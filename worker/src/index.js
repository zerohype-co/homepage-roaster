/**
 * roaster-proxy — Cloudflare Worker
 * Proxies URL → Cloudflare Browser Rendering /markdown API
 * Returns cleaned page text for the B2B Homepage Roaster scorer
 */

const ALLOWED_ORIGINS = [
  'https://zerohypelab.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// Strip markdown syntax to get clean text for the scorer
function stripMarkdown(md) {
  return md
    .replace(/!\[.*?\]\(.*?\)/g, '')          // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links → text
    .replace(/#{1,6}\s+/g, '')                // headings
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/`{1,3}[^`]*`{1,3}/g, '')       // code
    .replace(/^\s*[-*+]\s+/gm, '')           // list bullets
    .replace(/^\s*\d+\.\s+/gm, '')           // numbered lists
    .replace(/\|.*?\|/g, '')                  // tables
    .replace(/^[-=]{3,}$/gm, '')             // horizontal rules
    .replace(/\n{3,}/g, '\n\n')             // excess newlines
    .trim();
}

// Extract the most relevant above-the-fold content
// Takes first ~2000 chars but tries to cut at a sentence boundary
function extractAboveFold(text, maxChars = 2000) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  // Try to end at last sentence boundary
  const lastPeriod = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  return lastPeriod > maxChars * 0.6 ? slice.slice(0, lastPeriod + 1) : slice;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const url = (body.url || '').trim();

    // Validate URL
    if (!url) {
      return new Response(
        JSON.stringify({ error: 'Missing url field' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid URL format. Include https://' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return new Response(
        JSON.stringify({ error: 'Only http/https URLs are supported' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    // Call Cloudflare Browser Rendering /markdown
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/browser-rendering/markdown`;

    let cfRes;
    try {
      cfRes = await fetch(cfUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Failed to reach Cloudflare API' }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    if (!cfRes.ok) {
      const errText = await cfRes.text();
      return new Response(
        JSON.stringify({ error: `Cloudflare API error ${cfRes.status}`, detail: errText }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const data = await cfRes.json();

    // Cloudflare returns: { success: true, result: "markdown string" }
    // or sometimes: { result: { markdown: "..." } }
    const raw =
      (typeof data.result === 'string' ? data.result : null) ||
      data.result?.markdown ||
      data.markdown ||
      '';

    if (!raw) {
      return new Response(
        JSON.stringify({ error: 'No content returned. The page may be blocked or empty.' }),
        { status: 422, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const cleaned = stripMarkdown(raw);
    const text = extractAboveFold(cleaned);

    return new Response(
      JSON.stringify({ text, chars: text.length }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  },
};
