// Supabase Edge Function: zapi-recebidas
// Recebe o evento "Ao receber" (on-message-received) do Z-API e grava a
// mensagem que o DEVEDOR enviou em crm_mensagens_recebidas. É o lado INBOUND
// que faltava: o zapi-webhook só trata STATUS de entrega (outbound).
//
// Idempotente por message_id. Ignora mensagens nossas (fromMe), grupos e
// callbacks de status. Resolve o caso (devedor) pelo telefone via RPC.
//
// verify_jwt: false (Z-API não tem JWT do Supabase).
// Auth via query ?token=ZAPI_WEBHOOK_SECRET ou header Authorization: Bearer <secret>.
// (Reusa o MESMO segredo do zapi-webhook.)
//
// Setup no painel Z-API: webhook "Ao receber" ->
//   https://<projeto>.functions.supabase.co/zapi-recebidas?token=<ZAPI_WEBHOOK_SECRET>

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Comparação em tempo constante (mesmo padrão do zapi-webhook).
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

function normalizarTelefone(raw: string): string {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  return d.startsWith('55') ? d : '55' + d;
}

// Extrai { tipo, texto, midia_url } do payload conforme o tipo de mídia do Z-API.
function extrairConteudo(b: any): { tipo: string; texto: string | null; midia_url: string | null } {
  if (b?.text?.message != null) return { tipo: 'texto', texto: String(b.text.message), midia_url: null };
  if (b?.image) return { tipo: 'imagem', texto: b.image.caption ?? null, midia_url: b.image.imageUrl ?? b.image.url ?? null };
  if (b?.audio) return { tipo: 'audio', texto: null, midia_url: b.audio.audioUrl ?? b.audio.url ?? null };
  if (b?.document) return { tipo: 'documento', texto: b.document.caption ?? b.document.fileName ?? null, midia_url: b.document.documentUrl ?? b.document.url ?? null };
  if (b?.video) return { tipo: 'video', texto: b.video.caption ?? null, midia_url: b.video.videoUrl ?? b.video.url ?? null };
  // sticker, location, contact, etc. — guarda o tipo cru, sem texto.
  if (typeof b?.type === 'string') return { tipo: 'outro', texto: null, midia_url: null };
  return { tipo: 'texto', texto: null, midia_url: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const expected = Deno.env.get('ZAPI_WEBHOOK_SECRET');
  if (!expected) {
    return new Response(JSON.stringify({ error: 'ZAPI_WEBHOOK_SECRET não configurado.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const auth = req.headers.get('authorization') || '';
  const url = new URL(req.url);
  const tokenQs = url.searchParams.get('token') || '';
  const provided = auth.replace(/^Bearer\s+/i, '') || tokenQs;
  if (!(await safeEqual(provided, expected))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let body: any;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }

  // Só nos interessa mensagem RECEBIDA de pessoa: ignora as nossas (fromMe),
  // grupos e callbacks de status que por ventura cheguem nesta URL.
  if (body?.fromMe === true || body?.isGroup === true || body?.isStatusReply === true) {
    return new Response(JSON.stringify({ ok: true, ignored: 'fromMe/group/status' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const messageId = body?.messageId || body?.id || body?.zaapId || null;
  const telefone = normalizarTelefone(body?.phone || body?.from || '');
  if (!messageId || !telefone) {
    return new Response(JSON.stringify({ ok: true, ignored: 'sem messageId/telefone' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const { tipo, texto, midia_url } = extrairConteudo(body);

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Resolve o caso (devedor) pelo telefone (últimos 8 dígitos). Best-effort.
  let casoId: string | null = null;
  try {
    const { data: rid } = await sb.rpc('resolver_caso_por_telefone', { p_tel: telefone });
    if (rid) casoId = rid as string;
  } catch {/* sem match -> caso_id null; o front resolve o nome por telefone */}

  const momentMs = Number(body?.momment || body?.moment || 0);
  const recebidaEm = momentMs > 0 ? new Date(momentMs).toISOString() : new Date().toISOString();

  const { error } = await sb.from('crm_mensagens_recebidas').upsert({
    message_id: String(messageId),
    telefone,
    caso_id: casoId,
    texto,
    tipo,
    midia_url,
    recebida_em: recebidaEm,
    raw: body
  }, { onConflict: 'message_id' });

  if (error) {
    return new Response(JSON.stringify({ error: 'insert: ' + error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ ok: true, message_id: String(messageId), telefone, caso_id: casoId, tipo }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});
