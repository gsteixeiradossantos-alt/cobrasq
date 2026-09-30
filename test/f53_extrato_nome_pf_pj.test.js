// f53 — Extrato de repasse: PF e a empresa dela (MEI/CNPJ) não repetem o nome.
// Casos reais de 30/09/2026: "Edenilson dos Santos e Edenilson dos Santos 07238395908"
// (0001959-91.2021.8.16.0149) e "Jeferson Luciano Pereira e 50.677.114 Jeferson Luciano
// Pereira (MEI)" (0002398-29.2023.8.16.0183). Roda a função real do index.html.
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fatia(inicioRe, fimRe) {
  const a = HTML.search(inicioRe); assert.ok(a >= 0, 'não achei ' + inicioRe);
  const b = HTML.slice(a).search(fimRe); assert.ok(b > 0, 'não achei o fim de ' + inicioRe);
  return HTML.slice(a, a + b);
}
const ctx = vm.createContext({});
vm.runInContext(fatia(/^function _extratoAgruparPartes\(/m, /\n(?:\/\/ .*\n)*(?:const|let|var|function|async function) /)
  + '\nglobalThis.agrupar = _extratoAgruparPartes;', ctx);
const nomeDe = partes => ctx.agrupar(partes).map(p => p.rotuloNome).join(' e ');

// 1) PF + MEI
const jef = ctx.agrupar([
  { nome: 'Jeferson Luciano Pereira', doc: '073.254.299-59' },
  { nome: '50.677.114 Jeferson Luciano Pereira (MEI)', doc: '50.677.114/0001-49' },
]);
assert.strictEqual(jef.length, 1);
assert.strictEqual(jef[0].rotuloNome, 'Jeferson Luciano Pereira (PF e MEI)');
assert.deepStrictEqual(Array.from(jef[0].docs), ['073.254.299-59', '50.677.114/0001-49']);

// 2) PF + CNPJ comum (nome com CPF no fim)
assert.strictEqual(nomeDe([
  { nome: 'Edenilson dos Santos', doc: '072.383.959-08' },
  { nome: 'Edenilson dos Santos 07238395908', doc: '28.707.499/0001-90' },
]), 'Edenilson dos Santos (PF e PJ)');

// 3) Acento e caixa não atrapalham; ordem PJ antes da PF também não
assert.strictEqual(nomeDe([
  { nome: 'JOSE ANTONIO MULLER LTDA', doc: '11.222.333/0001-81' },
  { nome: 'José Antônio Müller', doc: '123.456.789-09' },
]), 'José Antônio Müller (PF e PJ)');

// 4) Pessoas diferentes continuam separadas por " e "
assert.strictEqual(nomeDe([
  { nome: 'Maria da Silva', doc: '111.111.111-11' },
  { nome: 'João Pereira', doc: '222.222.222-22' },
]), 'Maria da Silva e João Pereira');
assert.strictEqual(nomeDe([
  { nome: 'Maria da Silva', doc: '111.111.111-11' },
  { nome: 'Oficina Pereira Ltda', doc: '33.444.555/0001-66' },
]), 'Maria da Silva e Oficina Pereira Ltda');

// 5) Nome parcial não junta ("Ana Paula" não está contida em "Ana Paulada")
assert.strictEqual(nomeDe([
  { nome: 'Ana Paula', doc: '333.333.333-33' },
  { nome: 'Ana Paulada Comércio', doc: '44.555.666/0001-77' },
]), 'Ana Paula e Ana Paulada Comércio');

// 6) Parte única e sem documento
assert.strictEqual(nomeDe([{ nome: 'Fulano de Tal', doc: '' }]), 'Fulano de Tal');
assert.strictEqual(nomeDe([]), '');

// 7) O extrato usa o agrupamento no nome (cabeçalho/arquivo) e na legenda
assert.ok(/const devedor = _grupos\.map\(x=>x\.rotuloNome\)\.join\(' e '\)/.test(HTML), 'devedor não usa o agrupamento');
assert.ok(/devedorPartes: _grupos/.test(HTML), 'legenda não recebe os grupos');

console.log('f53 ok — extrato junta PF e MEI/PJ da mesma pessoa');
