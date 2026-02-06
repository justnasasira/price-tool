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

    const { productName, productId } = await req.json()
    if (!productName) {
      return new Response(
        JSON.stringify({ error: 'Missing productName' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Enriching product:', productName)

    const model = settings.gemini_model || 'gemini-2.5-flash'

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.gemini_api_key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a product data specialist. Given a product name, create an SEO-friendly title and detailed technical specifications.

Product: "${productName}"

TASK 1 - SEO Title:
Create a formatted product title like this:
"Brand Model: Key Specs Summary"

Example: "Dell Vostro 3030 MT: Intel Core i5 12th Gen, 8GB RAM, 512GB SSD, 19.5" E2020H Monitor, Ubuntu"

TASK 2 - Technical Specifications:
Create detailed specs using checkmark bullet points (use ✅). Include ALL relevant specifications.

For MONITORS include: Panel type, Resolution, Refresh rate, Response time, Ports, Stand adjustments, VESA mount
For LAPTOPS include: Processor, RAM, Storage, Display, Graphics, Battery, Weight, Ports, OS, Warranty
For DESKTOPS include: Processor, RAM, Storage, Graphics, Ports, Bundled monitor specs, OS, Warranty

Look up the ACTUAL specifications for this product from your knowledge.

Respond ONLY with valid JSON (no markdown, no code blocks):
{"seoTitle": "Brand Model: Key Specs Summary", "specs": "✅ Spec1: Details\\n✅ Spec2: Details", "confident": true}

Set confident to false if you're unsure about the exact model specifications.`
            }]
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2000
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

    const text = geminiData.candidates[0].content?.parts?.map((p: any) => p.text || '').join('') || ''
    console.log('AI response text:', text.substring(0, 200))

    // Try to extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)

    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0])
        if (result.specs) {
          result.specs = result.specs.replace(/\\n/g, '\n')
        }

        // Optionally update product in database if productId provided
        if (productId) {
          await supabaseClient
            .from('products')
            .update({
              seo_title: result.seoTitle,
              specs: result.specs,
              updated_at: new Date().toISOString()
            })
            .eq('id', productId)
            .eq('user_id', user.id)
        }

        return new Response(
          JSON.stringify(result),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      } catch (parseError) {
        console.error('JSON parse error:', parseError, 'Text:', jsonMatch[0])
        return new Response(
          JSON.stringify({ error: 'Failed to parse AI response as JSON', rawResponse: text.substring(0, 500) }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    return new Response(
      JSON.stringify({ error: 'No JSON found in AI response', rawResponse: text.substring(0, 500) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
