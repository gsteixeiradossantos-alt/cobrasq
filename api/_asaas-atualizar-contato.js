// api/_asaas-atualizar-contato.js — Corrige o CONTATO (telefone/e-mail) de um customer
// no Asaas. Despachado por api/automacao.js (?action=asaas-atualizar-contato).
// Owner-only. Prefixo "_": não conta no limite de 12 funções do plano Hobby.
//
// Por que existe: `sincronizarCustomer` (api/_asaas.js) só preenche BURACO —
// `contatoFaltante` ignora o telefone quando já há um lá, porque o cadastro daqui é o
// lado sujo. Isso é certo no caso geral e errado quando o número gravado é de OUTRA
// PESSOA: aí não há buraco para preencher e nada corrige.
//
// O caso que motivou (09/09/2026): o cadastro do Robson Ribeiro da Silva tinha
// 5546999189842, número de um terceiro. A régua mandou para lá 4 blocos em 07/09 e 4 em
// 09/09, com nome, valor de R$ 500,00 e link do boleto — até a pessoa responder pedindo
// que as mensagens fossem para o número particular dele. Corrigir só no Supabase não
// resolve: bia-cobranca-sync reescreve `bia_cobranca.telefone` a cada 30 min com o
// mobilePhone do Asaas, e a proteção do #673 só preserva o MESMO assinante em outro
// formato — número trocado é sobrescrito, como deve ser.
//
// Uso (a partir do painel logado, sessão de proprietário):
//   POST /api/automacao?action=asaas-atualizar-contato
//   { "customerId": "cus_000...", "mobilePhone": "46999361140" }
// Alternativas a customerId: "devedorId" (usa devedores.asaas_customer_id) ou
// "cpfCnpj" (procura o customer pelo documento). Dry-run: ?dry=1 mostra o antes/depois
// sem gravar.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { asaasReq, telAsaas } = require('./_asaas.js');

const digits = (s) => String(s || '').replace(/\D/g, '');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const user = await requireUser(req, res);
  if (!user) return;

  // Trocar contato de cliente mexe em para onde a cobrança é enviada — mesmo gate do
  // backfill: só o proprietário.
  let papel = null;
  try {
    const rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel`);
    papel = Array.isArray(rows) && rows[0] ? rows[0].papel : null;
  } catch (e) {
    return res.status(500).json({ error: 'Não foi possível verificar permissão.' });
  }
  if (papel !== 'proprietario') {
    return res.status(403).json({ error: 'Apenas o proprietário pode alterar contato no Asaas.' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const dry = req.query?.dry === '1' || req.query?.dry === 'true';
  const { devedorId, cpfCnpj, mobilePhone, phone, email } = body;
  let customerId = body.customerId || '';

  if (!mobilePhone && !phone && !email) {
    return res.status(400).json({ error: 'Informe ao menos mobilePhone, phone ou email.' });
  }

  // O Asaas guarda telefone brasileiro sem DDI; telAsaas devolve DDD + número e já
  // trata as sujeiras do cadastro (DDI, zero à esquerda, vários números no campo).
  const novoMobile = mobilePhone ? telAsaas(mobilePhone) : '';
  if (mobilePhone && !novoMobile) {
    return res.status(400).json({ error: `mobilePhone inválido: "${mobilePhone}". Esperado DDD + número.` });
  }
  const novoPhone = phone ? telAsaas(phone) : '';
  if (phone && !novoPhone) {
    return res.status(400).json({ error: `phone inválido: "${phone}". Esperado DDD + número.` });
  }
  if (email && !/.+@.+\..+/.test(String(email))) {
    return res.status(400).json({ error: `email inválido: "${email}".` });
  }

  try {
    // 1. Resolver o customer.
    if (!customerId && devedorId) {
      const rows = await sbFetch(`devedores?id=eq.${encodeURIComponent(devedorId)}&select=asaas_customer_id,nome`);
      customerId = (Array.isArray(rows) && rows[0] && rows[0].asaas_customer_id) || '';
      if (!customerId) {
        return res.status(404).json({ error: 'Devedor sem asaas_customer_id. Informe customerId ou cpfCnpj.' });
      }
    }
    if (!customerId && cpfCnpj) {
      const doc = digits(cpfCnpj);
      const r = await asaasReq('GET', `/customers?cpfCnpj=${encodeURIComponent(doc)}&limit=10`);
      const list = Array.isArray(r && r.data) ? r.data : [];
      if (!list.length) return res.status(404).json({ error: `Nenhum customer no Asaas com o documento ${doc}.` });
      // Mais de um customer para o mesmo documento é ambíguo: alterar o errado manda a
      // cobrança para outro lugar. Devolve os ids para quem chama escolher.
      if (list.length > 1) {
        return res.status(409).json({
          error: `${list.length} customers com o documento ${doc}. Informe customerId.`,
          candidatos: list.map((c) => ({ id: c.id, name: c.name, mobilePhone: c.mobilePhone, phone: c.phone })),
        });
      }
      customerId = list[0].id;
    }
    if (!customerId) return res.status(400).json({ error: 'Informe customerId, devedorId ou cpfCnpj.' });

    // 2. Ler o estado atual — é o que dá o "antes" na resposta e prova que o id existe.
    let atual;
    try {
      atual = await asaasReq('GET', `/customers/${customerId}`);
    } catch (e) {
      return res.status(404).json({ error: `Customer ${customerId} não encontrado no Asaas: ${e.message}` });
    }

    const payload = {};
    if (novoMobile && telAsaas(atual.mobilePhone) !== novoMobile) payload.mobilePhone = novoMobile;
    if (novoPhone && telAsaas(atual.phone) !== novoPhone) payload.phone = novoPhone;
    if (email && String(atual.email || '').toLowerCase() !== String(email).toLowerCase()) payload.email = String(email).toLowerCase();

    const antes = { mobilePhone: atual.mobilePhone || null, phone: atual.phone || null, email: atual.email || null };
    if (!Object.keys(payload).length) {
      return res.status(200).json({ ok: true, customerId, nome: atual.name, alterado: false, motivo: 'contato já está como pedido', antes });
    }
    if (dry) {
      return res.status(200).json({ ok: true, dry: true, customerId, nome: atual.name, antes, seria_gravado: payload });
    }

    await asaasReq('PUT', `/customers/${customerId}`, payload);
    const depois = await asaasReq('GET', `/customers/${customerId}`);

    return res.status(200).json({
      ok: true,
      customerId,
      nome: depois.name,
      alterado: true,
      antes,
      depois: { mobilePhone: depois.mobilePhone || null, phone: depois.phone || null, email: depois.email || null },
      campos: Object.keys(payload),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao atualizar contato no Asaas: ' + (e && e.message) });
  }
};
