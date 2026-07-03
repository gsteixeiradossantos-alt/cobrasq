// extension/popup.js — UI da extensão.
// Lista as petições "preparadas" no app e manda o conteúdo escolhido para o
// content script do eproc (na aba ativa) preencher.

const body = document.getElementById('body');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function send(msg) { return chrome.runtime.sendMessage(msg); }

async function abaEprocAtiva() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/:\/\/[^/]*\.tjpr\.jus\.br\//.test(tab.url || '')) return null;
  return tab;
}

function render(html) { body.innerHTML = html; }

// Envia uma mensagem ao content script do eproc. Se a aba foi aberta antes de a
// extensão (re)carregar, o content script não está lá e o sendMessage estoura
// "Receiving end does not exist" — nesse caso injetamos os scripts na hora
// (permissão "scripting" + host tjpr no manifest) e tentamos de novo.
async function enviarParaEproc(tabId, mensagem) {
  try {
    await chrome.tabs.sendMessage(tabId, mensagem);
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['selectors.js', 'content-eproc.js'] });
      await chrome.tabs.sendMessage(tabId, mensagem);
      return true;
    } catch (e) {
      alert('Não consegui falar com a página do eproc (' + ((e && e.message) || e) + ').\nDê F5 na aba do eproc e tente novamente.');
      return false;
    }
  }
}

// ── Pasta local / OneDrive (File System Access; handle salvo pela pasta.html) ──
const FS_DB = 'cobrasq-fs', FS_STORE = 'handles';
function fsAbrirDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(FS_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(FS_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function fsLerHandle() {
  const db = await fsAbrirDB();
  return new Promise((res, rej) => {
    const q = db.transaction(FS_STORE, 'readonly').objectStore(FS_STORE).get('pasta');
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
  });
}
function b64DeBuffer(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function listarPdfs(handle) {
  const arqs = [];
  for await (const [nome, h] of handle.entries()) {
    if (h.kind === 'file' && /\.pdf$/i.test(nome)) arqs.push(h);
  }
  // Mais recentes primeiro (limite de 12 pra não lotar o popup).
  const comData = await Promise.all(arqs.map(async h => ({ h, f: await h.getFile() })));
  comData.sort((a, b) => b.f.lastModified - a.f.lastModified);
  return comData.slice(0, 12);
}
async function anexarLocal(fileHandle) {
  const t = await abaEprocAtiva();
  if (!t) { alert('Abra a tela de peticionar no eproc TJPR primeiro.'); return; }
  const file = await fileHandle.getFile();
  if (file.size > 40 * 1024 * 1024) { alert('PDF muito grande (' + Math.round(file.size / 1048576) + ' MB).'); return; }
  const base64 = b64DeBuffer(await file.arrayBuffer());
  if (await enviarParaEproc(t.id, { type: 'ANEXAR_PDF_LOCAL', nome: file.name, base64 })) window.close();
}
// Monta a seção "Minha pasta" abaixo da lista de jobs.
async function renderPasta() {
  const div = document.createElement('div');
  div.style.cssText = 'margin-top:10px;border-top:1px solid #e3e3e3;padding-top:10px;';
  const abrirConfig = () => chrome.tabs.create({ url: chrome.runtime.getURL('pasta.html') });
  try {
    const handle = await fsLerHandle();
    if (!handle) {
      div.innerHTML = '<button class="btn ghost" id="cfg-pasta">📁 Anexar da minha pasta (OneDrive)…</button>' +
        '<div class="muted" style="margin-top:4px;">Configure uma vez e os PDFs aparecem aqui.</div>';
      body.appendChild(div);
      div.querySelector('#cfg-pasta').onclick = abrirConfig;
      return;
    }
    let perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      div.innerHTML = '<button class="btn ghost" id="reauth">📁 Reautorizar pasta "' + esc(handle.name) + '"</button>';
      body.appendChild(div);
      div.querySelector('#reauth').onclick = async () => {
        perm = await handle.requestPermission({ mode: 'read' });
        if (perm === 'granted') carregar();
      };
      return;
    }
    const pdfs = await listarPdfs(handle);
    div.innerHTML = '<div class="muted" style="margin-bottom:6px;">📁 <b>' + esc(handle.name) + '</b> — clique para anexar no eproc <a href="#" id="cfg-pasta" style="float:right;">trocar</a></div>' +
      (pdfs.length
        ? pdfs.map((p, i) => '<button class="btn ghost" data-pdf="' + i + '" style="margin-bottom:5px;text-align:left;">📎 ' + esc(p.f.name) + '</button>').join('')
        : '<div class="muted">Nenhum PDF na pasta.</div>');
    body.appendChild(div);
    div.querySelector('#cfg-pasta').onclick = (e) => { e.preventDefault(); abrirConfig(); };
    div.querySelectorAll('button[data-pdf]').forEach(b => {
      b.onclick = () => anexarLocal(pdfs[+b.dataset.pdf].h);
    });
  } catch (e) {
    div.innerHTML = '<div class="muted">Pasta local indisponível: ' + esc((e && e.message) || e) + '</div>';
    body.appendChild(div);
  }
}

async function carregar() {
  const has = await send({ type: 'HAS_TOKEN' });
  if (!has || !has.hasToken) {
    render(`<div class="warn">Sessão não encontrada.</div>
      <p class="muted">Abra o app Cobrasq em outra aba e faça login. Depois reabra este popup.</p>
      <button class="btn" id="reload">Tentar de novo</button>`);
    document.getElementById('reload').onclick = carregar;
    await renderPasta();
    return;
  }

  render(`<div class="muted">Buscando petições preparadas…</div>`);
  const res = await send({ type: 'GET_JOBS' });
  if (res && res.error) {
    render(`<div class="warn">Erro: ${esc(res.error)}</div><button class="btn" id="reload">Tentar de novo</button>`);
    document.getElementById('reload').onclick = carregar;
    await renderPasta();
    return;
  }
  const jobs = (res && res.jobs) || [];
  if (!jobs.length) {
    render(`<p class="muted">Nenhuma petição preparada. Prepare uma no app (aba Documentos → Petições) e volte aqui.</p>
      <button class="btn ghost" id="reload">Atualizar</button>`);
    document.getElementById('reload').onclick = carregar;
    await renderPasta();
    return;
  }

  const tab = await abaEprocAtiva();
  const aviso = tab ? '' : `<div class="warn">Abra o processo no eproc TJPR (aba ativa) para preencher.</div>`;
  const rotuloJob = (j) => {
    if (j.numero_processo) return j.numero_processo;
    const r = j.dados_distribuicao && j.dados_distribuicao.requeridos && j.dados_distribuicao.requeridos[0];
    return r && r.nome ? ('Inicial · ' + r.nome) : '— (inicial)';
  };
  render(aviso + jobs.map((j, i) => `
    <div class="job">
      <div><b>${esc(rotuloJob(j))}</b> · ${esc(j.tipo || '')}</div>
      <div class="muted">${esc(j.evento_eproc || (j.tipo === 'inicial' ? 'distribuição (5 etapas)' : 'sem evento'))}</div>
      <button class="btn" data-i="${i}" ${tab ? '' : 'disabled'} style="margin-top:6px;">Preencher no eproc</button>
    </div>`).join('') +
    `<button class="btn ghost" id="reload" style="margin-top:4px;">Atualizar lista</button>`);

  document.getElementById('reload').onclick = carregar;
  body.querySelectorAll('button[data-i]').forEach(btn => {
    btn.onclick = async () => {
      const job = jobs[+btn.dataset.i];
      const t = await abaEprocAtiva();
      if (!t) { alert('Abra o processo no eproc TJPR primeiro.'); return; }
      if (await enviarParaEproc(t.id, job)) window.close();
    };
  });
}

carregar();
