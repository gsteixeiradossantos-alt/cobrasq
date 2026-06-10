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

async function zapiSendText(phone, message) {
  const token    = process.env.ZAPI_TOKEN || '';
  const instance = process.env.ZAPI_INSTANCE_ID || '';
  const clientTk = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!token || !instance) throw new Error('Z-API não configurada');
  const url = `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (clientTk) headers['Client-Token'] = clientTk;
  const r = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ phone: String(phone).replace(/\D/g, ''), message }),
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
  if (secret !== expect) {
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

    if (DB.config?.reguaAtiva === false) {
      const calendarStats = dry ? null : await processarCalendarPendingDeletes();
      return res.status(200).json({ ok: true, msg: 'Régua pausada globalmente.', calendar: calendarStats });
    }

    const reguaCobranca = Array.isArray(DB.config?.reguaCobranca) ? DB.config.reguaCobranca
                       : Array.isArray(DB.config?.regraCobranca) ? DB.config.regraCobranca : [];
    const reguaAcordo   = Array.isArray(DB.config?.reguaAcordo) ? DB.config.reguaAcordo : [];

    if (reguaCobranca.length === 0 && reguaAcordo.length === 0) {
      const calendarStats = dry ? null : await processarCalendarPendingDeletes();
      return res.status(200).json({ ok: true, msg: 'Nenhum passo configurado em nenhuma régua.', calendar: calendarStats });
    }

    const credor = DB.config?.empresa || 'COBRASQ';
    const link = devLinkPortal();
    const devedores = Array.isArray(DB.devedores) ? DB.devedores : [];
    const ativos = devedores.filter(d => !d.arquivado && !['Quitado', 'Recebido', 'Devolvida', 'Sem êxito'].includes(d.status));

    // Back-fill de marcas legadas, se for o caso (uma vez só)
    const backfilled = dry ? 0 : await backfillSeNecessario(devedores);

    // Pré-carrega "já enviados" de todos os devedores ativos numa única query
    const devIds = ativos.map(d => String(d.id || ''));
    const jaEnviados = await loadJaEnviados(devIds);

    const resultado = {
      processados: ativos.length,
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
        if (step.canal !== 'whatsapp') {
          resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, skipped: `canal ${step.canal} não integrado` });
          continue;
        }
        if (!tel) { resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', skipped: 'sem telefone' }); continue; }

        const msg = renderTemplate(step.template, {
          nome: dev.nome || '', valor: fmtR(valor), doc: dev.doc || '',
          dias: String(dias), vencimento: baseData, link, credor
        });
        // F-10: reivindica a vaga ANTES de enviar. Se outro run já reivindicou,
        // não envia (evita WhatsApp duplicado em runs sobrepostos).
        if (!dry) {
          const claimed = await claimEnvio({ tipo: 'cobranca', devedorId: devId, parcelaId: '', stepKey, canal: step.canal });
          if (!claimed) {
            resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, skipped: 'já reivindicado (concorrência/duplicado)' });
            continue;
          }
        }
        try {
          if (!dry) await zapiSendText(tel, msg);
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
      const tel = devTelefone(dev);
      if (!tel) continue;
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
            if (step.canal !== 'whatsapp') {
              resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, skipped: `canal ${step.canal} não integrado` });
              continue;
            }

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
              const claimed = await claimEnvio({ tipo: 'acordo', devedorId: devId, parcelaId, stepKey, canal: step.canal });
              if (!claimed) {
                resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, skipped: 'já reivindicado (concorrência/duplicado)' });
                continue;
              }
            }
            try {
              if (!dry) await zapiSendText(tel, msg);
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

    res.status(200).json({ ok: true, hoje: new Date().toISOString().slice(0,10), ...resultado, calendar });
  } catch (err) {
    console.error('[cron-regua]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
