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

  if (!doc) return res.status(400).json({ error: 'CPF/CNPJ obrigatório para emitir NFS-e (identifica o tomador).' });
  if (!(valor > 0)) return res.status(400).json({ error: 'Valor inválido.' });

  let rowId = null;
  try {
    // Idempotência: se já existe uma nota EMITIDA com a mesma ref, não emite outra.
    if (ref) {
      const ja = await sbFetch(`nf_avulsa?metadata->>ref=eq.${encodeURIComponent(ref)}&nf_status=eq.emitida&select=id,nf_url,nf_asaas_id&limit=1`).catch(() => []);
      if (Array.isArray(ja) && ja[0]) {
        return res.status(200).json({ ok: true, skipped: 'já emitida (ref)', nf_status: 'emitida', nf_id: ja[0].nf_asaas_id, nf_url: ja[0].nf_url });
      }
    }

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

    // Registra a tentativa ANTES de chamar o Asaas (status 'emitindo'), para haver
    // rastro mesmo se a emissão falhar no meio.
    const ins = await sbFetch('nf_avulsa', {
      method: 'POST',
      body: JSON.stringify({
        nome: nome || null, doc, doc_digits: doc, valor, descricao: descricao || null,
        asaas_customer_id: customerId, nf_status: 'emitindo', criada_por: user.id,
        metadata: ref ? { ref } : {},
      }),
    });
    rowId = Array.isArray(ins) && ins[0] ? ins[0].id : null;

    // Monta o payload da NFS-e — IGUAL ao emissor nativo, trocando `payment` por `customer`.
    const iss = Number(process.env.ASAAS_NF_ISS || 0);
    const invoicePayload = {
      customer: customerId,
      serviceDescription: descricao || process.env.ASAAS_NF_SERVICE_DESCRIPTION || 'Serviços de cobrança e recuperação de crédito.',
      observations: ref ? `Ref ${ref}.` : 'Emissão avulsa.',
      value: valor,
      deductions: 0,
      effectiveDate: new Date().toISOString().slice(0, 10),
      taxes: {
        retainIss: String(process.env.ASAAS_NF_RETAIN_ISS || '').toLowerCase() === 'true',
        iss, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0,
      },
    };
    if (process.env.ASAAS_NF_MUNICIPAL_SERVICE_CODE) invoicePayload.municipalServiceCode = process.env.ASAAS_NF_MUNICIPAL_SERVICE_CODE;
    if (process.env.ASAAS_NF_MUNICIPAL_SERVICE_NAME) invoicePayload.municipalServiceName = process.env.ASAAS_NF_MUNICIPAL_SERVICE_NAME;

    // Cria e autoriza (emite de fato) a NFS-e.
    const invoice = await asaasReq('POST', '/invoices', invoicePayload);
    let authorized = invoice;
    try { authorized = await asaasReq('POST', `/invoices/${invoice.id}/authorize`, {}); }
    catch (e) { authorized = { ...invoice, _authorizeError: e.message }; }

    const nfUrl = authorized.pdfUrl || authorized.xmlUrl || invoice.pdfUrl || '';
    const nfStatus = authorized._authorizeError ? 'processando' : 'emitida';

    if (rowId) {
      await sbFetch(`nf_avulsa?id=eq.${rowId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          nf_status: nfStatus, nf_asaas_id: invoice.id || null, nf_url: nfUrl || null,
          metadata: { ...(ref ? { ref } : {}), nf_number: authorized.number || null },
        }),
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, nf_status: nfStatus, nf_id: invoice.id || null, nf_url: nfUrl || null, customer_id: customerId });
  } catch (e) {
    if (rowId) {
      await sbFetch(`nf_avulsa?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ nf_status: 'erro', erro: String(e.message || e).slice(0, 500) }) }).catch(() => {});
    }
    console.error('[emitir-nf-avulso]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
