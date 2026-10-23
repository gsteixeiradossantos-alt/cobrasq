/* Faixa com vencimento próprio: o termo cita a data de cada faixa.
 * Rodar: node test/f66_faixa_vencimento_proprio.test.js */
'use strict';
const path = require('path'); const assert = require('assert');
require(path.join(__dirname, '..', 'templates', 'termo-engine.js'));
const { frasePagamento } = globalThis.TermoEngine;
let falhas = 0;
function checa(n, fn){ try{ fn(); console.log('  ok   '+n); }catch(e){ falhas++; console.log('  FALHA '+n+'\n        '+e.message); } }
const base = { total: 3300, parcelas: 6, valorParcela: 300, vencimento: '2026-11-10', multa: 10, penal: 50 };
checa('sem data própria, frase sem citação de faixa', () => {
  const f = frasePagamento({ ...base, faixas: [{ qtd: 1, valor: 300 }, { qtd: 5, valor: 600 }] });
  assert(!/ª faixa/.test(f), f);
});
checa('faixa 2 com data própria é citada', () => {
  const f = frasePagamento({ ...base, faixas: [{ qtd: 1, valor: 300 }, { qtd: 5, valor: 600, venc: '2027-01-20' }] });
  assert(/2ª faixa \(5x de/.test(f) && /2027/.test(f), f);
});
checa('data na 1ª faixa é ignorada', () => {
  const f = frasePagamento({ ...base, faixas: [{ qtd: 1, valor: 300, venc: '2030-01-01' }, { qtd: 5, valor: 600 }] });
  assert(!/2030/.test(f), f);
});
if (falhas) process.exit(1); console.log('tudo ok');
