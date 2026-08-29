/*
 * Teste F-09 (api/_data.js) — a data de calendário do BACKEND sai do fuso de Curitiba,
 * não do relógio UTC do servidor.
 *
 * O runtime da Vercel roda em UTC. `new Date().toISOString().slice(0,10)` num handler
 * grava a data de UTC: das 21h à meia-noite (BRT) o servidor já virou o dia. Isso datava
 * no dia seguinte o `effectiveDate` da nota fiscal, a data do Pix e do comprovante de
 * repasse, o vencimento das parcelas do emitir-acordo e o `recebido_em` de pagamento sem
 * data vinda do Asaas.
 *
 * O teste força TZ=UTC de propósito — é o fuso do servidor real. Se o helper dependesse
 * do relógio da máquina, ele falharia aqui.
 *
 * Como rodar:
 *   node test/f09_data_backend.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

if (process.env.TZ !== 'UTC') {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit', env: Object.assign({}, process.env, { TZ: 'UTC' }),
  });
  process.exit(r.status == null ? 1 : r.status);
}

const { isoBR, hojeBR, addDiasBR, FUSO_BR } = require('../api/_data.js');

let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++; console.log(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

console.log(`F-09 · api/_data.js (processo em TZ=${process.env.TZ}, fuso alvo ${FUSO_BR})\n`);

// A faixa que quebrava: 21h–24h BRT já é o dia seguinte em UTC.
const casos = [
  ['2026-08-30T00:30:00Z', '2026-08-29', '29/08 21h30 BRT'],
  ['2026-08-30T02:59:00Z', '2026-08-29', '29/08 23h59 BRT'],
  ['2026-08-30T03:00:00Z', '2026-08-30', '30/08 00h00 BRT'],
  ['2026-08-29T12:00:00Z', '2026-08-29', '29/08 09h BRT (cron da régua)'],
  ['2027-01-01T01:00:00Z', '2026-12-31', 'virada de ano: 31/12 22h BRT'],
];
for (const [iso, esperado, quando] of casos) {
  const antigo = new Date(iso).toISOString().slice(0, 10);
  ok(`${quando} → ${esperado}`, isoBR(iso) === esperado, `isoBR deu ${isoBR(iso)}`);
  if (esperado !== antigo) {
    ok(`  …e o jeito antigo dava ${antigo}`, true);
  }
}

// hojeBR é isoBR(agora) e nunca cai fora de ±1 dia da data UTC.
const h = hojeBR();
ok('hojeBR tem formato AAAA-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(h), h);
const dUtc = new Date().toISOString().slice(0, 10);
const difDias = Math.abs((new Date(h + 'T12:00:00Z') - new Date(dUtc + 'T12:00:00Z')) / 86400000);
ok('hojeBR fica a no máximo 1 dia da data UTC', difDias <= 1, `${h} vs ${dUtc}`);

// addDiasBR: usado pelo emitir-acordo (vencimento das parcelas) e pelos syncs.
ok('addDiasBR(0) === hojeBR()', addDiasBR(0) === hojeBR());
ok('addDiasBR(+3) a partir de 29/08 21h30 BRT → 01/09',
  addDiasBR(3, '2026-08-30T00:30:00Z') === '2026-09-01', addDiasBR(3, '2026-08-30T00:30:00Z'));
ok('addDiasBR(-7) a partir de 29/08 21h30 BRT → 22/08',
  addDiasBR(-7, '2026-08-30T00:30:00Z') === '2026-08-22', addDiasBR(-7, '2026-08-30T00:30:00Z'));
ok('addDiasBR aceita Date', addDiasBR(1, new Date('2026-08-30T00:30:00Z')) === '2026-08-30');

// Entradas degeneradas não podem virar "NaN-NaN-NaN" no meio de um payload fiscal.
ok('data inválida devolve string vazia', isoBR('abacaxi') === '');
ok('addDiasBR com base inválida devolve string vazia', addDiasBR(1, 'abacaxi') === '');

// Guarda de fonte: ninguém pode reintroduzir o padrão antigo no backend.
const raiz = path.join(__dirname, '..');
const alvos = [];
(function varrer(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name.startsWith('.')) continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) varrer(p);
    else if (/\.(js|ts)$/.test(f.name)) alvos.push(p);
  }
})(path.join(raiz, 'api'));
(function varrer2(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) varrer2(p);
    else if (/\.(js|ts)$/.test(f.name)) alvos.push(p);
  }
})(path.join(raiz, 'supabase', 'functions'));

const infratores = [];
for (const p of alvos) {
  const txt = fs.readFileSync(p, 'utf8');
  for (const [i, linha] of txt.split('\n').entries()) {
    if (!/toISOString\(\)\.slice\(0, ?10\)/.test(linha)) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(linha)) continue;          // comentário explicando o defeito
    infratores.push(`${path.relative(raiz, p)}:${i + 1}`);
  }
}
ok(`guarda · nenhum toISOString().slice(0,10) em api/ ou supabase/functions/ (${alvos.length} arquivos varridos)`,
  infratores.length === 0, infratores.join(', '));

console.log('');
if (falhas) { console.error(`${falhas} falha(s).`); process.exit(1); }
console.log('F-09 · data do backend no fuso de Curitiba.');
