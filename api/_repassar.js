// api/repassar.js — Dispara o repasse PIX ao credor (Asaas /transfers) para uma
// fin_operacao. (PR4 — repasse SEMIAUTOMÁTICO: o usuário confirma antes de disparar.)
//
// Auth: usuário Supabase logado (a confirmação é manual, por design). Body:
//   { operacao_id | lancamento_id | lancamento_ids[], pix_key?, pix_key_type?, descricao? }
// `lancamento_ids` com 2+ parcelas do mesmo credor e do mesmo devedor = UM PIX com a soma
// (repassarLote, abaixo).
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
const { lerDescricaoRepasse, descricaoPix, primeiraParcela, enviarComprovanteCredor, destinoWhatsapp } = require('./_repasse-msg.js');
const { saldoDeCapital, devedorPrincipal, partesDaCobranca, resolverCobrancaId, registrarRepasseNaFicha } = require('./_repasse-ficha.js');

const { hojeBR } = require('./_data.js');
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function fmtBRL(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Resolve (ou cria) a fin_operacao de um lançamento de saída. Devolve { id } ou
// { status, json } para quem chamou responder. Serve ao repasse avulso e ao lote.
async function operacaoDoLancamento(lancamentoId, body) {
  const lancId = String(lancamentoId).replace(/\D/g, '');
  if (!lancId) return { status: 400, json: { error: 'lancamento_id inválido' } };
  const lancs = await sbFetch(`fin_lancamento?id=eq.${lancId}&select=id,descricao,valor,tipo_movimento,status,cobranca_id,credor_id,numero_parcela,total_parcelas&limit=1`);
  const lanc = lancs[0];
  if (!lanc) return { status: 404, json: { error: 'lançamento não encontrado' } };
  if (lanc.tipo_movimento !== 0) return { status: 400, json: { error: 'lançamento não é uma saída' } };
  if (lanc.status !== 0) return { status: 200, json: { ok: true, skipped: 'lançamento já baixado', lancamento_id: lanc.id } };

  // Já existe operação para este lançamento? Então é retry — reaproveita.
  const jaTem = await sbFetch(`fin_operacao?lancamento_despesa_id=eq.${lanc.id}&select=id&limit=1`).catch(() => []);
  if (Array.isArray(jaTem) && jaTem[0]) {
    return { id: jaTem[0].id };
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
      return { status: 400, json: { error: 'lançamento sem credor vinculado — informe credor_id ou vincule a cobrança' } };
    }
    const credorEscolhido = body.credor_id || credorId;
    // Nos casos antigos o id da cobrança é o do devedor; nos cadastrados com partes (ex.:
    // Deivid Ghizzo, 19/09/2026) não é — o devedor vem de cobranca_partes (principal).
    // Gravar o id da cobrança nesses casos violava fin_operacao_devedor_id_fkey (409).
    // Cobrança sem devedor nenhum: erro claro, para o Gustavo arrumar o cadastro (30/09/2026).
    if (devedorId) {
      const dvs = await sbFetch(`devedores?id=eq.${devedorId}&select=id&limit=1`);
      if (!dvs.length) {
        const pts = await sbFetch(`cobranca_partes?cobranca_id=eq.${devedorId}&devedor_id=not.is.null&select=devedor_id,principal&order=principal.desc&limit=1`);
        if (!pts.length) {
          const nome = lerDescricaoRepasse(lanc.descricao).devedor || 'este caso';
          return { status: 400, json: { error: `Repasse bloqueado: a cobrança de ${nome} não tem devedor cadastrado. Cadastre o devedor e tente de novo.` } };
        }
        devedorId = pts[0].devedor_id;
      }
    }

    // Grava a escolha no lançamento e nas OUTRAS parcelas em aberto do mesmo
    // devedor, para não repetir a escolha a cada parcela. Casa pelo texto sem a
    // numeração de parcela — é o único elo entre elas enquanto o cadastro não liga
    // a cobrança. Best-effort: não pode impedir o pagamento.
    if (body.credor_id) {
      try {
        // A marca ` · verificar` (pente-fino de 31/08) fica DEPOIS da numeração e cegava
        // este corte, quebrando o `like` que propaga o credor às outras parcelas.
        const base = String(lanc.descricao || '').replace(/\s*·\s*verificar\s*$/i, '')
          .replace(/\s*\d+\/\d+\s*$/, '').trim();
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
    const novaId = Array.isArray(nova) ? (nova[0] && nova[0].id) : (nova && nova.id);
    if (!novaId) return { status: 500, json: { error: 'não foi possível preparar o repasse' } };
    return { id: novaId };
  }
}

// Operações pagas pelo mesmo PIX (lote) — a própria, se o transfer for só dela.
async function operacoesDoTransfer(op) {
  if (!op.repasse_asaas_transfer_id) return [op];
  const irmas = await sbFetch(`fin_operacao?repasse_asaas_transfer_id=eq.${encodeURIComponent(op.repasse_asaas_transfer_id)}&select=*`).catch(() => []);
  const grupo = Array.isArray(irmas) ? irmas : [];
  if (!grupo.some(g => String(g.id) === String(op.id))) grupo.push(op);
  return grupo;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  let operacaoId = body.operacao_id;

  // Várias parcelas num PIX só (lote).
  if (!operacaoId && Array.isArray(body.lancamento_ids) && body.lancamento_ids.length > 1) {
    return repassarLote(res, body);
  }

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
      const r = await operacaoDoLancamento(body.lancamento_id, body);
      if (!r.id) return res.status(r.status).json(r.json);
      operacaoId = r.id;
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
      // Separar "não deu para perguntar ao Asaas" de "o Asaas respondeu que não existe":
      // um erro de rede NÃO pode liberar o botão, senão um segundo PIX sai por cima de
      // um primeiro que estava só demorando.
      let tr = null, trErr = null;
      try { tr = await asaasReq('GET', `/transfers/${encodeURIComponent(op.repasse_asaas_transfer_id)}`); }
      catch (e) { trErr = e; }
      const sumiu = !!trErr && /\b404\b/.test(String((trErr && trErr.message) || ''));
      const stExist = String((tr && tr.status) || op.metadata?.repasse_asaas_status || '').toUpperCase();
      const doneExist = stExist === 'DONE' || stExist === 'CONFIRMED';
      // Transferência recusada, cancelada ou apagada dentro do Asaas: o dinheiro não
      // saiu, então a operação volta a 'pendente' e o botão reaparece. Sem isto ela
      // ficava 'preparado' para sempre e o repasse simplesmente não acontecia mais.
      const falhouExist = !doneExist && (sumiu || /FAIL|CANCEL|ERROR|REFUS|REJECT|DENIED/.test(stExist));
      // PIX de lote pagou várias parcelas: todas as operações com este transfer andam
      // juntas — liberar ou concluir só a clicada deixaria as outras presas em 'preparado'.
      const grupo = await operacoesDoTransfer(op);
      if (falhouExist && op.repasse_status !== 'efetuado') {
        await Promise.all(grupo.filter(g => g.repasse_status !== 'efetuado').map(g => sbFetch(`fin_operacao?id=eq.${g.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            repasse_status: 'pendente',
            repasse_asaas_transfer_id: null,
            metadata: { ...(g.metadata || {}), repasse_asaas_status: sumiu ? 'NOT_FOUND' : stExist,
                        repasse_liberado_em: new Date().toISOString() },
          }),
        }).catch(() => {})));
        return res.status(200).json({
          ok: true, liberado: true, operacao_id: op.id, operacao_ids: grupo.map(g => g.id),
          asaas_status: sumiu ? 'NOT_FOUND' : (stExist || null), repasse_status: 'pendente',
          motivo: sumiu ? 'transferência não existe mais no Asaas' : `transferência ${stExist} no Asaas`,
        });
      }
      if (doneExist && op.repasse_status !== 'efetuado') {
        await Promise.all(grupo.filter(g => g.repasse_status !== 'efetuado').map(g => sbFetch(`fin_operacao?id=eq.${g.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            repasse_status: 'efetuado',
            repasse_efetuado_em: new Date().toISOString(),
            repasse_comprovante_url: (tr && (tr.transactionReceiptUrl || tr.receiptUrl)) || g.repasse_comprovante_url || null,
            metadata: { ...(g.metadata || {}), repasse_asaas_status: stExist },
          }),
        }).catch(() => {})));
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
    //
    // `body.descricao` é a descrição EDITADA no modal (10/09/2026): o gestor corrige o
    // número da parcela quando a numeração do lançamento não bate com o que o credor já
    // recebeu (ex.: R$ 20 pagos por fora antes da série). Ela vai literal ao extrato do
    // PIX; o número inicial ("2 - Fulana") vira a parcela da mensagem e da operação.
    const descEditada = String(body.descricao || '').trim().slice(0, 500);
    const ref = lerDescricaoRepasse(descEditada || (op.metadata && op.metadata.lancamento_descricao) || '');
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
      description: descEditada || descricaoPix(ref) || `Repasse Cobrasq — ${credor.nome || 'credor'}`,
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
      // Descrição editada com parcela diferente da do lançamento: a operação passa a
      // dizer a parcela corrigida, senão o webhook mandaria o comprovante com a errada.
      ...(descEditada && ref.parcela && ref.parcela !== op.parcela ? { parcela: ref.parcela, total_parcelas: ref.total || op.total_parcelas || null } : {}),
      metadata: {
        ...(op.metadata || {}), repasse_pix_key: pixKey, repasse_asaas_status: st,
        repasse_devedor_nome: ref.devedor || undefined,
        ...(descEditada ? { repasse_descricao_pix: descEditada } : {}),
        ...(arq ? { comprovante_storage_path: arq.storage_path, comprovante_bytes: arq.bytes } : {}),
      },
    };
    await sbFetch(`fin_operacao?id=eq.${op.id}`, { method: 'PATCH', body: JSON.stringify(update) });

    // Ponte fin_lancamento: ao efetivar, marca a despesa de repasse como PAGA. Move
    // data_competencia junto (mesmo motivo do lado da receita — ver _repasse-concluido.js).
    if (concluido && op.lancamento_despesa_id) {
      const hoje = hojeBR();
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
      // Ordem: PDF ORIGINAL do Asaas (o do botão "Baixar pdf", já baixado por
      // guardarComprovante) → página do Asaas impressa → comprovante da COBRASQ.
      // Até 11/09/2026 a página impressa vinha primeiro; o Gustavo viu o resultado
      // (2 páginas, "BAIXAR PDF" no rodapé, layout de tela) e pediu o original.
      let pdf = (arq && arq.base64) || '';
      if (!pdf) pdf = await imprimirPaginaAsaasPdf(comprovanteUrl);
      if (!pdf) {
        pdf = await gerarComprovanteRepassePdf({
          credorNome: credor.nome, devedor: ref.devedor, parcela: ref.parcela,
          valor: op.valor_capital, dataISO: hojeBR(),
          transferId: transfer.id, chavePix: pixKey, urlAsaas: comprovanteUrl,
        });
      }
      // Documento do devedor na mensagem (pedido do Gustavo, 17/08/2026). Best-effort:
      // devedor sem cadastro não tem doc, e a frase sai sem ele.
      // Todas as partes (co-devedores) entram na mensagem, cada uma com seu documento;
      // `dp` fica como reserva para cobrança sem partes cadastradas.
      const cobId = await resolverCobrancaId(op).catch(() => null);
      const [dp, partes] = await Promise.all([
        devedorPrincipal(cobId).catch(() => null),
        partesDaCobranca(cobId).catch(() => []),
      ]);
      envio = await enviarComprovanteCredor({
        telefone: destinoWhatsapp(credor), parcela: ref.parcela, total: ref.total || op.total_parcelas || null, devedor: ref.devedor,
        doc: dp && dp.doc, partes,
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
        dataPix: hojeBR(), comprovante: arq,
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
      // Fora do horário comercial o comprovante fica na fila; o painel mostra quando sai.
      comprovante_agendado_para: (envio && envio.agendado && envio.agendada_para) || null,
      ficha_caso: ficha ? { repasse_id: ficha.repasse_id, status_caso: ficha.status_caso || null } : null,
    });
  } catch (e) {
    console.error('[repassar]', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── Lote: várias parcelas, UM PIX ────────────────────────────────────────────────
// Pedido do Gustavo em 30/09/2026: três parcelas da Fernanda da Silva à Kalayame não
// precisam de três PIX (nem de três tarifas e três comprovantes). Cada parcela continua
// com a sua fin_operacao — é o que a tela e a conciliação leem —, mas todas levam o
// MESMO transfer: a trava anti-duplo, o teto do caso, a conferência "aguardando Asaas"
// e a conclusão pelo webhook tratam o grupo de uma vez.
//
// Só junta parcelas do mesmo credor (um PIX tem um destino) e do mesmo caso (o
// comprovante cita um acordo só). Parcela já baixada ou com PIX anterior recusa o lote
// inteiro: nada sai pela metade.
async function repassarLote(res, body) {
  const lancIds = [...new Set(body.lancamento_ids.map(x => String(x).replace(/\D/g, '')).filter(Boolean))];
  if (lancIds.length < 2) return res.status(400).json({ error: 'o lote precisa de duas ou mais parcelas' });
  if (lancIds.length > 60) return res.status(400).json({ error: 'lote grande demais: no máximo 60 parcelas por PIX' });

  let ops;
  try {
    const opIds = [];
    for (const id of lancIds) {
      const r = await operacaoDoLancamento(id, body);
      if (r.id) { opIds.push(r.id); continue; }
      if (r.json && r.json.skipped) return res.status(409).json({ error: `O lançamento ${id} já está baixado — tire-o da seleção e repita.`, lancamento_id: id });
      return res.status(r.status).json({ ...r.json, lancamento_id: id });
    }
    ops = await sbFetch(`fin_operacao?id=in.(${opIds.map(encodeURIComponent).join(',')})&select=*`);
    if (!Array.isArray(ops) || ops.length !== opIds.length) return res.status(500).json({ error: 'não foi possível ler as operações do lote' });
  } catch (e) {
    return res.status(500).json({ error: 'falha ao preparar o lote: ' + e.message });
  }

  try {
    const rotulo = op => (op.metadata && op.metadata.lancamento_descricao) || `operação ${op.id}`;
    for (const op of ops) {
      if (!(Number(op.valor_capital) > 0)) return res.status(400).json({ error: `${rotulo(op)}: sem capital a repassar` });
      if (op.repasse_status !== 'pendente' || op.repasse_asaas_transfer_id) {
        return res.status(409).json({ error: `${rotulo(op)}: já tem PIX (${op.repasse_status}) — tire-a da seleção e repita.`, operacao_id: op.id });
      }
    }

    const credorIds = new Set(ops.map(o => String(o.credor_id || '')));
    if (credorIds.size !== 1 || credorIds.has('')) {
      return res.status(400).json({ error: 'As parcelas são de credores diferentes (ou sem credor). Um PIX vai a um credor só — repasse em separado.' });
    }
    const refs = ops.map(o => lerDescricaoRepasse((o.metadata && o.metadata.lancamento_descricao) || ''));
    const cobIds = await Promise.all(ops.map(o => resolverCobrancaId(o).catch(() => null)));
    const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const caso = new Set(ops.map((o, i) => cobIds[i] ? 'c:' + cobIds[i] : 'n:' + norm(refs[i].devedor)));
    if (caso.size !== 1) {
      return res.status(400).json({ error: 'As parcelas são de devedores diferentes. O comprovante de um PIX cita um acordo só — repasse em separado.' });
    }
    const cobId = cobIds[0] || null;
    const total = round2(ops.reduce((s, o) => s + round2(o.valor_capital), 0));

    // Teto do caso, com a SOMA (mesma regra do avulso).
    if (!body.ignorar_teto && cobId) {
      const sc = await saldoDeCapital(cobId).catch(() => null);
      if (sc && total > sc.saldo + 0.005) {
        return res.status(409).json({
          error: `Este repasse passa do capital do caso. Capital ${fmtBRL(sc.capital)}, já repassado ${fmtBRL(sc.enviado)}, resta ${fmtBRL(sc.saldo)} — e as ${ops.length} parcelas somam ${fmtBRL(total)}.`,
          teto_capital: true, capital: sc.capital, ja_repassado: sc.enviado, saldo: sc.saldo, valor_parcela: total,
        });
      }
    }

    const cls = await sbFetch(`clientes?id=eq.${ops[0].credor_id}&select=id,nome,telefone,doc,chave_pix,metadata&limit=1`);
    const credor = cls[0] || null;
    if (!credor) return res.status(400).json({ error: 'credor não vinculado às operações' });
    const pixKey = (body.pix_key || credor.chave_pix || (credor.metadata || {}).pix_key || (credor.doc || '').replace(/\D/g, '') || '').trim();
    if (!pixKey) return res.status(400).json({ error: 'informe a chave PIX do credor (pix_key)' });

    let devedor = refs.map(r => r.devedor).find(Boolean) || '';
    const devId = ops.map(o => o.devedor_id).find(Boolean);
    if (devId) {
      const dvs = await sbFetch(`devedores?id=eq.${devId}&select=nome&limit=1`).catch(() => []);
      if (dvs[0] && dvs[0].nome) devedor = dvs[0].nome;
    }
    const parcelas = [...new Set(ops.map((o, i) => Number(o.parcela || refs[i].parcela) || 0).filter(n => n > 0))].sort((a, b) => a - b);
    const totalParcelas = Math.max(0, ...ops.map((o, i) => Number(o.total_parcelas || refs[i].total) || 0)) || null;
    const descEditada = String(body.descricao || '').trim().slice(0, 500);

    // Trava: todas pendente→preparado, ou nenhuma. Quem não pegar o grupo inteiro
    // devolve o que pegou e sai sem PIX.
    const ids = ops.map(o => encodeURIComponent(o.id)).join(',');
    const claim = await sbFetch(`fin_operacao?id=in.(${ids})&repasse_status=eq.pendente&repasse_asaas_transfer_id=is.null`, {
      method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ repasse_status: 'preparado' }),
    }).catch(() => null);
    const pegas = Array.isArray(claim) ? claim.map(c => encodeURIComponent(c.id)) : [];
    if (pegas.length !== ops.length) {
      if (pegas.length) {
        await sbFetch(`fin_operacao?id=in.(${pegas.join(',')})&repasse_asaas_transfer_id=is.null`, {
          method: 'PATCH', body: JSON.stringify({ repasse_status: 'pendente' }),
        }).catch(() => {});
      }
      return res.status(200).json({ ok: true, skipped: 'repasse já em andamento em alguma parcela (claim não obtido)', operacao_ids: ops.map(o => o.id) });
    }

    const transferPayload = {
      value: total,
      pixAddressKey: pixKey,
      operationType: 'PIX',
      description: descEditada || descricaoPix({ parcelas, devedor }) || `Repasse Cobrasq — ${credor.nome || 'credor'}`,
      // O Asaas guarda uma referência só: a 1ª operação. O webhook acha as outras pelo
      // transfer id (operacoesDoTransfer / _repasse-concluido.js).
      externalReference: ops[0].id,
    };
    if (body.pix_key_type) transferPayload.pixAddressKeyType = body.pix_key_type;
    let transfer;
    try {
      transfer = await asaasReq('POST', '/transfers', transferPayload);
    } catch (e) {
      await sbFetch(`fin_operacao?id=in.(${ids})&repasse_asaas_transfer_id=is.null`, {
        method: 'PATCH', body: JSON.stringify({ repasse_status: 'pendente' }),
      }).catch(() => {});
      throw e;
    }

    const st = String(transfer.status || '').toUpperCase();
    const concluido = st === 'DONE' || st === 'CONFIRMED';
    const comprovanteUrl = transfer.transactionReceiptUrl || transfer.receiptUrl || '';
    const arq = concluido ? await guardarComprovante(comprovanteUrl, transfer.id) : null;
    const lote = { operacoes: ops.map(o => o.id), lancamentos: ops.map(o => o.lancamento_despesa_id), parcelas, total_parcelas: totalParcelas, valor_total: total };

    await Promise.all(ops.map((op, i) => sbFetch(`fin_operacao?id=eq.${op.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        repasse_status: concluido ? 'efetuado' : 'preparado',
        ...(refs[i].parcela && !op.parcela ? { parcela: refs[i].parcela, total_parcelas: refs[i].total || null } : {}),
        repasse_asaas_transfer_id: transfer.id || null,
        repasse_comprovante_url: comprovanteUrl || null,
        repasse_efetuado_em: concluido ? new Date().toISOString() : null,
        metadata: {
          ...(op.metadata || {}), repasse_pix_key: pixKey, repasse_asaas_status: st,
          repasse_devedor_nome: devedor || undefined, repasse_lote: lote,
          ...(descEditada ? { repasse_descricao_pix: descEditada } : {}),
          ...(arq ? { comprovante_storage_path: arq.storage_path, comprovante_bytes: arq.bytes } : {}),
        },
      }),
    })));

    if (concluido) {
      const hoje = hojeBR();
      await Promise.all(ops.filter(op => op.lancamento_despesa_id).map(op => sbFetch(`fin_lancamento?id=eq.${op.lancamento_despesa_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 1, data_pagamento: hoje, data_competencia: hoje, valor_pago: -round2(op.valor_capital) }),
      }).catch(() => {})));
    }

    if (body.pix_key && body.pix_key !== credor.chave_pix) {
      await sbFetch(`clientes?id=eq.${credor.id}`, { method: 'PATCH', body: JSON.stringify({ chave_pix: pixKey }) }).catch(() => {});
    }

    // Um PIX = uma mensagem, que nomeia todas as parcelas; e uma linha na ficha do caso
    // com a soma (a ficha é idempotente pelo transfer id).
    let envio = null; let ficha = null;
    if (concluido) {
      let pdf = (arq && arq.base64) || '';
      if (!pdf) pdf = await imprimirPaginaAsaasPdf(comprovanteUrl);
      if (!pdf) {
        pdf = await gerarComprovanteRepassePdf({
          credorNome: credor.nome, devedor, parcela: primeiraParcela(parcelas),
          valor: total, dataISO: hojeBR(),
          transferId: transfer.id, chavePix: pixKey, urlAsaas: comprovanteUrl,
        });
      }
      const [dp, partes] = await Promise.all([
        devedorPrincipal(cobId).catch(() => null),
        partesDaCobranca(cobId).catch(() => []),
      ]);
      envio = await enviarComprovanteCredor({
        telefone: destinoWhatsapp(credor), parcelas, total: totalParcelas, devedor,
        doc: dp && dp.doc, partes,
        base64: pdf, ext: 'pdf', comprovanteUrl,
      });
      ficha = await registrarRepasseNaFicha({
        cobrancaId: cobId, credor, valor: total, transferId: transfer.id,
        dataPix: hojeBR(), comprovante: arq,
      });
    }

    return res.status(200).json({
      ok: true,
      lote: true,
      operacao_ids: ops.map(o => o.id),
      parcelas,
      valor_total: total,
      transfer_id: transfer.id || null,
      asaas_status: st,
      repasse_status: concluido ? 'efetuado' : 'preparado',
      comprovante_url: comprovanteUrl || null,
      comprovante_enviado: !!(envio && envio.enviado),
      comprovante_via: (envio && envio.via) || null,
      comprovante_agendado_para: (envio && envio.agendado && envio.agendada_para) || null,
      ficha_caso: ficha ? { repasse_id: ficha.repasse_id, status_caso: ficha.status_caso || null } : null,
    });
  } catch (e) {
    console.error('[repassar lote]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
