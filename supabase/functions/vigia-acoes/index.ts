// Supabase Edge Function: vigia-acoes
// Procura, no DJEN, os devedores de cobranças ATIVAS e os executados dos
// processos do escritório como parte de processo judicial que NÃO é nosso — só
// nos tribunais da UF do nosso processo — e grava o achado em `vigia_acoes`.
//
// Por quê (25/09/2026): o devedor Wesley Cechin Gobatto, executado por nós no
// 0005569-82.2025.8.16.0131, era AUTOR do 0002110-19.2025.8.16.0181 (JEC
// Marmeleiro) e levantou ~R$ 4.600 sem sabermos. Com o aviso, teríamos pedido
// penhora no rosto dos autos.
//   polo A = devedor é AUTOR → crédito a penhorar (prioridade)
//   polo P = devedor é RÉU de outro credor → concorrência
//
// Fluxo (pg_cron a cada 3 min das 06:00 às 08:57 UTC, ver migração
// 20260925_02_vigia_acoes.sql; cada chamada anda um pedaço da fila):
//   1) universo = vw_vigia_acoes_universo → montarAlvos (1 alvo por pessoa):
//      'dev:<devedor_id>' (cobrança ativa) e 'esc:<nome>' (executado do escritório);
//   2) pega quem ainda não foi buscado HOJE (vigia_acoes_busca), mais antigos primeiro;
//   3) GET comunicaapi.pje.jus.br/api/v1/comunicacao?nomeParte=… na janela dos
//      últimos DIAS_JANELA dias, 1 requisição a cada ESPACO_MS;
//   4) refiltra pelo nome EXATO (a API casa por prefixo), tira processo nosso
//      (OAB do escritório, parte COBRASQ, CNJ já cadastrado/intimado), tira tribunal
//      fora da UF do nosso processo (TJ/TRT/TRF da UF; decisão de 25/09/2026) e
//      agrupa por CNJ;
//   5) upsert em vigia_acoes, dedup (alvo, digitos). Status novo/visto/descartado
//      é da tela — o worker nunca reabre um "descartado" nem um "visto".
//
// Ritmo medido em 25/09/2026 (evidência no PR): x-ratelimit-limit 20; a 21ª
// chamada seguida devolve 429 com retry-after 2 e o contador volta ~5 s depois.
// ESPACO_MS = 1100 fica ~5x abaixo do teto; 429 respeita o retry-after.
//
// Manual: POST { dias, limite, alvos:['dev:…','esc:…'], nome:'trecho', inicio, fim, dry_run:true, forcar:true }
//   dry_run → não grava nada, devolve os achados; forcar → ignora "já buscado hoje".
//
// ⚠️ 25/09/2026: o DJEN devolve 403 para chamadas saídas do Supabase (35/35 na 1ª
// rodada; a mesma URL dá 200 no Mac, no Brasil). Por isso a busca roda no Mac
// (scripts/vigia-acoes-local.mjs) em dois passos com o mesmo bearer:
//   POST { modo:'fila', limite, forcar }  → { inicio, fim, fila:[{alvo, nome, busca}] }
//   POST { modo:'resultados', inicio, fim, resultados:[{alvo, itens, total, truncado, erro}] }
//     → a função refaz os filtros (nome exato, processo nosso, UF, teto, CPF) e grava.
// O cron `vigia-acoes` (busca pela própria função) ficou pausado.
// Auth: Authorization: Bearer <CRON_INVOKE_SECRET>.
// Secrets: CRON_INVOKE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { nomeDeBusca, agruparAchados, montarAlvos, resumirMuitos, filtrarTruncado } from './logica.mjs';

const MAX_ITENS_REPASSE = 5000; // por alvo, depois da poda no Mac

const API = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const DIAS_JANELA = 3;          // olha 3 dias para trás: atraso de 1–2 dias não perde nada
const ITENS_POR_PAGINA = 100;   // teto da API
const MAX_PAGINAS = 5;          // nome muito comum: 500 comunicações bastam (o resto é homônimo)
const ESPACO_MS = 1100;         // entre requisições (limite medido: 20 / ~5 s)
const LIMITE_PADRAO = 35;       // devedores por chamada
const ORCAMENTO_MS = 50000;     // pg_net espera 55 s; para antes
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const CRON_INVOKE_SECRET = Deno.env.get('CRON_INVOKE_SECRET') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

const _fmtBR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const hojeBR = () => _fmtBR.format(new Date());
const menosDias = (iso: string, n: number) => _fmtBR.format(new Date(Date.parse(iso + 'T12:00:00Z') - n * 86400000));
const dataISO = (v: unknown) => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[0] : null; };
const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Ritmo ────────────────────────────────────────────────────────────────────
let ultimaReq = 0;
const stats = { requisicoes: 0, r429: 0 };
async function getDjen(u: URL): Promise<any> {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const espera = ultimaReq + ESPACO_MS - Date.now();
    if (espera > 0) await dormir(espera);
    ultimaReq = Date.now();
    stats.requisicoes++;
    let r: Response;
    try {
      r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      if (tentativa === 3) throw e;
      await dormir(2000 * (tentativa + 1)); continue;
    }
    if (r.status === 429) {
      stats.r429++;
      const ra = Number(r.headers.get('retry-after')) || 3;
      await dormir((ra + 1) * 1000); continue;
    }
    if (r.status >= 500) { await dormir(2000 * (tentativa + 1)); continue; }
    if (!r.ok) throw new Error(`DJEN HTTP ${r.status}`);
    return await r.json();
  }
  throw new Error('DJEN: 4 tentativas sem resposta');
}

async function buscarNome(nome: string, inicio: string, fim: string): Promise<{ itens: any[]; total: number; truncado: boolean }> {
  const itens: any[] = [];
  let total = 0;
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const u = new URL(API);
    u.searchParams.set('nomeParte', nome);
    u.searchParams.set('dataDisponibilizacaoInicio', inicio);
    u.searchParams.set('dataDisponibilizacaoFim', fim);
    u.searchParams.set('itensPorPagina', String(ITENS_POR_PAGINA));
    u.searchParams.set('pagina', String(pagina));
    const j = await getDjen(u);
    const lote: any[] = Array.isArray(j?.items) ? j.items : [];
    total = Number(j?.count ?? 0);
    itens.push(...lote);
    if (!lote.length || itens.length >= total || lote.length < ITENS_POR_PAGINA) break;
  }
  return { itens, total, truncado: itens.length < total };
}

// CNJs "da casa": toda cobrança com processo + tudo o que já saiu no DJEN ou no e-mail nas nossas OABs.
async function carregarCnjsNossos(): Promise<Set<string>> {
  const s = new Set<string>();
  const add = (v: unknown) => { const d = String(v ?? '').replace(/\D/g, ''); if (d.length === 20) s.add(d); };
  for (let de = 0; ; de += 1000) {
    const { data, error } = await sb.from('cobrancas').select('numero_processo').not('numero_processo', 'is', null).range(de, de + 999);
    if (error) throw new Error('cobrancas: ' + error.message);
    (data || []).forEach((r: any) => add(r.numero_processo));
    if (!data || data.length < 1000) break;
  }
  for (let de = 0; ; de += 1000) {
    const { data, error } = await sb.from('intimacoes_djen').select('digitos').not('digitos', 'is', null).range(de, de + 999);
    if (error) break; // tabela opcional para este fim
    (data || []).forEach((r: any) => add(r.digitos));
    if (!data || data.length < 1000) break;
  }
  // Processos do escritório que só chegaram por e-mail (base dos alvos 'esc:').
  for (let de = 0; ; de += 1000) {
    const { data, error } = await sb.from('intimacoes_email').select('digitos').not('digitos', 'is', null).range(de, de + 999);
    if (error) break;
    (data || []).forEach((r: any) => add(r.digitos));
    if (!data || data.length < 1000) break;
  }
  return s;
}

async function gravarAchado(dev: any, a: any): Promise<'novo' | 'atualizado' | 'erro'> {
  const { data: exist, error: eSel } = await sb.from('vigia_acoes')
    .select('id, comunicacoes, primeira_data, ultima_data, polo, cpf_confere').eq('alvo', dev.alvo).eq('digitos', a.digitos).maybeSingle();
  if (eSel) { console.error('[vigia] select', eSel.message); return 'erro'; }
  if (!exist) {
    const { error } = await sb.from('vigia_acoes').insert({
      alvo: dev.alvo, origem: dev.origem, devedor_id: dev.devedor_id, cobranca_id: dev.cobranca_id,
      processo_ref: dev.processo_ref, uf_ref: dev.ufs.join('/'),
      nome_devedor: dev.nome, nome_encontrado: a.nome_encontrado,
      numero_processo: a.numero_processo, digitos: a.digitos, polo: a.polo,
      tribunal: a.tribunal, classe: a.classe, orgao: a.orgao, link: a.link,
      primeira_data: a.primeira_data, ultima_data: a.ultima_data,
      comunicacoes: a.comunicacoes, qtd_comunicacoes: a.comunicacoes.length,
      partes: a.partes, advogados: a.advogados, ultimo_texto: a.ultimo_texto,
      cpf_confere: !!a.cpf_confere, processos: a.processos ?? null,
    });
    if (error && !String(error.message).includes('duplicate')) { console.error('[vigia] insert', error.message); return 'erro'; }
    return 'novo';
  }
  const ids = Array.from(new Set([...(exist.comunicacoes || []), ...a.comunicacoes]));
  const maisNovo = !exist.ultima_data || (a.ultima_data && a.ultima_data > exist.ultima_data);
  const upd: Record<string, unknown> = {
    comunicacoes: ids, qtd_comunicacoes: ids.length,
    primeira_data: (!exist.primeira_data || (a.primeira_data && a.primeira_data < exist.primeira_data)) ? a.primeira_data : exist.primeira_data,
    polo: (exist.polo === 'A' || a.polo === 'A') ? 'A' : (exist.polo || a.polo),
    partes: a.partes, advogados: a.advogados, atualizado_em: new Date().toISOString(),
    cpf_confere: !!(exist.cpf_confere || a.cpf_confere),
  };
  // Linha "Vários processos": a lista e a contagem são as da busca mais recente.
  if (a.processos) Object.assign(upd, { processos: a.processos, numero_processo: a.numero_processo, tribunal: a.tribunal, nome_encontrado: a.nome_encontrado });
  if (maisNovo) Object.assign(upd, { ultima_data: a.ultima_data, link: a.link, ultimo_texto: a.ultimo_texto });
  const { error } = await sb.from('vigia_acoes').update(upd).eq('id', exist.id);
  if (error) { console.error('[vigia] update', error.message); return 'erro'; }
  return 'atualizado';
}

Deno.serve(async (req) => {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!CRON_INVOKE_SECRET || bearer !== CRON_INVOKE_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const t0 = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    const forcar = body?.forcar === true;
    const modo = body?.modo === 'fila' || body?.modo === 'resultados' ? body.modo : 'buscar';
    const limite = Math.min(Math.max(Number(body?.limite) || LIMITE_PADRAO, 1), 2000);
    const orcamento = Math.min(Math.max(Number(body?.orcamento_ms) || ORCAMENTO_MS, 5000), 140000);
    const hoje = hojeBR();
    const dias = Number(body?.dias) > 0 ? Number(body.dias) : DIAS_JANELA;
    const fim = dataISO(body?.fim) || hoje;
    const inicio = dataISO(body?.inicio) || menosDias(fim, dias);

    // Universo → alvos
    const { data: linhas, error: eU } = await sb.from('vw_vigia_acoes_universo')
      .select('origem, devedor_id, cobranca_id, nome, processo_ref, uf_devedor, uf_credor, doc').limit(10000);
    if (eU) throw new Error('universo: ' + eU.message);
    let universo = montarAlvos(linhas || []);
    if (Array.isArray(body?.alvos) && body.alvos.length) universo = universo.filter((d: any) => body.alvos.includes(d.alvo));
    if (typeof body?.nome === 'string' && body.nome.trim()) {
      const t = body.nome.trim().toUpperCase();
      universo = universo.filter((d: any) => String(d.nome).toUpperCase().includes(t));
    }

    // Quem já foi buscado hoje (e quando foi a última vez dos demais)
    const { data: estado } = await sb.from('vigia_acoes_busca').select('alvo, buscado_em, buscado_ts').limit(10000);
    const est = new Map((estado || []).map((r: any) => [r.alvo, r]));
    const fila = universo
      .filter((d: any) => forcar || est.get(d.alvo)?.buscado_em !== hoje)
      .sort((a: any, b: any) => String(est.get(a.alvo)?.buscado_ts || '').localeCompare(String(est.get(b.alvo)?.buscado_ts || '')))
      .slice(0, limite);

    const cnjsNossos = await carregarCnjsNossos();
    const res = { inicio, fim, dry_run: dryRun, universo: universo.length,
                  universo_escritorio: universo.filter((d: any) => d.origem === 'escritorio').length,
                  pendentes_hoje: 0, processados: 0,
                  pulados_nome: 0, comunicacoes: 0, novos: 0, atualizados: 0, erros: 0, truncados: 0,
                  descartados: { nome_diferente: 0, nosso: 0, sem_cnj: 0, fora_da_uf: 0, outro_ramo: 0, homonimo_truncado: 0 }, achados: [] as any[] };
    res.pendentes_hoje = universo.filter((d: any) => est.get(d.alvo)?.buscado_em !== hoje).length;

    const processar = async (dev: any, obter: () => Promise<{ itens: any[]; total: number; truncado: boolean }>) => {
      const { busca, motivo } = nomeDeBusca(dev.nome);
      let registro: Record<string, unknown> = { alvo: dev.alvo, devedor_id: dev.devedor_id, uf_ref: dev.ufs.join('/'), nome_busca: busca, buscado_em: hoje, buscado_ts: new Date().toISOString(), motivo, erro: null, comunicacoes: 0, achados: 0 };
      if (!busca) {
        res.pulados_nome++;
      } else {
        try {
          const { itens, total, truncado } = await obter();
          const { achados: agrupados, descartados } = agruparAchados(itens, dev.nome, cnjsNossos, dev.ufs, dev.doc);
          // busca cortada = nome comum demais: só fica o que tem CPF conferido
          const { achados: todos, descartados: homonimos } = filtrarTruncado(agrupados, truncado);
          res.descartados.homonimo_truncado += homonimos;
          const achados = resumirMuitos(todos);   // > 5 processos → 1 aviso "Vários processos (N)"
          res.comunicacoes += total;
          if (truncado) res.truncados++;
          for (const k of Object.keys(descartados) as (keyof typeof descartados)[]) res.descartados[k] += descartados[k];
          registro = { ...registro, comunicacoes: total, achados: todos.length, motivo: truncado ? 'truncado' : null };
          for (const a of achados) {
            if (dryRun) { res.achados.push({ alvo: dev.alvo, devedor: dev.nome, uf: dev.ufs.join('/'), ...a, ultimo_texto: undefined, doc: undefined }); continue; }
            const r = await gravarAchado(dev, a);
            if (r === 'novo') res.novos++; else if (r === 'atualizado') res.atualizados++; else res.erros++;
          }
        } catch (e) {
          res.erros++;
          registro.erro = e instanceof Error ? e.message : String(e);
          registro.buscado_em = null; // tenta de novo na próxima chamada
        }
      }
      if (!dryRun) {
        const { error } = await sb.from('vigia_acoes_busca').upsert(registro, { onConflict: 'alvo' });
        if (error) console.error('[vigia] busca upsert', error.message);
      }
      res.processados++;
    };

    if (modo === 'fila') {
      return new Response(JSON.stringify({ ok: true, inicio, fim, universo: universo.length, pendentes_hoje: res.pendentes_hoje,
        fila: fila.map((d: any) => ({ alvo: d.alvo, nome: d.nome, busca: nomeDeBusca(d.nome).busca })) }),
        { headers: { 'content-type': 'application/json' } });
    }
    if (modo === 'resultados') {
      const porAlvo = new Map(universo.map((d: any) => [d.alvo, d]));
      for (const r of (Array.isArray(body?.resultados) ? body.resultados : [])) {
        const dev = porAlvo.get(r?.alvo);
        if (!dev) { res.erros++; continue; }   // saiu do universo entre a fila e o repasse
        await processar(dev, async () => {
          if (r.erro) throw new Error(String(r.erro).slice(0, 300));
          const itens = Array.isArray(r.itens) ? r.itens.slice(0, MAX_ITENS_REPASSE) : [];
          return { itens, total: Number(r.total) || itens.length, truncado: !!r.truncado };
        });
      }
      return new Response(JSON.stringify({ ok: true, ...res, ms: Date.now() - t0 }), { headers: { 'content-type': 'application/json' } });
    }

    for (const dev of fila) {
      if (Date.now() - t0 > orcamento) break;
      await processar(dev, () => buscarNome(nomeDeBusca(dev.nome).busca as string, inicio, fim));
    }
    return new Response(JSON.stringify({ ok: true, ...res, ...stats, ms: Date.now() - t0 }), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[vigia-acoes]', msg);
    return new Response(JSON.stringify({ ok: false, error: msg, ...stats }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
