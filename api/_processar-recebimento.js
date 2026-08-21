// api/processar-recebimento.js — Processa um recebimento confirmado do Asaas como
// "operação única" (PR3): cria a fin_operacao da parcela paga (recebimento + split
// capital/honorário + estado de repasse), e manda o recibo ao devedor (R4).
//
// Chamado server-to-server pelo asaas-webhook (header x-emit-secret ==
// EMIT_ACORDO_SECRET). Idempotente por asaas_payment_id (fin_operacao.asaas_payment_id
// é UNIQUE). O repasse PIX em si é semiautomático e fica na PR4 (a operação nasce com
// repasse_status='pendente' quando há capital a repassar).
//
// Split (regra confirmada): credor recebe o CAPITAL (principal); excedente = honorário,
// diluído proporcionalmente por parcela. Base de capital = acordo.metadata.capital_credor
// senão devedor.valor_orig.

const crypto = require('crypto');
const { sbFetch } = require('./_sb.js');
const { asaasReq } = require('./_asaas.js');
const { zapiSendText, zapiSendDocumentPdf } = require('./_zapi.js');
const { gerarReciboPdfBase64, formaPagamento } = require('./_recibo.js');

// Conta e categorias da ponte fin_lancamento. Sem elas o lançamento nasce órfão:
// some dos relatórios por categoria e não entra em conta nenhuma. A revisão de
// 14/08/2026 achou 19 assim (R$ 1.970,86) — 11 "Recebimento" e 8 "Repasse ao
// credor", todos criados por este arquivo.
const CONTA_ASAAS = 13;
const CATEGORIA_ACORDOS = 167;  // receita do recebimento
const CATEGORIA_REPASSE = 156;  // "Aquisição de dívidas de terceiros" = repasse ao credor

// Vincula a categoria ao lançamento. Best-effort: categoria é secundária e não pode
// derrubar o processamento do recebimento, que é o que de fato move dinheiro.
async function _categorizar(lancId, categoriaId, valor){
  if(!lancId) return;
  try{
    await sbFetch('fin_lancamento_categoria', { method:'POST', prefer:'return=minimal',
      body: JSON.stringify({ lancamento_id: lancId, categoria_id: categoriaId, valor: Math.abs(+valor||0) }) });
  }catch(e){ console.warn('[processar-recebimento] categoria:', e.message); }
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Cópia de monitoramento: o Gustavo recebe o PDF do recibo de TODO recebimento confirmado
// (pedido 2026-08-06), independente do devedor ter telefone cadastrado ou não. Só o PDF,
// sem a mensagem de texto que vai pro devedor.
const NUMERO_MONITORAMENTO = '46999223332';

// Escolhe qual fin_lancamento do devedor corresponde ao pagamento do Asaas.
// Valor SOZINHO não identifica a linha: num acordo de parcela fixa as 24 linhas têm o
// mesmo valor e o mesmo `criada_em` (nascem no mesmo INSERT), então a versão antiga
// ("primeira do order=criada_em.desc com valor igual") era empate puro e o Postgres
// devolvia qualquer uma — foi o que baixou a 11/24 da Cristiane (pay_30shj4m6rmv4qtb8,
// "Parcela 1 de 24") e a 4/7 da Aline (pay_jniooq9iodcn7g2b, "Parcela 2 de 7") em
// 08/2026. Desempata pelo que o Asaas já informa: vencimento e número da parcela.
// Devolve null quando há mais de uma candidata e nenhuma chave decide — melhor deixar
// para baixa manual do que baixar a parcela errada.
function escolherLancamento(candidatos, valorRecebido, payment) {
  const mesmoValor = (candidatos || []).filter(c => Math.abs(Number(c.valor) - valorRecebido) < 0.05);
  if (!mesmoValor.length) return null;
  const nParc = payment && payment.installmentNumber != null ? Number(payment.installmentNumber) : null;
  const venc = (payment && payment.dueDate) || null;
  const dias = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

  return (
    // 1) vencimento idêntico ao do boleto: a chave mais forte que o Asaas dá.
    (venc && mesmoValor.find(c => c.data_vencimento === venc)) ||
    // 2) número da parcela (presente quando o boleto nasceu de uma série).
    (nParc != null && mesmoValor.find(c => Number(c.numero_parcela) === nParc)) ||
    // 3) sem chave exata (avulsa, vencimento reemitido): parcela EM ABERTO de vencimento
    //    mais próximo do boleto — nunca uma linha arbitrária.
    (venc && mesmoValor
      .filter(c => Number(c.status) === 0 && c.data_vencimento)
      .sort((a, b) => dias(a.data_vencimento, venc) - dias(b.data_vencimento, venc))[0]) ||
    // 4) candidata única no acordo inteiro: não há o que desempatar.
    (mesmoValor.length === 1 ? mesmoValor[0] : null)
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!timingSafeEq(req.headers['x-emit-secret'] || '', process.env.EMIT_ACORDO_SECRET || '')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  let payment = body.payment || null;
  const paymentId = body.payment_id || (payment && payment.id);
  if (!paymentId) return res.status(400).json({ error: 'payment_id/payment ausente' });

  try {
    // Idempotência: já processamos este pagamento?
    const existing = await sbFetch(`fin_operacao?asaas_payment_id=eq.${encodeURIComponent(paymentId)}&select=id&limit=1`);
    if (existing[0]) return res.status(200).json({ ok: true, duplicate: true, operacao_id: existing[0].id });

    // Garante o payload do pagamento (busca no Asaas se só veio o id).
    if (!payment) payment = await asaasReq('GET', `/payments/${encodeURIComponent(paymentId)}`);

    const acordoId = payment.externalReference || '';
    let acordo = null, devedor = null, credor = null;
    if (acordoId) {
      const acs = await sbFetch(`acordos?id=eq.${encodeURIComponent(acordoId)}&select=*&limit=1`).catch(() => []);
      acordo = acs[0] || null;
    }
    if (acordo) {
      const devs = await sbFetch(`devedores?id=eq.${acordo.devedor_id}&select=id,nome,telefone,cliente_id&limit=1`).catch(() => []);
      devedor = devs[0] || null;
    }
    // Fallback: casa o devedor pelo customer Asaas se não veio pelo acordo.
    if (!devedor && payment.customer) {
      const devs = await sbFetch(`devedores?asaas_customer_id=eq.${encodeURIComponent(payment.customer)}&select=id,nome,telefone,cliente_id&limit=1`).catch(() => []);
      devedor = devs[0] || null;
    }
    if (devedor && devedor.cliente_id) {
      const cls = await sbFetch(`clientes?id=eq.${devedor.cliente_id}&select=id,nome&limit=1`).catch(() => []);
      credor = cls[0] || null;
    }
    // FASE C2 (tempo-2): valor original vem de `cobrancas` (fonte única; invariante
    // cobranca.id == devedor.id), não mais de devedores.valor_orig (coluna depreciada).
    let cobValorOrig = null;
    if (devedor) {
      const cobs = await sbFetch(`cobrancas?id=eq.${devedor.id}&select=valor_orig&limit=1`).catch(() => []);
      cobValorOrig = cobs[0] ? cobs[0].valor_orig : null;
    }

    // Split capital/honorário.
    const valorRecebido = round2(payment.value);
    const acordoTotal = Number(acordo && acordo.valor_total) || 0;
    const capitalBase = Number((acordo && acordo.metadata && acordo.metadata.capital_credor)) ||
                        Number(cobValorOrig) || 0;
    // P1 (auditoria 2026-06): só rateia quando há base segura (acordo.valor_total > 0).
    // Sem acordo vinculado, o código antigo forçava capitalRatio=0 → 100% honorário e
    // NUNCA repassava capital ao credor, silenciosamente. Agora, na falta de base,
    // marca a operação para REVISÃO MANUAL em vez de classificar errado.
    const podeRatear = acordoTotal > 0;
    const capitalRatio = podeRatear ? Math.min(capitalBase / acordoTotal, 1) : null;
    const valorCapital = podeRatear ? round2(valorRecebido * capitalRatio) : 0;
    const valorHonorario = podeRatear ? round2(valorRecebido - valorCapital) : 0;
    // Acordo vinculado mas SEM base de capital (capital_credor/valor_orig ausentes ou 0,
    // ex.: dado legado não migrado) NÃO é o mesmo que capital genuinamente zero: também
    // vai para REVISÃO MANUAL, senão o valor cai 100% em honorário e o credor nunca é
    // repassado, sem alerta.
    const repasseStatus = (!podeRatear || capitalBase <= 0)
      ? 'revisar'
      : (valorCapital > 0 ? 'pendente' : 'nao_aplica');

    const row = {
      acordo_id: acordo ? acordo.id : null,
      devedor_id: devedor ? devedor.id : null,
      credor_id: credor ? credor.id : null,
      asaas_payment_id: paymentId,
      asaas_installment_id: payment.installment || (acordo && acordo.metadata && acordo.metadata.asaas_installment_id) || null,
      parcela: payment.installmentNumber || null,
      total_parcelas: (acordo && acordo.num_parcelas) || null,
      valor_recebido: valorRecebido,
      valor_capital: valorCapital,
      valor_honorario: valorHonorario,
      recebido_em: payment.paymentDate || payment.clientPaymentDate || new Date().toISOString().slice(0, 10),
      recebimento_status: 'recebido',
      repasse_status: repasseStatus,
      nf_status: 'pendente',
      metadata: {
        capital_base: capitalBase,
        capital_ratio: capitalRatio,
        billing_type: payment.billingType || null,
        net_value: payment.netValue ?? null,
        credor_nome: credor ? credor.nome : null,
      },
    };
    const inserted = await sbFetch('fin_operacao', { method: 'POST', body: JSON.stringify(row) });
    const operacao = Array.isArray(inserted) ? inserted[0] : inserted;

    // Baixa a parcela correspondente em acordos.parcelas (jsonb) — sem isso, o
    // "Recuperado no mês" do painel (index.html: recuperadoNoMes) só soma baixa
    // manual (toggleParcela), nunca pagamento confirmado automaticamente pelo
    // Asaas. Best-effort: não derruba o webhook se a casada falhar.
    if (acordo && Array.isArray(acordo.parcelas) && acordo.parcelas.length) {
      try {
        const parcelas = acordo.parcelas.map(p => ({ ...p }));
        let idx = -1;
        if (payment.installmentNumber != null) {
          idx = parcelas.findIndex(p => Number(p.numero) === Number(payment.installmentNumber) && !p.pago);
        }
        if (idx < 0 && payment.dueDate) {
          // Sem installmentNumber (cobrança avulsa) — o vencimento do boleto identifica a
          // parcela; valor não, porque num acordo de parcela fixa todas são iguais.
          idx = parcelas.findIndex(p => !p.pago && p.vencimento === payment.dueDate);
        }
        if (idx < 0) {
          // Último recurso: parcela em aberto de vencimento mais próximo do boleto (ou, sem
          // vencimento nenhum, a de valor mais próximo).
          const dias = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
          idx = parcelas.reduce((best, p, i) => {
            if (p.pago) return best;
            const score = payment.dueDate && p.vencimento
              ? dias(p.vencimento, payment.dueDate)
              : Math.abs((+p.valor || 0) - valorRecebido);
            const bp = best < 0 ? null : parcelas[best];
            const bestScore = !bp ? Infinity
              : (payment.dueDate && bp.vencimento ? dias(bp.vencimento, payment.dueDate)
                                                  : Math.abs((+bp.valor || 0) - valorRecebido));
            return score < bestScore ? i : best;
          }, -1);
        }
        if (idx >= 0) {
          parcelas[idx].pago = true;
          parcelas[idx].pagoEm = row.recebido_em;
          const patch = { parcelas };
          if (parcelas.every(p => p.pago)) patch.status = 'encerrado';
          await sbFetch(`acordos?id=eq.${encodeURIComponent(acordo.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        }
      } catch (e) { console.warn('[processar-recebimento] baixa de parcela:', e.message); }
    }

    // Ponte fin_lancamento: registra a RECEITA do recebimento (já paga) e a DESPESA
    // de repasse (nasce ATIVA/pendente porque o recebimento confirmou; vira "pago"
    // quando o PIX de repasse efetiva — /api/repassar e /api/repasse-concluido).
    // Convenção de sinal do app: despesa com valor negativo. conta_id/contato_id ficam
    // nulos (o módulo fin_* veio do Controlle; vínculo fino é passo futuro).
    if (operacao && operacao.id) {
      try {
        const credorNome = (credor && credor.nome) || '';
        const devNome = (devedor && devedor.nome) || 'devedor';
        const parcTxt = row.parcela && row.total_parcelas ? ` ${row.parcela}/${row.total_parcelas}` : '';

        // Casa com o lançamento já existente pra este devedor via cobranca_id (FK real —
        // ver migração 20260806_fin_lancamento_cobranca_id.sql; antes disso a casada era
        // por raw_payload->>'devedor_id', texto solto só nas linhas do import). Considera
        // tanto PENDENTE quanto já PAGO (idempotente) — se já tiver sido baixado por outro
        // caminho (ex.: manual, antes do webhook chegar), só reconfirma em vez de duplicar.
        // Duplicidade real (auditoria 2026-08-06, R$1.867 contados 2x): a versão antiga só
        // olhava status=0, então uma linha já paga manualmente virava candidata inexistente
        // e o webhook criava uma segunda linha do zero pro mesmo pagamento.
        // Casada da parcela: valor SOZINHO não identifica a linha. Num acordo de parcela
        // fixa as 24 linhas têm o mesmo valor e o mesmo `criada_em` (nascem no mesmo
        // INSERT), então "primeira do order=criada_em.desc com valor igual" era empate
        // puro — o Postgres devolvia qualquer uma. Foi o que baixou a 11/24 da Cristiane
        // (pay_30shj4m6rmv4qtb8, Parcela 1 de 24) e a 4/7 da Aline (pay_jniooq9iodcn7g2b,
        // Parcela 2 de 7) em 08/2026. Agora desempata pelo que o Asaas já diz: número da
        // parcela e, principalmente, vencimento. O limit=20 também saiu: com 24 parcelas
        // ele cortava as 4 últimas.
        let lancReceitaId = null;
        let existente = null;
        if (devedor && devedor.id) {
          // limit alto e sem order por criada_em: com 24 parcelas o limit=20 antigo cortava
          // as 4 últimas, e criada_em é idêntico dentro do mesmo acordo.
          const candidatos = await sbFetch(
            `fin_lancamento?tipo_movimento=eq.1&status=in.(0,1)&cobranca_id=eq.${devedor.id}&select=id,valor,status,observacoes,numero_parcela,total_parcelas,data_vencimento&order=data_vencimento.asc&limit=200`
          ).catch(() => []);
          existente = escolherLancamento(candidatos, valorRecebido, payment);
          if (!existente && (candidatos || []).some(c => Math.abs(Number(c.valor) - valorRecebido) < 0.05)) {
            console.warn(`[processar-recebimento] parcelas de mesmo valor e nenhuma casa por vencimento/numero — devedor=${devedor.id} payment=${paymentId}; baixa manual necessaria.`);
          }
        }

        const ehBoleto = String(payment.billingType || '').toUpperCase() === 'BOLETO';

        if (existente) {
          await sbFetch(`fin_lancamento?id=eq.${existente.id}`, { method: 'PATCH', body: JSON.stringify({
            // data_competencia também move pra data real do pagamento — senão a linha
            // continua aparecendo/agrupada no dia do vencimento original (pedido do
            // Gustavo 2026-08-06), mesmo já tendo sido baixada em outra data.
            status: 1, valor_pago: valorRecebido, data_pagamento: row.recebido_em, data_competencia: row.recebido_em,
            observacoes: `${existente.observacoes || ''} | confirmado via Asaas payment ${paymentId} em ${row.recebido_em}.`,
          }) }).catch(() => null);
          lancReceitaId = existente.id;
        } else if (ehBoleto) {
          // Boleto sempre nasce de uma parcela já importada/cadastrada no sistema — se não
          // achou candidato, é sinal de parcela faltando no cadastro, não de recebimento
          // avulso. NÃO cria lançamento novo (pedido do Gustavo 2026-08-06): criar mascarava
          // o problema real (cadastro incompleto) atrás de uma linha sem categoria/conta.
          console.warn(`[processar-recebimento] boleto sem lançamento correspondente — devedor=${devedor && devedor.id} valor=${valorRecebido} payment=${paymentId}`);
        } else {
          const rec = await sbFetch('fin_lancamento', { method: 'POST', body: JSON.stringify({
            descricao: `Recebimento — ${devNome}${parcTxt}`,
            valor: valorRecebido, valor_pago: valorRecebido,
            tipo_movimento: 1, status: 1,
            conta_id: CONTA_ASAAS,
            data_competencia: row.recebido_em, data_pagamento: row.recebido_em,
            // recebimento consumado: vencimento = o dia em que o dinheiro entrou.
            // Sem isto o lançamento some de qualquer relatório por vencimento.
            data_vencimento: row.recebido_em,
            numero_parcela: row.parcela, total_parcelas: row.total_parcelas,
            cobranca_id: devedor ? devedor.id : null,
          }) }).catch(() => null);
          lancReceitaId = (rec && rec[0] && rec[0].id) || null;
          await _categorizar(lancReceitaId, CATEGORIA_ACORDOS, valorRecebido);
        }
        let lancDespesaId = null;
        if (valorCapital > 0) {
          const desp = await sbFetch('fin_lancamento', { method: 'POST', body: JSON.stringify({
            descricao: `Repasse ao credor — ${credorNome || '—'}${parcTxt}`,
            valor: -valorCapital,
            tipo_movimento: 0, status: 0,
            conta_id: CONTA_ASAAS,
            data_competencia: row.recebido_em, data_vencimento: row.recebido_em,
            numero_parcela: row.parcela, total_parcelas: row.total_parcelas,
          }) }).catch(() => null);
          lancDespesaId = (desp && desp[0] && desp[0].id) || null;
          await _categorizar(lancDespesaId, CATEGORIA_REPASSE, valorCapital);
        }
        if (lancReceitaId || lancDespesaId) {
          await sbFetch(`fin_operacao?id=eq.${operacao.id}`, { method: 'PATCH', body: JSON.stringify({ lancamento_receita_id: lancReceitaId, lancamento_despesa_id: lancDespesaId }) }).catch(() => {});
          operacao.lancamento_despesa_id = lancDespesaId;
        }
      } catch (e) { console.warn('[processar-recebimento] ponte fin_lancamento:', e.message); }
    }

    // PR5: emissão automática da NFS-e (gated por AUTO_EMIT_NF=on). Best-effort —
    // depende de configuração fiscal municipal na conta Asaas. O disparo manual fica
    // sempre disponível em /api/emitir-nf.
    let nf = null;
    if (operacao && operacao.id && String(process.env.AUTO_EMIT_NF || '').toLowerCase() === 'on') {
      try {
        const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
        if (base) {
          const r = await fetch(base + '/api/emitir-nf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-emit-secret': process.env.EMIT_ACORDO_SECRET || '' },
            body: JSON.stringify({ operacao_id: operacao.id }),
          });
          nf = await r.json().catch(() => ({ status: r.status }));
        }
      } catch (e) { nf = { error: e.message }; }
    }

    // Recibo automático (R4) — best-effort. Formato "Financeiro COBRASQ" (pedido do
    // Gustavo 2026-08-06): PDF do recibo (mesmo timbrado que a Bia já usa quando o
    // devedor pede o comprovante manualmente — ver _recibo.js), gerado UMA vez e usado
    // em dois envios independentes:
    //   1. ao devedor (se tiver telefone cadastrado) — PDF anexo + mensagem confirmando
    //      a parcela; sem PDF, cai no link oficial do Asaas em vez de mentir "em anexo".
    //   2. cópia de monitoramento pro número do Gustavo — SÓ o PDF, sem mensagem, em
    //      TODO recebimento (mesmo sem devedor casado/telefone).
    const nomeCompleto = (devedor && devedor.nome) || 'Cliente';
    const dadosRec = {
      nome: nomeCompleto,
      valorNum: valorRecebido,
      valorFmt: valorRecebido.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      dataISO: row.recebido_em,
      forma: formaPagamento(payment.billingType),
      num: 'Nº ' + String(paymentId).slice(-6).toUpperCase(),
    };
    let b64 = '';
    try { b64 = await gerarReciboPdfBase64(dadosRec); } catch (e) { console.warn('[processar-recebimento] gerar recibo PDF:', e.message); }

    let zap = null, pdfEnviado = false, erroPdf = null;
    const tel = String((devedor && devedor.telefone) || '').replace(/\D/g, '');
    if (tel) {
      if (b64) { try { pdfEnviado = await zapiSendDocumentPdf(tel, b64, 'Recibo COBRASQ.pdf'); } catch (e) { pdfEnviado = false; erroPdf = e.message; } }

      const meioTxt = { PIX: 'do Pix', BOLETO: 'do boleto', CREDIT_CARD: 'do cartão', DEBIT_CARD: 'do cartão' }[String(payment.billingType || '').toUpperCase()] || 'do pagamento';
      const linhaParcela = row.parcela && row.total_parcelas ? ` referente a parcela n. ${row.parcela} de ${row.total_parcelas} do acordo realizado` : '';
      // Sem PDF, a mensagem vai SEM anexo e SEM link. O `transactionReceiptUrl` do Asaas
      // é uma página PÚBLICA, que expõe dados das duas partes a quem tiver o endereço —
      // a mesma razão pela qual o comprovante de repasse ao credor vai em base64 e nunca
      // por URL. Em 17/08/2026 esse fallback mandou o link ao Jean Carlos porque a
      // geração do PDF estourou o tempo limite.
      const linhaAnexo = pdfEnviado ? 'Em anexo, seu recibo de pagamento.' : '';

      const msg = `*Financeiro COBRASQ*\n${nomeCompleto}, o pagamento ${meioTxt}${linhaParcela} foi confirmado. ✅${linhaAnexo ? '\n\n' + linhaAnexo : ''}\n_Agradecemos!_`;
      try { zap = await zapiSendText(tel, msg); } catch (e) { zap = { error: e.message }; }
    }

    let monitorEnviado = false;
    if (b64) {
      try { monitorEnviado = await zapiSendDocumentPdf(NUMERO_MONITORAMENTO, b64, `Recibo COBRASQ - ${nomeCompleto}.pdf`); } catch (e) { monitorEnviado = false; }
    }

    // Falha do recibo vira evento na ficha do devedor. Antes era silenciosa: o retorno
    // trazia `recibo_pdf_enviado: false` e ninguém lia — o devedor simplesmente ficava
    // sem o comprovante, ou recebia o link público no lugar. Best-effort.
    if (devedor && devedor.id && !pdfEnviado) {
      await sbFetch('devedor_eventos', {
        method: 'POST',
        body: JSON.stringify({
          devedor_id: devedor.id,
          tipo: 'recibo_pdf_falhou',
          payload: {
            payment_id: paymentId,
            valor: valorRecebido,
            motivo: b64 ? 'PDF gerado, mas o envio pela Z-API falhou' : 'geração do PDF falhou (duas tentativas)',
            erro: erroPdf,
            tinha_telefone: !!tel,
          },
          autor_nome: 'Financeiro (webhook Asaas)',
        }),
      }).catch(() => { /* best-effort */ });
    }

    // Falha do TEXTO também vira evento. Até 20/08/2026 o erro do `zapiSendText` morria
    // dentro de `zap = { error }` e não era gravado em lugar nenhum — no caso da
    // Cristiane (18/08) não deu para saber, depois do fato, se a confirmação chegou a
    // sair. `crm_mensagens_enviadas` não cobre este caminho: só registra CRM/Bia.
    if (devedor && devedor.id && tel && !(zap && zap.messageId)) {
      await sbFetch('devedor_eventos', {
        method: 'POST',
        body: JSON.stringify({
          devedor_id: devedor.id,
          tipo: 'recibo_texto_falhou',
          payload: {
            payment_id: paymentId,
            valor: valorRecebido,
            telefone: tel,
            erro: (zap && zap.error) || 'a Z-API não devolveu messageId',
          },
          autor_nome: 'Financeiro (webhook Asaas)',
        }),
      }).catch(() => { /* best-effort */ });
    }

    return res.status(200).json({
      ok: true,
      operacao_id: operacao && operacao.id,
      valor_recebido: valorRecebido,
      valor_capital: valorCapital,
      valor_honorario: valorHonorario,
      repasse_status: row.repasse_status,
      recibo_pdf_enviado: pdfEnviado,
      recibo_enviado: !!(zap && zap.messageId),
      recibo_monitoramento_enviado: monitorEnviado,
      nf,
    });
  } catch (e) {
    console.error('[processar-recebimento]', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Exposto para teste (test/f05_asaas_casada_parcela.test.js). O handler continua sendo
// o export principal do módulo.
module.exports.escolherLancamento = escolherLancamento;
