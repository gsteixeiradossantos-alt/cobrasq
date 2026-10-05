// Supabase Edge Function: datajud-andamentos
// Captura os andamentos dos processos monitorados no DataJud (CNJ) em RODÍZIO.
// Substitui o disparo diário de api/cron-datajud.js (Vercel), desligado em
// 25/08/2026 por estourar o timeout de 300s.
//
// Fluxo (pg_cron a cada 10 min, migração 20261005_03_datajud_rodizio.sql):
//   1) RPC datajud_proximos(LOTE): os processos consultados há mais tempo
//      (nunca consultados primeiro), já com o devedor principal;
//   2) UMA chamada ao DataJud com todos eles (query terms) — medido em 05/10/2026:
//      20 processos = 34s; chamadas seguidas devolvem 429, por isso uma só;
//   3) movimentos → proc_intimacoes (feed cru dos alertas, upsert por dedup_key) e
//      o subconjunto curado → devedor_eventos (timeline, RPC idempotente);
//   4) datajud_controle.consultado_em = agora para cada processo da vez.
//      Em 429/timeout o lote NÃO avança: volta na próxima execução.
//
// Mesma semântica do cron antigo: dedup_key `<digitos>:<codigo>:<dataHora>`;
// na primeira sincronização de um processo o histórico entra como lida=true
// (sem alerta retroativo).
//
// Manual: POST { limite?: n (1–50), dry?: true }  — dry só lista a vez, sem chamar o CNJ.
// Auth: header Authorization: Bearer <CRON_INVOKE_SECRET>.
// Secrets: CRON_INVOKE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Opcional: DATAJUD_API_KEY (default = chave pública do CNJ, publicada em
// https://datajud-wiki.cnj.jus.br/api-publica/acesso/ — o CNJ pode trocá-la).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { curarMovimento } from '../_shared/datajud-tpu.ts';

const URL_TJPR = 'https://api-publica.datajud.cnj.jus.br/api_publica_tjpr/_search';
const CHAVE_PUBLICA_CNJ = 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
const LOTE_PADRAO = 20;
const TIMEOUT_MS = 90000;

const CRON_INVOKE_SECRET = Deno.env.get('CRON_INVOKE_SECRET') ?? '';
const API_KEY = Deno.env.get('DATAJUD_API_KEY') || CHAVE_PUBLICA_CNJ;

const sb = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

type Alvo = { cobranca_id: string; devedor_id: string | null; digitos: string; formatado: string; ja_sincronizado: boolean };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function marcar(ids: string[], resultado: string, extra: { erro?: string; movimentos?: Record<string, number> } = {}) {
  if (!ids.length) return;
  const agora = new Date().toISOString();
  const rows = ids.map((id) => ({
    cobranca_id: id,
    consultado_em: agora,
    ultimo_resultado: resultado,
    ultimo_erro: extra.erro ?? null,
    movimentos: extra.movimentos ? (extra.movimentos[id] ?? 0) : null,
    atualizado_em: agora,
  }));
  const { error } = await sb.from('datajud_controle').upsert(rows, { onConflict: 'cobranca_id' });
  if (error) console.error('[datajud-andamentos] controle:', error.message);
}

// Uma chamada para o lote inteiro. Um processo pode ter mais de um documento
// (1º e 2º grau): os movimentos são somados por número.
async function consultarLote(digitos: string[]): Promise<Map<string, any[]>> {
  const r = await fetch(URL_TJPR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `APIKey ${API_KEY}` },
    body: JSON.stringify({
      query: { terms: { numeroProcesso: digitos } },
      size: Math.max(10, digitos.length * 4),
      _source: ['numeroProcesso', 'movimentos'],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const e = new Error(`DataJud ${r.status}: ${t.slice(0, 200)}`);
    (e as any).status = r.status;
    throw e;
  }
  const j = await r.json();
  const porNumero = new Map<string, any[]>();
  for (const h of (j?.hits?.hits ?? [])) {
    const s = h?._source ?? {};
    const num = String(s.numeroProcesso ?? '');
    if (!num) continue;
    const lista = porNumero.get(num) ?? [];
    if (Array.isArray(s.movimentos)) lista.push(...s.movimentos);
    porNumero.set(num, lista);
  }
  return porNumero;
}

Deno.serve(async (req) => {
  const auth = req.headers.get('authorization') ?? '';
  if (!CRON_INVOKE_SECRET || auth !== `Bearer ${CRON_INVOKE_SECRET}`) return json({ error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const limite = Math.min(50, Math.max(1, parseInt(body?.limite, 10) || LOTE_PADRAO));
  const dry = body?.dry === true;

  const { data: vez, error: eVez } = await sb.rpc('datajud_proximos', { p_limite: limite });
  if (eVez) return json({ ok: false, etapa: 'proximos', error: eVez.message }, 500);
  const alvos = (vez ?? []) as Alvo[];
  if (dry) return json({ ok: true, dry: true, alvos: alvos.map((a) => ({ processo: a.formatado, sem_devedor: !a.devedor_id, ja_sincronizado: a.ja_sincronizado })) });

  const semDevedor = alvos.filter((a) => !a.devedor_id);
  const validos = alvos.filter((a) => a.devedor_id);
  if (semDevedor.length) {
    console.warn('[datajud-andamentos] sem devedor principal:', semDevedor.map((a) => `${a.formatado} (cobranca ${a.cobranca_id})`).join(', '));
    await marcar(semDevedor.map((a) => a.cobranca_id), 'sem_devedor');
  }
  if (!validos.length) return json({ ok: true, totais: { processos: 0, sem_devedor: semDevedor.length } });

  const t0 = Date.now();
  let porNumero: Map<string, any[]>;
  try {
    porNumero = await consultarLote(validos.map((a) => a.digitos));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const status = (e as any)?.status;
    const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
    console.error('[datajud-andamentos] consulta:', msg);
    // 429 / timeout: limite do CNJ ou lentidão — não avança o rodízio, tenta de novo daqui a 10 min.
    if (status === 429 || timeout) return json({ ok: false, retentar: true, error: msg }, 200);
    // Outro erro (ex.: 400 por um número que o CNJ recusa): avança para não travar o rodízio.
    await marcar(validos.map((a) => a.cobranca_id), 'erro', { erro: msg.slice(0, 500) });
    return json({ ok: false, error: msg }, 200);
  }
  const msConsulta = Date.now() - t0;

  const intimacoes: any[] = [];
  const eventos: any[] = [];
  const vistosDedup = new Set<string>();
  const qtdMov: Record<string, number> = {};
  const semDados: string[] = [];
  const comDados: string[] = [];

  for (const a of validos) {
    const movimentos = porNumero.get(a.digitos) ?? [];
    qtdMov[a.cobranca_id] = movimentos.length;
    if (!movimentos.length) { semDados.push(a.cobranca_id); continue; }
    comDados.push(a.cobranca_id);
    for (const m of movimentos) {
      const dataHora = m?.dataHora || m?.data_hora || '';
      const dataDia = dataHora ? String(dataHora).slice(0, 10) : null;
      const codigo = m?.codigo != null ? String(m.codigo) : 's';
      const dedup = `${a.digitos}:${codigo}:${dataHora}`;
      if (vistosDedup.has(dedup)) continue; // mesmo movimento em 1º e 2º grau
      vistosDedup.add(dedup);
      intimacoes.push({
        fonte: 'datajud',
        processo_num: a.formatado,
        data_publicacao: dataDia,
        data_intimacao: dataDia,
        conteudo: m?.nome || m?.descricao || 'Movimentação',
        link_diario: null,
        devedor_id: a.devedor_id,
        lida: !a.ja_sincronizado, // histórico inicial entra como lido (sem alerta retroativo)
        dedup_key: dedup,
      });
      const cur = curarMovimento(codigo, m?.nome, m?.complementosTabelados);
      if (!cur.include) continue;
      eventos.push({
        devedor_id: a.devedor_id,
        cobranca_id: a.cobranca_id,
        payload: { acao_completa: cur.label, fonte: 'datajud', data: dataDia, codigo, nome: m?.nome || '', dedup },
      });
    }
  }

  // Grava em blocos para não mandar um corpo gigante de uma vez.
  let novasIntimacoes = 0;
  const erros: string[] = [];
  for (let i = 0; i < intimacoes.length; i += 500) {
    const { data, error } = await sb.from('proc_intimacoes')
      .upsert(intimacoes.slice(i, i + 500), { onConflict: 'dedup_key', ignoreDuplicates: true })
      .select('id, lida');
    if (error) { erros.push(`intimacoes: ${error.message}`); continue; }
    novasIntimacoes += (data ?? []).filter((x: any) => x.lida === false).length;
  }
  let novosEventos = 0;
  for (let i = 0; i < eventos.length; i += 500) {
    const { data, error } = await sb.rpc('datajud_registrar_eventos', { p_eventos: eventos.slice(i, i + 500) });
    if (error) { erros.push(`eventos: ${error.message}`); continue; }
    novosEventos += Number(data ?? 0);
  }

  if (erros.length) {
    console.error('[datajud-andamentos] gravação:', erros.join(' | '));
    // Falha ao gravar: não avança quem tinha dados, para reprocessar na próxima volta.
    await marcar(semDados, 'sem_dados', { movimentos: qtdMov });
    return json({ ok: false, erros, ms_consulta: msConsulta }, 200);
  }

  await marcar(comDados, 'ok', { movimentos: qtdMov });
  await marcar(semDados, 'sem_dados', { movimentos: qtdMov });

  return json({
    ok: true,
    totais: {
      processos: validos.length,
      com_dados: comDados.length,
      sem_dados: semDados.length,
      sem_devedor: semDevedor.length,
      movimentos: intimacoes.length,
      intimacoes_novas_nao_lidas: novasIntimacoes,
      eventos_timeline_novos: novosEventos,
      ms_consulta: msConsulta,
    },
  });
});
