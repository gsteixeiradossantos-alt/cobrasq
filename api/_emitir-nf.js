// api/emitir-nf.js — Emite a NFS-e de uma fin_operacao pelo próprio Asaas. (PR5.)
//
// Regra confirmada: tomador = DEVEDOR (quem pagou o boleto — vem automaticamente por
// vincular a nota ao pagamento). Base = HONORÁRIO quando há repasse ao credor; VALOR
// CHEIO recebido quando não há repasse.
//
// Auth: x-emit-secret (server-to-server, disparo automático) OU usuário logado (manual).
// Idempotente: pula se nf_status='emitida'. Gating do disparo automático fica em quem
// chama (processar-recebimento só dispara com AUTO_EMIT_NF=on).
//
// Pré-requisito de produção: configuração fiscal municipal habilitada na conta Asaas
// (serviço municipal, alíquota ISS). Parametrizável por env:
//   ASAAS_NF_ISS (alíquota %, default 0), ASAAS_NF_MUNICIPAL_SERVICE_CODE,
//   ASAAS_NF_MUNICIPAL_SERVICE_NAME, ASAAS_NF_SERVICE_DESCRIPTION, ASAAS_NF_RETAIN_ISS.

const crypto = require('crypto');
const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');
const { zapiSendText } = require('./_zapi.js');

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const viaSecret = timingSafeEq(req.headers['x-emit-secret'] || '', process.env.EMIT_ACORDO_SECRET || '');
  if (!viaSecret) { const user = await requireUser(req, res); if (!user) return; }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const operacaoId = body.operacao_id;
  if (!operacaoId) return res.status(400).json({ error: 'operacao_id ausente' });

  let claimed = false, opIdRevert = null, prevNf = null;
  try {
    const ops = await sbFetch(`fin_operacao?id=eq.${encodeURIComponent(operacaoId)}&select=*&limit=1`);
    const op = ops[0];
    if (!op) return res.status(404).json({ error: 'operação não encontrada' });
    if (op.nf_status === 'emitida') return res.status(200).json({ ok: true, skipped: 'NF já emitida', nf_url: op.nf_url });
    opIdRevert = op.id; prevNf = op.nf_status;

    // Base: honorário se há repasse de capital; senão o valor cheio recebido.
    const temRepasse = Number(op.valor_capital) > 0;
    const base = round2(temRepasse ? op.valor_honorario : op.valor_recebido);
    if (!(base > 0)) {
      await sbFetch(`fin_operacao?id=eq.${op.id}`, { method: 'PATCH', body: JSON.stringify({ nf_status: 'nao_aplica' }) }).catch(() => {});
      return res.status(200).json({ ok: true, skipped: 'base zero', nf_status: 'nao_aplica' });
    }
    if (!op.asaas_payment_id) return res.status(400).json({ error: 'operação sem asaas_payment_id (não dá para vincular a NF ao pagador)' });

    // P1 (auditoria 2026-06) — claim atômico anti-duplicidade: marca 'emitindo' só se o
    // status não mudou desde a leitura (lock otimista). Em chamadas concorrentes, só uma
    // ganha o claim; a outra sai sem emitir uma 2ª NF. Em erro, o catch reverte o status.
    const claimFilter = (op.nf_status == null)
      ? `id=eq.${op.id}&nf_status=is.null`
      : `id=eq.${op.id}&nf_status=eq.${encodeURIComponent(op.nf_status)}`;
    const claim = await sbFetch(`fin_operacao?${claimFilter}`, { method: 'PATCH', body: JSON.stringify({ nf_status: 'emitindo' }) }).catch(() => []);
    if (!Array.isArray(claim) || !claim[0]) {
      const cur = await sbFetch(`fin_operacao?id=eq.${op.id}&select=nf_status,nf_url`).catch(() => []);
      return res.status(200).json({ ok: true, skipped: 'emissão já em andamento/concluída', nf_status: (cur[0] && cur[0].nf_status) || null, nf_url: (cur[0] && cur[0].nf_url) || null });
    }
    claimed = true;

    const iss = Number(process.env.ASAAS_NF_ISS || 0);
    const invoicePayload = {
      // Vincular ao pagamento faz o tomador ser o pagador (devedor) automaticamente.
      payment: op.asaas_payment_id,
      serviceDescription: process.env.ASAAS_NF_SERVICE_DESCRIPTION || 'Serviços de cobrança e recuperação de crédito prestados ao tomador, referentes ao acompanhamento e à intermediação do recebimento de valores inadimplidos.',
      observations: `Operação ${op.id}${op.parcela ? ' — parcela ' + op.parcela + '/' + op.total_parcelas : ''}.`,
      value: base,
      deductions: 0,
      effectiveDate: new Date().toISOString().slice(0, 10),
      taxes: {
        retainIss: String(process.env.ASAAS_NF_RETAIN_ISS || '').toLowerCase() === 'true',
        iss, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0,
      },
    };
    if (process.env.ASAAS_NF_MUNICIPAL_SERVICE_ID) invoicePayload.municipalServiceId = process.env.ASAAS_NF_MUNICIPAL_SERVICE_ID;
    else if (process.env.ASAAS_NF_MUNICIPAL_SERVICE_CODE) invoicePayload.municipalServiceCode = process.env.ASAAS_NF_MUNICIPAL_SERVICE_CODE;
    if (process.env.ASAAS_NF_MUNICIPAL_SERVICE_NAME) invoicePayload.municipalServiceName = process.env.ASAAS_NF_MUNICIPAL_SERVICE_NAME;

    // Cria e autoriza (emite de fato) a NFS-e.
    const invoice = await asaasReq('POST', '/invoices', invoicePayload);
    let authorized = invoice;
    try { authorized = await asaasReq('POST', `/invoices/${invoice.id}/authorize`, {}); }
    catch (e) { /* fica como agendada; o status real vem no GET/retorno */ authorized = { ...invoice, _authorizeError: e.message }; }

    // A NFS-e é autorizada pela prefeitura de forma ASSÍNCRONA: o /authorize NÃO-erro só
    // agenda; não significa autorizada. Só marca 'emitida' quando status=AUTHORIZED (ou já
    // veio pdfUrl). Senão fica 'processando' (reconcilia depois). ERROR já traz o motivo.
    // Evita o falso-positivo "emitida sem PDF" — mesma regra do avulso (_emitir-nf-avulso).
    const st = String(authorized.status || invoice.status || '').toUpperCase();
    const nfUrl = authorized.pdfUrl || authorized.xmlUrl || invoice.pdfUrl || '';
    let nfStatus, nfErro = null;
    if (st === 'AUTHORIZED' || nfUrl) nfStatus = 'emitida';
    else if (st === 'ERROR') { nfStatus = 'erro'; nfErro = (authorized.errors && authorized.errors[0] && authorized.errors[0].description) || authorized.statusDescription || authorized._authorizeError || 'Recusada pela prefeitura'; }
    else nfStatus = 'processando';
    await sbFetch(`fin_operacao?id=eq.${op.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        nf_status: nfStatus,
        nf_asaas_id: invoice.id || null,
        nf_url: nfUrl || null,
        metadata: { ...(op.metadata || {}), nf_base: base, nf_base_tipo: temRepasse ? 'honorario' : 'valor_cheio', nf_number: authorized.number || null, ...(nfErro ? { nf_erro: nfErro } : {}) },
      }),
    });

    // Manda a NF ao devedor (best-effort).
    let zap = null;
    if (nfUrl && op.devedor_id) {
      const dvs = await sbFetch(`devedores?id=eq.${op.devedor_id}&select=nome,telefone&limit=1`).catch(() => []);
      const dev = dvs[0];
      const tel = String((dev && dev.telefone) || '').replace(/\D/g, '');
      if (tel) {
        try { zap = await zapiSendText(tel, `Sua nota fiscal foi emitida. 🧾\n${nfUrl}\n\n— Cobrasq`); }
        catch (e) { zap = { error: e.message }; }
      }
    }

    return res.status(200).json({ ok: true, operacao_id: op.id, nf_status: nfStatus, nf_id: invoice.id || null, nf_url: nfUrl || null, base, base_tipo: temRepasse ? 'honorario' : 'valor_cheio', nf_enviada: !!(zap && zap.messageId) });
  } catch (e) {
    if (claimed && opIdRevert) {
      // libera o claim (não deixa a operação presa em 'emitindo') para permitir nova tentativa.
      await sbFetch(`fin_operacao?id=eq.${opIdRevert}`, { method: 'PATCH', body: JSON.stringify({ nf_status: prevNf || 'pendente' }) }).catch(() => {});
    }
    console.error('[emitir-nf]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
