#!/usr/bin/env node
/**
 * atualizar-indices.mjs — traz os índices oficiais do BCB/SGS para a tabela
 * embutida em templates/calc-engine.js (a MATRIZ única de cálculo).
 *
 *   node scripts/atualizar-indices.mjs          # grava os meses que faltam
 *   node scripts/atualizar-indices.mjs --check  # só confere; exit 1 se faltar o mês anterior
 *
 * Regras:
 *  - Só entram MESES FECHADOS (anteriores ao mês corrente). O SGS devolve a
 *    SELIC do mês em curso como parcial e ela já foi parar na tabela uma vez
 *    (#509, "SELIC de junho gravada em curso") — nunca mais.
 *  - Nunca sobrescreve um valor já gravado: revisão do BCB em mês antigo é
 *    apontada no relatório para conferência humana, não aplicada por script.
 *  - TJPR = média aritmética INPC/IGP-DI do mês (Tabela Prática TJPR).
 *  - TAXA-LEGAL[m] = (SGS 29541[m] / SGS 29542[m-1] − 1) × 100, piso 0,
 *    6 casas — mesma fórmula dos valores já gravados (Lei 14.905/24).
 *
 * Roda no GitHub Actions (.github/workflows/atualizar-indices.yml) nos dias 12
 * e 16 de cada mês e abre um PR; o merge continua sendo decisão humana.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(ROOT, 'templates', 'calc-engine.js');
const CHECK = process.argv.includes('--check');

// série SGS por índice (as mesmas de CalcEngine.BCB_SERIES)
const SGS = { 'INPC': 188, 'IPCA': 433, 'IGP-M': 189, 'IGP-DI': 190, 'SELIC': 4390 };
const SGS_TL = { selic: 29541, ipca15: 29542 };

const hoje = new Date();
const mesCorrente = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
const mesAnterior = (() => { const d = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
const mesAntes = (k) => { const [y, m] = k.split('-').map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

async function sgs(codigo, ultimos = 18) {   // o SGS aceita no máximo 20 em /ultimos
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${codigo}/dados/ultimos/${ultimos}?formato=json`;
  let r, arr;
  for (let t = 1; t <= 3; t++) {                       // instabilidade ocasional do SGS
    r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'cobrasq-indices/1.0' } });
    if (r.ok) { arr = await r.json(); break; }
    if (r.status === 400) break;                        // erro de negócio: não adianta repetir
    await new Promise(res => setTimeout(res, 800 * t));
  }
  if (!arr) throw new Error(`SGS ${codigo}: HTTP ${r && r.status} ${r ? (await r.text()).slice(0, 200) : ''}`);
  const out = {};
  for (const it of arr) { const [, mm, yyyy] = it.data.split('/'); out[`${yyyy}-${mm}`] = parseFloat(it.valor); }
  return out;
}

// ── lê a tabela do engine (uma linha por índice, formato fixo) ──
const src = readFileSync(ENGINE, 'utf8');
const linhaRe = (nome) => new RegExp(`^(\\s*'${nome.replace('-', '\\-')}': \\{)([^}]*)(\\},?)$`, 'm');
function lerTabela(nome) {
  const m = src.match(linhaRe(nome)); if (!m) throw new Error(`tabela ${nome} não encontrada no engine`);
  const tab = {};
  for (const par of m[2].split(',')) { const [k, v] = par.split(':'); tab[k.replace(/'/g, '').trim()] = parseFloat(v); }
  return tab;
}
function serializar(tab) {
  return Object.keys(tab).sort().map(k => `'${k}':${tab[k]}`).join(',');
}
const ultimoMes = (tab) => Object.keys(tab).sort().pop();

const tabelas = {}; for (const n of [...Object.keys(SGS), 'TJPR', 'TAXA-LEGAL']) tabelas[n] = lerTabela(n);

// ── --check: a tabela tem o mês anterior? ──
if (CHECK) {
  const faltando = Object.keys(SGS).filter(n => !(mesAnterior in tabelas[n]));
  for (const n of Object.keys(tabelas)) console.log(`${n.padEnd(11)} até ${ultimoMes(tabelas[n])}`);
  if (faltando.length) { console.error(`\nFALTA ${mesAnterior} em: ${faltando.join(', ')} — rode scripts/atualizar-indices.mjs`); process.exit(1); }
  console.log(`\nOK: todos os índices têm ${mesAnterior}.`); process.exit(0);
}

// ── busca e aplica meses fechados que faltam ──
const novos = {}, revisoes = [];
for (const [nome, cod] of Object.entries(SGS)) {
  const bcb = await sgs(cod);
  for (const [k, v] of Object.entries(bcb)) {
    if (k >= mesCorrente) continue;                       // mês em curso: nunca
    if (k in tabelas[nome]) { if (Math.abs(tabelas[nome][k] - v) > 1e-9) revisoes.push(`${nome} ${k}: tabela ${tabelas[nome][k]} × BCB ${v}`); continue; }
    tabelas[nome][k] = v; (novos[nome] ||= []).push(k);
  }
}
// TJPR derivado
for (const k of Object.keys(tabelas.INPC)) {
  if (k in tabelas.TJPR || !(k in tabelas['IGP-DI'])) continue;
  tabelas.TJPR[k] = Math.round(((tabelas.INPC[k] + tabelas['IGP-DI'][k]) / 2) * 1000) / 1000;
  (novos.TJPR ||= []).push(k);
}
// TAXA-LEGAL derivada (SGS 29541 = fator SELIC do mês; 29542 = fator IPCA-15 do mês)
const tlS = await sgs(SGS_TL.selic), tlI = await sgs(SGS_TL.ipca15);
for (const k of Object.keys(tlS)) {
  if (k >= mesCorrente || k in tabelas['TAXA-LEGAL'] || k < '2024-09') continue;
  const ant = tlI[mesAntes(k)]; if (ant == null) continue;
  const tl = Math.max(0, (tlS[k] / ant - 1) * 100);
  tabelas['TAXA-LEGAL'][k] = Math.round(tl * 1e6) / 1e6;
  (novos['TAXA-LEGAL'] ||= []).push(k);
}

// ── relatório ──
const temNovo = Object.keys(novos).length > 0;
for (const n of Object.keys(tabelas)) console.log(`${n.padEnd(11)} até ${ultimoMes(tabelas[n])}${novos[n] ? '  + ' + novos[n].sort().map(k => `${k}=${tabelas[n][k]}`).join(' ') : ''}`);
if (revisoes.length) { console.log('\nATENÇÃO — BCB revisou valor já gravado (não aplicado, conferir à mão):'); revisoes.forEach(r => console.log('  ' + r)); }
if (!temNovo) { console.log('\nNada a atualizar.'); process.exit(0); }

// ── grava, preservando o resto do arquivo ──
let out = src;
for (const n of Object.keys(tabelas)) out = out.replace(linhaRe(n), (m, a, _b, c) => `${a}${serializar(tabelas[n])}${c}`);
writeFileSync(ENGINE, out);
console.log(`\nGravado em ${ENGINE}.`);
