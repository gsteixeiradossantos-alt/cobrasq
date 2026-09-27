// Leitura pura (sem rede) das fontes da investigação: INPI, DataJud e texto das
// publicações do DJEN. Separada do index.ts para o teste F-49 rodar no Node.
//
// Formatos medidos em 26/09/2026:
// - INPI (busca.inpi.gov.br/pePI): HTML latin1. A busca de titular devolve uma
//   lista de titulares, cada um com link "…&pos=N" que abre as marcas dele na
//   mesma sessão. Pesquisado por NOME, o titular pessoa física vem com o CPF
//   inteiro colado ao nome ("FULANO DE TAL 12345678901"). Pesquisado por CPF, o
//   INPI não acha a pessoa: por isso pessoa física vai pelo nome.
// - Patentes: a âncora do número pode vir com o ">" só na linha seguinte.
// - DataJud: sem partes, advogados nem valor da causa.

const limpa = (s) => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const total = (html) => {
  const m = limpa(html).match(/Foram encontrad[oa]s (\d+)/);
  return m ? Number(m[1]) : 0;
};

// Linhas de resultado: <tr bgColor=…> até </tr>, células <td>…</td>.
function linhas(html) {
  const out = [];
  for (const tr of String(html).split(/<tr\s+bgColor\s*=/i).slice(1)) {
    const corpo = tr.split(/<\/tr>/i)[0];
    out.push({ bruto: corpo, tds: [...corpo.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]) });
  }
  return out;
}

export function inpiTitulares(html) {
  const out = [];
  for (const m of String(html).matchAll(/Action=searchMarca&(?:amp;)?tipoPesquisa=BY_CNPJ_NOME&(?:amp;)?pos=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const txt = limpa(m[2]);
    const doc = (txt.match(/(\d{14}|\d{11})\s*$/) || [])[1] || null;
    out.push({ pos: Number(m[1]), nome: doc ? txt.slice(0, -doc.length).trim() : txt, doc });
  }
  return out;
}

export function inpiMarcas(html) {
  const itens = [];
  for (const { bruto, tds } of linhas(html)) {
    if (!/Action=detail&(?:amp;)?CodPedido=/i.test(bruto) || tds.length < 8) continue;
    const titular = limpa(tds[6]);
    itens.push({
      numero: limpa(tds[0]), prioridade: limpa(tds[1]) || null,
      marca: (limpa(tds[3]).replace(/^-$/, '') || '(figurativa)'),
      situacao: limpa(tds[5]) || null,
      titular: titular.replace(/\s*\d{11,14}\s*$/, '') || null,
      classe: limpa(tds[7]) || null,
    });
  }
  return { total: total(html) || itens.length, itens };
}

export function inpiPatentes(html) {
  const itens = [];
  const fixo = String(html).replace(/class='visitado'(?!\s*>)/gi, "class='visitado'>");
  for (const { bruto, tds } of linhas(fixo)) {
    if (!/PatenteServletController\?Action=detail/i.test(bruto) || tds.length < 4) continue;
    itens.push({ pedido: limpa(tds[0]), deposito: limpa(tds[1]) || null, titulo: limpa(tds[2]) || null, ipc: limpa(tds[3]).replace(/^-$/, '') || null });
  }
  return { total: total(fixo) || itens.length, itens };
}

const chave = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Titular da busca do INPI é o alvo? Pessoa: CPF inteiro igual. Empresa: CNPJ
// igual. Sócio (QSA só mostra 6 dígitos): nome igual e os 6 dígitos do meio do
// CPF que o INPI mostra batem com os do QSA.
export function titularConfere(t, alvo) {
  const doc = String(t?.doc || '');
  if (alvo?.cpf) return doc === alvo.cpf;
  if (alvo?.cnpj) return doc === alvo.cnpj;
  if (alvo?.miolo) return doc.length === 11 && doc.slice(3, 9) === alvo.miolo && chave(t?.nome) === chave(alvo.nome);
  return false;
}

// Marca "viva": registro em vigor ou pedido ainda em andamento. Extinta,
// arquivada ou indeferida não é bem a penhorar.
export const marcaViva = (situacao) => {
  const s = String(situacao || '').toLowerCase();
  return /em vigor|aguardando|pedido|exame|sobrestad|publicad/.test(s) && !/extint|arquiv|indefer|cancelad|nul/.test(s);
};

// ── DataJud ────────────────────────────────────────────────────────────────
// Número CNJ NNNNNNN-DD.AAAA.J.TR.OOOO → índice público do tribunal.
const UF_TJ = ['', 'ac', 'al', 'ap', 'am', 'ba', 'ce', 'dft', 'es', 'go', 'ma', 'mt', 'ms', 'mg', 'pa', 'pb', 'pr', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc', 'se', 'sp', 'to'];
export function aliasDatajud(numero) {
  const d = String(numero ?? '').replace(/\D/g, '');
  if (d.length !== 20) return null;
  const j = d[13], tr = Number(d.slice(14, 16));
  if (j === '8' && UF_TJ[tr]) return 'api_publica_tj' + UF_TJ[tr];
  if (j === '5' && tr >= 1 && tr <= 24) return 'api_publica_trt' + tr;
  if (j === '4' && tr >= 1 && tr <= 6) return 'api_publica_trf' + tr;
  return null;
}

export function datajudResumo(src) {
  if (!src || typeof src !== 'object') return null;
  const movs = (Array.isArray(src.movimentos) ? src.movimentos : [])
    .filter(m => m && m.dataHora).sort((a, b) => String(b.dataHora).localeCompare(String(a.dataHora)));
  const ult = movs[0];
  return {
    classe: src.classe?.nome || null,
    assuntos: (Array.isArray(src.assuntos) ? src.assuntos : []).map(a => a?.nome).filter(Boolean).slice(0, 5),
    orgao: src.orgaoJulgador?.nome || null,
    grau: src.grau || null,
    ajuizamento: /^\d{8}/.test(String(src.dataAjuizamento || '')) ? String(src.dataAjuizamento).replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3')
      : (String(src.dataAjuizamento || '').slice(0, 10) || null),
    ultimo_andamento: ult ? { nome: ult.nome || null, data: String(ult.dataHora).slice(0, 10) } : null,
    andamentos: movs.length,
    sigilo: Number(src.nivelSigilo) || 0,
  };
}

// ── Texto das publicações do DJEN ──────────────────────────────────────────
// Palavra no texto que aponta bem, dinheiro ou paradeiro. É pista: a palavra
// pode estar numa lista de pedidos genéricos ou ter resultado negativo.
export const SINAIS = [
  { tipo: 'alvara', rotulo: 'Alvará / levantamento de valores', re: /alvar[áa]|levantamento d[eo]s? (valor|quantia|dep[óo]sito)/i },
  { tipo: 'bloqueio', rotulo: 'Bloqueio de dinheiro (Sisbajud)', re: /sisbajud|bacenjud|bloqueio (de|dos?) (valor|ativo|conta)|penhora on-?line/i },
  { tipo: 'veiculo', rotulo: 'Veículo (Renajud)', re: /renajud|ve[íi]culo|placa [a-z]{3}-?\d/i },
  { tipo: 'imovel', rotulo: 'Imóvel / matrícula', re: /im[óo]ve(l|is)\b|matr[íi]cula (n|sob)/i },
  { tipo: 'penhora', rotulo: 'Penhora', re: /penhor(a|ad[oa]s?)\b/i },
  { tipo: 'leilao', rotulo: 'Leilão / arrematação', re: /leil[ãa]o|hasta p[úu]blica|arremata/i },
  { tipo: 'acordo', rotulo: 'Acordo', re: /\bacordo\b/i },
  { tipo: 'renda', rotulo: 'Imposto de renda (Infojud)', re: /infojud|declara[çc][õoã](es|o) de (imposto|renda)/i },
  { tipo: 'desconsideracao', rotulo: 'Desconsideração da personalidade jurídica', re: /desconsidera[çc][ãa]o/i },
  { tipo: 'endereco', rotulo: 'Paradeiro (endereço novo ou não localizado)', re: /novo endere[çc]o|endere[çc]o atualizado|n[ãa]o (foi )?localizad|mudou-se|endere[çc]o (desconhecido|inexistente)/i },
];

const TRECHO = 170;
export function sinaisTexto(texto) {
  const t = limpa(texto);
  const out = [];
  for (const s of SINAIS) {
    const m = s.re.exec(t);
    if (!m) continue;
    const ini = Math.max(0, m.index - TRECHO), fim = Math.min(t.length, m.index + m[0].length + TRECHO);
    out.push({ tipo: s.tipo, rotulo: s.rotulo, trecho: (ini ? '…' : '') + t.slice(ini, fim).trim() + (fim < t.length ? '…' : '') });
  }
  return out;
}
