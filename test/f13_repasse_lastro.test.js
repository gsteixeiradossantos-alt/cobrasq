/*
 * Teste F-13 — o "↗ a repassar" só acende com o dinheiro em caixa.
 *
 * Em 31/08/2026 a aba Movimentações acendia o marcador de repasse em saída que ainda não
 * era devida. O caso: Leonardo dos Santos Fortes, saída de R$ 500,00 ao Odontomundi com
 * vencimento em 10/10, com a receita que ela repassa — a parcela 15/15, mesmo 10/10 —
 * ainda em aberto. Não havia o que repassar. Eram 323 saídas futuras, R$ 141.657,43,
 * todas acesas: o chip "A repassar" contava dinheiro fora do caixa.
 *
 * Quem responde "a entrada dela caiu?" é `_finRepasseLiberado()`, que o Painel e
 * Recebíveis já consomem. Este teste tranca as DUAS coisas que a integração pode quebrar:
 *
 *  1. o portão respeitar o escopo — só opina sobre despesa de repasse em aberto, que é o
 *     universo que aquela função apura. Opinar fora dele apagaria o marcador de linha que
 *     ela nunca examinou;
 *  2. "não sei" continuar sendo "não sei" — apuração falha mantém o comportamento antigo.
 *     Das duas formas de errar, esconder repasse devido some dinheiro do credor da tela;
 *     acender cedo demais só antecipa uma linha.
 *
 * Como rodar:
 *   node test/f13_repasse_lastro.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// As funções são curtas e sem template literal — recorte simples até o fim indicado.
// `fim` é '\n}' para função e '\n' para const de uma linha (o helper _finEhTarifa).
function recorta(marca, fim) {
  fim = fim || '\n}';
  const i = HTML.indexOf(marca);
  assert.ok(i >= 0, `não achei no index.html: ${marca}`);
  const j = HTML.indexOf(fim, i + marca.length);
  assert.ok(j > i, `não achei o fim de ${marca}`);
  return HTML.slice(i, j + fim.length);
}

const ctxVm = {};
vm.createContext(ctxVm);
vm.runInContext(
  // `_finEhTarifa` (F-18) é usado por _finLancEhRepasse e pelo escopo do lastro.
  recorta('const _finEhTarifa', '\n') + '\n'
  + recorta('function _finRepasseTemLastroApuravel(l){') + '\n'
  + recorta('const _finLancQuitado', '\n') + '\n'
  + recorta('function _finLancEhRepasse(l, ctx){') + '\n'
  + 'this._finLancEhRepasse = _finLancEhRepasse;'
  + 'this._finRepasseTemLastroApuravel = _finRepasseTemLastroApuravel;',
  ctxVm
);
const ehRepasse = ctxVm._finLancEhRepasse;
const apuravel = ctxVm._finRepasseTemLastroApuravel;

// A saída do Leonardo: repasse em aberto, com credor. `credorPorLanc` preenchido é o que
// fazia a seta acender antes — sem ele o teste passaria por acidente.
const SAIDA = { id: 124879, tipo_movimento: 0, status: 0, credor_id: 'odonto',
                descricao: 'Leonardo dos Santos Fortes' };
const base = { opsByLanc: {}, credorPorLanc: { 124879: 'Clínica Odontológica Balvedi Ltda Odontomundi' } };
const com = (liberadas) => Object.assign({}, base, { liberadas });

// ── O portão ────────────────────────────────────────────────────────────────────────
// 1) A entrada dela não caiu (não está no conjunto) → não há o que repassar.
assert.strictEqual(ehRepasse(SAIDA, com(new Set())), false,
  'saída cuja entrada não caiu NÃO pode contar como "a repassar"');

// 2) Liberada → volta a acender. É o dia em que o repasse vira devido.
assert.strictEqual(ehRepasse(SAIDA, com(new Set([124879]))), true,
  'liberada pela entrada, o repasse é devido e tem de acender');

// ── "Não sei" nunca vira "sem lastro" ──────────────────────────────────────────────
// 3) A apuração falhou (ctx.liberadas nulo): comportamento antigo, sem regressão.
assert.strictEqual(ehRepasse(SAIDA, com(null)), true,
  'apuração indisponível mantém o comportamento anterior');
// 4) E um ctx antigo, que nem traz o campo, não pode explodir.
assert.strictEqual(ehRepasse(SAIDA, base), true, 'ctx sem `liberadas` segue o caminho antigo');

// ── Escopo: o portão só opina sobre o que aquela função examina ────────────────────
// _finRepasseLiberado() varre saída em aberto, com credor, que não seja tarifa. Fora
// disso o id JAMAIS estaria no conjunto — e sem esta guarda o portão apagaria o marcador
// de toda linha que ela nunca olhou.
// Cada linha fora do escopo acende pelo caminho ANTIGO (tem cedente em credorPorLanc) e
// NÃO está no conjunto de liberadas. Assim, um `false` aqui só pode ter vindo do portão
// — sem esse cuidado o teste passaria por acidente, com o `false` vindo de outra origem.
const fora = (l) => ehRepasse(l, { opsByLanc: {}, liberadas: new Set(),
                                   credorPorLanc: { [l.id]: 'Cedente Qualquer' } });
// A receita acende pela PRIMEIRA origem (operação de repasse pendente), não pelo mapa de
// credor: desde 31/08 aquele mapa vale só para saídas — ele passou a cobrir também as
// receitas, para a sublinha dizer a carteira, e sem o filtro toda entrada com cobrança
// viraria "a repassar" (ver F-17). O que este caso prova continua o mesmo: o portão do
// lastro não opina fora do universo que _finRepasseLiberado() apura.
// A RECEITA saiu deste conjunto em 31/08 (F-20): desde então ela não acende por caminho
// nenhum — nem pela operação —, então não serve mais para provar que o portão do lastro
// se cala. Quem cobre receita é o F-20. Aqui fica a saída JÁ PAGA, que continua fora do
// universo apurado e continua acendendo pela operação.
// A saída JÁ PAGA saiu deste conjunto em 31/08 (F-23): repasse que já saiu nunca é "a
// repassar", por origem nenhuma. Ela continua fora do universo do lastro — o que este
// bloco prova —, mas agora o `false` vem da quitação, não do portão. A checagem de escopo
// que sobra é a de `apuravel`, logo abaixo.
assert.strictEqual(apuravel({ tipo_movimento: 0, status: 1, credor_id: 'x', descricao: 'repasse já pago' }),
  false, 'saída já paga está fora do universo que o lastro apura');
// (a saída já paga é tratada acima, por `apuravel`: desde o F-23 ela nem chega às origens)
assert.strictEqual(fora({ id: 3, tipo_movimento: 0, status: 0, credor_id: null, descricao: 'saída sem credor' }),
  true, 'saída sem credor está fora do universo apurado');
// A TARIFA saiu deste conjunto em 31/08 (F-18): ela deixou de acender por completo — não
// é repasse ao cedente, e a exclusão agora vale também na terceira origem. Como ela não
// acende por nenhum caminho, não serve mais para provar que o portão do lastro se cala.
// Quem cobre tarifa é o F-18; aqui fica só a checagem de escopo, logo abaixo.
assert.strictEqual(apuravel({ tipo_movimento: 0, status: 0, credor_id: 'x', descricao: 'Tarifa Asaas (Pix) — Fulano' }),
  false, 'tarifa continua fora do universo que o lastro apura');
// E a prova de que o fixture não é frouxo: DENTRO do escopo, o mesmo arranjo dá false.
assert.strictEqual(fora({ id: 5, tipo_movimento: 0, status: 0, credor_id: 'x', descricao: 'repasse a fulano' }),
  false, 'dentro do escopo o portão precisa mesmo barrar — senão o teste acima não prova nada');

// O escopo, direto:
assert.strictEqual(apuravel(SAIDA), true);
assert.strictEqual(apuravel({ tipo_movimento: 0, status: 0, credor_id: 'x', descricao: 'TARIFA asaas' }), false,
  'o corte de tarifa não pode ser sensível a maiúscula');

// ── A regra antiga continua valendo ─────────────────────────────────────────────────
assert.strictEqual(
  ehRepasse({ id: 7, tipo_movimento: 0, status: 0, credor_id: 'x', descricao: 'r' },
            { opsByLanc: { 7: { repasse_status: 'pendente' } }, credorPorLanc: {}, liberadas: new Set([7]) }),
  true, 'operação pendente e liberada continua sendo "a repassar"');
assert.strictEqual(
  ehRepasse({ id: 8, tipo_movimento: 0, status: 0, credor_id: 'x', descricao: 'r' },
            { opsByLanc: { 8: { repasse_status: 'efetuado' } }, credorPorLanc: {}, liberadas: new Set([8]) }),
  false, 'operação efetuada não conta');

// ── O portão precisa vir ANTES das três origens ────────────────────────────────────
const fonte = recorta('function _finLancEhRepasse(l, ctx){');
assert.ok(fonte.indexOf('ctx.liberadas') < fonte.indexOf('ctx.opsByLanc'),
  'a checagem de lastro tem de preceder as origens, senão a operação decide antes');

// ── Fonte única: a aba não pode reimplementar o pareamento ─────────────────────────
// Uma segunda resposta para "esta saída tem lastro?" é como quase todo defeito deste
// módulo começou — e só _finRepasseLiberado() consome a entrada (caso Valdair: três
// despesas apontando um boleto só de R$ 214,00).
assert.ok(/liberadas\s*=\s*new Set\(\(lib\.itens\|\|\[\]\)\.map/.test(HTML)
       && HTML.includes('const lib = await _finRepasseLiberado();'),
  'a aba tem de consumir _finRepasseLiberado(), não parear por conta própria');

console.log('F-13 ok — o ↗ só acende com o dinheiro em caixa, pela fonte que já existia.');
