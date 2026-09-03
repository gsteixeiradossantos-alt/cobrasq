// api/emitir-acordo.js — Emite o parcelamento no Asaas para um acordo ASSINADO e
// manda o boleto/PIX ao devedor por WhatsApp. (PR2 do roadmap de automação.)
//
// Chamado por:
//   - zapsign-webhook (Supabase edge) ao assinar — server-to-server, header
//     x-emit-secret == EMIT_ACORDO_SECRET. Gated por AUTO_EMIT_ACORDO=on para não
//     duplicar com o fluxo n8n legado enquanto ele não é desligado.
//   - app (botão manual no Faturamento) — usuário Supabase logado; sempre emite.
//
// Idempotência: pula se metadata.boletos_emitidos.
// NÃO usar acordos.cobranca_id como flag de "já emitido" — desde 20260827 ele é o vínculo
// real com a dívida e é preenchido no INSERT de todo acordo. Usá-lo aqui faria a emissão
// pular sempre (nenhum boleto sairia). A flag de emissão é só metadata.
// externalReference do pagamento = acordo.id (a baixa por parcela e a "operação
// única" recebimento↔repasse são fechadas na PR3, que consome o asaas-webhook).

const crypto = require('crypto');
const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq, ensureAsaasCustomer } = require('./_asaas.js');
const { zapiSendText } = require('./_zapi.js');

const { addDiasBR } = require('./_data.js');
function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
// Conta "Asaas" no Financeiro — é nela que as parcelas de acordo entram, igual ao
// que já era feito à mão. Env var permite mudar sem deploy de código.
const CONTA_ASAAS = Number(process.env.FIN_CONTA_ASAAS_ID || 13);
function addDaysISO(d) { return addDiasBR(d); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'tudo bem'; }
// Mensagem padrão do boleto no WhatsApp (emissão e reenvio).
function boletoMsg(nome, link) {
  return `*Financeiro COBRASQ:*\n`
    + `Olá, ${firstName(nome)}! Como vai?\n`
    + `Informamos que os boletos referentes ao nosso acordo realizado recentemente foram emitidos e estão disponíveis para pagamento. Para acessá-los basta clicar no link a seguir:\n\n`
    + `Link do boleto:\n${link}\n\n`
    + `_Se precisar de alguma ajuda, é só nos chamar._`;
}
// Variante para acordo em faixas de valor (várias séries no Asaas — ver "usaBlocos"
// mais abaixo): lista um link por faixa em vez de assumir um único boleto/série.
function boletoMsgMultiplo(nome, links) {
  const lista = links.map((l, i) => `Faixa ${i + 1}:\n${l}`).join('\n\n');
  return `*Financeiro COBRASQ:*\n`
    + `Olá, ${firstName(nome)}! Como vai?\n`
    + `Informamos que os boletos referentes ao nosso acordo realizado recentemente foram emitidos e estão disponíveis para pagamento. Seguem os links:\n\n`
    + `${lista}\n\n`
    + `_Se precisar de alguma ajuda, é só nos chamar._`;
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
    // Acordo cancelado não emite nem reenvia boleto. Sem esta trava, a emissão faria
    // `status: 'ativo'` mais abaixo e RESSUSCITARIA um acordo que o operador matou.
    if (String(acordo.status || '').toLowerCase() === 'cancelado') {
      return res.status(409).json({ error: 'acordo cancelado — reabra o acordo antes de emitir boleto', acordo_id: acordoId });
    }

    const meta = acordo.metadata || {};

    // Modo REENVIO: acordo já emitido → só reenvia o link do boleto por WhatsApp (não
    // cria boleto novo). Grava metadata.whatsapp_ok com o resultado (alimenta o Painel).
    if ((body.resend === true || req.query.resend) && meta.boletos_emitidos) {
      // Acordo em faixas grava um link por série em metadata.asaas_series; acordo
      // de série única só tem o campo singular de sempre. Reenvia todos que existirem.
      const linksSeries = Array.isArray(meta.asaas_series) ? meta.asaas_series.map((s) => s.invoice_url).filter(Boolean) : [];
      const url = meta.asaas_invoice_url || '';
      const links = linksSeries.length > 1 ? linksSeries : (url ? [url] : []);
      const dvs = await sbFetch(`devedores?id=eq.${acordo.devedor_id}&select=nome,telefone&limit=1`);
      const dev = dvs[0];
      const tel = String((dev && dev.telefone) || '').replace(/\D/g, '');
      if (!tel || !links.length) return res.status(200).json({ ok: true, acordo_id: acordoId, reenviado: false, motivo: !tel ? 'devedor sem telefone' : 'acordo sem link' });
      let zap = null;
      try { zap = await zapiSendText(tel, links.length > 1 ? boletoMsgMultiplo(dev.nome, links) : boletoMsg(dev.nome, links[0])); }
      catch (e) { zap = { error: e.message }; }
      const enviado = !!(zap && zap.messageId);
      await sbFetch(`acordos?id=eq.${acordo.id}`, { method: 'PATCH', body: JSON.stringify({ metadata: { ...meta, whatsapp_ok: enviado } }) }).catch(() => {});
      await sbFetch('devedor_eventos', { method: 'POST', body: JSON.stringify({ devedor_id: acordo.devedor_id, tipo: 'asaas_boletos_emitidos', payload: { acordo_id: acordoId, invoice_url: links[0], invoice_urls: links, whatsapp: enviado ? 'enviado' : 'falha', via: 'reenvio' }, autor_nome: 'Faturamento (reenvio)' }) }).catch(() => {});
      return res.status(200).json({ ok: true, acordo_id: acordoId, reenviado: enviado, erro: enviado ? undefined : (zap && zap.error) });
    }

    if (meta.boletos_emitidos) {
      return res.status(200).json({ ok: true, skipped: 'já emitido', acordo_id: acordoId });
    }
    acordoRef = acordo.id; prevMeta = meta; devedorRef = acordo.devedor_id;
    // Trava anti-duplicação com o n8n: automático só emite com AUTO_EMIT_ACORDO=on.
    if (!manual && String(process.env.AUTO_EMIT_ACORDO || '').toLowerCase() !== 'on') {
      return res.status(200).json({ ok: true, skipped: 'auto-emit desligado (AUTO_EMIT_ACORDO≠on)', acordo_id: acordoId });
    }

    const devs = await sbFetch(`devedores?id=eq.${acordo.devedor_id}&select=id,nome,doc,email,telefone,asaas_customer_id,cep,rua,numero,complemento,bairro,cidade,uf,endereco,endereco_crm,metadata&limit=1`);
    const dev = devs[0];
    if (!dev) return res.status(404).json({ error: 'devedor não encontrado' });

    const { customerId, created } = await ensureAsaasCustomer(dev);
    if (customerId && customerId !== dev.asaas_customer_id) {
      await sbFetch(`devedores?id=eq.${dev.id}`, { method: 'PATCH', body: JSON.stringify({ asaas_customer_id: customerId }) })
        .catch((e) => console.warn('[emitir-acordo] não persistiu asaas_customer_id no devedor:', e && e.message));
    }

    // Monta o parcelamento a partir dos termos do acordo.
    const parcelas = Array.isArray(acordo.parcelas) ? acordo.parcelas : [];
    let nParc = acordo.num_parcelas || parcelas.length || 1;
    let total = Number(acordo.valor_total) || parcelas.reduce((s, p) => s + (Number(p.valor) || 0), 0);

    // Blindagem (caso Francieli, 25/06/2026): acordos criados pelo n8n vinham só com
    // valor_total — num_parcelas=null e parcelas=[] — e a emissão caía p/ 1x (boleto
    // único) mesmo num acordo parcelado. Os termos reais ficam no acordo_final da
    // cobrança vinculada (acordo.cobranca_id; devedor_id só como último recurso — o
    // invariante 1:1 morre na 2ª cobrança do mesmo devedor). Se o acordo não declara
    // parcelamento, puxa de lá.
    if (nParc <= 1) {
      try {
        const cob = await sbFetch(`cobrancas?id=eq.${encodeURIComponent(acordo.cobranca_id || acordo.devedor_id)}&select=acordo_final&limit=1`);
        const af = cob && cob[0] && cob[0].acordo_final;
        const afParc = af && Number(af.parcelas);
        if (afParc && afParc > 1) {
          nParc = afParc;
          if (!(total > 0)) total = Number(af.total) || (Number(af.valor) || 0) * afParc;
        }
      } catch (e) { console.warn('[emitir-acordo] fallback acordo_final:', e && e.message); }
    }

    // R-19 (caso Edilaine, 05/08/2026): acordo.valor_total é o valor CHEIO do
    // acordo (entrada incluída, ex. PIX pago à parte). Sem subtrair a entrada
    // aqui, o Asaas parcelava o total cheio em nParc boletos e cobrava a
    // entrada de novo, embutida em cada parcela.
    const entrada = Number(acordo.valor_entrada) || 0;
    if (entrada > 0) total = round2(total - entrada);

    if (!(total > 0)) return res.status(400).json({ error: 'acordo sem valor_total' });
    const firstDue = acordo.data_primeiro_venc || (parcelas[0] && (parcelas[0].venc || parcelas[0].vencimento)) || addDaysISO(3);

    // P1 (auditoria 2026-06) — claim atômico anti-duplicidade antes de criar o
    // parcelamento no Asaas. O UPDATE com WHERE em metadata->>emitindo/boletos_emitidos
    // é serializado pelo lock de linha do Postgres: só uma chamada concorrente passa;
    // a outra sai sem emitir uma 2ª série de boletos. O catch reverte em caso de erro.
    const claim = await sbFetch(
      `acordos?id=eq.${acordo.id}&metadata->>boletos_emitidos=is.null&metadata->>emitindo=is.null`,
      { method: 'PATCH', body: JSON.stringify({ metadata: { ...meta, emitindo: new Date().toISOString() } }) }
    ).catch(() => []);
    if (!Array.isArray(claim) || !claim[0]) {
      return res.status(200).json({ ok: true, skipped: 'emissão já em andamento/concluída', acordo_id: acordoId });
    }
    claimedAcordo = true;

    // 1x = boleto único (campo `value`); 2x+ = parcelamento (installmentCount+totalValue).
    // O Asaas rejeita installmentCount=1, então os casos são separados.
    //
    // ACORDO EM FAIXAS ("blocos"): quando o acordo foi montado no Faturamento com
    // mais de uma faixa de valor (ex.: 3x R$300 depois 12x R$400 — ver
    // index.html: salvarAcordo()/addBlocoAcordo()), o Asaas NÃO tem como cobrar isso
    // numa série só: installmentCount+totalValue sempre divide o total IGUALMENTE
    // pelas parcelas. A saída é emitir 1 série por faixa (dentro de cada faixa o
    // valor já é uniforme). Todas as séries usam o MESMO externalReference=acordo.id
    // — é por esse campo que api/_processar-recebimento.js resolve o acordo no
    // webhook, então ter várias séries no mesmo acordo não quebra esse caminho.
    const blocosMeta = Array.isArray(meta.blocos) ? meta.blocos.filter((b) => b && b.qtd > 0 && b.valor > 0) : [];
    const usaBlocos = blocosMeta.length > 1;

    let series; // [{ bloco, qtd, total, dueDate, charge }] — sempre >=1 entrada.
    if (usaBlocos) {
      series = [];
      for (let bi = 0; bi < blocosMeta.length; bi++) {
        const bloco = blocosMeta[bi];
        const parcelasDoBloco = parcelas.filter((p) => (p.bloco || 0) === bi + 1);
        const dueBloco = (parcelasDoBloco[0] && (parcelasDoBloco[0].vencimento || parcelasDoBloco[0].venc)) || firstDue;
        const totalBloco = round2(bloco.qtd * bloco.valor);
        const payBloco = {
          customer: customerId,
          billingType: 'BOLETO',
          dueDate: dueBloco,
          description: `Acordo ${dev.nome} — faixa ${bi + 1}/${blocosMeta.length} (${bloco.qtd}x ${round2(bloco.valor)})`,
          externalReference: acordo.id,
          fine: { value: 10 },
          interest: { value: 1 },
        };
        if (bloco.qtd > 1) { payBloco.installmentCount = bloco.qtd; payBloco.totalValue = totalBloco; }
        else { payBloco.value = totalBloco; }
        const chargeBloco = await asaasReq('POST', '/payments', payBloco);
        series.push({ bloco: bi + 1, qtd: bloco.qtd, total: totalBloco, dueDate: dueBloco, charge: chargeBloco });
      }
    } else {
      const pay = {
        customer: customerId,
        billingType: 'BOLETO',
        dueDate: firstDue,
        description: `Acordo ${dev.nome}${nParc > 1 ? ` — ${nParc}x` : ' — à vista'}`,
        externalReference: acordo.id,
        // Multa 10% é o padrão declarado no termo de acordo (campo "Multa boleto (%)",
        // peticao-teixeira-azzolin) — estava hardcoded em 2%, descasado do que o
        // devedor assina. Achado junto com o R-19 (caso Edilaine, 05/08/2026).
        fine: { value: 10 },
        interest: { value: 1 },
      };
      if (nParc > 1) { pay.installmentCount = nParc; pay.totalValue = round2(total); }
      else { pay.value = round2(total); }
      const charge = await asaasReq('POST', '/payments', pay);
      series = [{ bloco: 1, qtd: nParc, total, dueDate: firstDue, charge }];
    }

    // charge da 1ª série = pagamento da 1ª parcela; .installment = id da série.
    // Mantemos os campos singulares (asaas_installment_id/asaas_invoice_url/...)
    // apontando pra 1ª série por compatibilidade com quem já lê só isso
    // (index.html, api/_processar-recebimento.js fallback, painel) — e
    // adicionamos asaas_series/asaas_installment_ids com TODAS as séries, que é
    // o que api/_boletos-para-lancamentos.js passa a usar para não perder o
    // vínculo dos boletos das faixas seguintes.
    const primeira = series[0].charge;
    const invoiceUrl = primeira.invoiceUrl || primeira.bankSlipUrl || '';

    const newMeta = {
      ...meta,
      boletos_emitidos: true,
      emitido_em: new Date().toISOString(),
      emitido_via: manual ? 'manual' : 'auto',
      valor_entrada_excluida: entrada > 0 ? entrada : undefined,
      valor_boletos: total,
      asaas_installment_id: primeira.installment || null,
      asaas_first_payment_id: primeira.id || null,
      asaas_invoice_url: invoiceUrl,
      asaas_installment_ids: series.map((s) => s.charge.installment).filter(Boolean),
      asaas_series: series.map((s) => ({
        bloco: s.bloco,
        qtd: s.qtd,
        total: s.total,
        due: s.dueDate,
        installment_id: s.charge.installment || null,
        first_payment_id: s.charge.id || null,
        invoice_url: s.charge.invoiceUrl || s.charge.bankSlipUrl || null,
      })),
      asaas_customer_id: customerId,
    };
    await sbFetch(`acordos?id=eq.${acordo.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ativo', metadata: newMeta }) });

    // PARCELAS PREVISTAS NO FINANCEIRO. Até 21/08/2026 a emissão criava os boletos
    // no Asaas e não escrevia nada em `fin_lancamento` — o Financeiro só passava a
    // conhecer a parcela quando ela era PAGA (asaas-webhook → processar-recebimento).
    // Resultado: acordo assinado não aparecia como recebível, e a tela de Movimentações
    // mostrava o futuro vazio (caso Michele Garipuna, 18x R$ 280 emitidos e zero
    // lançamentos). Aqui gravamos as parcelas como previstas (status 0), lendo os
    // vencimentos REAIS do Asaas — que ajusta data por fim de semana/feriado, então
    // calcular mês a mês aqui divergiria do boleto. Best-effort: falha não derruba a
    // emissão, que já está feita e é o que importa para o devedor.
    // Percorre TODAS as séries (1 no caminho antigo, N com blocos) numerando as
    // parcelas em sequência contínua (1..nParc) através das faixas.
    let previstas = 0;
    try {
      const linhasAll = [];
      let offsetParc = 0;
      for (const s of series) {
        let pagamentos = [];
        if (s.charge.installment) {
          const lista = await asaasReq('GET', `/payments?installment=${encodeURIComponent(s.charge.installment)}&limit=100`);
          pagamentos = (lista && lista.data) || [];
        } else if (s.charge.id) {
          pagamentos = [s.charge];
        }
        pagamentos
          .slice()
          .sort((a, b) => (a.installmentNumber || 1) - (b.installmentNumber || 1))
          .forEach((p) => {
            linhasAll.push({
              descricao: `${dev.nome} ${offsetParc + (p.installmentNumber || 1)}/${nParc}`,
              tipo_movimento: 1,
              status: 0,
              valor: round2(p.value),
              data_competencia: p.dueDate,
              data_vencimento: p.dueDate,
              conta_id: CONTA_ASAAS,
              cobranca_id: acordo.cobranca_id || acordo.devedor_id,   // vínculo real; devedor_id é fallback legado
              acordo_id: acordo.id,
              asaas_payment_id: p.id,
              numero_parcela: offsetParc + (p.installmentNumber || 1),
              total_parcelas: nParc,
              grupo_parcelamento: s.charge.installment || null,
            });
          });
        offsetParc += s.qtd;
      }
      if (linhasAll.length) {
        // ignoreDuplicates no asaas_payment_id: reemissão/retry não duplica a previsão.
        await sbFetch('fin_lancamento', {
          method: 'POST',
          prefer: 'resolution=ignore-duplicates,return=minimal',
          body: JSON.stringify(linhasAll),
        });
        previstas = linhasAll.length;
      }
    } catch (e) {
      console.warn('[emitir-acordo] parcelas previstas no financeiro:', e && e.message);
    }

    // WhatsApp com o(s) link(s) do boleto/PIX (best-effort, não derruba a emissão).
    // 1 série = mensagem simples (igual sempre foi); >1 série = lista uma por faixa.
    let zap = null;
    const tel = String(dev.telefone || '').replace(/\D/g, '');
    const linksValidos = series.map((s) => s.charge.invoiceUrl || s.charge.bankSlipUrl || '').filter(Boolean);
    if (tel && linksValidos.length === 1) {
      try { zap = await zapiSendText(tel, boletoMsg(dev.nome, linksValidos[0])); } catch (e) { zap = { error: e.message }; }
    } else if (tel && linksValidos.length > 1) {
      try { zap = await zapiSendText(tel, boletoMsgMultiplo(dev.nome, linksValidos)); } catch (e) { zap = { error: e.message }; }
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
          installment: primeira.installment || null,
          series: series.length,
          parcelas: nParc,
          total,
          invoice_url: invoiceUrl,
          parcelas_previstas: previstas,
          whatsapp: zap && zap.messageId ? 'enviado' : 'falha/sem-tel',
          via: manual ? 'manual' : 'auto',
        },
        autor_nome: manual ? 'Faturamento (manual)' : 'ZapSign (auto)',
      }),
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      acordo_id: acordo.id,
      installment: primeira.installment || null,
      series: series.length,
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
