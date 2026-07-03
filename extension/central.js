// extension/central.js — Central de Peticionamento (página da extensão).
// Fluxo: (1) escolher pasta [1 caso = pasta com PDFs; lote = pasta-mãe com
// subpastas] → (2) extração por IA da peça principal (via background →
// /api/claude do app) → (3) revisão em grade editável → (4) fila de execução:
// abre o eproc numa aba e o content script roda as 5 etapas em modo AUTO.
//
// Travas: o 1º caso do lote SEMPRE para no Finalizar (validação humana);
// qualquer anomalia pausa o lote (Continuar / Pular caso / Cancelar);
// login/MFA é sempre do usuário, na página real do tribunal.
//
// A página serve os PDFs sob demanda ao content script (mensagem PEDIR_DOC),
// lendo dos handles da pasta — por isso ela deve FICAR ABERTA durante o lote.

const app = document.getElementById('app');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const digitos = (s) => String(s || '').replace(/\D/g, '');

// Defaults do escritório (mesmos do app) — a IA sobrescreve o que extrair.
const DEFAULTS = {
  comarca: 'Dois Vizinhos', rito: 'Juizado Especial Estadual', area: 'Juizado Especial Cível',
  classe: 'Procedimento do Juizado Especial Cível', assuntos: ['Perdas e Danos'],
  competencia: 'Matéria Residual', nivel_sigilo: '0', valor_causa: null,
  requerentes: [], requeridos: [],
};

// Tipos de documento do eproc (códigos reais do select da etapa 5; OUT exige observação).
const TIPOS_DOC = [
  [/inicial|peti[cç][aã]o/i, 'PETIÇÃO INICIAL', '1', false],
  [/procura[cç][aã]o/i, 'PROCURAÇÃO', null, false],
  [/contrato\s*social/i, 'CONTRATO SOCIAL', '321', false],
  [/c[aá]lculo/i, 'CÁLCULOS', '504', false],
  [/cess[aã]o|declara[cç][aã]o/i, 'DECLARAÇÃO', '52', false],
  [/cnpj/i, 'CNPJ', '314', false],
  [/cpf/i, 'CPF', '9', false],
  [/anexo/i, 'Anexo', '262', false],
  [/comprovante/i, 'COMPROVANTES', '176', false],
  [/contrato/i, 'CONTRATO', '40', false],
];
function classificarDoc(nome) {
  for (const [re, tipoTxt, selVal] of TIPOS_DOC) if (re.test(nome)) return { tipoTxt, selVal, obs: null };
  return { tipoTxt: 'OUTROS', selVal: '11', obs: nome.replace(/\.pdf$/i, '').slice(0, 90) };
}

// ── estado ─────────────────────────────────────────────────────────────────────
const state = {
  fase: 1,              // 1 pasta · 2 extração · 3 revisão · 4 execução
  pastaNome: '',
  casos: [],            // {id, nome, docs:[{nome,handle,tipoTxt,selVal,obs,principal,size}], dados, extracao:'pendente|ok|erro', erroExtracao, status:'aguardando|rodando|pausado|protocolado|pulado|erro', numero, statusTexto}
  atual: -1,
  tabId: null,
  primeiroValidado: false,
  rodando: false,
};

function pill(caso) {
  const map = { aguardando: ['p-cinza', 'aguardando'], rodando: ['p-azul', 'protocolando…'], pausado: ['p-amarelo', 'PAUSADO'], protocolado: ['p-verde', 'protocolado ✓'], pulado: ['p-cinza', 'pulado'], erro: ['p-verm', 'erro'] };
  const [cls, txt] = map[caso.status] || ['p-cinza', caso.status];
  return `<span class="pill ${cls}">${txt}</span>`;
}
function setPasso(n) {
  state.fase = n;
  document.querySelectorAll('#passos span').forEach(el => el.classList.toggle('on', +el.dataset.p === n));
}

// ── fase 1: ingestão ──────────────────────────────────────────────────────────
async function lerPdfsDaPasta(dirHandle) {
  const docs = [];
  for await (const [nome, h] of dirHandle.entries()) {
    if (h.kind === 'file' && /\.pdf$/i.test(nome)) {
      const f = await h.getFile();
      docs.push({ nome, handle: h, size: f.size, ...classificarDoc(nome) });
    }
  }
  docs.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return docs;
}
async function escolherPasta() {
  let root;
  try { root = await window.showDirectoryPicker({ mode: 'read' }); }
  catch (e) { if (e && e.name === 'AbortError') return; throw e; }
  state.pastaNome = root.name;
  state.casos = [];
  // Subpastas com PDFs → lote (1 caso por subpasta). Senão, a própria pasta é 1 caso.
  const subs = [];
  for await (const [nome, h] of root.entries()) if (h.kind === 'directory') subs.push([nome, h]);
  subs.sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  for (const [nome, h] of subs) {
    const docs = await lerPdfsDaPasta(h);
    if (docs.length) state.casos.push(novoCaso(nome, docs));
  }
  if (!state.casos.length) {
    const docs = await lerPdfsDaPasta(root);
    if (docs.length) state.casos.push(novoCaso(root.name, docs));
  }
  if (!state.casos.length) { renderFase1('Nenhum PDF encontrado (nem na pasta, nem em subpastas).'); return; }
  await extrairTodos();
}
function novoCaso(nome, docs) {
  // Peça principal: nome contém "inicial"; senão o 1º PDF.
  let pi = docs.findIndex(d => /inicial/i.test(d.nome));
  if (pi < 0) pi = 0;
  docs.forEach((d, i) => d.principal = (i === pi));
  return {
    id: 'caso-' + Math.random().toString(36).slice(2, 9), nome, docs,
    dados: JSON.parse(JSON.stringify(DEFAULTS)),
    extracao: 'pendente', status: 'aguardando', numero: null, statusTexto: '',
  };
}
function renderFase1(msgErro) {
  setPasso(1);
  app.innerHTML = `<div class="card">
    <h2 style="margin-top:0;font-size:16px;">Escolha a pasta das petições</h2>
    <p class="muted">• <b>1 caso:</b> uma pasta com os PDFs (petição inicial + procuração + documentos).<br>
    • <b>Lote:</b> uma pasta-mãe com <b>uma subpasta por caso</b>.<br>
    Pode ser a pasta do OneDrive sincronizada no computador. Só leitura, nada sai da sua máquina além do envio ao tribunal e da peça principal à IA do sistema.</p>
    ${msgErro ? `<div class="erro">${esc(msgErro)}</div>` : ''}
    <button class="btn" id="pick">📁 Escolher pasta…</button>
  </div>`;
  document.getElementById('pick').onclick = () => escolherPasta().catch(e => renderFase1(String(e.message || e)));
}

// ── fase 2: extração por IA ───────────────────────────────────────────────────
function b64DeBuffer(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function extrairTodos() {
  setPasso(2);
  for (const caso of state.casos) {
    renderFase2();
    const principal = caso.docs.find(d => d.principal);
    if (!principal || principal.size > 3 * 1024 * 1024) {
      caso.extracao = 'erro';
      caso.erroExtracao = !principal ? 'sem peça principal' : 'peça principal > 3 MB (preencha os dados na revisão)';
      continue;
    }
    try {
      const f = await principal.handle.getFile();
      const base64 = b64DeBuffer(await f.arrayBuffer());
      const r = await chrome.runtime.sendMessage({ type: 'CLAUDE_EXTRACT', base64 });
      if (r && r.ok && r.dados) {
        const d = r.dados;
        const limpa = (v) => (v == null || v === '' ? undefined : v);
        caso.dados = {
          ...caso.dados,
          comarca: limpa(d.comarca) ?? caso.dados.comarca,
          rito: limpa(d.rito) ?? caso.dados.rito,
          area: limpa(d.area) ?? caso.dados.area,
          classe: limpa(d.classe) ?? caso.dados.classe,
          competencia: limpa(d.competencia) ?? caso.dados.competencia,
          valor_causa: (typeof d.valor_causa === 'number' && d.valor_causa > 0) ? d.valor_causa : caso.dados.valor_causa,
          assuntos: (Array.isArray(d.assuntos) && d.assuntos.length) ? d.assuntos : caso.dados.assuntos,
          requerentes: Array.isArray(d.requerentes) ? d.requerentes.filter(p => p && p.nome) : [],
          requeridos: Array.isArray(d.requeridos) ? d.requeridos.filter(p => p && p.nome) : [],
        };
        caso.extracao = 'ok';
      } else {
        caso.extracao = 'erro';
        caso.erroExtracao = (r && r.error) || 'falha na IA';
      }
    } catch (e) {
      caso.extracao = 'erro';
      caso.erroExtracao = String((e && e.message) || e);
    }
  }
  renderFase3();
}
function renderFase2() {
  const feito = state.casos.filter(c => c.extracao !== 'pendente').length;
  app.innerHTML = `<div class="card"><h2 style="margin-top:0;font-size:16px;">🧠 Lendo as petições com IA…</h2>
    <p class="muted">Pasta <b>${esc(state.pastaNome)}</b> — ${state.casos.length} caso(s). Extraídos: ${feito}/${state.casos.length}.</p>
    ${state.casos.map(c => `<div class="caso"><b>${esc(c.nome)}</b> — ${c.extracao === 'pendente' ? '<span class="pill p-azul">extraindo…</span>' : c.extracao === 'ok' ? '<span class="pill p-verde">ok</span>' : `<span class="pill p-amarelo">manual: ${esc(c.erroExtracao || '')}</span>`}</div>`).join('')}
  </div>`;
}

// ── fase 3: revisão ───────────────────────────────────────────────────────────
function inputD(caso, campo, rotulo, valor) {
  return `<div><label>${rotulo}</label><input data-caso="${caso.id}" data-campo="${campo}" value="${esc(valor == null ? '' : valor)}"></div>`;
}
function partesHtml(caso, chave, rotulo) {
  const lista = caso.dados[chave] || [];
  // Endereço/e-mail/telefone: o eproc EXIGE endereço+contato da parte (cadastro novo
  // ou complemento). Vêm da qualificação da inicial via IA; usados nas pausas guiadas.
  const linhas = lista.map((p, i) => `<div style="margin:3px 0 8px;" class="partes">
      <div style="display:flex;gap:6px;">
        <input style="flex:2;" data-caso="${caso.id}" data-parte="${chave}.${i}.nome" value="${esc(p.nome || '')}" placeholder="nome">
        <input style="flex:1;" data-caso="${caso.id}" data-parte="${chave}.${i}.doc" value="${esc(p.doc || '')}" placeholder="CPF/CNPJ">
      </div>
      <div style="display:flex;gap:6px;margin-top:3px;">
        <input style="flex:3;" data-caso="${caso.id}" data-parte="${chave}.${i}.endereco" value="${esc(p.endereco || '')}" placeholder="endereço (rua, nº, cidade/UF, CEP) — p/ cadastro no eproc">
        <input style="flex:1.4;" data-caso="${caso.id}" data-parte="${chave}.${i}.email" value="${esc(p.email || '')}" placeholder="e-mail">
        <input style="flex:1;" data-caso="${caso.id}" data-parte="${chave}.${i}.telefone" value="${esc(p.telefone || '')}" placeholder="telefone">
      </div>
    </div>`).join('');
  return `<div style="margin-top:6px;"><label class="muted"><b>${rotulo}</b></label>${linhas || '<div class="muted">— nenhum (preencha ou será pausado)</div>'}</div>`;
}
function renderFase3() {
  setPasso(3);
  app.innerHTML = `<div class="card">
    <h2 style="margin-top:0;font-size:16px;">Revise antes de protocolar</h2>
    <p class="muted">Pasta <b>${esc(state.pastaNome)}</b> — ${state.casos.length} caso(s). Edite o que precisar. O <b>1º caso para no Finalizar</b> pra você validar; os demais seguem automáticos. Qualquer anomalia pausa o lote.</p>
  </div>` + state.casos.map(caso => `
    <div class="caso" id="rev-${caso.id}">
      <h3>📂 ${esc(caso.nome)} ${caso.extracao === 'erro' ? `<span class="pill p-amarelo">IA falhou: revise tudo</span>` : '<span class="pill p-verde">extraído por IA</span>'}</h3>
      <div class="grade">
        ${inputD(caso, 'comarca', 'Comarca', caso.dados.comarca)}
        ${inputD(caso, 'rito', 'Rito', caso.dados.rito)}
        ${inputD(caso, 'area', 'Área', caso.dados.area)}
        ${inputD(caso, 'classe', 'Classe processual', caso.dados.classe)}
        ${inputD(caso, 'assuntos', 'Assuntos (vírgula)', (caso.dados.assuntos || []).join(', '))}
        ${inputD(caso, 'competencia', 'Competência', caso.dados.competencia)}
        ${inputD(caso, 'valor_causa', 'Valor da causa (R$)', caso.dados.valor_causa)}
      </div>
      ${partesHtml(caso, 'requerentes', 'Requerente(s) / autor(es)')}
      ${partesHtml(caso, 'requeridos', 'Requerido(s) / réu(s)')}
      <div style="margin-top:8px;"><label class="muted"><b>Documentos (${caso.docs.length})</b> — o tipo vai preenchido no eproc</label>
        <ul class="docs">${caso.docs.map(d => `<li>${d.principal ? '⭐' : '📎'} ${esc(d.nome)} <span class="muted">→ ${esc(d.tipoTxt)}${d.obs ? ' (' + esc(d.obs) + ')' : ''}</span></li>`).join('')}</ul>
      </div>
    </div>`).join('') + `
    <div class="card" style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn ghost" id="voltar">← Trocar pasta</button>
      <button class="btn" id="rodar">▶ Protocolar ${state.casos.length > 1 ? 'o lote (' + state.casos.length + ' casos)' : 'este caso'}</button>
    </div>`;
  app.querySelectorAll('input[data-campo]').forEach(inp => inp.onchange = () => {
    const caso = state.casos.find(c => c.id === inp.dataset.caso);
    const campo = inp.dataset.campo;
    if (campo === 'assuntos') caso.dados.assuntos = inp.value.split(',').map(s => s.trim()).filter(Boolean);
    else if (campo === 'valor_causa') caso.dados.valor_causa = parseFloat(String(inp.value).replace(/\./g, '').replace(',', '.')) || null;
    else caso.dados[campo] = inp.value.trim() || null;
  });
  app.querySelectorAll('input[data-parte]').forEach(inp => inp.onchange = () => {
    const caso = state.casos.find(c => c.id === inp.dataset.caso);
    const [chave, i, campo] = inp.dataset.parte.split('.');
    caso.dados[chave][+i][campo] = inp.value.trim() || null;
  });
  document.getElementById('voltar').onclick = () => renderFase1();
  document.getElementById('rodar').onclick = iniciarLote;
}

// ── fase 4: execução ──────────────────────────────────────────────────────────
async function garantirAba() {
  if (state.tabId != null) {
    try { await chrome.tabs.get(state.tabId); return state.tabId; } catch (_) { state.tabId = null; }
  }
  const tab = await chrome.tabs.create({ url: 'https://eproc1g.tjpr.jus.br/eproc/', active: true });
  state.tabId = tab.id;
  await new Promise(r => setTimeout(r, 3500)); // carregamento inicial (login pode pausar depois)
  return tab.id;
}
function payloadDoCaso(caso) {
  return {
    id: caso.id,
    dados: caso.dados,
    docs: caso.docs.map((d, i) => ({ idx: i, nome: d.nome, tipoTxt: d.tipoTxt, selVal: d.selVal, obs: d.obs, principal: !!d.principal })),
    primeiro: !state.primeiroValidado,
  };
}
async function mandarParaAba(tipo, extra) {
  const tabId = await garantirAba();
  const msg = { type: tipo, ...(extra || {}) };
  try { await chrome.tabs.sendMessage(tabId, msg); }
  catch (_) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['selectors.js', 'content-eproc.js'] });
    await chrome.tabs.sendMessage(tabId, msg);
  }
}
async function iniciarLote() {
  // O eproc rejeita a mesma pessoa nos dois polos (hdnSinValidarPoloOposto=S):
  // barra aqui, antes de abrir o tribunal, com aviso apontando o caso.
  for (const caso of state.casos) {
    const digs = (l) => (caso.dados[l] || []).map(p => String(p && p.doc || '').replace(/\D/g, '')).filter(Boolean);
    const reus = new Set(digs('requeridos'));
    const dup = digs('requerentes').find(d => reus.has(d));
    if (dup) { alert('Caso "' + caso.nome + '": o CPF/CNPJ ' + dup + ' aparece como autor E réu — o eproc rejeita isso. Corrija na revisão.'); return; }
  }
  state.rodando = true;
  state.atual = state.casos.findIndex(c => c.status === 'aguardando');
  if (state.atual < 0) { renderFase4(); return; }
  await rodarCasoAtual();
}
async function rodarCasoAtual() {
  const caso = state.casos[state.atual];
  caso.status = 'rodando'; caso.statusTexto = 'iniciando no eproc…';
  renderFase4();
  await mandarParaAba('RUN_CENTRAL', { caso: payloadDoCaso(caso) });
}
function proximoCaso() {
  const prox = state.casos.findIndex((c, i) => i > state.atual && c.status === 'aguardando');
  if (prox < 0) { state.rodando = false; state.atual = -1; renderFase4(); return; }
  state.atual = prox;
  setTimeout(() => rodarCasoAtual().catch(mostraErroGeral), 1200);
}
function mostraErroGeral(e) {
  const caso = state.casos[state.atual];
  if (caso) { caso.status = 'erro'; caso.statusTexto = String((e && e.message) || e); }
  renderFase4();
}
function renderFase4() {
  setPasso(4);
  const pausado = state.casos.find(c => c.status === 'pausado');
  const concluidos = state.casos.filter(c => c.status === 'protocolado').length;
  app.innerHTML = `<div class="card">
    <h2 style="margin-top:0;font-size:16px;">Protocolando ${state.casos.length > 1 ? 'lote' : 'caso'} — ${concluidos}/${state.casos.length} ✓</h2>
    <p class="muted">⚠️ Mantenha esta aba aberta (ela fornece os PDFs). O login no eproc, se pedido, é você quem faz — a fila continua sozinha depois.</p>
    ${pausado ? `<div class="aviso"><b>⏸ Pausado no caso "${esc(pausado.nome)}":</b> ${pausado.statusTexto || ''}<br>
      Ajuste na aba do eproc se preciso e escolha:
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button class="btn" id="continuar">▶ Continuar</button>
        <button class="btn ghost" id="pular">Pular este caso</button>
        <button class="btn warn" id="cancelar">Cancelar o lote</button>
      </div></div>` : ''}
  </div>` + state.casos.map(c => `
    <div class="caso"><h3>📂 ${esc(c.nome)} ${pill(c)}</h3>
      <div class="muted">${c.numero ? '<b>Nº ' + esc(c.numero) + '</b> · ' : ''}${esc(String(c.statusTexto || '').replace(/<[^>]*>/g, ' '))}</div>
    </div>`).join('') + `
    <div class="card" style="display:flex;gap:10px;justify-content:flex-end;">
      ${!state.rodando ? '<button class="btn ghost" id="denovo">↩ Nova pasta</button>' : ''}
    </div>`;
  const btnC = document.getElementById('continuar');
  if (btnC) btnC.onclick = async () => {
    const caso = state.casos[state.atual];
    caso.status = 'rodando'; caso.statusTexto = 'retomando…'; renderFase4();
    await mandarParaAba('CONTINUAR_CENTRAL', {});
  };
  const btnP = document.getElementById('pular');
  if (btnP) btnP.onclick = async () => {
    state.casos[state.atual].status = 'pulado';
    await mandarParaAba('CANCELAR_CENTRAL', {});
    proximoCaso();
  };
  const btnX = document.getElementById('cancelar');
  if (btnX) btnX.onclick = async () => {
    state.casos.forEach(c => { if (c.status === 'rodando' || c.status === 'pausado' || c.status === 'aguardando') c.status = 'pulado'; });
    state.rodando = false;
    await mandarParaAba('CANCELAR_CENTRAL', {});
    renderFase4();
  };
  const btnN = document.getElementById('denovo');
  if (btnN) btnN.onclick = () => { state.primeiroValidado = false; renderFase1(); };
}

// ── mensagens vindas do content script (aba do eproc) ─────────────────────────
chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m) return false;
  const caso = state.casos.find(c => c.id === m.casoId) || state.casos[state.atual];
  if (m.type === 'PEDIR_DOC') {
    (async () => {
      try {
        const c = state.casos.find(x => x.id === m.casoId);
        const d = c && c.docs[m.idx];
        if (!d) { sendResponse({ error: 'doc não encontrado' }); return; }
        const f = await d.handle.getFile();
        sendResponse({ ok: true, nome: d.nome, base64: b64DeBuffer(await f.arrayBuffer()) });
      } catch (e) { sendResponse({ error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (m.type === 'CENTRAL_PROGRESS') {
    if (caso) { caso.statusTexto = m.texto || ''; renderFase4(); }
    return false;
  }
  if (m.type === 'CENTRAL_PAUSA') {
    if (caso) { caso.status = 'pausado'; caso.statusTexto = m.motivo || 'anomalia'; renderFase4(); }
    return false;
  }
  if (m.type === 'CENTRAL_CASO_OK') {
    (async () => {
      if (caso) {
        caso.status = 'protocolado'; caso.numero = m.numero || null; caso.statusTexto = 'registrando no Cobrasq…';
        state.primeiroValidado = true;
        renderFase4();
        const r = await chrome.runtime.sendMessage({ type: 'REGISTRAR_PROTOCOLO', numero: caso.numero, caso: { dados: caso.dados } }).catch(() => null);
        caso.statusTexto = r && r.ok ? ('registrado no Cobrasq' + (r.cobrancaVinculada ? ' + cobrança vinculada' : ' (sem cobrança correspondente)')) : 'protocolado (registro no Cobrasq falhou: ' + ((r && r.error) || '?') + ')';
        renderFase4();
      }
      proximoCaso();
    })();
    return false;
  }
  return false;
});

// Abrir/recarregar a Central zera a fila (o estado dela é em memória) — então
// limpa qualquer caso "fantasma" que tenha ficado no storage de uma rodada
// anterior, pra ele não tentar retomar sozinho na aba do eproc.
chrome.storage.local.remove('cobrasq_central_caso');

renderFase1();
