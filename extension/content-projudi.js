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
  if (!/(^|\.)projudi\.tjpr\.jus\.br$/.test(location.hostname)) return;
  // Guarda de idempotência (manifest + reinjeção da Central). Ver CA1/M1.
  if (window.__cobrasqProjudi) return;
  window.__cobrasqProjudi = true;

  // ── Botão de SUPORTE: copia o HTML pro clipboard (pro usuário colar no chat).
  // O Projudi é frameset — captura a ÁRVORE inteira de frames de mesma origem, e o
  // botão aparece só em frames de conteúdo (pula o topFrame de 45px e o frameset).
  function copiarTextoSuporte(txt) {
    return (navigator.clipboard ? navigator.clipboard.writeText(txt).then(() => true).catch(() => false) : Promise.resolve(false))
      .then(ok => {
        if (ok) return true;
        const ta = document.createElement('textarea'); ta.value = txt;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        (document.body || document.documentElement).appendChild(ta); ta.focus(); ta.select();
        let r = false; try { r = document.execCommand('copy'); } catch (_) {} ta.remove(); return r;
      });
  }
  function htmlDaPaginaSuporte() {
    function serializar(win, rotulo) {
      let out;
      try { out = '\n\n<!-- ===== ' + rotulo + ': ' + (win.location && win.location.href) + ' ===== -->\n' + win.document.documentElement.outerHTML; }
      catch (_) { return '\n\n<!-- ' + rotulo + ': (outra origem — não acessível) -->'; }
      try { for (let i = 0; i < win.frames.length; i++) out += serializar(win.frames[i], rotulo + '>frame[' + i + ']'); } catch (_) {}
      return out;
    }
    let raiz; try { raiz = window.top; } catch (_) { raiz = window; }
    return '<!-- CAPTURA PROJUDI (arvore de frames) -->' + serializar(raiz, 'TOP');
  }
  function botaoCapturaSuporte() {
    if (!document.body || window.innerHeight < 150) return;  // pula frameset e topFrame
    if (document.getElementById('cobrasq-cap-html')) return;
    const b = document.createElement('button');
    b.id = 'cobrasq-cap-html'; b.textContent = '📋 HTML';
    b.title = 'Copiar o HTML desta página para enviar ao suporte (Claude)';
    b.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#0c2340;color:#fff;border:0;border-radius:8px;padding:8px 12px;font:12px system-ui,Arial,sans-serif;cursor:pointer;opacity:.8;box-shadow:0 4px 14px rgba(0,0,0,.2);';
    b.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const html = htmlDaPaginaSuporte();
      const ok = await copiarTextoSuporte(html);
      b.textContent = ok ? ('✅ copiado (' + Math.round(html.length / 1024) + ' KB) — cole no chat') : '⚠ não copiou — use o F12';
      setTimeout(() => { b.textContent = '📋 HTML'; }, 5000);
    }, true);
    document.body.appendChild(b);
  }
  try { botaoCapturaSuporte(); } catch (_) {}

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
    // Toda pausa CANCELA o auto-concluir em voo: sem isto, uma pausa (ex.: login expirado)
    // no meio do "Concluir Movimento" deixava a flag viva e, ao retomar, a simples volta à
    // tela do processo era lida como "protocolado" — falso sucesso em ato irreversível.
    c.autoConcluindo = false;
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
    let hrefJs = /^javascript:/i.test(href) ? href.replace(/^javascript:/i, '').trim() : '';
    // "javascript:void(0)" / "javascript:;" NÃO é ação real — trata como sem-js para
    // cair no clique NATIVO (senão, com onclick real ao lado, o handler não dispararia).
    if (/^(void\s*\(?\s*0\s*\)?|void\s+0)?\s*;*\s*$/i.test(hrefJs)) hrefJs = '';
    // onclick inline (ou nada de função real no href) → CLIQUE NATIVO dispara o handler
    // da página (como o clique humano). Prioriza onclick sobre href javascript:void(0).
    if (onclick || !hrefJs) { clicar(el); return true; }
    // href=javascript:funçãoReal(...) SEM onclick → executa no mundo MAIN (imune a CSP).
    const calls = extrairChamadas(hrefJs);
    if (calls) return execNaPagina(calls.length === 1 ? { fn: calls[0].fn, args: calls[0].args } : { calls });
    return execNaPagina({ code: hrefJs }); // último recurso (pode ser barrado por CSP)
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

  // Confere se a TELA atual pertence ao processo do caso (guarda fail-closed da
  // auditoria: telas VELHAS de juntada/intimação de outro processo eram roteadas
  // direto para a ação — peça ia parar no processo errado). 'ok' = número do caso
  // está na tela; 'errado' = a tela mostra outro CNJ; 'desconhecido' = nenhum CNJ
  // legível (tela ainda carregando ou sem número).
  const RE_CNJ = /\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/;
  function confereProcessoNaTela(c, doc) {
    const alvo = digitos(c.numero_processo);
    if (alvo.length < 13) return 'desconhecido';
    const d = doc || document;
    const corpo = d.body ? d.body.innerText : '';
    if (digitos(corpo).includes(alvo)) return 'ok';
    return RE_CNJ.test(corpo) ? 'errado' : 'desconhecido';
  }

  // Telas da intimação (intimacao.do): (a) aviso "Existem mais intimações não lidas…
  // Confirma?" → PAUSA (decisão do usuário: confirmar inicia o prazo de TODAS as
  // intimações não lidas, inclusive de outros casos); (b) a intimação em si →
  // "Cumprir Prazo" (abre a juntada), com guarda de processo certo.
  function ehTelaIntimacao() {
    if (document.getElementById('intimacaoForm')) return true;
    const cont = document.getElementById('continueButton');
    return !!cont && /intima[cç][oõ]es\s+n[aã]o\s+lidas|todas\s+ter[aã]o\s+seu\s+prazo/i.test(document.body ? document.body.innerText : '');
  }
  async function telaIntimacao(c) {
    // (a) aviso de confirmação (sem "Cumprir Prazo" ainda) → PAUSA. Confirmar aqui
    // inicia o prazo LEGAL de TODAS as intimações não lidas do advogado (o próprio
    // aviso diz isso) — efeito colateral fora do caso corrente; a decisão é humana.
    if (!document.getElementById('cumprirButton')) {
      const cont = document.getElementById('continueButton') ||
        acharControle(['continuar'], 'input[type=submit],input[type=button],button,a');
      if (cont && visivel(cont)) {
        destacar(cont, '#fab005');
        return pausar(c, 'o Projudi avisa que há <b>mais intimações não lidas</b> e que TODAS terão o prazo iniciado ao continuar. Decida você: clique <b>Continuar</b> na tela do Projudi (se quiser prosseguir) e depois <b>Continuar</b> na Central.');
      }
    }
    // (b) a intimação → "Cumprir Prazo" — SÓ se a tela for do processo do caso.
    const conf = confereProcessoNaTela(c);
    if (conf !== 'ok') {
      return pausar(c, 'não confirmei que esta intimação é do processo <b>' + escHtml(c.numero_processo) + '</b>' +
        (conf === 'errado' ? ' (a tela mostra OUTRO processo — pode ser tela antiga)' : ' (número não visível na tela)') +
        ' — abra a intimação certa e clique Continuar.');
    }
    const cumprir = document.getElementById('cumprirButton') ||
      acharControle(['cumprir prazo', 'cumprir'], 'input[type=submit],input[type=button],button,a');
    if (cumprir && visivel(cumprir)) {
      progresso(c, 'intimação → Cumprir Prazo');
      clicar(cumprir);
      setTimeout(() => runCentral().catch(() => {}), 2500);
      return;
    }
    return pausar(c, 'estou na intimação mas não achei <b>Cumprir Prazo</b> — clique você e depois Continuar.');
  }

  // Tela: o processo (processo.do — form processoForm com #cumprirButton/#peticionarButton).
  async function telaProcesso(c) {
    // GUARDA DE PROCESSO CERTO (bug do lote): ao começar um caso NOVO, a tela ainda pode
    // ser a do processo ANTERIOR (após concluir, o Projudi permanece na tela do processo).
    // Se o número ABERTO não for o deste caso, NÃO peticiona aqui — senão junta a peça no
    // PROCESSO ERRADO. Vai buscar o processo certo pelo menu.
    // FAIL-CLOSED (auditoria): o título pode chegar por AJAX depois do load — ESPERA o
    // número aparecer; se não der pra confirmar, PAUSA (antes: seguia em frente e podia
    // peticionar no processo anterior). Anti-loop: no máx. 2 idas à busca por caso.
    const alvo = digitos(c.numero_processo);
    let abertoDig = '';
    await esperar(() => {
      const ident = ((document.getElementById('barraTituloStatusProcessual') || {}).textContent || '') + ' ' + (document.title || '');
      const mCnj = ident.match(RE_CNJ);
      if (mCnj) { abertoDig = digitos(mCnj[0]); return true; }
      return false;
    }, 6000, 400);
    if (alvo.length >= 13) {
      if (!abertoDig) {
        return pausar(c, 'não consegui LER o número do processo desta tela para confirmar que é o <b>' + escHtml(c.numero_processo) + '</b> — confira (abra o processo certo se preciso) e clique Continuar.');
      }
      if (abertoDig !== alvo) {
        c.buscaErrada = (c.buscaErrada || 0) + 1;
        if (c.buscaErrada > 2) {
          return pausar(c, 'fui buscar o processo <b>' + escHtml(c.numero_processo) + '</b> 2× e continuo caindo em OUTRO processo — abra você o processo certo e clique Continuar.');
        }
        await casoSalvar(c);
        progresso(c, 'a tela aberta é de OUTRO processo — indo buscar ' + c.numero_processo + '…');
        return abrirBuscaPeloMenu(c);
      }
      c.buscaErrada = 0; // achou o certo: zera o contador p/ futuras navegações do caso
    }
    // PRIORIDADE: se há intimação não lida (Pendências → "Ver Intimação"), o caminho é
    // CUMPRIR O PRAZO dela — não "Petição Eletrônica" (petição avulsa, sem vínculo).
    const verIntim = document.querySelector('#quadroPendencias a[href*="intimacao.do"]') ||
      Array.from(document.querySelectorAll('#quadroPendencias a, a')).find(a => visivel(a) && /ver\s+intima[cç][aã]o/i.test(a.textContent || ''));
    if (verIntim && visivel(verIntim)) {
      progresso(c, 'intimação pendente → abrindo (Cumprir Prazo)…');
      clicar(verIntim);
      setTimeout(() => runCentral().catch(() => {}), 2500);
      return;
    }
    // M2: os botões podem chegar por AJAX depois do document_idle — espera antes de
    // decidir; se nunca vierem, pausa (NÃO navega embora, senão loop).
    const btn = await esperar(() => {
      const cu = document.getElementById('cumprirButton'), pe = document.getElementById('peticionarButton');
      if (cu && visivel(cu)) return cu;
      if (pe && visivel(pe)) return pe;
      return null;
    }, 8000);
    if (btn) {
      progresso(c, btn.id === 'cumprirButton' ? 'pendência encontrada → Cumprir Prazo' : 'sem pendência aparente → Petição Eletrônica');
      clicar(btn);
      // Rede de segurança: se o clique trocar o conteúdo por AJAX (sem novo load), a
      // auto-retomada (one-shot) não re-dispara — reinvoca runCentral em 2,5s. É
      // idempotente (mutex + despacho por formulário presente na tela).
      setTimeout(() => runCentral().catch(() => {}), 2500);
      return;
    }
    return pausar(c, 'estou no processo mas não achei "Cumprir Prazo" nem "Petição Eletrônica" — clique você no caminho certo (se houver intimação: Ver Intimação → Cumprir Prazo) e depois Continuar');
  }

  // Tela: juntar documento (cumprirIntimacao/juntarDocumento — form juntarDocumentoForm).
  // Tipo via LUPA (#descricaoTipoDocumento → hidden #idTipoDocumento); "Adicionar"
  // abre o diálogo de upload (iframe upload.do — outra instância cuida).
  // B1: conta só linhas que são anexo de verdade (têm ação de remover ou um .pdf),
  // ignora cabeçalho/placeholder "Nenhum registro encontrado".
  function linhasAnexos() {
    // Conta SÓ linhas que representam um ARQUIVO anexado de verdade. Antes bastava
    // ter um checkbox → contava linhas de OUTRAS tabelas do form (intimação, partes,
    // movimento) e a extensão "achava" que já tinha anexo e PULAVA o Adicionar (bug
    // reproduzido no testbed). Agora exige sinal de arquivo: nome com extensão de
    // documento OU (ação de remover/excluir + célula de tamanho Kb/MB).
    // Extensão SEM âncora de fim: no textContent as células vêm coladas — o nome do
    // arquivo gruda na Descrição e no tamanho ("nome.pdfPetição120Kb"), então tanto
    // \b quanto (?![a-z]) falhavam (bugs pegos no testbed). Basta o ponto+extensão.
    const EXT = /\.(pdf|docx?|odt|rtf|txt|jpe?g|png|tiff?|zip|p7s|xml|html?)/i;
    const TAM = /\b\d+([.,]\d+)?\s*(kb|mb|bytes)\b/i;
    const VAZIO = /nenhum\s+(registro|documento|arquivo|anexo|item)|nada\s+encontrado/i;
    // Escopo: prefere a TABELA DE ARQUIVOS (cabeçalho com "Tamanho"/"Nome do arquivo")
    // — só ela conta como anexo; assim linhas de intimação/movimento que citem ".pdf"
    // não geram falso-positivo. Fallback: tabelas de resultado do form de juntada.
    let tabelas = Array.from(document.querySelectorAll('.resultTable, #juntarDocumentoForm table'))
      .filter(t => /tamanho|nome\s+do\s+arquivo/i.test(t.textContent || ''));
    // Fallback (nenhuma tabela com cabeçalho de arquivos): critério ENDURECIDO — exige
    // extensão E tamanho na MESMA linha. Auditoria: só a extensão deixava linha de
    // intimação/movimento que citasse "nome.pdf" contar como anexo → a extensão pulava
    // o upload achando que já tinha anexo (e, no modo auto, concluiria sem arquivo).
    const fallback = !tabelas.length;
    if (fallback) tabelas = Array.from(document.querySelectorAll('.resultTable, #juntarDocumentoForm table'));
    const linhas = new Set();
    tabelas.forEach(t => t.querySelectorAll('tbody tr, tr').forEach(tr => linhas.add(tr)));
    let n = 0;
    linhas.forEach(tr => {
      if (!visivel(tr)) return;
      const txt = tr.textContent || '';
      if (VAZIO.test(txt)) return;
      if (fallback) { if (EXT.test(txt) && TAM.test(txt)) n++; return; }
      if (EXT.test(txt)) { n++; return; }
      const temRemover = tr.querySelector('a[onclick*="remover" i], a[onclick*="excluir" i], a[href*="remover" i], a[href*="excluir" i], img[onclick*="remover" i]');
      if (temRemover && TAM.test(txt)) n++;
    });
    return n;
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
    // Descrição limpa: prefere o rótulo <label for> do rádio; senão o texto da linha
    // sem o valor do rádio (evita "Petição40 120Kb…" com lixo da árvore na tela-mãe).
    const rowSel = alvoRadio.closest('tr,li,label,div');
    const lbl = alvoRadio.id ? document.querySelector('label[for="' + alvoRadio.id + '"]') : null;
    let descricaoRaw = (lbl ? lbl.textContent : (rowSel ? rowSel.textContent : '')) || tipoTxt;
    // Escapa metacaracteres do value (auditoria: um "(" no value estourava SyntaxError
    // engolido e o diálogo ficava mudo até o timeout de 25s).
    const valEsc = String(alvoRadio.value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    descricaoRaw = descricaoRaw.replace(/\s+/g, ' ').trim().replace(new RegExp(valEsc ? '\\b' + valEsc + '\\b' : '(?!)'), '').trim().slice(0, 200);
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
    // GUARDA FAIL-CLOSED (auditoria): uma tela de juntada VELHA (lote anterior
    // cancelado, outro processo) era usada direto — os PDFs do caso novo iam parar no
    // processo errado e o modo auto CONCLUIRIA. Só age se a tela confirmar o número.
    const confJ = confereProcessoNaTela(c);
    if (confJ !== 'ok') {
      return pausar(c, 'não confirmei que esta tela de juntada é do processo <b>' + escHtml(c.numero_processo) + '</b>' +
        (confJ === 'errado' ? ' (a tela mostra OUTRO processo — provável tela antiga)' : ' (número não visível)') +
        ' — feche a tela antiga se houver, abra o processo certo (Ver Intimação → Cumprir Prazo) e clique Continuar.');
    }
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
        const abriu = await esperar(() => document.querySelector('iframe[src*="upload.do"]') || document.getElementById('fileUploadForm') || document.querySelector('input[type="file"]'), 8000);
        if (!abriu) return pausar(c, 'cliquei em "Adicionar" mas o envio de arquivos não abriu — clique você e depois Continuar');
        c.abriuUpload = true; await casoSalvar(c);
      }
      // Se o envio abriu EMBUTIDO nesta mesma tela (não num iframe separado), a
      // instância deste frame precisa conduzir o upload — senão ninguém age e o
      // lote fica preso em "aguardando" (o telaJuntar segura o mutex do frame).
      if (document.getElementById('fileUploadForm') || document.querySelector('input[type="file"]')) {
        await telaUpload(c);
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
    cFinal.fase = 'assinar'; c = cFinal;
    const concluirBtn = acharControle(['concluir movimento', 'concluir']);
    // MODO AUTOMÁTICO: conclui sozinho SÓ quando é seguro — auto ligado, não é o 1º caso
    // (esse você confere), todos os anexos são .p7s (já assinados, sem certificado no
    // meio) e não ficou assinatura pendente. Fora disso, sempre entrega ao humano.
    const todosP7s = (c.docs || []).length > 0 && (c.docs || []).every(d => /\.p7s$/i.test(d.nome || ''));
    const podeAuto = c.autoConcluir && !c.primeiro && todosP7s && !c.assinaturaPendente && concluirBtn;
    if (podeAuto) {
      c.autoConcluindo = true; await casoSalvar(c);
      // Auto-aceita qualquer confirm() do "Concluir Movimento" (você optou pelo modo auto).
      // allFrames: o confirm vive no userMainFrame do frameset.
      await chrome.runtime.sendMessage({ type: 'OVERRIDE_DIALOGS', allFrames: true }).catch(() => {});
      progresso(c, 'modo automático: concluindo o movimento…');
      destacar(concluirBtn, '#1a7f37');
      await new Promise(r => setTimeout(r, 700));
      clicar(concluirBtn);
      // WATCHDOG (auditoria): se o clique não navegar (confirm preso, clique no vazio),
      // nada mais reinvocaria o fluxo — o lote ficaria mudo. Em 6s o dirigir reavalia:
      // form ainda na tela → pausa; navegou → detecção de conclusão normal.
      setTimeout(() => runCentral().catch(() => {}), 6000);
      return; // na próxima carga, o dirigir detecta a conclusão e segue a fila
    }
    await casoSalvar(c);
    if (concluirBtn) destacar(concluirBtn, '#1a7f37');
    return pausar(c, 'PDF(s) anexado(s) ✔ — confira, clique <b>Concluir Movimento</b> e ASSINE com sua senha. Depois do protocolo, clique <b>Continuar</b> na Central que eu dou o caso por concluído e sigo a fila.');
  }

  // Diálogo de upload (upload.do — form fileUploadForm; roda em iframe próprio).
  // O onchange do input de arquivos JÁ envia sozinho (atualiza_arquivos_selecionados→enviar(2)),
  // mas exige codDescricao selecionado ANTES (senão alert).
  async function telaUpload(c) {
    if (c.uploadFeito) return;
    if (!(c.docs || []).length) return; // B6
    // Cada arquivo enviado vira uma LINHA na resultTable com um select name="tipos".
    const linhasUpload = () => Array.from(document.querySelectorAll(
      '#fileUploadForm .resultTable tbody tr, form[name="fileUploadForm"] .resultTable tbody tr'))
      .filter(tr => tr.querySelector('select[name="tipos"], select[id^="tipo"]')).length;

    // GUARDA ANTI-DUPLICATA (bug visto: peça juntada 2×): ao concluir o upload, o Projudi
    // RECARREGA o diálogo (finaliza_upload). O content script morre nesse reload e retoma
    // aqui — se a lista JÁ tem os arquivos, NÃO reenvia; vai direto para a conclusão.
    // PARCIAL (algumas linhas, mas < docs): NÃO reenviar o conjunto todo (o Projudi
    // ANEXA por cima → duplicaria o que já subiu). Entrega ao humano pra ele completar.
    // GUARDA DE DIÁLOGO VELHO (auditoria): um diálogo de upload remanescente de OUTRO
    // caso é "condutor" e agiria com o caso novo. O diálogo em si não mostra o número —
    // confere no frame-PAI (mesma origem): se a tela-mãe mostra outro processo, pausa.
    try {
      if (window.parent && window.parent !== window) {
        const confPai = confereProcessoNaTela(c, window.parent.document);
        if (confPai === 'errado') {
          return pausar(c, 'a janela de envio pertence a OUTRO processo (tela antiga?) — feche-a, abra o processo <b>' + escHtml(c.numero_processo) + '</b> e clique Continuar.');
        }
      }
    } catch (_) { /* frame-pai inacessível: segue (o telaJuntar já foi guardado) */ }
    const jaSubiu = linhasUpload();
    if (jaSubiu > 0 && jaSubiu < c.docs.length) {
      return pausar(c, 'envio parcial: ' + jaSubiu + '/' + c.docs.length + ' PDF(s) já entraram. Para não duplicar, <b>anexe você o(s) que falta(m)</b> no diálogo e clique <b>Continuar</b>.');
    }
    if (jaSubiu >= c.docs.length && !c.uploadFeito) {
      // Lista já "cheia" SEM termos enviado nada nesta passada: confere se são MESMO os
      // nossos arquivos (auditoria: staging abandonado de outra tentativa passava batido
      // e o Confirmar Inclusão validava arquivos alheios). Nome não bate → humano decide.
      //
      // ATENÇÃO: o Projudi RENOMEIA o arquivo ao subir — remove pontuação/underscores e
      // DESEMBRULHA o .p7s (vira .pdf com "Assinado: Sim"). Ex.: enviado
      // "0001044-19.2025.8.16.0079_Manifestacao_v1.pdf.p7s" aparece como
      // "000104419.2025.8.16.0079Manifestacaov1.pdf". Por isso a comparação é por
      // ALFANUMÉRICOS, sem extensão — a comparação textual crua dava falso positivo e
      // TRAVAVA o caminho normal (bug relatado na v0.10.20).
      const alnum = (s) => norm(s).replace(/[^a-z0-9]/g, '');
      const semExt = (s) => String(s || '').replace(/\.(pdf\.p7s|p7s|pdf)$/i, '');
      const txtTabela = alnum(Array.from(document.querySelectorAll(
        '#fileUploadForm .resultTable, form[name="fileUploadForm"] .resultTable')).map(t => t.textContent || '').join(' '));
      const bate = (d) => {
        const k = alnum(semExt(d.nome));
        if (!k) return false;
        if (txtTabela.includes(k)) return true;
        // Projudi pode TRUNCAR nomes longos: aceita casar por um prefixo robusto.
        return k.length > 24 && txtTabela.includes(k.slice(0, 24));
      };
      const nossos = (c.docs || []).filter(bate);
      if (txtTabela && nossos.length < c.docs.length) {
        return pausar(c, 'a lista de envio já tem ' + jaSubiu + ' arquivo(s), mas só reconheci ' + nossos.length + '/' + c.docs.length +
          ' pelo nome — pode haver arquivo de outra tentativa. Confira a lista (remova o que não for deste caso), complete se faltar e clique <b>Continuar</b>.');
      }
    }
    if (jaSubiu < c.docs.length) {
      const inputArq = document.getElementById('conteudo') ||
        document.querySelector('#fileUploadForm input[type="file"], form[name="fileUploadForm"] input[type="file"], input[type="file"]');
      if (!inputArq) {
        return pausar(c, 'a janela de envio abriu, mas não achei o campo de <b>escolher arquivo</b>. Anexe você o PDF e clique Continuar.');
      }
      progresso(c, 'enviando ' + c.docs.length + ' PDF(s)…');
      // #conteudo tem onchange=atualiza_arquivos_selecionados()→enviar(2), que JÁ envia.
      const dt = new DataTransfer();
      for (const d of c.docs) dt.items.add(await pedirDoc(c.id, d.idx));
      inputArq.files = dt.files;
      inputArq.dispatchEvent(new Event('input', { bubbles: true }));
      inputArq.dispatchEvent(new Event('change', { bubbles: true }));
      // O diálogo recarrega ao concluir → este script morre e retoma na guarda acima.
      const subiu = await esperar(() => linhasUpload() >= c.docs.length || !document.getElementById('conteudo'),
        Math.max(90000, c.docs.length * 45000), 700);
      if (!subiu) return pausar(c, 'anexei o(s) PDF(s), mas o envio não concluiu (' + linhasUpload() + '/' + c.docs.length + ') — confira e clique Continuar.');
      if (linhasUpload() < c.docs.length) return; // recarregou: retoma na próxima passada
    }
    // tipo POR ARQUIVO (selects tipoN/name="tipos" da resultTable) — só se veio vazio.
    const alvoTipo = norm(c.tipo_peticao || 'peticao');
    for (const sel of Array.from(document.querySelectorAll(
      '#fileUploadForm .resultTable select[name="tipos"], #fileUploadForm .resultTable select[id^="tipo"]')).filter(visivel)) {
      if (sel.value && sel.value !== '0') continue; // já preenchido pela detecção do nome
      const val = (o) => o.value && o.value !== '0';
      const opt = Array.from(sel.options).find(o => val(o) && norm(o.textContent) === alvoTipo) ||
                  Array.from(sel.options).find(o => val(o) && norm(o.textContent).includes(alvoTipo)) ||
                  Array.from(sel.options).find(o => val(o) && norm(o.textContent) === 'peticao') || // "Petição"
                  Array.from(sel.options).find(o => val(o) && norm(o.textContent).includes('peticao') && !norm(o.textContent).includes('inicial')) ||
                  Array.from(sel.options).find(o => val(o) && norm(o.textContent).includes('outros'));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    c.uploadFeito = true; await casoSalvar(c);
    await new Promise(r => setTimeout(r, 300));
    // CONCLUSÃO. Depois do upload o botão pode ser:
    //  • "Assinar Arquivos" (#assinarButton) → assinatura com CERTIFICADO do usuário
    //    (AssinadorTJPR). A extensão NÃO assina — PAUSA para o humano assinar + concluir.
    //  • "Confirmar Inclusão" (#closeButton) → ex.: arquivo .p7s já assinado; clica e segue.
    const assinar = document.getElementById('assinarButton') ||
      acharControle(['assinar arquivos', 'assinar'], 'input[type=submit],input[type=button],button,a');
    const confirmar = document.getElementById('closeButton') ||
      acharControle(['confirmar inclusao', 'confirmar inclusão'], 'input[type=submit],input[type=button],button,a');
    if (assinar && visivel(assinar)) {
      // Exige CERTIFICADO → o modo automático NUNCA conclui isto (a assinatura é sua).
      c.assinaturaPendente = true; c.fase = 'assinar'; await casoSalvar(c);
      destacar(assinar, '#1a7f37');
      return pausar(c, 'PDF(s) anexado(s) ✔ — clique <b>Assinar Arquivos</b>, assine com seu <b>certificado</b> e depois <b>Concluir Movimento</b>. Terminado o protocolo, clique <b>Continuar</b> na Central que eu sigo a fila.');
    }
    if (confirmar && visivel(confirmar)) {
      // "Confirmar Inclusão" (ex.: .p7s já assinado) → sem certificado pendente; o
      // modo automático pode concluir o movimento depois (na tela de juntada).
      c.assinaturaPendente = false; await casoSalvar(c);
      clicar(confirmar); return;
    }
    return pausar(c, 'anexei o(s) PDF(s) — conclua o envio (Assinar Arquivos / Confirmar Inclusão) e clique Continuar.');
  }

  // Tela pré-login do Projudi (index): cartões "Magistrados…", "Advogados, Partes…",
  // "Certificado Digital". O 1º passo é entrar por "Advogados, Partes" (CPF/senha).
  function acessoAdvogado() {
    const txt = norm(document.body ? document.body.innerText : '');
    // JÁ LOGADO? Usa só sinais EXCLUSIVOS da tela logada ("Atribuição: Advogado…",
    // "Sair") — não palavras de menu (Audiências/Intimações/Estatísticas) que podem
    // existir em menu público de consulta e dariam falso-negativo no pré-login.
    if (/atribuicao|\bsair\b/.test(txt)) return null;
    // Só a tela de acesso de verdade (tem esse cabeçalho e NÃO tem o menu logado).
    const naTela = txt.includes('acesso ao sistema') || txt.includes('cadastro no sistema') || txt.includes('usuarios externos');
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

      // MODO AUTOMÁTICO: já clicamos "Concluir Movimento"; esta é a carga seguinte.
      if (c.autoConcluindo && c.status === 'rodando') {
        // Se ainda há form de juntada/upload na tela, o clique NÃO avançou (ex.: exigiu
        // certificado, validação falhou) → aborta o auto e entrega ao humano (segurança).
        if (document.getElementById('juntarDocumentoForm') || document.getElementById('fileUploadForm')) {
          c.autoConcluindo = false; await casoSalvar(c);
          return pausar(c, 'modo automático: o <b>Concluir Movimento</b> não avançou (pode ter exigido certificado). Conclua você e clique <b>Continuar</b> na Central.');
        }
        // Sucesso do Projudi (confirmado nas capturas): após concluir a juntada ele
        // REDIRECIONA para a TELA DO PROCESSO (processoForm) do MESMO número, com a nova
        // peça no topo das Movimentações — NÃO exibe banner "com sucesso". Então o sinal
        // é: estar em processoForm E o número do processo bater (guarda contra tela de
        // erro/outro processo). Uma mensagem explícita de sucesso também vale. O form de
        // juntada/upload já foi descartado acima. Na dúvida, PAUSA (protocolo é irreversível).
        const soDig = (s) => String(s || '').replace(/\D/g, '');
        const numAlvo = soDig(c.numero_processo);
        const confirmou = () => {
          const corpo = document.body ? document.body.innerText : '';
          const naTelaProcesso = !!document.getElementById('processoForm') && !!numAlvo && soDig(corpo).indexOf(numAlvo) >= 0;
          const txtOk = /movimento (concluido|registrado|realizado|inserido)|juntada realizada|operacao realizada|realizad[oa] com sucesso|conclu[ií]d[oa] com sucesso|protocolad[oa] com sucesso/
            .test(norm(corpo));
          return naTelaProcesso || txtOk;
        };
        if (!confirmou()) {
          // Ainda carregando/transição? Dá mais uma passada curta antes de decidir.
          await new Promise(r => setTimeout(r, 1500));
          if (!confirmou()) {
            c.autoConcluindo = false; await casoSalvar(c);
            return pausar(c, 'modo automático: <b>não confirmei</b> a conclusão pela tela. Verifique se protocolou — se sim, clique <b>Continuar</b> na Central; se não, conclua e depois Continuar.');
          }
        }
        await casoLimpar();
        reportar('CENTRAL_CASO_OK', { casoId: c.id, numero: c.numero_processo });
        setBody(msg('✅ Caso concluído automaticamente — próximo da fila.', '#d3f9d8'));
        return;
      }

      // FASE FINAL: o advogado assinou/protocolou e clicou Continuar.
      if (c.fase === 'assinar' && c.status === 'rodando' && c.retomadoPeloUsuario) {
        const m = (document.body.innerText || '').match(/protocolo[^\d]{0,20}(\d[\d./-]{5,})/i);
        await casoLimpar();
        reportar('CENTRAL_CASO_OK', { casoId: c.id, numero: (m && m[1]) || c.numero_processo });
        setBody(msg('✅ Caso concluído — próximo da fila.', '#d3f9d8'));
        return;
      }

      // Despacho por formulário presente na tela (IDs reais dos saves):
      // Só trata como diálogo de upload se o campo de arquivo estiver VISÍVEL —
      // senão, num upload EMBUTIDO (form escondido no mesmo doc da juntada), o
      // roteador chamaria telaUpload antes da telaJuntar e o lote travava.
      const upForm = document.getElementById('fileUploadForm');
      const upFile = upForm && upForm.querySelector('input[type="file"]');
      // Só trata como diálogo de upload EMBUTIDO se o campo de arquivo existir E estiver
      // visível — senão a juntada (com um fileUploadForm oculto/sem input) seria
      // sequestrada. O upload em iframe próprio é pego pelo ramo final.
      if (upForm && upFile && visivel(upFile)) return await telaUpload(c);
      if (document.getElementById('juntarDocumentoForm')) return await telaJuntar(c);
      if (upForm && upFile) return await telaUpload(c); // upload em iframe próprio sem juntada na tela
      if (ehTelaIntimacao()) return await telaIntimacao(c); // aviso/"Cumprir Prazo"
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
        const gravar = () => casoSalvar({ ...m.caso, status: 'rodando', motivo: null, fase: null, abriuLupa: false, abriuUpload: false, uploadFeito: false, retomadoPeloUsuario: false, assinaturaPendente: false, autoConcluindo: false });
        if (ehCondutor()) {
          await gravar();
          sendResponse({ ok: true });
          runCentral().catch(() => {});
        } else {
          // TOPO = fallback (auditoria M4): grava com ATRASO e só se o condutor não
          // gravou antes — um save tardio do topo regravava "rodando" por cima de uma
          // pausa recém-salva pelo condutor (a pausa "sumia" e nada dirigia).
          sendResponse({ ok: true });
          setTimeout(async () => {
            const cur = await casoLer();
            if (!cur || cur.id !== m.caso.id) { await gravar(); runCentral().catch(() => {}); }
          }, 900);
        }
      })();
      return true;
    }
    if (m.type === 'CONTINUAR_CENTRAL') {
      if (!respondo) return false;
      (async () => {
        const retomar = async () => {
          const c = await casoLer();
          if (c && c.sistema === 'projudi' && c.status !== 'rodando') {
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
        };
        if (ehCondutor()) { await retomar(); sendResponse({ ok: true }); }
        else { sendResponse({ ok: true }); setTimeout(() => { retomar().catch(() => {}); }, 900); } // topo: fallback com atraso (M4)
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
