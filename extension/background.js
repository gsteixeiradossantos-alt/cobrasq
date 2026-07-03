// extension/background.js — Service worker (MV3).
// Centraliza: (1) guardar o token de sessão Supabase recebido do app, (2) falar
// com o endpoint api/eproc-peticionamento (buscar jobs, reportar resultado),
// (3) extração por IA via /api/claude (Central de Peticionamento), (4) registro
// do protocolo direto no banco (PostgREST com o token do usuário; RLS aplicada),
// (5) override de confirm()/alert() na página (world MAIN) para o modo auto.
//
// Não guarda senha/MFA do eproc — só o token do app (mesma sessão do usuário),
// em chrome.storage.session (some ao fechar o navegador).

const API_BASE = 'https://painel.cobrasq.com.br';

// Mensagens que pertencem à página da Central (central.js responde/ouve) — o
// background NÃO pode respondê-las, senão vence a corrida do sendResponse.
const TIPOS_DA_CENTRAL = new Set(['PEDIR_DOC', 'CENTRAL_PROGRESS', 'CENTRAL_CASO_OK', 'CENTRAL_PAUSA']);

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

// ── Extração por IA: manda o PDF (base64) ao proxy /api/claude do app ─────────
const PROMPT_EXTRACAO = `Você é assistente de um escritório de cobrança que distribui petições iniciais no eproc TJPR.
Leia a petição inicial anexa e devolva SOMENTE um JSON válido (sem cercas de código, sem comentários) com:
{
 "requerentes": [{"nome": "...", "doc": "CPF ou CNPJ com pontuação, ou null", "endereco": "endereço completo da qualificação (rua, nº, bairro, cidade/UF, CEP) ou null", "email": "e-mail ou null", "telefone": "telefone/celular ou null"}],
 "requeridos":  [{"nome": "...", "doc": "CPF ou CNPJ com pontuação, ou null", "endereco": "endereço completo da qualificação (rua, nº, bairro, cidade/UF, CEP) ou null", "email": "e-mail ou null", "telefone": "telefone/celular ou null"}],
 "valor_causa": 1234.56,
 "comarca": "cidade do foro/comarca indicada no endereçamento",
 "classe": "classe processual (ex.: Procedimento do Juizado Especial Cível)",
 "assuntos": ["assunto CNJ principal, ex.: Perdas e Danos"],
 "competencia": "competência do Juizado se aplicável (ex.: Matéria Residual), senão null",
 "rito": "ex.: Juizado Especial Estadual ou Comum",
 "area": "ex.: Juizado Especial Cível ou Cível",
 "numero_processo": "nº CNJ se a peça citar processo existente, senão null"
}
Se um campo não constar na peça, use null (ou [] em listas). Não invente documentos.`;

async function claudeExtrair(base64Pdf) {
  const token = await getToken();
  if (!token) return { error: 'sem_sessao' };
  const r = await fetch(`${API_BASE}/api/claude`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
          { type: 'text', text: PROMPT_EXTRACAO },
        ],
      }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: (j.error && j.error.message) || ('HTTP ' + r.status) };
  // A resposta vem em BLOCOS (content: [...]) e o texto pode não ser o 1º bloco
  // (modelos com raciocínio emitem um bloco de thinking antes) — junta todos.
  const blocos = (j && j.content) || [];
  const texto = blocos.map(b => (b && b.text) || '').join('');
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'IA não devolveu JSON (parada: ' + (j && j.stop_reason) + '; blocos: ' + (blocos.map(b => b && b.type).join(',') || 'nenhum') + ') ' + texto.slice(0, 120) };
  try { return { ok: true, dados: JSON.parse(m[0]) }; }
  catch (e) { return { error: 'JSON inválido da IA: ' + String(e.message || e) }; }
}

// ── Registro do protocolo no banco (PostgREST com o token; RLS aplicada) ──────
let _cfgCache = null;
async function configSupabase() {
  if (_cfgCache) return _cfgCache;
  const token = await getToken();
  const r = await fetch(`${API_BASE}/api/config`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const j = await r.json().catch(() => ({}));
  const url = j.supabaseUrl || j.url || j.SUPABASE_URL || (j.supabase && j.supabase.url);
  const anon = j.supabaseAnonKey || j.anonKey || j.anon || j.SUPABASE_ANON_KEY || (j.supabase && j.supabase.anonKey);
  if (!url || !anon) return null;
  _cfgCache = { url: String(url).replace(/\/+$/, ''), anon };
  return _cfgCache;
}
async function pgrest(path, opts = {}) {
  const cfg = await configSupabase();
  const token = await getToken();
  if (!cfg || !token) throw new Error('config/sessão indisponível p/ registro');
  const r = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json', apikey: cfg.anon, Authorization: `Bearer ${token}`,
      Prefer: opts.prefer || 'return=representation', ...(opts.headers || {}),
    },
  });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`PostgREST ${path}: ${r.status} — ${typeof d === 'string' ? d : JSON.stringify(d)}`);
  return d;
}
// Grava o protocolo e tenta vincular a cobrança pelo doc do requerido principal
// (invariante do sistema: cobranca.id = id do devedor principal).
async function registrarProtocolo({ numero, caso }) {
  try {
    const digitos = (doc) => String(doc || '').replace(/\D/g, '');
    const tipo = (caso && caso.tipo) || 'inicial';
    const numProcesso = (caso && caso.numero_processo) || numero || null;
    let cobrancaId = null;
    // Intercorrente: o processo já existe — vincula pela cobrança com o mesmo nº.
    if (tipo === 'intercorrente' && numProcesso) {
      try {
        const cobs = await pgrest(`cobrancas?numero_processo=eq.${encodeURIComponent(numProcesso)}&select=id&limit=1`);
        if (Array.isArray(cobs) && cobs[0]) cobrancaId = cobs[0].id;
      } catch (_) { /* sem vínculo: registra mesmo assim */ }
    }
    const reqPrincipal = ((caso && caso.dados || {}).requeridos || [])[0];
    const doc = digitos(reqPrincipal && reqPrincipal.doc);
    if (!cobrancaId && doc) {
      const devs = await pgrest(`devedores?select=id,doc&limit=500`);
      const dev = (Array.isArray(devs) ? devs : []).find(d => digitos(d.doc) === doc);
      if (dev) {
        const cobs = await pgrest(`cobrancas?id=eq.${dev.id}&select=id,numero_processo`);
        if (Array.isArray(cobs) && cobs[0]) {
          cobrancaId = cobs[0].id;
          if (!cobs[0].numero_processo && numero) {
            await pgrest(`cobrancas?id=eq.${cobrancaId}`, {
              method: 'PATCH', prefer: 'return=minimal',
              body: JSON.stringify({ numero_processo: numero, updated_at: new Date().toISOString() }),
            });
          }
        }
      }
    }
    await pgrest('proc_peticionamentos', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        cobranca_id: cobrancaId, devedor_id: cobrancaId, numero_processo: numProcesso,
        tipo, status: 'protocolado', protocolo_num: numero || null,
        protocolado_em: new Date().toISOString(),
        dados_distribuicao: (caso && caso.dados) || null,
      }),
    });
    return { ok: true, cobrancaVinculada: !!cobrancaId };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Override de diálogos nativos na página (modo auto): confirm→true, alert→captura.
async function overrideDialogos(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => {
      if (window.__cbDialogosOk) return;
      window.__cbDialogosOk = true;
      window.confirm = () => true;
      window.alert = (msg) => { window.__cbUltimoAlert = String(msg); try { console.warn('[cobrasq] alert:', msg); } catch (_) {} };
    },
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || TIPOS_DA_CENTRAL.has(msg.type)) return false; // deixa a Central responder/ouvir
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
      } else if (msg.type === 'CLAUDE_EXTRACT') {
        sendResponse(await claudeExtrair(msg.base64));
      } else if (msg.type === 'REGISTRAR_PROTOCOLO') {
        sendResponse(await registrarProtocolo(msg));
      } else if (msg.type === 'OVERRIDE_DIALOGS') {
        const tabId = (sender.tab && sender.tab.id) || msg.tabId;
        if (tabId) { await overrideDialogos(tabId); sendResponse({ ok: true }); }
        else sendResponse({ error: 'sem tabId' });
      } else if (msg.type === 'EXEC_PAGINA') {
        // Executa uma ação NO MUNDO DA PÁGINA (world:'MAIN') no FRAME que pediu —
        // imune ao CSP da página (scripts injetados pela extensão são isentos).
        // Prefere chamar a função global (msg.fn + msg.args); senão avalia msg.code.
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) { sendResponse({ error: 'sem tabId' }); return; }
        try {
          const target = { tabId, world: 'MAIN' };
          if (sender.frameId != null) target.frameIds = [sender.frameId];
          const [res] = await chrome.scripting.executeScript({
            target,
            func: (fn, args, code) => {
              try {
                if (fn && typeof window[fn] === 'function') { window[fn].apply(window, args || []); return true; }
                if (code) { (0, eval)(code); return true; } // eslint-disable-line no-eval
              } catch (e) { return 'erro: ' + (e && e.message || e); }
              return false;
            },
            args: [msg.fn || null, msg.args || [], msg.code || null],
          });
          sendResponse({ ok: true, resultado: res && res.result });
        } catch (e) { sendResponse({ error: String((e && e.message) || e) }); }
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
