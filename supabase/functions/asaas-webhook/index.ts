// Supabase Edge Function: asaas-webhook
// Recebe POST do Asaas quando um pagamento muda de estado.
//
// DINHEIRO QUE ENTRA — PAYMENT_RECEIVED / PAYMENT_CONFIRMED:
//   1. casar o pagamento ao devedor via devedores.asaas_customer_id (= payment.customer);
//   2. registrar o evento em devedor_eventos (idempotente por payment.id);
//   3. dar baixa best-effort na cobrança quando o externalReference for um uuid de
//      cobranca (o vínculo forte payment↔cobranca é gravado na emissão — PR2);
//   4. delegar a /api/processar-recebimento (recibo, operação única, split, NFS-e).
//
// PAYMENT_UPDATED (valor/vencimento alterado no Asaas) e PAYMENT_OVERDUE (vencido
// sem pagar): tratados aqui mesmo (sem passar pelo Vercel). PAYMENT_UPDATED procura
// a linha PENDENTE correspondente em fin_lancamento (por devedor_id + numero_parcela)
// e atualiza valor/vencimento — evita que o financeiro fique com dado velho quando
// um boleto é remarcado (caso real: incidente 2026-07-26). PAYMENT_OVERDUE só loga
// em devedor_eventos; "atrasado" já é calculado em tempo de leitura por data_vencimento.
//
// Os passos seguintes (recibo ao devedor, operação única recebimento↔repasse,
// preparo de PIX de repasse e NFS-e) consomem o evento de entrada nas PRs 3–6.
//
// verify_jwt: false (Asaas não tem JWT do Supabase).
// Autenticação via header `asaas-access-token: <ASAAS_WEBHOOK_SECRET>` (padrão do
// Asaas) OU query string ?token=<ASAAS_WEBHOOK_SECRET>.
//
// Setup: supabase secrets set ASAAS_WEBHOOK_SECRET=<random-32>
// Painel Asaas → Integrações → Webhooks:
//   URL: https://jokbxzhcctcwnbhkhgru.functions.supabase.co/asaas-webhook?token=<secret>
//   (ou configurar o "Token de autenticação" = secret, que vem em asaas-access-token)
//   Eventos: PAYMENT_RECEIVED, PAYMENT_CONFIRMED, PAYMENT_UPDATED, PAYMENT_OVERDUE.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, asaas-access-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ⚠️ ATIVAR SÓ APÓS TROCAR PARA HEADER NO PAINEL DO ASAAS.
// O segredo via `?token=` na URL vaza em logs/histórico/referrer; o correto é mandá-lo só
// no HEADER `asaas-access-token` (campo "Token de autenticação" do webhook, no painel).
// Enquanto a URL cadastrada ainda usa `?token=`, manter TRUE evita quebrar o webhook em
// produção. PASSO MANUAL para desligar a querystring:
//   1. Painel Asaas → Integrações → Webhooks → editar o webhook.
//   2. Remover o `?token=<secret>` da URL e preencher "Token de autenticação" = <secret>
//      (ele chega no header `asaas-access-token`).
//   3. Enviar evento de teste e confirmar 200.
//   4. Trocar esta flag para `false` e re-deployar. A partir daí, `?token=` é IGNORADO.
const ACEITAR_TOKEN_QUERYSTRING = true;

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
  const tokenQs = ACEITAR_TOKEN_QUERYSTRING ? (url.searchParams.get('token') || '').trim() : '';
  const provided =
    (req.headers.get('asaas-access-token') || '').trim() ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
    tokenQs;
  if (!(await safeEqual(provided, expected))) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'JSON inválido' }, 400); }

  const event = String(body?.event || '').toUpperCase();
  const payment = body?.payment || {};
  const paymentId = payment?.id || null;

  // PR4: eventos de TRANSFERÊNCIA (repasse PIX de saída). Conclui a operação e manda
  // o comprovante ao credor. Delega ao Vercel (lá moram Z-API/lógica de repasse).
  if (event.startsWith('TRANSFER')) {
    const transfer = body?.transfer || {};
    const base = (Deno.env.get('APP_BASE_URL') || '').replace(/\/+$/, '');
    const emitSecret = Deno.env.get('EMIT_ACORDO_SECRET');
    let result: unknown = { skipped: 'sem APP_BASE_URL/EMIT_ACORDO_SECRET' };
    if (base && emitSecret) {
      try {
        const r = await fetch(base + '/api/repasse-concluido', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-emit-secret': emitSecret },
          body: JSON.stringify({ event, transfer }),
          signal: AbortSignal.timeout(20000),
        });
        result = await r.json().catch(() => ({ status: r.status }));
      } catch (e) { result = { error: String((e as Error)?.message || e) }; }
    }
    return json({ ok: true, event, transfer_id: transfer.id || null, repasse: result });
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // PAYMENT_UPDATED (valor/vencimento mudou) e PAYMENT_OVERDUE (venceu sem pagar).
  // Não passam pelo fluxo de recebimento (PR3) — tratados aqui mesmo, direto no
  // Supabase, sem depender do endpoint Vercel.
  const ATUALIZACAO = new Set(['PAYMENT_UPDATED']);
  const ATRASO = new Set(['PAYMENT_OVERDUE']);
  if (ATUALIZACAO.has(event) || ATRASO.has(event)) {
    if (!paymentId) return json({ ok: true, ignored: 'sem payment.id' });

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
    if (!devedorId) {
      return json({ ok: true, unmatched: true, reason: 'customer sem devedor', customer: payment.customer || null, payment_id: paymentId, event });
    }

    if (ATUALIZACAO.has(event)) {
      // Propaga a mudança de valor/vencimento pra linha PENDENTE correspondente em
      // fin_lancamento — casada por devedor_id (raw_payload) + numero_parcela quando
      // o Asaas manda installmentNumber. Nunca mexe em linha já paga (status=1), nem
      // cria linha nova (isso é papel do /api/processar-recebimento na confirmação).
      let lancamentoAtualizado: string | null = null;
      try {
        let q = sb.from('fin_lancamento')
          .select('id, valor, data_vencimento, observacoes')
          .eq('status', 0).eq('tipo_movimento', 1)
          .filter('raw_payload->>devedor_id', 'eq', devedorId)
          .order('criada_em', { ascending: false })
          .limit(5);
        if (payment.installmentNumber != null) q = q.eq('numero_parcela', payment.installmentNumber);
        const { data: candidatos } = await q;
        const alvo = candidatos && candidatos[0];
        if (alvo) {
          const novoValor = payment.value != null ? Number(payment.value) : null;
          const novoVenc = payment.dueDate || null;
          const patch: Record<string, unknown> = {
            observacoes: `${alvo.observacoes || ''} | Asaas PAYMENT_UPDATED (${paymentId}) em ${new Date().toISOString().slice(0, 10)}: valor ${alvo.valor}→${novoValor ?? alvo.valor}, vencimento ${alvo.data_vencimento}→${novoVenc ?? alvo.data_vencimento}.`,
          };
          if (novoValor != null) patch.valor = novoValor;
          if (novoVenc) { patch.data_vencimento = novoVenc; patch.data_competencia = novoVenc; }
          await sb.from('fin_lancamento').update(patch).eq('id', alvo.id);
          lancamentoAtualizado = alvo.id;
        }
      } catch (e) { console.warn('[asaas-webhook] PAYMENT_UPDATED falhou: ' + String((e as Error)?.message || e)); }
      return json({ ok: true, event, payment_id: paymentId, devedor_id: devedorId, lancamento_atualizado: lancamentoAtualizado });
    }

    // PAYMENT_OVERDUE: fin_lancamento não tem (nem precisa de) um status "atrasado" —
    // o app já calcula atraso em tempo de leitura comparando data_vencimento < hoje
    // com status=0 (ver api/_diagnostico-financeiro.js, api/cron-regua.js). Aqui só
    // registramos o evento em devedor_eventos, pra auditoria/histórico do devedor.
    try {
      await sb.from('devedor_eventos').insert({
        devedor_id: devedorId,
        tipo: 'asaas_pagamento_atrasado',
        payload: {
          payment_id: paymentId, event,
          asaas_customer: payment.customer || null,
          value: payment.value ?? null,
          due_date: payment.dueDate || null,
          installment: payment.installmentNumber ?? null,
        },
        autor_nome: 'Asaas (webhook)',
      });
    } catch (e) { console.warn('[asaas-webhook] log atraso falhou: ' + String((e as Error)?.message || e)); }
    return json({ ok: true, event, payment_id: paymentId, devedor_id: devedorId, logged: 'atraso' });
  }

  // Só agimos sobre dinheiro que entra a partir daqui. Demais eventos são confirmados
  // (200) e ignorados.
  const ENTRADA = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']);
  if (!ENTRADA.has(event)) return json({ ok: true, ignored: event || 'sem evento' });
  if (!paymentId) return json({ ok: true, ignored: 'sem payment.id' });

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
  let devedorNome: string | null = null;
  let devedorDoc: string | null = null;
  if (payment.customer) {
    try {
      const { data: dev } = await sb
        .from('devedores')
        .select('id, nome, doc')
        .eq('asaas_customer_id', String(payment.customer))
        .limit(1);
      if (dev && dev[0]) {
        devedorId = dev[0].id;
        devedorNome = dev[0].nome || null;
        devedorDoc = dev[0].doc || null;
      }
    } catch {/* ignore */}
  }

  // Fila de análise de NF (Emitir NF v2): TODO recebimento entra como 'pendente'
  // — inclusive sem devedor casado (nome/cpf ficam para preencher lazy via Asaas
  // na tela). Nada é emitido automaticamente; o usuário decide na tela Emitir NF.
  // Upsert por asaas_payment_id: reenvio do Asaas não duplica. Best-effort: uma
  // falha aqui não pode derrubar o fluxo existente (recibo/split/baixa).
  try {
    const bt = String(payment.billingType || '').toUpperCase();
    const origem = bt === 'PIX' ? 'PIX'
      : bt === 'BOLETO' ? 'BOLETO'
      : (bt === 'CREDIT_CARD' || bt === 'DEBIT_CARD' || bt === 'CARTAO') ? 'CARTAO'
      : 'OUTRO';
    await sb.from('nf_fila_analise').upsert({
      asaas_payment_id: String(paymentId),
      customer_id: payment.customer ? String(payment.customer) : null,
      nome: devedorNome,
      cpf_cnpj: devedorDoc,
      valor: Number(payment.value ?? 0) || 0,
      origem
    }, { onConflict: 'asaas_payment_id', ignoreDuplicates: true });
  } catch (e) {
    console.warn('[asaas-webhook] nf_fila_analise upsert falhou: ' + String((e as Error)?.message || e));
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

  // BUG CRÍTICO até 2026-08-07: sem devedor casado, a function parava AQUI — devolvia
  // 200 pro Asaas (que então parava de reenviar) e NUNCA chamava /api/processar-recebimento.
  // Dinheiro recebido de verdade (ex.: Cecília Aparecida Federle, PIX de R$252 em
  // 07/08, sem devedor cadastrado) ficava com ZERO registro no sistema — nem
  // fin_operacao, nem lançamento, nem recibo. Isso também explica boa parte do gap
  // achado na auditoria de 06/08 (webhook só tinha processado 19 de 52 recebimentos
  // de julho). `devedor_eventos.devedor_id` é NOT NULL, então só pulamos ESSE insert
  // quando não há devedor — mas o fluxo de recebimento (PR3) segue adiante igual,
  // porque /api/processar-recebimento já lida com devedor nulo (cria a operação e o
  // lançamento sem vínculo, em vez de descartar o pagamento).
  if (devedorId) {
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
  }

  // PR3: cria a "operação única" (recebimento + split capital/honorário) e envia o
  // recibo ao devedor. Delega ao endpoint Vercel (lá moram a chave Asaas e a lógica
  // financeira). Best-effort: o evento de pagamento já foi registrado acima.
  let operacao: unknown = null;
  const base = (Deno.env.get('APP_BASE_URL') || '').replace(/\/+$/, '');
  const emitSecret = Deno.env.get('EMIT_ACORDO_SECRET');
  if (base && emitSecret) {
    try {
      const r = await fetch(base + '/api/processar-recebimento', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-emit-secret': emitSecret },
        body: JSON.stringify({ payment_id: paymentId, payment }),
        signal: AbortSignal.timeout(25000),
      });
      operacao = await r.json().catch(() => ({ status: r.status }));
    } catch (e) {
      operacao = { error: String((e as Error)?.message || e) };
      console.warn('[asaas-webhook] processar-recebimento falhou: ' + JSON.stringify(operacao));
    }
  }

  return json({ ok: true, event, payment_id: paymentId, devedor_id: devedorId, cobranca_id: cobrancaId, operacao });
});
