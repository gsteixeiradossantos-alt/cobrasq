// Supabase Edge Function: google-calendar-sync
// Cria/atualiza/deleta eventos no Google Calendar de ccobrasq@gmail.com via Service Account.
// Usado pelo app pra sincronizar acordos, vencimentos, lembretes (S10).
//
// Setup:
//   - Criar projeto no Google Cloud Console
//   - Ativar Google Calendar API
//   - Criar Service Account, gerar JSON key
//   - Compartilhar o calendar ccobrasq@gmail.com com o email da service account (permissão "Fazer alterações em eventos")
//   - supabase secrets set GCAL_SERVICE_ACCOUNT_JSON='<conteudo do JSON em uma linha>'
//   - supabase secrets set GCAL_CALENDAR_ID='ccobrasq@gmail.com'
//   - supabase functions deploy google-calendar-sync

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Origens permitidas para chamar essa função. Configurável via env GCAL_ALLOWED_ORIGINS
// (lista separada por vírgula). Padrão inclui o domínio de produção da Vercel.
// Preview/branches do Vercel são reconhecidos pelo sufixo .vercel.app.
const DEFAULT_ORIGINS = 'https://cobrasq-faturamento.vercel.app';

function pickAllowedOrigin(req: Request): string {
  const allowed = (Deno.env.get('GCAL_ALLOWED_ORIGINS') || DEFAULT_ORIGINS)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const origin = req.headers.get('origin') || '';
  if (!origin) return allowed[0] || '';
  // match exato, ou wildcard de subdomínios .vercel.app pra previews
  if (allowed.includes(origin)) return origin;
  if (allowed.some(a => a === 'https://*.vercel.app') && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return origin;
  return ''; // origem não permitida → bloqueia
}

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = pickAllowedOrigin(req);
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

// JWT pra Service Account (Google OAuth2)
async function getAccessToken(): Promise<string> {
  const sa = JSON.parse(Deno.env.get('GCAL_SERVICE_ACCOUNT_JSON') || '{}');
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GCAL_SERVICE_ACCOUNT_JSON não configurado.');
  }

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = (obj: unknown) => btoa(JSON.stringify(obj))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const unsigned = encode(header) + '.' + encode(claims);

  // Importa private key
  const pemContents = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = unsigned + '.' + sigB64;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('OAuth falhou: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  // Bloqueia preflight/origin não-listada
  if (!corsHeaders['Access-Control-Allow-Origin']) {
    return new Response(JSON.stringify({ error: 'origin not allowed' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await req.json();
    // body: { action: 'create'|'update'|'delete', event: {summary, description, start, end, ...}, eventId? }
    const calendarId = Deno.env.get('GCAL_CALENDAR_ID') || 'ccobrasq@gmail.com';
    const token = await getAccessToken();

    let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    let method = 'POST';
    let payload: any = body.event;

    if (body.action === 'update' && body.eventId) {
      url += '/' + encodeURIComponent(body.eventId);
      method = 'PATCH';
    } else if (body.action === 'delete' && body.eventId) {
      url += '/' + encodeURIComponent(body.eventId);
      method = 'DELETE';
      payload = null;
    }

    const r = await fetch(url, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || `HTTP ${r.status}`, detalhes: data }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ok: true, event: data }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Erro: ' + (e instanceof Error ? e.message : String(e)) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
