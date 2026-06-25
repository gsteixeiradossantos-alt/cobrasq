// api/cron-regua.js — Executa réguas de cobrança diariamente.
// Processa:
//   1. reguaCobranca  — pré-acordo (para cada devedor não-quitado, sem acordo ativo)
//   2. reguaAcordo    — pós-acordo (para cada parcela em aberto de acordos ativos)
//
// Configurado em vercel.json como cron job (default: 12:00 UTC = 09:00 BRT).
// Invocação manual: GET /api/cron-regua?dry=1  → dry-run sem enviar
//
// Mudança Fase C (B4): a idempotência (sabe se um passo já foi enviado)
// passou de _reguaEnviados dentro do JSONB para a tabela `regua_envios`.
// Antes: cron fazia PATCH no cobrasq_data inteiro depois de cada run, podendo
// sobrescrever edições simultâneas do usuário.
// Agora: leituras do JSONB são read-only; gravações vão pra `regua_envios`
// (idempotência) e `audit_logs` (histórico). Migração de marcas legadas:
// se a tabela `regua_envios` está vazia mas existe `_reguaEnviados` no JSONB,
// faz back-fill no primeiro run.

const SB_URL = process.env.SUPABASE_URL || '';
// Padronizado para SUPABASE_SERVICE_ROLE_KEY; mantém fallback retrocompat.
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

async function sbFetch(path, opts) {
  if (!SB_URL || !SB_KEY) {
    const missing = [];
    if (!SB_URL) missing.push('SUPABASE_URL');
    if (!SB_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    throw new Error('Supabase não configurado no servidor — variáveis ausentes: ' + missing.join(', '));
  }
  const r = await fetch(`${SB_URL.replace(/\/+$/, '')}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer': 'return=representation',
      ...(opts?.headers || {}),
    },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Supabase ${path}: ${r.status} — ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

function renderTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : ''));
}

function parseValorBR(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return isFinite(n) ? n : 0;
}

function fmtR(v) {
  const n = +v || 0;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function diasDesde(dataStr) {
  if (!dataStr) return 0;
  const d = new Date(dataStr);
  if (isNaN(d)) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function diasAte(dataStr) {
  if (!dataStr) return 0;
  const d = new Date(dataStr);
  if (isNaN(d)) return 0;
  return Math.floor((d.getTime() - Date.now()) / 86400000);
}

const { sendEmail, emailDisponivel } = require('./_email.js');
const { sendSms, smsDisponivel } = require('./_sms.js');

// Canal disponível? Permite à régua PULAR o passo sem reivindicar envio quando o canal
// não tem provedor configurado (e-mail sem RESEND_API_KEY, SMS sem gateway).
function canalDisponivel(canal) {
  if (canal === 'email') return emailDisponivel();
  if (canal === 'sms') return smsDisponivel();
  if (canal === 'ligacao') return false; // sem ligação automática (decisão do usuário)
  return true; // whatsapp (default)
}

// Dispatch por canal. mensagem é o corpo renderizado; e-mail usa assunto.
async function enviarPorCanal(canal, { tel, email, mensagem, assunto }) {
  if (canal === 'email') {
    if (!email) throw new Error('sem e-mail');
    return await sendEmail({ to: email, subject: assunto || 'Cobrasq', text: mensagem });
  }
  if (canal === 'sms') return await sendSms(tel, mensagem);
  return await zapiSendText(tel, mensagem); // whatsapp
}

async function zapiSendText(phone, message) {
  const token    = process.env.ZAPI_TOKEN || '';
  const instance = process.env.ZAPI_INSTANCE_ID || '';
  const clientTk = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!token || !instance) throw new Error('Z-API não configurada');
  const url = `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (clientTk) headers['Client-Token'] = clientTk;
  // Normaliza p/ o formato que a Z-API espera (DDI 55), igual ao waTel55 do front.
  let fone = String(phone).replace(/\D/g, '');
  if (fone && fone.length <= 11 && !fone.startsWith('55')) fone = '55' + fone;
  const r = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ phone: fone, message }),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Z-API HTTP ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

function devTelefone(dev) {
  return (dev.tel || dev.telefone || '').replace(/\D/g, '');
}

function devLinkPortal() {
  return process.env.PORTAL_URL || '';
}

function acordoAtivo(ac) {
  return ac && (ac.status === 'ativo' || (ac.parcelas || []).some(p => !p.pago));
}

// ── Idempotência: lookup/registro em regua_envios ───────────────
// Set<string> com chave "tipo|devedor|parcela|step" pra evitar 1 select por step.
async function loadJaEnviados(devIds) {
  if (!devIds.length) return new Set();
  // PostgREST não aceita filtros muito longos; chunkar em blocos de 100.
  const set = new Set();
  for (let i = 0; i < devIds.length; i += 100) {
    const chunk = devIds.slice(i, i + 100).map(encodeURIComponent).join(',');
    const rows = await sbFetch(
      `regua_envios?select=tipo,devedor_id,parcela_id,step_key&devedor_id=in.(${chunk})&status=eq.sent`
    );
    for (const r of rows) {
      set.add(`${r.tipo}|${r.devedor_id}|${r.parcela_id || ''}|${r.step_key}`);
    }
  }
  return set;
}

function jaEnviadoKey(tipo, devId, parcelaId, stepKey) {
  return `${tipo}|${devId}|${parcelaId || ''}|${stepKey}`;
}

async function registrarEnvio({ tipo, devedorId, parcelaId, stepKey, canal, status, error }) {
  try {
    await sbFetch('regua_envios', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        tipo, devedor_id: devedorId,
        parcela_id: parcelaId || '',
        step_key: stepKey, canal,
        status: status || 'sent',
        error: error || null,
      }),
    });
  } catch (e) {
    console.warn('[regua_envios] insert falhou:', e.message);
  }
}

// ── F-10: claim idempotente ANTES do envio (anti double-send) ───────────────
// Antes o cron ENVIAVA o WhatsApp e SÓ DEPOIS gravava a marca em regua_envios.
// Em runs sobrepostos (cron + disparo manual, ou run que passa de 24h) os dois
// liam regua_envios sem a marca, ambos enviavam e só então gravavam -> o devedor
// recebia a mesma mensagem 2x. Agora invertemos: reivindicamos a vaga ANTES de
// enviar. A unique key (tipo,devedor_id,parcela_id,step_key) garante UM vencedor.
//
// claimEnvio insere status='sending' com resolution=ignore-duplicates: quem
// efetivamente inseriu recebe a linha de volta (return=representation); o
// concorrente recebe [] e NÃO envia. Em qualquer dúvida (erro), retornamos false
// -> preferimos NÃO enviar a arriscar duplicar.
async function claimEnvio({ tipo, devedorId, parcelaId, stepKey, canal }) {
  try {
    const rows = await sbFetch('regua_envios', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        tipo, devedor_id: devedorId,
        parcela_id: parcelaId || '',
        step_key: stepKey, canal,
        status: 'sending',
      }),
    });
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn('[regua_envios] claim falhou:', e.message);
    return false; // fail-safe: na dúvida NÃO envia
  }
}

function _enviosKeyQuery({ tipo, devedorId, parcelaId, stepKey }) {
  return 'regua_envios'
    + `?tipo=eq.${encodeURIComponent(tipo)}`
    + `&devedor_id=eq.${encodeURIComponent(devedorId)}`
    + `&parcela_id=eq.${encodeURIComponent(parcelaId || '')}`
    + `&step_key=eq.${encodeURIComponent(stepKey)}`
    + `&status=eq.sending`;
}

// Envio confirmado: promove a marca de 'sending' -> 'sent' (vira idempotência
// definitiva; loadJaEnviados só conta 'sent').
async function confirmarEnvio({ tipo, devedorId, parcelaId, stepKey }) {
  try {
    await sbFetch(_enviosKeyQuery({ tipo, devedorId, parcelaId, stepKey }), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'sent' }),
    });
  } catch (e) {
    console.warn('[regua_envios] confirmar falhou:', e.message);
  }
}

// Envio falhou: libera o claim (remove a linha 'sending' que ESTA run criou)
// para que o próximo run possa tentar de novo — preserva o retry-on-failure que
// já existia, sem nunca duplicar. DELETE pontual da própria reserva, não em massa.
async function liberarEnvio({ tipo, devedorId, parcelaId, stepKey }) {
  try {
    await sbFetch(_enviosKeyQuery({ tipo, devedorId, parcelaId, stepKey }), {
      method: 'DELETE',
      headers: { 'Prefer': 'return=minimal' },
    });
  } catch (e) {
    console.warn('[regua_envios] liberar claim falhou:', e.message);
  }
}

// Back-fill único: na primeira run, popula regua_envios a partir do
// _reguaEnviados que ficou no JSONB. Idempotente (insert ON CONFLICT DO NOTHING
// é simulado por `resolution=ignore-duplicates`).
async function backfillSeNecessario(devedores) {
  let backfilled = 0;
  // Conta rápida (HEAD) — se já tem qualquer linha, pula
  let rows;
  try { rows = await sbFetch('regua_envios?select=id&limit=1'); }
  catch { rows = []; }
  if (Array.isArray(rows) && rows.length > 0) return 0;

  for (const dev of devedores) {
    const enviadosCob = Array.isArray(dev._reguaEnviados) ? dev._reguaEnviados : [];
    for (const stepKey of enviadosCob) {
      await registrarEnvio({ tipo: 'cobranca', devedorId: String(dev.id), parcelaId: '', stepKey, canal: 'whatsapp' });
      backfilled++;
    }
    for (const ac of (dev.acordos || [])) {
      for (const p of (ac.parcelas || [])) {
        const enviadosPar = Array.isArray(p._reguaEnviados) ? p._reguaEnviados : [];
        for (const stepKey of enviadosPar) {
          await registrarEnvio({ tipo: 'acordo', devedorId: String(dev.id), parcelaId: String(p.id || p.numero || ''), stepKey, canal: 'whatsapp' });
          backfilled++;
        }
      }
    }
  }
  return backfilled;
}

// ── B7: processa cleanup de eventos do Google Calendar pendentes ─
async function processarCalendarPendingDeletes() {
  const out = { tentados: 0, removidos: 0, falhas: 0 };
  let rows;
  try { rows = await sbFetch('calendar_events_sync?select=id,user_id,google_event_id&pending_delete=eq.true&deleted_at=is.null&limit=200'); }
  catch (e) { console.warn('[calendar] list pendentes:', e.message); return out; }
  if (!Array.isArray(rows) || rows.length === 0) return out;

  const allowedOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.PORTAL_URL || '');
  for (const row of rows) {
    out.tentados++;
    try {
      const r = await fetch(`${SB_URL.replace(/\/+$/, '')}/functions/v1/google-calendar-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SB_KEY}`,
          'apikey': SB_KEY,
          ...(allowedOrigin ? { 'Origin': allowedOrigin } : {}),
        },
        body: JSON.stringify({ action: 'delete', eventId: row.google_event_id }),
      });
      if (!r.ok && r.status !== 404 && r.status !== 410) {
        const t = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      // 404/410: já não existe no Google — considera ok.
      await sbFetch(`calendar_events_sync?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ deleted_at: new Date().toISOString() }),
      });
      out.removidos++;
    } catch (e) {
      out.falhas++;
      console.warn(`[calendar] delete event ${row.google_event_id}:`, e.message);
    }
  }
  return out;
}

// PR7: notificações pessoais de CONTAS A PAGAR PRÓPRIAS. Avisa o gestor (WhatsApp +
// e-mail) sobre despesas de fin_lancamento vencendo/atrasadas e ainda não pagas, até
// que o pagamento seja confirmado. Destino: CONTAS_PAGAR_PHONE/CONTAS_PAGAR_EMAIL
// (ou DB.config.contasPagarTelefone/Email). Roda no cron diário (uma msg-resumo/dia).
async function processarContasPagarProprias(DB) {
  const out = { vencendo: 0, notificado: false, canais: [] };
  const hoje = new Date().toISOString().slice(0, 10);
  let rows;
  try {
    rows = await sbFetch(
      `fin_lancamento?select=id,descricao,valor,data_vencimento,status` +
      `&tipo_movimento=eq.0&status=in.(0,2)&data_vencimento=lte.${hoje}` +
      `&order=data_vencimento.asc&limit=100`
    );
  } catch (e) { return { ...out, error: e.message }; }
  if (!Array.isArray(rows) || rows.length === 0) return out;
  out.vencendo = rows.length;

  const destTel = String(process.env.CONTAS_PAGAR_PHONE || DB.config?.contasPagarTelefone || '').replace(/\D/g, '');
  const destEmail = process.env.CONTAS_PAGAR_EMAIL || DB.config?.contasPagarEmail || '';
  if (!destTel && !destEmail) return { ...out, skipped: 'sem destino (CONTAS_PAGAR_PHONE/EMAIL)' };

  const linhas = rows.map(r => {
    const venc = String(r.data_vencimento || '').split('-').reverse().join('/');
    const atras = (r.data_vencimento && r.data_vencimento < hoje) ? ' (atrasada)' : '';
    return `• ${r.descricao || '—'} — ${fmtR(Math.abs(Number(r.valor)) || 0)} — vence ${venc}${atras}`;
  });
  const total = rows.reduce((s, r) => s + Math.abs(Number(r.valor) || 0), 0);
  const corpo = `Contas a pagar (vencendo/atrasadas) — ${rows.length} item(ns), total ${fmtR(total)}:\n\n` +
    `${linhas.join('\n')}\n\nConfirme o pagamento no sistema para parar os lembretes.`;

  try { if (destTel) { await zapiSendText(destTel, '🔔 ' + corpo); out.canais.push('whatsapp'); } }
  catch (e) { out.whatsapp_error = e.message; }
  try { if (destEmail && emailDisponivel()) { await sendEmail({ to: destEmail, subject: 'Cobrasq — Contas a pagar', text: corpo }); out.canais.push('email'); } }
  catch (e) { out.email_error = e.message; }
  out.notificado = out.canais.length > 0;
  return out;
}

// ── Fase 3 (sombra) — fonte relacional da lista de devedores ────────
// Hoje a régua lê os devedores do blob `cobrasq_data` (DB.devedores). A cura da
// Fase 3 é ler do relacional: `cobrancas` é a fonte única pós-Fase C. Esta função
// monta a lista no MESMO formato que a régua consome, a partir de `cobrancas` + o
// devedor principal (via cobranca_partes), mantendo o MESMO id (= caso) — então a
// idempotência de `regua_envios` (chave por devedor_id) segue valendo na troca.
// Só é usada quando REGUA_SOURCE=relacional (env) ou ?source=relacional (query);
// o default continua o blob, sem mudança de comportamento.
// A metade PÓS-ACORDO fica DEFERIDA (acordos:[]): hoje é no-op (0 passos de acordo
// e 0 parcelas no relacional) — espelha o blob, que também tem 0 acordos.
async function carregarDevedoresRelacional() {
  const sel = [
    'id', 'status', 'arquivado', 'is_draft', 'valor_orig', 'valor_atual',
    'vencimento', 'data_entrada', 'created_at', 'divida', 'metadata',
    'partes:cobranca_partes(principal,devedor:devedores(nome,doc,telefone,email))',
  ].join(',');
  const rows = await sbFetch(`cobrancas?select=${encodeURIComponent(sel)}&arquivado=eq.false&is_draft=eq.false&limit=5000`);
  if (!Array.isArray(rows)) return [];
  return rows.map((co) => {
    const partes = Array.isArray(co.partes) ? co.partes : [];
    const parte = partes.find((p) => p && p.principal) || partes[0] || null;
    const d = (parte && parte.devedor) ? parte.devedor : {};
    const div = co.divida || {};
    const meta = co.metadata || {};
    // Mesma lógica de COALESCE da view `casos`, p/ máxima paridade com o blob.
    const valorAtual = co.valor_atual != null ? co.valor_atual
                     : (div.totalAvista != null ? div.totalAvista : div.valorAtual);
    const valorOrig = co.valor_orig != null ? co.valor_orig
                    : (div.valorOriginal != null ? div.valorOriginal
                    : (div.valor_original != null ? div.valor_original : div.totalAvista));
    const vencimento = co.vencimento || div.vencimento || meta.vencimento || '';
    return {
      id: co.id,
      nome: d.nome || '',
      doc: d.doc || '',
      tel: d.telefone || '',
      email: d.email || '',
      status: co.status || '',
      arquivado: !!co.arquivado,
      vencimento,
      entrada: co.data_entrada || '',
      createdAt: co.created_at || '',
      valorAtual,
      valorOrig,
      acordos: [],
    };
  });
}

// ── Fase 3 (sombra) — comparação de fontes (read-only) ──────────────
// Diff entre a lista "ativos" do blob e do relacional, com o MESMO filtro que a
// régua aplica (não-arquivado e status fora da lista de exclusão). Não envia e
// não grava nada — só para conferir a paridade antes do cutover de fonte.
// `somente_no_blob`  = casos que SAIRIAM da régua ao trocar p/ relacional.
// `somente_no_relacional` = casos que ENTRARIAM na régua.
function _ativosRegua(arr) {
  const excl = ['Quitado', 'Recebido', 'Devolvida', 'Sem êxito'];
  return (Array.isArray(arr) ? arr : []).filter((d) => !d.arquivado && !excl.includes(d.status));
}
function compararFontes(blobDevs, relDevs) {
  const idNome = (arr) => {
    const m = new Map();
    for (const d of (Array.isArray(arr) ? arr : [])) m.set(String(d.id || ''), d.nome || '');
    return m;
  };
  const nb = idNome(blobDevs);
  const nr = idNome(relDevs);
  const idsBlob = new Set(_ativosRegua(blobDevs).map((d) => String(d.id || '')));
  const idsRel = new Set(_ativosRegua(relDevs).map((d) => String(d.id || '')));
  const somenteBlob = [...idsBlob].filter((id) => !idsRel.has(id)).map((id) => ({ id, nome: nb.get(id) || '' }));
  const somenteRel = [...idsRel].filter((id) => !idsBlob.has(id)).map((id) => ({ id, nome: nr.get(id) || '' }));
  const emAmbos = [...idsBlob].filter((id) => idsRel.has(id)).length;
  return {
    blob_ativos: idsBlob.size,
    relacional_ativos: idsRel.size,
    em_ambos: emAmbos,
    somente_no_blob: somenteBlob,
    somente_no_relacional: somenteRel,
  };
}

module.exports = async function handler(req, res) {
  // F-09: autenticação forte de cron. Antes aceitava um bypass por user-agent
  // (/vercel-cron/i), que é trivialmente forjável -> qualquer um disparava a
  // régua (envio de WhatsApp em massa). Agora exige o segredo e falha fechado
  // se ele não estiver configurado no servidor.
  // Aceita o segredo via header x-cron-secret, querystring ?secret=, ou o
  // header Authorization: Bearer <segredo> (formato padrão do cron do Vercel).
  const expect = process.env.CRON_SECRET || '';
  if (!expect) {
    return res.status(500).json({ error: 'CRON_SECRET não configurado no servidor.' });
  }
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const secret = req.headers['x-cron-secret'] || req.query?.secret || bearer || '';
  // Comparação em tempo constante: o === simples vaza por timing quanto do
  // segredo já bateu. O hash iguala os tamanhos antes do timingSafeEqual.
  const crypto = require('crypto');
  const got = crypto.createHash('sha256').update(String(secret)).digest();
  const exp = crypto.createHash('sha256').update(String(expect)).digest();
  if (!crypto.timingSafeEqual(got, exp)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  try {
    // Leitura única do JSONB (read-only — não fazemos mais PATCH dele)
    const rows = await sbFetch(`cobrasq_data?key=eq.main&select=data,updated_at`);
    if (!rows || rows.length === 0) {
      return res.status(200).json({ ok: true, msg: 'cobrasq_data vazia.' });
    }
    const DB = rows[0].data || {};
    const blobDevedores = Array.isArray(DB.devedores) ? DB.devedores : [];

    // Fase 3 (sombra) — modo comparação read-only: diff blob × relacional, SEM
    // enviar e SEM gravar. Use /api/cron-regua?compare=1 (com o segredo) p/ conferir
    // a paridade antes de virar a fonte padrão (cutover).
    if (req.query?.compare === '1' || req.query?.compare === 'true') {
      let relForCompare = [];
      let erroRelacional = null;
      try { relForCompare = await carregarDevedoresRelacional(); }
      catch (e) { erroRelacional = e.message; }
      return res.status(200).json({
        ok: true, modo: 'compare',
        erro_relacional: erroRelacional,
        ...compararFontes(blobDevedores, relForCompare),
      });
    }

    // Fase 3 (sombra) — fonte da lista de devedores. Default = blob (comportamento
    // inalterado). Relacional só quando explicitamente pedido (?source=relacional)
    // ou via env REGUA_SOURCE=relacional. O id é o MESMO (=caso) nas duas fontes,
    // então a idempotência de regua_envios continua válida na troca.
    const sourceParam = String(req.query?.source || '').toLowerCase();
    const reguaSource = (sourceParam === 'relacional' || sourceParam === 'blob') ? sourceParam
                      : (String(process.env.REGUA_SOURCE || '').toLowerCase() === 'relacional' ? 'relacional' : 'blob');

    // PR7: contas a pagar próprias — independe da régua de cobrança estar ativa.
    const contasPagar = dry ? null : await processarContasPagarProprias(DB);

    if (DB.config?.reguaAtiva === false) {
      const calendarStats = dry ? null : await processarCalendarPendingDeletes();
      return res.status(200).json({ ok: true, msg: 'Régua pausada globalmente.', calendar: calendarStats, contasPagar });
    }

    const reguaCobranca = Array.isArray(DB.config?.reguaCobranca) ? DB.config.reguaCobranca
                       : Array.isArray(DB.config?.regraCobranca) ? DB.config.regraCobranca : [];
    const reguaAcordo   = Array.isArray(DB.config?.reguaAcordo) ? DB.config.reguaAcordo : [];

    if (reguaCobranca.length === 0 && reguaAcordo.length === 0) {
      const calendarStats = dry ? null : await processarCalendarPendingDeletes();
      return res.status(200).json({ ok: true, msg: 'Nenhum passo configurado em nenhuma régua.', calendar: calendarStats, contasPagar });
    }

    const credor = DB.config?.empresa || 'COBRASQ';
    const link = devLinkPortal();
    const devedores = reguaSource === 'relacional' ? await carregarDevedoresRelacional() : blobDevedores;
    const ativos = devedores.filter(d => !d.arquivado && !['Quitado', 'Recebido', 'Devolvida', 'Sem êxito'].includes(d.status));

    // Back-fill de marcas legadas, se for o caso (uma vez só). SEMPRE a partir do
    // blob — é lá que viviam as marcas _reguaEnviados (e a tabela já está populada,
    // então na prática isto é no-op idempotente).
    const backfilled = dry ? 0 : await backfillSeNecessario(blobDevedores);

    // Pré-carrega "já enviados" de todos os devedores ativos numa única query
    const devIds = ativos.map(d => String(d.id || ''));
    const jaEnviados = await loadJaEnviados(devIds);

    const resultado = {
      processados: ativos.length,
      source: reguaSource,
      enviados_cobranca: 0,
      enviados_acordo:   0,
      falhas: 0,
      dry,
      backfilled,
      itens: []
    };

    // ========== RÉGUA A — PRÉ-ACORDO (devedores sem acordo ativo) ==========
    for (const dev of ativos) {
      const temAcordoAtivo = (dev.acordos || []).some(acordoAtivo);
      if (temAcordoAtivo) continue;

      const baseData = dev.vencimento || dev.entrada || (dev.createdAt ? dev.createdAt.split('T')[0] : '');
      const dias = diasDesde(baseData);
      if (dias < 0) continue;

      const tel = devTelefone(dev);
      const valor = parseValorBR(dev.valorAtual) || parseValorBR(dev.valorOrig) || 0;
      const devId = String(dev.id || '');

      for (const step of reguaCobranca) {
        const stepKey = step.id || `${step.dias}_${step.canal}`;
        if (dias < (step.dias || 0)) continue;
        if (jaEnviados.has(jaEnviadoKey('cobranca', devId, '', stepKey))) continue;
        const canal = step.canal || 'whatsapp';
        if (!canalDisponivel(canal)) {
          resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, skipped: `canal ${canal} indisponível` });
          continue;
        }
        const dest = canal === 'email' ? (dev.email || '') : tel;
        if (!dest) { resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, skipped: `sem ${canal === 'email' ? 'e-mail' : 'telefone'}` }); continue; }

        const msg = renderTemplate(step.template, {
          nome: dev.nome || '', valor: fmtR(valor), doc: dev.doc || '',
          dias: String(dias), vencimento: baseData, link, credor
        });
        // F-10: reivindica a vaga ANTES de enviar. Se outro run já reivindicou,
        // não envia (evita WhatsApp duplicado em runs sobrepostos).
        if (!dry) {
          const claimed = await claimEnvio({ tipo: 'cobranca', devedorId: devId, parcelaId: '', stepKey, canal });
          if (!claimed) {
            resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, skipped: 'já reivindicado (concorrência/duplicado)' });
            continue;
          }
        }
        try {
          if (!dry) await enviarPorCanal(canal, { tel, email: dev.email, mensagem: msg, assunto: 'Cobrasq — Cobrança' });
          if (!dry) await confirmarEnvio({ tipo: 'cobranca', devedorId: devId, parcelaId: '', stepKey });
          jaEnviados.add(jaEnviadoKey('cobranca', devId, '', stepKey)); // evita reenvio na mesma run
          resultado.enviados_cobranca++;
          resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, status: dry ? 'dry' : 'sent' });
        } catch (e) {
          resultado.falhas++;
          if (!dry) await liberarEnvio({ tipo: 'cobranca', devedorId: devId, parcelaId: '', stepKey }); // libera p/ retry no próximo run
          resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, error: e.message });
        }
      }
    }

    // ========== RÉGUA B — PÓS-ACORDO (cada parcela em aberto) ==========
    for (const dev of ativos) {
      const acordos = (dev.acordos || []).filter(acordoAtivo);
      if (acordos.length === 0) continue;
      const tel = devTelefone(dev); // pode ser vazio: passos de e-mail seguem por dev.email
      const devId = String(dev.id || '');

      for (const ac of acordos) {
        const parcelas = (ac.parcelas || []).filter(p => !p.pago);
        for (const p of parcelas) {
          const parcelaId = String(p.id || p.numero || '');
          const diasParaVencer = diasAte(p.vencimento);
          for (const step of reguaAcordo) {
            const stepKey = step.id || `${step.referencia}_${step.dias}_${step.canal}`;
            if (jaEnviados.has(jaEnviadoKey('acordo', devId, parcelaId, stepKey))) continue;
            let disparaHoje = false;
            if (step.referencia === 'antes')  disparaHoje = (diasParaVencer === (step.dias || 0));
            else if (step.referencia === 'no_dia') disparaHoje = (diasParaVencer === 0);
            else if (step.referencia === 'depois') disparaHoje = (diasParaVencer === -(step.dias || 0));
            if (!disparaHoje) continue;
            const canal = step.canal || 'whatsapp';
            if (!canalDisponivel(canal)) {
              resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, skipped: `canal ${canal} indisponível` });
              continue;
            }
            const dest = canal === 'email' ? (dev.email || '') : tel;
            if (!dest) { resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, skipped: `sem ${canal === 'email' ? 'e-mail' : 'telefone'}` }); continue; }

            const msg = renderTemplate(step.template, {
              nome: dev.nome || '', valor: fmtR(parseValorBR(dev.valorAtual) || parseValorBR(dev.valorOrig) || 0),
              doc: dev.doc || '', credor, link,
              dias: String(Math.abs(diasParaVencer)),
              vencimento: p.vencimento || '',
              parcela_num: String(p.numero || ''),
              parcela_total: String(ac.numParc || (ac.parcelas || []).length || ''),
              parcela_valor: fmtR(p.valor || 0),
              parcela_venc: (p.vencimento || '').split('-').reverse().join('/'),
              acordo_total: fmtR(ac.valorTotal || 0),
            });
            // F-10: claim idempotente antes do envio (anti double-send).
            if (!dry) {
              const claimed = await claimEnvio({ tipo: 'acordo', devedorId: devId, parcelaId, stepKey, canal });
              if (!claimed) {
                resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, skipped: 'já reivindicado (concorrência/duplicado)' });
                continue;
              }
            }
            try {
              if (!dry) await enviarPorCanal(canal, { tel, email: dev.email, mensagem: msg, assunto: 'Cobrasq — Acordo' });
              if (!dry) await confirmarEnvio({ tipo: 'acordo', devedorId: devId, parcelaId, stepKey });
              jaEnviados.add(jaEnviadoKey('acordo', devId, parcelaId, stepKey));
              resultado.enviados_acordo++;
              resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, status: dry ? 'dry' : 'sent' });
            } catch (e) {
              resultado.falhas++;
              if (!dry) await liberarEnvio({ tipo: 'acordo', devedorId: devId, parcelaId, stepKey }); // libera p/ retry
              resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, error: e.message });
            }
          }
        }
      }
    }

    // Cleanup de calendar (B7): só fora de dry-run
    const calendar = dry ? null : await processarCalendarPendingDeletes();

    try {
      await sbFetch('audit_logs', {
        method: 'POST',
        body: JSON.stringify({
          action: dry ? 'regua.dry_run' : 'regua.exec',
          entity: 'sistema',
          metadata: {
            source: reguaSource,
            enviados_cobranca: resultado.enviados_cobranca,
            enviados_acordo: resultado.enviados_acordo,
            falhas: resultado.falhas,
            processados: resultado.processados,
            backfilled,
            calendar
          }
        })
      });
    } catch {}

    res.status(200).json({ ok: true, hoje: new Date().toISOString().slice(0,10), ...resultado, calendar, contasPagar });
  } catch (err) {
    console.error('[cron-regua]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
