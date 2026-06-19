/*
 * Teste F-02 (FASE C) — ficha pura: devedorToRow ↔ rowToDevedor preservam os
 * campos de pessoa/qualificação (apelido, rg, nacionalidade, estado civil,
 * profissão, observações, tags, nascimento) sem perda. Garante que a separação
 * Devedor↔Cobrança não some com nenhum dado da pessoa.
 *
 * Roda contra o CÓDIGO REAL (extrai funções do index.html). Sem build.
 *   node test/f02_qualificacao_roundtrip.test.js   (ou jsc ...)
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
function extractDelimited(src, a, b){
  var s = src.indexOf(a); if (s < 0) throw new Error('não achei: ' + a);
  var e = src.indexOf(b, s); if (e < 0) throw new Error('não achei fim: ' + b);
  return src.slice(s, e + b.length);
}
var PATH = (typeof process !== 'undefined' && process.argv && process.argv[2]) ? process.argv[2]
         : (typeof arguments !== 'undefined' && arguments.length && typeof arguments[0] === 'string') ? arguments[0]
         : 'index.html';
var SRC = readSource(PATH);

var setSrc = extractDelimited(SRC, 'const _DEV_COL_FIELDS = new Set([', ']);');
var numSrc = extractBalanced(SRC, 'function _devNumOrNull(');
var rowSrc = extractBalanced(SRC, 'function devedorToRow(');
var r2dSrc = extractBalanced(SRC, 'function rowToDevedor(');

var harness =
  'var parseValorBR = function(v){ var n = parseFloat(String(v).replace(/[^0-9.-]/g,"")); return isFinite(n)?n:NaN; };\n' +
  setSrc + '\n' + numSrc + '\n' + rowSrc + '\n' + r2dSrc + '\n' +
  'this.__devedorToRow = devedorToRow; this.__rowToDevedor = rowToDevedor;';
(0, eval)(harness);
var devedorToRow = (typeof globalThis !== 'undefined') ? globalThis.__devedorToRow : this.__devedorToRow;
var rowToDevedor = (typeof globalThis !== 'undefined') ? globalThis.__rowToDevedor : this.__rowToDevedor;

var RAN = 0, FAIL = 0;
function check(n, c){ RAN++; if (c) { LOG('  ✓ ' + n); } else { FAIL++; LOG('  ✗ ' + n); } }

// Devedor "ficha pura" com qualificação para petição.
var dev = { id:'d1', nome:'Maria Silva', doc:'123', apelido:'Mary', rg:'MG-1',
  nacionalidade:'Brasileira', estadoCivil:'Casado(a)', profissao:'Médica',
  obs:'cliente boa', tags:['vip','reincidente'], loginNascimento:'1985-03-04' };
var row = devedorToRow(dev);
check('apelido → coluna', row.apelido === 'Mary');
check('rg → coluna', row.rg === 'MG-1');
check('nacionalidade → coluna', row.nacionalidade === 'Brasileira');
check('estado_civil → coluna', row.estado_civil === 'Casado(a)');
check('profissao → coluna', row.profissao === 'Médica');
check('observacoes → coluna', row.observacoes === 'cliente boa');
check('data_nascimento → coluna', row.data_nascimento === '1985-03-04');
check('tags → array', Array.isArray(row.tags) && row.tags.length === 2);

// Round-trip de volta (simula a linha vinda do banco).
var back = rowToDevedor({ id:'d1', nome:'Maria Silva', doc:'123',
  apelido:row.apelido, rg:row.rg, nacionalidade:row.nacionalidade,
  estado_civil:row.estado_civil, profissao:row.profissao, observacoes:row.observacoes,
  data_nascimento:row.data_nascimento, tags:row.tags, metadata:{} });
check('round-trip apelido', back.apelido === 'Mary');
check('round-trip estadoCivil', back.estadoCivil === 'Casado(a)');
check('round-trip profissao', back.profissao === 'Médica');
check('round-trip obs', back.obs === 'cliente boa');
check('round-trip tags', Array.isArray(back.tags) && back.tags.join(',') === 'vip,reincidente');
check('round-trip nascimento', back.loginNascimento === '1985-03-04');

// A coluna vence o metadata legado (backfill já copiou metadata → coluna).
var back2 = rowToDevedor({ id:'d2', nome:'X', rg:'COLU', metadata:{ rg:'META', obs:'metaobs' } });
check('coluna rg vence metadata', back2.rg === 'COLU');
check('fallback obs do metadata quando sem coluna', back2.obs === 'metaobs');

LOG(FAIL === 0 ? '\n✅ F-02 OK — ' + RAN + ' testes.' : '\n❌ F-02 FALHOU — ' + FAIL + '/' + RAN);
if (FAIL > 0) { if (typeof process !== 'undefined' && process.exit) process.exit(1); throw new Error('F-02 failures: ' + FAIL); }
