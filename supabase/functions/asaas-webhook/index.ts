// Supabase Edge Function: asaas-webhook
// Recebe POST do Asaas quando um pagamento muda de estado. Nesta PR tratamos os
// eventos de DINHEIRO QUE ENTRA — PAYMENT_RECEIVED / PAYMENT_CONFIRMED — para:
//   1. casar o pagamento ao devedor via devedores.asaas_customer_id (= payment.customer);
//   2. registrar o evento em devedor_eventos (idempotente por payment.id);
//   3. dar baixa best-effort na cobrança quando o externalReference for um uuid de
//      cobranca (o vínculo forte payment↔cobranca é gravado na emissão — PR2).
// Os passos seguintes (recibo ao devedor, operação única recebimento↔repasse,
// preparo de PIX de repasse e NFS-e) consomem este evento nas PRs 3–6.
//
// verify_jwt: false (Asaas não tem JWT do Supabase).
// Autenticação via header `asaas-access-token: <ASAAS_WEBHOOK_SECRET>` (padrão do
// Asaas) OU query string ?token=<ASAAS_WEBHOOK_SECRET>.
//
// Setup: supabase secrets set ASAAS_WEBHOOK_SECRET=<random-32>
// Painel Asaas → Integrações → Webhooks:
//   URL: https://jokbxzhcctcwnbhkhgru.functions.supabase.co/asaas-webhook?token=<secret>
//   (ou configurar o "Token de autenticação" = secret, que vem em asaas-access-token)
//   Eventos: PAYMENT_RECEIVED, PAYMENT_CONFIRMED (mínimo desta PR).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, asaas-access-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Comparação em tempo constante (mesmo padrão do zapi-webhook/zapsign-webhook).
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expected = Deno.env.get('ASAAS_WEBHOOK_SECRET');
  if (!expected) return json({ error: 'ASAAS_WEBHOOK_SECRET não configurado.' }, 500);

  const url = new URL(req.url);
  const provided =
    (req.headers.get('asaas-access-token') || '').trim() ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
    (url.searchParams.get('token') || '').trim();
  if (!(await safeEqual(provided, expected))) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'JSON inválido' }, 400); }

  const event = String(body?.event || '').toUpperCase();
  const payment = body?.payment || {};
  const paymentId = payment?.id || null;

  // Só agimos sobre dinheiro que entra. Demais eventos são confirmados (200) e ignorados.
  const ENTRADA = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']);
  if (!ENTRADA.has(event)) return json({ ok: true, ignored: event || 'sem evento' });
  if (!paymentId) return json({ ok: true, ignored: 'sem payment.id' });

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Idempotência: o Asaas reenvia webhooks até receber 200. Se já registramos este
  // payment.id como recebido, não duplicamos.
  try {
    const { data: dup } = await sb
      .from('devedor_eventos')
      .select('id')
      .eq('tipo', 'asaas_pagamento_recebido')
      .filter('payload->>payment_id', 'eq', String(paymentId))
      .limit(1);
    if (dup && dup[0]) return json({ ok: true, duplicate: true, payment_id: paymentId });
  } catch {/* se a leitura falhar, segue (degrada para risco de duplicar evento) */}

  // Casa o devedor pelo customer Asaas.
  let devedorId: string | null = null;
  if (payment.customer) {
    try {
      const { data: dev } = await sb
        .from('devedores')
        .select('id')
        .eq('asaas_customer_id', String(payment.customer))
        .limit(1);
      if (dev && dev[0]) devedorId = dev[0].id;
    } catch {/* ignore */}
  }

  // Baixa best-effort na cobrança quando o externalReference é um uuid de cobranca
  // (o vínculo forte é gravado na emissão — PR2; aqui é defensivo).
  let cobrancaId: string | null = null;
  const extRef = payment.externalReference ? String(payment.externalReference) : '';
  if (UUID_RE.test(extRef)) {
    try {
      const { data: cob } = await sb
        .from('cobrancas')
        .update({ status: 'paga' })
        .eq('id', extRef)
        .select('id')
        .limit(1);
      if (cob && cob[0]) cobrancaId = cob[0].id;
    } catch {/* ignore — status/regra de baixa real refinada na PR3 */}
  }

  // Sem devedor casado não há onde registrar o evento (devedor_eventos.devedor_id é
  // NOT NULL). Confirmamos 200 para o Asaas parar de reenviar e logamos o motivo.
  if (!devedorId) {
    return json({ ok: true, unmatched: true, reason: 'customer sem devedor', customer: payment.customer || null, payment_id: paymentId });
  }

  await sb.from('devedor_eventos').insert({
    devedor_id: devedorId,
    cobranca_id: cobrancaId,
    tipo: 'asaas_pagamento_recebido',
    payload: {
      payment_id: paymentId,
      event,
      asaas_customer: payment.customer || null,
      installment: payment.installment || null,
      external_reference: extRef || null,
      value: payment.value ?? null,
      net_value: payment.netValue ?? null,
      billing_type: payment.billingType || null,
      payment_date: payment.paymentDate || payment.clientPaymentDate || null,
      status: payment.status || null
    },
    autor_nome: 'Asaas (webhook)'
  });

  return json({ ok: true, event, payment_id: paymentId, devedor_id: devedorId, cobranca_id: cobrancaId });
});
