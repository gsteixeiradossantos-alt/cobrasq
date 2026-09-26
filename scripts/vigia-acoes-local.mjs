#!/usr/bin/env node
// Vigia de ações — busca no DJEN feita NO MAC, gravação feita pela edge function.
//
// Por quê (25/09/2026): o DJEN (comunicaapi.pje.jus.br) devolve 403 para chamadas
// saídas do Supabase — 35/35 na 1ª rodada da função `vigia-acoes` — e 200 para a
// mesma URL chamada deste Mac (Brasil). O `djen-intimacoes` sofre do mesmo 403.
// Então o Mac só faz o que o servidor não consegue (baixar do DJEN) e repassa;
// quem filtra (nome exato, processo nosso, UF, teto de 5, CPF) e grava é a função,
// que já tem acesso ao banco. O Mac não guarda chave do banco.
//
// Passos:
//   1) POST vigia-acoes { modo:'fila' }   → quem ainda não foi buscado hoje;
//   2) para cada um, GET no DJEN (1 req / 1,1 s; limite medido 20 / ~5 s),
//      poda o que não tem o nome como destinatário (podarItens) e
//   3) POST vigia-acoes { modo:'resultados' } em lotes de LOTE alvos.
//
// Token: o mesmo CRON_INVOKE_SECRET da função, lido do Keychain na hora
//   (serviço `cobrasq-vigia`), ou da variável VIGIA_TOKEN. Nunca vai para o log.
//
// Uso:
//   node scripts/vigia-acoes-local.mjs                 # rodada do dia (fila inteira)
//   node scripts/vigia-acoes-local.mjs --limite 10     # só 10 alvos (teste)
//   node scripts/vigia-acoes-local.mjs --forcar        # ignora "já buscado hoje"
//   node scripts/vigia-acoes-local.mjs --so-djen       # só testa o DJEN, não chama a função
//   node scripts/vigia-acoes-local.mjs --nome "WESLEY CECHIN" --inicio 2025-01-01 --forcar
//                                                       # só quem tem esse trecho no nome, janela longa

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { podarItens } from '../supabase/functions/vigia-acoes/logica.mjs';

const FUNCAO = 'https://jokbxzhcctcwnbhkhgru.supabase.co/functions/v1/vigia-acoes';
const API = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const ITENS_POR_PAGINA = 100;
const MAX_PAGINAS = 5;
const ESPACO_MS = 1100;
const LOTE = 20;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'cobrasq');
const LOG = join(LOG_DIR, 'vigia-acoes.log');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const LIMITE = Number(opt('--limite')) || 2000;
const FORCAR = args.includes('--forcar');
const SO_DJEN = args.includes('--so-djen');
const NOME = opt('--nome');
const INICIO = opt('--inicio');
const FIM = opt('--fim');

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

// ── DJEN (mesmo ritmo e mesmas regras da função) ─────────────────────────────
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
      r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(20000) });
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

async function buscarNome(nome, inicio, fim) {
  const itens = [];
  let total = 0;
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const u = new URL(API);
    u.searchParams.set('nomeParte', nome);
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
  return { itens, total, truncado: itens.length < total };
}

async function main() {
  const t0 = Date.now();
  if (SO_DJEN) {
    const hoje = new Date().toISOString().slice(0, 10);
    const r = await buscarNome('WESLEY CECHIN GOBATTO', '2025-01-01', hoje);
    log(`so-djen: DJEN respondeu, ${r.total} comunicações, ${r.itens.length} baixadas`);
    return;
  }
  const token = lerToken();
  if (!token) throw new Error('sem token: guardar o CRON_INVOKE_SECRET no Keychain, serviço cobrasq-vigia');

  const f = await chamarFuncao(token, {
    modo: 'fila', limite: LIMITE, forcar: FORCAR,
    ...(NOME ? { nome: NOME } : {}), ...(INICIO ? { inicio: INICIO } : {}), ...(FIM ? { fim: FIM } : {}),
  });
  const fila = f.fila || [];
  log(`fila: ${fila.length} alvos (universo ${f.universo}, pendentes hoje ${f.pendentes_hoje}), janela ${f.inicio} a ${f.fim}`);

  const soma = { processados: 0, comunicacoes: 0, novos: 0, atualizados: 0, erros: 0, erros_djen: 0, truncados: 0, pulados_nome: 0 };
  let lote = [];
  const enviar = async () => {
    if (!lote.length) return;
    const r = await chamarFuncao(token, { modo: 'resultados', inicio: f.inicio, fim: f.fim, forcar: true, resultados: lote });
    for (const k of ['processados', 'comunicacoes', 'novos', 'atualizados', 'erros', 'truncados', 'pulados_nome']) soma[k] += Number(r[k]) || 0;
    lote = [];
  };

  let seguidos403 = 0;
  for (const alvo of fila) {
    if (!alvo.busca) { lote.push({ alvo: alvo.alvo, itens: [], total: 0 }); }
    else {
      try {
        const { itens, total, truncado } = await buscarNome(alvo.busca, f.inicio, f.fim);
        lote.push({ alvo: alvo.alvo, itens: podarItens(itens, alvo.nome), total, truncado });
        seguidos403 = 0;
      } catch (e) {
        soma.erros_djen++;
        lote.push({ alvo: alvo.alvo, erro: e.message || String(e) });
        // 403 em série = o DJEN bloqueou também daqui: para em vez de insistir
        seguidos403 = /HTTP 403/.test(e.message) ? seguidos403 + 1 : 0;
        if (seguidos403 >= 3) {
          await enviar();
          throw new Error('DJEN devolveu 403 três vezes seguidas; rodada interrompida');
        }
      }
    }
    if (lote.length >= LOTE) await enviar();
  }
  await enviar();
  log(`fim: ${soma.processados} alvos gravados, ${soma.comunicacoes} comunicações, ${soma.novos} avisos novos, ${soma.atualizados} atualizados, ` +
      `${soma.erros} erros na função, ${soma.erros_djen} erros no DJEN, ${soma.truncados} truncados, ` +
      `${stats.requisicoes} req DJEN (${stats.r429} × 429), ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().catch(e => { log('ERRO:', e.message || String(e)); process.exitCode = 1; });
