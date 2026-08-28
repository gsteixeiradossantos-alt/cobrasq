/*
 * Teste F-06 (Asaas) — o customer criado/atualizado leva nome, doc, endereço,
 * telefone e e-mail certos.
 *
 * Roda contra o CÓDIGO REAL (api/_asaas.js) com fetch e env mockados — nada sai
 * da máquina.
 *
 * Como rodar:
 *   node test/f06_asaas_customer.test.js
 *
 * Contexto (28/08/2026): a emissão do boleto mandava para o Asaas menos do que o
 * cadastro tinha. Três buracos, todos travados aqui:
 *   1. telefone/e-mail só iam na CRIAÇÃO do customer — quem já tinha customer
 *      nunca recebia o telefone descoberto depois (ex.: assinatura no ZapSign);
 *   2. o endereço digitado no PAINEL cai em devedores.metadata (devedorToRow não
 *      mapeia para coluna) e o builder não lia de lá → NFS-e sem endereço;
 *   3. telefone com DDI, com zero à esquerda ou com dois números no mesmo campo
 *      ia cru para o mobilePhone, que o Asaas não aceita.
 * E a trava do outro lado: NUNCA sobrescrever telefone/e-mail já preenchidos no
 * Asaas — lá pode ter sido corrigido por atendimento.
 */
'use strict';

const path = require('path');
const assert = require('assert');

process.env.ASAAS_API_KEY = 'chave-teste';
process.env.ASAAS_ENV = 'sandbox';

const { ensureAsaasCustomer, buildAsaasAddress, contatoFaltante, telAsaas } =
  require(path.join(__dirname, '..', 'api', '_asaas.js'));

let chamadas = [];
let rotas = {};
global.fetch = async (url, opts) => {
  const method = (opts && opts.method) || 'GET';
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  chamadas.push({ url: String(url), method, body });
  // chave da rota = "<METHOD> <trecho da URL>"
  const key = Object.keys(rotas).find((k) => {
    const [m, ...resto] = k.split(' ');
    return m === method && String(url).includes(resto.join(' '));
  });
  const resp = key ? rotas[key] : { ok: false, status: 404, payload: { errors: [{ description: 'rota não mockada: ' + method + ' ' + url }] } };
  return { ok: resp.ok !== false, status: resp.status || 200, text: async () => JSON.stringify(resp.payload || {}) };
};

let falhas = 0;
function ok(nome, cond, extra) {
  if (cond) { console.log('  ok  ' + nome); return; }
  falhas++; console.log('  FALHA ' + nome + (extra ? ' → ' + JSON.stringify(extra) : ''));
}
function eq(nome, got, esp) { ok(nome, JSON.stringify(got) === JSON.stringify(esp), { got, esp }); }

// ── 1. telAsaas: as sujeiras reais do cadastro ────────────────────────────────
console.log('1) telefone no formato do Asaas');
eq('local 11 dígitos passa', telAsaas('46999824142'), '46999824142');
eq('com DDI 55 perde o 55', telAsaas('5546999824142'), '46999824142');
eq('mascarado', telAsaas('(46) 99982-4142'), '46999824142');
eq('zero à esquerda', telAsaas('046999824142'), '46999824142');
eq('fixo 10 dígitos', telAsaas('4635241720'), '4635241720');
eq('dois números no campo → o primeiro', telAsaas('42984332184, 42991515679'), '42984332184');
eq('vazio', telAsaas(''), '');
eq('lixo', telAsaas('123'), '');

// ── 2. buildAsaasAddress: as três moradas do endereço ─────────────────────────
console.log('2) endereço vem das três moradas');
eq('colunas + endereco_crm',
  buildAsaasAddress({ cep: '85660-000', numero: '380', endereco_crm: { rua: 'Av. Rio Grande do Sul', bairro: 'Centro' } }),
  { postalCode: '85660000', address: 'Av. Rio Grande do Sul', addressNumber: '380', province: 'Centro' });
eq('endereço digitado no painel (metadata)',
  buildAsaasAddress({ metadata: { cep: '85660-000', rua: 'Rua XV', numero: '10', bairro: 'Centro', complemento: 'sala 2' } }),
  { postalCode: '85660000', address: 'Rua XV', addressNumber: '10', complement: 'sala 2', province: 'Centro' });
eq('coluna rua (era ignorada)', buildAsaasAddress({ rua: 'Rua da Coluna' }), { address: 'Rua da Coluna' });
eq('metadata.enderecoCrm camelCase do blob',
  buildAsaasAddress({ metadata: { enderecoCrm: { rua: 'Rua do Blob', cep: '85660000' } } }),
  { postalCode: '85660000', address: 'Rua do Blob' });
eq('endereco_crm vence o metadata',
  buildAsaasAddress({ endereco_crm: { rua: 'Rua Boa' }, metadata: { rua: 'Rua Velha' } }), { address: 'Rua Boa' });
eq('sem endereço nenhum', buildAsaasAddress({ nome: 'X' }), {});

// ── 3. contatoFaltante: só preenche buraco ────────────────────────────────────
console.log('3) contato só preenche o que falta no Asaas');
eq('Asaas sem telefone → preenche',
  contatoFaltante({ email: 'ja@tem.com' }, { telefone: '5546999824142', email: 'novo@mail.com' }),
  { mobilePhone: '46999824142' });
eq('Asaas com mobilePhone → não toca',
  contatoFaltante({ mobilePhone: '46988887777' }, { telefone: '46999824142' }), {});
eq('Asaas com phone fixo → também não toca',
  contatoFaltante({ phone: '4635241720' }, { telefone: '46999824142' }), {});
eq('e-mail inválido não entra', contatoFaltante({}, { email: 'nao-eh-email' }), {});
eq('nada nos dois lados', contatoFaltante({}, {}), {});

// ── 4. ensureAsaasCustomer: os três caminhos ──────────────────────────────────
(async () => {
  console.log('4) ensureAsaasCustomer');

  // 4a. customer já vinculado, sem telefone no Asaas → PUT leva endereço E telefone
  chamadas = [];
  rotas = {
    'GET /customers/cus_1': { payload: { id: 'cus_1', name: 'Fulano', email: null, mobilePhone: null } },
    'PUT /customers/cus_1': { payload: { id: 'cus_1' } },
  };
  let r = await ensureAsaasCustomer({
    asaas_customer_id: 'cus_1', nome: 'Fulano', doc: '04370149916',
    telefone: '5546999824142', email: 'Fulano@Mail.com',
    metadata: { cep: '85660-000', rua: 'Rua XV', numero: '10' },
  });
  const put = chamadas.find((c) => c.method === 'PUT');
  eq('4a: id preservado', r.customerId, 'cus_1');
  eq('4a: não criou', r.created, false);
  eq('4a: PUT com endereço + contato', put && put.body,
    { postalCode: '85660000', address: 'Rua XV', addressNumber: '10', mobilePhone: '46999824142', email: 'fulano@mail.com' });

  // 4b. customer já vinculado e JÁ com telefone → PUT não sobrescreve
  chamadas = [];
  rotas = {
    'GET /customers/cus_2': { payload: { id: 'cus_2', email: 'certo@mail.com', mobilePhone: '46988887777' } },
    'PUT /customers/cus_2': { payload: { id: 'cus_2' } },
  };
  await ensureAsaasCustomer({ asaas_customer_id: 'cus_2', telefone: '46999824142', email: 'outro@mail.com', metadata: { cep: '85660000' } });
  const put2 = chamadas.find((c) => c.method === 'PUT');
  eq('4b: PUT só com endereço', put2 && put2.body, { postalCode: '85660000' });

  // 4c. GET do customer falha → manda só o endereço (não chuta contato)
  chamadas = [];
  rotas = { 'PUT /customers/cus_3': { payload: { id: 'cus_3' } } };  // GET não mockado = 404
  await ensureAsaasCustomer({ asaas_customer_id: 'cus_3', telefone: '46999824142', metadata: { cep: '85660000' } });
  const put3 = chamadas.find((c) => c.method === 'PUT');
  eq('4c: sem leitura, só endereço', put3 && put3.body, { postalCode: '85660000' });

  // 4d. customer inexistente → POST com tudo
  chamadas = [];
  rotas = {
    'GET /customers?cpfCnpj=': { payload: { data: [] } },
    'POST /customers': { payload: { id: 'cus_novo' } },
  };
  r = await ensureAsaasCustomer({
    nome: 'Nova Empresa Ltda', doc: '64.466.919/0001-58', telefone: '(46) 3524-1720',
    email: 'contato@empresa.com', endereco_crm: { rua: 'Av. Brasil', bairro: 'Centro' },
  });
  const post = chamadas.find((c) => c.method === 'POST');
  eq('4d: criou', r.created, true);
  eq('4d: POST completo', post && post.body, {
    name: 'Nova Empresa Ltda', cpfCnpj: '64466919000158', email: 'contato@empresa.com',
    mobilePhone: '4635241720', address: 'Av. Brasil', province: 'Centro', notificationDisabled: true,
  });

  // 4e. sem CPF/CNPJ → erro explícito (a emissão não pode seguir)
  let erro = null;
  try { await ensureAsaasCustomer({ nome: 'Sem Doc' }); } catch (e) { erro = e.message; }
  eq('4e: exige documento', erro, 'Devedor sem CPF/CNPJ cadastrado.');

  console.log(falhas ? '\nF-06: ' + falhas + ' FALHA(S).' : '\nF-06: todos passaram.');
  process.exit(falhas ? 1 : 0);
})();
