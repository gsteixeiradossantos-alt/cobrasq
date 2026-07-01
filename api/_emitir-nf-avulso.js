// api/_emitir-nf-avulso.js — Emite uma NFS-e AVULSA pelo Asaas, SEM depender de um
// pagamento/cobrança (fin_operacao). O tomador é identificado pelo `customer` do
// Asaas (achado/criado por CPF/CNPJ), não pelo `payment`. Despachado por
// api/automacao.js (?action=emitir-nf-avulso). Owner-only. Uso manual/lote (a UI
// chama uma vez por linha da lista).
//
// Por que existe: o emissor nativo (api/_emitir-nf.js) só emite vinculado a um
// asaas_payment_id de uma fin_operacao recebida. Para emitir notas a partir de uma
// lista solta (nome/CPF/valor) a corrente de pagamentos não serve — esta rota emite
// direto pelo cadastro do tomador.
//
// Pré-requisito de produção (igual ao emissor nativo): config fiscal municipal
// habilitada na conta Asaas (serviço municipal, alíquota ISS). Parametrizável pelos
// MESMOS envs: ASAAS_NF_ISS, ASAAS_NF_MUNICIPAL_SERVICE_CODE/NAME,
// ASAAS_NF_SERVICE_DESCRIPTION, ASAAS_NF_RETAIN_ISS.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq, ensureAsaasCustomer } = require('./_asaas.js');

// Descrição livre do serviço (campo serviceDescription do Asaas). Sobrescrevível por env.
const DEFAULT_NF_DESC = 'Serviços de cobrança e recuperação de crédito prestados ao tomador, referentes ao acompanhamento e à intermediação do recebimento de valores inadimplidos.';

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
const digits = (s) => String(s || '').replace(/\D/g, '');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;

  // Gate de proprietário (mesma checagem do backfill). Service role ignora RLS, então
  // a trava é aqui no servidor — emitir nota fiscal é ação de gestor, não de operador.
  let papel = null;
  try {
    const rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel`);
    papel = Array.isArray(rows) && rows[0] ? rows[0].papel : null;
  } catch (e) {
    return res.status(500).json({ error: 'Não foi possível verificar permissão.' });
  }
  if (papel !== 'proprietario') {
    return res.status(403).json({ error: 'Apenas o proprietário pode emitir notas fiscais.' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const nome = String(body.nome || '').trim();
  const doc = digits(body.doc || body.cpf_cnpj);
  const valor = round2(body.valor);
  const descricao = String(body.descricao || '').trim();
  const ref = String(body.ref || '').trim(); // chave de idempotência opcional (uma por linha do lote)
  const endereco = (body.endereco && typeof body.endereco === 'object') ? body.endereco : {};
  // Serviço municipal (NFS-e): obrigatório. Vem do corpo (seletor da UI) ou de env.
  const munId = String(body.municipalServiceId || process.env.ASAAS_NF_MUNICIPAL_SERVICE_ID || '').trim();
  const munCode = String(body.municipalServiceCode || process.env.ASAAS_NF_MUNICIPAL_SERVICE_CODE || '').trim();
  const munName = String(body.municipalServiceName || process.env.ASAAS_NF_MUNICIPAL_SERVICE_NAME || '').trim();
  // Metadados fiscais p/ a conciliação ISS por competência (gravados no metadata,
  // não vão no payload do Asaas). competencia "MM/AAAA"; aliquota = % ISS do modelo.
  const competencia = String(body.competencia || '').trim() || null;
  const aliquotaNum = (body.aliquota != null && isFinite(Number(body.aliquota))) ? Number(body.aliquota) : null;
  const modeloNome = String(body.modelo_nome || '').trim() || null;
  const municipio = String(body.municipio || '').trim() || null;
  const fiscalMeta = {};
  if (competencia) fiscalMeta.competencia = competencia;
  if (aliquotaNum != null) fiscalMeta.aliquota = aliquotaNum;
  if (modeloNome) fiscalMeta.modelo_nome = modeloNome;
  if (municipio) fiscalMeta.municipio = municipio;

  if (!doc) return res.status(400).json({ error: 'CPF/CNPJ obrigatório para emitir NFS-e (identifica o tomador).' });
  if (!munId && !munCode) return res.status(400).json({ error: 'Serviço municipal não informado. Selecione o serviço da NFS-e (municipalServiceId) na tela antes de emitir.' });
  if (!(valor > 0)) return res.status(400).json({ error: 'Valor inválido.' });

  let rowId = null;
  try {
    // DEDUP FORTE por (CPF/CNPJ + valor): se já há nota EMITIDA pro mesmo tomador e
    // valor, NÃO emite outra — evita duplicidade na prefeitura. E para não empilhar
    // tentativas falhas: reaproveita UMA linha não-emitida do mesmo item e apaga as
    // demais (resolve o "18 → 36 com erro").
    const mesmas = await sbFetch(`nf_avulsa?doc_digits=eq.${encodeURIComponent(doc)}&valor=eq.${valor}&select=id,nf_status,nf_url,nf_asaas_id&order=criada_em.desc`).catch(() => []);
    // Só bloqueia se há nota REALMENTE emitida (com PDF). 'emitida' sem nf_url é
    // falso-positivo do fluxo assíncrono e NÃO deve travar a reemissão.
    const emitida = Array.isArray(mesmas) ? mesmas.find((x) => x.nf_status === 'emitida' && x.nf_url) : null;
    if (emitida) {
      return res.status(200).json({ ok: true, skipped: 'já emitida (mesmo CPF+valor)', nf_status: 'emitida', nf_id: emitida.nf_asaas_id, nf_url: emitida.nf_url });
    }
    const reuso = Array.isArray(mesmas) ? mesmas.filter((x) => !(x.nf_status === 'emitida' && x.nf_url)) : [];
    rowId = reuso[0] ? reuso[0].id : null;
    const apagar = reuso.slice(1).map((x) => x.id);
    if (apagar.length) { await sbFetch(`nf_avulsa?id=in.(${apagar.join(',')})`, { method: 'DELETE' }).catch(() => {}); }

    // Garante o customer no Asaas (acha por CPF, sincroniza endereço; cria se não houver).
    // Monta um objeto "dev-like" que buildAsaasAddress/ensureAsaasCustomer entende.
    const devLike = {
      nome: nome || 'Tomador',
      doc,
      asaas_customer_id: body.asaas_customer_id || null,
      email: body.email || undefined,
      telefone: body.telefone || undefined,
      endereco_crm: {
        cep: endereco.cep, rua: endereco.rua || endereco.logradouro,
        numero: endereco.numero, complemento: endereco.complemento, bairro: endereco.bairro,
      },
    };
    const { customerId } = await ensureAsaasCustomer(devLike);

    // Registra/atualiza a tentativa ANTES de chamar o Asaas (status 'emitindo'), para
    // haver rastro mesmo se falhar no meio. Reusa a linha de erro do item se existir.
    const linhaTentativa = {
      nome: nome || null, doc, doc_digits: doc, valor, descricao: descricao || null,
      asaas_customer_id: customerId, nf_status: 'emitindo', erro: null, criada_por: user.id,
      metadata: { ...(ref ? { ref } : {}), ...fiscalMeta },
    };
    if (rowId) {
      await sbFetch(`nf_avulsa?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify(linhaTentativa) }).catch(() => {});
    } else {
      const ins = await sbFetch('nf_avulsa', { method: 'POST', body: JSON.stringify(linhaTentativa) });
      rowId = Array.isArray(ins) && ins[0] ? ins[0].id : null;
    }

    // Monta o payload da NFS-e — IGUAL ao emissor nativo, trocando `payment` por `customer`.
    const iss = Number(process.env.ASAAS_NF_ISS || 0);
    const invoicePayload = {
      customer: customerId,
      serviceDescription: descricao || process.env.ASAAS_NF_SERVICE_DESCRIPTION || DEFAULT_NF_DESC,
      observations: ref ? `Ref ${ref}.` : 'Emissão avulsa.',
      value: valor,
      deductions: 0,
      effectiveDate: new Date().toISOString().slice(0, 10),
      taxes: {
        retainIss: String(process.env.ASAAS_NF_RETAIN_ISS || '').toLowerCase() === 'true',
        iss, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0,
      },
    };
    // Identificação do serviço municipal. Conta com lista → municipalServiceId.
    // Conta via Portal Nacional (sem lista) → municipalServiceId:null + Code (+ Name),
    // conforme a doc do Asaas. Sem isso a prefeitura rejeita a NFS-e.
    if (munId) {
      invoicePayload.municipalServiceId = munId;
    } else if (munCode) {
      invoicePayload.municipalServiceId = null;
      invoicePayload.municipalServiceCode = munCode;
    }
    if (munName) invoicePayload.municipalServiceName = munName;

    // Cria e autoriza (emite de fato) a NFS-e.
    const invoice = await asaasReq('POST', '/invoices', invoicePayload);
    let authorized = invoice;
    try { authorized = await asaasReq('POST', `/invoices/${invoice.id}/authorize`, {}); }
    catch (e) { authorized = { ...invoice, _authorizeError: e.message }; }

    // A NFS-e é autorizada pela prefeitura de forma ASSÍNCRONA: o /authorize NÃO-erro
    // só agenda; não significa autorizada. Só marca 'emitida' quando status=AUTHORIZED
    // (ou já veio pdfUrl). Senão fica 'processando' (e a UI reconcilia depois). ERROR
    // já traz o motivo. Evita o falso-positivo "emitida sem PDF".
    const st = String(authorized.status || invoice.status || '').toUpperCase();
    const nfUrl = authorized.pdfUrl || authorized.xmlUrl || invoice.pdfUrl || '';
    let nfStatus, nfErro = null;
    if (st === 'AUTHORIZED' || nfUrl) nfStatus = 'emitida';
    else if (st === 'ERROR') { nfStatus = 'erro'; nfErro = (authorized.errors && authorized.errors[0] && authorized.errors[0].description) || authorized.statusDescription || 'Recusada pela prefeitura'; }
    else nfStatus = 'processando';

    if (rowId) {
      await sbFetch(`nf_avulsa?id=eq.${rowId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          nf_status: nfStatus, erro: nfErro, nf_asaas_id: invoice.id || null, nf_url: nfUrl || null,
          metadata: { ...(ref ? { ref } : {}), ...fiscalMeta, nf_number: authorized.number || null },
        }),
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, nf_status: nfStatus, nf_id: invoice.id || null, nf_url: nfUrl || null, erro: nfErro, customer_id: customerId });
  } catch (e) {
    if (rowId) {
      await sbFetch(`nf_avulsa?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ nf_status: 'erro', erro: String(e.message || e).slice(0, 500) }) }).catch(() => {});
    }
    console.error('[emitir-nf-avulso]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
