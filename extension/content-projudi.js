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

  // ── quem dirige ──────────────────────────────────────────────────────────────
  // O Projudi tem TRÊS frames irmãos (topFrame de 45px, mainFrame com o menu e,
  // dentro dele, o iframe userMainFrame com a tela). Checagem POSITIVA: só o
  // userMainFrame (nome dado pelo nível 2) ou o diálogo/pop-up de upload dirigem —
  // senão o topFrame vira "condutor" e pausa o lote à toa (visto no 1º teste real).
  function ehCondutor() {
    if (document.getElementById('fileUploadForm')) return true; // diálogo/pop-up de upload
    return window !== window.top && window.name === 'userMainFrame';
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

  // ── telas (calibradas com os saves reais do Projudi TJPR) ────────────────────
  const digitos = (s) => String(s || '').replace(/\D/g, '');
  function linkDoProcesso(numero) {
    const alvo = digitos(numero);
    return Array.from(document.querySelectorAll('a[href*="processo.do"], a.link')).find(a => visivel(a) && digitos(a.textContent).includes(alvo) && alvo.length >= 13) || null;
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

  // Tela: Buscar Processos (form buscaProcessosQualquerInstanciaForm + #numeroProcesso).
  async function telaBusca(c) {
    const campo = document.getElementById('numeroProcesso');
    progresso(c, 'buscando o processo ' + c.numero_processo + '…');
    setInput(campo, c.numero_processo);
    const btn = document.getElementById('pesquisar') || acharControle(['pesquisar']);
    if (!btn) return pausar(c, 'tela de busca: não achei o botão Pesquisar — clique você e depois Continuar', campo);
    clicar(btn); // o form navega; o script renasce na tela de resultado
  }

  // Tela: resultado da busca (mesma form, linhas com checkbox name="processos" + link p/ processo.do).
  async function telaResultado(c) {
    const link = await esperar(() => linkDoProcesso(c.numero_processo), 6000);
    if (link) { progresso(c, 'abrindo o processo…'); clicar(link); return; }
    return pausar(c, 'processo ' + c.numero_processo + ' não apareceu no resultado — confira o número (a busca fica em Buscas → Processos 1º Grau), abra o processo e clique Continuar');
  }

  // Tela: o processo (processo.do — form processoForm com #cumprirButton/#peticionarButton).
  async function telaProcesso(c) {
    const cumprir = document.getElementById('cumprirButton');
    const peticionar = document.getElementById('peticionarButton');
    if (cumprir && visivel(cumprir)) { progresso(c, 'pendência encontrada → Cumprir Prazo'); clicar(cumprir); return; }
    if (peticionar && visivel(peticionar)) { progresso(c, 'sem pendência aparente → Petição Eletrônica'); clicar(peticionar); return; }
    return pausar(c, 'estou no processo mas não achei "Cumprir Prazo" nem "Petição Eletrônica" — clique você no caminho certo (se houver intimação: Ver Intimação → Cumprir Prazo) e depois Continuar');
  }

  // Tela: juntar documento (cumprirIntimacao/juntarDocumento — form juntarDocumentoForm).
  // Tipo via autocomplete (#descricaoTipoDocumento → hidden #idTipoDocumento), botão
  // "Adicionar" abre o diálogo de upload (iframe upload.do — outra instância cuida).
  function linhasAnexos() {
    return Array.from(document.querySelectorAll('.resultTable tbody tr'))
      .filter(tr => visivel(tr) && (tr.textContent || '').trim().length > 5).length;
  }
  async function telaJuntar(c) {
    if (document.querySelector('iframe[src*="upload.do"]')) return; // diálogo aberto: quem age é a instância dele
    if (c.fase === 'assinar') return; // já orientado: esperando o advogado concluir/assinar
    // 1) tipo do movimento ("JUNTADA DE …") — autocomplete: digita, espera a lista
    // #ajaxAuto_descricaoTipoDocumento e CLICA na sugestão (só digitar não confirma).
    const hid = document.getElementById('idTipoDocumento');
    const desc = document.getElementById('descricaoTipoDocumento');
    if (desc && hid && !hid.value) {
      const tipoTxt = c.tipo_peticao || 'Manifestação da Parte';
      const alvo = norm(tipoTxt);
      progresso(c, 'definindo o tipo: ' + tipoTxt);
      // O autocompleteJS do Projudi ouve o evento 'input', busca via AJAX e monta a
      // lista num <div id="<campo>autocomplete-list"> com um <div> por sugestão; o
      // click do <div> preenche o hidden e chama select(). O 1º teste mostrou que
      // "manif" já traz a única sugestão — então simulamos digitação de verdade
      // (tecla a tecla, com input a cada char) e clicamos na sugestão que casa.
      // A lista pode aparecer em #<id>autocomplete-list (novo) ou #ajaxAuto_<id> (legado).
      const acharSug = () => {
        const boxes = [document.getElementById(desc.id + 'autocomplete-list'), document.getElementById('ajaxAuto_' + desc.id)].filter(Boolean);
        for (const box of boxes) {
          const its = Array.from(box.querySelectorAll('div,li,a')).filter(d => visivel(d) && (d.textContent || '').trim());
          if (!its.length) continue;
          const m = its.find(d => norm(d.textContent).includes(alvo)) || its.find(d => norm(d.textContent).includes('manifestacao'));
          if (m) return m;
          if (its.length === 1) return its[0];
        }
        return null;
      };
      const termo = (tipoTxt.split(/\s+/).find(w => w.length >= 5) || tipoTxt).toLowerCase().slice(0, 8);
      desc.focus();
      desc.value = '';
      let sug = null;
      for (let i = 0; i < termo.length && !sug; i++) {
        const ch = termo[i];
        desc.value += ch;
        desc.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch }));
        desc.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: ch }));
        desc.dispatchEvent(new Event('input', { bubbles: true }));
        desc.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch }));
        sug = await esperar(acharSug, 1200, 150); // dá tempo do AJAX responder a cada tecla
      }
      if (!sug) sug = await esperar(acharSug, 6000);
      if (sug) {
        sug.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sug.click();
      } else {
        desc.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      const ok = await esperar(() => hid.value, 6000);
      if (!ok) return pausar(c, 'não consegui confirmar o tipo "' + escHtml(tipoTxt) + '" — deixei "' + escHtml(termo) + '" digitado no campo Tipo Movimento; clique na sugestão que aparecer (ou use a 🔍 lupa ao lado) e depois Continuar.', desc);
    }
    // 2) anexos
    if (linhasAnexos() < (c.docs || []).length) {
      if (!c.abriuUpload) {
        c.abriuUpload = true; await casoSalvar(c);
        const add = acharControle(['adicionar']);
        if (!add) return pausar(c, 'não achei o botão "Adicionar" para abrir o envio de arquivos — anexe você e clique Continuar');
        progresso(c, 'abrindo o envio de arquivos…');
        clicar(add);
      }
      progresso(c, 'aguardando os PDFs subirem…');
      const subiu = await esperar(() => linhasAnexos() >= (c.docs || []).length, 180000, 800);
      if (!subiu) { c.abriuUpload = false; await casoSalvar(c); return pausar(c, 'os anexos não apareceram na lista — confira o diálogo de envio (Adicionar → escolher arquivos → Confirmar Inclusão) e clique Continuar'); }
    }
    // 3) tudo anexado → o humano conclui e assina (senha é sempre sua)
    c.fase = 'assinar'; await casoSalvar(c);
    const concluirBtn = acharControle(['concluir movimento', 'concluir']);
    if (concluirBtn) destacar(concluirBtn, '#1a7f37');
    return pausar(c, 'PDF(s) anexado(s) ✔ — confira, clique <b>Concluir Movimento</b> e ASSINE com sua senha. Depois do protocolo, clique <b>Continuar</b> na Central que eu dou o caso por concluído e sigo a fila.');
  }

  // Diálogo de upload (upload.do — form fileUploadForm; roda em iframe próprio).
  // O onchange do input de arquivos JÁ envia sozinho (atualiza_arquivos_selecionados→enviar(2)),
  // mas exige codDescricao selecionado ANTES (senão alert).
  async function telaUpload(c) {
    if (c.uploadFeito) return;
    const sel = document.getElementById('codDescricao');
    const inputArq = document.getElementById('conteudo');
    if (!sel || !inputArq) return;
    progresso(c, 'enviando ' + (c.docs || []).length + ' PDF(s)…');
    const alvoTipo = norm(c.tipo_peticao || 'peticao');
    let opt = Array.from(sel.options).find(o => norm(o.textContent) === alvoTipo) ||
              Array.from(sel.options).find(o => o.value !== '0' && norm(o.textContent).includes(alvoTipo)) ||
              Array.from(sel.options).find(o => norm(o.textContent).includes('peticao'));
    if (!opt) {
      opt = Array.from(sel.options).find(o => norm(o.textContent).includes('outros'));
      const descTxt = document.getElementById('descricao');
      if (descTxt) setInput(descTxt, (c.tipo_peticao || c.docs[0].nome.replace(/\.pdf$/i, '')).slice(0, 200));
    }
    if (!opt) return pausar(c, 'não achei um tipo de documento compatível no diálogo de envio — selecione o tipo, escolha os arquivos e Confirmar Inclusão; depois Continuar', sel);
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const dt = new DataTransfer();
    for (const d of c.docs) dt.items.add(await pedirDoc(c.id, d.idx));
    inputArq.files = dt.files;
    inputArq.dispatchEvent(new Event('change', { bubbles: true })); // dispara o envio automático
    c.uploadFeito = true; await casoSalvar(c);
    // dá tempo do envio terminar e confirma a inclusão (fecha o diálogo)
    await new Promise(r => setTimeout(r, 5000));
    const fechar = document.getElementById('closeButton') || acharControle(['confirmar inclusao']);
    if (fechar) clicar(fechar);
  }

  // Tela pré-login do Projudi (index): cartões "Magistrados…", "Advogados, Partes…",
  // "Certificado Digital". O 1º passo é entrar por "Advogados, Partes" (CPF/senha).
  function acessoAdvogado() {
    const txt = norm(document.body ? document.body.innerText : '');
    if (!txt.includes('acesso ao sistema') && !txt.includes('cadastro no sistema')) return null;
    const cands = Array.from(document.querySelectorAll('a, div, button, li, td'));
    const alvo = cands.find(el => visivel(el) && /advogad[oa]s?[ ,]+partes/.test(norm(el.textContent)) && norm(el.textContent).length < 200);
    if (!alvo) return null;
    return alvo.closest('a[href]') || (alvo.getAttribute && alvo.getAttribute('onclick') ? alvo : null) || alvo.querySelector('a[href]') || alvo;
  }

  async function runCentral() {
    const c = await casoLer();
    if (!c || c.sistema !== 'projudi') return;
    if (!ehCondutor()) {
      // Tela pré-login (topo): clica em "Advogados, Partes" para chegar ao login.
      if (window === window.top && c.status !== 'pausado') {
        const acesso = acessoAdvogado();
        if (acesso) { progresso(c, 'entrando por "Advogados, Partes"…'); clicar(acesso); return; }
      }
      // Frames coadjuvantes só cuidam do login (a tela de senha pode aparecer
      // em qualquer moldura); o resto é do userMainFrame/diálogo de upload.
      if (temLogin() && c.status !== 'pausado') { await pausar(c, 'login'); setBody(msg('Faça o <b>login no Projudi</b> (CPF/CNPJ + senha) — a fila continua sozinha depois.', '#fff3bf')); }
      return;
    }
    try {
      if (c.status === 'pausado') {
        if (c.motivo === 'login' && !temLogin()) { c.status = 'rodando'; c.motivo = null; await casoSalvar(c); }
        else { setBody(msg('⏸ <b>Pausado:</b> ' + (c.motivo || ''), '#fff3bf') + msg('Use os botões na aba da Central.', '#e7f5ff')); return; }
      }
      if (temLogin()) { await pausar(c, 'login'); setBody(msg('Faça o <b>login no Projudi</b> — a fila continua sozinha depois.', '#fff3bf')); return; }

      if (!c.numero_processo) return pausar(c, 'caso sem número de processo — corrija na revisão da Central');

      // FASE FINAL: o advogado assinou/protocolou e clicou Continuar.
      if (c.fase === 'assinar' && c.status === 'rodando' && c.retomadoPeloUsuario) {
        const m = (document.body.innerText || '').match(/protocolo[^\d]{0,20}(\d[\d./-]{5,})/i);
        await casoLimpar();
        reportar('CENTRAL_CASO_OK', { casoId: c.id, numero: (m && m[1]) || c.numero_processo });
        setBody(msg('✅ Caso concluído — próximo da fila.', '#d3f9d8'));
        return;
      }

      // Despacho por formulário presente na tela (IDs reais dos saves):
      if (document.getElementById('fileUploadForm')) return await telaUpload(c);
      if (document.getElementById('juntarDocumentoForm')) return await telaJuntar(c);
      if (document.getElementById('processoForm') && (document.getElementById('cumprirButton') || document.getElementById('peticionarButton'))) return await telaProcesso(c);
      if (document.getElementById('buscaProcessosQualquerInstanciaForm')) {
        if (document.getElementById('numeroProcesso')) return await telaBusca(c);
        return await telaResultado(c);
      }
      // Qualquer outra tela (mesa do advogado etc.): navega pelo menu.
      await abrirBuscaPeloMenu(c);
    } catch (e) { const c2 = await casoLer(); if (c2) await pausar(c2, 'erro inesperado: ' + String((e && e.message) || e)); }
  }

  // ── mensageria (só o frame-condutor responde às ações) ───────────────────────
  chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
    if (!m || !m.type) return false;
    // O topo SEMPRE responde (garante resposta à Central mesmo na tela de login);
    // quem age de verdade é o condutor (userMainFrame/diálogo de upload).
    const respondo = ehCondutor() || window === window.top;
    if (m.type === 'RUN_CENTRAL' && m.caso && m.caso.sistema === 'projudi') {
      if (!respondo) return false;
      (async () => {
        await casoSalvar({ ...m.caso, status: 'rodando', motivo: null, fase: null, abriuUpload: false, uploadFeito: false, retomadoPeloUsuario: false });
        sendResponse({ ok: true });
        runCentral().catch(() => {});
      })();
      return true;
    }
    if (m.type === 'CONTINUAR_CENTRAL') {
      if (!respondo) return false;
      (async () => {
        const c = await casoLer();
        if (c && c.sistema === 'projudi') {
          c.status = 'rodando'; c.motivo = null;
          if (c.fase === 'assinar') c.retomadoPeloUsuario = true; // pós-assinatura: Continuar = caso concluído
          await casoSalvar(c); runCentral().catch(() => {});
        }
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
