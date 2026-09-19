// extension/content-pje.js — roda no PJe (Processo Judicial Eletrônico), AINDA EM FASE
// DE CALIBRAÇÃO. Este arquivo não preenche formulário, não seleciona tipo de documento,
// não anexa arquivo e não clica em nada do fluxo de peticionamento — só identifica que a
// aba é do PJe e oferece o botão de captura (📋 HTML), para o Gustavo mandar telas reais
// das etapas-chave (busca do processo, petição intercorrente/inicial, seleção de tipo de
// documento, upload, confirmação de protocolo). É o MESMO caminho usado para calibrar o
// Projudi (ver content-projudi.js) — lá, cada guarda fail-closed veio de uma tela real
// que o Gustavo mandou. Aqui ainda não há nenhuma tela real, então não há seletor.
//
// ⚠️ NÃO ADICIONE lógica de preenchimento/clique aqui sem antes calibrar contra uma
// captura real (HTML + contexto de qual tela é). Protocolo é irreversível — construir
// seletores "no escuro" contra o manual do PJe/CNJ arrisca clicar na coisa errada. Ver
// discussão em extension/README.md § PJe.

(function () {
  // Guarda de idempotência (mesmo padrão do content-eproc.js/content-projudi.js): evita
  // 2 cópias rodando no mesmo frame se a Central reinjetar via chrome.scripting.
  if (window.__cobrasqPje) return;
  window.__cobrasqPje = true;

  // Guarda de hostname: família "pje" nos domínios .jus.br (ex.: pje.tjmt.jus.br,
  // pje1g.trf1.jus.br, pje2g.trf3.jus.br — 1º/2º grau costumam vir como pje1g/pje2g).
  // Ajuste esta lista quando soubermos os domínios exatos que o Gustavo usa (TJMT, TRF
  // e o(s) outro(s) TJ em PJe citados por ele) — por ora é propositalmente ampla.
  if (!/^pje[\dg]*\.[\w.-]+\.jus\.br$/i.test(location.hostname)) return;

  // ── Botão de SUPORTE: copia o HTML desta página (+ iframes de mesma origem) pro
  // clipboard, pro Gustavo colar no chat. Igual ao do eproc/Projudi.
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
    let html = '<!-- ===== PAGINA: ' + location.href + ' ===== -->\n' + document.documentElement.outerHTML;
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      try { const d = f.contentDocument; if (d && d.documentElement) html += '\n\n<!-- ===== IFRAME: ' + (f.src || f.id || '(sem src)') + ' ===== -->\n' + d.documentElement.outerHTML; } catch (_) { /* iframe de outra origem */ }
    }
    return html;
  }
  function botaoCapturaSuporte() {
    if (window.top !== window) return; // só no frame principal
    if (document.getElementById('cobrasq-cap-html')) return;
    const b = document.createElement('button');
    b.id = 'cobrasq-cap-html'; b.textContent = '📋 HTML (PJe)';
    b.title = 'Copiar o HTML desta página para enviar ao suporte (Claude) — calibração do PJe';
    b.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#5b2a86;color:#fff;border:0;border-radius:8px;padding:8px 12px;font:12px system-ui,Arial,sans-serif;cursor:pointer;opacity:.8;box-shadow:0 4px 14px rgba(0,0,0,.2);';
    b.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const html = htmlDaPaginaSuporte();
      const ok = await copiarTextoSuporte(html);
      b.textContent = ok ? ('✅ copiado (' + Math.round(html.length / 1024) + ' KB) — cole no chat') : '⚠ não copiou — use o F12';
      setTimeout(() => { b.textContent = '📋 HTML (PJe)'; }, 5000);
    }, true);
    (document.body || document.documentElement).appendChild(b);
  }

  // ── painel flutuante (só avisa e orienta — não participa da fila da Central) ─────
  function painel() {
    if (window.top !== window) return null; // só no frame principal
    let p = document.getElementById('cobrasq-pje-panel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'cobrasq-pje-panel';
    p.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;width:340px;max-height:80vh;overflow:auto;' +
      'background:#fff;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);' +
      'font:13px/1.45 system-ui,Arial,sans-serif;color:#1a1a1a;';
    p.innerHTML =
      '<div style="background:#5b2a86;color:#fff;padding:10px 12px;font-weight:600;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;">' +
      '<span>Cobrasq · PJe <small style="opacity:.7;">calibração</small></span>' +
      '<span id="cb-pje-close" style="cursor:pointer;opacity:.8;">✕</span></div>' +
      '<div style="padding:12px;">' +
      '<div style="padding:6px 8px;border-radius:6px;background:#fff3bf;margin-bottom:8px;">' +
      'PJe detectado — <b>protocolo automático aqui ainda não existe</b>.</div>' +
      '<div style="padding:6px 8px;border-radius:6px;background:#e7f5ff;">' +
      'Pra eu calibrar: em cada tela do fluxo (busca do processo, petição intercorrente/inicial, ' +
      'seleção de tipo de documento, upload de arquivo, confirmação de protocolo), clique no botão ' +
      '<b>📋 HTML (PJe)</b> (canto inferior esquerdo) e cole no chat, junto com um print e dizendo qual ' +
      'tela é. Sem interagir com nada do formulário — só olhar e copiar.</div>' +
      '</div>';
    document.body.appendChild(p);
    p.querySelector('#cb-pje-close').onclick = () => p.remove();
    return p;
  }

  function iniciar() {
    try { botaoCapturaSuporte(); } catch (_) {}
    try { painel(); } catch (_) {}
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') iniciar();
  else document.addEventListener('DOMContentLoaded', iniciar);
})();
