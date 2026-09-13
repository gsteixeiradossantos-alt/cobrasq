/* =============================================================================
 *  NFS-e ESNFS — Emissão em lote (COBRASQ)
 *  content.js — motor de automação que roda dentro de esnfs.com.br
 *
 *  Executa o playbook "Emitir NFS-e ESNFS (COBRASQ)" NF a NF:
 *    1. CPF/CNPJ  ->  carrega cadastro do tomador
 *    2. abre o modal do tomador pelo LÁPIS (nunca pelo campo "Pesquisa")
 *    3. aplica as regras de decisão (completo / parcial / vazio / override)
 *    4. Fechar  ->  Incluir serviço
 *    5. serviço -> ESPERA -> valor -> alíquota -> discriminação -> Salvar
 *    6. Gravar  ->  lê a mensagem de resultado  ->  próxima NF
 *
 *  O estado vive em chrome.storage.local, então a automação sobrevive ao
 *  recarregamento de página que o "Gravar" provoca.
 * ========================================================================== */

(() => {
  'use strict';

  if (!/(^|\.)esnfs\.com\.br$/i.test(location.hostname)) return;
  if (window.__nfseAutoLoaded) return;
  window.__nfseAutoLoaded = true;

  const KEY = 'nfseJob';
  const EDIT_PATH = '/nfsemissao.edit.logic';

  /* ---------------------------------------------------------------- estado */

  const getState = () =>
    new Promise((res) => chrome.storage.local.get(KEY, (o) => res(o[KEY] || null)));
  const setState = (st) =>
    new Promise((res) => chrome.storage.local.set({ [KEY]: st }, res));

  let ST = null; // cópia em memória do estado
  let pendingConfirm = null; // resolver do "confirmar antes de gravar"

  async function save() {
    await setState(ST);
  }

  /* --------------------------------------------------------------- helpers */

  const byId = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, { timeout = 12000, interval = 120, label = 'condição' } = {}) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try {
        v = fn();
      } catch (_) {
        v = null;
      }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('Tempo esgotado aguardando ' + label);
      await sleep(interval);
    }
  }

  /**
   * O modal do Bootstrap está aberto?
   *
   * Três armadilhas que este check evita:
   *  - offsetParent é sempre null em position:fixed (todo .modal é fixed);
   *  - o retângulo do .modal pode medir 0x0 mesmo aberto;
   *  - a opacidade NÃO serve de critério: o .modal usa transição de opacity e,
   *    se a aba estiver em segundo plano, o navegador congela a transição —
   *    o modal fica aberto para sempre com opacity 0 e a automação travaria.
   *
   * Sobra o que é confiável e imediato: display e visibility, que o Bootstrap
   * altera na hora ao abrir e ao fechar.
   */
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true });
    }
    return true;
  }
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

  function setValue(el, v) {
    if (!el) return;
    try { el.focus(); } catch (_) {}
    el.value = v;
    fire(el, 'input');
    fire(el, 'change');
    try { el.blur(); } catch (_) {}
  }

  const onlyDigits = (s) => String(s || '').replace(/\D+/g, '');
  const txt = (el) => (el ? (el.value !== undefined ? el.value : el.textContent) || '' : '').trim();

  function formatDoc(d) {
    d = onlyDigits(d);
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    return d;
  }

  function norm(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const STOP = new Set(['DA', 'DE', 'DO', 'DAS', 'DOS', 'E', 'D']);
  const words = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t));

  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      prev = cur;
    }
    return prev[n];
  }

  /** Dois pedaços de nome são o mesmo? Trata inicial ("B." = "BATISTA") e typo. */
  function tokenMatch(a, b) {
    if (a === b) return true;
    if (a.length === 1) return b.indexOf(a) === 0;
    if (b.length === 1) return a.indexOf(b) === 0;
    return 1 - lev(a, b) / Math.max(a.length, b.length) >= 0.75;
  }

  /**
   * 0..1 — o quanto os nomes são compatíveis, tolerando acento, typo e
   * abreviação. Divide pelo MENOR dos dois porque "DIONEIA B." e
   * "DIONEIA BATISTA" são a mesma pessoa — um é só a versão curta do outro.
   * Primeiro nome diferente derruba tudo a zero: aí é outra pessoa.
   */
  function nameSimilarity(a, b) {
    const A = words(a), B = words(b);
    if (!A.length || !B.length) return 0;
    if (!tokenMatch(A[0], B[0])) return 0;
    const used = new Set();
    let matched = 0;
    for (const ta of A) {
      for (let i = 0; i < B.length; i++) {
        if (used.has(i)) continue;
        if (tokenMatch(ta, B[i])) { used.add(i); matched++; break; }
      }
    }
    return matched / Math.min(A.length, B.length);
  }

  /**
   * Quantos pedaços do nome estão por extenso (não são inicial).
   * Serve para nunca trocar um cadastro completo por uma versão abreviada,
   * e para completar um cadastro abreviado quando a lista traz o nome inteiro.
   */
  const completude = (s) => words(s).filter((t) => t.length > 1).length;

  /* ------------------------------------------------------------ painel HUD */

  let hud = null, hudRoot = null;

  function buildHud() {
    if (hud) return;
    hud = document.createElement('div');
    hud.id = '__nfse_hud';
    hud.style.cssText =
      'position:fixed;right:16px;bottom:16px;width:340px;z-index:2147483647;';
    hudRoot = hud.attachShadow({ mode: 'open' });
    hudRoot.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
        .box{background:#fff;color:#1f2937;border:1px solid #e2e8f0;border-radius:12px;
             box-shadow:0 10px 40px rgba(15,23,42,.18);overflow:hidden;font-size:12px}
        .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f8fafc;
            border-bottom:1px solid #e2e8f0;font-weight:600;font-size:12px;color:#0f172a}
        .dot{width:8px;height:8px;border-radius:50%;background:#16a34a;flex:0 0 auto}
        .dot.pause{background:#d97706}.dot.err{background:#dc2626}.dot.done{background:#0284c7}
        .hd .sp{margin-left:auto;display:flex;gap:6px}
        .bd{padding:10px 12px}
        .bar{height:6px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin:6px 0 8px}
        .bar i{display:block;height:100%;background:#0284c7;width:0;transition:width .3s}
        .cur{font-size:12px;color:#0f172a;margin-bottom:2px}
        .st{font-size:11px;color:#64748b;min-height:14px}
        .log{margin-top:8px;max-height:150px;overflow:auto;border-top:1px solid #e2e8f0;
             padding-top:6px;font-size:11px;line-height:1.5;color:#64748b}
        .log b{color:#334155;font-weight:600}
        .log .ok{color:#15803d}.log .er{color:#b91c1c}.log .wr{color:#b45309}
        button{border:1px solid #cbd5e1;border-radius:6px;padding:5px 9px;font-size:11px;
               font-weight:600;cursor:pointer;background:#fff;color:#334155}
        button:hover{background:#f1f5f9}
        button.pri{background:#0284c7;border-color:#0284c7;color:#fff}
        button.pri:hover{background:#0369a1}
        button.dg{background:#fff;border-color:#fca5a5;color:#b91c1c}
        button.dg:hover{background:#fef2f2}
        .row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
        .cf{background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:8px;
            border-radius:8px;margin-top:8px;font-size:11px}
        .ver{font-size:10px;font-weight:600;color:#64748b;background:#f1f5f9;
             border:1px solid #e2e8f0;border-radius:4px;padding:2px 5px;
             font-variant-numeric:tabular-nums;align-self:center}
        .min .bd{display:none}
      </style>
      <div class="box" id="box">
        <div class="hd">
          <span class="dot" id="dot"></span>
          <span>NFS-e em lote</span>
          <span id="cnt" style="color:#64748b;font-weight:400"></span>
          <span class="sp"><span class="ver" id="ver"></span><button id="tog">–</button></span>
        </div>
        <div class="bd">
          <div class="cur" id="cur">—</div>
          <div class="bar"><i id="pb"></i></div>
          <div class="st" id="st"></div>
          <div id="cfbox"></div>
          <div class="row" id="btns"></div>
          <div class="log" id="log"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(hud);

    // versão carregada — confirma na hora se o Chrome pegou a build nova
    try {
      const m = chrome.runtime.getManifest();
      hudRoot.getElementById('ver').textContent = 'v' + (m.version_name || m.version);
    } catch (_) {
      hudRoot.getElementById('ver').textContent = 'v?';
    }

    hudRoot.getElementById('tog').onclick = () => {
      const b = hudRoot.getElementById('box');
      b.classList.toggle('min');
      hudRoot.getElementById('tog').textContent = b.classList.contains('min') ? '+' : '–';
    };
  }

  function logLine(msg, kind) {
    if (!hudRoot) return;
    const el = hudRoot.getElementById('log');
    const d = document.createElement('div');
    if (kind) d.className = kind;
    const hh = new Date().toTimeString().slice(0, 8);
    d.innerHTML = `<b>${hh}</b> ${msg}`;
    el.appendChild(d);
    while (el.children.length > 60) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  function status(s) {
    if (hudRoot) hudRoot.getElementById('st').textContent = s || '';
  }

  function renderHud() {
    if (!ST) { if (hud) hud.remove(), (hud = null), (hudRoot = null); return; }
    buildHud();
    const total = ST.queue.length;
    const done = Math.min(ST.index, total);
    const item = ST.queue[ST.index];
    hudRoot.getElementById('cnt').textContent = `${done}/${total}`;
    hudRoot.getElementById('pb').style.width = total ? (done / total) * 100 + '%' : '0%';
    hudRoot.getElementById('cur').textContent =
      ST.phase === 'done'
        ? 'Concluído.'
        : item
        ? `NF ${ST.index + 1}: ${item.nome} — R$ ${item.valor}`
        : '—';

    const dot = hudRoot.getElementById('dot');
    dot.className = 'dot' + (ST.phase === 'done' ? ' done' : ST.paused ? ' pause' : '');

    // botões
    const btns = hudRoot.getElementById('btns');
    btns.innerHTML = '';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = fn;
      btns.appendChild(b);
    };
    if (ST.phase === 'done') {
      mk('Copiar relatório', 'pri', copyReport);
      const fails = ST.results.filter((r) => r.status !== 'ok');
      if (fails.length) mk(`Reprocessar ${fails.length} falha(s)`, '', retryFailures);
      mk('Limpar', 'dg', async () => { ST = null; await setState(null); renderHud(); });
    } else if (ST.paused) {
      mk('Retomar', 'pri', async () => {
        ST.paused = false; ST.pauseReason = ''; await save(); renderHud(); boot();
      });
      mk('Parar', 'dg', stopJob);
      mk('Copiar relatório', '', copyReport);
    } else {
      mk('Pausar', '', async () => { ST.paused = true; await save(); renderHud(); });
      mk('Parar', 'dg', stopJob);
    }

    // caixa de confirmação
    const cf = hudRoot.getElementById('cfbox');
    cf.innerHTML = '';
    if (ST.phase === 'awaiting-confirm') {
      const d = document.createElement('div');
      d.className = 'cf';
      d.innerHTML = '<div style="margin-bottom:6px">Nota preenchida e conferida na tela. Gravar?</div>';
      const ok = document.createElement('button');
      ok.className = 'pri'; ok.textContent = 'Gravar e continuar';
      ok.onclick = () => { if (pendingConfirm) pendingConfirm(true); };
      const no = document.createElement('button');
      no.className = 'dg'; no.textContent = 'Cancelar lote';
      no.style.marginLeft = '6px';
      no.onclick = () => { if (pendingConfirm) pendingConfirm(false); };
      d.appendChild(ok); d.appendChild(no);
      cf.appendChild(d);
    }
    if (ST.paused && ST.pauseReason) {
      const d = document.createElement('div');
      d.className = 'cf';
      d.textContent = ST.pauseReason;
      cf.appendChild(d);
    }
  }

  /* -------------------------------------------------------------- relatório */

  function buildReport() {
    if (!ST) return '';
    const l = [];
    l.push(`# Emissão de NFS-e — ${new Date().toLocaleString('pt-BR')}`);
    l.push('');
    l.push('| # | Tomador | CPF/CNPJ | Valor (R$) | Nota | Status | Observação |');
    l.push('|---|---------|----------|-----------|------|--------|------------|');
    let soma = 0;
    ST.results.forEach((r, i) => {
      if (r.status === 'ok') soma += parseFloat(String(r.valor).replace(/\./g, '').replace(',', '.')) || 0;
      l.push(
        `| ${i + 1} | ${r.nome} | ${formatDoc(r.cpf)} | ${r.valor} | ${r.nota || '—'} | ${
          r.status === 'ok' ? '✅ emitida' : '❌ falhou'
        } | ${(r.obs || []).join('; ') || '—'} |`
      );
    });
    l.push('');
    const ok = ST.results.filter((r) => r.status === 'ok').length;
    l.push(`**Emitidas:** ${ok}/${ST.results.length} — **Total emitido:** R$ ${soma.toFixed(2).replace('.', ',')}`);
    const fails = ST.results.filter((r) => r.status !== 'ok');
    if (fails.length) {
      l.push('');
      l.push('**Pendentes / falhadas:**');
      fails.forEach((r) => l.push(`- ${r.nome} (${formatDoc(r.cpf)}) — ${(r.obs || []).join('; ')}`));
    }
    // Bloco legível por máquina: o painel COBRASQ ("Importar resultado do ESNFS") lê
    // daqui a ref, o status e o número da nota para marcar cada linha como emitida.
    l.push('');
    l.push('--- COBRASQ-RESULTADO v1 ---');
    l.push('ref;status;nota;cpf;valor;nome;obs');
    const limpo = (v) => String(v || '').replace(/[;\r\n]+/g, ' ').trim();
    ST.results.forEach((r) => {
      l.push([
        limpo(r.ref || (r.item && r.item.ref)), r.status === 'ok' ? 'ok' : 'erro', limpo(r.nota),
        onlyDigits(r.cpf), limpo(r.valor), limpo(r.nome), limpo((r.obs || []).join(' / ')),
      ].join(';'));
    });
    l.push('--- FIM ---');
    return l.join('\n');
  }

  async function copyReport() {
    const t = buildReport();
    try {
      await navigator.clipboard.writeText(t);
      logLine('Relatório copiado para a área de transferência.', 'ok');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      logLine('Relatório copiado.', 'ok');
    }
  }

  async function retryFailures() {
    const fails = ST.results.filter((r) => r.status !== 'ok').map((r) => r.item);
    if (!fails.length) return;
    ST = {
      ...ST,
      queue: fails,
      index: 0,
      results: [],
      phase: 'running',
      paused: false,
      pauseReason: '',
      navTries: 0,
    };
    await save();
    renderHud();
    boot();
  }

  async function stopJob() {
    if (ST) { ST.phase = 'done'; ST.paused = false; await save(); }
    renderHud();
  }

  async function pause(reason) {
    ST.paused = true;
    ST.pauseReason = reason;
    await save();
    logLine(reason, 'er');
    renderHud();
  }

  /* Pausa cooperativa: o botão "Pausar" só interrompe entre passos, nunca no
     meio de um preenchimento — assim a nota nunca fica meio pronta sem aviso. */
  let resumeWaiters = [];
  const waitResume = () => new Promise((r) => resumeWaiters.push(r));

  async function gate() {
    if (ST && ST.paused) {
      status('pausado — clique em Retomar');
      logLine('pausado a pedido do usuário', 'wr');
      await waitResume();
      status('retomando…');
    }
    if (ST && ST.phase === 'done') throw new Error('__abort__');
  }

  /* ------------------------------------------------------- passos do fluxo */

  const isEmissionPage = () => !!byId('nrDocumentoTomador') && !!byId('notaFiscal');

  /** Passo 1+2 — informa o documento e abre o cadastro pelo lápis. */
  async function abrirTomador(item) {
    status('abrindo cadastro do tomador…');
    const cpf = await waitFor(() => byId('nrDocumentoTomador'), { label: 'campo Cpf/Cnpj' });
    setValue(cpf, formatDoc(item.cpf));
    await sleep(1600); // AJAX carregaTomadorConferindoDados

    const lapis = document.querySelector('button[data-target="#tomadorModal"]');
    if (!lapis) throw new Error('Botão de edição do tomador (lápis) não encontrado');
    lapis.click();

    await waitFor(() => visible(byId('tomadorModal')), { label: 'modal do Tomador' });
    await sleep(500);
  }

  /**
   * Seleciona UF e cidade (a lista de cidades vem por AJAX ao trocar a UF).
   * `force` = o endereço veio da lista e tem precedência sobre o cadastro.
   * Sem force, um cadastro que já tem UF+cidade é preservado — nunca troque
   * a UF de um cadastro válido, porque isso apaga a cidade dele.
   */
  async function setUfCidade(uf, cidade, force) {
    const ufSel = byId('formulario.tomador.endereco.nmUf');
    const citySel = byId('formulario.tomador.endereco.idCidade');
    if (!ufSel || !citySel) return;

    if (ufSel.value && citySel.value && !force) return; // cadastro completo

    if (norm(ufSel.value) !== norm(uf)) {
      setValue(ufSel, uf);
      await waitFor(() => citySel.options.length > 1, { timeout: 15000, label: 'lista de cidades' });
      await sleep(250);
    }
    if (citySel.value && !force) return;
    const alvo = norm(cidade);
    const opt = Array.from(citySel.options).find((o) => norm(o.textContent) === alvo);
    if (!opt) throw new Error(`Cidade "${cidade}" não encontrada na lista de ${uf}`);
    setValue(citySel, opt.value);
  }

  /** Passo 2 — aplica as regras de decisão sobre o cadastro do tomador. */
  async function ajustarTomador(item, obs) {
    const cfg = ST.cfg;
    const f = {
      nome: byId('formulario.tomador.nmPessoa'),
      email: byId('formulario.tomador.endereco.dsEmail'),
      tel: byId('formulario.tomador.endereco.nrTelefone'),
      log: byId('formulario.tomador.endereco.dsEndereco'),
      num: byId('formulario.tomador.endereco.nrEndereco'),
      bairro: byId('formulario.tomador.endereco.nmBairro'),
      cep: byId('formulario.tomador.endereco.nrCep'),
    };
    if (!f.nome) throw new Error('Campos do modal do Tomador não encontrados');

    // --- nome
    // O normal é o nome vir do próprio ESNFS ao pesquisar o CPF; a linha só
    // precisa trazer nome quando o tomador ainda não existe no cadastro.
    const atual = txt(f.nome);
    if (!item.nome) {
      if (!atual) {
        throw new Error(
          'o ESNFS não encontrou este CPF/CNPJ e a linha não trouxe o nome — ' +
            'preencha o nome do tomador nesta linha e refaça'
        );
      }
      // cadastro achado: usa o nome dele, nada a decidir
    } else if (!atual) {
      setValue(f.nome, norm(item.nome));
      obs.push('cadastro vazio — nome preenchido pela lista');
    } else {
      const sim = nameSimilarity(atual, item.nome);
      if (sim < 0.7) {
        // diferença grande: provavelmente outra pessoa no cadastro
        setValue(f.nome, norm(item.nome));
        obs.push(`NOME DIVERGENTE: cadastro dizia "${atual}" → gravado "${norm(item.nome)}" (confira)`);
      } else if (completude(item.nome) > completude(atual)) {
        // mesma pessoa, mas o cadastro estava abreviado
        setValue(f.nome, norm(item.nome));
        obs.push(`nome do cadastro estava abreviado ("${atual}") → completado pela lista`);
      } else if (norm(atual) !== norm(item.nome)) {
        obs.push(`pequena diferença de nome — mantido o do cadastro ("${atual}")`);
      }
    }

    // --- contato: só preenche o que estiver vazio
    if (item.telefone && !txt(f.tel)) setValue(f.tel, onlyDigits(item.telefone));
    if (item.email && !txt(f.email)) setValue(f.email, item.email.trim());

    // --- endereço
    const pad = cfg.endereco;
    const dado = item.endereco || null; // endereço vindo da lista tem precedência

    const aplicar = (el, valorDado, valorPadrao, rotulo) => {
      if (!el) return;
      if (valorDado) { setValue(el, valorDado); return; }
      if (!txt(el)) { setValue(el, valorPadrao); obs.push(`${rotulo} ausente → padrão`); }
    };

    aplicar(f.log, dado && dado.logradouro, pad.logradouro, 'logradouro');
    aplicar(f.num, dado && dado.numero, pad.numero, 'número');
    aplicar(f.bairro, dado && dado.bairro, pad.bairro, 'bairro');
    aplicar(f.cep, dado && onlyDigits(dado.cep), onlyDigits(pad.cep), 'CEP');

    const uf = (dado && dado.uf) || pad.uf;
    const cidade = (dado && dado.cidade) || pad.cidade;
    await setUfCidade(uf, cidade, !!dado);

    // --- fechar o modal (salvaTomador)
    status('salvando tomador…');
    const fechar = document.querySelector('#tomadorModal button.botaoGravar');
    if (!fechar) throw new Error('Botão "Fechar" do modal do Tomador não encontrado');
    fechar.click();

    try {
      await waitFor(() => !visible(byId('tomadorModal')), { timeout: 6000, label: 'fechamento do modal' });
    } catch (e) {
      const err = txt(byId('mensagemTomador'));
      throw new Error('O ESNFS recusou os dados do tomador: ' + (err || 'motivo não informado'));
    }
    await sleep(400);
  }

  /** Escolhe a opção de serviço (código 17.22.01.000 — Cobrança em geral). */
  function pickServico(sel) {
    const opts = Array.from(sel.options).filter((o) => o.value);
    const byVal = opts.find((o) => o.value === ST.cfg.servicoValue);
    if (byVal) return byVal;
    const alvo = norm(ST.cfg.servicoMatch);
    const byTxt = opts.find((o) => norm(o.textContent).includes(alvo));
    if (byTxt) return byTxt;
    if (opts.length === 1) return opts[0];
    throw new Error('Não encontrei o serviço "' + ST.cfg.servicoMatch + '" na lista do prestador');
  }

  /** Passos 3+4 — inclui o serviço, respeitando a ORDEM crítica. */
  async function incluirServico(item) {
    status('incluindo serviço…');
    const link = await waitFor(() => byId('linkAdicionarNovoServico'), { label: 'link "Incluir serviço"' });
    link.click();
    await waitFor(() => visible(byId('novoServicoModal')), { label: 'modal Novo Serviço' });
    await sleep(500);

    const sel = byId('idServico');
    if (!sel) throw new Error('Combo de serviço não encontrado');
    setValue(sel, pickServico(sel).value);

    // ORDEM CRÍTICA: a alíquota é zerada ao escolher o serviço — esperar.
    await sleep(1300);

    setValue(byId('vlServico'), item.valorBRL);

    const aliq = byId('vlAliquota');
    if (aliq) {
      aliq.focus();
      aliq.value = '';
      fire(aliq, 'input');
      setValue(aliq, ST.cfg.aliquota);
    }

    setValue(byId('dsDiscriminacaoServico'), ST.cfg.discriminacao);
    await sleep(200);

    const salvar = document.querySelector('#novoServicoModal button.botaoGravar');
    if (!salvar) throw new Error('Botão "Salvar" do serviço não encontrado');
    salvar.click();

    try {
      await waitFor(() => !visible(byId('novoServicoModal')), { timeout: 8000, label: 'gravação do serviço' });
    } catch (e) {
      const err = txt(byId('mensagemServico'));
      throw new Error('O ESNFS recusou o serviço: ' + (err || 'motivo não informado'));
    }

    // valida que o serviço realmente entrou na nota
    await waitFor(() => txt(byId('vlTotalNota')) && txt(byId('vlTotalNota')) !== '0,00', {
      timeout: 8000,
      label: 'total da nota',
    });
    const total = txt(byId('vlTotalNota'));
    logLine(`serviço lançado — total da nota R$ ${total}`);
    if (total !== item.valorBRL) {
      logLine(`atenção: total (${total}) diferente do valor pedido (${item.valorBRL})`, 'wr');
    }
  }

  /** Passo 5 — grava a NF. A página navega; o resultado é lido no próximo load. */
  async function gravarNota(obs) {
    const btn = document.querySelector('input[value="Gravar"][onclick*="insert.logic"]');
    if (!btn) throw new Error('Botão "Gravar" não encontrado');

    if (ST.cfg.dryRun) {
      ST.results.push(mkResult('ok', obs.concat('SIMULAÇÃO — nota preenchida, não gravada'), '(simulação)'));
      ST.phase = 'done';
      await save();
      renderHud();
      logLine(
        'SIMULAÇÃO: a nota está preenchida na tela e NÃO foi gravada. Confira os campos e, se estiver certo, ' +
          'desmarque "Simulação" e rode o lote de verdade.',
        'wr'
      );
      status('simulação concluída — nada foi gravado');
      return;
    }

    const precisaConfirmar =
      ST.cfg.confirmMode === 'each' ||
      (ST.cfg.confirmMode === 'first' && ST.results.length === 0);

    if (precisaConfirmar) {
      ST.phase = 'awaiting-confirm';
      await save();
      renderHud();
      status('aguardando sua confirmação…');
      const ok = await new Promise((res) => (pendingConfirm = res));
      pendingConfirm = null;
      if (!ok) {
        ST.phase = 'done';
        await save();
        renderHud();
        logLine('Lote cancelado por você.', 'wr');
        return;
      }
    }

    status('gravando a nota…');
    ST.phase = 'awaiting-gravar';
    ST.pendingObs = obs;
    await save();
    renderHud();

    btn.click();

    // Se o ESNFS responder sem navegar, tratamos aqui mesmo.
    try {
      await waitFor(() => txt(byId('mensagem')).length > 3, { timeout: 25000, label: 'resposta do ESNFS' });
      await finalizarNota();
    } catch (_) {
      /* navegou: o próximo carregamento assume */
    }
  }

  function mkResult(statusStr, obs, nota) {
    const it = ST.queue[Math.min(ST.index, ST.queue.length - 1)];
    return {
      nome: it.nome,
      cpf: it.cpf,
      valor: it.valorBRL,
      nota: nota || '',
      status: statusStr,
      obs: obs || [],
      ref: it.ref || '', // ref do painel COBRASQ (fila:<uuid>/manual:<id>) — volta no relatório
      item: it,
    };
  }

  /** Lê a mensagem do ESNFS depois do Gravar e decide o próximo passo. */
  async function finalizarNota() {
    // a mensagem pode aparecer alguns instantes depois do carregamento
    await waitFor(() => txt(byId('mensagem')).length > 3, { timeout: 5000, label: 'mensagem' }).catch(() => {});
    const msg = txt(byId('mensagem'));
    const obs = ST.pendingObs || [];
    const sucesso = /sucesso|inserid/i.test(msg) && !/erro|falh/i.test(msg);

    if (sucesso) {
      let nota = '';
      const linha = document.querySelector('#ultimasNotasAtualizacao tr td:nth-child(2)');
      if (linha) nota = linha.textContent.trim();
      ST.results.push(mkResult('ok', obs, nota));
      logLine(`NF ${ST.index + 1} emitida${nota ? ' (nº ' + nota + ')' : ''}.`, 'ok');
    } else {
      ST.results.push(mkResult('erro', obs.concat(msg || 'a página não confirmou a emissão')));
      logLine(`NF ${ST.index + 1} falhou: ${msg || 'sem mensagem'}`, 'er');
    }

    ST.index++;
    ST.pendingObs = null;
    ST.phase = 'running';
    ST.dirty = false; // vamos recarregar o formulário limpo logo abaixo
    await save();
    renderHud();

    if (ST.index >= ST.queue.length) {
      ST.phase = 'done';
      await save();
      renderHud();
      logLine('Lote concluído.', 'ok');
      await copyReport();
      return;
    }
    location.href = EDIT_PATH; // sempre volta ao formulário limpo
  }

  /* ------------------------------------------------------- laço principal */

  async function processarItem() {
    const item = ST.queue[ST.index];
    if (!item) {
      ST.phase = 'done';
      await save();
      renderHud();
      return;
    }
    logLine(`<b>NF ${ST.index + 1}/${ST.queue.length}</b> — ${item.nome} · R$ ${item.valorBRL}`);
    const obs = [];
    ST.dirty = true; // a partir daqui o formulário tem dados pela metade
    await save();
    try {
      await gate();
      await abrirTomador(item);
      await gate();
      await ajustarTomador(item, obs);
      await gate();
      await incluirServico(item);
      await gate();
      await gravarNota(obs);
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      if (m === '__abort__') { renderHud(); return; }
      logLine(`erro na NF ${ST.index + 1}: ${m}`, 'er');
      ST.results.push(mkResult('erro', obs.concat(m)));
      ST.index++;
      ST.phase = 'running';
      ST.dirty = false;
      await save();
      renderHud();
      if (ST.index >= ST.queue.length) {
        ST.phase = 'done';
        await save();
        renderHud();
        logLine('Lote concluído (com falhas).', 'wr');
        await copyReport();
        return;
      }
      await sleep(600);
      location.href = EDIT_PATH; // recomeça limpo depois de um erro
    }
  }

  async function boot() {
    ST = await getState();
    renderHud();
    if (!ST || ST.phase === 'done' || !ST.running || ST.paused) return;

    if (ST.phase === 'awaiting-gravar') {
      await finalizarNota();
      return;
    }
    if (ST.phase === 'awaiting-confirm') {
      // recarregou no meio da confirmação: refaz o item do zero
      ST.phase = 'running';
      await save();
    }

    // formulário ficou pela metade (pausa/recarregamento no meio do
    // preenchimento) — recomeça de uma tela limpa para não somar serviços
    if (ST.dirty) {
      ST.dirty = false;
      await save();
      logLine('formulário estava pela metade — recarregando a tela de emissão', 'wr');
      location.href = EDIT_PATH;
      return;
    }

    if (!isEmissionPage()) {
      ST.navTries = (ST.navTries || 0) + 1;
      await save();
      if (ST.navTries > 3) {
        await pause(
          'Não consegui abrir a tela de Emissão de NFS-e. Verifique se você continua logado no ESNFS e clique em Retomar.'
        );
        return;
      }
      location.href = EDIT_PATH;
      return;
    }

    ST.navTries = 0;
    await save();
    await sleep(400);
    await processarItem();
  }

  // pausa/retomada disparadas pelo popup
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch[KEY]) return;
    const novo = ch[KEY].newValue;
    if (!novo) { ST = null; renderHud(); return; }
    const eraPausado = ST && ST.paused;
    ST = novo;
    renderHud();
    if (eraPausado && !novo.paused && novo.running) {
      if (resumeWaiters.length) resumeWaiters.splice(0).forEach((f) => f());
      else boot();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
