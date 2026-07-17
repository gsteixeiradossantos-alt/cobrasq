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
  // R-10: HTTP 200 NÃO garante envio — a Z-API responde 200 com corpo de erro quando a
  // instância está desconectada / número inválido (sem messageId/zaapId). Exige a prova de
  // envio, igual à convenção `zap.messageId` dos demais endpoints; sem ela, lança para cair
  // no catch do chamador → liberarEnvio (retry no próximo run) em vez de marcar 'sent' e
  // nunca mais reenviar a cobrança.
  if (!data || typeof data !== 'object' || !(data.messageId || data.zaapId)) {
    throw new Error(`Z-API sem messageId: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
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

// Fase 3 — status que NÃO entram na régua de COBRANÇA (pré-acordo). Antes só os 4
// terminais (inline). Ampliado porque a fonte relacional EXPÕE casos que no blob
// não apareciam como "ativos": judiciais (cobrança extrajudicial automática não se
// aplica — está com o advogado) e os que já têm acordo (vão p/ a régua de acordo,
// não a de cobrança). É um filtro SÓ-RESTRITIVO: nunca faz enviar a mais, só a menos.
// (Quando a régua de ACORDO for ligada, os 'Acordo*'/'Em pagamento' precisam ser
// revistos — hoje a régua de acordo é no-op, então excluí-los aqui é seguro.)
const STATUS_FORA_REGUA = [
  // terminais / sem cobrança
  'Quitado', 'Recebido', 'Devolvida', 'Sem êxito', 'Encerrado',
  // já tem acordo -> régua de acordo (não a de cobrança pré-acordo)
  'Acordo', 'Acordo firmado', 'Em pagamento',
  // fase judicial -> não cobrar por WhatsApp automático
  'Ação judicial', 'Petição inicial', 'Citação', 'Contestação',
  'Audiência', 'Sentença', 'Recurso', 'Execução', 'Penhora', 'Hasta pública',
];

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
  return (Array.isArray(arr) ? arr : []).filter((d) => !d.arquivado && !STATUS_FORA_REGUA.includes(d.status));
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

// ============================================================
// LEMBRETE DE ASSINATURA ZapSign (server-side) — item #11.
// ------------------------------------------------------------
// Substitui o worker client-side do crm.html (processarAutoCobrancaZapSign /
// agendarAutoCobranca, ~L7309), que só rodava enquanto o crm.html estava aberto
// no navegador de um operador. Quando o crm.html for aposentado, aquele worker
// para — este job assume a mesma responsabilidade no servidor (roda no cron
// diário do cron-regua, independente de qualquer aba aberta).
//
// O QUE FAZ (verbatim ao CRM):
//   • acordo "aguardando assinatura" há ≥24h  -> agenda lembrete 24h
//   • há ≥48h                                 -> agenda lembrete 48h
//   • há ≥72h                                 -> marca o acordo como ABANDONADO
// Estados terminais (assinado/recusado/cancelado/expirado) saem do funil.
//
// COMO ENVIA: NÃO envia direto. Insere uma linha em `crm_mensagens_agendadas`
// (origem='auto_cobranca_24h'/'auto_cobranca_48h'), a MESMA fila que o CRM usava.
// O sender é a Edge Function `cron-mensagens-agendadas` (pg_cron a cada 1 min),
// que já envia por Z-API, faz retry e RESPEITA whatsapp_atendimentos.regua_bloqueada
// (números marcados como spam/engano). Reusa 100% do pipeline existente — nenhuma
// função Vercel nova, nenhum envio duplicado de canal.
//
// IDEMPOTÊNCIA (dupla, igual/melhor que o CRM):
//   1. Marca no metadata do acordo (metadata.auto_cobranca_24h / _48h / _72h),
//      espelhando as flags que o CRM gravava no histórico do caso.
//   2. A tabela crm_mensagens_agendadas tem índice único parcial
//      uq_crm_msg_agendadas_auto_cobranca (caso_id, origem) WHERE origem LIKE
//      'auto_cobranca%' (migração 20260706_infra_uniq_auto_cobranca, JÁ EM PROD):
//      um INSERT repetido do mesmo (caso_id, origem) falha com unique_violation
//      em vez de duplicar. Tratamos 409/23505 como "já agendado" (no-op).
//
// TELEFONE: acordos não tem telefone; vem de devedores.telefone (join).
// caso_id = devedor_id (no CRM o "caso" é o devedor; a FK de crm_mensagens_agendadas
// aponta pra casos(id), que compartilha o id do devedor — mesma convenção do CRM,
// que inseria caso_id = c.id sendo c.id o id do devedor/caso).

// Textos VERBATIM do crm.html (processarAutoCobrancaZapSign).
const LEMBRETE_ZAPSIGN_24H = 'Oi, vi que você ainda não assinou o termo. Precisa de alguma ajuda pra concluir?';
const LEMBRETE_ZAPSIGN_48H = 'Oi! Ainda não vi sua assinatura no termo de acordo. Quer revisar algo? Tô à disposição pra resolver.';

// Estados terminais: acordo não está mais "aguardando assinatura" -> fora do funil.
// (CRM usava {assinado,recusado,cancelado}; incluímos 'expirado', que também é
// terminal pelo CHECK chk_acordos_status_zapsign e claramente não aguarda mais.)
const ZAPSIGN_TERMINAIS = new Set(['assinado', 'recusado', 'cancelado', 'expirado']);

function horasDesde(dataStr) {
  if (!dataStr) return null;
  const d = new Date(dataStr);
  if (isNaN(d)) return null;
  return (Date.now() - d.getTime()) / 3600000;
}

async function processarLembretesZapSign({ dry } = {}) {
  const out = { candidatos: 0, agendados_24h: 0, agendados_48h: 0, abandonados: 0, pulados: 0, falhas: 0, itens: [] };

  // Acordos ainda em assinatura: status_zapsign em (enviado, visualizado, pendente),
  // não terminal. Traz o telefone do devedor pelo join. Limite generoso: são poucos.
  let acordos;
  try {
    acordos = await sbFetch(
      'acordos?select=' + encodeURIComponent(
        'id,devedor_id,status,status_zapsign,zapsign_evento_em,created_at,metadata,devedor:devedores(telefone,assigned_to)'
      ) +
      '&status_zapsign=in.(enviado,visualizado,pendente)' +
      '&order=created_at.desc&limit=1000'
    );
  } catch (e) {
    return { ...out, error: 'select acordos: ' + e.message };
  }
  if (!Array.isArray(acordos) || acordos.length === 0) return out;

  for (const ac of acordos) {
    const status = String(ac.status_zapsign || '').toLowerCase();
    if (ZAPSIGN_TERMINAIS.has(status)) continue;        // já saiu do funil
    // Só acordos ativos; um acordo cancelado no CRM tem status != 'ativo'.
    if (ac.status && ac.status !== 'ativo') continue;

    out.candidatos++;
    const meta = (ac.metadata && typeof ac.metadata === 'object') ? ac.metadata : {};
    // "Início da etapa" = quando o documento entrou em assinatura. Preferimos
    // zapsign_evento_em (carimbo do webhook ao virar enviado/visualizado); fallback
    // pro created_at do acordo. Espelha o tempoNaEtapa do CRM da forma mais fiel possível.
    const horas = horasDesde(ac.zapsign_evento_em || ac.created_at);
    if (horas == null) { out.pulados++; continue; }

    const dev = (ac.devedor && typeof ac.devedor === 'object') ? ac.devedor : {};
    const telefone = String(dev.telefone || '').replace(/\D/g, '');
    const casoId = ac.devedor_id;          // caso = devedor (mesma convenção do CRM)
    const operadorId = dev.assigned_to || null;

    // ≥72h: marca o acordo como ABANDONADO (não agenda mensagem — igual ao CRM, que
    // trocava o passoAtual e NÃO enviava cobrança). Só marca uma vez (flag no metadata).
    if (horas >= 72) {
      if (meta.auto_cobranca_72h) { out.pulados++; continue; }
      out.itens.push({ acordo: ac.id, acao: 'abandonado', horas: Math.floor(horas), status: dry ? 'dry' : 'marcado' });
      if (!dry) {
        try {
          await sbFetch(`acordos?id=eq.${encodeURIComponent(ac.id)}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({
              metadata: { ...meta,
                auto_cobranca_72h: true,
                auto_cobranca_72h_em: new Date().toISOString(),
                auto_cobranca_72h_nota: 'caso marcado como ABANDONADO (>72h sem assinatura)' },
            }),
          });
        } catch (e) { out.falhas++; out.itens[out.itens.length - 1].error = e.message; continue; }
      }
      out.abandonados++;
      continue;
    }

    // ≥48h ou ≥24h: agenda o lembrete (um por estágio). Precisa de telefone.
    let origem = null, corpo = null;
    if (horas >= 48 && !meta.auto_cobranca_48h) { origem = 'auto_cobranca_48h'; corpo = LEMBRETE_ZAPSIGN_48H; }
    else if (horas >= 24 && !meta.auto_cobranca_24h) { origem = 'auto_cobranca_24h'; corpo = LEMBRETE_ZAPSIGN_24H; }
    if (!origem) { out.pulados++; continue; }

    if (!telefone) {
      out.itens.push({ acordo: ac.id, origem, skipped: 'sem telefone do devedor' });
      out.pulados++; continue;
    }

    out.itens.push({ acordo: ac.id, origem, horas: Math.floor(horas), status: dry ? 'dry' : 'agendado' });
    if (!dry) {
      // Insere na fila. O índice único (caso_id, origem) fecha a janela de duplicidade
      // no banco: um segundo INSERT do mesmo par cai em 409/23505 -> tratamos como no-op.
      let jaAgendado = false;
      try {
        await sbFetch('crm_mensagens_agendadas', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            caso_id: casoId,
            operador_id: operadorId,
            telefone,
            mensagem: corpo,
            agendada_para: new Date(Date.now() + 60000).toISOString(),
            status: 'pendente',
            origem,
          }),
        });
      } catch (e) {
        // Duplicata (índice único) -> já existe o lembrete deste estágio; ok.
        if (/409|23505|duplicate|unique/i.test(e.message)) { jaAgendado = true; }
        else { out.falhas++; out.itens[out.itens.length - 1].error = e.message; continue; }
      }

      // Marca o estágio no metadata do acordo (idempotência espelhada ao CRM). Mesmo
      // quando jaAgendado (a linha já existia), gravar a flag evita reprocessar toda run.
      try {
        await sbFetch(`acordos?id=eq.${encodeURIComponent(ac.id)}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            metadata: { ...meta, [origem]: true, [origem + '_em']: new Date().toISOString() },
          }),
        });
      } catch (e) { /* não crítico: o índice único ainda impede duplicar o envio */ }

      if (jaAgendado) { out.pulados++; out.itens[out.itens.length - 1].status = 'ja_agendado'; continue; }
    }
    if (origem === 'auto_cobranca_48h') out.agendados_48h++; else out.agendados_24h++;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// RÉGUA C — QUITAFÁCIL (autonegociação de dívidas pequenas)
// Convida por WhatsApp os devedores elegíveis a resolverem sozinhos no portal.
// Mensagem redigida pela BEATRIZ (IA, Claude Haiku) com fallback estático.
// Cadência D0 · D+3 · D+7 (1 msg por run, no máx 3). Idempotência: regua_envios
// tipo='quita' (parcela_id = cobranca_id). DUPLO GATE: (1) opt-in por credor
// (clientes.metadata.quita.disparoAtivo); (2) QUITA_NOTIFICAR_LIVE=1 no ambiente.
// ════════════════════════════════════════════════════════════════════════════
const BEATRIZ_QUITA_SYSTEM = `Você é Beatriz, assistente da COBRASQ Recuperadora de Crédito.
Redija UMA mensagem curta de WhatsApp (máximo 4 linhas) convidando a pessoa a resolver uma dívida pequena de forma simples e digna, pelo portal (o link vem no fim).
Tom: educado, acolhedor, humano — NUNCA ameaçador nem com jargão jurídico.
Use só o primeiro nome. Sem markdown (nada de asteriscos ou listas). No máximo 1 emoji. Português brasileiro, sem gerundismo.
Deixe claro que dá para pagar à vista com desconto OU parcelar, que é rápido e que a própria pessoa resolve, sem precisar falar com ninguém.
Termine com o link. Responda SOMENTE com o texto da mensagem, nada mais.`;

function _quitaMsgFallback(ctx) {
  const primeiro = String(ctx.nome || '').trim().split(/\s+/)[0] || 'Olá';
  return `Olá, ${primeiro}! Aqui é a Beatriz, da ${ctx.credor}.\n`
    + `Você tem uma pendência de ${fmtR(ctx.valor)} e dá para resolver agora, do seu jeito: à vista com ${ctx.desc}% de desconto (${fmtR(ctx.avista)}) ou parcelado em até ${ctx.maxParc}x.\n`
    + `É rápido e você mesmo resolve por aqui, sem precisar falar com ninguém:\n${ctx.link}`;
}

async function beatrizConviteQuita(ctx) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) return _quitaMsgFallback(ctx);
  const primeiro = String(ctx.nome || '').trim().split(/\s+/)[0] || '';
  const userMsg = `Dados para a mensagem:
Nome: ${primeiro}
Valor atual da dívida: ${fmtR(ctx.valor)}
À vista com ${ctx.desc}% de desconto: ${fmtR(ctx.avista)}
Parcelamento: até ${ctx.maxParc}x (parcela mínima ${fmtR(ctx.parcMin)})
Link do portal: ${ctx.link}
Momento: ${ctx.passo === 'd0' ? 'primeiro contato' : 'lembrete gentil (a pessoa ainda não resolveu)'}

Escreva a mensagem.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: BEATRIZ_QUITA_SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!r.ok) return _quitaMsgFallback(ctx);
    const j = await r.json();
    const txt = (j && j.content && j.content[0] && j.content[0].text || '').trim();
    return txt || _quitaMsgFallback(ctx);
  } catch (e) {
    return _quitaMsgFallback(ctx);
  }
}

async function reguaQuita({ dry, DB }) {
  const out = { enviados: 0, falhas: 0, elegiveis: 0, itens: [] };
  const link = devLinkPortal();
  const credorNome = DB.config?.empresa || 'COBRASQ';

  // 1) Credores com o portal LIGADO (opt-in). Sem nenhum → no-op (piloto seguro).
  let credores = [];
  try {
    credores = await sbFetch(`clientes?select=id,nome,nome_fantasia,arquivado,metadata&metadata->quita->>disparoAtivo=eq.true`);
  } catch (e) { credores = []; }
  credores = (credores || []).filter(c => !c.arquivado);
  if (!credores.length) return out;
  const cfgPorCredor = {};
  for (const c of credores) cfgPorCredor[c.id] = (c.metadata && c.metadata.quita) || {};
  const credorIds = credores.map(c => c.id);

  // 2) Cobranças desses credores + devedor principal (com telefone).
  const inList = credorIds.map(encodeURIComponent).join(',');
  let cobrs = [];
  try {
    cobrs = await sbFetch(`cobrancas?cliente_id=in.(${inList})&select=id,cliente_id,arquivado,valor_atual,valor_orig,valor_capital,fase,numero_processo,status,divida,cobranca_partes(principal,devedores(id,nome,telefone))`);
  } catch (e) { cobrs = []; }

  // 3) Filtra elegíveis (mesma regra do quita_oferta) e resolve o devedor principal.
  const alvos = [];
  for (const c of (cobrs || [])) {
    if (c.arquivado) continue;
    if ((c.fase || 'extrajudicial') !== 'extrajudicial') continue;
    if (c.numero_processo && String(c.numero_processo).trim()) continue;
    if (/(acord|quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebid)/i.test(c.status || '')) continue;
    const cfg = cfgPorCredor[c.cliente_id] || {};
    const limite = (cfg.limite != null && cfg.limite !== '' && +cfg.limite > 0) ? +cfg.limite : 500;
    const capital = (c.valor_capital != null) ? +c.valor_capital
      : (c.divida && c.divida.valorCapital != null ? +c.divida.valorCapital : (+c.valor_orig || +c.valor_atual || 0));
    if (!(capital > 0 && capital <= limite)) continue;
    const partes = (c.cobranca_partes || []).slice().sort((a, b) => (b.principal ? 1 : 0) - (a.principal ? 1 : 0));
    const dev = (partes[0] || {}).devedores;
    if (!dev || !dev.id) continue;
    const tel = String(dev.telefone || '').replace(/\D/g, '');
    if (!tel) continue;
    alvos.push({
      cobId: c.id, devId: dev.id, nome: dev.nome, tel,
      valor: +c.valor_atual || +c.valor_orig || 0,
      desc: (cfg.descAvista != null && cfg.descAvista !== '') ? +cfg.descAvista : 10,
      maxP: (cfg.maxParcelas != null && cfg.maxParcelas !== '') ? +cfg.maxParcelas : 12,
      parcMin: (cfg.parcelaMin != null && cfg.parcelaMin !== '') ? +cfg.parcelaMin : 150,
    });
  }
  out.elegiveis = alvos.length;
  if (!alvos.length) return out;

  // 4) Exclui quem já tem acordo QuitaFácil (não perturbar quem já fechou).
  const cobIds = [...new Set(alvos.map(a => a.cobId))];
  const jaAcordo = new Set();
  try {
    for (let i = 0; i < cobIds.length; i += 100) {
      const ch = cobIds.slice(i, i + 100).map(encodeURIComponent).join(',');
      const rows = await sbFetch(`acordos?select=cobranca_id&cobranca_id=in.(${ch})&metadata->>origem=eq.quitafacil`);
      for (const r of (rows || [])) jaAcordo.add(r.cobranca_id);
    }
  } catch (e) { /* melhor esforço */ }

  // 5) Cadência via regua_envios (tipo='quita'): passo d0/d3/d7 devido hoje.
  const devIds = [...new Set(alvos.map(a => a.devId))];
  const envios = {}; // "devId|cobId" -> { d0, d3, d7 } (created_at)
  try {
    for (let i = 0; i < devIds.length; i += 100) {
      const ch = devIds.slice(i, i + 100).map(encodeURIComponent).join(',');
      const rows = await sbFetch(`regua_envios?select=devedor_id,parcela_id,step_key,created_at&tipo=eq.quita&status=eq.sent&devedor_id=in.(${ch})`);
      for (const r of (rows || [])) {
        const k = `${r.devedor_id}|${r.parcela_id || ''}`;
        (envios[k] = envios[k] || {})[r.step_key] = r.created_at;
      }
    }
  } catch (e) { /* melhor esforço */ }

  for (const a of alvos) {
    if (jaAcordo.has(a.cobId)) continue;
    const env = envios[`${a.devId}|${a.cobId}`] || {};
    let step = null;
    if (!env.d0) step = 'd0';
    else if (!env.d3 && diasDesde(String(env.d0).slice(0, 10)) >= 3) step = 'd3';
    else if (!env.d7 && diasDesde(String(env.d0).slice(0, 10)) >= 7) step = 'd7';
    if (!step) continue;

    const avista = Math.max(0, a.valor * (1 - a.desc / 100));
    const maxViavel = Math.max(1, Math.min(a.maxP, Math.floor(a.valor / a.parcMin) || 1));
    const msg = await beatrizConviteQuita({ nome: a.nome, valor: a.valor, avista, desc: a.desc, maxParc: maxViavel, parcMin: a.parcMin, link, credor: credorNome, passo: step });

    if (!dry) {
      const claimed = await claimEnvio({ tipo: 'quita', devedorId: a.devId, parcelaId: a.cobId, stepKey: step, canal: 'whatsapp' });
      if (!claimed) { out.itens.push({ dev: a.nome, step, skipped: 'já reivindicado' }); continue; }
    }
    try {
      if (!dry) await zapiSendText(a.tel, msg);
      if (!dry) await confirmarEnvio({ tipo: 'quita', devedorId: a.devId, parcelaId: a.cobId, stepKey: step });
      out.enviados++;
      out.itens.push({ dev: a.nome, step, status: dry ? 'dry' : 'sent', msg: dry ? msg : undefined });
    } catch (e) {
      out.falhas++;
      if (!dry) await liberarEnvio({ tipo: 'quita', devedorId: a.devId, parcelaId: a.cobId, stepKey: step });
      out.itens.push({ dev: a.nome, step, error: e.message });
    }
  }
  return out;
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
    // Fase 3 — cutover: relacional vira o PADRÃO (o blob deixa de ser a fonte da régua).
    // ?source=blob ou env REGUA_SOURCE=blob ainda forçam o blob (escape hatch reversível).
    const reguaSource = (sourceParam === 'relacional' || sourceParam === 'blob') ? sourceParam
                      : (String(process.env.REGUA_SOURCE || '').toLowerCase() === 'blob' ? 'blob' : 'relacional');

    // PR7: contas a pagar próprias — independe da régua de cobrança estar ativa.
    const contasPagar = dry ? null : await processarContasPagarProprias(DB);

    if (DB.config?.reguaAtiva === false) {
      const calendarStats = dry ? null : await processarCalendarPendingDeletes();
      return res.status(200).json({ ok: true, msg: 'Régua pausada globalmente.', calendar: calendarStats, contasPagar });
    }

    // ===== RÉGUA C — QUITAFÁCIL (independe das outras réguas). Duplo gate:
    // (1) opt-in por credor (metadata.quita.disparoAtivo); (2) QUITA_NOTIFICAR_LIVE=1
    // no ambiente — sem a env, roda em DRY (Beatriz redige, mas NÃO envia). =====
    const quitaLive = process.env.QUITA_NOTIFICAR_LIVE === '1';
    let quita = null;
    try { quita = await reguaQuita({ dry: dry || !quitaLive, DB }); if (quita) quita.live = quitaLive; }
    catch (e) { quita = { error: e.message }; }

    const reguaCobranca = Array.isArray(DB.config?.reguaCobranca) ? DB.config.reguaCobranca
                       : Array.isArray(DB.config?.regraCobranca) ? DB.config.regraCobranca : [];
    const reguaAcordo   = Array.isArray(DB.config?.reguaAcordo) ? DB.config.reguaAcordo : [];

    if (reguaCobranca.length === 0 && reguaAcordo.length === 0) {
      const calendarStats = dry ? null : await processarCalendarPendingDeletes();
      return res.status(200).json({ ok: true, msg: 'Nenhum passo configurado nas réguas clássicas.', calendar: calendarStats, contasPagar, quita });
    }

    const credor = DB.config?.empresa || 'COBRASQ';
    const link = devLinkPortal();
    const devedores = reguaSource === 'relacional' ? await carregarDevedoresRelacional() : blobDevedores;
    const ativos = devedores.filter(d => !d.arquivado && !STATUS_FORA_REGUA.includes(d.status));

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

      // Opção (a) do gestor: manda só o lembrete do ESTÁGIO ATUAL — o passo de MAIOR
      // `dias` já vencido — 1 por devedor por run. Evita a rajada de vários lembretes de
      // uma vez na retomada; conforme o devedor envelhece e cruza um passo novo, só esse
      // passo novo dispara (uma vez). Os `continue` daqui pulam para o PRÓXIMO devedor.
      const _devidos = (reguaCobranca || []).filter(s => dias >= (s.dias || 0));
      const step = _devidos.length ? _devidos.reduce((a, b) => ((b.dias || 0) >= (a.dias || 0) ? b : a)) : null;
      if (step) {
        const stepKey = step.id || `${step.dias}_${step.canal}`;
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
        // F-10: reivindica a vaga ANTES de enviar (evita WhatsApp duplicado em runs sobrepostos).
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

    // Lembrete de assinatura ZapSign (item #11) — roda dentro do cron-regua diário.
    // TRAVA DE SEGURANÇA: começa DESLIGADO (força dry) até LEMBRETE_ZAPSIGN_LIVE=1 no
    // ambiente, para que o deploy não dispare envio automático sem uma conferência
    // prévia. Com a env ligada, respeita o ?dry=1 manual normalmente.
    const zapsignLive = process.env.LEMBRETE_ZAPSIGN_LIVE === '1';
    let zapsign = null;
    try { zapsign = await processarLembretesZapSign({ dry: dry || !zapsignLive }); }
    catch (e) { zapsign = { error: e.message }; }

    res.status(200).json({ ok: true, hoje: new Date().toISOString().slice(0,10), ...resultado, calendar, contasPagar, zapsign, zapsign_live: zapsignLive, quita });
  } catch (err) {
    console.error('[cron-regua]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
