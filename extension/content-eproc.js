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
      sel.value = best.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true;
    }
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

  function etapa1(d, erros) {
    preencherCampo(DIST.comarca, d.comarca, 'Comarca', erros, true, IDS.comarca);
    // Campo real: "Valor da Causa: (R$) (Somente números)" → sem separador de milhar.
    preencherCampo(DIST.valorCausa, d.valor_causa != null ? fmtNum(d.valor_causa).replace(/\./g, '') : null, 'Valor da causa', erros, false, IDS.valorCausa);
    preencherCampo(DIST.rito, d.rito, 'Rito', erros, false, IDS.rito);
    preencherCampo(DIST.area, d.area, 'Área', erros, false, IDS.area);
    preencherCampo(DIST.classe, d.classe, 'Classe processual', erros, true, IDS.classe);
    if (d.nivel_sigilo != null) preencherCampo(DIST.sigilo, 'Nível ' + d.nivel_sigilo, 'Nível de sigilo', erros, false, IDS.sigilo);
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
    const erros = [];
    if (etapa === 1) etapa1(d, erros);
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

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m.type === 'FILL_JOB') {
      iniciar(m.job).catch(e => setBody(msg('Erro: ' + (e.message || e), '#ffe3e3')));
      send({ ok: true });
    } else if (m.type === 'ANEXAR_PDF_LOCAL') {
      anexarPdfLocal(m.nome, m.base64).catch(e => setBody(msg('Erro ao anexar: ' + (e.message || e), '#ffe3e3')));
      send({ ok: true });
    }
    return true;
  });

  // Auto-retoma a distribuição a cada recarregamento de página (após "Próxima"),
  // enquanto houver job ativo guardado e a página parecer uma etapa do assistente.
  (async function autoRetomar() {
    const job = await lerJobAtivo();
    if (job && job.tipo === 'inicial' && detectarEtapa() > 0) {
      preencherDistribuicao(job).catch(() => {});
    }
  })();
})();
