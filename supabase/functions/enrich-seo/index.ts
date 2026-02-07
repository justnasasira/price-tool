import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SEO_PROMPT = `Product: "{productName}"

Create an SEO title and DETAILED technical specifications.

SEO Title: Include brand, model, CPU gen, RAM, storage, display size, and OS (e.g., "Dell Optiplex 7020 SFF: Intel Core i5 14th Gen, 8GB DDR4, 512GB NVMe SSD, 20" E2020H Monitor, Windows 11 Pro")

Specs: Use bullet points with DETAILED info for each:
- Processor: Full model name, generation, cores, threads, speed, cache
- RAM: Size, type, speed, slots, max expandable
- Storage: Size, type (PCIe NVMe/SATA)
- Graphics: Model name
- Ports: List all USB, video, audio ports with specs
- Bundled Monitor: Size, resolution, panel type, refresh rate (if included)
- OS: Operating system
- Warranty: Duration

Respond with valid JSON only (no markdown):
{"seoTitle": "Brand Model: specs", "specs": "Processor: details\\nRAM: details\\n...", "confident": true/false}`

// AWS Signature V4 helper functions
function toHex(data: Uint8Array): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  return toHex(new Uint8Array(hash))
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(hash)
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
  return new Uint8Array(sig)
}

async function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Promise<Uint8Array> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + key), dateStamp)
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, service)
  const kSigning = await hmacSha256(kService, 'aws4_request')
  return kSigning
}

async function signAwsRequest(
  method: string,
  url: string,
  body: string,
  accessKey: string,
  secretKey: string,
  region: string,
  service: string
): Promise<Record<string, string>> {
  const urlObj = new URL(url)
  const host = urlObj.host
  const path = urlObj.pathname

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)

  const payloadHash = await sha256(body)

  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'content-type;host;x-amz-date'

  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const algorithm = 'AWS4-HMAC-SHA256'
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const canonicalRequestHash = await sha256(canonicalRequest)

  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n')

  const signingKey = await getSignatureKey(secretKey, dateStamp, region, service)
  const signature = toHex(await hmacSha256(signingKey, stringToSign))

  const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    'Authorization': authorizationHeader
  }
}

async function callGeminiAPI(apiKey: string, model: string, productName: string) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: SEO_PROMPT.replace('{productName}', productName) }]
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096
        }
      })
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error('Gemini API error: ' + errorText)
  }

  const data = await response.json()
  if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error('No response from Gemini')
  }

  return data.candidates[0].content.parts.map((p: any) => p.text || '').join('')
}

async function callClaudeAPI(apiKey: string, model: string, productName: string) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: SEO_PROMPT.replace('{productName}', productName)
      }]
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

async function callBedrockAPI(apiKey: string, accessKey: string, secretKey: string, region: string, model: string, productName: string) {
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${model}/invoke`

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: SEO_PROMPT.replace('{productName}', productName)
    }]
  })

  const headers = await signAwsRequest('POST', url, body, accessKey, secretKey, region, 'bedrock')
  // Add API key to headers
  headers['x-api-key'] = apiKey

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error('Bedrock API error: ' + errorText)
  }

  const data = await response.json()
  if (!data.content?.[0]?.text) {
    throw new Error('No response from Bedrock')
  }

  return data.content[0].text
}

function parseAIResponse(text: string) {
  // Remove markdown code blocks if present
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()

  // Try to extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/)

  if (jsonMatch) {
    try {
      // Fix unescaped newlines in JSON string values
      let jsonStr = jsonMatch[0]
      jsonStr = jsonStr.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
        return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r')
      })

      const result = JSON.parse(jsonStr)
      if (result.specs) {
        result.specs = result.specs.replace(/\\n/g, '\n')
      }
      return result
    } catch (e) {
      console.error('JSON parse error:', e)
    }
  }

  // Fallback: try to manually extract fields
  if (text.startsWith('{')) {
    const seoTitleMatch = text.match(/"seoTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
    const specsStartMatch = text.match(/"specs"\s*:\s*"/)
    let specs = ''
    if (specsStartMatch) {
      const specsStart = text.indexOf(specsStartMatch[0]) + specsStartMatch[0].length
      let specsEnd = text.indexOf('", "confident"', specsStart)
      if (specsEnd === -1) specsEnd = text.indexOf('"}', specsStart)
      if (specsEnd === -1) specsEnd = text.length
      specs = text.substring(specsStart, specsEnd)
    }

    if (seoTitleMatch) {
      return {
        seoTitle: seoTitleMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' '),
        specs: specs.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
        confident: false
      }
    }
  }

  throw new Error('Could not parse AI response')
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
      .select('ai_provider, gemini_api_key, gemini_model, claude_api_key, claude_model, bedrock_api_key, aws_access_key, aws_secret_key, aws_region, bedrock_model')
      .eq('user_id', user.id)
      .single()

    const aiProvider = settings?.ai_provider || 'gemini'
    console.log('AI Provider:', aiProvider)

    // Check if the selected provider has credentials
    if (aiProvider === 'bedrock' && (!settings?.bedrock_api_key || !settings?.aws_access_key || !settings?.aws_secret_key)) {
      return new Response(
        JSON.stringify({ error: 'AWS Bedrock credentials not configured. Please add API key, Access Key, and Secret Key in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (aiProvider === 'claude' && !settings?.claude_api_key) {
      return new Response(
        JSON.stringify({ error: 'Claude API key not configured. Please add it in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (aiProvider === 'gemini' && !settings?.gemini_api_key) {
      return new Response(
        JSON.stringify({ error: 'Gemini API key not configured. Please add it in Settings.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { productName, productId } = await req.json()
    if (!productName) {
      return new Response(
        JSON.stringify({ error: 'Missing productName' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Enriching product:', productName, 'with', aiProvider)

    // Call the appropriate AI API
    let responseText: string
    if (aiProvider === 'bedrock') {
      responseText = await callBedrockAPI(
        settings.bedrock_api_key,
        settings.aws_access_key,
        settings.aws_secret_key,
        settings.aws_region || 'us-east-1',
        settings.bedrock_model || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        productName
      )
    } else if (aiProvider === 'claude') {
      responseText = await callClaudeAPI(
        settings.claude_api_key,
        settings.claude_model || 'claude-3-5-sonnet-20241022',
        productName
      )
    } else {
      responseText = await callGeminiAPI(
        settings.gemini_api_key,
        settings.gemini_model || 'gemini-2.5-flash',
        productName
      )
    }

    console.log('AI response length:', responseText.length)
    const result = parseAIResponse(responseText)

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

  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
