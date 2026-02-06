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
              text: `Product: "${productName}"

Create an SEO title and DETAILED technical specifications.

SEO Title: Include brand, model, CPU gen, RAM, storage, display size, and OS (e.g., "Dell Optiplex 7020 SFF: Intel Core i5 14th Gen, 8GB DDR4, 512GB NVMe SSD, 20" E2020H Monitor, Windows 11 Pro")

Specs: Use ✅ bullets with DETAILED info for each:
✅ Processor: Full model name, generation, cores, threads, speed, cache
✅ RAM: Size, type, speed, slots, max expandable
✅ Storage: Size, type (PCIe NVMe/SATA)
✅ Graphics: Model name
✅ Ports: List all USB, video, audio ports with specs
✅ Bundled Monitor: Size, resolution, panel type, refresh rate (if included)
✅ OS: Operating system
✅ Warranty: Duration

Respond with valid JSON only (no markdown):
{"seoTitle": "Brand Model: specs", "specs": "✅ Processor: details\\n✅ RAM: details\\n...", "confident": true/false}`
            }]
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096
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
    console.log('Gemini full response:', JSON.stringify(geminiData).substring(0, 1000))

    if (!geminiData.candidates || geminiData.candidates.length === 0) {
      console.error('No candidates:', JSON.stringify(geminiData))
      return new Response(
        JSON.stringify({ error: 'No response from AI. Check if model is available.', details: geminiData }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const candidate = geminiData.candidates[0]
    console.log('Finish reason:', candidate.finishReason)
    if (candidate.safetyRatings) {
      console.log('Safety ratings:', JSON.stringify(candidate.safetyRatings))
    }

    let text = candidate.content?.parts?.map((p: any) => p.text || '').join('') || ''
    console.log('AI response length:', text.length)
    console.log('AI response preview:', text.substring(0, 300))
    console.log('Has closing brace:', text.includes('}'))

    // Remove markdown code blocks if present
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()

    // Try to extract JSON from response
    let jsonMatch = text.match(/\{[\s\S]*\}/)

    // If no closing brace found, try to manually extract fields
    if (!jsonMatch && text.startsWith('{')) {
      console.log('Attempting manual field extraction...')

      // Extract seoTitle - handle escaped quotes properly
      const seoTitleMatch = text.match(/"seoTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
      // Extract specs - get everything after "specs": "
      const specsStartMatch = text.match(/"specs"\s*:\s*"/)
      let specs = ''
      if (specsStartMatch) {
        const specsStart = text.indexOf(specsStartMatch[0]) + specsStartMatch[0].length
        // Find the end - look for ", "confident" or just take until end
        let specsEnd = text.indexOf('", "confident"', specsStart)
        if (specsEnd === -1) specsEnd = text.indexOf('"}', specsStart)
        if (specsEnd === -1) specsEnd = text.length
        specs = text.substring(specsStart, specsEnd)
      }

      if (seoTitleMatch) {
        const result = {
          seoTitle: seoTitleMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' '),
          specs: specs.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
          confident: false // Mark as uncertain since we had to recover
        }

        console.log('Recovered result:', JSON.stringify(result).substring(0, 200))

        // Update product in database if productId provided
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
      }
    }

    if (jsonMatch) {
      try {
        // Fix unescaped newlines in JSON string values
        let jsonStr = jsonMatch[0]
        // Replace actual newlines within strings with escaped newlines
        jsonStr = jsonStr.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
          return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r')
        })

        const result = JSON.parse(jsonStr)
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
        console.error('JSON parse error:', parseError, 'Text:', jsonMatch[0].substring(0, 200))
        return new Response(
          JSON.stringify({ error: 'Failed to parse AI response as JSON', rawResponse: text.substring(0, 500) }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    return new Response(
      JSON.stringify({
        error: 'No JSON found in AI response',
        rawResponse: text.substring(0, 500),
        textLength: text.length,
        finishReason: geminiData.candidates?.[0]?.finishReason || 'unknown'
      }),
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
