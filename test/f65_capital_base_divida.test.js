// F-65 — o capital é a base do valor atualizado (migração 20261016c).
// Extrai _baseCapitalDivida do index.html real e trava a precedência:
// valor_capital/valorCapital → divida.valorCapital → valor_orig/valorOrig.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(sig){
  const i = src.indexOf(sig);
  if (i < 0) throw new Error('não achei ' + sig);
  let j = src.indexOf('{', i), depth = 0;
  for (let k = j; k < src.length; k++){
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('chaves desbalanceadas em ' + sig);
}
const _baseCapitalDivida = new Function(extract('function _baseCapitalDivida(d)') + '\nreturn _baseCapitalDivida;')();

let ran = 0, fail = 0;
function check(nome, cond){ ran++; if (!cond){ fail++; console.log('  ✗ ' + nome); } else console.log('  ✓ ' + nome); }

check('snake: capital vence valor_orig', _baseCapitalDivida({ valor_capital: 1000, valor_orig: 5400 }) === 1000);
check('snake: capital 0 é capital (não cai para valor_orig)', _baseCapitalDivida({ valor_capital: 0, valor_orig: 5400 }) === 0);
check('snake: sem capital usa divida.valorCapital', _baseCapitalDivida({ valor_capital: null, valor_orig: 10, divida: { valorCapital: 7 } }) === 7);
check('snake: sem capital nenhum cai para valor_orig', _baseCapitalDivida({ valor_capital: null, valor_orig: 10, divida: {} }) === 10);
check('camel: valorCapital vence valorOrig', _baseCapitalDivida({ valorCapital: '1000', valorOrig: '5.400,00' }) === '1000');
check('camel: sem capital cai para valorOrig', _baseCapitalDivida({ valorOrig: '5.400,00' }) === '5.400,00');
check('string vazia não conta como capital', _baseCapitalDivida({ valor_capital: '', valor_orig: 3 }) === 3);
check('nulo devolve null', _baseCapitalDivida(null) === null);

// dividaAtualHoje e _refrescarValorAtualHoje precisam ler a base pelo helper.
check('dividaAtualHoje usa _baseCapitalDivida', /function dividaAtualHoje\(d\)\{[\s\S]{0,120}_baseCapitalDivida\(d\)/.test(src));
check('_refrescarValorAtualHoje usa _baseCapitalDivida', /function _refrescarValorAtualHoje\(\)\{[\s\S]{0,200}_baseCapitalDivida\(obj\)/.test(src));
// O valor atualizado do formulário de cobrança é calculado, não digitado.
check('cobr-valor-atual é readonly', /<input id="cobr-valor-atual"[^>]*\breadonly\b/.test(src));

console.log(fail === 0 ? '\n✅ OK — todos os ' + ran + ' testes passaram.' : '\n❌ FALHOU — ' + fail + '/' + ran);
if (fail) process.exit(1);
