// Lógica pura do vigia de ações (sem Deno, sem rede) — importada pela Edge
// Function e pelo teste test/f46_vigia_acoes_logica.test.js.
//
// Três armadilhas medidas na API do DJEN em 25/09/2026 que moldam este arquivo:
//  1) `nomeParte` casa por PREFIXO/"contém": "Adilson Ferreira" devolveu 156
//     comunicações em 3 dias, das quais só 14 eram de "ADILSON FERREIRA" — o resto
//     era "… DA SILVA", "… DOS SANTOS", etc. Por isso o casamento é refeito aqui,
//     nome a nome, contra `destinatarios[].nome`.
//  2) A API não traz CPF/CNPJ: nome igual NÃO prova que é o mesmo devedor. A tela
//     mostra o achado para conferência manual (homônimo = "descartado").
//  3) Nome de cadastro vem sujo ("50.677.114 Fulano (MEI)", "Fulano | Design Gesso"):
//     sem limpar, a busca não acha nada.

// Advogados do escritório (Gustavo, Ana Clara) — processo com um deles é NOSSO.
export const OABS_NOSSAS = ['112743/PR', '119424/PR'];
// Parte com um destes nomes = processo da casa (COBRASQ autora / cessionária).
const RE_NOSSA_PARTE = /\bCOBRASQ\b|TEIXEIRA\s*(E|&)?\s*AZZOLIN/;

// Sufixos societários ignorados na comparação ("… LTDA" x "… LTDA - ME").
const SUFIXOS = new Set(['LTDA', 'ME', 'EPP', 'EIRELI', 'MEI', 'SA', 'S', 'A', 'SS', 'SLU']);

export function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' E ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Chave de comparação: normalizado, sem sufixo societário no fim.
export function chaveNome(s) {
  const t = normalizar(s).split(' ').filter(Boolean);
  while (t.length > 2 && SUFIXOS.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

// Nome do cadastro → texto que vai para a API (ou motivo para não buscar).
export function nomeDeBusca(nomeCadastro) {
  let s = String(nomeCadastro ?? '');
  s = s.split('|')[0];                              // "Fulano | Nome fantasia"
  { const c = s.split(/\s+[—–-]\s+/)[0];            // "Fulano LTDA - Lojas X", "… — filial"
    if (c.trim().split(/\s+/).length >= 2) s = c; }  // ("AT - Empreiteira…" fica inteiro)
  // "SS Funilaria / 54.687.183 Fulano": fica o trecho com o CNPJ do MEI (é a pessoa)
  if (s.includes('/')) { const p = s.split('/'); s = p.find(x => /^\s*\d{2}\.\d{3}\.\d{3}\s/.test(x)) || p[0]; }
  s = s.replace(/\([^)]*\)/g, ' ');                 // "(MEI)", "(espólio)", "(resp. por …)"
  s = s.replace(/["“”][^"“”]*["“”]/g, ' ');         // apelido: Claudemir Mattei "Peixe"
  s = s.replace(/^[\s\d.\-\/]+(?=[A-Za-zÀ-ú])/, ''); // "50.677.114 Fulano" (CNPJ do MEI na frente)
  s = s.replace(/[\s\d.\-\/]+$/, '');               // "Fulano 07238395908" (CPF no fim), "Fulano."
  s = s.replace(/\s+/g, ' ').trim();
  const palavras = normalizar(s).split(' ').filter(w => w.length > 1);
  if (palavras.length < 2 || s.length < 8) return { busca: null, motivo: 'nome_curto' };
  return { busca: s, motivo: null };
}

// O destinatário é o devedor? Igualdade de chave, ou "X REPRESENTADO(A) POR <nome>".
export function destinatarioCasa(nomeDest, chaveDevedor) {
  const c = chaveNome(nomeDest);
  if (!c || !chaveDevedor) return false;
  if (c === chaveDevedor) return true;
  return c.endsWith(' POR ' + chaveDevedor);
}

function soDigitos(v) { return String(v ?? '').replace(/\D/g, ''); }

// ---------------------------------------------------------------------------
// Filtro por UF (decisão do Gustavo, 25/09/2026): "nosso processo for no
// Paraná, corta por Paraná". A UF do NOSSO processo (J.TR do CNJ; sem CNJ, a UF
// do cadastro do devedor, depois a do credor, depois PR) define quais tribunais
// valem: o TJ, o(s) TRT e o TRF daquela UF. Achado fora deles é descartado
// (`fora_da_uf`); SEEU, STF, STJ, TST, eleitoral e militar também (`outro_ramo`).
// ---------------------------------------------------------------------------
const UF_TJ = ['', 'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR',
               'PE','PI','RJ','RN','RS','RO','RR','SC','SE','SP','TO']; // J=8, TR 01..27
const UF_TRT = { 1:['RJ'], 2:['SP'], 3:['MG'], 4:['RS'], 5:['BA'], 6:['PE'], 7:['CE'], 8:['PA','AP'],
  9:['PR'], 10:['DF','TO'], 11:['AM','RR'], 12:['SC'], 13:['PB'], 14:['RO','AC'], 15:['SP'], 16:['MA'],
  17:['ES'], 18:['GO'], 19:['AL'], 20:['SE'], 21:['RN'], 22:['PI'], 23:['MT'], 24:['MS'] };
const UF_TRF = { 1:['AC','AM','AP','BA','DF','GO','MA','PA','PI','RO','RR','TO'], 2:['RJ','ES'],
  3:['SP','MS'], 4:['RS','SC','PR'], 5:['PE','AL','CE','PB','RN','SE'], 6:['MG'] };
export const UFS = new Set(UF_TJ.filter(Boolean));

// UFs abrangidas pelo tribunal do CNJ (20 dígitos). [] = ramo que não vigiamos.
export function ufsDoCNJ(dig) {
  const d = soDigitos(dig);
  if (d.length !== 20) return [];
  const j = d[13], tr = Number(d.slice(14, 16));
  if (j === '8') return UF_TJ[tr] ? [UF_TJ[tr]] : [];
  if (j === '5') return UF_TRT[tr] || [];      // TR 00 = TST
  if (j === '4') return UF_TRF[tr] || [];
  return [];                                    // 1 STF, 3 STJ, 6 eleitoral, 7/9 militar
}

// UF do nosso processo, na ordem: CNJ (se aponta UMA UF) → devedor → credor → PR.
export function ufReferencia({ cnj, ufDevedor, ufCredor } = {}) {
  const u = ufsDoCNJ(cnj);
  if (u.length === 1) return { uf: u[0], fonte: 'cnj' };
  for (const [v, fonte] of [[ufDevedor, 'devedor'], [ufCredor, 'credor']]) {
    const x = String(v ?? '').trim().toUpperCase();
    if (UFS.has(x)) return { uf: x, fonte };
  }
  return { uf: 'PR', fonte: 'padrao' };
}

// O achado (CNJ + sigla do tribunal) está na UF de referência?
// `uf`: uma UF ou lista (executado do escritório com processos em mais de uma UF).
export function motivoForaDaUF(digAchado, siglaTribunal, uf) {
  if (/^(SEEU|STF|STJ|TST|TSE|STM)$/i.test(String(siglaTribunal || '').trim())) return 'outro_ramo';
  const ufs = ufsDoCNJ(digAchado);
  if (!ufs.length) return 'outro_ramo';
  const ref = Array.isArray(uf) ? uf : [uf];
  return ufs.some(u => ref.includes(u)) ? null : 'fora_da_uf';
}

// Processo da casa? (advogado nosso, parte COBRASQ/T&A, ou CNJ já cadastrado em cobrancas)
export function ehProcessoNosso(item, cnjsNossos) {
  const dig = soDigitos(item?.numero_processo || item?.numeroprocessocommascara);
  if (dig && cnjsNossos && cnjsNossos.has(dig)) return 'cnj_cadastrado';
  const oabs = new Set(OABS_NOSSAS.map(o => { const [n, uf] = o.split('/'); return `${soDigitos(n)}/${uf}`; }));
  for (const a of (Array.isArray(item?.destinatarioadvogados) ? item.destinatarioadvogados : [])) {
    const adv = a?.advogado || a || {};
    const k = `${soDigitos(adv.numero_oab)}/${String(adv.uf_oab || '').toUpperCase()}`;
    if (oabs.has(k)) return 'advogado_nosso';
  }
  for (const d of (Array.isArray(item?.destinatarios) ? item.destinatarios : [])) {
    if (RE_NOSSA_PARTE.test(normalizar(d?.nome))) return 'parte_nossa';
  }
  return null;
}

export function formatarCNJ(d) {
  return d.length === 20 ? `${d.slice(0,7)}-${d.slice(7,9)}.${d.slice(9,13)}.${d.slice(13,14)}.${d.slice(14,16)}.${d.slice(16,20)}` : d;
}

function dataISO(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// Itens da API para UM devedor → achados agrupados por processo.
// `uf` (opcional): UF de referência (ufReferencia) — achado de outro tribunal cai.
// Devolve { achados: [...], descartados: { nome_diferente, nosso, sem_cnj, fora_da_uf, outro_ramo } }.
export function agruparAchados(itens, nomeDevedor, cnjsNossos, uf = null) {
  const chave = chaveNome(nomeDeBusca(nomeDevedor).busca || nomeDevedor);
  const porProc = new Map();
  const desc = { nome_diferente: 0, nosso: 0, sem_cnj: 0, fora_da_uf: 0, outro_ramo: 0 };
  for (const it of (itens || [])) {
    const dests = Array.isArray(it?.destinatarios) ? it.destinatarios : [];
    const meu = dests.filter(d => destinatarioCasa(d?.nome, chave));
    if (!meu.length) { desc.nome_diferente++; continue; }
    if (ehProcessoNosso(it, cnjsNossos)) { desc.nosso++; continue; }
    const dig = soDigitos(it.numero_processo || it.numeroprocessocommascara);
    if (dig.length !== 20) { desc.sem_cnj++; continue; }
    if (uf && uf.length) { const m = motivoForaDaUF(dig, it.siglaTribunal, uf); if (m) { desc[m]++; continue; } }
    const data = dataISO(it.data_disponibilizacao) || dataISO(it.datadisponibilizacao);
    const polo = meu.some(d => d.polo === 'A') ? 'A' : (meu.some(d => d.polo === 'P') ? 'P' : null);
    let a = porProc.get(dig);
    if (!a) {
      a = {
        digitos: dig, numero_processo: formatarCNJ(dig), polo,
        nome_encontrado: meu[0].nome,
        tribunal: it.siglaTribunal || null, classe: it.nomeClasse || null, orgao: it.nomeOrgao || null,
        link: it.link || null, primeira_data: data, ultima_data: data,
        comunicacoes: [], partes: [], advogados: [], ultimo_texto: null,
      };
      porProc.set(dig, a);
    }
    if (polo === 'A') a.polo = 'A'; else if (!a.polo) a.polo = polo;
    if (data && (!a.primeira_data || data < a.primeira_data)) a.primeira_data = data;
    if (data && (!a.ultima_data || data >= a.ultima_data)) {
      a.ultima_data = data;
      a.link = it.link || a.link;
      a.ultimo_texto = String(it.texto || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200) || a.ultimo_texto;
    }
    if (it.id != null && !a.comunicacoes.includes(String(it.id))) a.comunicacoes.push(String(it.id));
    for (const d of dests) {
      if (!a.partes.some(p => p.nome === d.nome && p.polo === d.polo)) a.partes.push({ nome: d.nome, polo: d.polo });
    }
    for (const x of (Array.isArray(it.destinatarioadvogados) ? it.destinatarioadvogados : [])) {
      const adv = x?.advogado || {};
      const k = `${adv.nome || ''} (OAB ${adv.numero_oab || '?'}/${adv.uf_oab || '?'})`;
      if (adv.nome && !a.advogados.includes(k)) a.advogados.push(k);
    }
  }
  return { achados: [...porProc.values()], descartados: desc };
}

// "Creative Soluções Visuais Ltda; Wesley Cechin Gobatto" (intimacoes_email.executado)
// → um nome por pessoa; parte da casa (COBRASQ/T&A) fica de fora.
export function nomesExecutados(campo) {
  return String(campo ?? '').split(/;|,(?!\s*(?:S\.?\s*A|ME|EPP|LTDA)\b)/i)
    .map(x => x.replace(/\s+/g, ' ').trim())
    .filter(x => x && !RE_NOSSA_PARTE.test(normalizar(x)));
}

// Linhas de vw_vigia_acoes_universo → alvos de busca (1 por pessoa).
//   cobrasq    → alvo 'dev:<devedor_id>', UF por ufReferencia (CNJ → devedor → credor → PR)
//   escritorio → o campo executado ("A; B") vira um alvo por nome, 'esc:<chave>',
//                UF(s) do CNJ dos nossos processos; quem já é devedor COBRASQ fica só lá.
export function montarAlvos(linhas) {
  const alvos = new Map(); const chavesCob = new Set();
  for (const r of (linhas || []).filter(r => r.origem !== 'escritorio')) {
    const ref = ufReferencia({ cnj: r.processo_ref, ufDevedor: r.uf_devedor, ufCredor: r.uf_credor });
    alvos.set('dev:' + r.devedor_id, { alvo: 'dev:' + r.devedor_id, origem: 'cobrasq', devedor_id: r.devedor_id,
      cobranca_id: r.cobranca_id || null, nome: r.nome, processo_ref: soDigitos(r.processo_ref).length === 20 ? formatarCNJ(soDigitos(r.processo_ref)) : null,
      ufs: [ref.uf], uf_fonte: ref.fonte });
    chavesCob.add(chaveNome(nomeDeBusca(r.nome).busca || r.nome));
  }
  for (const r of (linhas || []).filter(r => r.origem === 'escritorio')) {
    const dig = soDigitos(r.processo_ref);
    const ufsProc = ufsDoCNJ(dig);
    const ufs = ufsProc.length === 1 ? ufsProc : ['PR'];
    for (const nome of nomesExecutados(r.nome)) {
      const chave = chaveNome(nomeDeBusca(nome).busca || nome);
      if (!chave || chavesCob.has(chave)) continue;
      const k = 'esc:' + chave;
      const a = alvos.get(k);
      if (a) { for (const u of ufs) if (!a.ufs.includes(u)) a.ufs.push(u); continue; }
      alvos.set(k, { alvo: k, origem: 'escritorio', devedor_id: null, cobranca_id: null, nome,
        processo_ref: dig.length === 20 ? formatarCNJ(dig) : null, ufs: [...ufs], uf_fonte: 'cnj' });
    }
  }
  return [...alvos.values()];
}
