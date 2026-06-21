// api/emitir-acordo.js — Emite o parcelamento no Asaas para um acordo ASSINADO e
// manda o boleto/PIX ao devedor por WhatsApp. (PR2 do roadmap de automação.)
//
// Chamado por:
//   - zapsign-webhook (Supabase edge) ao assinar — server-to-server, header
//     x-emit-secret == EMIT_ACORDO_SECRET. Gated por AUTO_EMIT_ACORDO=on para não
//     duplicar com o fluxo n8n legado enquanto ele não é desligado.
//   - app (botão manual no Faturamento) — usuário Supabase logado; sempre emite.
//
// Idempotência: pula se o acordo já tem cobranca_id OU metadata.boletos_emitidos.
// externalReference do pagamento = acordo.id (a baixa por parcela e a "operação
// única" recebimento↔repasse são fechadas na PR3, que consome o asaas-webhook).

const crypto = require('crypto');
const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq, ensureAsaasCustomer } = require('./_asaas.js');
const { zapiSendText } = require('./_zapi.js');

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function addDaysISO(d) { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'tudo bem'; }
// Mensagem padrão do boleto no WhatsApp (emissão e reenvio).
function boletoMsg(nome, link) {
  return `*Financeiro COBRASQ:*\n`
    + `Olá, ${firstName(nome)}! Como vai?\n`
    + `Informamos que os boletos referentes ao nosso acordo realizado recentemente foram emitidos e estão disponíveis para pagamento. Para acessá-los basta clicar no link a seguir:\n\n`
    + `Link do boleto:\n${link}\n\n`
    + `_ Se precisar de alguma ajuda, é só nos chamar._`;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: server-to-server (segredo) OU usuário logado (chamada manual).
  const secret = process.env.EMIT_ACORDO_SECRET || '';
  const viaSecret = timingSafeEq(req.headers['x-emit-secret'] || '', secret);
  let manual = false;
  if (!viaSecret) {
    const user = await requireUser(req, res);
    if (!user) return; // requireUser já respondeu 401/5xx
    manual = true;
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const acordoId = body.acordo_id || req.query.acordo_id;
  if (!acordoId) return res.status(400).json({ error: 'acordo_id ausente' });

  let claimedAcordo = false, acordoRef = null, prevMeta = null, devedorRef = null;
  try {
    const acs = await sbFetch(`acordos?id=eq.${encodeURIComponent(acordoId)}&select=*&limit=1`);
    const acordo = acs[0];
    if (!acordo) return res.status(404).json({ error: 'acordo não encontrado' });

    const meta = acordo.metadata || {};

    // Modo REENVIO: acordo já emitido → só reenvia o link do boleto por WhatsApp (não
    // cria boleto novo). Grava metadata.whatsapp_ok com o resultado (alimenta o Painel).
    if ((body.resend === true || req.query.resend) && (acordo.cobranca_id || meta.boletos_emitidos)) {
      const url = meta.asaas_invoice_url || '';
      const dvs = await sbFetch(`devedores?id=eq.${acordo.devedor_id}&select=nome,telefone&limit=1`);
      const dev = dvs[0];
      const tel = String((dev && dev.telefone) || '').replace(/\D/g, '');
      if (!tel || !url) return res.status(200).json({ ok: true, acordo_id: acordoId, reenviado: false, motivo: !tel ? 'devedor sem telefone' : 'acordo sem link' });
      let zap = null;
      try { zap = await zapiSendText(tel, boletoMsg(dev.nome, url)); }
      catch (e) { zap = { error: e.message }; }
      const enviado = !!(zap && zap.messageId);
      await sbFetch(`acordos?id=eq.${acordo.id}`, { method: 'PATCH', body: JSON.stringify({ metadata: { ...meta, whatsapp_ok: enviado } }) }).catch(() => {});
      await sbFetch('devedor_eventos', { method: 'POST', body: JSON.stringify({ devedor_id: acordo.devedor_id, tipo: 'asaas_boletos_emitidos', payload: { acordo_id: acordoId, invoice_url: url, whatsapp: enviado ? 'enviado' : 'falha', via: 'reenvio' }, autor_nome: 'Faturamento (reenvio)' }) }).catch(() => {});
      return res.status(200).json({ ok: true, acordo_id: acordoId, reenviado: enviado, erro: enviado ? undefined : (zap && zap.error) });
    }

    if (acordo.cobranca_id || meta.boletos_emitidos) {
      return res.status(200).json({ ok: true, skipped: 'já emitido', acordo_id: acordoId });
    }
    acordoRef = acordo.id; prevMeta = meta; devedorRef = acordo.devedor_id;
    // Trava anti-duplicação com o n8n: automático só emite com AUTO_EMIT_ACORDO=on.
    if (!manual && String(process.env.AUTO_EMIT_ACORDO || '').toLowerCase() !== 'on') {
      return res.status(200).json({ ok: true, skipped: 'auto-emit desligado (AUTO_EMIT_ACORDO≠on)', acordo_id: acordoId });
    }

    const devs = await sbFetch(`devedores?id=eq.${acordo.devedor_id}&select=id,nome,doc,email,telefone,asaas_customer_id,cep,numero,complemento,bairro,cidade,uf,endereco,endereco_crm&limit=1`);
    const dev = devs[0];
    if (!dev) return res.status(404).json({ error: 'devedor não encontrado' });

    const { customerId, created } = await ensureAsaasCustomer(dev);
    if (customerId && customerId !== dev.asaas_customer_id) {
      await sbFetch(`devedores?id=eq.${dev.id}`, { method: 'PATCH', body: JSON.stringify({ asaas_customer_id: customerId }) }).catch(() => {});
    }

    // Monta o parcelamento a partir dos termos do acordo.
    const parcelas = Array.isArray(acordo.parcelas) ? acordo.parcelas : [];
    const nParc = acordo.num_parcelas || parcelas.length || 1;
    const total = Number(acordo.valor_total) || parcelas.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    if (!(total > 0)) return res.status(400).json({ error: 'acordo sem valor_total' });
    const firstDue = acordo.data_primeiro_venc || (parcelas[0] && (parcelas[0].venc || parcelas[0].vencimento)) || addDaysISO(3);

    // P1 (auditoria 2026-06) — claim atômico anti-duplicidade antes de criar o
    // parcelamento no Asaas. O UPDATE com WHERE em metadata->>emitindo/boletos_emitidos
    // é serializado pelo lock de linha do Postgres: só uma chamada concorrente passa;
    // a outra sai sem emitir uma 2ª série de boletos. O catch reverte em caso de erro.
    const claim = await sbFetch(
      `acordos?id=eq.${acordo.id}&cobranca_id=is.null&metadata->>boletos_emitidos=is.null&metadata->>emitindo=is.null`,
      { method: 'PATCH', body: JSON.stringify({ metadata: { ...meta, emitindo: new Date().toISOString() } }) }
    ).catch(() => []);
    if (!Array.isArray(claim) || !claim[0]) {
      return res.status(200).json({ ok: true, skipped: 'emissão já em andamento/concluída', acordo_id: acordoId });
    }
    claimedAcordo = true;

    // 1x = boleto único (campo `value`); 2x+ = parcelamento (installmentCount+totalValue).
    // O Asaas rejeita installmentCount=1, então os casos são separados.
    const pay = {
      customer: customerId,
      billingType: 'BOLETO',
      dueDate: firstDue,
      description: `Acordo ${dev.nome}${nParc > 1 ? ` — ${nParc}x` : ' — à vista'}`,
      externalReference: acordo.id,
      fine: { value: 2 },
      interest: { value: 1 },
    };
    if (nParc > 1) { pay.installmentCount = nParc; pay.totalValue = round2(total); }
    else { pay.value = round2(total); }
    const charge = await asaasReq('POST', '/payments', pay);
    // charge = pagamento da 1ª parcela; charge.installment = id da série.
    const invoiceUrl = charge.invoiceUrl || charge.bankSlipUrl || '';

    const newMeta = {
      ...meta,
      boletos_emitidos: true,
      emitido_em: new Date().toISOString(),
      emitido_via: manual ? 'manual' : 'auto',
      asaas_installment_id: charge.installment || null,
      asaas_first_payment_id: charge.id || null,
      asaas_invoice_url: invoiceUrl,
      asaas_customer_id: customerId,
    };
    await sbFetch(`acordos?id=eq.${acordo.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ativo', metadata: newMeta }) });

    // WhatsApp com o link do boleto/PIX (best-effort, não derruba a emissão).
    let zap = null;
    const tel = String(dev.telefone || '').replace(/\D/g, '');
    if (tel && invoiceUrl) {
      const msg = boletoMsg(dev.nome, invoiceUrl);
      try { zap = await zapiSendText(tel, msg); } catch (e) { zap = { error: e.message }; }
    }

    // Marca no acordo se o WhatsApp do boleto saiu (alimenta o alerta/reenvio do Painel).
    await sbFetch(`acordos?id=eq.${acordo.id}`, { method: 'PATCH', body: JSON.stringify({ metadata: { ...newMeta, whatsapp_ok: !!(zap && zap.messageId) } }) }).catch(() => {});

    await sbFetch('devedor_eventos', {
      method: 'POST',
      body: JSON.stringify({
        devedor_id: dev.id,
        tipo: 'asaas_boletos_emitidos',
        payload: {
          acordo_id: acordo.id,
          installment: charge.installment || null,
          parcelas: nParc,
          total,
          invoice_url: invoiceUrl,
          whatsapp: zap && zap.messageId ? 'enviado' : 'falha/sem-tel',
          via: manual ? 'manual' : 'auto',
        },
        autor_nome: manual ? 'Faturamento (manual)' : 'ZapSign (auto)',
      }),
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      acordo_id: acordo.id,
      installment: charge.installment || null,
      parcelas: nParc,
      total,
      invoice_url: invoiceUrl,
      whatsapp: !!(zap && zap.messageId),
      customer_criado: created,
    });
  } catch (e) {
    if (claimedAcordo && acordoRef) {
      // libera o claim (remove metadata.emitindo) para permitir nova tentativa.
      await sbFetch(`acordos?id=eq.${acordoRef}`, { method: 'PATCH', body: JSON.stringify({ metadata: prevMeta || {} }) }).catch(() => {});
    }
    console.error('[emitir-acordo]', e.message);
    // ALERTA DE FALHA (auditoria 2026-06): registra o evento e avisa o gestor por
    // WhatsApp, p/ "assinou mas não emitiu por erro" nunca mais passar despercebido.
    // O número do gestor vem de ALERT_WHATSAPP_TO (só dígitos, com DDI 55).
    try {
      if (devedorRef) {
        await sbFetch('devedor_eventos', {
          method: 'POST',
          body: JSON.stringify({
            devedor_id: devedorRef,
            tipo: 'asaas_emissao_falhou',
            payload: { acordo_id: acordoId, erro: String(e.message || e), via: manual ? 'manual' : 'auto' },
            autor_nome: 'Sistema (falha na emissão)',
          }),
        }).catch(() => {});
      }
      const alertTo = String(process.env.ALERT_WHATSAPP_TO || '').replace(/\D/g, '');
      if (alertTo) {
        await zapiSendText(alertTo,
          `⚠️ COBRASQ — falha ao emitir boleto.\n` +
          `Acordo: ${acordoId}\nErro: ${String(e.message || e)}\n\n` +
          `O acordo foi liberado p/ nova tentativa. Confira no painel (funil_automacao).`
        ).catch(() => {});
      }
    } catch (_) { /* alerta é best-effort, não pode mascarar o erro original */ }
    return res.status(500).json({ error: e.message });
  }
};
