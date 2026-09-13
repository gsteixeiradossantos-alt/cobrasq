// Supabase Edge Function: djen-intimacoes
// Puxa do DJEN (Diário de Justiça Eletrônico Nacional) tudo o que saiu em nome
// das OABs do escritório e grava em `intimacoes_djen`.
//
// Por quê: no TJRS (eproc) um ato ordinatório publicado só no diário (meio "D")
// NÃO gera e-mail do sistema — o escritório só descobria pelo "prazo decorrido"
// dias depois. O DJEN é a fonte oficial e a API é pública (sem chave).
//
// Fluxo (disparado por pg_cron, ver migração 20260912_02_intimacoes_djen.sql):
//   1) para cada OAB, pagina GET comunicaapi.pje.jus.br/api/v1/comunicacao na
//      janela dos últimos DIAS_JANELA dias;
//   2) cada comunicação vira 1 linha em intimacoes_djen (dedup = sha1 de
//      cnj:data:texto — a mesma comunicação aparece nas duas OABs);
//   3) casa o CNJ com cobrancas.numero_processo → status 'vinculada'/'a_vincular';
//   4) RPC intimacoes_djen_cruzar(): marca as que também chegaram por e-mail
//      (mesmo CNJ, data do ato −3 … publicação +3). O que sobra é "só no diário";
//   5) o que é "só no diário" E de caso cadastrado entra em devedor_eventos
//      (timeline, fonte='djen'), uma vez só (evento_gravado).
//
// Backfill manual: POST { inicio: 'YYYY-MM-DD', fim: 'YYYY-MM-DD' } ou { dias: N }.
//
// Auth: header Authorization: Bearer <CRON_INVOKE_SECRET>.
// Secrets: CRON_INVOKE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Opcional: DJEN_OABS ("112743/PR,119424/PR" — default abaixo).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const API = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const DIAS_JANELA = 5;          // reprocessa os últimos N dias (idempotente por dedup)
const ITENS_POR_PAGINA = 100;   // teto da API
const MAX_PAGINAS = 30;         // trava de segurança por OAB/run
const OABS_DEFAULT = '112743/PR,119424/PR'; // Gustavo, Ana Clara
// A API recusa clientes sem User-Agent "de navegador".
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const CRON_INVOKE_SECRET = Deno.env.get('CRON_INVOKE_SECRET') ?? '';
const OABS = (Deno.env.get('DJEN_OABS') || OABS_DEFAULT).split(',').map(s => s.trim()).filter(Boolean);

const sb = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

// ── Helpers ──────────────────────────────────────────────────────────────────
function digitosCNJ(num: unknown): string | null {
  const d = String(num ?? '').replace(/\D/g, '');
  return d.length === 20 ? d : null;
}
function formatarCNJ(d: string): string {
  return `${d.slice(0,7)}-${d.slice(7,9)}.${d.slice(9,13)}.${d.slice(13,14)}.${d.slice(14,16)}.${d.slice(16,20)}`;
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
// "20/08/2026" | "2026-08-20" → "2026-08-20"
function dataISO(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
const ENT: Record<string, string> = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', ordm:'º', ordf:'ª', deg:'°', sect:'§' };
function limparHtml(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|section|tr|li|br|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => {
      if (ENT[e.toLowerCase()] != null) return ENT[e.toLowerCase()];
      // &aacute; &Ccedil; &otilde; … → letra acentuada
      const mm = String(e).match(/^([A-Za-z])(acute|grave|circ|tilde|uml|cedil|ring)$/);
      if (!mm) return m;
      const comb: Record<string, string> = { acute:'\u0301', grave:'\u0300', circ:'\u0302', tilde:'\u0303', uml:'\u0308', cedil:'\u0327', ring:'\u030A' };
      return (mm[1] + comb[mm[2]]).normalize('NFC');
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
// Data do ato citada no texto — PROJUDI: "movimento (seq. 129) JUNTADA … (11/08/2026)".
// O diário do TJPR sai ~9 dias depois do movimento; o cruzamento com o e-mail
// (que chega no dia do ato) precisa dessa data. Só aceita data até 60 dias
// antes da publicação e nunca depois dela; senão usa a própria publicação.
function dataAtoDoTexto(textoLimpo: string, dataDisp: string): string {
  const m = String(textoLimpo || '').match(/\((\d{2})\/(\d{2})\/(\d{4})\)/);
  if (!m) return dataDisp;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const t = Date.parse(iso + 'T12:00:00Z'), td = Date.parse(dataDisp + 'T12:00:00Z');
  if (!Number.isFinite(t) || t > td || td - t > 60 * 86400000) return dataDisp;
  return iso;
}
async function sha1(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function parseJsonish(v: unknown): unknown {
  if (v == null || typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return v; }
}

// Carrega uma vez o mapa dígitos-CNJ → cobranca_id (evita 1 query por linha).
async function carregarCobrancasMap(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const { data } = await sb.from('cobrancas').select('id, numero_processo').not('numero_processo', 'is', null).limit(2000);
  for (const c of (data || [])) { const d = digitosCNJ((c as any).numero_processo); if (d) m.set(d, (c as any).id); }
  return m;
}

// ── DJEN ─────────────────────────────────────────────────────────────────────
async function buscarOab(oab: string, inicio: string, fim: string): Promise<any[]> {
  const [numero, uf] = oab.split('/');
  const itens: any[] = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const u = new URL(API);
    u.searchParams.set('numeroOab', numero);
    u.searchParams.set('ufOab', uf || 'PR');
    u.searchParams.set('dataDisponibilizacaoInicio', inicio);
    u.searchParams.set('dataDisponibilizacaoFim', fim);
    u.searchParams.set('itensPorPagina', String(ITENS_POR_PAGINA));
    u.searchParams.set('pagina', String(pagina));
    let j: any = null;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(25000) });
        if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 2000 * (tentativa + 1))); continue; }
        if (!r.ok) throw new Error(`DJEN ${r.status} p/ OAB ${oab}`);
        j = await r.json(); break;
      } catch (e) {
        if (tentativa === 2) throw e;
        await new Promise(s => setTimeout(s, 2000 * (tentativa + 1)));
      }
    }
    const lote: any[] = Array.isArray(j?.items) ? j.items : [];
    itens.push(...lote);
    const total = Number(j?.count ?? 0);
    if (!lote.length || itens.length >= total || lote.length < ITENS_POR_PAGINA) break;
  }
  return itens;
}

// ── Grava ────────────────────────────────────────────────────────────────────
async function gravar(item: any, oab: string, cobrMap: Map<string, string>): Promise<'nova' | 'repetida' | 'erro'> {
  const dig = digitosCNJ(item.numero_processo || item.numeroprocessocommascara);
  const numero = dig ? formatarCNJ(dig) : (item.numeroprocessocommascara || null);
  const data = dataISO(item.data_disponibilizacao) || dataISO(item.datadisponibilizacao);
  if (!data) return 'erro';
  const texto = String(item.texto || '');
  const textoLimpo = limparHtml(texto).slice(0, 8000);
  const dedup = await sha1(`${dig || numero || ''}:${data}:${textoLimpo.toLowerCase()}`);
  const cobrancaId = dig ? (cobrMap.get(dig) ?? null) : null;

  const { error } = await sb.from('intimacoes_djen').insert({
    djen_id: item.id != null ? String(item.id) : null,
    hash_djen: item.hash || null,
    oab,
    data_disponibilizacao: data,
    data_ato: dataAtoDoTexto(textoLimpo, data),
    tribunal: item.siglaTribunal || null,
    orgao: item.nomeOrgao || null,
    tipo_comunicacao: item.tipoComunicacao || null,
    tipo_documento: item.tipoDocumento || null,
    classe: item.nomeClasse || null,
    meio: item.meio || null,
    numero_processo: numero, digitos: dig,
    texto: texto.slice(0, 60000), texto_limpo: textoLimpo,
    link: item.link || null,
    destinatarios: parseJsonish(item.destinatarios),
    advogados: parseJsonish(item.destinatarioadvogados),
    status: cobrancaId ? 'vinculada' : 'a_vincular',
    cobranca_id: cobrancaId, devedor_id: cobrancaId,
    dedup,
    raw: { id: item.id, hash: item.hash, status: item.status, numeroComunicacao: item.numeroComunicacao, meiocompleto: item.meiocompleto, ativo: item.ativo, data_cancelamento: item.data_cancelamento, motivo_cancelamento: item.motivo_cancelamento },
  });
  if (!error) return 'nova';
  if (String(error.message || '').includes('duplicate')) return 'repetida';
  console.error('[djen] insert', error.message);
  return 'erro';
}

// "Só no diário" de caso cadastrado → timeline do caso (uma vez). Só depois de
// 1 dia da publicação: dá tempo de o e-mail do tribunal chegar e o cruzamento
// casar — senão a timeline ganharia o mesmo ato duas vezes (djen + email).
async function gravarEventos(): Promise<number> {
  const ontem = isoDate(new Date(Date.now() - 86400000));
  const { data } = await sb.from('intimacoes_djen')
    .select('id, cobranca_id, numero_processo, data_disponibilizacao, data_ato, tribunal, tipo_documento, orgao, texto_limpo, dedup')
    .is('intimacao_email_id', null).eq('evento_gravado', false).not('cobranca_id', 'is', null)
    .neq('status', 'ignorada').lte('data_disponibilizacao', ontem).limit(200);
  let n = 0;
  for (const r of (data || []) as any[]) {
    const evDedup = `djen:${r.dedup}`;
    const rotulo = `${r.tipo_documento || 'Publicação no diário'} (DJEN)`;
    const { error } = await sb.from('devedor_eventos').insert({
      devedor_id: r.cobranca_id, cobranca_id: r.cobranca_id, tipo: 'andamento_judicial',
      payload: { acao_completa: rotulo, fonte: 'djen', data: r.data_ato || r.data_disponibilizacao, publicado_em: r.data_disponibilizacao, tribunal: r.tribunal, orgao: r.orgao,
                 resumo: String(r.texto_limpo || '').slice(0, 600), dedup: evDedup },
    });
    if (error && !String(error.message || '').includes('duplicate')) { console.error('[djen] devedor_eventos', error.message); continue; }
    await sb.from('intimacoes_djen').update({ evento_gravado: true }).eq('id', r.id);
    n++;
  }
  return n;
}

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!CRON_INVOKE_SECRET || bearer !== CRON_INVOKE_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const dias = Number(body?.dias) > 0 ? Number(body.dias) : DIAS_JANELA;
    const fim = dataISO(body?.fim) || isoDate(new Date());
    const inicio = dataISO(body?.inicio) || isoDate(new Date(new Date(fim + 'T12:00:00Z').getTime() - dias * 86400000));

    const cobrMap = await carregarCobrancasMap();
    const res: Record<string, any> = { inicio, fim, oabs: {} };
    let novas = 0;
    for (const oab of OABS) {
      const itens = await buscarOab(oab, inicio, fim);
      const c = { total: itens.length, novas: 0, repetidas: 0, erros: 0 };
      for (const it of itens) {
        const r = await gravar(it, oab, cobrMap);
        if (r === 'nova') c.novas++; else if (r === 'repetida') c.repetidas++; else c.erros++;
      }
      novas += c.novas;
      res.oabs[oab] = c;
    }
    // Cruza com o e-mail (janela um pouco maior que a de busca, p/ e-mail atrasado).
    const { data: cruzadas, error: eCruz } = await sb.rpc('intimacoes_djen_cruzar', { p_dias: dias + 10 });
    if (eCruz) console.error('[djen] cruzar', eCruz.message);
    res.cruzadas = cruzadas ?? null;
    res.eventos = await gravarEventos();
    res.novas = novas;
    return new Response(JSON.stringify({ ok: true, ...res }), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[djen-intimacoes]', msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
