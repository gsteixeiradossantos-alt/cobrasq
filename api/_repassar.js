// api/repassar.js — Dispara o repasse PIX ao credor (Asaas /transfers) para uma
// fin_operacao. (PR4 — repasse SEMIAUTOMÁTICO: o usuário confirma antes de disparar.)
//
// Auth: usuário Supabase logado (a confirmação é manual, por design). Body:
//   { operacao_id, pix_key?, pix_key_type? }
// Se pix_key não vier, usa clientes.metadata.pix_key; senão cai no CPF/CNPJ do credor.
// A chave informada é persistida em clientes.metadata.pix_key para reuso.
//
// O Asaas pode concluir o PIX de forma assíncrona: se o transfer voltar DONE marcamos
// 'efetuado' e mandamos o comprovante ao credor na hora; senão fica 'preparado' e o
// asaas-webhook conclui ao receber TRANSFER_DONE.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');
const { zapiSendText } = require('./_zapi.js');
const { guardarComprovante } = require('./_comprovante.js');

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function fmtR(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Monta a mensagem de comprovante ao credor (reutilizada aqui e no webhook).
function msgComprovante(op, credorNome, devNome, comprovanteUrl) {
  const parc = op.parcela && op.total_parcelas ? `, parcela ${op.parcela}/${op.total_parcelas}` : '';
  const ref = devNome ? ` referente ao pagamento de ${devNome}${parc}` : '';
  return `${credorNome ? credorNome + ', ' : ''}repasse efetuado${ref}: ${fmtR(op.valor_capital)}. ✅\n\n` +
    (comprovanteUrl ? `Comprovante: ${comprovanteUrl}\n\n` : '') + `— Cobrasq`;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  let operacaoId = body.operacao_id;

  // Pagar direto de um lançamento de saída (repasse importado do Controlle).
  //
  // Em 14/08/2026 havia 323 repasses em aberto no Financeiro (R$ 123.448,19) e só 8
  // tinham fin_operacao — os outros vieram da importação e ficavam fora do alcance
  // deste endpoint. Em vez de duplicar o fluxo, resolvemos/criamos a fin_operacao a
  // partir do lançamento e seguimos pelo caminho de sempre: assim o repasse herda a
  // trava anti-duplo-repasse, a reconciliação do transfer e a conclusão pelo webhook,
  // sem nenhuma cópia de lógica de pagamento.
  //
  // A operação é criada SÓ na hora de pagar, não em backfill: aqui já se conhece o
  // valor, o credor e o lançamento, então ela nasce completa em vez de pela metade.
  if (!operacaoId && body.lancamento_id) {
    try {
      const lancId = String(body.lancamento_id).replace(/\D/g, '');
      if (!lancId) return res.status(400).json({ error: 'lancamento_id inválido' });
      const lancs = await sbFetch(`fin_lancamento?id=eq.${lancId}&select=id,descricao,valor,tipo_movimento,status,cobranca_id,numero_parcela,total_parcelas&limit=1`);
      const lanc = lancs[0];
      if (!lanc) return res.status(404).json({ error: 'lançamento não encontrado' });
      if (lanc.tipo_movimento !== 0) return res.status(400).json({ error: 'lançamento não é uma saída' });
      if (lanc.status !== 0) return res.status(200).json({ ok: true, skipped: 'lançamento já baixado', lancamento_id: lanc.id });

      // Já existe operação para este lançamento? Então é retry — reaproveita.
      const jaTem = await sbFetch(`fin_operacao?lancamento_despesa_id=eq.${lanc.id}&select=id&limit=1`).catch(() => []);
      if (Array.isArray(jaTem) && jaTem[0]) {
        operacaoId = jaTem[0].id;
      } else {
        // Credor: cobrança → cliente. Sem credor não há para quem transferir.
        let credorId = null, devedorId = lanc.cobranca_id || null;
        if (lanc.cobranca_id) {
          const cobs = await sbFetch(`cobrancas?id=eq.${lanc.cobranca_id}&select=cliente_id&limit=1`).catch(() => []);
          credorId = (cobs[0] && cobs[0].cliente_id) || null;
        }
        if (!credorId && !body.credor_id) {
          return res.status(400).json({ error: 'lançamento sem credor vinculado — informe credor_id ou vincule a cobrança' });
        }
        const nova = await sbFetch('fin_operacao', {
          method: 'POST', prefer: 'return=representation',
          body: JSON.stringify({
            credor_id: body.credor_id || credorId,
            devedor_id: devedorId,
            valor_capital: round2(Math.abs(Number(lanc.valor) || 0)),
            parcela: lanc.numero_parcela, total_parcelas: lanc.total_parcelas,
            lancamento_despesa_id: lanc.id,
            recebimento_status: 'recebido', repasse_status: 'pendente',
            metadata: { origem: 'lancamento', lancamento_descricao: lanc.descricao, criada_em: new Date().toISOString() },
          }),
        });
        operacaoId = Array.isArray(nova) ? (nova[0] && nova[0].id) : (nova && nova.id);
        if (!operacaoId) return res.status(500).json({ error: 'não foi possível preparar o repasse' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'falha ao preparar repasse do lançamento: ' + e.message });
    }
  }

  if (!operacaoId) return res.status(400).json({ error: 'operacao_id ou lancamento_id ausente' });

  try {
    const ops = await sbFetch(`fin_operacao?id=eq.${encodeURIComponent(operacaoId)}&select=*&limit=1`);
    const op = ops[0];
    if (!op) return res.status(404).json({ error: 'operação não encontrada' });
    if (!(Number(op.valor_capital) > 0)) return res.status(400).json({ error: 'operação sem capital a repassar' });
    if (op.repasse_status === 'efetuado') return res.status(200).json({ ok: true, skipped: 'repasse já efetuado', operacao_id: op.id });
    if (op.repasse_status === 'nao_aplica') return res.status(400).json({ error: 'operação não tem repasse' });

    // P1 (auditoria 2026-06) — anti-duplo-repasse: se já existe um /transfers
    // disparado (status 'preparado' aguardando o assíncrono do Asaas), NÃO cria
    // outro. Reconcilia o status do transfer existente e retorna; só envia um novo
    // PIX quando ainda não há transfer vinculado à operação.
    if (op.repasse_asaas_transfer_id) {
      const tr = await asaasReq('GET', `/transfers/${encodeURIComponent(op.repasse_asaas_transfer_id)}`).catch(() => null);
      const stExist = String((tr && tr.status) || op.metadata?.repasse_asaas_status || '').toUpperCase();
      const doneExist = stExist === 'DONE' || stExist === 'CONFIRMED';
      if (doneExist && op.repasse_status !== 'efetuado') {
        await sbFetch(`fin_operacao?id=eq.${op.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            repasse_status: 'efetuado',
            repasse_efetuado_em: new Date().toISOString(),
            repasse_comprovante_url: (tr && (tr.transactionReceiptUrl || tr.receiptUrl)) || op.repasse_comprovante_url || null,
            metadata: { ...(op.metadata || {}), repasse_asaas_status: stExist },
          }),
        }).catch(() => {});
      }
      return res.status(200).json({
        ok: true,
        skipped: 'repasse já disparado (sem reenvio)',
        operacao_id: op.id,
        transfer_id: op.repasse_asaas_transfer_id,
        asaas_status: stExist || null,
        repasse_status: doneExist ? 'efetuado' : op.repasse_status,
      });
    }

    // Credor + chave PIX.
    let credor = null;
    if (op.credor_id) {
      const cls = await sbFetch(`clientes?id=eq.${op.credor_id}&select=id,nome,telefone,doc,metadata&limit=1`);
      credor = cls[0] || null;
    }
    if (!credor) return res.status(400).json({ error: 'credor não vinculado à operação' });

    const credMeta = credor.metadata || {};
    const pixKey = (body.pix_key || credMeta.pix_key || (credor.doc || '').replace(/\D/g, '') || '').trim();
    if (!pixKey) return res.status(400).json({ error: 'informe a chave PIX do credor (pix_key)' });

    // Devedor (para o texto do comprovante).
    let devNome = '';
    if (op.devedor_id) {
      const dvs = await sbFetch(`devedores?id=eq.${op.devedor_id}&select=nome&limit=1`).catch(() => []);
      devNome = (dvs[0] && dvs[0].nome) || '';
    }

    // Trava atômica anti-duplo-repasse: só prossegue quem conseguir transicionar
    // pendente→preparado. Em duplo-clique concorrente, o 2º não obtém o claim e sai
    // sem disparar um segundo PIX. Reverte para 'pendente' se a emissão falhar (abaixo).
    const claim = await sbFetch(`fin_operacao?id=eq.${op.id}&repasse_status=eq.pendente`, {
      method: 'PATCH', prefer: 'return=representation',
      body: JSON.stringify({ repasse_status: 'preparado' }),
    }).catch(() => null);
    if (!Array.isArray(claim) || claim.length === 0) {
      return res.status(200).json({ ok: true, skipped: 'repasse já em andamento (claim não obtido)', operacao_id: op.id });
    }

    // Dispara o PIX no Asaas.
    const transferPayload = {
      value: round2(op.valor_capital),
      pixAddressKey: pixKey,
      operationType: 'PIX',
      // Descrição editável (regra "Repasses a clientes": "<nº parcela> - <devedor>").
      // Se o front não mandar, cai no texto padrão. Trunca em 500 (limite Asaas).
      description: (body.descricao && String(body.descricao).trim().slice(0, 500)) || `Repasse Cobrasq — ${credor.nome || 'credor'}${op.parcela ? ' — parcela ' + op.parcela + '/' + op.total_parcelas : ''}`,
      externalReference: op.id,
    };
    if (body.pix_key_type) transferPayload.pixAddressKeyType = body.pix_key_type;
    let transfer;
    try {
      transfer = await asaasReq('POST', '/transfers', transferPayload);
    } catch (e) {
      // Falhou ao disparar: reverte o claim (só se nenhum transfer foi criado) p/ permitir retry.
      await sbFetch(`fin_operacao?id=eq.${op.id}&repasse_asaas_transfer_id=is.null`, {
        method: 'PATCH', body: JSON.stringify({ repasse_status: 'pendente' }),
      }).catch(() => {});
      throw e;
    }

    const st = String(transfer.status || '').toUpperCase();
    const concluido = st === 'DONE' || st === 'CONFIRMED';
    const comprovanteUrl = transfer.transactionReceiptUrl || transfer.receiptUrl || '';

    // Guarda o ARQUIVO do comprovante, não só o link do Asaas (ver _comprovante.js).
    // Best-effort: o PIX já saiu, então falhar aqui não pode derrubar o repasse.
    const arq = concluido ? await guardarComprovante(comprovanteUrl, transfer.id) : null;

    const update = {
      repasse_status: concluido ? 'efetuado' : 'preparado',
      repasse_asaas_transfer_id: transfer.id || null,
      repasse_comprovante_url: comprovanteUrl || null,
      repasse_efetuado_em: concluido ? new Date().toISOString() : null,
      metadata: {
        ...(op.metadata || {}), repasse_pix_key: pixKey, repasse_asaas_status: st,
        ...(arq ? { comprovante_storage_path: arq.storage_path, comprovante_bytes: arq.bytes } : {}),
      },
    };
    await sbFetch(`fin_operacao?id=eq.${op.id}`, { method: 'PATCH', body: JSON.stringify(update) });

    // Ponte fin_lancamento: ao efetivar, marca a despesa de repasse como PAGA. Move
    // data_competencia junto (mesmo motivo do lado da receita — ver _repasse-concluido.js).
    if (concluido && op.lancamento_despesa_id) {
      const hoje = new Date().toISOString().slice(0, 10);
      await sbFetch(`fin_lancamento?id=eq.${op.lancamento_despesa_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 1, data_pagamento: hoje, data_competencia: hoje, valor_pago: -round2(op.valor_capital) }),
      }).catch(() => {});
    }

    // Persiste a chave PIX no credor para reuso (best-effort).
    if (body.pix_key && body.pix_key !== credMeta.pix_key) {
      await sbFetch(`clientes?id=eq.${credor.id}`, {
        method: 'PATCH', body: JSON.stringify({ metadata: { ...credMeta, pix_key: pixKey } }),
      }).catch(() => {});
    }

    // Se já concluiu, manda o comprovante ao credor agora (senão, vai no webhook).
    let zap = null;
    const telCred = String(credor.telefone || '').replace(/\D/g, '');
    if (concluido && telCred) {
      try { zap = await zapiSendText(telCred, msgComprovante({ ...op, ...update }, credor.nome, devNome, comprovanteUrl)); }
      catch (e) { zap = { error: e.message }; }
    }

    return res.status(200).json({
      ok: true,
      operacao_id: op.id,
      transfer_id: transfer.id || null,
      asaas_status: st,
      repasse_status: update.repasse_status,
      comprovante_url: comprovanteUrl || null,
      comprovante_enviado: !!(zap && zap.messageId),
    });
  } catch (e) {
    console.error('[repassar]', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.msgComprovante = msgComprovante;
