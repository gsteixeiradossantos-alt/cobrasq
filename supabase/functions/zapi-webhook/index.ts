// Supabase Edge Function: zapi-webhook
// Recebe POST do Z-API quando uma mensagem muda de status (SENT/QUEUED/
// DELIVERED/READ/NOT_DELIVERED). Insere/atualiza em crm_mensagens_status
// e, se NOT_DELIVERED, registra em crm_envios_falhados.
//
// verify_jwt: false (Z-API não tem JWT do Supabase).
// Autenticação via query string ?token=ZAPI_WEBHOOK_SECRET ou
// header Authorization: Bearer <ZAPI_WEBHOOK_SECRET>.
//
// Setup: supabase secrets set ZAPI_WEBHOOK_SECRET=<random-32>
// Painel Z-API: webhook URL
//   https://jokbxzhcctcwnbhkhgru.functions.supabase.co/zapi-webhook?token=<secret>
//   Eventos: message-status (delivered, read, etc).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ⚠️ ATIVAR SÓ APÓS TROCAR PARA HEADER NO PAINEL DO Z-API.
// O segredo via `?token=` na URL vaza em logs/histórico/referrer; o correto é mandá-lo só
// no HEADER `Authorization: Bearer <secret>`. Enquanto a URL cadastrada no painel ainda usa
// `?token=`, manter TRUE evita quebrar o webhook em produção. PASSO MANUAL para desligar:
//   1. Painel Z-API → Webhooks → editar a URL do webhook (message-status).
//   2. Remover `?token=<secret>` da URL e configurar o segredo como header
//      `Authorization: Bearer <secret>` (campo de headers do webhook, se disponível).
//   3. Enviar evento de teste e confirmar 200.
//   4. Trocar esta flag para `false` e re-deployar. A partir daí, `?token=` é IGNORADO.
const ACEITAR_TOKEN_QUERYSTRING = true;

// Comparação em tempo constante (mesmo padrão do zapsign-webhook): o !== simples
// vaza por timing quanto do segredo já bateu.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

function mapStatus(raw: string): string {
  const s = String(raw || '').toUpperCase();
  if (s.includes('READ')) return 'read';
  if (s.includes('DELIVER')) return 'delivered';
  if (s.includes('NOT_DELIVER') || s.includes('NOT-DELIVER') || s.includes('FAIL') || s.includes('ERROR')) return 'not_delivered';
  if (s.includes('SENT') || s.includes('PLAY')) return 'sent';
  if (s.includes('QUEUE')) return 'queued';
  return 'sent';
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
  const tokenQs = ACEITAR_TOKEN_QUERYSTRING ? (url.searchParams.get('token') || '') : '';
  const provided = auth.replace(/^Bearer\s+/i, '') || tokenQs;
  if (!(await safeEqual(provided, expected))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let body: any;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }

  const data = body?.data || body || {};
  const messageId = data.messageId || data.id || data.zaapi_id || body.messageId || body.id;
  const status = mapStatus(data.status || body.status || body.type || '');
  const telefone = data.phone || body.phone || null;

  if (!messageId) {
    return new Response(JSON.stringify({ ok: true, ignored: 'sem messageId' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  let casoId: string | null = null;
  try {
    const { data: ev } = await sb
      .from('devedor_eventos')
      .select('devedor_id')
      .filter('payload->>message_id', 'eq', String(messageId))
      .limit(1);
    if (ev && ev[0]) casoId = ev[0].devedor_id;
  } catch {/* ignore */}

  await sb.from('crm_mensagens_status').upsert({
    caso_id: casoId,
    message_id: String(messageId),
    telefone_enviado: telefone,
    status,
    evento_em: new Date().toISOString(),
    raw_payload: body
  }, { onConflict: 'message_id' });

  if (status === 'not_delivered') {
    // F-15: idempotência. A tabela crm_envios_falhados não tem coluna message_id
    // (o id da mensagem vai embutido no texto), então não dá pra usar
    // upsert/onConflict sem migration. Em vez disso, deduplicamos pelo texto
    // determinístico que NÓS montamos a partir do messageId: se o Z-API reenviar
    // o mesmo NOT_DELIVERED (acontece), a linha já existe -> só incrementamos
    // 'tentativas', sem criar duplicata. Sem mudança de schema.
    const marcador = '[zapi-webhook] msg ' + messageId + ' não entregue';
    let existente: any = null;
    try {
      const { data: rows } = await sb
        .from('crm_envios_falhados')
        .select('id, tentativas')
        .eq('mensagem', marcador)
        .limit(1);
      if (rows && rows[0]) existente = rows[0];
    } catch {/* se a leitura falhar, cai no insert abaixo (degrada pra comportamento antigo) */}

    if (existente) {
      await sb.from('crm_envios_falhados')
        .update({
          tentativas: (existente.tentativas || 1) + 1,
          erro: 'NOT_DELIVERED via webhook Z-API: ' + JSON.stringify(body).slice(0, 400)
        })
        .eq('id', existente.id);
    } else {
      await sb.from('crm_envios_falhados').insert({
        caso_id: casoId,
        operador_id: null,
        telefone: telefone,
        mensagem: marcador,
        erro: 'NOT_DELIVERED via webhook Z-API: ' + JSON.stringify(body).slice(0, 400),
        tentativas: 1,
        status: 'pendente'
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, status, message_id: messageId, caso_id: casoId }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});
