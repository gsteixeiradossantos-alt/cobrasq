// extension/content-eproc.js — roda na página do eproc TJPR (usuário já logado).
//
// Recebe um "job" (petição preparada) do popup, AUTO-PREENCHE a tela de
// peticionamento e PARA no botão Protocolar (revisão humana — padrão). NÃO clica
// em Protocolar. Depois que o humano protocola, ele confirma o nº no painel e a
// extensão reporta o resultado ao app.
//
// ⚠️ Seletores em selectors.js (window.EPROC_SEL) — validar contra o eproc real.

(function () {
  const SEL = window.EPROC_SEL || {};
  const TXT = window.EPROC_TXT || {};
  let jobAtual = null;

  // ── helpers de DOM ─────────────────────────────────────────────────────────
  function qFirst(cands) {
    for (const sel of (cands || [])) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (_) {}
    }
    return null;
  }
  // Fallback: acha <input>/<select> cujo rótulo/â vizinhança contém `texto`.
  function byLabel(texto) {
    const t = texto.toLowerCase();
    const labels = Array.from(document.querySelectorAll('label, th, td, span, div'));
    for (const l of labels) {
      if ((l.textContent || '').toLowerCase().includes(t)) {
        const forId = l.getAttribute && l.getAttribute('for');
        if (forId) { const el = document.getElementById(forId); if (el) return el; }
        const near = l.parentElement && l.parentElement.querySelector('input,select,textarea');
        if (near) return near;
      }
    }
    return null;
  }
  // Fallback: tenta uma LISTA de termos de rótulo (vocabulário do eproc).
  function byAnyLabel(termos) {
    for (const t of (termos || [])) { const el = byLabel(t); if (el) return el; }
    return null;
  }
  // Acha um botão/input clicável cujo value/texto contenha um dos termos.
  function acharBotao(termos) {
    const cands = Array.from(document.querySelectorAll(
      'input[type="submit"],input[type="button"],button,a[href]'));
    for (const termo of (termos || [])) {
      const t = String(termo).toLowerCase();
      for (const el of cands) {
        const txt = ((el.value || '') + ' ' + (el.textContent || '') + ' ' + (el.title || '')).toLowerCase();
        if (txt.includes(t)) return el;
      }
    }
    return null;
  }
  function setSelectByText(sel, texto) {
    if (!sel || !texto) return false;
    const alvo = String(texto).toLowerCase();
    for (const opt of Array.from(sel.options || [])) {
      if ((opt.textContent || '').toLowerCase().includes(alvo)) {
        sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true;
      }
    }
    return false;
  }
  function destacar(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline = '3px solid #C9A961';
    el.style.boxShadow = '0 0 0 4px rgba(201,169,97,.35)';
  }

  // ── painel flutuante ────────────────────────────────────────────────────────
  function painel() {
    let p = document.getElementById('cobrasq-eproc-panel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'cobrasq-eproc-panel';
    p.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;width:320px;' +
      'background:#fff;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);' +
      'font:13px/1.45 system-ui,Arial,sans-serif;color:#1a1a1a;overflow:hidden;';
    p.innerHTML = `
      <div style="background:#0c2340;color:#fff;padding:10px 12px;font-weight:600;display:flex;justify-content:space-between;align-items:center;">
        <span>Cobrasq · Peticionador eproc</span>
        <span id="cb-close" style="cursor:pointer;opacity:.8;">✕</span>
      </div>
      <div id="cb-body" style="padding:12px;"></div>`;
    document.body.appendChild(p);
    p.querySelector('#cb-close').onclick = () => p.remove();
    return p;
  }
  function setBody(html) { painel().querySelector('#cb-body').innerHTML = html; }
  function msg(t, cor) { return `<div style="padding:6px 8px;border-radius:6px;background:${cor || '#f1f3f5'};margin-bottom:8px;">${t}</div>`; }

  // ── fluxo de preenchimento ──────────────────────────────────────────────────
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

  async function preencher(job) {
    jobAtual = job;
    setBody(msg('Preenchendo o processo <b>' + (job.numero_processo || '') + '</b>…'));

    // 1) Claim atômico no app (evita protocolar 2x).
    const claim = await chrome.runtime.sendMessage({ type: 'CLAIM', id: job.id });
    if (claim && claim.error) {
      setBody(msg('Não foi possível reservar este job: ' + claim.error, '#ffe3e3'));
      return;
    }

    const erros = [];

    // 2) Tipo de Documento / Tipo de Petição / evento (rótulos reais do eproc TJPR).
    const selTipo = qFirst(SEL.tipoDocumento) || byAnyLabel(TXT.tipoDocumento);
    if (selTipo && job.evento_eproc) { if (!setSelectByText(selTipo, job.evento_eproc)) erros.push('tipo de documento "' + job.evento_eproc + '" não encontrado na lista'); }
    else if (!selTipo) erros.push('campo "Tipo de Documento" não localizado nesta etapa');

    // 3) Anexar PDF (etapa "Documentos" / "Anexar Documento").
    try {
      const inputFile = qFirst(SEL.anexoPdf) || byAnyLabel(TXT.anexo);
      if (!inputFile) { erros.push('campo de anexo (input file) não localizado nesta etapa'); }
      else if (job.pdf_url) {
        const file = await baixarPdfComoFile(job.pdf_url, 'peticao_' + (job.numero_processo || '') + '.pdf');
        anexarArquivo(inputFile, file);
      } else { erros.push('job sem PDF'); }
    } catch (e) { erros.push(String(e.message || e)); }

    // 4) Localiza o botão FINAL (Finalizar/Peticionar/Protocolar/Confirmar) e o de
    //    AVANÇAR etapa (Próxima). Destaca o que existir — NUNCA clica.
    const btnFinal = qFirst(SEL.botaoFinal) || acharBotao(TXT.final);
    const btnAvancar = qFirst(SEL.botaoAvancar) || acharBotao(TXT.avancar);
    destacar(btnFinal || btnAvancar);
    if (!btnFinal && btnAvancar) {
      erros.push('esta é uma etapa intermediária do assistente (botão "Próxima") — avance até a etapa final de documentos para protocolar');
    } else if (!btnFinal && !btnAvancar) {
      erros.push('botão de protocolo/avanço não localizado');
    }

    // 5) Painel: revisão humana + confirmação do protocolo.
    const labelBotao = btnFinal ? ((btnFinal.value || btnFinal.textContent || 'Finalizar').trim()) : 'Próxima';
    setBody(
      (erros.length ? msg('⚠️ Revise manualmente: <br>• ' + erros.join('<br>• '), '#fff3bf') : msg('✓ Preenchido. Revise e clique <b>' + labelBotao + '</b> no eproc.', '#d3f9d8')) +
      `<div style="margin-top:6px;">Depois de protocolar, cole o <b>nº do protocolo</b>:</div>
       <input id="cb-protocolo" placeholder="nº do protocolo" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;margin:6px 0;">
       <div style="display:flex;gap:6px;">
         <button id="cb-done" style="flex:1;padding:8px;border:0;border-radius:6px;background:#0c2340;color:#fff;cursor:pointer;">Confirmar protocolo</button>
         <button id="cb-err" style="padding:8px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;">Erro</button>
       </div>`
    );
    const body = painel().querySelector('#cb-body');
    body.querySelector('#cb-done').onclick = async () => {
      const num = (body.querySelector('#cb-protocolo').value || '').trim();
      const r = await chrome.runtime.sendMessage({ type: 'DONE', id: job.id, protocolo_num: num });
      setBody(r && r.ok ? msg('✓ Registrado no app. Protocolo: ' + (num || '(sem nº)'), '#d3f9d8') : msg('Falha ao registrar: ' + (r && r.error), '#ffe3e3'));
    };
    body.querySelector('#cb-err').onclick = async () => {
      await chrome.runtime.sendMessage({ type: 'REPORT_ERROR', id: job.id, erro: erros.join('; ') || 'erro manual' });
      setBody(msg('Marcado como erro no app. Você pode re-preparar a petição.', '#fff3bf'));
    };
  }

  // ── recebe o job do popup ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m.type === 'FILL_JOB') {
      preencher(m.job).catch(e => setBody(msg('Erro: ' + (e.message || e), '#ffe3e3')));
      send({ ok: true });
    }
    return true;
  });
})();
