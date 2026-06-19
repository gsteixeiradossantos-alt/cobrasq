/*
 * Teste F-03 (FASE C) — regra N:N DividaDevedor (cobranca_partes):
 *   • garantirUmPrincipal: exatamente UM principal por dívida (espelha o índice
 *     único uq_cobranca_partes_principal no banco).
 *   • escolherDevedorExistente: deduplicação — reusa um Devedor por CPF/CNPJ
 *     (ignorando máscara), depois por nome; senão null (= cadastra novo na hora).
 *
 * Roda contra o CÓDIGO REAL (extrai funções do index.html). Sem build.
 *   node test/f03_partes_nn.test.js   (ou jsc ...)
 */
'use strict';
var LOG = (typeof print === 'function') ? print : console.log;
function readSource(p){
  if (typeof readFile === 'function') return readFile(p);
  if (typeof read === 'function') return read(p);
  return require('fs').readFileSync(p, 'utf8');
}
function extractBalanced(src, sig){
  var start = src.indexOf(sig); if (start < 0) throw new Error('não achei: ' + sig);
  var i = src.indexOf('{', start), depth = 0;
  for (var j = i; j < src.length; j++){
    var c = src[j];
    if (c === '{') depth++;
    else if (c === '}'){ depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('chaves desbalanceadas: ' + sig);
}
var PATH = (typeof process !== 'undefined' && process.argv && process.argv[2]) ? process.argv[2]
         : (typeof arguments !== 'undefined' && arguments.length && typeof arguments[0] === 'string') ? arguments[0]
         : 'index.html';
var SRC = readSource(PATH);

var docSrc  = extractBalanced(SRC, 'function docSoDigitos(');
var prinSrc = extractBalanced(SRC, 'function garantirUmPrincipal(');
var escSrc  = extractBalanced(SRC, 'function escolherDevedorExistente(');

var harness = docSrc + '\n' + prinSrc + '\n' + escSrc + '\n' +
  'this.__p = garantirUmPrincipal; this.__e = escolherDevedorExistente;';
(0, eval)(harness);
var garantirUmPrincipal = (typeof globalThis !== 'undefined') ? globalThis.__p : this.__p;
var escolherDevedorExistente = (typeof globalThis !== 'undefined') ? globalThis.__e : this.__e;

var RAN = 0, FAIL = 0;
function check(n, c){ RAN++; if (c) { LOG('  ✓ ' + n); } else { FAIL++; LOG('  ✗ ' + n); } }
function nPrinc(a){ return a.filter(function(x){ return x.principal; }).length; }

// ── Exatamente um principal ──────────────────────────────────────────────────
var a1 = [{nome:'A',principal:false},{nome:'B',principal:false}];
garantirUmPrincipal(a1);
check('0 principal → 1º vira principal', nPrinc(a1) === 1 && a1[0].principal === true);

var a2 = [{nome:'A',principal:false},{nome:'B',principal:true}];
garantirUmPrincipal(a2);
check('1 principal mantém', nPrinc(a2) === 1 && a2[1].principal === true);

var a3 = [{nome:'A',principal:true},{nome:'B',principal:true},{nome:'C',principal:true}];
garantirUmPrincipal(a3);
check('2+ principais → colapsa p/ 1 (1º vence)', nPrinc(a3) === 1 && a3[0].principal === true);

check('lista vazia não quebra', Array.isArray(garantirUmPrincipal([])));

// ── Deduplicação por documento (depois por nome) ─────────────────────────────
var devs = [
  {id:'d1', nome:'João Souza', doc:'111.222.333-44'},
  {id:'d2', nome:'Maria',      doc:'55667788000199'}
];
check('acha por CPF (mascarado)', (escolherDevedorExistente(devs,'qualquer','11122233344')||{}).id === 'd1');
check('acha por CNPJ (mascarado)', (escolherDevedorExistente(devs,'x','55.667.788/0001-99')||{}).id === 'd2');
check('acha por nome quando sem doc', (escolherDevedorExistente(devs,'maria','')||{}).id === 'd2');
check('doc tem prioridade sobre nome', (escolherDevedorExistente(devs,'Maria','11122233344')||{}).id === 'd1');
check('não acha → null (cadastra novo)', escolherDevedorExistente(devs,'Fulano','99999999999') === null);

LOG(FAIL === 0 ? '\n✅ F-03 OK — ' + RAN + ' testes.' : '\n❌ F-03 FALHOU — ' + FAIL + '/' + RAN);
if (FAIL > 0) { if (typeof process !== 'undefined' && process.exit) process.exit(1); throw new Error('F-03 failures: ' + FAIL); }
