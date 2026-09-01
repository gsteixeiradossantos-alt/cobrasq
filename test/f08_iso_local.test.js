/*
 * Teste F-08 (isoLocal) — a data de calendário sai do relógio LOCAL, nunca de UTC.
 *
 * Antes, o app inteiro usava `x.toISOString().slice(0,10)`, que converte para UTC antes
 * de cortar. Em Curitiba (UTC−3) isso erra o dia inteiro toda noite: às 21h01 de 29/08 o
 * navegador já está em 30/08 UTC, e "hoje" virava amanhã. Atingia prazo, agenda, régua,
 * baixa de lançamento e nome de arquivo — 56 pontos do index.html.
 *
 * O teste roda com TZ=America/Sao_Paulo e exercita justamente a faixa das 21h à
 * meia-noite, onde o defeito aparecia.
 *
 * Como rodar:
 *   TZ=America/Sao_Paulo node test/f08_iso_local.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

if (process.env.TZ !== 'America/Sao_Paulo') {
  // O teste só significa alguma coisa num fuso negativo. Re-executa a si mesmo com o TZ
  // certo em vez de passar por acidente na máquina de quem roda em UTC.
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit', env: Object.assign({}, process.env, { TZ: 'America/Sao_Paulo' }),
  });
  process.exit(r.status == null ? 1 : r.status);
}

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ini = HTML.indexOf('function isoLocal(d){');
assert.ok(ini >= 0, 'isoLocal não existe mais no index.html');
const fim = HTML.indexOf('\n}', ini) + 2;
const ctx = { console, Date, Math, String, Number, isNaN };
vm.createContext(ctx);
vm.runInContext(HTML.slice(ini, fim), ctx);

let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++; console.log(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

console.log('F-08 · isoLocal (TZ=America/Sao_Paulo)\n');

// A faixa que quebrava: das 21h à meia-noite, UTC já está no dia seguinte.
for (const hora of [21, 22, 23]) {
  const d = new Date(2026, 7, 29, hora, 30, 0);              // 29/08/2026, horário local
  const utc = d.toISOString().slice(0, 10);                   // o jeito antigo
  ok(`${hora}h30 de 29/08 → 2026-08-29 (UTC diria ${utc})`,
    ctx.isoLocal(d) === '2026-08-29', `isoLocal devolveu ${ctx.isoLocal(d)}`);
  ok(`  …e o jeito antigo realmente errava às ${hora}h`, utc === '2026-08-30', `toISOString deu ${utc}`);
}

// Fora da faixa continua igual — a correção não pode mover nada que já estava certo.
for (const hora of [0, 9, 15, 20]) {
  const d = new Date(2026, 7, 29, hora, 0, 0);
  ok(`${String(hora).padStart(2,'0')}h de 29/08 continua 2026-08-29`, ctx.isoLocal(d) === '2026-08-29');
}

// Virada de mês e de ano no horário perigoso.
ok('31/12/2026 23h59 → 2026-12-31 (não 2027-01-01)',
  ctx.isoLocal(new Date(2026, 11, 31, 23, 59)) === '2026-12-31');
ok('31/08/2026 22h → 2026-08-31 (não 09-01)',
  ctx.isoLocal(new Date(2026, 7, 31, 22, 0)) === '2026-08-31');

// Zero-padding e entradas degeneradas.
ok('mês e dia com zero à esquerda', ctx.isoLocal(new Date(2026, 0, 5, 12)) === '2026-01-05');
ok('aceita string ISO', ctx.isoLocal('2026-03-10T12:00:00') === '2026-03-10');
ok('data inválida devolve string vazia, não "NaN-NaN-NaN"', ctx.isoLocal('abacaxi') === '');

// Guarda de fonte: ninguém pode reintroduzir o padrão antigo no index.html.
const residuo = (HTML.match(/toISOString\(\)\.slice\(0, ?10\)/g) || [])
  .filter(m => true).length;
const emComentario = (HTML.match(/\/\/.*toISOString\(\)\.slice\(0, ?10\)/g) || []).length;
ok(`guarda · nenhum toISOString().slice(0,10) fora de comentário (${residuo} achados, ${emComentario} em comentário)`,
  residuo - emComentario === 0,
  'voltou a cortar data de UTC em algum lugar do index.html');

// Guarda de fonte 2: os helpers consolidados não voltam.
//
// Em 29/08 conviviam quatro montadores da mesma data local no index.html
// (isoLocal, _finHojeLocal, _finISO, _metaYmd) mais uma IIFE solta. Nada quebrava —
// mas _finHojeLocal carregava um comentário afirmando que o `hoje()` global ainda era
// UTC, o que deixou de ser verdade no mesmo dia. Cópia a mais não é bug: é a próxima
// sessão corrigindo uma das quatro e achando que corrigiu todas.
for (const morto of ['_finHojeLocal', '_finISO', '_metaYmd']) {
  ok(`guarda · ${morto} não ressuscitou (use isoLocal)`, !HTML.includes(morto),
    `${morto} voltou ao index.html — aponte para isoLocal em vez de recriar`);
}

// E nenhum montador NOVO entra. O padrão é o miolo de qualquer reimplementação:
// getFullYear + getMonth()+1 + getDate() na mesma expressão. A linha de base abaixo é
// o que sobrou de inline em 31/08 (fmt, sem7, chave e cia., mais três falso-positivos
// que são `new Date(y, m+1, 0)` = último dia do mês). Consolidar esses é trabalho
// separado; esta guarda só impede que o número CRESÇA.
const BASE_MONTADORES = 15;
const montadores = (HTML.match(/getFullYear\(\)[^;\n]*getMonth\(\) ?\+ ?1[^;\n]*getDate\(\)/g) || []).length;
ok(`guarda · montadores de data inline não aumentaram (${montadores} ≤ ${BASE_MONTADORES})`,
  montadores <= BASE_MONTADORES,
  'apareceu um montador de data local novo — use isoLocal');

console.log('');
if (falhas) { console.error(`${falhas} falha(s).`); process.exit(1); }
console.log('F-08 · isoLocal correto na faixa que quebrava.');
