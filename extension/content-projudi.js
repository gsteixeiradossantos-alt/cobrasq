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
  // Guarda de idempotência (manifest + reinjeção da Central). Ver CA1/M1.
  if (window.__cobrasqProjudi) return;
  window.__cobrasqProjudi = true;

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
  // Relê o caso APÓS uma espera longa (25s do tipo, minutos do upload): outra
  // mensagem/frame pode ter gravado estado novo — gravar o `c` capturado antes da
  // espera sobregravaria (last-write-wins) um Continuar do usuário ou um motivo de
  // pausa mais específico. null = aborta a passada (outra execução assumiu).
  async function casoAposEspera(c) {
    const cur = await casoLer();
    if (!cur || cur.sistema !== 'projudi' || cur.id !== c.id) return null;
    if (cur.status === 'pausado') return null; // já pausado por outro frame: preserva o motivo dele
    return cur;
  }
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

  // Executa código NO MUNDO DA PÁGINA. Caminho BLINDADO: pede ao background rodar
  // via chrome.scripting world:'MAIN' (isento do CSP da página). Fallback local:
  // injeta um <script> (pode ser barrado por CSP em páginas mais novas).
  async function execNaPagina(payload) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'EXEC_PAGINA', ...payload });
      // M6/B7: só considera sucesso se a função REALMENTE rodou no mundo da página
      // (resultado===true). ok:true sem resultado = função inexistente/CSP → tenta
      // o fallback e, se nada confirmar, o chamador decide (pausa).
      if (r && r.ok && r.resultado === true) return true;
    } catch (_) {}
    // fallback: injeção local (só funciona sem CSP restritivo — pode ser barrado).
    try {
      const code = payload.code || (payload.fn ? payload.fn + '(' + (payload.args || []).map(a => JSON.stringify(a)).join(',') + ')' : '');
      if (!code) return false;
      const s = document.createElement('script');
      s.textContent = 'try{' + code + '}catch(e){}';
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      return false; // não há como confirmar execução via injeção local
    } catch (_) { return false; }
  }
  // "f1('a'); f2();" → [{fn:'f1',args:['a']},{fn:'f2',args:[]}] — ou null se houver
  // qualquer coisa além de chamadas simples. Motivo (CAUSA RAIZ v0.8.1): o caminho
  // antigo mandava multi-statement para eval no mundo MAIN, e o eval é BLOQUEADO
  // pelo CSP da página — por isso "openDialogSelecao(x)" (1 função) sempre abria a
  // janela, mas "disableScreen(); selectTipoDocumento();" (2 funções) nunca rodava.
  function extrairChamadas(js) {
    const stmts = js.split(';').map(s => s.trim()).filter(s => s && s !== 'void(0)' && !/^return\b/.test(s));
    if (!stmts.length) return null;
    const calls = [];
    for (const st of stmts) {
      const m = st.match(/^([A-Za-z_$][\w$]*)\s*\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)$/);
      if (!m) return null;
      const arg = m[2] !== undefined ? m[2] : m[3]; // distingue "sem arg" de arg "" (string vazia)
      calls.push(arg !== undefined ? { fn: m[1], args: [arg] } : { fn: m[1], args: [] });
    }
    return calls;
  }
  // Aciona "de verdade" um controle cujo gatilho é JS da página (href=javascript:… ou
  // onclick=…). onclick INLINE: o clique NATIVO já dispara o handler no mundo da
  // página (é assim que o clique humano funciona; o Projudi inteiro usa onclick
  // inline, logo o CSP permite). href=javascript:… vira chamada(s) de função global
  // via background world:MAIN — NUNCA eval (bloqueado pelo CSP).
  async function clicarPagina(el) {
    if (!el) return false;
    const href = (el.getAttribute && el.getAttribute('href')) || '';
    const onclick = (el.getAttribute && el.getAttribute('onclick')) || '';
    if (onclick && !/^javascript:/i.test(href)) { clicar(el); return true; }
    const js = /^javascript:/i.test(href) ? href.replace(/^javascript:/i, '') : (onclick || '');
    if (js) {
      const calls = extrairChamadas(js);
      if (calls) return execNaPagina(calls.length === 1 ? { fn: calls[0].fn, args: calls[0].args } : { calls });
      return execNaPagina({ code: js }); // último recurso (pode ser barrado por CSP)
    }
    clicar(el); return true;
  }

  // ── busca de controles por texto (rótulos/valores/títulos) ───────────────────
  function acharControle(termos, tags) {
    const cands = Array.from(document.querySelectorAll(tags || 'input[type="submit"],input[type="button"],button,a'))
      .filter(visivel);
    for (const t of termos) {
      const alvo = norm(t);
      for (const el of cands) {
        const txt = norm(((el.value || '') + ' ' + (el.textContent || '') + ' ' + (el.title || '') + ' ' + (el.alt || '')).trim());
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
    // M2: os botões podem chegar por AJAX depois do document_idle — espera antes de
    // decidir; se nunca vierem, pausa (NÃO navega embora, senão loop).
    const btn = await esperar(() => {
      const cu = document.getElementById('cumprirButton'), pe = document.getElementById('peticionarButton');
      if (cu && visivel(cu)) return cu;
      if (pe && visivel(pe)) return pe;
      return null;
    }, 8000);
    if (btn && btn.id === 'cumprirButton') { progresso(c, 'pendência encontrada → Cumprir Prazo'); clicar(btn); return; }
    if (btn) { progresso(c, 'sem pendência aparente → Petição Eletrônica'); clicar(btn); return; }
    return pausar(c, 'estou no processo mas não achei "Cumprir Prazo" nem "Petição Eletrônica" — clique você no caminho certo (se houver intimação: Ver Intimação → Cumprir Prazo) e depois Continuar');
  }

  // Tela: juntar documento (cumprirIntimacao/juntarDocumento — form juntarDocumentoForm).
  // Tipo via LUPA (#descricaoTipoDocumento → hidden #idTipoDocumento); "Adicionar"
  // abre o diálogo de upload (iframe upload.do — outra instância cuida).
  // B1: conta só linhas que são anexo de verdade (têm ação de remover ou um .pdf),
  // ignora cabeçalho/placeholder "Nenhum registro encontrado".
  function linhasAnexos() {
    return Array.from(document.querySelectorAll('.resultTable tbody tr, #juntarDocumentoForm table tbody tr'))
      .filter(tr => {
        if (!visivel(tr)) return false;
        if (/nenhum registro/i.test(tr.textContent || '')) return false;
        return !!tr.querySelector('a[onclick*="remover"], a[onclick*="excluir"], input[type="checkbox"]') || /\.pdf/i.test(tr.textContent || '');
      }).length;
  }
  // Janela da LUPA (tipoDocumento.do) — roda no iframe da janela "Seleção de Tipo
  // de Documento". Detecção: URL do frame OU (heading + radios na própria tela).
  function ehDialogoTipo() {
    if (/tipoDocumento\.do/i.test(location.href || '')) return true;
    // Fallback same-doc: exige SINAIS exclusivos do diálogo (#selectButton + rádios).
    // NÃO usar o texto "Seleção de Tipo de Documento": ele também aparece na tela de
    // juntada (é o título da lupinha) e faria a juntada ser confundida com a janela.
    return !!document.getElementById('selectButton') && !!document.querySelector('input[type="radio"]');
  }
  // Escolhe o tipo na janela: Descrição → Pesquisar → marca o radio que casa →
  // Selecionar (o Projudi fecha o diálogo e preenche o hidden na tela-mãe).
  async function telaDialogoTipo(c) {
    const tipoTxt = c.tipo_peticao || 'Manifestação da Parte';
    const alvo = norm(tipoTxt);
    const palavras = alvo.split(/\W+/).filter(w => w.length >= 4);
    const radiosVis = () => Array.from(document.querySelectorAll('input[type="radio"]')).filter(visivel);
    const linhaDoRadio = (r) => { const row = r.closest('tr,li,label,div'); return norm(row ? row.textContent : ''); };
    const casa = (r) => { const t = linhaDoRadio(r); return t.includes(alvo) || (palavras.length && palavras.every(w => t.includes(w))); };
    // A árvore de tipos chega por AJAX (ajaxtags) DEPOIS do load — espera os rádios
    // aparecerem (até 8s) antes de decidir qualquer coisa (senão pausa cedo demais).
    await new Promise(r => setTimeout(r, 400)); // deixa o frame assentar
    await esperar(() => radiosVis().length, 8000, 300);
    // Se o item JÁ está na lista (a janela abre com todos os tipos), escolhe direto —
    // não filtra (evita re-submit em loop). Só filtra por Descrição se não achar.
    let radios = radiosVis();
    if (!radios.some(casa)) {
      const desc = inputPorRotulo(['descricao', 'descrição']) ||
        Array.from(document.querySelectorAll('input[type="text"],input:not([type])')).find(visivel);
      if (desc) {
        setInput(desc, tipoTxt);
        const pesquisar = acharControle(['pesquisar', 'filtrar', 'consultar']);
        if (pesquisar) await clicarPagina(pesquisar);
        await esperar(() => radiosVis().some(casa), 6000);
        radios = radiosVis();
      }
    }
    let alvoRadio = radios.find(casa) || (radios.length === 1 ? radios[0] : null);
    if (!alvoRadio) return pausar(c, 'não achei "' + escHtml(tipoTxt) + '" na janela de tipo — escolha você na lista e clique <b>Selecionar</b>; depois Continuar.');
    // SELEÇÃO ROBUSTA: o Projudi (ajaxtags) registra a escolha pelo onclick do rádio/
    // linha, não só pelo .checked — então marca, dispara a sequência de mouse COMPLETA
    // (mousedown→mouseup→click) e, se o rádio/linha tiver onclick da página, executa
    // de verdade no mundo MAIN. Sem isso, o "Selecionar" acha que nada foi escolhido.
    try { alvoRadio.scrollIntoView({ block: 'center' }); } catch (_) {}
    alvoRadio.checked = true;
    const linhaEl = alvoRadio.closest('label,td,tr,li,a') || alvoRadio;
    for (const ev of ['mousedown', 'mouseup', 'click']) {
      try { alvoRadio.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true })); } catch (_) {}
      try { if (linhaEl !== alvoRadio) linhaEl.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true })); } catch (_) {}
    }
    alvoRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    // GARANTIA (independente do JS da página): escreve o resultado DIRETO na tela-mãe
    // — exatamente o que selectTipoDocumento() faria (os nomes dos campos vêm na
    // própria URL da janela: parentIdField/parentDescricaoField). Mesma origem, ok.
    const rowSel = alvoRadio.closest('tr,li,label,div');
    const descricaoRaw = (((rowSel ? rowSel.textContent : '') || tipoTxt).replace(/\s+/g, ' ').trim()).slice(0, 200);
    const q = new URLSearchParams(location.search || '');
    try {
      const pdoc = window.parent.document;
      const pid = pdoc.getElementById(q.get('parentIdField') || 'idTipoDocumento');
      const pdesc = pdoc.getElementById(q.get('parentDescricaoField') || 'descricaoTipoDocumento');
      if (pid && alvoRadio.value) {
        pid.value = alvoRadio.value;
        if (pdesc) pdesc.value = descricaoRaw;
        pid.dispatchEvent(new Event('change', { bubbles: true }));
        if (pdesc) pdesc.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {}
    progresso(c, 'tipo "' + tipoTxt + '" selecionado → confirmando');
    // Via oficial p/ FECHAR a janela: clique NATIVO no Selecionar (#selectButton,
    // onclick inline "disableScreen(); selectTipoDocumento();" roda no mundo da
    // página no clique, como um clique humano). Se não fechar, a tela-mãe fecha o
    // overlay sozinha — o campo já está garantido pelo bloco acima.
    const selecionar = document.getElementById('selectButton') || acharControle(['selecionar']);
    if (selecionar) clicar(selecionar);
  }
  // Acha a lupinha do campo "Tipo de Documento" (abre a janela oficial de Seleção).
  function acharLupaTipo() {
    return document.querySelector('a.searchButton[href*="openDialogSelecao"], a[href*="openDialogSelecaoTipoDocumento"]') ||
      Array.from(document.querySelectorAll('a,[onclick]')).find(el =>
        /openDialogSelecaoTipoDocumento|openDialogSelecao/.test((el.getAttribute('href') || '') + (el.getAttribute('onclick') || ''))) || null;
  }
  async function telaJuntar(c) {
    if (document.querySelector('iframe[src*="upload.do"]')) return; // diálogo aberto: quem age é a instância dele
    if (c.fase === 'assinar') return; // já orientado: esperando o advogado concluir/assinar
    // 1) tipo do movimento ("JUNTADA DE …") — autocomplete: digita, espera a lista
    // via LUPA (determinístico): openDialogSelecao abre a janela oficial de Seleção
    // de Tipo de Documento; ao escolher o item, o próprio Projudi preenche o hidden
    // #idTipoDocumento. Bem mais confiável que o autocomplete (AJAX + eventos).
    const hid = document.getElementById('idTipoDocumento');
    const desc = document.getElementById('descricaoTipoDocumento');
    if (desc && hid && !hid.value) {
      const tipoTxt = c.tipo_peticao || 'Manifestação da Parte';
      // O tipo NÃO é texto livre: o Projudi só aceita o item escolhido na janela de
      // Seleção (ela preenche #idTipoDocumento sozinha). Então abrimos a LUPA e a
      // instância da extensão dentro do iframe da janela marca o item e clica
      // Selecionar (ver telaDialogoTipo). Nada de digitar o texto — isso não vale.
      if (!c.abriuLupa) {
        const lupa = acharLupaTipo();
        if (!lupa) return pausar(c, 'não achei a lupinha ao lado de "Tipo de Documento" — clique você nela, escolha <b>' + escHtml(tipoTxt) + '</b>, clique <b>Selecionar</b> e depois Continuar.');
        progresso(c, 'abrindo a janela de Seleção de Tipo…');
        await clicarPagina(lupa);
        c.abriuLupa = true; await casoSalvar(c);
      }
      // A janela (iframe) se encarrega de escolher e clicar Selecionar; aqui só
      // esperamos o Projudi preencher o hidden. NÃO segura o mutex do iframe: são
      // janelas/execuções separadas (a janela é um iframe de verdade — tjpr.js).
      const ok = await esperar(() => hid.value, 25000, 500);
      if (!ok) {
        const cur = await casoAposEspera(c); // F-A1: não sobregravar estado mais novo
        if (!cur) return;
        cur.abriuLupa = false; await casoSalvar(cur); // permite reabrir na próxima passada
        return pausar(cur, 'a janela de Seleção abriu, mas não consegui confirmar "<b>' + escHtml(tipoTxt) + '</b>" sozinho — na janela, clique no tipo e em <b>Selecionar</b>; depois <b>Continuar</b>. (a fila segue sozinha)');
      }
      progresso(c, 'tipo confirmado → anexos');
      // Se a janela da lupa ainda estiver aberta (Selecionar não fechou), fecha pelo
      // X do Window ('<id>_close', onclick inline Windows.close roda no clique
      // nativo) — o overlay modal bloquearia o botão "Adicionar" dos anexos.
      const sobraX = document.querySelector('div[id$="_close"]');
      if (sobraX && visivel(sobraX)) { clicar(sobraX); await new Promise(r => setTimeout(r, 400)); }
    }
    // 2) anexos
    if (!(c.docs || []).length) return pausar(c, 'este caso não tem PDF para anexar — refaça na Central.'); // B6
    if (linhasAnexos() < c.docs.length) {
      if (!c.abriuUpload) {
        // Botão que abre o envio de arquivos — cobre rótulos e tipos de controle
        // variados (input button/image, <a>, <button>) e a lupa/ícone de "+".
        const add = acharControle(['adicionar arquivo', 'adicionar documento', 'adicionar', 'incluir arquivo', 'incluir documento', 'incluir', 'anexar arquivo', 'anexar'],
          'input[type=submit],input[type=button],input[type=image],button,a,[onclick]');
        if (!add) {
          const botoes = Array.from(document.querySelectorAll('input[type=submit],input[type=button],input[type=image],button,a'))
            .filter(visivel).map(b => norm((b.value || b.textContent || b.title || b.alt || '')).trim()).filter(Boolean).slice(0, 14).join(' · ');
          return pausar(c, 'não achei o botão para anexar (procurei Adicionar/Incluir/Anexar). Botões visíveis agora: <b>' + escHtml(botoes || '(nenhum)') + '</b>. Clique você no botão de anexar e depois Continuar — me diga qual era o nome certo.');
        }
        progresso(c, 'abrindo o envio de arquivos…');
        await new Promise(r => setTimeout(r, 800)); // M4: deixa os handlers assentarem
        clicar(add);
        // M4: confirma que o diálogo (iframe upload.do) abriu ANTES de marcar a flag;
        // senão reverte e re-tenta na próxima passada (evita timeout de 3min à toa).
        const abriu = await esperar(() => document.querySelector('iframe[src*="upload.do"]') || document.getElementById('fileUploadForm'), 8000);
        if (!abriu) return pausar(c, 'cliquei em "Adicionar" mas o envio de arquivos não abriu — clique você e depois Continuar');
        c.abriuUpload = true; await casoSalvar(c);
      }
      progresso(c, 'aguardando os PDFs subirem…');
      const tempo = Math.max(120000, c.docs.length * 60000); // B4: proporcional aos docs
      const subiu = await esperar(() => linhasAnexos() >= c.docs.length, tempo, 800);
      if (!subiu) {
        const cur = await casoAposEspera(c); // F-A1
        if (!cur) return;
        cur.abriuUpload = false; cur.uploadFeito = false; await casoSalvar(cur);
        return pausar(cur, 'os anexos não apareceram na lista — confira o diálogo de envio (Adicionar → escolher arquivos → Confirmar Inclusão) e clique Continuar');
      }
    }
    // 3) tudo anexado → o humano conclui e assina (senha é sempre sua)
    // F-A1: houve esperas longas acima — regrava sobre o estado ATUAL do storage;
    // se outro frame pausou/trocou o caso nesse meio-tempo, aborta a passada.
    const cFinal = await casoAposEspera(c);
    if (!cFinal) return;
    cFinal.fase = 'assinar'; await casoSalvar(cFinal); c = cFinal;
    const concluirBtn = acharControle(['concluir movimento', 'concluir']);
    if (concluirBtn) destacar(concluirBtn, '#1a7f37');
    return pausar(c, 'PDF(s) anexado(s) ✔ — confira, clique <b>Concluir Movimento</b> e ASSINE com sua senha. Depois do protocolo, clique <b>Continuar</b> na Central que eu dou o caso por concluído e sigo a fila.');
  }

  // Diálogo de upload (upload.do — form fileUploadForm; roda em iframe próprio).
  // O onchange do input de arquivos JÁ envia sozinho (atualiza_arquivos_selecionados→enviar(2)),
  // mas exige codDescricao selecionado ANTES (senão alert).
  async function telaUpload(c) {
    if (c.uploadFeito) return;
    if (!(c.docs || []).length) return; // B6
    const sel = document.getElementById('codDescricao');
    const inputArq = document.getElementById('conteudo');
    if (!sel || !inputArq) return;
    progresso(c, 'enviando ' + c.docs.length + ' PDF(s)…');
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
    // M5: espera SINAL de conclusão do envio (a lista do diálogo recebe as linhas
    // dos arquivos, ou o input volta a ficar vazio) em vez de sleep fixo de 5s —
    // fechar cedo cancelaria upload de PDF grande. Só então confirma a inclusão.
    await esperar(() => {
      const linhas = document.querySelectorAll('#fileUploadForm table tbody tr, .resultTable tbody tr').length;
      return linhas >= c.docs.length || (inputArq.value === '' && linhas > 0);
    }, Math.max(60000, c.docs.length * 45000), 700);
    try {
      const fechar = document.getElementById('closeButton') || acharControle(['confirmar inclusao']);
      if (fechar) clicar(fechar);
    } catch (_) { /* diálogo pode ter fechado sozinho */ }
  }

  // Tela pré-login do Projudi (index): cartões "Magistrados…", "Advogados, Partes…",
  // "Certificado Digital". O 1º passo é entrar por "Advogados, Partes" (CPF/senha).
  function acessoAdvogado() {
    const txt = norm(document.body ? document.body.innerText : '');
    const naTela = txt.includes('acesso ao sistema') || txt.includes('cadastro no sistema') ||
      txt.includes('usuarios externos') || /advogad/.test(txt);
    if (!naTela) return null;
    // Queremos o cartão de usuários EXTERNOS (advogados, procuradores, partes, MP,
    // peritos) — NUNCA o de magistrados/servidores. O título nem sempre traz "Partes"
    // colado em "Advogados" (ex.: "Advogados, Procuradores, Partes…" ou o complemento
    // "Membros do MP, Peritos e demais usuários externos ao TJPR"), então casamos por
    // QUALQUER palavra-chave externa e excluímos as internas.
    // F-A4: escolhe SÓ entre CLICÁVEIS e por PONTUAÇÃO (título "advogad…" curto ganha)
    // — "último elemento do DOM" podia cair num rodapé/aviso que citasse advogados.
    const externo = /advogad|procurador|\bpartes?\b|usuarios? externos|membros do mp|\bperitos?\b/;
    const interno = /magistrados?|servidores?/;
    const pontua = (t) => (t.startsWith('advogad') ? 0 : /advogad/.test(t) ? 1 : 2) * 1000 + t.length;
    const clicaveis = Array.from(document.querySelectorAll('a[href], [onclick], button'))
      .filter(visivel)
      .map(el => ({ el, t: norm(el.textContent) }))
      .filter(o => o.t && o.t.length < 240 && externo.test(o.t) && !interno.test(o.t))
      .sort((a, b) => pontua(a.t) - pontua(b.t));
    if (clicaveis.length) return clicaveis[0].el;
    // Fallback (cartão com listener JS, sem href/onclick no atributo): elemento de
    // TEXTO que melhor pontua; o clique borbulha até o listener do cartão.
    const textuais = Array.from(document.querySelectorAll('a, div, button, li, td, span, h1, h2, h3'))
      .filter(el => visivel(el))
      .map(el => ({ el, t: norm(el.textContent) }))
      .filter(o => o.t && o.t.length < 240 && externo.test(o.t) && !interno.test(o.t))
      .sort((a, b) => pontua(a.t) - pontua(b.t));
    if (!textuais.length) return null;
    const alvo = textuais[0].el;
    const dentro = alvo.querySelector && alvo.querySelector('a[href],[onclick]');
    return (dentro && visivel(dentro)) ? dentro : alvo;
  }

  // Mutex de reentrância — auto-retomar (1200ms) + RUN + CONTINUAR. Ver C3.
  let _rodandoProjudi = false;
  async function runCentral() {
    if (_rodandoProjudi) return;
    _rodandoProjudi = true;
    try {
    const c = await casoLer();
    if (!c || c.sistema !== 'projudi') return;
    // A janela da lupa é um iframe não-condutor, mas precisa agir (escolher o tipo).
    if (c.status !== 'pausado' && ehDialogoTipo()) { await telaDialogoTipo(c); return; }
    if (!ehCondutor()) {
      // Tela pré-login: clica em "Advogados, Partes" para chegar ao login. O cartão
      // pode estar no TOPO ou num FRAME (o Projudi usa frameset até no acesso) — só
      // age o frame cujo PRÓPRIO documento contém o cartão.
      if (c.status !== 'pausado') {
        const naTelaAcesso = /acesso ao sistema/.test(norm(document.body ? document.body.innerText : ''));
        const acesso = acessoAdvogado();
        if (acesso) {
          progresso(c, 'entrando por "Advogados, Partes"…');
          const ok = await clicarPagina(acesso);
          // M8: se o clique não pôde ser executado (CSP/estrutura), entrega ao humano.
          if (!ok) return pausar(c, 'não consegui abrir o acesso automaticamente — clique você em <b>Advogados, Partes</b> (ou faça seu login por certificado) e clique Continuar.');
          return;
        }
        // M8: estamos na tela de acesso mas não achamos o cartão CPF+senha (ex.: fluxo
        // por Certificado Digital/PIN) → pausa entregando o login ao humano.
        if (naTelaAcesso) return pausar(c, 'faça o <b>login no Projudi</b> como preferir (CPF/CNPJ+senha ou certificado) e clique Continuar — a fila segue sozinha depois.');
      }
      // Frames coadjuvantes só cuidam do login (a tela de senha pode aparecer
      // em qualquer moldura); o resto é do userMainFrame/diálogo de upload.
      if (temLogin() && c.status !== 'pausado') { await pausar(c, 'login'); setBody(msg('Faça o <b>login no Projudi</b> — a fila continua sozinha depois.', '#fff3bf')); }
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
      if (document.getElementById('processoForm')) return await telaProcesso(c); // M2: espera botões lá dentro
      if (document.getElementById('buscaProcessosQualquerInstanciaForm')) {
        // C1 (hardening): detecção POSITIVA — se já há link do processo no resultado,
        // vai direto p/ resultado; senão é a tela de busca.
        if (linkDoProcesso(c.numero_processo)) return await telaResultado(c);
        if (document.getElementById('numeroProcesso')) return await telaBusca(c);
        return await telaResultado(c);
      }
      // M3: só navega pelo menu quando estamos claramente na "mesa do advogado";
      // numa tela intermediária desconhecida do fluxo, PAUSA (não navega, senão loop).
      const naMesa = document.getElementById('mesaAdvogadoForm') || /mesaAdvogado|principal\.php|home\.do/i.test(location.href || '');
      if (naMesa) { await abrirBuscaPeloMenu(c); return; }
      return pausar(c, 'cheguei numa tela que ainda não reconheço no fluxo — seu clique resolve (ex.: se houver intimação, Ver Intimação → Cumprir Prazo). Ajuste e clique Continuar.');
    } catch (e) { const c2 = await casoLer(); if (c2) await pausar(c2, 'erro inesperado: ' + String((e && e.message) || e)); }
    } finally { _rodandoProjudi = false; }
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
        await casoSalvar({ ...m.caso, status: 'rodando', motivo: null, fase: null, abriuLupa: false, abriuUpload: false, uploadFeito: false, retomadoPeloUsuario: false });
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
          if (c.fase === 'assinar') {
            c.retomadoPeloUsuario = true; // pós-assinatura: Continuar = caso concluído
          } else {
            // C2: o humano pode ter resolvido algo (anexo/tipo) — não confiar nas
            // flags velhas; derivar do DOM na próxima passada.
            c.abriuLupa = false; c.abriuUpload = false; c.uploadFeito = false;
          }
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
