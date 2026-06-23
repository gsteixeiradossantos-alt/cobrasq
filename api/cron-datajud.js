// api/cron-datajud.js — Cron Vercel diário (ver vercel.json) que consulta a API
// pública do DataJud (CNJ) para cada processo cadastrado e grava ANDAMENTOS novos
// em proc_intimacoes (fonte='datajud'), alimentando os alertas de movimentação.
//
// Fonte gratuita e oficial do CNJ (latência ~24-48h). Complementa o Escavador
// (intimações em tempo real via DJEN). Ver docs/setup/escavador.md e
// docs/specs/eproc-tjpr-integracao-viabilidade.md.
//
// Modelo de dados: itera public.cobrancas (numero_processo IS NOT NULL). Pela
// invariante 2026-06-15 (cobranca.id = id do devedor principal = caso.id), o
// devedor_id da intimação é o próprio cobranca.id — sem lookup reverso.
//
// Idempotência: cada andamento vira um dedup_key estável
// (`<digitos>:<codigoMov>:<dataHora>`) com UNIQUE index; o insert usa
// on_conflict=ignore para reexecuções seguras (migration 2026-06-23a).
//
// Primeira sincronização de um processo: o histórico entra como lida=true (não
// dispara alerta retroativo). Andamentos novos em execuções seguintes entram
// como lida=false (alerta real).
//
// Auth: igual ao cron-controlle (CRON_SECRET, comparação em tempo constante).
// Teste manual: GET /api/cron-datajud?dry=1   ·   ?limit=5

const crypto = require('crypto');
const { sbFetch } = require('./_sb.js');

// Endpoint público do TJPR no DataJud. A chave é a APIKey pública do CNJ
// (documentada em https://datajud-wiki.cnj.jus.br/), exposta em DATAJUD_API_KEY.
const DATAJUD_TJPR_URL = 'https://api-publica.datajud.cnj.jus.br/api_publica_tjpr/_search';

// Só consultamos processos do TJPR (Justiça Estadual J=8, Tribunal TR=16). Outros
// tribunais usariam outro alias do DataJud — fora do escopo deste cron.
const TJPR_SEGMENTO = '8';
const TJPR_TRIBUNAL = '16';

// Extrai os 20 dígitos do número CNJ (aceita formatado ou só dígitos).
function digitosCNJ(num) {
  const d = String(num || '').replace(/\D/g, '');
  return d.length === 20 ? d : null;
}

// Formata 20 dígitos em NNNNNNN-DD.AAAA.J.TR.OOOO (forma canônica p/ exibição).
function formatarCNJ(d) {
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`;
}

function ehTJPR(d) {
  return d && d[13] === TJPR_SEGMENTO && d.slice(14, 16) === TJPR_TRIBUNAL;
}

// Consulta o DataJud por número de processo (20 dígitos). Retorna o _source ou null.
async function consultarDataJud(apiKey, digitos) {
  const r = await fetch(DATAJUD_TJPR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `APIKey ${apiKey}` },
    body: JSON.stringify({ query: { match: { numeroProcesso: digitos } }, size: 1 }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`DataJud ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json().catch(() => null);
  const hit = j && j.hits && Array.isArray(j.hits.hits) ? j.hits.hits[0] : null;
  return hit ? hit._source : null;
}

module.exports = async function handler(req, res) {
  // ── Auth (timing-safe), espelha cron-controlle / cron-regua ────────────────
  const expect = process.env.CRON_SECRET || '';
  if (!expect) return res.status(500).json({ error: 'CRON_SECRET não configurado no servidor.' });
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const secret = req.headers['x-cron-secret'] || req.query?.secret || bearer || '';
  const got = crypto.createHash('sha256').update(String(secret)).digest();
  const exp = crypto.createHash('sha256').update(String(expect)).digest();
  if (!crypto.timingSafeEqual(got, exp)) return res.status(401).json({ error: 'unauthorized' });

  const apiKey = process.env.DATAJUD_API_KEY || '';
  if (!apiKey) return res.status(500).json({ error: 'DATAJUD_API_KEY não configurada no servidor.' });

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';
  const limit = Math.min(500, Math.max(1, parseInt(req.query?.limit, 10) || 200));

  try {
    // Processos cadastrados (fonte única = cobrancas, Fase C).
    const cobrancas = await sbFetch(
      `cobrancas?numero_processo=not.is.null&select=id,numero_processo&limit=${limit}`
    );

    // Filtra os que têm CNJ válido do TJPR.
    const alvos = [];
    for (const c of cobrancas) {
      const d = digitosCNJ(c.numero_processo);
      if (d && ehTJPR(d)) alvos.push({ cobrancaId: c.id, digitos: d, formatado: formatarCNJ(d) });
    }

    if (dry) {
      return res.status(200).json({
        ok: true, dry: true,
        cobrancas_com_processo: cobrancas.length,
        processos_tjpr_validos: alvos.length,
      });
    }

    const totais = { processos: alvos.length, consultados: 0, novos: 0, backfill: 0, sem_dados: 0, erros: 0 };

    for (const alvo of alvos) {
      try {
        const source = await consultarDataJud(apiKey, alvo.digitos);
        totais.consultados++;
        const movimentos = source && Array.isArray(source.movimentos) ? source.movimentos : [];
        if (!movimentos.length) { totais.sem_dados++; continue; }

        // Primeira sincronização deste processo? (sem nenhum andamento datajud salvo)
        const existentes = await sbFetch(
          `proc_intimacoes?fonte=eq.datajud&processo_num=eq.${encodeURIComponent(alvo.formatado)}&select=id&limit=1`
        );
        const primeiraVez = !Array.isArray(existentes) || existentes.length === 0;

        const rows = movimentos.map((m) => {
          const dataHora = m.dataHora || m.data_hora || '';
          const dataDia = dataHora ? String(dataHora).slice(0, 10) : null;
          const codigo = m.codigo != null ? String(m.codigo) : 's';
          return {
            fonte: 'datajud',
            processo_num: alvo.formatado,
            data_publicacao: dataDia,
            data_intimacao: dataDia,
            conteudo: m.nome || m.descricao || 'Movimentação',
            link_diario: null,
            devedor_id: alvo.cobrancaId, // invariante: cobranca.id = devedor principal
            lida: primeiraVez, // histórico inicial entra como lido (sem alerta retroativo)
            dedup_key: `${alvo.digitos}:${codigo}:${dataHora}`,
          };
        });

        // Insert idempotente: ON CONFLICT (dedup_key) DO NOTHING; retorna só os novos.
        const inseridos = await sbFetch('proc_intimacoes?on_conflict=dedup_key', {
          method: 'POST',
          prefer: 'resolution=ignore-duplicates,return=representation',
          body: JSON.stringify(rows),
        });
        const qtd = Array.isArray(inseridos) ? inseridos.length : 0;
        if (primeiraVez) totais.backfill += qtd; else totais.novos += qtd;
      } catch (e) {
        totais.erros++;
        console.error('[cron-datajud]', alvo.formatado, String((e && e.message) || e));
      }
    }

    return res.status(200).json({ ok: true, totais });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error('[cron-datajud]', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
};
