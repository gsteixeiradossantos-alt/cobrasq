// api/repassar.js — Dispara o repasse PIX ao credor (Asaas /transfers) para uma
// fin_operacao. (PR4 — repasse SEMIAUTOMÁTICO: o usuário confirma antes de disparar.)
//
// Auth: usuário Supabase logado (a confirmação é manual, por design). Body:
//   { operacao_id, pix_key?, pix_key_type? }
// Se pix_key não vier, usa a COLUNA clientes.chave_pix — que é o campo "Chave PIX" da
// tela de cadastro de cliente. Depois tenta metadata.pix_key (legado) e, por último, o
// CPF/CNPJ do credor. A chave informada é persistida na coluna para reuso.
//
// Até 17/08/2026 este endpoint lia SÓ metadata.pix_key: a chave digitada no painel nunca
// era usada para pagar, e o que se gravava no metadata por fora era destruído no primeiro
// save de cliente (o painel remontava o metadata do zero). A coluna é a fonte.
//
// O Asaas pode concluir o PIX de forma assíncrona: se o transfer voltar DONE marcamos
// 'efetuado' e mandamos o comprovante ao credor na hora; senão fica 'preparado' e o
// asaas-webhook conclui ao receber TRANSFER_DONE.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');
const { guardarComprovante } = require('./_comprovante.js');
const { gerarComprovanteRepassePdf, imprimirPaginaAsaasPdf } = require('./_comprovante-pdf.js');
const { lerDescricaoRepasse, descricaoPix, enviarComprovanteCredor, destinoWhatsapp } = require('./_repasse-msg.js');
const { saldoDeCapital } = require('./_repasse-ficha.js');
const { registrarRepasseNaFicha, resolverCobrancaId } = require('./_repasse-ficha.js');

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function fmtBRL(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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
      const lancs = await sbFetch(`fin_lancamento?id=eq.${lancId}&select=id,descricao,valor,tipo_movimento,status,cobranca_id,credor_id,numero_parcela,total_parcelas&limit=1`);
      const lanc = lancs[0];
      if (!lanc) return res.status(404).json({ error: 'lançamento não encontrado' });
      if (lanc.tipo_movimento !== 0) return res.status(400).json({ error: 'lançamento não é uma saída' });
      if (lanc.status !== 0) return res.status(200).json({ ok: true, skipped: 'lançamento já baixado', lancamento_id: lanc.id });

      // Já existe operação para este lançamento? Então é retry — reaproveita.
      const jaTem = await sbFetch(`fin_operacao?lancamento_despesa_id=eq.${lanc.id}&select=id&limit=1`).catch(() => []);
      if (Array.isArray(jaTem) && jaTem[0]) {
        operacaoId = jaTem[0].id;
      } else {
        // Credor, em ordem de precedência: o que o usuário escolheu agora → o já
        // gravado no lançamento → a cobrança.
        //
        // Em 16/08/2026, 239 dos 323 repasses em aberto (R$ 79.941,69) não chegavam a
        // um cliente: a cadeia devedor → cobrança → cliente está quebrada na origem —
        // dos devedores testados, a maioria existe em `devedores` mas sem cobrança que
        // aponte cliente, e alguns não existem nem como devedor. Depender só da cobrança
        // deixaria esse dinheiro sem caminho de pagamento por tempo indeterminado.
        let devedorId = lanc.cobranca_id || null;
        let credorId = lanc.credor_id || null;
        if (!credorId && lanc.cobranca_id) {
          const cobs = await sbFetch(`cobrancas?id=eq.${lanc.cobranca_id}&select=cliente_id&limit=1`).catch(() => []);
          credorId = (cobs[0] && cobs[0].cliente_id) || null;
        }
        if (!credorId && !body.credor_id) {
          return res.status(400).json({ error: 'lançamento sem credor vinculado — informe credor_id ou vincule a cobrança' });
        }
        const credorEscolhido = body.credor_id || credorId;

        // Grava a escolha no lançamento e nas OUTRAS parcelas em aberto do mesmo
        // devedor, para não repetir a escolha a cada parcela. Casa pelo texto sem a
        // numeração de parcela — é o único elo entre elas enquanto o cadastro não liga
        // a cobrança. Best-effort: não pode impedir o pagamento.
        if (body.credor_id) {
          try {
            const base = String(lanc.descricao || '').replace(/\s*\d+\/\d+\s*$/, '').trim();
            await sbFetch(`fin_lancamento?id=eq.${lanc.id}`, {
              method: 'PATCH', prefer: 'return=minimal',
              body: JSON.stringify({ credor_id: credorEscolhido }),
            });
            if (base.length >= 8) {
              await sbFetch(`fin_lancamento?tipo_movimento=eq.0&status=eq.0&credor_id=is.null&descricao=like.${encodeURIComponent(base + '*')}`, {
                method: 'PATCH', prefer: 'return=minimal',
                body: JSON.stringify({ credor_id: credorEscolhido }),
              });
            }
          } catch (e) { console.warn('[repassar] gravar credor no lançamento:', e.message); }
        }
        const nova = await sbFetch('fin_operacao', {
          method: 'POST', prefer: 'return=representation',
          body: JSON.stringify({
            credor_id: credorEscolhido,
            devedor_id: devedorId,
            valor_capital: round2(Math.abs(Number(lanc.valor) || 0)),
            parcela: lanc.numero_parcela, total_parcelas: lanc.total_parcelas,
            lancamento_despesa_id: lanc.id,
            recebimento_status: 'recebido', repasse_status: 'pendente',
            metadata: { origem: 'lancamento', lancamento_descricao: lanc.descricao, cobranca_id: lanc.cobranca_id || null, criada_em: new Date().toISOString() },
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

    // TETO DO CASO: nenhuma trava olhava o caso inteiro (ver saldoDeCapital). Recusa antes
    // de tocar no dinheiro quando esta parcela passaria do capital que o credor tem a
    // receber. Só vale quando o lançamento tem cobrança e a cobrança tem capital definido;
    // sem isso não há teto conhecido e o fluxo segue como antes.
    if (!body.ignorar_teto) {
      const cobId = op.metadata && op.metadata.cobranca_id;
      const alvoCob = cobId || await (async () => {
        if (!op.lancamento_despesa_id) return null;
        const l = await sbFetch(`fin_lancamento?id=eq.${op.lancamento_despesa_id}&select=cobranca_id&limit=1`).catch(() => []);
        return (l[0] && l[0].cobranca_id) || null;
      })();
      const sc = await saldoDeCapital(alvoCob).catch(() => null);
      if (sc && round2(op.valor_capital) > sc.saldo + 0.005) {
        return res.status(409).json({
          error: `Este repasse passa do capital do caso. Capital ${fmtBRL(sc.capital)}, já repassado ${fmtBRL(sc.enviado)}, resta ${fmtBRL(sc.saldo)} — e esta parcela é ${fmtBRL(op.valor_capital)}.`,
          teto_capital: true, capital: sc.capital, ja_repassado: sc.enviado, saldo: sc.saldo,
          valor_parcela: round2(op.valor_capital),
        });
      }
    }

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
      const cls = await sbFetch(`clientes?id=eq.${op.credor_id}&select=id,nome,telefone,doc,chave_pix,metadata&limit=1`);
      credor = cls[0] || null;
    }
    if (!credor) return res.status(400).json({ error: 'credor não vinculado à operação' });

    const credMeta = credor.metadata || {};
    const pixKey = (body.pix_key || credor.chave_pix || credMeta.pix_key || (credor.doc || '').replace(/\D/g, '') || '').trim();
    if (!pixKey) return res.status(400).json({ error: 'informe a chave PIX do credor (pix_key)' });

    // Parcela e devedor — o que o credor vê no extrato do PIX e na mensagem.
    // Vêm da descrição do lançamento; devedor cadastrado, quando existe, prevalece.
    const ref = lerDescricaoRepasse(body.descricao || (op.metadata && op.metadata.lancamento_descricao) || '');
    if (op.devedor_id) {
      const dvs = await sbFetch(`devedores?id=eq.${op.devedor_id}&select=nome&limit=1`).catch(() => []);
      if (dvs[0] && dvs[0].nome) ref.devedor = dvs[0].nome;
    }
    if (!ref.parcela && op.parcela) { ref.parcela = op.parcela; ref.total = op.total_parcelas; }

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
      // Descrição no extrato do credor: "<nº parcela> - <devedor>" (pedido do Gustavo,
      // 16/08/2026). O que o front manda é a descrição CRUA do lançamento, com as
      // anotações internas ("pagar", "conferido", "depende do Sisbajud") — normalizamos
      // aqui, no servidor, para que o webhook e a mensagem falem a mesma língua.
      description: descricaoPix(ref) || `Repasse Cobrasq — ${credor.nome || 'credor'}`,
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
      // Parcela e devedor ficam gravados: quando o Asaas conclui depois, é o webhook
      // que manda o comprovante, e lá a descrição do lançamento não está mais em mão.
      ...(ref.parcela && !op.parcela ? { parcela: ref.parcela, total_parcelas: ref.total } : {}),
      metadata: {
        ...(op.metadata || {}), repasse_pix_key: pixKey, repasse_asaas_status: st,
        repasse_devedor_nome: ref.devedor || undefined,
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
    // Persiste na COLUNA, não no metadata: é o campo que a tela de cliente edita e o
    // único que sobrevive ao save do painel.
    if (body.pix_key && body.pix_key !== credor.chave_pix) {
      await sbFetch(`clientes?id=eq.${credor.id}`, {
        method: 'PATCH', body: JSON.stringify({ chave_pix: pixKey }),
      }).catch(() => {});
    }

    // Se já concluiu, manda o comprovante ao credor agora (senão, vai no webhook).
    // Um PIX = uma mensagem, com o PDF em anexo.
    let envio = null;
    if (concluido) {
      // Ordem de preferência: o comprovante do BANCO primeiro. Ele é prova de
      // terceiro, com o identificador oficial do PIX e as instituições das duas partes —
      // documento que a COBRASQ emite sobre si mesma não tem a mesma força. O nosso PDF
      // entra só se o Asaas não entregar o dele.
      // Ordem: página do Asaas impressa (layout completo) → PDF estático do Asaas →
      // comprovante da COBRASQ. Os dois primeiros são do banco; o terceiro é nosso.
      let pdf = await imprimirPaginaAsaasPdf(comprovanteUrl);
      if (!pdf) pdf = (arq && arq.base64) || '';
      if (!pdf) {
        pdf = await gerarComprovanteRepassePdf({
          credorNome: credor.nome, devedor: ref.devedor, parcela: ref.parcela,
          valor: op.valor_capital, dataISO: new Date().toISOString().slice(0, 10),
          transferId: transfer.id, chavePix: pixKey, urlAsaas: comprovanteUrl,
        });
      }
      envio = await enviarComprovanteCredor({
        telefone: destinoWhatsapp(credor), parcela: ref.parcela, devedor: ref.devedor,
        base64: pdf, ext: 'pdf', comprovanteUrl,
      });
    }

    // Ficha do caso: aba "Repasses ao cliente" da cobrança, com o comprovante anexado.
    // Só quando o lançamento tem cobrança vinculada — o repasse importado do Controlle
    // em geral não tem, e aí o registro fica só no Financeiro.
    let ficha = null;
    if (concluido) {
      ficha = await registrarRepasseNaFicha({
        cobrancaId: await resolverCobrancaId(op),
        credor, valor: op.valor_capital, transferId: transfer.id,
        dataPix: new Date().toISOString().slice(0, 10), comprovante: arq,
      });
    }

    return res.status(200).json({
      ok: true,
      operacao_id: op.id,
      transfer_id: transfer.id || null,
      asaas_status: st,
      repasse_status: update.repasse_status,
      comprovante_url: comprovanteUrl || null,
      comprovante_enviado: !!(envio && envio.enviado),
      comprovante_via: (envio && envio.via) || null,
      ficha_caso: ficha ? { repasse_id: ficha.repasse_id, status_caso: ficha.status_caso || null } : null,
    });
  } catch (e) {
    console.error('[repassar]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
