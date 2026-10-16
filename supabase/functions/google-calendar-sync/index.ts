// Supabase Edge Function: google-calendar-sync
// Cria/atualiza/deleta eventos no Google Calendar de ccobrasq@gmail.com via Service Account.
// Usado pelo app pra sincronizar acordos, vencimentos, lembretes (S10).
//
// Ações (body.action):
//   list      { timeMin, timeMax }            → eventos da janela (card "Próximos 7 dias")
//   create    { event }                       → cria
//   update    { eventId, event }              → PATCH
//   delete    { eventId }                     → apaga
//   lembrete  { lembreteId, op, dataHora? }   → acha o evento-espelho pela linha
//             `lembrete:<uuid>` da descrição e aplica op = concluir | excluir | reagendar
//
// Quem pode chamar: o gestor logado (app_users.papel = 'proprietario', ativo) ou o
// servidor com a service_role (cron-regua, limpeza de eventos). O gateway confere a
// assinatura do JWT (verify_jwt = true no config.toml); aqui se confere QUEM é.
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Origens permitidas para chamar essa função. Configurável via env GCAL_ALLOWED_ORIGINS
// (lista separada por vírgula). Padrão inclui o domínio canônico e o legado .vercel.app.
// Preview/branches do Vercel são reconhecidos pelo sufixo .vercel.app.
const DEFAULT_ORIGINS = 'https://painel.cobrasq.com.br,https://cobrasq-faturamento.vercel.app';

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

// Quem chama: service_role (servidor) ou o gestor logado. O gateway já validou a
// assinatura (verify_jwt = true), então ler o `role` do payload é seguro aqui.
function ehServiceRole(req: Request): boolean {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.role === 'service_role';
  } catch { return false; /* não é JWT legível: segue para getUser, que recusa */ }
}

async function chamadorAutorizado(req: Request): Promise<true | { erro: string; status: number }> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { erro: 'unauthorized: sem token de sessão', status: 401 };
  if (ehServiceRole(req)) return true;
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return { erro: 'configuração do servidor incompleta', status: 500 };
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return { erro: 'unauthorized: sessão inválida ou expirada', status: 401 };
  const { data: caller, error: e2 } = await admin.from('app_users').select('papel, ativo').eq('id', user.id).maybeSingle();
  if (e2) return { erro: 'falha ao verificar permissão', status: 500 };
  if (!caller || caller.ativo === false || caller.papel !== 'proprietario') {
    return { erro: 'forbidden: só o gestor mexe na agenda', status: 403 };
  }
  return true;
}

// Regra fixa de "concluído" na agenda (skill lembretes-cobrasq): o evento vai para
// 07:00–07:10 do dia em que foi cumprido, cor Sage (2), e o emoji do título vira ✅.
function patchConcluir(summary: string) {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const tit = String(summary || '').trim();
  const semEmoji = tit.replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+/u, '');
  return {
    summary: tit.startsWith('✅') ? tit : '✅ ' + semEmoji,
    colorId: '2',
    start: { dateTime: `${hoje}T07:00:00`, timeZone: 'America/Sao_Paulo' },
    end: { dateTime: `${hoje}T07:10:00`, timeZone: 'America/Sao_Paulo' }
  };
}

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  // Bloqueia preflight/origin não-listada. Chamada de servidor com a service_role
  // (cron-regua manda Origin = URL do deploy da Vercel, que muda a cada deploy) não
  // depende de CORS: a origem só protege o navegador.
  if (!corsHeaders['Access-Control-Allow-Origin'] && !ehServiceRole(req)) {
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

  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });

  try {
    const autorizado = await chamadorAutorizado(req);
    if (autorizado !== true) return json({ error: autorizado.erro }, autorizado.status);

    const body = await req.json();
    const calendarId = Deno.env.get('GCAL_CALENDAR_ID') || 'ccobrasq@gmail.com';
    const token = await getAccessToken();
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const gfetch = (url: string, method = 'GET', payload?: unknown) => fetch(url, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined
    });

    if (body.action === 'list') {
      if (!body.timeMin || !body.timeMax) return json({ error: 'timeMin e timeMax são obrigatórios' }, 400);
      const qs = new URLSearchParams({
        timeMin: body.timeMin, timeMax: body.timeMax,
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250'
      });
      const r = await gfetch(`${base}?${qs}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: data.error?.message || `HTTP ${r.status}` }, 502);
      const items = (data.items || []).filter((e: any) => e.status !== 'cancelled').map((e: any) => ({
        id: e.id, summary: e.summary || '', description: e.description || '',
        start: e.start, end: e.end, colorId: e.colorId || null, htmlLink: e.htmlLink || null
      }));
      return json({ ok: true, items });
    }

    if (body.action === 'lembrete') {
      const id = String(body.lembreteId || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'lembreteId inválido' }, 400);
      // A busca livre do Google cobre a descrição; confere a linha exata depois.
      const r = await gfetch(`${base}?${new URLSearchParams({ q: `lembrete:${id}`, singleEvents: 'true', maxResults: '10' })}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: data.error?.message || `HTTP ${r.status}` }, 502);
      const eventos = (data.items || []).filter((e: any) =>
        e.status !== 'cancelled' && String(e.description || '').includes(`lembrete:${id}`));
      if (!eventos.length) return json({ ok: true, achados: 0 });
      for (const ev of eventos) {
        const url = `${base}/${encodeURIComponent(ev.id)}`;
        let rr: Response;
        if (body.op === 'excluir') {
          rr = await gfetch(url, 'DELETE');
        } else if (body.op === 'concluir') {
          rr = await gfetch(url, 'PATCH', patchConcluir(ev.summary));
        } else if (body.op === 'reagendar' && body.dataHora) {
          const ini = new Date(body.dataHora);
          if (isNaN(ini.getTime())) return json({ error: 'dataHora inválida' }, 400);
          const durMs = ev.start?.dateTime && ev.end?.dateTime
            ? Math.max(5 * 60e3, new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime())
            : 15 * 60e3;
          rr = await gfetch(url, 'PATCH', {
            start: { dateTime: ini.toISOString(), timeZone: 'America/Sao_Paulo' },
            end: { dateTime: new Date(ini.getTime() + durMs).toISOString(), timeZone: 'America/Sao_Paulo' }
          });
        } else {
          return json({ error: 'op inválida (use concluir, excluir ou reagendar)' }, 400);
        }
        if (!rr.ok && rr.status !== 404 && rr.status !== 410) {
          const d = await rr.json().catch(() => ({}));
          return json({ error: d.error?.message || `HTTP ${rr.status}` }, 502);
        }
      }
      return json({ ok: true, achados: eventos.length });
    }

    if (body.action === 'concluir' && body.eventId) {
      const url = `${base}/${encodeURIComponent(body.eventId)}`;
      const r0 = await gfetch(url);
      const ev = await r0.json().catch(() => ({}));
      if (!r0.ok) return json({ error: ev.error?.message || `HTTP ${r0.status}` }, 502);
      const r = await gfetch(url, 'PATCH', patchConcluir(ev.summary));
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: data.error?.message || `HTTP ${r.status}` }, 502);
      return json({ ok: true, event: data });
    }

    let url = base;
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
    // Apagar evento que já não existe (404/410) = objetivo cumprido. Sem isso o
    // cron-regua recebia 502 e tentava apagar o mesmo evento a cada rodada.
    if (method === 'DELETE' && (r.status === 404 || r.status === 410)) {
      return json({ ok: true, jaNaoExistia: true });
    }
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
