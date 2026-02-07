import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function buildMatchPrompt(existingSummary: string, newSummary: string) {
  return `Match products by name similarity. Format: ID|Name|Price

EXISTING:
${existingSummary}

NEW:
${newSummary}

Return JSON with matches (existing ID to new index), new product indices, and missing IDs:
{"matches":[{"existingId":"id","newIndex":0,"confidence":0.9}],"newProducts":[1,3],"missingIds":["id2"]}`
}

async function callGeminiAPI(apiKey: string, model: string, prompt: string) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2000
        }
      })
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error('Gemini API error: ' + errorText)
  }

  const data = await response.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

async function callClaudeAPI(apiKey: string, model: string, prompt: string) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error('Claude API error: ' + errorText)
  }

  const data = await response.json()
  return data.content?.[0]?.text || ''
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: settings } = await supabaseClient
      .from('user_settings')
      .select('ai_provider, gemini_api_key, gemini_model, claude_api_key, claude_model')
      .eq('user_id', user.id)
      .single()

    const aiProvider = settings?.ai_provider || 'gemini'

    // Check if the selected provider has an API key
    const hasApiKey = aiProvider === 'claude'
      ? !!settings?.claude_api_key
      : !!settings?.gemini_api_key

    if (!hasApiKey) {
      return new Response(
        JSON.stringify({ error: `${aiProvider === 'claude' ? 'Claude' : 'Gemini'} API key not configured` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { existingProducts, newProducts } = await req.json()
    if (!existingProducts || !newProducts) {
      return new Response(
        JSON.stringify({ error: 'Missing existingProducts or newProducts' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Matching', existingProducts.length, 'existing vs', newProducts.length, 'new products with', aiProvider)

    const existingSummary = existingProducts.map((p: any) => `${p.id}|${p.name}|${p.basePrice}`).join('\n')
    const newSummary = newProducts.map((p: any, i: number) => `${i}|${p.name}|${p.basePrice}`).join('\n')
    const prompt = buildMatchPrompt(existingSummary, newSummary)

    // Call the appropriate AI API
    let responseText: string
    try {
      if (aiProvider === 'claude') {
        responseText = await callClaudeAPI(
          settings.claude_api_key,
          settings.claude_model || 'claude-3-5-sonnet-20241022',
          prompt
        )
      } else {
        responseText = await callGeminiAPI(
          settings.gemini_api_key,
          settings.gemini_model || 'gemini-2.5-flash',
          prompt
        )
      }
    } catch (apiError) {
      console.error('AI API error:', apiError)
      // Fall back gracefully - treat all as new products
      return new Response(
        JSON.stringify({
          matches: [],
          newProducts: newProducts.map((_: any, i: number) => i),
          missingIds: existingProducts.map((p: any) => p.id)
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('AI response:', responseText.substring(0, 500))

    if (!responseText) {
      console.log('No response, falling back to simple matching')
      return new Response(
        JSON.stringify({
          matches: [],
          newProducts: newProducts.map((_: any, i: number) => i),
          missingIds: existingProducts.map((p: any) => p.id)
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse the response
    let text = responseText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)

    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0])
        return new Response(
          JSON.stringify(result),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      } catch (parseError) {
        console.error('JSON parse error:', parseError)
      }
    }

    // Fallback if no valid JSON
    return new Response(
      JSON.stringify({
        matches: [],
        newProducts: newProducts.map((_: any, i: number) => i),
        missingIds: []
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
