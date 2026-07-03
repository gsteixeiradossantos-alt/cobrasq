// extension/content-eproc.js — roda na página do eproc TJPR (usuário já logado).
//
// Dois modos:
//  • INTERCORRENTE (tela única): seleciona Tipo de Documento, anexa o PDF e PARA no
//    botão final (Peticionar/Confirmar) para revisão humana.
//  • INICIAL / DISTRIBUIÇÃO (assistente de 5 etapas): MOTOR MULTI-ETAPAS. A cada
//    página da distribuição, detecta a etapa visível e preenche os campos a partir
//    do snapshot job.dados_distribuicao; destaca "Próxima" (ou "Finalizar" na etapa 5).
//    NUNCA clica em Próxima/Finalizar — o humano revisa e avança; a extensão então
//    preenche a próxima etapa sozinha (job ativo guardado em chrome.storage.local).
//
// ⚠️ Seletores/rótulos em selectors.js (EPROC_SEL / EPROC_TXT / EPROC_DIST) — calibrar
//    contra o eproc real. Autocompletes (Comarca/Classe/Assunto) e o ciclo de Partes
//    (Consultar→Salvar→Incluir) são os pontos que mais precisam de ajuste fino.

(function () {
  const SEL = window.EPROC_SEL || {};
  const TXT = window.EPROC_TXT || {};
  const DIST = window.EPROC_DIST || {};
  const IDS = window.EPROC_IDS || {};
  const JOB_KEY = 'cobrasq_job_ativo';
  let jobAtual = null;

  // ── helpers de DOM ─────────────────────────────────────────────────────────
  function qFirst(cands) {
    for (const sel of (cands || [])) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (_) {}
    }
    return null;
  }
  // Normaliza p/ comparação: minúsculas e sem acentos ("Cível" ≈ "CIVEL").
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function visivel(el) { return !!(el && el.offsetParent !== null); }
  // Dado um rótulo, acha o campo correspondente: atributo for=, senão o primeiro
  // input/select VISÍVEL que vem DEPOIS do rótulo (subindo até 3 níveis de container).
  function campoDoLabel(l) {
    const forId = l.getAttribute && l.getAttribute('for');
    if (forId) { const el = document.getElementById(forId); if (visivel(el)) return el; }
    let scope = l.parentElement;
    for (let depth = 0; scope && depth < 3; depth++) {
      const cands = Array.from(scope.querySelectorAll('input:not([type="hidden"]),select,textarea')).filter(visivel);
      for (const c of cands) {
        if (l.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) return c;
      }
      if (cands.length) return cands[0];
      scope = scope.parentElement;
    }
    return null;
  }
  // Fallback: acha <input>/<select> cujo rótulo VISÍVEL contém `texto`.
  // Prioriza <label> reais; ignora containers gigantes (texto > 120 chars) para não
  // casar com divs de layout que contêm a página inteira.
  function byLabel(texto) {
    const t = norm(texto);
    const grupos = ['label', 'th, td, b, strong, span, div'];
    for (const selGrupo of grupos) {
      for (const l of Array.from(document.querySelectorAll(selGrupo))) {
        const full = (l.textContent || '').trim();
        if (!full || full.length > 120) continue;
        if (!norm(full).includes(t)) continue;
        if (!visivel(l)) continue;
        const el = campoDoLabel(l);
        if (el) return el;
      }
    }
    return null;
  }
  function byAnyLabel(termos) {
    for (const t of (termos || [])) { const el = byLabel(t); if (el) return el; }
    return null;
  }
  function acharBotao(termos) {
    const cands = Array.from(document.querySelectorAll('input[type="submit"],input[type="button"],button,a[href]'));
    for (const termo of (termos || [])) {
      const t = String(termo).toLowerCase();
      for (const el of cands) {
        const txt = ((el.value || '') + ' ' + (el.textContent || '') + ' ' + (el.title || '')).toLowerCase();
        if (txt.includes(t)) return el;
      }
    }
    return null;
  }
  function setInput(el, val) {
    if (!el || val == null || val === '') return false;
    try { el.focus(); } catch (_) {}
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  // Seleciona a opção com melhor casamento (sem acentos; aceita casamento parcial
  // por palavras: "Cível" acha "CÍVEL", "Juizado Especial Cível" acha
  // "RITO SUMARÍSSIMO (JUIZADO ESPECIAL)" só se a maioria das palavras bater).
  function setSelectByText(sel, texto) {
    if (!sel || !texto) return false;
    const alvo = norm(texto);
    let best = null, bestScore = 0;
    for (const opt of Array.from(sel.options || [])) {
      const o = norm(opt.textContent);
      if (!o.trim()) continue;
      let score = 0;
      if (o.includes(alvo) || alvo.includes(o)) score = 100;
      else {
        const palavras = alvo.split(/\W+/).filter(w => w.length >= 4);
        const hits = palavras.filter(w => o.includes(w)).length;
        if (palavras.length && hits) score = Math.round((100 * hits) / palavras.length);
      }
      if (score > bestScore) { best = opt; bestScore = score; }
    }
    if (best && bestScore >= 60) {
      if (sel.value === best.value) return true; // já selecionada: não re-dispara a cascata
      sel.value = best.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true;
    }
    return false;
  }
  // Os selects da Etapa 1 do eproc carregam em CASCATA via AJAX (Comarca → Rito →
  // Área → Classe). Espera o select existir com opções e tenta casar o valor,
  // re-tentando enquanto as opções chegam.
  async function selecionarComEspera(ids, termos, valor, rotulo, erros, timeoutMs) {
    if (valor == null || valor === '') return true;
    const fim = Date.now() + (timeoutMs || 8000);
    let el = null;
    while (Date.now() < fim) {
      el = (ids && qFirst(ids)) || byAnyLabel(termos);
      if (el && el.tagName === 'SELECT' && el.options && el.options.length >= 2 && setSelectByText(el, valor)) return true;
      if (el && el.tagName !== 'SELECT') { setInput(el, valor); return true; }
      await new Promise(r => setTimeout(r, 300));
    }
    if (!el) erros.push(rotulo + ' (campo não localizado)');
    else { erros.push(rotulo + ' (opção "' + valor + '" não apareceu na lista — confira)'); destacar(el, '#fab005'); }
    return false;
  }
  function fmtNum(n) {
    const v = Number(n);
    if (!isFinite(v)) return '';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function destacar(el, cor) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline = '3px solid ' + (cor || '#C9A961');
    el.style.boxShadow = '0 0 0 4px rgba(201,169,97,.35)';
  }

  // ── painel flutuante ────────────────────────────────────────────────────────
  function painel() {
    let p = document.getElementById('cobrasq-eproc-panel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'cobrasq-eproc-panel';
    p.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;width:340px;max-height:80vh;overflow:auto;' +
      'background:#fff;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);' +
      'font:13px/1.45 system-ui,Arial,sans-serif;color:#1a1a1a;';
    p.innerHTML =
      '<div style="background:#0c2340;color:#fff;padding:10px 12px;font-weight:600;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;">' +
      '<span>Cobrasq · Peticionador eproc</span>' +
      '<span id="cb-close" style="cursor:pointer;opacity:.8;">✕</span></div>' +
      '<div id="cb-body" style="padding:12px;"></div>';
    document.body.appendChild(p);
    p.querySelector('#cb-close').onclick = () => p.remove();
    return p;
  }
  function setBody(html) { painel().querySelector('#cb-body').innerHTML = html; }
  function msg(t, cor) { return '<div style="padding:6px 8px;border-radius:6px;background:' + (cor || '#f1f3f5') + ';margin-bottom:8px;">' + t + '</div>'; }
  function listaErros(erros) {
    return erros.length
      ? msg('⚠️ Revise/complete à mão:<br>• ' + erros.join('<br>• '), '#fff3bf')
      : msg('✓ Tudo preenchido nesta etapa.', '#d3f9d8');
  }

  // ── job ativo (persistência entre as etapas/recarregamentos) ────────────────
  async function salvarJobAtivo(job) { try { await chrome.storage.local.set({ [JOB_KEY]: job }); } catch (_) {} }
  async function lerJobAtivo() { try { const o = await chrome.storage.local.get([JOB_KEY]); return o && o[JOB_KEY]; } catch (_) { return null; } }
  async function limparJobAtivo() { try { await chrome.storage.local.remove(JOB_KEY); } catch (_) {} }

  // ── PDF ─────────────────────────────────────────────────────────────────────
  async function baixarPdfComoFile(url, nome) {
    const resp = await chrome.runtime.sendMessage({ type: 'FETCH_PDF', url });
    if (!resp || !resp.ok) throw new Error('Falha ao baixar o PDF: ' + (resp && resp.error || '?'));
    const bin = atob(resp.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], nome || 'peticao.pdf', { type: 'application/pdf' });
  }
  function anexarArquivo(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── preenchimento de UM campo simples (id real → fallback por rótulo) ───────
  function preencherCampo(termos, valor, rotulo, erros, autocomplete, ids) {
    if (valor == null || valor === '') return;
    const el = (ids && qFirst(ids)) || byAnyLabel(termos);
    if (!el) { erros.push(rotulo + ' (campo não localizado)'); return; }
    if (ids && qFirst(ids)) autocomplete = false; // id exato: selects nativos, sem confirmação
    if (el.tagName === 'SELECT') {
      if (!setSelectByText(el, valor)) { erros.push(rotulo + ' (opção "' + valor + '" não está na lista — confira)'); destacar(el, '#fab005'); }
    } else {
      setInput(el, valor);
      if (autocomplete) { erros.push(rotulo + ' (autocomplete: confirme a opção que abriu)'); destacar(el, '#fab005'); }
    }
  }

  // ── DISTRIBUIÇÃO (inicial) — motor multi-etapas ─────────────────────────────
  function detectarEtapa() {
    // Título real do eproc TJPR: "Peticionamento Eletrônico (1 de 5) - Informações do processo"
    const h = Array.from(document.querySelectorAll('h1,h2,h3,.infraCaption'))
      .map(e => e.textContent || '').join(' ');
    const t = h + ' ' + (document.body ? (document.body.innerText || '').slice(0, 4000) : '');
    if (/Processo distribu[íi]do/i.test(t)) return 6; // tela de sucesso
    let m = t.match(/\(\s*([1-5])\s*de\s*5\s*\)/i) || t.match(/Etapa\s*([1-5])\s*de\s*5/i);
    if (m) return +m[1];
    if (/Informa[çc][õo]es do processo/i.test(t)) return 1;
    if (/Assuntos/i.test(t)) return 2;
    if (/Partes\s*(Autoras|Requerentes)/i.test(t)) return 3;
    if (/Partes\s*(R[ée]s|Requerid|Executad)/i.test(t)) return 4;
    if (/Documentos/i.test(t) || /Anexar Documento/i.test(t)) return 5;
    return 0;
  }

  async function etapa1(d, erros) {
    // Ordem importa: Comarca dispara a cascata; Valor e Sigilo são imediatos;
    // Rito/Área esperam as opções do AJAX; Classe por ÚLTIMO (o onchange dela
    // recarrega a página no eproc — e aí o assistente auto-retoma na volta).
    preencherCampo(DIST.comarca, d.comarca, 'Comarca', erros, true, IDS.comarca);
    // Campo real: "Valor da Causa: (R$) (Somente números)" → sem separador de milhar.
    preencherCampo(DIST.valorCausa, d.valor_causa != null ? fmtNum(d.valor_causa).replace(/\./g, '') : null, 'Valor da causa', erros, false, IDS.valorCausa);
    if (d.nivel_sigilo != null) preencherCampo(DIST.sigilo, 'Nível ' + d.nivel_sigilo, 'Nível de sigilo', erros, false, IDS.sigilo);
    await selecionarComEspera(IDS.rito, DIST.rito, d.rito, 'Rito', erros);
    await selecionarComEspera(IDS.area, DIST.area, d.area, 'Área', erros);
    await selecionarComEspera(IDS.classe, DIST.classe, d.classe, 'Classe processual', erros);
  }
  function etapa2(d, erros) {
    // Árvore de assuntos (jstree): a extensão pré-preenche a busca; a seleção na
    // árvore e o "Incluir" são cliques do humano. Competência é select ao lado.
    const assuntos = d.assuntos || [];
    const busca = qFirst(IDS.assuntoBusca) || byAnyLabel(DIST.assuntoBusca);
    if (assuntos.length && busca) {
      setInput(busca, assuntos[0]);
      destacar(qFirst(IDS.filtrar) || byAnyLabel(DIST.filtrar) || busca, '#fab005');
      erros.push('Assuntos: ' + assuntos.join(', ') + ' — clique <b>Filtrar</b>, selecione na árvore e <b>Incluir</b>');
    } else if (!assuntos.length) {
      erros.push('Sem assuntos no snapshot — selecione na árvore e clique Incluir');
    }
    const comp = qFirst(IDS.competencia);
    if (comp) {
      // Ex.: "Matéria Residual" casa com "Juizado Especial Cível - Matéria Residual".
      if (d.competencia && setSelectByText(comp, d.competencia)) { /* selecionada */ }
      else if (comp.value === '-1') { destacar(comp, '#fab005'); erros.push('Selecione a <b>Competência</b> (ex.: Matéria Residual)'); }
    }
  }
  function etapaPartes(lista, rotulo, erros) {
    const partes = lista || [];
    if (!partes.length) { erros.push('Sem ' + rotulo + ' no snapshot'); return; }
    // Pré-preenche o CPF/CNPJ da 1ª parte; Consultar→(Receita)→Incluir é do humano.
    const docEl = qFirst(IDS.docParte) || byAnyLabel(DIST.docParte);
    if (docEl && partes[0].doc) { setInput(docEl, partes[0].doc.replace(/[^\d./-]/g, '')); }
    const consultar = qFirst(IDS.consultar) || acharBotao(DIST.consultar);
    if (consultar) destacar(consultar, '#fab005');
    const linhas = partes.map(p => '— ' + (p.nome || '?') + (p.doc ? ' (' + p.doc + ')' : '')).join('<br>');
    erros.push(rotulo + ' a incluir (Consultar → conferir → Incluir, um a um):<br>' + linhas);
  }
  function etapa3(d, erros) { etapaPartes(d.requerentes, 'Requerente(s)', erros); }
  function etapa4(d, erros) { etapaPartes(d.requeridos, 'Requerido(s)', erros); }
  async function etapa5(d, job, erros) {
    // Anexo do PDF no uploader (qq/plupload) + tipo do documento (autocomplete).
    try {
      const inputFile = qFirst(IDS.anexo) || qFirst(SEL.anexoPdf) || byAnyLabel(TXT.anexo);
      if (!inputFile) erros.push('Campo de anexo não localizado');
      else if (job.pdf_url) {
        anexarArquivo(inputFile, await baixarPdfComoFile(job.pdf_url, 'peticao.pdf'));
        erros.push('PDF anexado — informe o <b>Tipo</b> (ex.: PETIÇÃO INICIAL) e clique <b>Confirmar seleção de documentos</b>');
        const tipoTxt = qFirst(IDS.tipoDoc);
        if (tipoTxt) { setInput(tipoTxt, job.evento_eproc || 'PETIÇÃO INICIAL'); destacar(tipoTxt, '#fab005'); }
        const conf = qFirst(IDS.confirmarDocs);
        if (conf) destacar(conf, '#fab005');
      } else erros.push('Job sem PDF');
    } catch (e) { erros.push(String(e.message || e)); }
  }

  // Tela final "Processo distribuído.": captura o nº e reporta ao app sozinho.
  async function telaSucesso(job) {
    const el = qFirst(IDS.numeroSucesso) || qFirst(SEL.resultadoProtocolo);
    const num = el ? (el.textContent || '').trim() : '';
    await chrome.runtime.sendMessage({ type: 'CLAIM', id: job.id }).catch(() => {});
    const r = await chrome.runtime.sendMessage({ type: 'DONE', id: job.id, protocolo_num: num });
    await limparJobAtivo();
    setBody(
      msg('🎉 <b>Processo distribuído!</b>' + (num ? '<br>Nº ' + num : ''), '#d3f9d8') +
      (r && r.ok ? msg('✓ Registrado no app automaticamente.', '#d3f9d8')
                 : msg('Não consegui registrar no app (' + ((r && r.error) || '?') + ') — anote o número.', '#fff3bf')));
  }

  async function preencherDistribuicao(job) {
    jobAtual = job;
    const d = job.dados_distribuicao || {};
    const etapa = detectarEtapa();
    if (!etapa) {
      setBody(
        msg('Distribuição ativa para <b>' + ((d.requerentes && d.requerentes[0] && d.requerentes[0].nome) || job.numero_processo || 'caso') + '</b>.') +
        msg('Não reconheci a etapa atual. Abra o assistente de <b>Distribuição</b> (Petição inicial) e navegue até a Etapa 1.', '#fff3bf') +
        botaoParar());
      ligarBotaoParar();
      return;
    }
    if (etapa === 6) { await telaSucesso(job); return; }
    const nomes = { 1: 'Informações do processo', 2: 'Assuntos', 3: 'Partes Autoras', 4: 'Partes Rés', 5: 'Documentos' };
    setBody(msg('<b>Etapa ' + etapa + '/5:</b> preenchendo… (aguardo as listas do eproc carregarem)'));
    const erros = [];
    if (etapa === 1) await etapa1(d, erros);
    else if (etapa === 2) etapa2(d, erros);
    else if (etapa === 3) etapa3(d, erros);
    else if (etapa === 4) etapa4(d, erros);
    else if (etapa === 5) await etapa5(d, job, erros);

    const ultima = etapa === 5;
    const btn = ultima ? (qFirst(IDS.finalizar) || qFirst(SEL.botaoFinal) || acharBotao(TXT.final))
                       : (qFirst(IDS.avancar) || qFirst(SEL.botaoAvancar) || acharBotao(TXT.avancar));
    destacar(btn);
    const rotuloBtn = ultima ? 'Finalizar' : 'Próxima';

    setBody(
      msg('<b>Distribuição — Etapa ' + etapa + '/5:</b> ' + nomes[etapa]) +
      listaErros(erros) +
      msg('Revise e clique <b>' + rotuloBtn + '</b> no eproc.' + (ultima ? '' : ' Eu preencho a próxima etapa sozinho.'), '#e7f5ff') +
      (ultima ? blocoProtocolo() : '') +
      botaoParar());
    if (ultima) ligarBotaoProtocolo(job);
    ligarBotaoParar();
  }

  function botaoParar() {
    return '<button id="cb-parar" style="width:100%;margin-top:6px;padding:8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;">Parar assistente</button>';
  }
  function ligarBotaoParar() {
    const b = painel().querySelector('#cb-parar');
    if (b) b.onclick = async () => { await limparJobAtivo(); setBody(msg('Assistente parado. Nada mais será preenchido.', '#f1f3f5')); };
  }
  function blocoProtocolo() {
    return '<div style="margin-top:6px;">Depois de <b>Finalizar</b>, cole o <b>nº do processo/protocolo</b>:</div>' +
      '<input id="cb-protocolo" placeholder="nº gerado" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;margin:6px 0;">' +
      '<div style="display:flex;gap:6px;"><button id="cb-done" style="flex:1;padding:8px;border:0;border-radius:6px;background:#0c2340;color:#fff;cursor:pointer;">Confirmar protocolo</button>' +
      '<button id="cb-err" style="padding:8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;">Erro</button></div>';
  }
  function ligarBotaoProtocolo(job) {
    const body = painel().querySelector('#cb-body');
    const done = body.querySelector('#cb-done'); const err = body.querySelector('#cb-err');
    if (done) done.onclick = async () => {
      const num = (body.querySelector('#cb-protocolo').value || '').trim();
      const r = await chrome.runtime.sendMessage({ type: 'DONE', id: job.id, protocolo_num: num });
      await limparJobAtivo();
      setBody(r && r.ok ? msg('✓ Registrado no app. Protocolo: ' + (num || '(sem nº)'), '#d3f9d8') : msg('Falha ao registrar: ' + (r && r.error), '#ffe3e3'));
    };
    if (err) err.onclick = async () => {
      await chrome.runtime.sendMessage({ type: 'REPORT_ERROR', id: job.id, erro: 'erro manual na distribuição' });
      await limparJobAtivo();
      setBody(msg('Marcado como erro no app.', '#fff3bf'));
    };
  }

  // ── INTERCORRENTE (tela única) ──────────────────────────────────────────────
  async function preencherIntercorrente(job) {
    jobAtual = job;
    setBody(msg('Preenchendo o processo <b>' + (job.numero_processo || '') + '</b>…'));
    const claim = await chrome.runtime.sendMessage({ type: 'CLAIM', id: job.id });
    if (claim && claim.error) { setBody(msg('Não foi possível reservar este job: ' + claim.error, '#ffe3e3')); return; }

    const erros = [];
    const selTipo = qFirst(SEL.tipoDocumento) || byAnyLabel(TXT.tipoDocumento);
    if (selTipo && job.evento_eproc) { if (!setSelectByText(selTipo, job.evento_eproc)) erros.push('tipo de documento "' + job.evento_eproc + '" não encontrado na lista'); }
    else if (!selTipo) erros.push('campo "Tipo de Documento" não localizado nesta etapa');

    try {
      const inputFile = qFirst(SEL.anexoPdf) || byAnyLabel(TXT.anexo);
      if (!inputFile) erros.push('campo de anexo (input file) não localizado');
      else if (job.pdf_url) anexarArquivo(inputFile, await baixarPdfComoFile(job.pdf_url, 'peticao_' + (job.numero_processo || '') + '.pdf'));
      else erros.push('job sem PDF');
    } catch (e) { erros.push(String(e.message || e)); }

    const btnFinal = qFirst(SEL.botaoFinal) || acharBotao(TXT.final);
    const btnAvancar = qFirst(SEL.botaoAvancar) || acharBotao(TXT.avancar);
    destacar(btnFinal || btnAvancar);
    if (!btnFinal && btnAvancar) erros.push('etapa intermediária do assistente — avance até a etapa final para protocolar');
    else if (!btnFinal && !btnAvancar) erros.push('botão de protocolo/avanço não localizado');

    const labelBotao = btnFinal ? ((btnFinal.value || btnFinal.textContent || 'Peticionar').trim()) : 'Próxima';
    setBody(listaErros(erros) + blocoProtocoloIntercorrente(labelBotao));
    ligarBotaoProtocolo(job);
  }
  function blocoProtocoloIntercorrente(labelBotao) {
    return msg('Revise e clique <b>' + labelBotao + '</b> no eproc.', '#e7f5ff') +
      '<div style="margin-top:2px;">Depois, cole o <b>nº do protocolo</b>:</div>' +
      '<input id="cb-protocolo" placeholder="nº do protocolo" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;margin:6px 0;">' +
      '<div style="display:flex;gap:6px;"><button id="cb-done" style="flex:1;padding:8px;border:0;border-radius:6px;background:#0c2340;color:#fff;cursor:pointer;">Confirmar protocolo</button>' +
      '<button id="cb-err" style="padding:8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;">Erro</button></div>';
  }

  // ── dispatch ────────────────────────────────────────────────────────────────
  async function iniciar(job) {
    if (job && job.tipo === 'inicial' && job.dados_distribuicao) {
      // Reserva o job (preparado→enviando) p/ o "Confirmar protocolo" funcionar no
      // fim. Best-effort: se já estava 'enviando' (re-clique), seguimos mesmo assim.
      await chrome.runtime.sendMessage({ type: 'CLAIM', id: job.id }).catch(() => {});
      await salvarJobAtivo(job);          // persiste p/ reabrir a cada etapa
      await preencherDistribuicao(job);
    } else {
      await preencherIntercorrente(job);
    }
  }

  // Anexa um PDF vindo da PASTA LOCAL/OneDrive do usuário (via popup, sem job do app).
  async function anexarPdfLocal(nome, base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], nome || 'documento.pdf', { type: 'application/pdf' });
    const input = qFirst(IDS.anexo) || qFirst(SEL.anexoPdf) || byAnyLabel(TXT.anexo);
    if (!input) { setBody(msg('Não achei o campo de anexo nesta tela — abra a etapa de Documentos.', '#ffe3e3')); return; }
    anexarArquivo(input, file);
    const tipoTxt = qFirst(IDS.tipoDoc); if (tipoTxt) destacar(tipoTxt, '#fab005');
    const conf = qFirst(IDS.confirmarDocs); if (conf) destacar(conf, '#fab005');
    setBody(msg('📎 <b>' + nome + '</b> anexado da sua pasta.', '#d3f9d8') +
      msg('Informe o <b>Tipo</b> do documento e clique <b>Confirmar seleção de documentos</b>.', '#e7f5ff'));
  }

  // ═══════════════════ CENTRAL DE PETICIONAMENTO — modo AUTO ═══════════════════
  // O caso ativo fica em chrome.storage.local (sobrevive às recargas do wizard).
  // A cada página, runCentral() detecta onde está e executa a etapa. Qualquer
  // anomalia → pausar() (circuit breaker): avisa a Central e espera Continuar.
  const CASO_KEY = 'cobrasq_central_caso';
  async function casoLer() { const o = await chrome.storage.local.get(CASO_KEY); return o[CASO_KEY] || null; }
  async function casoSalvar(c) { await chrome.storage.local.set({ [CASO_KEY]: c }); }
  async function casoLimpar() { await chrome.storage.local.remove(CASO_KEY); }
  function reportar(tipo, extra) { try { chrome.runtime.sendMessage({ type: tipo, ...(extra || {}) }); } catch (_) {} }
  function progresso(c, texto) { setBody(msg('<b>Central:</b> ' + texto)); reportar('CENTRAL_PROGRESS', { casoId: c.id, texto }); }
  async function pausar(c, motivo, el) {
    c.status = 'pausado'; c.motivo = motivo; await casoSalvar(c);
    if (el) destacar(el, '#fa5252');
    setBody(msg('⏸ <b>Pausado:</b> ' + motivo, '#fff3bf') + msg('Ajuste aqui se preciso e use os botões na aba da <b>Central</b>.', '#e7f5ff'));
    reportar('CENTRAL_PAUSA', { casoId: c.id, motivo });
  }
  async function esperar(cond, timeoutMs, passoMs) {
    const fim = Date.now() + (timeoutMs || 15000);
    while (Date.now() < fim) { const v = cond(); if (v) return v; await new Promise(r => setTimeout(r, passoMs || 300)); }
    return null;
  }
  function temLogin() { const p = document.querySelector('input[type="password"]'); return !!(p && visivel(p)); }
  function clicar(el) { try { el.scrollIntoView({ block: 'center' }); } catch (_) {} el.click(); }

  async function runCentral() {
    const c = await casoLer();
    if (!c) return;
    const etapa = detectarEtapa();
    try {
      if (etapa === 6) { // sucesso — processa mesmo se estava pausado (1º caso validado à mão)
        const elNum = qFirst(IDS.numeroSucesso) || qFirst(SEL.resultadoProtocolo);
        const numero = elNum ? (elNum.textContent || '').trim() : '';
        await casoLimpar();
        reportar('CENTRAL_CASO_OK', { casoId: c.id, numero });
        setBody(msg('🎉 <b>Distribuído!</b> Nº ' + numero, '#d3f9d8'));
        const nova = document.querySelector('#btnNovaPeticao');
        if (nova) clicar(nova); // deixa a tela pronta pro próximo caso da fila
        return;
      }
      if (c.status === 'pausado') {
        if (c.motivo === 'login' && !temLogin()) { c.status = 'rodando'; c.motivo = null; await casoSalvar(c); }
        else { setBody(msg('⏸ <b>Pausado:</b> ' + (c.motivo || ''), '#fff3bf') + msg('Use os botões na aba da Central.', '#e7f5ff')); return; }
      }
      if (temLogin()) { await pausar(c, 'login'); setBody(msg('Faça o <b>login no eproc</b> — a fila continua sozinha depois.', '#fff3bf')); return; }
      if (etapa === 1) return await autoE1(c);
      if (etapa === 2) return await autoE2(c);
      if (etapa === 3) return await autoPartes(c, 'requerentes', 'Etapa 3/5 — autores');
      if (etapa === 4) return await autoPartes(c, 'requeridos', 'Etapa 4/5 — réus');
      if (etapa === 5) return await autoE5(c);
      // Fora do assistente com uma parte pendente = provável tela de cadastro novo
      // (após "Novo"). NÃO navegar embora — pausamos com a ficha pra preencher.
      if (c.parte) {
        const p = [...(c.dados.requerentes || []), ...(c.dados.requeridos || [])]
          .find(x => x && x.doc && String(x.doc).replace(/\D/g, '') === c.parte.doc);
        return pausar(c, 'parece a tela de CADASTRO da parte — preencha (endereço e contato são obrigatórios), salve, inclua a parte no processo e clique Continuar.' + fichaParte(p || { doc: c.parte.doc }));
      }
      // Fora do assistente: navega pelo menu "Petição Inicial" (evita URLs com hash).
      progresso(c, 'abrindo a Petição Inicial…');
      const link = await esperar(() => document.querySelector('a[href*="acao=processo_cadastrar&"]'), 10000);
      if (!link) return pausar(c, 'não achei o menu "Petição Inicial" — navegue até a Etapa 1 e clique Continuar');
      clicar(link);
    } catch (e) { await pausar(c, 'erro inesperado: ' + String((e && e.message) || e)); }
  }

  async function autoE1(c) {
    progresso(c, 'Etapa 1/5 — informações do processo…');
    const erros = [];
    await etapa1(c.dados, erros);
    if (erros.length) return pausar(c, 'Etapa 1: ' + erros.join(' · '));
    const btn = qFirst(IDS.avancar);
    if (!btn) return pausar(c, 'Etapa 1: botão Próxima não encontrado');
    progresso(c, 'Etapa 1 ok → Próxima');
    clicar(btn);
  }

  function linhaAssuntoOk() { return !!document.querySelector('#tblAssuntoPrincipal tbody tr'); }
  async function autoE2(c) {
    progresso(c, 'Etapa 2/5 — assuntos…');
    const d = c.dados;
    if (!linhaAssuntoOk()) {
      const assunto = (d.assuntos || [])[0];
      if (!assunto) return pausar(c, 'Etapa 2: nenhum assunto informado');
      const busca = qFirst(IDS.assuntoBusca), filtrar = qFirst(IDS.filtrar);
      if (!busca || !filtrar) return pausar(c, 'Etapa 2: busca de assunto não encontrada');
      // Nó da árvore: a busca do jstree MARCA os achados com .jstree-search (visto no
      // teste real: <span class="jstree-search">Perdas e danos (02190505)</span>) —
      // esse é o alvo prioritário; fallback: casar palavras no texto dos anchors.
      const palavras = norm(assunto).split(/\W+/).filter(w => w.length >= 4);
      const casa = (el) => {
        const t = norm(el.textContent);
        return t.includes(norm(assunto)) || (palavras.length && palavras.every(w => t.includes(w)));
      };
      const achaNo = () => {
        const marcados = Array.from(document.querySelectorAll('#divArvore .jstree-search')).filter(visivel);
        const alvo = marcados.length === 1 ? marcados[0] : marcados.find(casa);
        if (alvo) return alvo.closest('.jstree-anchor') || alvo;
        return Array.from(document.querySelectorAll('#divArvore .jstree-anchor')).find(a => visivel(a) && casa(a));
      };
      // O onclick do Filtrar depende dos scripts da página, que carregam DEPOIS do
      // content script — então digita, espera a página assentar e RE-CLICA até a
      // árvore responder (o teste real mostrou o 1º clique caindo no vazio).
      await new Promise(r => setTimeout(r, 1500));
      setInput(busca, assunto);
      let anchor = null;
      for (let tent = 0; tent < 5 && !anchor; tent++) {
        clicar(filtrar);
        progresso(c, 'Etapa 2: filtrando assunto "' + assunto + '"… (tentativa ' + (tent + 1) + ')');
        anchor = await esperar(achaNo, 6000);
      }
      if (!anchor) return pausar(c, 'Etapa 2: assunto "' + assunto + '" não apareceu na árvore mesmo filtrando — selecione o nó manualmente, clique Incluir e depois Continuar');
      clicar(anchor);
      await esperar(() => (document.querySelector('#txtDesAssunto') || {}).value, 5000);
      const incluir = qFirst(IDS.incluirAssunto);
      if (incluir) clicar(incluir);
      const ok = await esperar(linhaAssuntoOk, 8000);
      if (!ok) return pausar(c, 'Etapa 2: não consegui incluir o assunto — inclua manualmente e Continuar');
    }
    const comp = qFirst(IDS.competencia);
    if (comp && d.competencia && comp.value === '-1' && !setSelectByText(comp, d.competencia))
      return pausar(c, 'Etapa 2: competência "' + d.competencia + '" não está na lista', comp);
    const btn = document.querySelector('button[name="sbmProcessoEtapa2"]');
    if (!btn) return pausar(c, 'Etapa 2: botão Próxima não encontrado');
    progresso(c, 'Etapa 2 ok → Próxima');
    clicar(btn);
  }

  function docsDaTabelaPartes() {
    return Array.from(document.querySelectorAll('#tblPartes tbody td'))
      .map(td => (td.textContent || '').replace(/\D/g, '')).filter(s => s.length === 11 || s.length === 14);
  }
  function acharBotaoParte(termos) {
    const cands = Array.from(document.querySelectorAll('input[type="submit"],input[type="button"],button,a'))
      .filter(el => visivel(el) && !/^btn(Proxima|Anterior|Cancelar|Consultar|Novo|Voltar|IncluirAssunto|Salvar$)/.test(el.id || ''));
    for (const t of termos) {
      const alvo = norm(t);
      for (const el of cands) {
        const txt = norm(((el.value || '') + ' ' + (el.textContent || '') + ' ' + (el.title || '')).trim());
        if (txt === alvo || txt.includes(alvo)) return el;
      }
    }
    return null;
  }
  // Ficha da parte para as pausas: quem preenche o cadastro novo/endereço é o
  // humano, mas entregamos prontos os dados que a IA tirou da qualificação.
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
  function fichaParte(p) {
    if (!p) return '';
    const l = [];
    if (p.nome) l.push('<b>Nome:</b> ' + escHtml(p.nome));
    if (p.doc) l.push('<b>CPF/CNPJ:</b> ' + escHtml(p.doc));
    if (p.endereco) l.push('<b>Endereço:</b> ' + escHtml(p.endereco));
    if (p.email) l.push('<b>E-mail:</b> ' + escHtml(p.email));
    if (p.telefone) l.push('<b>Telefone:</b> ' + escHtml(p.telefone));
    return l.length ? '<br><u>Dados da inicial (copie no cadastro):</u><br>' + l.join('<br>') : '';
  }
  async function autoPartes(c, chave, rot) {
    progresso(c, rot + '…');
    const lista = (c.dados[chave] || []).filter(p => p && p.doc);
    const semDoc = (c.dados[chave] || []).filter(p => p && p.nome && !p.doc);
    const presentes = docsDaTabelaPartes();
    const falta = lista.find(p => !presentes.includes(String(p.doc).replace(/\D/g, '')));
    if (!falta) {
      if (semDoc.length && !presentes.length)
        return pausar(c, rot + ': "' + semDoc[0].nome + '" está sem CPF/CNPJ — inclua manualmente e Continuar' + fichaParte(semDoc[0]));
      const btn = document.querySelector('#btnProxima');
      if (!btn) return pausar(c, rot + ': botão Próxima não encontrado');
      // O "Próxima" valida endereço/contato das partes (hdnSinCadastroEnderecoObrigatorio=S):
      // pode abrir o modal "Adicionar Endereço e Contato" em vez de avançar, ou a página
      // recarregar de volta na mesma etapa. Contador + vigia evitam loop/silêncio.
      c.avanco = c.avanco || {};
      c.avanco[chave] = (c.avanco[chave] || 0) + 1;
      await casoSalvar(c);
      if (c.avanco[chave] > 3)
        return pausar(c, rot + ': o eproc não avança — provavelmente falta ENDEREÇO/CONTATO de uma parte. Clique no ícone 🏠 (Adicionar Endereço e Contato) na linha da parte, complete e clique Continuar.');
      progresso(c, rot + ' ok → Próxima');
      clicar(btn);
      await esperar(() => false, 10000); // se navegar, este script morre aqui
      const pendente = lista.find(p => !docsDaTabelaPartes().includes(String(p.doc).replace(/\D/g, '')));
      return pausar(c, rot + ': cliquei em Próxima mas a página não avançou — o eproc deve estar exigindo endereço/contato da parte (modal ou aviso na tela). Complete e clique Continuar.' + fichaParte(pendente || lista[0]));
    }
    const doc = String(falta.doc).replace(/\D/g, '');
    if (c.parte && c.parte.doc === doc) {
      // Já consultamos: procura os botões de conclusão da consulta (Salvar / Incluir).
      const salvar = acharBotaoParte(['salvar']);
      if (salvar && !c.parte.salvou) { c.parte.salvou = true; await casoSalvar(c); progresso(c, rot + ': salvando dados da Receita…'); clicar(salvar); return; }
      const incluir = acharBotaoParte(['incluir']);
      if (incluir && !c.parte.incluiu) {
        c.parte.incluiu = true; await casoSalvar(c);
        progresso(c, rot + ': incluindo ' + (falta.nome || doc) + '…');
        clicar(incluir);
        const ok = await esperar(() => docsDaTabelaPartes().includes(doc), 10000);
        if (ok) { c.parte = null; await casoSalvar(c); return runCentral(); }
      }
      // Consulta não devolveu Salvar/Incluir: pessoa sem cadastro no eproc.
      // O caminho é o botão "Novo" (ao lado do Consultar) → formulário de cadastro
      // com endereço/contato obrigatórios. Destacamos e entregamos a ficha pronta.
      const novo = document.querySelector('#btnNovo');
      if (novo && visivel(novo)) {
        return pausar(c, rot + ': "' + (falta.nome || doc) + '" parece NÃO ter cadastro no eproc. Clique em <b>Novo</b> (destacado), preencha o cadastro (endereço e contato são obrigatórios), inclua a parte e clique Continuar.' + fichaParte(falta), novo);
      }
      return pausar(c, rot + ': não consegui incluir ' + (falta.nome || doc) + ' (pode exigir endereço/cadastro novo) — inclua manualmente e clique Continuar' + fichaParte(falta));
    }
    // 1ª tentativa desta parte: Tipo Pessoa + doc + Consultar (a página recarrega).
    const tipoSel = qFirst(IDS.tipoPessoa);
    if (tipoSel) setSelectByText(tipoSel, doc.length === 11 ? 'Pessoa Física' : 'Pessoa Jurídica');
    const docEl = qFirst(IDS.docParte);
    if (!docEl) return pausar(c, rot + ': campo CPF/CNPJ não encontrado');
    setInput(docEl, falta.doc);
    c.parte = { doc }; await casoSalvar(c);
    const consultar = document.querySelector('#btnConsultar') || qFirst(IDS.consultar);
    if (!consultar) return pausar(c, rot + ': botão Consultar não encontrado');
    progresso(c, rot + ': consultando ' + (falta.nome || doc) + '…');
    clicar(consultar);
  }

  async function pedirDoc(casoId, idx) {
    const r = await chrome.runtime.sendMessage({ type: 'PEDIR_DOC', casoId, idx });
    if (!r || !r.ok) throw new Error('PDF ' + (idx + 1) + ': ' + ((r && r.error) || 'a aba da Central está fechada?'));
    const bin = atob(r.base64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], r.nome, { type: 'application/pdf' });
  }
  function uploadsProntos() {
    return Array.from(document.querySelectorAll('input[id^="fleArquivo_"]')).filter(i => i.value).length;
  }
  async function autoE5(c) {
    progresso(c, 'Etapa 5/5 — documentos…');
    const n = (c.docs || []).length;
    const naTabela = () => document.querySelectorAll('#tbDocumentosCadastradas tbody tr').length;
    if (naTabela() < n) {
      if (uploadsProntos() === 0) {
        const input = qFirst(IDS.anexo);
        if (!input) return pausar(c, 'Etapa 5: uploader não encontrado');
        progresso(c, 'Etapa 5: baixando e anexando ' + n + ' PDF(s)…');
        const dt = new DataTransfer();
        for (const d of c.docs) dt.items.add(await pedirDoc(c.id, d.idx));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const okUp = await esperar(() => uploadsProntos() >= n, 120000, 600);
      if (!okUp) return pausar(c, 'Etapa 5: upload dos PDFs não concluiu (' + uploadsProntos() + '/' + n + ') — confira e Continuar');
      // Tipos: a ordem dos fieldsets segue a ordem de anexação (= ordem de c.docs).
      let iDoc = 0;
      for (const fld of Array.from(document.querySelectorAll('fieldset[id^="fldInfDocumento"]'))) {
        const nId = (fld.id || '').replace('fldInfDocumento', '');
        const fle = document.getElementById('fleArquivo_' + nId);
        if (!fle || !fle.value) continue;
        const meta = c.docs[iDoc++]; if (!meta) break;
        const hidden = document.getElementById('selTipoArquivo_' + nId);
        const txt = document.getElementById('txtTipo_' + nId);
        const usaOut = !meta.selVal;
        if (hidden) hidden.value = meta.selVal || '11';
        if (txt) txt.value = usaOut ? 'OUTROS' : meta.tipoTxt;
        if (usaOut || meta.selVal === '11') {
          const obs = document.getElementById('txtObservacao_' + nId);
          if (obs) { obs.style.display = 'inline-block'; obs.value = meta.obs || meta.tipoTxt || meta.nome; }
        }
      }
      const conf = qFirst(IDS.confirmarDocs);
      if (!conf) return pausar(c, 'Etapa 5: botão "Confirmar seleção de documentos" não encontrado');
      progresso(c, 'Etapa 5: confirmando ' + n + ' documento(s)…');
      clicar(conf);
      const okTb = await esperar(() => naTabela() >= n, 120000, 600);
      if (!okTb) return pausar(c, 'Etapa 5: documentos não entraram na tabela (' + naTabela() + '/' + n + ') — confira os tipos e Continuar');
    }
    const fin = qFirst(IDS.finalizar);
    if (!fin) return pausar(c, 'Etapa 5: botão Finalizar não encontrado');
    if (c.primeiro && !c.validado) {
      c.validado = true;
      destacar(fin);
      return pausar(c, '1º caso do lote: confira as etapas e clique VOCÊ em Finalizar — depois disso a fila segue sozinha');
    }
    progresso(c, 'finalizando (protocolo automático)…');
    await chrome.runtime.sendMessage({ type: 'OVERRIDE_DIALOGS' }).catch(() => {});
    clicar(fin);
  }

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m.type === 'FILL_JOB') {
      iniciar(m.job).catch(e => setBody(msg('Erro: ' + (e.message || e), '#ffe3e3')));
      send({ ok: true });
    } else if (m.type === 'ANEXAR_PDF_LOCAL') {
      anexarPdfLocal(m.nome, m.base64).catch(e => setBody(msg('Erro ao anexar: ' + (e.message || e), '#ffe3e3')));
      send({ ok: true });
    } else if (m.type === 'RUN_CENTRAL') {
      (async () => {
        await casoSalvar({ ...m.caso, status: 'rodando', motivo: null, parte: null, validado: false });
        runCentral().catch(() => {});
      })();
      send({ ok: true });
    } else if (m.type === 'CONTINUAR_CENTRAL') {
      (async () => {
        const c = await casoLer();
        if (c) { c.status = 'rodando'; c.motivo = null; await casoSalvar(c); runCentral().catch(() => {}); }
      })();
      send({ ok: true });
    } else if (m.type === 'CANCELAR_CENTRAL') {
      casoLimpar().then(() => setBody(msg('Caso cancelado pela Central.', '#f1f3f5')));
      send({ ok: true });
    }
    return true;
  });

  // Auto-retoma a cada recarregamento de página: primeiro a Central (modo auto),
  // senão o job assistido do app (fluxo antigo).
  (async function autoRetomar() {
    const c = await casoLer();
    if (c) { runCentral().catch(() => {}); return; }
    const job = await lerJobAtivo();
    if (job && job.tipo === 'inicial' && detectarEtapa() > 0) {
      preencherDistribuicao(job).catch(() => {});
    }
  })();
})();
