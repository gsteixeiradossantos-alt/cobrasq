// extension/content-app.js — roda no origin do app Cobrasq.
// Lê o token de sessão Supabase do localStorage (mesma sessão que o usuário já
// usa no app) e o envia ao background. Assim a extensão fala com a API como o
// próprio usuário, SEM nunca pedir/guardar senha.
//
// O supabase-js v2 guarda a sessão numa chave `sb-<ref>-auth-token`. Lemos
// qualquer chave que case com esse padrão (robusto a mudança de ref).

(function () {
  function lerToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !/^sb-.*-auth-token$/.test(k)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const obj = JSON.parse(raw);
        // Formatos possíveis: { access_token } ou { currentSession: { access_token } }
        const tok = obj?.access_token || obj?.currentSession?.access_token;
        if (tok) return tok;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function enviar() {
    const token = lerToken();
    if (token) {
      try { chrome.runtime.sendMessage({ type: 'SET_TOKEN', token }); } catch (_) {}
    }
  }

  enviar();
  // Reenvia em foco (renovação de sessão) — best-effort.
  window.addEventListener('focus', enviar);
})();
