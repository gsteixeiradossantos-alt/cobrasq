// scripts/sync-bia-knowledge.js
// Lê docs/bia/*.md e sincroniza (upsert) com a tabela bia_conhecimento no
// Supabase. Entradas que existem na tabela mas não existem mais nos
// arquivos são marcadas ativo=false (soft-delete).
//
// Uso: node --env-file=.env.local scripts/sync-bia-knowledge.js
//      (ou: npm run sync:bia)
// Requer no ambiente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, '..', 'docs', 'bia');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

const META_RE = /slug:\s*([\w-]+)\s*\|\s*categoria:\s*(\w+)(?:\s*\|\s*ordem:\s*(\d+))?/;

function parseFile(content, filename) {
  const rows = [];
  // divide em seções por "## " no início de linha; descarta o preâmbulo (antes do 1º H2)
  const parts = content.split(/^## /m).slice(1);
  for (const part of parts) {
    const lines = part.split('\n');
    const titulo = lines[0].trim();
    const metaIdx = lines.findIndex((l) => l.trim().startsWith('<!--'));
    if (metaIdx === -1) {
      console.warn(`[aviso] ${filename}: seção "${titulo}" sem linha de metadados, pulando`);
      continue;
    }
    const m = META_RE.exec(lines[metaIdx]);
    if (!m) {
      console.warn(`[aviso] ${filename}: metadados inválidos em "${titulo}", pulando`);
      continue;
    }
    const [, slug, categoria, ordem] = m;
    const conteudo = lines.slice(metaIdx + 1).join('\n').trim();
    if (!conteudo) {
      console.warn(`[aviso] ${filename}: "${titulo}" (${slug}) sem conteúdo, pulando`);
      continue;
    }
    rows.push({ slug, categoria, titulo, conteudo, ordem: ordem ? Number(ordem) : 100, ativo: true });
  }
  return rows;
}

async function sbFetch(pathAndQuery, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`Supabase ${pathAndQuery}: ${r.status} — ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function main() {
  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md');
  if (!files.length) throw new Error(`Nenhum .md encontrado em ${DOCS_DIR}`);

  let all = [];
  for (const f of files) all = all.concat(parseFile(fs.readFileSync(path.join(DOCS_DIR, f), 'utf8'), f));
  if (!all.length) throw new Error('Nenhuma entrada válida encontrada nos arquivos.');

  const slugsVistos = new Set();
  for (const row of all) {
    if (slugsVistos.has(row.slug)) throw new Error(`slug duplicado: ${row.slug}`);
    slugsVistos.add(row.slug);
  }

  // --json: só imprime as entradas parseadas (sem tocar rede) — útil pra revisar
  // antes de sincronizar, ou pra aplicar via SQL direto quando não há a chave à mão.
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(all));
    return;
  }

  if (!SB_URL || !SB_KEY) {
    const missing = [!SB_URL && 'SUPABASE_URL', !SB_KEY && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean);
    throw new Error(`Faltam variáveis de ambiente: ${missing.join(', ')}`);
  }

  await sbFetch('bia_conhecimento?on_conflict=slug', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(all.map((r) => ({ ...r, atualizado_em: new Date().toISOString() }))),
  });
  console.log(`Sincronizado: ${all.length} entrada(s) em ${files.length} arquivo(s).`);

  // soft-delete: desativa no banco quem não existe mais nos arquivos
  const existentes = await sbFetch('bia_conhecimento?select=slug&ativo=eq.true');
  const orfaos = (existentes || []).map((r) => r.slug).filter((s) => !slugsVistos.has(s));
  if (orfaos.length) {
    for (const slug of orfaos) {
      await sbFetch(`bia_conhecimento?slug=eq.${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ativo: false, atualizado_em: new Date().toISOString() }),
      });
    }
    console.log(`Desativado(s) (removido(s) dos arquivos): ${orfaos.join(', ')}`);
  }
}

main().catch((e) => {
  console.error('[erro]', e.message || e);
  process.exit(1);
});
