// f54 — Comprovante de repasse ao credor: PF e a empresa dela (MEI/CNPJ) não repetem
// o nome. Caso real de 30/09/2026: Jeferson Luciano Pereira (0002398-29.2023.8.16.0183).
'use strict';

const assert = require('assert');
const { listarPagadores, msgComprovanteCredor } = require('../api/_repasse-msg.js');

const jef = [
  { nome: 'Jeferson Luciano Pereira', doc: '073.254.299-59' },
  { nome: '50.677.114 Jeferson Luciano Pereira (MEI)', doc: '50.677.114/0001-49' },
];
assert.strictEqual(listarPagadores(jef),
  'Jeferson Luciano Pereira (PF e MEI) (CPF n. 073.254.299-59 e CNPJ n. 50.677.114/0001-49)');

assert.strictEqual(listarPagadores([
  { nome: 'Edenilson dos Santos', doc: '072.383.959-08' },
  { nome: 'Edenilson dos Santos 07238395908', doc: '28.707.499/0001-90' },
]), 'Edenilson dos Santos (PF e PJ) (CPF n. 072.383.959-08 e CNPJ n. 28.707.499/0001-90)');

// Pessoas diferentes: como antes
assert.strictEqual(listarPagadores([
  { nome: 'Elaine Baranoski', doc: '11111111111' },
  { nome: 'Sidimar Pruch', doc: '22222222222' },
]), 'Elaine Baranoski (CPF n. 111.111.111-11) e Sidimar Pruch (CPF n. 222.222.222-22)');

const msg = msgComprovanteCredor({ parcela: 2, total: 71, partes: jef });
assert.ok(msg.includes('firmado por *Jeferson Luciano Pereira (PF e MEI) (CPF n. 073.254.299-59 e CNPJ n. 50.677.114/0001-49).*'), msg);

console.log('f54 ok — comprovante junta PF e MEI/PJ da mesma pessoa');
