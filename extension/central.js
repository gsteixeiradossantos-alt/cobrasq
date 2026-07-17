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
// Versão visível no topo — pra nunca mais restar dúvida de qual build está rodando.
try { document.querySelector('header small').textContent += ' · versão ' + chrome.runtime.getManifest().version; } catch (_) {}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const digitos = (s) => String(s || '').replace(/\D/g, '');

// Defaults do escritório (mesmos do app) — a IA sobrescreve o que extrair.
// Autora padrão: quase sempre é a própria COBRASQ; se a IA extrair outra, prevalece
// a extração (e tudo segue editável na revisão).
const AUTOR_PADRAO = { nome: 'COBRASQ RECUPERADORA DE CREDITO E COBRANCA LTDA', doc: '34.626.848/0001-42' };
const DEFAULTS = {
  comarca: 'Dois Vizinhos', rito: 'Juizado Especial Estadual', area: 'Juizado Especial Cível',
  classe: 'Procedimento do Juizado Especial Cível', assuntos: ['Perdas e Danos'],
  competencia: 'Matéria Residual', nivel_sigilo: '0', valor_causa: null,
  requerentes: [{ ...AUTOR_PADRAO }], requeridos: [],
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
// Nome do documento SEM o número de ordem da frente (ex.: "01 - Petição.pdf" →
// "Petição", "05. Declaração.pdf" → "Declaração") — é o que vai em Observação no OUTROS.
function nomeSemNumero(nome) {
  return String(nome || '')
    .replace(/\.pdf$/i, '')
    .replace(/^\s*\d{1,3}\s*[-._)\]]*\s*/, '') // tira "01 - ", "1.", "02_", "3) " etc.
    .trim();
}
function classificarDoc(nome) {
  for (const [re, tipoTxt, selVal] of TIPOS_DOC) if (re.test(nome)) return { tipoTxt, selVal, obs: null };
  return { tipoTxt: 'OUTROS', selVal: '11', obs: nomeSemNumero(nome).slice(0, 90) };
}

// ── estado ─────────────────────────────────────────────────────────────────────
// O eproc é o MESMO sistema em vários tribunais — só muda o domínio
// (eprocNg.tj<UF>.jus.br). Para somar um estado, inclua a sigla da UF em UFS_EPROC.
const UFS_EPROC = ['pr', 'rs', 'sc', 'mg', 'ms', 'rn', 'to', 'se', 'am', 'rr', 'ac', 'ap'];
const NOME_UF = { pr: 'Paraná', rs: 'Rio Grande do Sul', sc: 'Santa Catarina', mg: 'Minas Gerais', ms: 'Mato Grosso do Sul', rn: 'Rio Grande do Norte', to: 'Tocantins', se: 'Sergipe', am: 'Amazonas', rr: 'Roraima', ac: 'Acre', ap: 'Amapá' };
const TRIBUNAIS_EPROC = {};
for (const uf of UFS_EPROC) TRIBUNAIS_EPROC['tj' + uf] = {
  nome: 'TJ' + uf.toUpperCase() + (NOME_UF[uf] ? ' — ' + NOME_UF[uf] : ''),
  host: 'tj' + uf + '.jus.br',                         // domínio-base (cobre 1º e 2º grau)
  url: 'https://eproc1g.tj' + uf + '.jus.br/eproc/',   // 1º grau (padrão do eproc)
};
// Justiça Federal da 4ª Região (mesmo eproc, no caminho /eprocV2/ — confirmado pela
// URL real da JFPR): JFPR/JFSC/JFRS 1º grau; TRF4 2º grau.
TRIBUNAIS_EPROC.jfpr = { nome: 'JFPR — Justiça Federal do Paraná', host: 'jfpr.jus.br', url: 'https://eproc.jfpr.jus.br/eprocV2/' };
TRIBUNAIS_EPROC.jfsc = { nome: 'JFSC — Justiça Federal de Santa Catarina', host: 'jfsc.jus.br', url: 'https://eproc.jfsc.jus.br/eprocV2/' };
TRIBUNAIS_EPROC.jfrs = { nome: 'JFRS — Justiça Federal do Rio Grande do Sul', host: 'jfrs.jus.br', url: 'https://eproc.jfrs.jus.br/eprocV2/' };
TRIBUNAIS_EPROC.trf4 = { nome: 'TRF4 — Tribunal Regional Federal 4ª Região', host: 'trf4.jus.br', url: 'https://eproc.trf4.jus.br/eprocV2/' };

const state = {
  fase: 1,              // 1 pasta · 2 extração · 3 revisão · 4 execução
  sistema: 'eproc',     // 'eproc' (iniciais) | 'projudi' (intercorrentes)
  tribunal: 'tjpr',     // tribunal do eproc (multi-estado) — ver TRIBUNAIS_EPROC
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
  if (state.sistema === 'projudi') {
    // Intercorrentes: cada PDF solto = 1 caso; cada subpasta = 1 caso com vários anexos.
    const raiz = await lerPdfsDaPasta(root);
    for (const d of raiz) state.casos.push(novoCasoProjudi(d.nome, [d]));
    const subs = [];
    for await (const [nome, h] of root.entries()) if (h.kind === 'directory') subs.push([nome, h]);
    subs.sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
    for (const [nome, h] of subs) {
      const docs = await lerPdfsDaPasta(h);
      if (docs.length) state.casos.push(novoCasoProjudi(nome, docs));
    }
    if (!state.casos.length) { renderFase1('Nenhum PDF encontrado (nem na pasta, nem em subpastas).'); return; }
    state.casos.forEach(c => { c.extracao = 'ok'; }); // sem IA no modo Projudi (v1)
    renderFase3();
    return;
  }
  // eproc: se a pasta escolhida tem PDFs SOLTOS, ELA é o caso — usa só os PDFs dela e
  // NÃO entra nas subpastas. Só quando NÃO há PDF solto é que a tratamos como pasta-mãe
  // de LOTE (1 caso por subpasta). Antes, qualquer subpasta virava lote e os PDFs da
  // própria pasta eram ignorados — daí "puxava das subpastas" sem querer.
  const raizDocs = await lerPdfsDaPasta(root);
  if (raizDocs.length) {
    state.casos.push(novoCaso(root.name, raizDocs));
  } else {
    const subs = [];
    for await (const [nome, h] of root.entries()) if (h.kind === 'directory') subs.push([nome, h]);
    subs.sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
    for (const [nome, h] of subs) {
      const docs = await lerPdfsDaPasta(h);
      if (docs.length) state.casos.push(novoCaso(nome, docs));
    }
  }
  if (!state.casos.length) { renderFase1('Nenhum PDF encontrado (nem na pasta, nem em subpastas).'); return; }
  await extrairTodos();
}
// Número CNJ do TJPR no meio de um texto (aceita com ou sem pontuação).
function acharCnj(texto) {
  const m = String(texto || '').match(/(\d{7})[-. ]?(\d{2})[. ]?(\d{4})[. ]?8[. ]?16[. ]?(\d{4})/);
  return m ? `${m[1]}-${m[2]}.${m[3]}.8.16.${m[4]}` : null;
}
function novoCasoProjudi(nome, docs) {
  docs.forEach((d, i) => d.principal = (i === 0));
  const numero = acharCnj(nome) || acharCnj(docs.map(d => d.nome).join(' '));
  return {
    id: 'caso-' + Math.random().toString(36).slice(2, 9), nome, docs,
    sistema: 'projudi',
    numero_processo: numero,
    tipo_peticao: 'Manifestação da Parte',
    dados: {},
    extracao: 'ok', status: 'aguardando', numero: null, statusTexto: '',
  };
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
  const ehEproc = state.sistema === 'eproc';
  app.innerHTML = `<div class="card">
    <h2 style="margin-top:0;font-size:16px;">O que vamos protocolar?</h2>
    <div style="display:flex;gap:10px;margin-bottom:12px;">
      <button class="btn ${ehEproc ? '' : 'ghost'}" id="modo-eproc">⚖️ eproc — iniciais</button>
      <button class="btn ${ehEproc ? 'ghost' : ''}" id="modo-projudi">🌳 Projudi — intercorrentes</button>
    </div>
    ${ehEproc ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      <label for="sel-tribunal" style="font-weight:600;">Tribunal:</label>
      <select id="sel-tribunal" style="padding:6px 8px;border-radius:6px;border:1px solid #ccc;flex:1;">
        ${Object.keys(TRIBUNAIS_EPROC).map(k => `<option value="${k}"${k === state.tribunal ? ' selected' : ''}>${esc(TRIBUNAIS_EPROC[k].nome)}</option>`).join('')}
      </select>
    </div>` : ''}
    ${ehEproc ? `<p class="muted">• <b>1 caso:</b> uma pasta com os PDFs (petição inicial + procuração + documentos).<br>
    • <b>Lote:</b> uma pasta-mãe com <b>uma subpasta por caso</b>.<br>
    Pode ser a pasta do OneDrive sincronizada no computador. Só leitura, nada sai da sua máquina além do envio ao tribunal e da peça principal à IA do sistema.<br>
    ⚠️ A leitura por IA usa o servidor do app Cobrasq — deixe o <b>painel aberto e logado</b> em outra aba (a extensão conecta sozinha).</p>`
    : `<p class="muted">• Cada <b>PDF solto</b> na pasta = 1 petição intercorrente; o <b>número do processo vem do nome do arquivo</b><br>
    &nbsp;&nbsp;(ex.: <code>0001234-56.2024.8.16.0079 - pedido de penhora.pdf</code>).<br>
    • <b>Subpasta</b> = 1 petição com vários anexos (número no nome da subpasta ou de um PDF).<br>
    Sem IA nesta versão: o PDF vai como anexo e você confere tipo/número na revisão. A assinatura/senha no protocolo é <b>sempre sua</b>.</p>`}
    ${msgErro ? `<div class="erro">${esc(msgErro)}</div>` : ''}
    <button class="btn" id="pick">📁 Escolher pasta…</button>
  </div>`;
  document.getElementById('modo-eproc').onclick = () => { state.sistema = 'eproc'; renderFase1(); };
  document.getElementById('modo-projudi').onclick = () => { state.sistema = 'projudi'; renderFase1(); };
  const selTrib = document.getElementById('sel-tribunal');
  if (selTrib) selTrib.onchange = () => { state.tribunal = selTrib.value; try { chrome.storage.local.set({ cobrasq_tribunal: state.tribunal }); } catch (_) {} };
  document.getElementById('pick').onclick = () => escolherPasta().catch(e => renderFase1(String(e.message || e)));
}

// ── fase 2: extração por IA ───────────────────────────────────────────────────
function b64DeBuffer(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// A Central puxa a sessão ATIVAMENTE das abas do app (mesma receita do popup):
// sem isso, Chrome recém-aberto = token vazio no background = "sem_sessao" na IA.
async function puxarTokenDoApp() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://painel.cobrasq.com.br/*' });
    for (const tab of tabs) {
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (!k || !/^sb-.*-auth-token$/.test(k)) continue;
              let raw = localStorage.getItem(k);
              if (!raw) continue;
              if (raw.startsWith('base64-')) {
                try { raw = atob(raw.slice(7).replace(/-/g, '+').replace(/_/g, '/')); } catch (_) { continue; }
              }
              try {
                const o = JSON.parse(raw);
                const t = (o && o.access_token) || (o && o.currentSession && o.currentSession.access_token);
                if (t) return t;
              } catch (_) {}
            }
            return null;
          },
        });
        if (r && r.result) { await chrome.runtime.sendMessage({ type: 'SET_TOKEN', token: r.result }); return true; }
      } catch (_) { /* aba sem permissão/descartada: tenta a próxima */ }
    }
  } catch (_) {}
  return false;
}
async function garantirSessao() {
  const has = await chrome.runtime.sendMessage({ type: 'HAS_TOKEN' }).catch(() => null);
  if (has && has.hasToken) return true;
  return puxarTokenDoApp();
}
function erroAmigavel(e) {
  if (e === 'sem_sessao') return 'sem conexão com o app — deixe o painel Cobrasq aberto e logado e clique Extrair de novo';
  return e || 'falha na IA';
}
async function extrairCaso(caso) {
  caso.extracao = 'pendente'; caso.erroExtracao = null;
  const principal = caso.docs.find(d => d.principal);
  if (!principal || principal.size > 3 * 1024 * 1024) {
    caso.extracao = 'erro';
    caso.erroExtracao = !principal ? 'sem peça principal' : 'peça principal com ' + (principal.size / 1048576).toFixed(1) + ' MB (limite 3 MB) — preencha os dados na revisão';
    return;
  }
  {
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
          // Partes: a extração só substitui o default (COBRASQ autora) se achou algo.
          requerentes: (Array.isArray(d.requerentes) && d.requerentes.filter(p => p && p.nome).length)
            ? d.requerentes.filter(p => p && p.nome) : caso.dados.requerentes,
          requeridos: (Array.isArray(d.requeridos) && d.requeridos.filter(p => p && p.nome).length)
            ? d.requeridos.filter(p => p && p.nome) : caso.dados.requeridos,
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
}
async function extrairTodos() {
  setPasso(2);
  await garantirSessao();
  for (const caso of state.casos) {
    renderFase2();
    await extrairCaso(caso);
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
  const alerta = lista.some(p => p && digitos(p.doc).length >= 11) ? ''
    : ' <span class="pill p-verm">sem CPF/CNPJ — o caso vai pausar no eproc</span>';
  return `<div style="margin-top:6px;"><label class="muted"><b>${rotulo}</b>${alerta}</label>${linhas || '<div class="muted">— nenhum (preencha ou será pausado)</div>'}</div>`;
}
function renderFase3() {
  setPasso(3);
  app.innerHTML = `<div class="card">
    <h2 style="margin-top:0;font-size:16px;">Revise antes de protocolar</h2>
    <p class="muted">Pasta <b>${esc(state.pastaNome)}</b> — ${state.casos.length} caso(s). Edite o que precisar. O <b>1º caso para no Finalizar</b> pra você validar; os demais seguem automáticos. Qualquer anomalia pausa o lote.</p>
  </div>` + state.casos.map(caso => caso.sistema === 'projudi' ? `
    <div class="caso" id="rev-${caso.id}">
      <h3>🌳 ${esc(caso.nome)} <span>${caso.numero_processo ? '<span class="pill p-verde">nº do processo ok</span>' : '<span class="pill p-verm">SEM nº do processo — corrija</span>'}</span></h3>
      <div class="grade">
        <div><label>Número do processo (CNJ)</label><input data-caso="${caso.id}" data-proj="numero_processo" value="${esc(caso.numero_processo || '')}" placeholder="0000000-00.0000.8.16.0000"></div>
        <div><label>Tipo da petição</label><input data-caso="${caso.id}" data-proj="tipo_peticao" value="${esc(caso.tipo_peticao || '')}" placeholder="ex.: Petição, Manifestação"></div>
      </div>
      <div style="margin-top:8px;"><label class="muted"><b>Anexos (${caso.docs.length})</b></label>
        <ul class="docs">${caso.docs.map(d => `<li>📎 ${esc(d.nome)}</li>`).join('')}</ul>
      </div>
    </div>` : `
    <div class="caso" id="rev-${caso.id}">
      <h3>📂 ${esc(caso.nome)} <span>${caso.extracao === 'erro'
        ? `<span class="pill p-amarelo">IA falhou: ${esc(erroAmigavel(caso.erroExtracao))}</span> <button class="btn ghost" data-reextrair="${caso.id}" style="padding:3px 10px;font-size:12px;">🔁 Extrair de novo</button>`
        : '<span class="pill p-verde">extraído por IA</span>'}</span></h3>
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
  app.querySelectorAll('input[data-proj]').forEach(inp => inp.onchange = () => {
    const caso = state.casos.find(c => c.id === inp.dataset.caso);
    if (!caso) return;
    caso[inp.dataset.proj] = inp.value.trim() || null;
    if (inp.dataset.proj === 'numero_processo') renderFase3();
  });
  document.getElementById('voltar').onclick = () => renderFase1();
  document.getElementById('rodar').onclick = (e) => { if (e && e.currentTarget) e.currentTarget.disabled = true; iniciarLote(); }; // CA3
  app.querySelectorAll('button[data-reextrair]').forEach(b => b.onclick = async () => {
    const caso = state.casos.find(c => c.id === b.dataset.reextrair);
    if (!caso) return;
    b.disabled = true; b.textContent = 'extraindo…';
    await garantirSessao();
    await extrairCaso(caso);
    renderFase3();
  });
}

// ── fase 4: execução ──────────────────────────────────────────────────────────
const SCRIPT_SISTEMA = { eproc: 'content-eproc.js', projudi: 'content-projudi.js' };
function tribunalAtual() { return TRIBUNAIS_EPROC[state.tribunal] || TRIBUNAIS_EPROC.tjpr; }
function urlDoSistema() { return state.sistema === 'projudi' ? 'https://projudi.tjpr.jus.br/projudi/' : tribunalAtual().url; }
function hostDoSistema() { return state.sistema === 'projudi' ? 'projudi.tjpr.jus.br' : tribunalAtual().host; }
async function esperarAbaPronta(tabId, timeoutMs) {
  const fim = Date.now() + (timeoutMs || 20000);
  while (Date.now() < fim) {
    try { const t = await chrome.tabs.get(tabId); if (t && t.status === 'complete') return true; } catch (_) { return false; }
    await new Promise(r => setTimeout(r, 300));
  }
  return true;
}
async function garantirAba() {
  if (state.tabId != null) {
    try {
      const t = await chrome.tabs.get(state.tabId);
      // CM3: só reusa se a aba ainda está no tribunal certo; senão abre nova
      // (evita injetar o content script numa página alheia).
      if (t && (t.url || t.pendingUrl || '').includes(hostDoSistema())) { await esperarAbaPronta(state.tabId, 20000); return state.tabId; }
    } catch (_) {}
    state.tabId = null;
  }
  const tab = await chrome.tabs.create({ url: urlDoSistema(), active: true });
  state.tabId = tab.id;
  await esperarAbaPronta(tab.id, 25000); // espera carregar (login pode pausar depois)
  return tab.id;
}
function payloadDoCaso(caso) {
  return {
    id: caso.id,
    sistema: caso.sistema || 'eproc',
    numero_processo: caso.numero_processo || null,
    tipo_peticao: caso.tipo_peticao || null,
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
    // Projudi roda em molduras: injeta em TODOS os frames.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: state.sistema === 'projudi' },
      files: ['selectors.js', SCRIPT_SISTEMA[state.sistema] || 'content-eproc.js'],
    });
    await chrome.tabs.sendMessage(tabId, msg);
  }
}
async function iniciarLote() {
  if (state.rodando) return; // CA3: barra duplo clique em Protocolar
  if (state.sistema === 'projudi') {
    const semNum = state.casos.filter(c => !acharCnj(c.numero_processo || ''));
    if (semNum.length) { alert('Caso(s) sem número de processo válido: ' + semNum.map(c => c.nome).join(', ') + '. Corrija na revisão.'); return; }
    state.casos.forEach(c => { c.numero_processo = acharCnj(c.numero_processo); });
  } else {
    // O eproc rejeita a mesma pessoa nos dois polos (hdnSinValidarPoloOposto=S):
    // barra aqui, antes de abrir o tribunal, com aviso apontando o caso.
    for (const caso of state.casos) {
      const digs = (l) => (caso.dados[l] || []).map(p => String(p && p.doc || '').replace(/\D/g, '')).filter(Boolean);
      const reus = new Set(digs('requeridos'));
      const dup = digs('requerentes').find(d => reus.has(d));
      if (dup) { alert('Caso "' + caso.nome + '": o CPF/CNPJ ' + dup + ' aparece como autor E réu — o eproc rejeita isso. Corrija na revisão.'); return; }
    }
    const semReu = state.casos.filter(c => !(c.dados.requeridos || []).some(p => p && digitos(p.doc).length >= 11));
    if (semReu.length && !confirm('Caso(s) sem réu com CPF/CNPJ: ' + semReu.map(c => c.nome).join(', ') + '.\nEles vão PAUSAR na etapa de réus para você incluir manualmente. Continuar mesmo assim?')) return;
  }
  state.rodando = true;
  state.atual = state.casos.findIndex(c => c.status === 'aguardando');
  if (state.atual < 0) { renderFase4(); return; }
  await rodarCasoAtual();
}
async function rodarCasoAtual() {
  if (!state.rodando) return; // CC2: não ressuscitar caso após Cancelar
  const caso = state.casos[state.atual];
  if (!caso) return;
  caso.status = 'rodando'; caso.statusTexto = 'iniciando no ' + (caso.sistema === 'projudi' ? 'Projudi' : 'eproc') + '…';
  renderFase4();
  await mandarParaAba('RUN_CENTRAL', { caso: payloadDoCaso(caso) });
}
let _proximoTimer = null;
function proximoCaso() {
  const prox = state.casos.findIndex((c, i) => i > state.atual && c.status === 'aguardando');
  if (prox < 0) { state.rodando = false; state.atual = -1; renderFase4(); return; }
  state.atual = prox;
  // CM7: espera a aba assentar antes de disparar o próximo (a página de sucesso
  // ainda transiciona); CC2: timer guardado p/ o Cancelar poder abortar.
  if (_proximoTimer) clearTimeout(_proximoTimer);
  _proximoTimer = setTimeout(async () => {
    _proximoTimer = null;
    if (!state.rodando) return;
    try { if (state.tabId != null) await esperarAbaPronta(state.tabId, 15000); } catch (_) {}
    rodarCasoAtual().catch(mostraErroGeral);
  }, 1200);
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
      Ajuste na aba do tribunal se preciso e escolha:
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
    if (_proximoTimer) { clearTimeout(_proximoTimer); _proximoTimer = null; } // CC2
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
  // CA4: match ESTRITO por casoId. Um content script remanescente (rodada antiga
  // ou frame duplicado) pode emitir com casoId que não bate; nada de fallback para
  // "o caso atual", senão marcaríamos o caso ERRADO como protocolado.
  const casoExato = m.casoId ? state.casos.find(c => c.id === m.casoId) : null;
  const caso = casoExato; // usado por PROGRESS/PAUSA/CASO_OK
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
    // CA4: ignora conclusão de casoId desconhecido (não avança a fila indevidamente).
    if (!caso || caso.status === 'protocolado') return false;
    (async () => {
      caso.status = 'protocolado'; caso.numero = m.numero || null; caso.statusTexto = 'registrando no Cobrasq…';
      state.primeiroValidado = true;
      renderFase4();
      const r = await chrome.runtime.sendMessage({
        type: 'REGISTRAR_PROTOCOLO', numero: caso.numero,
        caso: { dados: caso.dados, tipo: caso.sistema === 'projudi' ? 'intercorrente' : 'inicial', numero_processo: caso.numero_processo || null },
      }).catch(() => null);
      caso.statusTexto = r && r.ok ? ('registrado no Cobrasq' + (r.cobrancaVinculada ? ' + cobrança vinculada' : ' (sem cobrança correspondente)')) : 'protocolado (registro no Cobrasq falhou: ' + ((r && r.error) || '?') + ')';
      renderFase4();
      proximoCaso();
    })();
    return false;
  }
  return false;
});

// CC1: se a aba do tribunal for FECHADA ou navegada para fora com um caso ainda
// "rodando", a fila (100% orientada a eventos) travaria para sempre. Aqui a Central
// detecta e pausa o caso ("aba fechada"), expondo o botão Continuar (que recria a
// aba via garantirAba e reenvia o caso).
function pausarPorAba(motivo) {
  if (!state.rodando) return;
  const caso = state.atual >= 0 ? state.casos[state.atual] : null;
  if (caso && caso.status === 'rodando') {
    caso.status = 'pausado';
    caso.statusTexto = motivo;
    state.tabId = null;
    try { renderFase4(); } catch (_) {}
  }
}
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) pausarPorAba('a aba do tribunal foi fechada — clique Continuar que eu reabro e retomo.');
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId !== state.tabId || !info.url) return;
  if (!(info.url || '').includes(hostDoSistema())) {
    pausarPorAba('a aba saiu do site do tribunal — clique Continuar que eu reabro e retomo.');
  }
});

// Abrir/recarregar a Central zera a fila (o estado dela é em memória) — então
// limpa qualquer caso "fantasma" que tenha ficado no storage de uma rodada
// anterior, pra ele não tentar retomar sozinho na aba do eproc.
chrome.storage.local.remove('cobrasq_central_caso');

// Carrega o tribunal preferido (persistido) antes do 1º render; se falhar, TJPR.
chrome.storage.local.get('cobrasq_tribunal').then(o => {
  if (o && o.cobrasq_tribunal && TRIBUNAIS_EPROC[o.cobrasq_tribunal]) state.tribunal = o.cobrasq_tribunal;
}).catch(() => {}).finally(() => renderFase1());
