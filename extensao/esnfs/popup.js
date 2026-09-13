/* =============================================================================
 *  popup.js — formulário de tomadores (uma caixa por dado) e disparo do lote.
 *
 *  Por linha só se pede CPF/CNPJ e valor: o nome e o endereço vêm do próprio
 *  ESNFS ao pesquisar o documento. Os campos extras existem para o caso —
 *  comum — de o cadastro não existir ou vir sem endereço.
 * ========================================================================== */

const KEY = 'nfseJob';
const CFG_KEY = 'nfseCfg';
const EDIT_PATH = '/nfsemissao.edit.logic';

const PADRAO = {
  aliquota: '2,01',
  servicoValue: '32761',
  servicoMatch: '17.22.01.000',
  discriminacao:
    'Serviços de cobrança e recuperação de crédito prestados ao tomador, referentes ao acompanhamento e à intermediação do recebimento de valores inadimplidos.',
  // usado quando o ESNFS não traz o endereço do tomador
  endereco: {
    logradouro: 'Endereço desconhecido',
    numero: '0',
    bairro: 'Endereço desconhecido',
    cep: '85660000',
    uf: 'PR',
    cidade: 'Dois Vizinhos',
  },
};

const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];

const $ = (id) => document.getElementById(id);
const onlyDigits = (s) => String(s || '').replace(/\D+/g, '');

/* ------------------------------------------------------------- validações */

function cpfValido(d) {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += +d[i] * (10 - i);
  let r = (s * 10) % 11 % 10;
  if (r !== +d[9]) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += +d[i] * (11 - i);
  r = (s * 10) % 11 % 10;
  return r === +d[10];
}

function cnpjValido(d) {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (base, pesos) => {
    const s = base.split('').reduce((a, n, i) => a + +n * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(d.slice(0, 12), [5,4,3,2,9,8,7,6,5,4,3,2]) === +d[12] &&
         calc(d.slice(0, 13), [6,5,4,3,2,9,8,7,6,5,4,3,2]) === +d[13];
}

function toBRL(v) {
  let s = String(v || '').trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}(\D|$)/.test(s)) s = s.replace(/\./g, '');
  else s = s.replace(/,/g, '.');
  const n = parseFloat(s);
  if (!isFinite(n) || n <= 0) return null;
  return n.toFixed(2).replace('.', ',');
}

function formatDoc(d) {
  d = onlyDigits(d);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

/** Máscara progressiva enquanto digita, sem atrapalhar o apagar. */
function mascaraDoc(v) {
  const d = onlyDigits(v).slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/^(\d{0,3})(\d{0,3})(\d{0,3})(\d{0,2}).*/, (m, a, b, c, e) =>
      a + (b ? '.' + b : '') + (c ? '.' + c : '') + (e ? '-' + e : ''));
  }
  return d.replace(/^(\d{0,2})(\d{0,3})(\d{0,3})(\d{0,4})(\d{0,2}).*/, (m, a, b, c, e, f) =>
    a + (b ? '.' + b : '') + (c ? '.' + c : '') + (e ? '/' + e : '') + (f ? '-' + f : ''));
}

/* ------------------------------------------------------- linhas de tomador */

const linhas = () => Array.from($('linhas').children);

function novaLinha(dados) {
  const el = $('tplLinha').content.firstElementChild.cloneNode(true);
  const q = (c) => el.querySelector('.' + c);

  q('fDoc').addEventListener('input', (e) => {
    const alvo = e.target;
    const fim = alvo.selectionStart === alvo.value.length;
    alvo.value = mascaraDoc(alvo.value);
    if (fim) alvo.setSelectionRange(alvo.value.length, alvo.value.length);
    revisar();
  });
  // colar várias linhas de uma planilha vira várias linhas do formulário
  q('fDoc').addEventListener('paste', (e) => {
    const t = (e.clipboardData || window.clipboardData).getData('text') || '';
    if (!/[\n\r\t|;]/.test(t)) return;
    e.preventDefault();
    absorverColagem(t, el);
  });
  q('fVal').addEventListener('input', revisar);
  q('fVal').addEventListener('blur', (e) => {
    const b = toBRL(e.target.value);
    if (b) e.target.value = b;
    revisar();
  });
  ['fNome','fTel','fMail','fLog','fNum','fBai','fCep','fCid'].forEach((c) =>
    q(c).addEventListener('input', revisar));

  q('bMais').addEventListener('click', () => {
    const box = q('linMais');
    box.classList.toggle('hidden');
    q('bMais').classList.toggle('on', !box.classList.contains('hidden'));
    q('bMais').textContent = box.classList.contains('hidden') ? '⌄' : '⌃';
  });
  q('bDel').addEventListener('click', () => {
    el.remove();
    if (!linhas().length) addLinha();
    revisar();
  });

  if (dados) {
    el.dataset.ref = dados.ref || '';
    q('fDoc').value = dados.doc || '';
    q('fVal').value = dados.valor || '';
    q('fNome').value = dados.nome || '';
    q('fTel').value = dados.tel || '';
    q('fMail').value = dados.mail || '';
    if (dados.nome || dados.tel || dados.mail) {
      q('linMais').classList.remove('hidden');
      q('bMais').classList.add('on');
      q('bMais').textContent = '⌃';
    }
  }
  return el;
}

function addLinha(dados, focar) {
  const el = novaLinha(dados);
  $('linhas').appendChild(el);
  if (focar) el.querySelector('.fDoc').focus();
  revisar();
  return el;
}

/** Texto colado de planilha/lista → preenche a linha atual e cria as demais. */
function absorverColagem(texto, linhaAtual) {
  const regs = texto.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let alvo = linhaAtual;
  regs.forEach((l, i) => {
    const c = l.split(/\s*[|;\t]\s*/);
    // aceita "CPF | Valor" e também "Nome | CPF | Valor". Um 4º campo (3º, sem nome) é
    // a REF do painel COBRASQ ("fila:<uuid>" / "manual:<id>"): não aparece na tela,
    // mas volta no relatório para o painel casar a nota emitida com a linha certa.
    let doc, valor, nome = '', ref = '';
    if (onlyDigits(c[0]).length >= 11) { doc = c[0]; valor = c[1]; ref = c[2] || ''; }
    else { nome = c[0] || ''; doc = c[1]; valor = c[2]; ref = c[3] || ''; }
    if (!/^(fila|manual|op):/.test(ref)) ref = '';
    const d = { doc: formatDoc(doc), valor: toBRL(valor) || (valor || '').trim(), nome, ref };
    if (i === 0 && alvo) {
      alvo.querySelector('.fDoc').value = d.doc;
      alvo.querySelector('.fVal').value = d.valor;
      alvo.dataset.ref = ref;
      if (nome) {
        alvo.querySelector('.fNome').value = nome;
        alvo.querySelector('.linMais').classList.remove('hidden');
        alvo.querySelector('.bMais').classList.add('on');
        alvo.querySelector('.bMais').textContent = '⌃';
      }
    } else {
      addLinha(d);
    }
  });
  revisar();
}

/* -------------------------------------------------------------- leitura */

function parseCidadeUf(txt) {
  const t = String(txt || '').trim();
  if (!t) return {};
  const m = t.match(/^(.*?)[\s,\/-]+([A-Za-z]{2})$/);
  if (m && UFS.includes(m[2].toUpperCase())) return { cidade: m[1].trim(), uf: m[2].toUpperCase() };
  return { cidade: t };
}

function lerLinha(el) {
  const q = (c) => el.querySelector('.' + c).value.trim();
  const cid = parseCidadeUf(q('fCid'));
  const end = {
    logradouro: q('fLog'),
    numero: q('fNum'),
    bairro: q('fBai'),
    cep: onlyDigits(q('fCep')),
    cidade: cid.cidade || '',
    uf: cid.uf || '',
  };
  const temEnd = Object.values(end).some(Boolean);

  const it = {
    el,
    nome: q('fNome'),
    cpf: onlyDigits(q('fDoc')),
    valorBRL: toBRL(q('fVal')),
    telefone: onlyDigits(q('fTel')),
    email: q('fMail'),
    endereco: temEnd ? end : null,
    ref: el.dataset.ref || '',
    vazia: !q('fDoc') && !q('fVal'),
    erros: [],
    avisos: [],
  };

  if (it.vazia) return it;
  if (!it.cpf) it.erros.push('informe o CPF/CNPJ');
  else if (it.cpf.length === 11 && !cpfValido(it.cpf)) it.erros.push('CPF inválido');
  else if (it.cpf.length === 14 && !cnpjValido(it.cpf)) it.erros.push('CNPJ inválido');
  else if (it.cpf.length !== 11 && it.cpf.length !== 14) it.erros.push('documento incompleto');
  if (!it.valorBRL) it.erros.push('informe o valor');
  if (it.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(it.email)) {
    it.avisos.push('e-mail com formato estranho — será ignorado');
    it.email = '';
  }
  if (it.telefone && (it.telefone.length < 10 || it.telefone.length > 13)) {
    it.avisos.push('telefone com quantidade de dígitos incomum');
  }
  if (it.endereco && !it.endereco.cep) it.avisos.push('endereço sem CEP — usará o CEP padrão');
  return it;
}

function revisar() {
  const itens = linhas().map(lerLinha);
  const validos = itens.filter((i) => !i.vazia);

  const vistos = new Map();
  validos.forEach((it, i) => {
    if (!it.cpf) return;
    if (vistos.has(it.cpf)) it.avisos.push(`mesmo documento da linha ${vistos.get(it.cpf) + 1}`);
    else vistos.set(it.cpf, i);
  });

  itens.forEach((it, i) => {
    it.el.querySelector('.num').textContent = it.vazia ? '·' : String(validos.indexOf(it) + 1);
    const doc = it.el.querySelector('.fDoc');
    const val = it.el.querySelector('.fVal');
    doc.classList.toggle('ruim', it.erros.some((e) => /CPF|CNPJ|documento/.test(e)));
    val.classList.toggle('ruim', it.erros.some((e) => /valor/.test(e)));
    const err = it.el.querySelector('.linErr');
    err.textContent = it.erros.join(' · ') || it.avisos.join(' · ');
    err.classList.toggle('aviso2', !it.erros.length && !!it.avisos.length);
  });

  const comErro = validos.filter((i) => i.erros.length).length;
  const soma = validos.reduce(
    (a, i) => a + (i.valorBRL ? parseFloat(i.valorBRL.replace(/\./g, '').replace(',', '.')) : 0), 0);
  $('resumo').textContent = validos.length
    ? `${validos.length} NF(s) · total R$ ${soma.toFixed(2).replace('.', ',')}` +
      (comErro ? ` · ${comErro} com erro` : '')
    : 'nenhum tomador ainda';
  $('iniciar').disabled = !validos.length || comErro > 0;
  return validos;
}

/* ------------------------------------------------------------ config UI */

function lerCfg() {
  return {
    aliquota: $('aliquota').value.trim() || PADRAO.aliquota,
    servicoValue: $('servicoValue').value.trim() || PADRAO.servicoValue,
    servicoMatch: $('servicoMatch').value.trim() || PADRAO.servicoMatch,
    discriminacao: $('discriminacao').value.trim() || PADRAO.discriminacao,
    endereco: {
      logradouro: $('eLog').value.trim() || PADRAO.endereco.logradouro,
      numero: $('eNum').value.trim() || PADRAO.endereco.numero,
      bairro: $('eBai').value.trim() || PADRAO.endereco.bairro,
      cep: onlyDigits($('eCep').value) || PADRAO.endereco.cep,
      uf: ($('eUf').value.trim() || PADRAO.endereco.uf).toUpperCase(),
      cidade: $('eCid').value.trim() || PADRAO.endereco.cidade,
    },
    confirmMode: $('confirmEach').checked ? 'each' : $('confirmFirst').checked ? 'first' : 'none',
    dryRun: $('dryRun').checked,
  };
}

function aplicarCfg(c) {
  $('aliquota').value = c.aliquota;
  $('servicoValue').value = c.servicoValue;
  $('servicoMatch').value = c.servicoMatch;
  $('discriminacao').value = c.discriminacao;
  $('eLog').value = c.endereco.logradouro;
  $('eNum').value = c.endereco.numero;
  $('eBai').value = c.endereco.bairro;
  $('eCep').value = c.endereco.cep;
  $('eUf').value = c.endereco.uf;
  $('eCid').value = c.endereco.cidade;
}

/* --------------------------------------------------------------- ações */

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function abaEsnfs() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /esnfs\.com\.br$/i.test(new URL(tab.url || 'https://x.invalid').hostname)) return tab;
  const todas = await chrome.tabs.query({ url: ['https://*.esnfs.com.br/*', 'https://esnfs.com.br/*'] });
  return todas[0] || null;
}

async function iniciar() {
  const itens = revisar();
  if (!itens.length) return setStatus('Adicione pelo menos um tomador.', 'err');
  if (itens.some((i) => i.erros.length)) return setStatus('Corrija os campos em vermelho antes de iniciar.', 'err');

  const tab = await abaEsnfs();
  if (!tab) {
    $('aviso').textContent =
      'Abra o ESNFS em uma aba e faça login antes de iniciar. A automação usa a sessão que já está logada no navegador.';
    $('aviso').classList.remove('hidden');
    return setStatus('Nenhuma aba do ESNFS encontrada.', 'err');
  }

  const cfg = lerCfg();
  await chrome.storage.local.set({ [CFG_KEY]: cfg });

  const queue = itens.map((i) => ({
    nome: i.nome,
    cpf: i.cpf,
    valor: i.valorBRL,
    valorBRL: i.valorBRL,
    telefone: i.telefone,
    email: i.email,
    endereco: i.endereco,
    ref: i.ref || '',
  }));

  await chrome.storage.local.set({
    [KEY]: {
      running: true, paused: false, pauseReason: '', phase: 'running',
      index: 0, queue, results: [], cfg, navTries: 0, startedAt: Date.now(),
    },
  });

  const origem = new URL(tab.url).origin;
  await chrome.tabs.update(tab.id, { url: origem + EDIT_PATH, active: true });
  setStatus(`Iniciado: ${queue.length} NF(s). Acompanhe pelo painel no canto da página.`, 'ok');
  setTimeout(() => window.close(), 900);
}

async function verRelatorio() {
  const { [KEY]: st } = await chrome.storage.local.get(KEY);
  if (!st || !st.results || !st.results.length) return setStatus('Ainda não há resultados.', 'err');
  const ok = st.results.filter((r) => r.status === 'ok').length;
  const soma = st.results
    .filter((r) => r.status === 'ok')
    .reduce((a, r) => a + (parseFloat(String(r.valor).replace(/\./g, '').replace(',', '.')) || 0), 0);
  const linhasTxt = st.results.map((r, i) =>
    `${i + 1}. ${r.nome || '(nome do cadastro)'} — ${formatDoc(r.cpf)} — R$ ${r.valor} — ${
      r.status === 'ok' ? 'emitida' + (r.nota ? ' (nº ' + r.nota + ')' : '') : 'FALHOU: ' + (r.obs || []).join('; ')
    }`);
  const txt =
    `Emissão de NFS-e — ${new Date(st.startedAt).toLocaleString('pt-BR')}\n\n` +
    linhasTxt.join('\n') +
    `\n\nEmitidas: ${ok}/${st.results.length} — Total: R$ ${soma.toFixed(2).replace('.', ',')}` +
    '\n\n' + blocoResultado(st.results);
  await navigator.clipboard.writeText(txt);
  setStatus(`Relatório copiado (${ok}/${st.results.length} emitidas).`, 'ok');
}

async function limpar() {
  await chrome.storage.local.remove(KEY);
  $('linhas').innerHTML = '';
  addLinha();
  setStatus('Formulário e resultados limpos.', 'ok');
}

/**
 * Bloco legível por máquina, no fim do relatório: é o que o painel COBRASQ
 * (Emitir NF → "Importar resultado do ESNFS") lê para marcar as notas emitidas.
 * Uma linha por NF: ref;status;nota;cpf;valor;nome;observações.
 */
function blocoResultado(results) {
  const limpo = (v) => String(v || '').replace(/[;\r\n]+/g, ' ').trim();
  const l = ['--- COBRASQ-RESULTADO v1 ---', 'ref;status;nota;cpf;valor;nome;obs'];
  (results || []).forEach((r) => {
    l.push([
      limpo(r.ref || (r.item && r.item.ref)), r.status === 'ok' ? 'ok' : 'erro', limpo(r.nota),
      onlyDigits(r.cpf), limpo(r.valor), limpo(r.nome), limpo((r.obs || []).join(' / ')),
    ].join(';'));
  });
  l.push('--- FIM ---');
  return l.join('\n');
}

/* ---------------------------------------------------------------- init */

/** Versão carregada agora — serve para confirmar que o Chrome pegou a build nova. */
function mostrarVersao() {
  try {
    const m = chrome.runtime.getManifest();
    $('ver').textContent = 'v' + (m.version_name || m.version);
  } catch (_) {
    $('ver').textContent = 'v?';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  mostrarVersao();
  const { [CFG_KEY]: cfg } = await chrome.storage.local.get(CFG_KEY);
  aplicarCfg(cfg || PADRAO);
  if (cfg) {
    $('confirmEach').checked = cfg.confirmMode === 'each';
    $('confirmFirst').checked = cfg.confirmMode !== 'none';
    $('dryRun').checked = !!cfg.dryRun;
  }

  addLinha();
  addLinha();
  addLinha();

  const { [KEY]: st } = await chrome.storage.local.get(KEY);
  if (st && st.running && st.phase !== 'done') {
    $('aviso').textContent =
      `Há um lote em andamento (${st.index}/${st.queue.length}). Use o painel na página do ESNFS para pausar, retomar ou parar. Iniciar um novo lote substitui o atual.`;
    $('aviso').classList.remove('hidden');
  } else if (st && st.phase === 'done') {
    const ok = st.results.filter((r) => r.status === 'ok').length;
    setStatus(`Último lote: ${ok}/${st.results.length} emitidas.`);
  }

  $('addLinha').addEventListener('click', () => addLinha(null, true));
  $('iniciar').addEventListener('click', iniciar);
  $('relatorio').addEventListener('click', verRelatorio);
  $('limpar').addEventListener('click', limpar);
  $('restaurar').addEventListener('click', (e) => { e.preventDefault(); aplicarCfg(PADRAO); });
  $('confirmEach').addEventListener('change', () => {
    if ($('confirmEach').checked) $('confirmFirst').checked = true;
  });

  // Enter no último campo cria a próxima linha
  $('linhas').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const lin = e.target.closest('.lin');
    if (lin && lin === $('linhas').lastElementChild) addLinha(null, true);
    else if (lin && lin.nextElementSibling) lin.nextElementSibling.querySelector('.fDoc').focus();
  });
});
