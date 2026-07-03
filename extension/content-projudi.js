// extension/content-projudi.js — Peticionamento INTERCORRENTE no Projudi TJPR
// (modo AUTO da Central). O Projudi tem 3 níveis de moldura:
//   nível 1: frameset (topFrame + mainFrame)
//   nível 2: mainFrame — barra de menus #main-menu + <iframe name="userMainFrame">
//   nível 3: userMainFrame — a TELA de verdade (busca, processo, petição, anexos)
// O script roda em todos os frames (all_frames no manifest), mas só o nível 3
// "dirige": como tudo é mesma origem, ele alcança o menu via parent.document.
// Fluxo: buscar processo pelo nº (vem do nome do PDF) → abrir → Cumprir Prazo ou
// Peticionar → anexar PDF(s) → PAUSA para o advogado assinar/protocolar (senha é
// sempre humana, nunca armazenada) → Continuar = caso concluído.
// Telas ainda não calibradas geram PAUSA com instrução — mesmo loop de live-debug
// que calibrou o eproc.

(() => {
  'use strict';
  if (!/projudi\.tjpr\.jus\.br$/.test(location.hostname)) return;

  const VERSAO = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
  const CASO_KEY = 'cobrasq_central_caso';

  // ── nível do frame ───────────────────────────────────────────────────────────
  function nivel() {
    if (document.querySelector('frameset')) return 1;
    if (document.getElementById('main-menu') || document.getElementById('BarraMenu')) return 2;
    if (window !== window.top) return 3;
    return 0; // página solta (login/autenticação fora das molduras)
  }

  // ── helpers (mesmo espírito do content-eproc) ────────────────────────────────
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  function visivel(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }
  async function esperar(cond, timeoutMs, passoMs) {
    const fim = Date.now() + (timeoutMs || 15000);
    while (Date.now() < fim) { const v = cond(); if (v) return v; await new Promise(r => setTimeout(r, passoMs || 300)); }
    return null;
  }
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
  function destacar(el, cor) { try { el.style.outline = '3px solid ' + (cor || '#fab005'); el.scrollIntoView({ block: 'center' }); } catch (_) {} }
  function clicar(el) { try { el.scrollIntoView({ block: 'center' }); } catch (_) {} el.click(); }

  function painel() {
    let p = document.getElementById('cobrasq-projudi-panel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'cobrasq-projudi-panel';
    p.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;width:340px;max-height:80vh;overflow:auto;' +
      'background:#fff;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);' +
      'font:13px/1.45 system-ui,Arial,sans-serif;color:#1a1a1a;';
    p.innerHTML =
      '<div style="background:#3b5e2b;color:#fff;padding:10px 12px;font-weight:600;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;">' +
      '<span>Cobrasq · Peticionador Projudi <small style="opacity:.7;">v' + VERSAO + '</small></span>' +
      '<span id="cbp-close" style="cursor:pointer;opacity:.8;">✕</span></div>' +
      '<div id="cbp-body" style="padding:12px;"></div>';
    (document.body || document.documentElement).appendChild(p);
    p.querySelector('#cbp-close').onclick = () => p.remove();
    return p;
  }
  function setBody(html) { painel().querySelector('#cbp-body').innerHTML = html; }
  function msg(t, cor) { return '<div style="padding:6px 8px;border-radius:6px;background:' + (cor || '#f1f3f5') + ';margin-bottom:8px;">' + t + '</div>'; }

  async function casoLer() { const o = await chrome.storage.local.get(CASO_KEY); return o[CASO_KEY] || null; }
  async function casoSalvar(c) { await chrome.storage.local.set({ [CASO_KEY]: c }); }
  async function casoLimpar() { await chrome.storage.local.remove(CASO_KEY); }
  function reportar(tipo, extra) { try { chrome.runtime.sendMessage({ type: tipo, ...(extra || {}) }); } catch (_) {} }
  function progresso(c, texto) { setBody(msg('<b>Central (Projudi):</b> ' + texto)); reportar('CENTRAL_PROGRESS', { casoId: c.id, texto }); }
  async function pausar(c, motivo, el) {
    c.status = 'pausado'; c.motivo = motivo; await casoSalvar(c);
    if (el) destacar(el, '#fa5252');
    setBody(msg('⏸ <b>Pausado:</b> ' + motivo, '#fff3bf') + msg('Faça na tela o que a mensagem pede e use <b>Continuar</b> na aba da Central.', '#e7f5ff'));
    reportar('CENTRAL_PAUSA', { casoId: c.id, motivo });
  }
  function temLogin() { const p = document.querySelector('input[type="password"]'); return !!(p && visivel(p)); }

  // ── busca de controles por texto (rótulos/valores/títulos) ───────────────────
  function acharControle(termos, tags) {
    const cands = Array.from(document.querySelectorAll(tags || 'input[type="submit"],input[type="button"],button,a'))
      .filter(visivel);
    for (const t of termos) {
      const alvo = norm(t);
      for (const el of cands) {
        const txt = norm(((el.value || '') + ' ' + (el.textContent || '') + ' ' + (el.title || '')).trim());
        if (txt === alvo || txt.includes(alvo)) return el;
      }
    }
    return null;
  }
  function inputPorRotulo(termos) {
    // label[for] → input; senão input cujo name/id contenha o termo.
    for (const t of termos) {
      const alvo = norm(t);
      for (const lb of document.querySelectorAll('label')) {
        if (norm(lb.textContent).includes(alvo)) {
          const inp = lb.htmlFor ? document.getElementById(lb.htmlFor) : lb.querySelector('input');
          if (inp && visivel(inp)) return inp;
        }
      }
      for (const inp of document.querySelectorAll('input[type="text"],input:not([type])')) {
        if (visivel(inp) && norm((inp.name || '') + ' ' + (inp.id || '')).includes(alvo.replace(/ /g, ''))) return inp;
      }
    }
    return null;
  }
  function setInput(el, valor) {
    el.focus(); el.value = valor;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function pedirDoc(casoId, idx) {
    const r = await chrome.runtime.sendMessage({ type: 'PEDIR_DOC', casoId, idx });
    if (!r || !r.ok) throw new Error('PDF ' + (idx + 1) + ': ' + ((r && r.error) || 'a aba da Central está fechada?'));
    const bin = atob(r.base64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], r.nome, { type: 'application/pdf' });
  }

  // ── telas ────────────────────────────────────────────────────────────────────
  const digitos = (s) => String(s || '').replace(/\D/g, '');
  function telaTemBusca() { return !!inputPorRotulo(['numero processo', 'numeroprocesso', 'nº do processo', 'numero do processo']); }
  function linkDoProcesso(numero) {
    const alvo = digitos(numero);
    return Array.from(document.querySelectorAll('a')).find(a => visivel(a) && digitos(a.textContent).includes(alvo) && alvo.length >= 13) || null;
  }

  async function abrirBuscaPeloMenu(c) {
    // Nível 3 alcança o menu do nível 2 (mesma origem).
    let doc = null;
    try { doc = window.parent && window.parent.document; } catch (_) {}
    const links = doc ? Array.from(doc.querySelectorAll('#main-menu a, #BarraMenu a')) : [];
    const alvo = links.find(a => norm(a.textContent) === 'processos 1º grau' || norm(a.textContent) === 'processos 1o grau' || norm(a.textContent).includes('processos 1'));
    if (!alvo) return pausar(c, 'não achei "Buscas → Processos 1º Grau" no menu — abra essa tela você e clique Continuar');
    progresso(c, 'abrindo Buscas → Processos 1º Grau…');
    alvo.click(); // href com target=userMainFrame: navega ESTE frame (o script renasce)
  }

  async function runCentral() {
    const c = await casoLer();
    if (!c || c.sistema !== 'projudi') return;
    const meuNivel = nivel();
    if (meuNivel !== 3 && meuNivel !== 0) return; // só o frame da tela dirige
    if (meuNivel === 0 && !temLogin()) return;     // página solta sem login: nada a fazer
    try {
      if (c.status === 'pausado') {
        if (c.motivo === 'login' && !temLogin()) { c.status = 'rodando'; c.motivo = null; await casoSalvar(c); }
        else { setBody(msg('⏸ <b>Pausado:</b> ' + (c.motivo || ''), '#fff3bf') + msg('Use os botões na aba da Central.', '#e7f5ff')); return; }
      }
      if (temLogin()) { await pausar(c, 'login'); setBody(msg('Faça o <b>login no Projudi</b> — a fila continua sozinha depois.', '#fff3bf')); return; }

      const numero = c.numero_processo;
      if (!numero) return pausar(c, 'caso sem número de processo — corrija na revisão da Central');

      // FASE FINAL: o advogado assinou/protocolou e clicou Continuar.
      if (c.fase === 'finalizando') {
        const m = (document.body.innerText || '').match(/protocolo[^\d]{0,20}(\d[\d./-]{5,})/i);
        await casoLimpar();
        reportar('CENTRAL_CASO_OK', { casoId: c.id, numero: (m && m[1]) || numero });
        setBody(msg('✅ Caso concluído — próximo da fila.', '#d3f9d8'));
        return;
      }

      // 1) Tela de busca: preenche o nº e pesquisa.
      if (telaTemBusca()) {
        const campo = inputPorRotulo(['numero processo', 'numeroprocesso', 'numero do processo']);
        if (digitos(campo.value) !== digitos(numero)) {
          progresso(c, 'buscando o processo ' + numero + '…');
          setInput(campo, numero);
          const btn = acharControle(['pesquisar', 'consultar', 'buscar']);
          if (!btn) return pausar(c, 'tela de busca: não achei o botão Pesquisar — clique você e depois Continuar', campo);
          clicar(btn);
          await esperar(() => linkDoProcesso(numero), 8000);
        }
        const link = linkDoProcesso(numero);
        if (link) { progresso(c, 'abrindo o processo…'); clicar(link); return; }
        return pausar(c, 'processo ' + numero + ' não apareceu no resultado — confira o número/abra o processo e clique Continuar');
      }

      // 2) Tela do processo: pendência (Cumprir Prazo) tem prioridade; senão Peticionar.
      const textoTela = norm((document.body.innerText || '').slice(0, 6000));
      const nestaTela = textoTela.includes(digitos(numero).slice(0, 7)) || digitos(document.body.innerText).includes(digitos(numero));
      if (nestaTela) {
        const cumprir = acharControle(['cumprir prazo']);
        const peticionar = acharControle(['peticionar', 'inserir peticao', 'juntar documento', 'movimentar']);
        // Anexos: se a tela atual já tem campo de arquivo, é a tela da petição.
        const inputArq = Array.from(document.querySelectorAll('input[type="file"]')).find(visivel);
        if (inputArq) return await anexarEPausar(c, inputArq);
        if (cumprir) { progresso(c, 'pendência encontrada → Cumprir Prazo'); clicar(cumprir); return; }
        if (peticionar) { progresso(c, 'sem pendência → Peticionar'); clicar(peticionar); return; }
        return pausar(c, 'estou no processo mas não achei "Cumprir Prazo" nem "Peticionar" — clique você no caminho certo (se houver intimação: Ver Intimação → Cumprir Prazo) e depois Continuar');
      }

      // 3) Qualquer outra tela (mesa do advogado etc.): navega pelo menu.
      await abrirBuscaPeloMenu(c);
    } catch (e) { const c2 = await casoLer(); if (c2) await pausar(c2, 'erro inesperado: ' + String((e && e.message) || e)); }
  }

  async function anexarEPausar(c, inputArq) {
    if (!c.anexou) {
      progresso(c, 'anexando ' + (c.docs || []).length + ' PDF(s)…');
      // Tipo do documento (se a tela tiver select/campo "Tipo"): melhor esforço.
      const tipoSel = Array.from(document.querySelectorAll('select')).find(s => visivel(s) && norm((s.name || '') + (s.id || '')).includes('tipo'));
      if (tipoSel && c.tipo_peticao) {
        const opt = Array.from(tipoSel.options).find(o => norm(o.textContent).includes(norm(c.tipo_peticao)));
        if (opt) { tipoSel.value = opt.value; tipoSel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      const dt = new DataTransfer();
      for (const d of c.docs) dt.items.add(await pedirDoc(c.id, d.idx));
      inputArq.files = dt.files;
      inputArq.dispatchEvent(new Event('change', { bubbles: true }));
      c.anexou = true; await casoSalvar(c);
    }
    c.fase = 'finalizando'; await casoSalvar(c);
    return pausar(c, 'PDF(s) anexado(s) — confira o tipo da petição, ASSINE e protocole você (a senha é sempre sua). Depois do protocolo, clique <b>Continuar</b> na Central que eu dou o caso por concluído e sigo a fila.');
  }

  // ── mensageria (só o frame-condutor responde às ações) ───────────────────────
  chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
    if (!m || !m.type) return false;
    const meuNivel = nivel();
    if (m.type === 'RUN_CENTRAL' && m.caso && m.caso.sistema === 'projudi') {
      if (meuNivel !== 3) return false;
      (async () => {
        await casoSalvar({ ...m.caso, status: 'rodando', motivo: null, anexou: false, fase: null });
        sendResponse({ ok: true });
        runCentral().catch(() => {});
      })();
      return true;
    }
    if (m.type === 'CONTINUAR_CENTRAL') {
      if (meuNivel !== 3) return false;
      (async () => {
        const c = await casoLer();
        if (c && c.sistema === 'projudi') { c.status = 'rodando'; c.motivo = null; await casoSalvar(c); runCentral().catch(() => {}); }
        sendResponse({ ok: true });
      })();
      return true;
    }
    if (m.type === 'CANCELAR_CENTRAL') {
      (async () => { const c = await casoLer(); if (c && c.sistema === 'projudi') await casoLimpar(); sendResponse({ ok: true }); })();
      return true;
    }
    return false;
  });

  // Auto-retomada a cada carga de página (o wizard recarrega o tempo todo).
  (async () => {
    const c = await casoLer();
    if (c && c.sistema === 'projudi') setTimeout(() => runCentral().catch(() => {}), 1200);
  })();
})();
