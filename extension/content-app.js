// extension/content-app.js — roda no origin do app Cobrasq.
// Lê o token de sessão Supabase do localStorage (mesma sessão que o usuário já
// usa no app) e o envia ao background. Assim a extensão fala com a API como o
// próprio usuário, SEM nunca pedir/guardar senha.
//
// O supabase-js v2 guarda a sessão numa chave `sb-<ref>-auth-token`; em versões
// novas o valor pode vir prefixado com "base64-". Lemos os dois formatos.
// Além do envio imediato, re-tentamos por ~30s (login pode acontecer depois do
// carregamento) e no foco da aba. O popup também consegue PUXAR o token
// ativamente (ver popup.js), então esta ponte é só o caminho rápido.

(function () {
  function lerToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !/^sb-.*-auth-token$/.test(k)) continue;
        let raw = localStorage.getItem(k);
        if (!raw) continue;
        if (raw.startsWith('base64-')) {
          try { raw = atob(raw.slice(7).replace(/-/g, '+').replace(/_/g, '/')); } catch (_) { continue; }
        }
        const obj = JSON.parse(raw);
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
      return true;
    }
    return false;
  }

  enviar();
  // Re-tenta por ~30s (caso o login aconteça depois) e a cada foco da aba.
  let tentativas = 0;
  const timer = setInterval(() => { if (enviar() || ++tentativas > 20) clearInterval(timer); }, 1500);
  window.addEventListener('focus', enviar);
})();
