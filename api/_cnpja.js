// api/_cnpja.js — Consulta reversa "CPF/nome → empresas" (quadro societário).
//
// Exposto como ação em api/automacao.js (?action=cnpja) para não estourar o limite
// de 12 Serverless Functions do plano Hobby (ver CLAUDE.md).
//
// PARA QUE SERVE
//   Na tela de acordo, o operador precisa saber se o DEVEDOR pessoa física é sócio de
//   alguma empresa (p/ incluí-la/incluí-lo como avalista). Esse caminho é "reverso"
//   (nome/CPF → empresas) e NÃO existe em API pública gratuita — a CNPJá Open e a
//   BrasilAPI só fazem CNPJ → sócios. A busca por sócio é recurso da API COMERCIAL.
//
// COMO CASA A IDENTIDADE (nome completo + 6 dígitos do CPF)
//   O QSA público traz o CPF do sócio MASCARADO (`***.XYZ.WV*-**` — só os 6 dígitos do
//   meio, posições 4–9, ficam visíveis). Com o CPF completo do devedor em mãos, batemos
//   esses 6 dígitos contra o taxId mascarado de cada candidato retornado pela busca por
//   nome — o nome reduz os candidatos e os 6 dígitos eliminam homônimos.
//
// GATED (mesmo padrão do api/_serasa.js): sem CNPJA_TOKEN configurado, devolve
//   { pendente:true, ... } com 200 — o front mostra o aviso e o link da Casa dos Dados.
//   As URLs são sobrescrevíveis por env p/ ajustar ao contrato sem mexer no código.
//
// Envs (Vercel):
//   CNPJA_TOKEN      — token da API Comercial do CNPJá (Authorization: Bearer)
//   CNPJA_BASE_URL   — base da API (default https://api.cnpja.com)
//
// Auth: usuário Supabase logado (requireUser). Método: GET ou POST.
//   Query/body: { nome, cpf }  →  { ok:true, empresas:[{cnpj, nome, papel, confere}] }

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');

const BASE = (process.env.CNPJA_BASE_URL || 'https://api.cnpja.com').replace(/\/+$/, '');

function onlyDigits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

// Os 6 dígitos visíveis (meio) de um CPF de 11 dígitos: posições 4–9 (0-based 3..8).
function mioloCpf(cpf) { const d = onlyDigits(cpf); return d.length === 11 ? d.slice(3, 9) : ''; }

// Extrai os dígitos presentes de um CPF mascarado ("***.456.789-**" → "456789").
function digitosMascara(masc) { return String(masc == null ? '' : masc).replace(/\D/g, ''); }

// Confere se o miolo do CPF do devedor aparece no CPF (mascarado) do sócio retornado.
function confereMiolo(cpfDevedor, taxIdSocio) {
  const miolo = mioloCpf(cpfDevedor);
  if (!miolo) return false;
  const socio = digitosMascara(taxIdSocio);
  return !!socio && socio.includes(miolo);
}

function normNome(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return; // requireUser já respondeu 401/5xx

  const src = req.method === 'POST'
    ? (typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {}))
    : (req.query || {});
  const nome = String(src.nome || '').trim();
  const cpf = onlyDigits(src.cpf);

  if (!nome) return res.status(400).json({ error: 'Informe o nome completo do devedor.' });
  if (cpf && cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido (11 dígitos).' });

  // 1) FONTE GRATUITA: base pública da Receita Federal carregada no Supabase (rf_socios),
  //    consultada pela RPC buscar_empresas_por_socio. Se a migração/carga ainda não foi
  //    feita (import_cnpj_rf.py), a RPC falha → cai no CNPJá pago (fallback) abaixo.
  try {
    const rows = await sbFetch('rpc/buscar_empresas_por_socio', {
      method: 'POST',
      body: JSON.stringify({ p_nome: nome, p_cpf: cpf || null }),
    });
    if (Array.isArray(rows)) {
      const empresas = rows.map((r) => ({
        cnpj: onlyDigits(r.cnpj),
        nome: r.nome || '',
        papel: r.papel || '',
        confere: (r.confere === true || r.confere === false) ? r.confere : null,
      })).filter((e) => e.cnpj);
      return res.status(200).json({ ok: true, fonte: 'Receita Federal (Supabase)', empresas, total: empresas.length });
    }
  } catch (e) {
    // RPC/tabela ausente ou Supabase indisponível — segue para o CNPJá pago (fallback).
    console.warn('[cnpja] RPC Supabase indisponível, tentando CNPJá:', e && e.message);
  }

  // 2) FALLBACK PAGO: API Comercial do CNPJá (busca por sócio), gated por CNPJA_TOKEN.
  const token = process.env.CNPJA_TOKEN || '';
  if (!token) {
    // Sem base local nem token pago: orienta o operador a usar a busca manual gratuita.
    return res.status(200).json({
      pendente: true,
      motivo: 'CNPJA_TOKEN não configurada no servidor.',
      hint: 'Defina CNPJA_TOKEN (API Comercial do CNPJá) no painel da Vercel para ligar a busca automática por sócio.',
      fallbackUrl: 'https://casadosdados.com.br/solucao/cnpj/busca-avancada?socio=' + encodeURIComponent(nome),
    });
  }

  // ── Busca por sócio na API Comercial do CNPJá ──────────────────────────────
  // ADAPTAR AO CONTRATO REAL: o endpoint /office aceita filtros de busca; o filtro por
  // nome de sócio é `members.person.name`. Confirme os nomes exatos dos parâmetros na
  // referência (https://cnpja.com/api/reference) — deixados aqui em env-fallback.
  const paramNome = process.env.CNPJA_PARAM_SOCIO || 'members.person.name';
  const qs = new URLSearchParams();
  qs.set(paramNome, nome);
  qs.set('limit', '30');
  const url = `${BASE}/office?${qs.toString()}`;

  try {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) {
      return res.status(502).json({ error: 'CNPJá recusou a consulta (HTTP ' + r.status + ').', detalhes: data });
    }

    // A resposta comercial pagina em `records` (ou `offices`/array direto conforme plano).
    const registros = Array.isArray(data) ? data
      : (data.records || data.offices || data.data || []);
    const alvoNome = normNome(nome);

    const empresas = (registros || []).map((of) => {
      const company = of.company || of;
      const membros = (company.members || of.members || []);
      // Localiza o sócio que bate com o devedor (nome + 6 dígitos do CPF, quando houver).
      const socio = membros.find((m) => {
        const p = (m && m.person) || m || {};
        const bateNome = normNome(p.name).includes(alvoNome) || alvoNome.includes(normNome(p.name));
        const bateCpf = cpf ? confereMiolo(cpf, p.taxId || p.tax_id) : true;
        return bateNome && bateCpf;
      });
      const cnpj = onlyDigits(of.taxId || of.tax_id || of.cnpj || (of.office && of.office.cnpj));
      return {
        cnpj,
        nome: company.name || company.razao_social || of.alias || '',
        papel: (socio && socio.role && (socio.role.text || socio.role)) || '',
        // confere=true só quando o miolo do CPF confirmou a identidade (sem homônimo).
        confere: cpf ? !!(socio && confereMiolo(cpf, (socio.person || socio).taxId || (socio.person || socio).tax_id)) : null,
      };
    }).filter((e) => e.cnpj);

    return res.status(200).json({ ok: true, empresas, total: empresas.length });
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao consultar o CNPJá: ' + (e && e.message || e) });
  }
};
