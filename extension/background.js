// extension/background.js — Service worker (MV3).
// Centraliza: (1) guardar o token de sessão Supabase recebido do app, (2) falar
// com o endpoint api/eproc-peticionamento (buscar jobs, reportar resultado).
//
// Não guarda senha/MFA do eproc — só o token do app (mesma sessão do usuário),
// em chrome.storage.session (some ao fechar o navegador).

const API_BASE = 'https://cobrasq-faturamento.vercel.app';

async function getToken() {
  const { token } = await chrome.storage.session.get('token');
  return token || null;
}

async function apiGetJobs() {
  const token = await getToken();
  if (!token) return { error: 'sem_sessao' };
  const r = await fetch(`${API_BASE}/api/eproc-peticionamento?status=preparado`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: j.error || ('HTTP ' + r.status) };
  return j; // { ok, jobs }
}

async function apiReport(payload) {
  const token = await getToken();
  if (!token) return { error: 'sem_sessao' };
  const r = await fetch(`${API_BASE}/api/eproc-peticionamento`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: j.error || ('HTTP ' + r.status) };
  return j;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'SET_TOKEN') {
        if (msg.token) await chrome.storage.session.set({ token: msg.token });
        sendResponse({ ok: true });
      } else if (msg.type === 'HAS_TOKEN') {
        sendResponse({ ok: true, hasToken: !!(await getToken()) });
      } else if (msg.type === 'GET_JOBS') {
        sendResponse(await apiGetJobs());
      } else if (msg.type === 'CLAIM') {
        sendResponse(await apiReport({ id: msg.id, action: 'claim' }));
      } else if (msg.type === 'DONE') {
        sendResponse(await apiReport({ id: msg.id, action: 'done', protocolo_num: msg.protocolo_num }));
      } else if (msg.type === 'REPORT_ERROR') {
        sendResponse(await apiReport({ id: msg.id, action: 'error', erro: msg.erro }));
      } else if (msg.type === 'FETCH_PDF') {
        // Baixa o PDF da signed URL (Supabase) aqui no worker — host_permissions
        // evita problema de CORS no content script do eproc.
        const r = await fetch(msg.url);
        if (!r.ok) { sendResponse({ error: 'HTTP ' + r.status }); return; }
        const buf = await r.arrayBuffer();
        let bin = ''; const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        sendResponse({ ok: true, base64: btoa(bin) });
      } else {
        sendResponse({ error: 'tipo desconhecido' });
      }
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true; // resposta assíncrona
});
