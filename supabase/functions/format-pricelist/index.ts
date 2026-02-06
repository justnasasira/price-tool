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
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: settings } = await supabaseClient
      .from('user_settings')
      .select('gemini_api_key, gemini_model')
      .eq('user_id', user.id)
      .single()

    if (!settings?.gemini_api_key) {
      return new Response(
        JSON.stringify({ error: 'Gemini API key not configured. Please add it in Settings.' }),
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
        JSON.stringify({ error: 'AI formatting failed', details: errorText }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const geminiData = await geminiResponse.json()

    if (!geminiData.candidates || geminiData.candidates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No response from AI' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let text = geminiData.candidates[0].content?.parts?.map((p: any) => p.text || '').join('') || ''
    text = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim()

    return new Response(
      JSON.stringify({ formattedText: text }),
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
