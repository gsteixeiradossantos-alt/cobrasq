// api/repasse-concluido.js — Conclui (ou reabre) o repasse de uma fin_operacao quando
// o Asaas notifica o resultado da transferência PIX. (PR4.) Chamado server-to-server
// pelo asaas-webhook nos eventos TRANSFER_*.
//
// - TRANSFER_DONE/CONFIRMED  → repasse_status='efetuado' + comprovante ao credor.
// - TRANSFER_FAILED/CANCELLED → volta a 'pendente' (permite refazer).
// Idempotente: se já está 'efetuado', não reenvia.

const { sbFetch } = require('./_sb.js');
const { lerDescricaoRepasse, enviarComprovanteCredor, destinoWhatsapp, primeiraParcela } = require('./_repasse-msg.js');
const { devedorPrincipal, partesDaCobranca, registrarRepasseNaFicha, resolverCobrancaId } = require('./_repasse-ficha.js');
const { guardarComprovante } = require('./_comprovante.js');
const { gerarComprovanteRepassePdf, imprimirPaginaAsaasPdf } = require('./_comprovante-pdf.js');
const { hojeBR } = require('./_data.js');
const crypto = require('crypto');

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// Todas as operações pagas pelo mesmo transfer (PIX em lote), com `op` sempre incluída.
// Sem lote, devolve [op] — o caminho de sempre.
async function grupoDoTransfer(op, transferId) {
  const lote = op.metadata && op.metadata.repasse_lote;
  const tid = transferId || op.repasse_asaas_transfer_id;
  if (!lote || !Array.isArray(lote.operacoes) || lote.operacoes.length < 2 || !tid) return [op];
  const ids = lote.operacoes.map(x => encodeURIComponent(x)).join(',');
  const rows = await sbFetch(`fin_operacao?id=in.(${ids})&repasse_asaas_transfer_id=eq.${encodeURIComponent(tid)}&select=*`).catch(() => []);
  const out = Array.isArray(rows) ? rows.filter(r => r.id !== op.id) : [];
  return [op, ...out];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!timingSafeEq(req.headers['x-emit-secret'] || '', process.env.EMIT_ACORDO_SECRET || '')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const event = String(body.event || '').toUpperCase();
  const transfer = body.transfer || {};
  const transferId = transfer.id || null;
  const opId = transfer.externalReference || null;
  if (!transferId && !opId) return res.status(400).json({ error: 'transfer sem id/externalReference' });

  try {
    // Casa a operação por externalReference (id da operação) ou pelo transfer id.
    let ops = [];
    if (opId) ops = await sbFetch(`fin_operacao?id=eq.${encodeURIComponent(opId)}&select=*&limit=1`).catch(() => []);
    if (!ops[0] && transferId) ops = await sbFetch(`fin_operacao?repasse_asaas_transfer_id=eq.${encodeURIComponent(transferId)}&select=*&limit=1`).catch(() => []);
    const op = ops[0];
    if (!op) return res.status(200).json({ ok: true, unmatched: true, transfer_id: transferId });

    const st = String(transfer.status || event.replace(/^TRANSFER_/, '')).toUpperCase();
    const falhou = /FAIL|CANCEL|ERROR/.test(st) || event === 'TRANSFER_FAILED' || event === 'TRANSFER_CANCELLED';
    const concluido = !falhou && (/DONE|CONFIRMED/.test(st) || event === 'TRANSFER_DONE' || event === 'TRANSFER_CONFIRMED');

    // P1 (auditoria 2026-06) — uma vez 'efetuado', ignora QUALQUER evento posterior
    // (inclusive um TRANSFER_FAILED tardio/fora de ordem ou reentrega de webhook).
    // Antes, um FAILED após o DONE reabria para 'pendente' e podia disparar repasse
    // em dobro. Transfer concluído não volta atrás aqui.
    //
    // PIX em lote (várias parcelas, um transfer — ver repassarLote em _repassar.js): o
    // Asaas devolve só a 1ª operação no externalReference; as outras vêm pelo transfer id.
    // O grupo conclui ou falha junto, e o credor recebe UMA mensagem.
    const grupo = await grupoDoTransfer(op, transferId);
    const abertas = grupo.filter(o => o.repasse_status !== 'efetuado');
    if (!abertas.length) {
      return res.status(200).json({ ok: true, duplicate: true, operacao_id: op.id, repasse_status: 'efetuado' });
    }
    const lote = grupo.length > 1 ? ((op.metadata && op.metadata.repasse_lote) || {}) : null;
    const valorPix = Math.round(grupo.reduce((s, o) => s + (Number(o.valor_capital) || 0), 0) * 100) / 100;
    const parcelasLote = lote ? ((lote.parcelas && lote.parcelas.length) ? lote.parcelas
      : [...new Set(grupo.map(o => Number(o.parcela) || 0).filter(n => n > 0))].sort((a, b) => a - b)) : null;

    const comprovanteUrl = transfer.transactionReceiptUrl || transfer.receiptUrl || op.repasse_comprovante_url || '';
    // P1 (auditoria 2026-06) — ao FALHAR, zera o transfer_id para liberar novo disparo
    // em /api/repassar. Sem isso, o guard anti-duplo-repasse (_repassar.js:54) trava em
    // QUALQUER transfer_id existente e devolve "repasse já disparado (sem reenvio)",
    // deixando o capital do credor preso em 'pendente' sem saída pelo app. Guarda o id
    // que falhou no metadata (auditoria).
    // Guarda o ARQUIVO do comprovante (ver _comprovante.js). Aqui é a conclusão
    // ASSÍNCRONA — a maioria dos repasses passa por este caminho, não pelo disparo.
    const arqCompr = concluido ? await guardarComprovante(comprovanteUrl, transferId || op.repasse_asaas_transfer_id) : null;
    const transferIdFalho = falhou ? (transferId || op.repasse_asaas_transfer_id || null) : null;
    const novoStatus = falhou ? 'pendente' : (concluido ? 'efetuado' : 'preparado');
    const agora = new Date().toISOString();
    await Promise.all(abertas.map(o => sbFetch(`fin_operacao?id=eq.${o.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        repasse_status: novoStatus,
        repasse_asaas_transfer_id: falhou ? null : (transferId || o.repasse_asaas_transfer_id),
        repasse_comprovante_url: comprovanteUrl || null,
        repasse_efetuado_em: concluido ? agora : o.repasse_efetuado_em,
        metadata: {
          ...(o.metadata || {}),
          repasse_asaas_status: st,
          repasse_falhou: falhou || undefined,
          ...(transferIdFalho ? { repasse_asaas_transfer_id_falho: transferIdFalho } : {}),
          ...(arqCompr ? { comprovante_storage_path: arqCompr.storage_path, comprovante_bytes: arqCompr.bytes } : {}),
        },
      }),
    })));

    // Ponte fin_lancamento: ao concluir, marca a despesa de repasse como PAGA. Move
    // data_competencia junto — senão a linha some do dia/mês em que o repasse saiu de
    // verdade e fica presa no dia em que foi cadastrada (mesmo bug do lado da receita,
    // pedido do Gustavo 2026-08-06).
    if (concluido) {
      const hoje = hojeBR();
      await Promise.all(abertas.filter(o => o.lancamento_despesa_id).map(o => sbFetch(`fin_lancamento?id=eq.${o.lancamento_despesa_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 1, data_pagamento: hoje, data_competencia: hoje, valor_pago: -(Number(o.valor_capital) || 0) }),
      }).catch(() => {})));
    }

    // Comprovante ao credor quando concluído (best-effort). Uma mensagem por PIX (no lote,
    // uma para todas as parcelas), com
    // o PDF em anexo. Parcela e devedor saem do que /api/repassar gravou na operação;
    // aqui a descrição do lançamento não chega no payload do Asaas.
    let envio = null; let ficha = null;
    if (concluido && op.credor_id) {
      const cls = await sbFetch(`clientes?id=eq.${op.credor_id}&select=id,nome,doc,telefone,metadata&limit=1`).catch(() => []);
      const credor = cls[0] || {};
      let devNome = (op.metadata && op.metadata.repasse_devedor_nome) || '';
      if (!devNome && op.devedor_id) {
        const dvs = await sbFetch(`devedores?id=eq.${op.devedor_id}&select=nome&limit=1`).catch(() => []);
        devNome = (dvs[0] && dvs[0].nome) || '';
      }
      if (!devNome && op.metadata && op.metadata.lancamento_descricao) {
        devNome = lerDescricaoRepasse(op.metadata.lancamento_descricao).devedor;
      }
      // PDF original do Asaas primeiro; página impressa e o nosso só se ele não vier
      // (ver _repassar.js).
      let pdf = (arqCompr && arqCompr.base64) || '';
      if (!pdf) pdf = await imprimirPaginaAsaasPdf(comprovanteUrl);
      if (!pdf) {
        pdf = await gerarComprovanteRepassePdf({
          credorNome: credor.nome, devedor: devNome, parcela: parcelasLote ? primeiraParcela(parcelasLote) : op.parcela,
          valor: valorPix, dataISO: hojeBR(),
          transferId: transferId || op.repasse_asaas_transfer_id,
          chavePix: (op.metadata && op.metadata.repasse_pix_key) || '', urlAsaas: comprovanteUrl,
        });
      }
      const cobId = await resolverCobrancaId(op).catch(() => null);
      const [dp, partes] = await Promise.all([
        devedorPrincipal(cobId).catch(() => null),
        partesDaCobranca(cobId).catch(() => []),
      ]);
      envio = await enviarComprovanteCredor({
        telefone: destinoWhatsapp(credor), parcela: op.parcela, total: (lote && lote.total_parcelas) || op.total_parcelas || null, devedor: devNome,
        ...(parcelasLote ? { parcelas: parcelasLote } : {}),
        doc: dp && dp.doc, partes,
        base64: pdf, ext: 'pdf', comprovanteUrl,
      });
      // Ficha do caso — idempotente pelo transacao_id, então não duplica se /api/repassar
      // já tiver registrado ao concluir na hora.
      ficha = await registrarRepasseNaFicha({
        cobrancaId: await resolverCobrancaId(op),
        credor, valor: valorPix, transferId: transferId || op.repasse_asaas_transfer_id,
        dataPix: hojeBR(), comprovante: arqCompr,
      });
    }

    return res.status(200).json({
      ok: true, operacao_id: op.id, repasse_status: novoStatus,
      ...(grupo.length > 1 ? { operacao_ids: grupo.map(o => o.id) } : {}),
      comprovante_enviado: !!(envio && envio.enviado),
      comprovante_via: (envio && envio.via) || null,
      comprovante_agendado_para: (envio && envio.agendado && envio.agendada_para) || null,
      ficha_caso: ficha ? { repasse_id: ficha.repasse_id, status_caso: ficha.status_caso || null } : null,
    });
  } catch (e) {
    console.error('[repasse-concluido]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
