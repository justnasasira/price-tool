import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function buildFormatPrompt(rawText: string) {
  return `Convert this price list to a clean format. Include ALL items.

FORMAT:
- First line: month/year (e.g., FEB 2026)
- Category headers in ALL CAPS on own line
- Product name on one line (combine multi-line descriptions, include SKU codes)
- Price on next line as @NUMBER+
- Remove asterisks, line numbers, bullets

Example output:
FEB 2026
DESKTOPS

HP PRO TOWER 290 G9 CI3 14100 8GB 512GB 21.5" #C6QM6AT
@460+

Dell Optiplex 7020 Ci5 14th gen 8GB 512GB 20" E2020H
@580+

DATA TO FORMAT:
${rawText}

Output ONLY the formatted list. Include ALL products.`
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
          maxOutputTokens: 65536
        }
      })
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error('Gemini API error: ' + errorText)
  }

  const data = await response.json()
  if (!data.candidates?.[0]?.content?.parts) {
    throw new Error('No response from Gemini')
  }

  return data.candidates[0].content.parts.map((p: any) => p.text || '').join('')
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
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error('Claude API error: ' + errorText)
  }

  const data = await response.json()
  if (!data.content?.[0]?.text) {
    throw new Error('No response from Claude')
  }

  return data.content[0].text
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
        JSON.stringify({ error: `${aiProvider === 'claude' ? 'Claude' : 'Gemini'} API key not configured. Please add it in Settings.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { rawText } = await req.json()
    if (!rawText) {
      return new Response(
        JSON.stringify({ error: 'Missing rawText in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Formatting price list with', aiProvider, '- Input length:', rawText.length)

    const prompt = buildFormatPrompt(rawText)

    // Call the appropriate AI API
    let responseText: string
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

    // Remove markdown code blocks if present
    responseText = responseText.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim()

    console.log('Output length:', responseText.length)

    return new Response(
      JSON.stringify({ formattedText: responseText }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
