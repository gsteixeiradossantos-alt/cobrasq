/*
 * Teste F-55 — CPF/CNPJ formatado na qualificação dos termos de acordo.
 *
 * O caso: em 30/09/2026 a minuta saiu com "inscrito no CPF sob. n. 02433555990" —
 * o cadastro guarda só os dígitos e o termo-engine colava o valor cru. O texto do
 * termo tem que trazer o documento com pontos e hífen ("024.335.559-90").
 *
 * Como rodar:
 *   node test/f55_termo_cpf_formatado.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');
require(path.join(__dirname, '..', 'templates', 'termo-engine.js'));
const E = globalThis.TermoEngine;

const pf = E.qualifDevedor({ tipo: 'PF', genero: 'M', documento: '02433555990' });
assert.ok(pf.includes('024.335.559-90'), pf);

const pj = E.qualifDevedor({ tipo: 'PJ', documento: '34626848000142' });
assert.ok(pj.includes('34.626.848/0001-42'), pj);

// já formatado não é mexido; documento ausente não gera lixo
assert.ok(E.qualifDevedor({ tipo: 'PF', genero: 'F', documento: '024.335.559-90' }).includes('024.335.559-90'));
assert.ok(!/undefined|null/.test(E.qualifDevedor({ tipo: 'PF', genero: 'F' })));

const cr = E.qualifCredor({ documento: '34626848000142' });
assert.ok(cr.includes('34.626.848/0001-42'), cr);

console.log('f55 ok — CPF/CNPJ formatado na qualificação dos termos');
