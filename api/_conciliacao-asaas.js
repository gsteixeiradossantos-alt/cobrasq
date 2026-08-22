// api/_conciliacao-asaas.js — Concilia pagamentos do Asaas × lançamentos do financeiro.
//
// POR QUE EXISTE (levantamento de 21/08/2026)
// Nenhum lançamento guardava de qual pagamento veio. Sem esse vínculo não dá para
// dizer quais pagamentos ficaram sem baixa: a única saída era inferir por valor e
// data — o mesmo método que já falhava dentro do /api/processar-recebimento. A
// inferência produziu falso positivo comprovado (Nely Therezinha: apontada como sem
// baixa, mas a parcela estava quitada 8 dias antes do pagamento, fora da janela).
//
// Este endpoint resolve isso indo à FONTE: o extrato do Asaas, que traz dueDate e
// value de cada pagamento. Com o vencimento em mãos, o casamento deixa de ser
// adivinhação — e o resultado é conferível linha a linha antes de qualquer baixa.
//
// SEMPRE DRY POR PADRÃO. Escreve só com ?aplicar=1 E o header x-emit-secret. Sem os
// dois, devolve a proposta e não toca em nada.
//
//   GET /api/conciliacao-asaas?de=2026-07-01&ate=2026-08-31
//   GET /api/conciliacao-asaas?de=...&ate=...&aplicar=1   (+ x-emit-secret)
//
// Auth de leitura: usuário Supabase logado (mesmo padrão do diagnóstico financeiro).

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Percorre /payments paginando. O Asaas devolve no máximo 100 por página.
async function pagarTudo(query) {
  const out = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const r = await asaasReq('GET', `/payments?${query}&limit=100&offset=${offset}`);
    const lote = (r && Array.isArray(r.data)) ? r.data : [];
    out.push(...lote);
    if (!r || !r.hasMore) break;
  }
  return out;
}

// Mesma precedência do /api/processar-recebimento — de propósito: o que este endpoint
// propõe para o passado é exatamente o que o fluxo novo fará no futuro.
//   (1) vínculo já gravado  (2) mesmo vencimento  (3) mesmo valor  (4) valor + acréscimo
function escolherLancamento(lancamentos, pagamento, tomados) {
  const valor = round2(pagamento.value);
  const venc = pagamento.dueDate ? String(pagamento.dueDate) : null;
  // `tomados` = lançamentos já reservados por OUTRO pagamento nesta mesma rodada.
  // Sem isso, dois pagamentos do mesmo devedor apontam para a mesma parcela: no dry
  // de 21/08 a Fatima Cordova apareceu duas vezes (R$116,63 de 16/07 e R$106,00 de
  // 17/08) reivindicando a parcela 21/21. Aplicar aquilo quitaria uma parcela só e
  // daria o outro pagamento por baixado.
  const reservados = tomados || new Set();
  const abertos = lancamentos.filter(l => Number(l.status) === 0 && !reservados.has(l.id));

  const jaVinculado = lancamentos.find(l => l.asaas_payment_id === pagamento.id);
  if (jaVinculado) return { alvo: jaVinculado, criterio: 'ja_vinculado', confianca: 'alta' };

  if (venc) {
    const porVenc = abertos.find(l => String(l.data_vencimento) === venc);
    if (porVenc) return { alvo: porVenc, criterio: 'vencimento', confianca: 'alta' };
  }

  const mesmoValor = abertos.filter(l => Math.abs(Number(l.valor) - valor) < 0.05);
  if (mesmoValor.length === 1) return { alvo: mesmoValor[0], criterio: 'valor_unico', confianca: 'alta' };
  if (mesmoValor.length > 1) {
    // Várias parcelas idênticas e sem vencimento para desempatar: a mais antiga em
    // aberto (regra do Gustavo, 21/08), mas marcada como BAIXA confiança — é
    // justamente o caso que exige olho humano (Ivone Klinzer: 26 parcelas de R$506).
    return { alvo: mesmoValor[0], criterio: 'valor_ambiguo', confianca: 'baixa', empatados: mesmoValor.length };
  }

  const teto = Math.max(valor * 0.3, 150);
  const comAcrescimo = abertos.filter(l => {
    const excedente = valor - (Number(l.valor) || 0);
    return excedente > 0 && excedente <= teto;
  });
  if (comAcrescimo.length === 1) {
    const alvo = comAcrescimo[0];
    return { alvo, criterio: 'valor_mais_acrescimo', confianca: 'media', acrescimo: round2(valor - Number(alvo.valor)) };
  }
  if (comAcrescimo.length > 1) {
    return { alvo: comAcrescimo[0], criterio: 'acrescimo_ambiguo', confianca: 'baixa', empatados: comAcrescimo.length };
  }

  return { alvo: null, criterio: 'sem_candidato', confianca: 'nenhuma' };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  const q = req.query || {};
  const de = String(q.de || '').slice(0, 10);
  const ate = String(q.ate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
    return res.status(400).json({ error: 'Informe o período: ?de=AAAA-MM-DD&ate=AAAA-MM-DD' });
  }

  // Escrever em LOTE exige as DUAS coisas: a intenção explícita e o segredo de serviço.
  // A decisão PONTUAL (abaixo) é diferente: quem escolheu foi um humano logado na tela,
  // então basta a sessão de proprietário — o risco que o segredo protege (varrer o
  // período inteiro aplicando heurística) não existe quando o alvo é um par único.
  const segredo = process.env.EMIT_ACORDO_SECRET || '';
  const pediuAplicar = String(q.aplicar || '') === '1';
  const temSegredo = segredo && (req.headers['x-emit-secret'] === segredo);
  const aplicar = pediuAplicar && temSegredo;
  if (pediuAplicar && !temSegredo) {
    return res.status(403).json({ error: 'aplicar=1 exige o header x-emit-secret.' });
  }

  // ── Decisão humana pontual: "este pagamento quitou ESTE lançamento" ──────────
  // É o que a fila de ambíguos da tela usa. Nunca sobrescreve vínculo existente.
  if (q.payment_id && q.lancamento_id) {
    try {
      const pay = await asaasReq('GET', `/payments/${encodeURIComponent(String(q.payment_id))}`);
      if (!pay || !pay.id) return res.status(404).json({ error: 'pagamento não encontrado no Asaas.' });
      const st = String(pay.status || '');
      if (!['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(st)) {
        return res.status(400).json({ error: `pagamento não está recebido no Asaas (status ${st}).` });
      }
      const alvos = await sbFetch(
        `fin_lancamento?id=eq.${encodeURIComponent(String(q.lancamento_id))}` +
        `&select=id,descricao,valor,status,asaas_payment_id&limit=1`
      );
      const alvo = Array.isArray(alvos) ? alvos[0] : null;
      if (!alvo) return res.status(404).json({ error: 'lançamento não encontrado.' });
      if (alvo.asaas_payment_id && alvo.asaas_payment_id !== pay.id) {
        return res.status(409).json({ error: 'este lançamento já está vinculado a outro pagamento.' });
      }
      const valorPago = round2(pay.value);
      const acrescimo = round2(Math.max(0, valorPago - Number(alvo.valor)));
      const patch = {
        status: 1, valor_pago: valorPago,
        data_pagamento: pay.paymentDate, data_competencia: pay.paymentDate,
        asaas_payment_id: pay.id,
        observacoes: `conciliado manualmente com Asaas payment ${pay.id} em ${pay.paymentDate}.`,
      };
      if (acrescimo >= 0.01) patch.juros = acrescimo;
      await sbFetch(`fin_lancamento?id=eq.${encodeURIComponent(alvo.id)}`, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch),
      });
      // resolve o órfão correspondente, se houver
      await sbFetch(`asaas_pagamento_orfao?asaas_payment_id=eq.${encodeURIComponent(pay.id)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ resolvido_em: new Date().toISOString(), lancamento_id: alvo.id }),
      }).catch(() => null);
      return res.status(200).json({ ok: true, conciliado: { payment_id: pay.id, lancamento_id: alvo.id, valor_pago: valorPago, acrescimo } });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  try {
    const pagos = [
      ...await pagarTudo(`status=RECEIVED&paymentDate%5Bge%5D=${de}&paymentDate%5Ble%5D=${ate}`),
      ...await pagarTudo(`status=CONFIRMED&paymentDate%5Bge%5D=${de}&paymentDate%5Ble%5D=${ate}`),
    ];
    const porId = new Map();
    for (const p of pagos) if (!p.deleted) porId.set(p.id, p);

    // devedores por asaas_customer_id, para achar o caso de cada pagamento
    const custIds = [...new Set([...porId.values()].map(p => p.customer).filter(Boolean))];
    const devPorCustomer = new Map();
    for (let i = 0; i < custIds.length; i += 50) {
      const chunk = custIds.slice(i, i + 50).map(encodeURIComponent).join(',');
      const rows = await sbFetch(
        `devedores?select=id,nome,asaas_customer_id&asaas_customer_id=in.(${chunk})`
      ).catch(() => []);
      for (const d of (rows || [])) devPorCustomer.set(d.asaas_customer_id, d);
    }

    // lançamentos de receita por caso (uma consulta por devedor envolvido)
    const lancPorDevedor = new Map();
    for (const dev of new Set([...devPorCustomer.values()].map(d => d.id))) {
      const rows = await sbFetch(
        `fin_lancamento?tipo_movimento=eq.1&status=in.(0,1)&cobranca_id=eq.${dev}` +
        `&select=id,descricao,valor,status,data_vencimento,data_pagamento,asaas_payment_id&order=data_vencimento.asc`
      ).catch(() => []);
      lancPorDevedor.set(dev, rows || []);
    }

    const itens = [];
    const resumo = { pagamentos: 0, ja_vinculados: 0, propostos: 0, sem_candidato: 0, sem_devedor: 0, aplicados: 0, falhas: 0 };

    // ── Alocação exclusiva ────────────────────────────────────────────────
    // Uma parcela só pode ser quitada por UM pagamento. Sem esta passada, dois
    // pagamentos do mesmo devedor reivindicam a mesma linha (Fatima Cordova no dry de
    // 21/08). Ordem de atendimento: quem tem o casamento mais confiável escolhe
    // primeiro — senão um palpite ambíguo rouba a parcela de um casamento por
    // vencimento, que é certo. Empate se resolve pela data do pagamento (mais antigo
    // primeiro), que é a ordem em que as parcelas foram de fato quitadas.
    const PRIORIDADE = { alta: 0, media: 1, baixa: 2, nenhuma: 3 };
    const comDevedor = [];
    for (const p of porId.values()) {
      resumo.pagamentos++;
      const dev = devPorCustomer.get(p.customer);
      if (!dev) {
        resumo.sem_devedor++;
        itens.push({ payment_id: p.id, valor: round2(p.value), vencimento: p.dueDate, pago_em: p.paymentDate, situacao: 'sem devedor cadastrado' });
        continue;
      }
      const previa = escolherLancamento(lancPorDevedor.get(dev.id) || [], p);
      comDevedor.push({ p, dev, previa });
    }
    comDevedor.sort((a, b) => {
      const d = PRIORIDADE[a.previa.confianca] - PRIORIDADE[b.previa.confianca];
      if (d !== 0) return d;
      return String(a.p.paymentDate || '').localeCompare(String(b.p.paymentDate || ''));
    });

    const tomados = new Set();
    for (const { p, dev } of comDevedor) {
      // Recalcula já descontando o que outro pagamento reservou.
      const escolha = escolherLancamento(lancPorDevedor.get(dev.id) || [], p, tomados);
      if (escolha.alvo) tomados.add(escolha.alvo.id);
      const item = {
        payment_id: p.id, devedor: dev.nome,
        valor: round2(p.value), vencimento: p.dueDate, pago_em: p.paymentDate,
        forma: p.billingType,
        criterio: escolha.criterio, confianca: escolha.confianca,
        empatados: escolha.empatados, acrescimo: escolha.acrescimo,
        lancamento_id: escolha.alvo ? escolha.alvo.id : null,
        lancamento: escolha.alvo ? escolha.alvo.descricao : null,
        lancamento_valor: escolha.alvo ? round2(escolha.alvo.valor) : null,
        lancamento_vencimento: escolha.alvo ? escolha.alvo.data_vencimento : null,
      };

      if (escolha.criterio === 'ja_vinculado') { resumo.ja_vinculados++; item.acao = 'nada a fazer'; itens.push(item); continue; }
      if (!escolha.alvo) { resumo.sem_candidato++; item.acao = 'conferir cadastro'; itens.push(item); continue; }

      resumo.propostos++;
      item.acao = aplicar ? 'baixar' : 'baixar (proposta)';

      // Confiança BAIXA nunca é aplicada automaticamente, nem com aplicar=1: são os
      // casos de parcelas idênticas, onde errar significa quitar a parcela errada e
      // sujar a prestação de contas do credor. Ficam para decisão humana.
      if (aplicar && escolha.confianca === 'baixa') {
        item.acao = 'não aplicado — ambíguo, decidir manualmente';
        itens.push(item);
        continue;
      }

      if (aplicar) {
        const acrescimo = round2(Math.max(0, round2(p.value) - Number(escolha.alvo.valor)));
        const patch = {
          status: 1, valor_pago: round2(p.value),
          data_pagamento: p.paymentDate, data_competencia: p.paymentDate,
          asaas_payment_id: p.id,
          observacoes: `conciliado com Asaas payment ${p.id} em ${p.paymentDate} (critério: ${escolha.criterio}).`,
        };
        if (acrescimo >= 0.01) patch.juros = acrescimo;
        try {
          await sbFetch(`fin_lancamento?id=eq.${escolha.alvo.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
          resumo.aplicados++; item.acao = 'baixado';
        } catch (e) {
          resumo.falhas++; item.acao = 'falhou: ' + e.message;
        }
      }
      itens.push(item);
    }

    itens.sort((a, b) => String(a.pago_em || '').localeCompare(String(b.pago_em || '')));

    // Fila de órfãos: pagamento que nem chegou a ter candidato (boleto sem parcela ou
    // sem devedor casado). Vive em asaas_pagamento_orfao desde 21/08 — antes disso
    // sumia num console.warn.
    let orfaos = [];
    try {
      orfaos = await sbFetch(
        'asaas_pagamento_orfao?resolvido_em=is.null' +
        '&select=asaas_payment_id,asaas_customer_id,valor,due_date,payment_date,billing_type,motivo,detalhe' +
        '&order=payment_date.desc&limit=200'
      );
    } catch { orfaos = []; }
    resumo.orfaos = Array.isArray(orfaos) ? orfaos.length : 0;

    return res.status(200).json({ ok: true, periodo: { de, ate }, aplicado: aplicar, resumo, itens, orfaos });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
