#!/usr/bin/env node
// Intimações do DJEN — busca feita NO MAC, gravação feita pela edge function.
//
// Por quê (26/09/2026): o DJEN (comunicaapi.pje.jus.br) devolve 403 para chamadas
// saídas do Supabase — intimacoes_djen parou em 13/09/2026 — e 200 para a mesma
// URL chamada deste Mac (Brasil). Mesmo remédio da vigia-acoes: o Mac só baixa;
// quem deduplica, vincula ao caso, cruza com o e-mail e grava na timeline é a
// função `djen-intimacoes`, que já tem acesso ao banco. O Mac não guarda chave do banco.
//
// Passos:
//   1) POST djen-intimacoes { modo:'janela' }  → janela (últimos 5 dias) e OABs;
//   2) para cada OAB, GET no DJEN paginado (1 req / 1,1 s; limite medido 20 / ~5 s);
//   3) POST djen-intimacoes { modo:'resultados' } em lotes de 100 comunicações;
//      o último lote leva finalizar:true (cruzar com e-mail + timeline).
//
// Token: o mesmo CRON_INVOKE_SECRET, lido do Keychain na hora (serviço
//   `cobrasq-vigia`, o mesmo da vigia de ações) ou da variável VIGIA_TOKEN.
//   Nunca vai para o log.
//
// Uso:
//   node scripts/djen-intimacoes-local.mjs                                   # rodada do dia
//   node scripts/djen-intimacoes-local.mjs --inicio 2026-09-10 --fim 2026-09-26   # backfill
//   node scripts/djen-intimacoes-local.mjs --so-djen                         # só testa o DJEN, não chama a função

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { partirOab, montarRepasses, somarRespostas } from './djen-intimacoes-lotes.mjs';

const FUNCAO = 'https://jokbxzhcctcwnbhkhgru.supabase.co/functions/v1/djen-intimacoes';
const API = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const ITENS_POR_PAGINA = 100;
const MAX_PAGINAS = 30;
const ESPACO_MS = 1100;
const LOTE = 100;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'cobrasq');
const LOG = join(LOG_DIR, 'djen-intimacoes.log');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const INICIO = opt('--inicio');
const FIM = opt('--fim');
const SO_DJEN = args.includes('--so-djen');

try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* sem log em arquivo */ }
const log = (...m) => {
  const linha = `[${new Date().toISOString()}] ${m.join(' ')}`;
  console.log(linha);
  try { appendFileSync(LOG, linha + '\n'); } catch { /* ignora */ }
};
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

function lerToken() {
  if (process.env.VIGIA_TOKEN) return process.env.VIGIA_TOKEN.trim();
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'cobrasq-vigia', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function chamarFuncao(token, corpo) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(FUNCAO, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(140000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { const e = new Error('função recusou o token (401) — conferir o item cobrasq-vigia no Keychain'); e.fatal = true; throw e; }
      if (!r.ok || j.ok === false) throw new Error(`função HTTP ${r.status}: ${j.error || ''}`);
      return j;
    } catch (e) {
      if (e.fatal || t === 2) throw e;
      await dormir(3000 * (t + 1));
    }
  }
}

// ── DJEN (mesmo ritmo e mesmas regras da vigia) ──────────────────────────────
let ultimaReq = 0;
const stats = { requisicoes: 0, r429: 0 };
async function getDjen(u) {
  for (let t = 0; t < 4; t++) {
    const espera = ultimaReq + ESPACO_MS - Date.now();
    if (espera > 0) await dormir(espera);
    ultimaReq = Date.now();
    stats.requisicoes++;
    let r;
    try {
      r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(25000) });
    } catch (e) {
      if (t === 3) throw e;
      await dormir(2000 * (t + 1)); continue;
    }
    if (r.status === 429) {
      stats.r429++;
      await dormir(((Number(r.headers.get('retry-after')) || 3) + 1) * 1000); continue;
    }
    if (r.status >= 500) { await dormir(2000 * (t + 1)); continue; }
    if (!r.ok) throw new Error(`DJEN HTTP ${r.status}`);
    return await r.json();
  }
  throw new Error('DJEN: 4 tentativas sem resposta');
}

async function buscarOab(oab, inicio, fim) {
  const p = partirOab(oab);
  if (!p) throw new Error(`OAB inválida: ${oab}`);
  const itens = [];
  let total = 0;
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const u = new URL(API);
    u.searchParams.set('numeroOab', p.numero);
    u.searchParams.set('ufOab', p.uf);
    u.searchParams.set('dataDisponibilizacaoInicio', inicio);
    u.searchParams.set('dataDisponibilizacaoFim', fim);
    u.searchParams.set('itensPorPagina', String(ITENS_POR_PAGINA));
    u.searchParams.set('pagina', String(pagina));
    const j = await getDjen(u);
    const lote = Array.isArray(j?.items) ? j.items : [];
    total = Number(j?.count ?? 0);
    itens.push(...lote);
    if (!lote.length || itens.length >= total || lote.length < ITENS_POR_PAGINA) break;
  }
  return { itens, total };
}

async function main() {
  const t0 = Date.now();
  if (SO_DJEN) {
    const fim = FIM || new Date().toISOString().slice(0, 10);
    const inicio = INICIO || new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    for (const oab of ['112743/PR', '119424/PR']) {
      const r = await buscarOab(oab, inicio, fim);
      log(`so-djen: OAB ${oab} ${inicio} a ${fim}: ${r.total} comunicações, ${r.itens.length} baixadas`);
    }
    return;
  }
  const token = lerToken();
  if (!token) throw new Error('sem token: guardar o CRON_INVOKE_SECRET no Keychain, serviço cobrasq-vigia');

  const j = await chamarFuncao(token, { modo: 'janela', ...(INICIO ? { inicio: INICIO } : {}), ...(FIM ? { fim: FIM } : {}) });
  log(`janela ${j.inicio} a ${j.fim}, OABs ${j.oabs.join(', ')}`);

  const resultados = [];
  for (const oab of j.oabs) {
    try {
      const { itens, total } = await buscarOab(oab, j.inicio, j.fim);
      log(`OAB ${oab}: ${itens.length} de ${total} comunicações baixadas`);
      resultados.push({ oab, itens });
    } catch (e) {
      log(`OAB ${oab}: ERRO no DJEN — ${e.message || e}`);
      resultados.push({ oab, erro: e.message || String(e) });
    }
  }
  // As duas OABs com 403 = o DJEN bloqueou também daqui: não adianta repassar vazio.
  if (resultados.every(r => r.erro)) throw new Error('DJEN falhou para todas as OABs; nada repassado');

  const respostas = [];
  for (const corpo of montarRepasses(resultados, { inicio: j.inicio, fim: j.fim, tamanho: LOTE })) {
    respostas.push(await chamarFuncao(token, corpo));
  }
  const s = somarRespostas(respostas);
  const porOab = Object.entries(s.oabs).map(([o, c]) => c.erro ? `${o}: erro (${c.erro})` : `${o}: ${c.total} lidas, ${c.novas} novas, ${c.repetidas} repetidas, ${c.erros} erros`).join(' · ');
  log(`fim: ${s.novas} novas · ${porOab} · cruzadas com e-mail ${s.cruzadas ?? '?'} · eventos na timeline ${s.eventos ?? '?'} · ` +
      `${stats.requisicoes} req DJEN (${stats.r429} × 429), ${Math.round((Date.now() - t0) / 1000)} s`);
  if (resultados.some(r => r.erro)) process.exitCode = 1;
}

main().catch(e => { log('ERRO:', e.message || String(e)); process.exitCode = 1; });
