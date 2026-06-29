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

async function carregar() {
  const has = await send({ type: 'HAS_TOKEN' });
  if (!has || !has.hasToken) {
    render(`<div class="warn">Sessão não encontrada.</div>
      <p class="muted">Abra o app Cobrasq em outra aba e faça login. Depois reabra este popup.</p>
      <button class="btn" id="reload">Tentar de novo</button>`);
    document.getElementById('reload').onclick = carregar;
    return;
  }

  render(`<div class="muted">Buscando petições preparadas…</div>`);
  const res = await send({ type: 'GET_JOBS' });
  if (res && res.error) {
    render(`<div class="warn">Erro: ${esc(res.error)}</div><button class="btn" id="reload">Tentar de novo</button>`);
    document.getElementById('reload').onclick = carregar;
    return;
  }
  const jobs = (res && res.jobs) || [];
  if (!jobs.length) {
    render(`<p class="muted">Nenhuma petição preparada. Prepare uma no app (aba Documentos → Petições) e volte aqui.</p>
      <button class="btn ghost" id="reload">Atualizar</button>`);
    document.getElementById('reload').onclick = carregar;
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
      await chrome.tabs.sendMessage(t.id, { type: 'FILL_JOB', job });
      window.close();
    };
  });
}

carregar();
