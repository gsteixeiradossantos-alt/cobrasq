// api/repasse-concluido.js — Conclui (ou reabre) o repasse de uma fin_operacao quando
// o Asaas notifica o resultado da transferência PIX. (PR4.) Chamado server-to-server
// pelo asaas-webhook nos eventos TRANSFER_*.
//
// - TRANSFER_DONE/CONFIRMED  → repasse_status='efetuado' + comprovante ao credor.
// - TRANSFER_FAILED/CANCELLED → volta a 'pendente' (permite refazer).
// Idempotente: se já está 'efetuado', não reenvia.

const { sbFetch } = require('./_sb.js');
const { lerDescricaoRepasse, enviarComprovanteCredor, destinoWhatsapp } = require('./_repasse-msg.js');
const { devedorPrincipal, registrarRepasseNaFicha, resolverCobrancaId } = require('./_repasse-ficha.js');
const { guardarComprovante } = require('./_comprovante.js');
const { gerarComprovanteRepassePdf, imprimirPaginaAsaasPdf } = require('./_comprovante-pdf.js');
const crypto = require('crypto');

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

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
    if (op.repasse_status === 'efetuado') {
      return res.status(200).json({ ok: true, duplicate: true, operacao_id: op.id, repasse_status: 'efetuado' });
    }

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
    const update = {
      repasse_status: falhou ? 'pendente' : (concluido ? 'efetuado' : 'preparado'),
      repasse_asaas_transfer_id: falhou ? null : (transferId || op.repasse_asaas_transfer_id),
      repasse_comprovante_url: comprovanteUrl || null,
      repasse_efetuado_em: concluido ? new Date().toISOString() : op.repasse_efetuado_em,
      metadata: {
        ...(op.metadata || {}),
        repasse_asaas_status: st,
        repasse_falhou: falhou || undefined,
        ...(transferIdFalho ? { repasse_asaas_transfer_id_falho: transferIdFalho } : {}),
        ...(arqCompr ? { comprovante_storage_path: arqCompr.storage_path, comprovante_bytes: arqCompr.bytes } : {}),
      },
    };
    await sbFetch(`fin_operacao?id=eq.${op.id}`, { method: 'PATCH', body: JSON.stringify(update) });

    // Ponte fin_lancamento: ao concluir, marca a despesa de repasse como PAGA. Move
    // data_competencia junto — senão a linha some do dia/mês em que o repasse saiu de
    // verdade e fica presa no dia em que foi cadastrada (mesmo bug do lado da receita,
    // pedido do Gustavo 2026-08-06).
    if (concluido && op.lancamento_despesa_id) {
      const hoje = new Date().toISOString().slice(0, 10);
      await sbFetch(`fin_lancamento?id=eq.${op.lancamento_despesa_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 1, data_pagamento: hoje, data_competencia: hoje, valor_pago: -(Number(op.valor_capital) || 0) }),
      }).catch(() => {});
    }

    // Comprovante ao credor quando concluído (best-effort). Uma mensagem por PIX, com
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
      // Comprovante do BANCO primeiro; o nosso só se o Asaas não entregar (ver _repassar.js).
      let pdf = await imprimirPaginaAsaasPdf(comprovanteUrl);
      if (!pdf) pdf = (arqCompr && arqCompr.base64) || '';
      if (!pdf) {
        pdf = await gerarComprovanteRepassePdf({
          credorNome: credor.nome, devedor: devNome, parcela: op.parcela,
          valor: op.valor_capital, dataISO: new Date().toISOString().slice(0, 10),
          transferId: transferId || op.repasse_asaas_transfer_id,
          chavePix: (op.metadata && op.metadata.repasse_pix_key) || '', urlAsaas: comprovanteUrl,
        });
      }
      const dp = await devedorPrincipal(await resolverCobrancaId(op).catch(() => null)).catch(() => null);
      envio = await enviarComprovanteCredor({
        telefone: destinoWhatsapp(credor), parcela: op.parcela, devedor: devNome,
        doc: dp && dp.doc,
        base64: pdf, ext: 'pdf', comprovanteUrl,
      });
      // Ficha do caso — idempotente pelo transacao_id, então não duplica se /api/repassar
      // já tiver registrado ao concluir na hora.
      ficha = await registrarRepasseNaFicha({
        cobrancaId: await resolverCobrancaId(op),
        credor, valor: op.valor_capital, transferId: transferId || op.repasse_asaas_transfer_id,
        dataPix: new Date().toISOString().slice(0, 10), comprovante: arqCompr,
      });
    }

    return res.status(200).json({
      ok: true, operacao_id: op.id, repasse_status: update.repasse_status,
      comprovante_enviado: !!(envio && envio.enviado),
      comprovante_via: (envio && envio.via) || null,
      ficha_caso: ficha ? { repasse_id: ficha.repasse_id, status_caso: ficha.status_caso || null } : null,
    });
  } catch (e) {
    console.error('[repasse-concluido]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
