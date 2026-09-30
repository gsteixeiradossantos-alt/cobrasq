// F-51 — código TPU 51 ("Conclusão") era rotulado "Penhora/constrição de bens" na
// timeline do caso (961 eventos em 218 cobranças até 30/09/2026). Conferido na TPU
// do CNJ (gateway.cloud.pje.jus.br/tpu, versão 2025-09-11): 51 = "Conclusão", pai 48.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { curarMovimento } = require('../api/_datajud-tpu.js');

const c = curarMovimento('51', 'Conclusão', []);
assert.strictEqual(c.label, 'Conclusos', 'backend: código 51 com rótulo ' + c.label);
assert.ok(!/penhora/i.test(c.label));

// O front (index.html) espelha a tabela — os dois precisam concordar.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\b51:\{include:(true|false),label:'([^']*)'\}/);
assert.ok(m, 'front: código 51 não encontrado em TPU_MOV');
assert.strictEqual(m[2], 'Conclusos', 'front: código 51 com rótulo ' + m[2]);

// 466/893/898 — conferidos na mesma TPU: Homologação de Transação, Desarquivamento,
// Suspensão por decisão judicial.
const esperados = { 466: 'Acordo homologado', 893: 'Processo desarquivado', 898: 'Processo suspenso por decisão judicial' };
for (const [cod, rot] of Object.entries(esperados)) {
  assert.strictEqual(curarMovimento(cod, '', []).label, rot, 'backend: código ' + cod);
  const mf = html.match(new RegExp('\\b' + cod + ":\\{include:true,label:'([^']*)'\\}"));
  assert.ok(mf && mf[1] === rot, 'front: código ' + cod + ' = ' + (mf && mf[1]));
}

// Penhora de verdade (nome com "penhora", código fora da tabela) continua penhora.
assert.strictEqual(curarMovimento('99999', 'Penhora online', []).label, 'Penhora/constrição de bens');

console.log('f51_datajud_tpu_conclusao: ok');
