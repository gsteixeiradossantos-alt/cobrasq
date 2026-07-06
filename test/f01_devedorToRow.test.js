/*
 * Teste F-01 — devedorToRow não deve "zerar" campos que o CRM também grava.
 *
 * Roda contra o CÓDIGO REAL: extrai a função devedorToRow (e suas dependências
 * _DEV_COL_FIELDS / _devNumOrNull) direto do index.html e avalia. Sem build.
 *
 * Como rodar (qualquer um):
 *   jsc  test/f01_devedorToRow.test.js              (macOS JavaScriptCore)
 *   node test/f01_devedorToRow.test.js              (se houver Node)
 * Opcional: passar o caminho do index.html como 1º argumento.
 *
 * Contexto: o dual-write do faturamento faz upsert do array inteiro a cada save.
 * Enviar assigned_to/passo_atual/etc. = null (valor velho de uma aba) sobrescrevia
 * o que o CRM/backfill gravou (last-write-wins). O fix: só assertar esses campos
 * quando há valor. Este teste trava esse comportamento contra regressão.
 */
'use strict';

// ---- print/exit portáveis (jsc usa print; node usa console.log/process) ----
var LOG = (typeof print === 'function') ? print : console.log;
function done(failures){
  LOG(failures === 0
    ? '\n✅ OK — todos os ' + RAN + ' testes passaram.'
    : '\n❌ FALHOU — ' + failures + '/' + RAN + ' teste(s).');
  if (failures > 0) {
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
    throw new Error('F-01 test failures: ' + failures);
  }
}

// ---- leitura de arquivo portável ----
function readSource(path){
  if (typeof readFile === 'function') return readFile(path);           // jsc
  if (typeof read === 'function')     return read(path);               // jsc (alt)
  return require('fs').readFileSync(path, 'utf8');                      // node
}

// ---- extrai um trecho por assinatura + balanceamento de chaves ----
function extractBalanced(src, signature){
  var start = src.indexOf(signature);
  if (start < 0) throw new Error('não achei a assinatura: ' + signature);
  var i = src.indexOf('{', start);
  if (i < 0) throw new Error('sem { após: ' + signature);
  var depth = 0;
  for (var j = i; j < src.length; j++){
    var c = src[j];
    if (c === '{') depth++;
    else if (c === '}'){ depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('chaves desbalanceadas em: ' + signature);
}
function extractDelimited(src, startToken, endToken){
  var s = src.indexOf(startToken);
  if (s < 0) throw new Error('não achei: ' + startToken);
  var e = src.indexOf(endToken, s);
  if (e < 0) throw new Error('não achei fim: ' + endToken);
  return src.slice(s, e + endToken.length);
}

// Node injeta um `arguments` próprio (objetos do wrapper CommonJS) — por isso
// process.argv vem primeiro e o `arguments` do jsc só vale se for string.
var PATH = (typeof process !== 'undefined' && process.argv && process.argv[2]) ? process.argv[2]
         : (typeof arguments !== 'undefined' && arguments.length && typeof arguments[0] === 'string') ? arguments[0]
         : 'index.html';

var SRC = readSource(PATH);

// Dependências que devedorToRow usa:
var setSrc  = extractDelimited(SRC, 'const _DEV_COL_FIELDS = new Set([', ']);');
var numSrc  = extractBalanced(SRC, 'function _devNumOrNull(');
var rowSrc  = extractBalanced(SRC, 'function devedorToRow(');

// Sandbox: stub de parseValorBR (não exercitado aqui) + as funções reais.
var harness =
  'var parseValorBR = function(v){ var n = parseFloat(String(v).replace(/[^0-9.-]/g,"")); return isFinite(n)?n:NaN; };\n' +
  setSrc + '\n' + numSrc + '\n' + rowSrc + '\n' +
  'this.__devedorToRow = devedorToRow;';
(0, eval)(harness);
// No Node CJS, `this` é module.exports (não o global onde o eval gravou).
var devedorToRow = (typeof globalThis !== 'undefined') ? globalThis.__devedorToRow : this.__devedorToRow;

// ---------------------------- asserções ----------------------------
var RAN = 0, FAIL = 0;
function check(name, cond){
  RAN++;
  if (cond) { LOG('  ✓ ' + name); }
  else { FAIL++; LOG('  ✗ ' + name); }
}
var has = function(o,k){ return Object.prototype.hasOwnProperty.call(o,k); };

var GESTOR = '4fc57db2-4ecf-4021-81f3-c30004e708b8';

// 1) Com valor → o campo É enviado.
var r1 = devedorToRow({ id:'d1', nome:'X', assignedTo: GESTOR });
check('assigned_to presente quando há UUID', has(r1,'assigned_to') && r1.assigned_to === GESTOR);

// 2) Nulo/vazio → o campo NÃO é enviado (preserva o do banco/CRM).
var r2 = devedorToRow({ id:'d2', nome:'X', assignedTo: null });
check('assigned_to OMITIDO quando null', !has(r2,'assigned_to'));
var r3 = devedorToRow({ id:'d3', nome:'X', assignedTo: '' });
check('assigned_to OMITIDO quando string vazia', !has(r3,'assigned_to'));
var r4 = devedorToRow({ id:'d4', nome:'X' }); // undefined
check('assigned_to OMITIDO quando ausente', !has(r4,'assigned_to'));

// 2b) cliente_id (credor) — MESMA proteção do assigned_to (R-15): uma aba velha com
// clienteId vazio NÃO pode zerar o vínculo no banco (some da contagem em Clientes E da
// visão do cedente, cuja RLS filtra por devedores.cliente_id).
var rc = devedorToRow({ id:'c1', nome:'X', clienteId: GESTOR });
check('cliente_id presente quando há valor', has(rc,'cliente_id') && rc.cliente_id === GESTOR);
check('cliente_id OMITIDO quando string vazia', !has(devedorToRow({ id:'c2', nome:'X', clienteId:'' }),'cliente_id'));
check('cliente_id OMITIDO quando ausente', !has(r4,'cliente_id'));

// 3) Campos 100% do CRM: omitidos quando vazios, enviados quando há valor.
check('passo_atual OMITIDO quando vazio', !has(r4,'passo_atual'));
check('encerramento OMITIDO quando vazio', !has(r4,'encerramento'));
check('acordo_final OMITIDO quando vazio', !has(r4,'acordo_final'));
check('encaminhamento_judicial OMITIDO quando vazio', !has(r4,'encaminhamento_judicial'));
// FASE C2 (tempo-2): status/funil/dívida NÃO são mais gravados no devedor (vivem só
// em `cobrancas`). devedorToRow NÃO deve emiti-los, mesmo presentes no objeto.
var r5 = devedorToRow({ id:'d5', nome:'X', passoAtual:'negociacao', encerramento:'2026-06-10',
                        acordoFinal:{x:1}, encaminhamentoJudicial:'sim',
                        status:'Acordo', fase:'judicial', valorOrig:'1.000,00', tipoCobranca:'fisica' });
check('passo_atual NÃO emitido (tempo-2)', !has(r5,'passo_atual'));
check('encerramento NÃO emitido (tempo-2)', !has(r5,'encerramento'));
check('acordo_final NÃO emitido (tempo-2)', !has(r5,'acordo_final'));
check('encaminhamento_judicial NÃO emitido (tempo-2)', !has(r5,'encaminhamento_judicial'));
check('status NÃO emitido (tempo-2)', !has(r5,'status'));
check('fase NÃO emitida (tempo-2)', !has(r5,'fase'));
check('valor_orig NÃO emitido (tempo-2)', !has(r5,'valor_orig'));
check('tipo_cobranca NÃO emitido (tempo-2)', !has(r5,'tipo_cobranca'));

// 4) Campos sempre presentes (não-CRM) continuam saindo no row, inclusive vazios.
check('id sempre presente', has(r4,'id') && r4.id === 'd4');
check('nome sempre presente', has(r4,'nome'));
check('telefone (pessoa) sempre presente', has(r4,'telefone'));
check('arquivado sempre presente (booleano)', has(r4,'arquivado') && r4.arquivado === false);
// FASE C2 (tempo-2): a dívida não é mais emitida no row do devedor.
check('status já NÃO sai no row', !has(r4,'status'));
check('fase já NÃO sai no row', !has(r4,'fase'));
check('divida já NÃO sai no row', !has(r4,'divida'));

done(FAIL);
