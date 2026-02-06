import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
      console.error('Auth error:', userError)
      return new Response(
        JSON.stringify({ error: 'Unauthorized: ' + (userError?.message || 'No user') }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('User authenticated:', user.email)

    const { data: settings, error: settingsError } = await supabaseClient
      .from('user_settings')
      .select('gemini_api_key, gemini_model')
      .eq('user_id', user.id)
      .single()

    if (settingsError) {
      console.error('Settings error:', settingsError)
    }

    if (!settings?.gemini_api_key) {
      return new Response(
        JSON.stringify({ error: 'Gemini API key not configured. Please add it in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Gemini API key found, model:', settings.gemini_model)

    const { rawText } = await req.json()
    if (!rawText) {
      return new Response(
        JSON.stringify({ error: 'Missing rawText in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Input length:', rawText.length)

    const model = settings.gemini_model || 'gemini-2.5-flash'

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.gemini_api_key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Convert this price list to a clean format. Include ALL items.

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
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 65536
          }
        })
      }
    )

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text()
      console.error('Gemini API error:', errorText)
      return new Response(
        JSON.stringify({ error: 'Gemini API error: ' + errorText }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const geminiData = await geminiResponse.json()
    console.log('Gemini response received')

    if (!geminiData.candidates || geminiData.candidates.length === 0) {
      console.error('No candidates:', JSON.stringify(geminiData))
      return new Response(
        JSON.stringify({ error: 'No response from AI. Check if model is available.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let text = geminiData.candidates[0].content?.parts?.map((p: any) => p.text || '').join('') || ''

    // Remove markdown code blocks if present
    text = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim()

    console.log('Output length:', text.length)

    return new Response(
      JSON.stringify({ formattedText: text }),
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
