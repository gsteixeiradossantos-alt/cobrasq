// api/cron-regua.js — Executa réguas de cobrança diariamente.
// Processa:
//   1. reguaCobranca  — pré-acordo (para cada devedor não-quitado, sem acordo ativo)
//   2. reguaAcordo    — pós-acordo (para cada parcela em aberto de acordos ativos)
//
// Configurado em vercel.json como cron job (default: 12:00 UTC = 09:00 BRT).
// Invocação manual: GET /api/cron-regua?dry=1  → dry-run sem enviar

const SB_URL = process.env.SUPABASE_URL || '';
// Padronizado para SUPABASE_SERVICE_ROLE_KEY (mesmo nome usado pelas edge functions).
// SUPABASE_SERVICE_KEY mantido como fallback de retrocompat para não quebrar deploys atuais.
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

// Dias entre hoje e uma data futura (negativo se já passou)
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

module.exports = async function handler(req, res) {
  const ua = req.headers['user-agent'] || '';
  const secret = req.headers['x-cron-secret'] || req.query?.secret || '';
  const expect = process.env.CRON_SECRET || '';
  const isVercelCron = /vercel-cron/i.test(ua);
  if (expect && !isVercelCron && secret !== expect) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  try {
    const rows = await sbFetch(`cobrasq_data?key=eq.main&select=data,updated_at`);
    if (!rows || rows.length === 0) {
      return res.status(200).json({ ok: true, msg: 'cobrasq_data vazia.' });
    }
    const DB = rows[0].data || {};

    if (DB.config?.reguaAtiva === false) {
      return res.status(200).json({ ok: true, msg: 'Régua pausada globalmente.' });
    }

    const reguaCobranca = Array.isArray(DB.config?.reguaCobranca) ? DB.config.reguaCobranca
                       : Array.isArray(DB.config?.regraCobranca) ? DB.config.regraCobranca : [];
    const reguaAcordo   = Array.isArray(DB.config?.reguaAcordo) ? DB.config.reguaAcordo : [];

    if (reguaCobranca.length === 0 && reguaAcordo.length === 0) {
      return res.status(200).json({ ok: true, msg: 'Nenhum passo configurado em nenhuma régua.' });
    }

    const credor = DB.config?.empresa || 'COBRASQ';
    const link = devLinkPortal();
    const devedores = Array.isArray(DB.devedores) ? DB.devedores : [];
    const ativos = devedores.filter(d => !d.arquivado && !['Quitado', 'Recebido', 'Devolvida', 'Sem êxito'].includes(d.status));

    DB.reguaLog = DB.reguaLog || [];
    const resultado = {
      processados: ativos.length,
      enviados_cobranca: 0,
      enviados_acordo:   0,
      falhas: 0,
      dry,
      itens: []
    };

    // ========== RÉGUA A — PRÉ-ACORDO (devedores sem acordo ativo) ==========
    for (const dev of ativos) {
      const temAcordoAtivo = (dev.acordos || []).some(acordoAtivo);
      if (temAcordoAtivo) continue; // cobrança só pré-acordo

      // Prioriza dev.vencimento; fallback entrada/createdAt
      const baseData = dev.vencimento || dev.entrada || (dev.createdAt ? dev.createdAt.split('T')[0] : '');
      const dias = diasDesde(baseData);
      if (dias < 0) continue; // não venceu ainda

      dev._reguaEnviados = Array.isArray(dev._reguaEnviados) ? dev._reguaEnviados : [];
      const tel = devTelefone(dev);
      const valor = parseValorBR(dev.valorAtual) || parseValorBR(dev.valorOrig) || 0;

      for (const step of reguaCobranca) {
        const stepKey = step.id || `${step.dias}_${step.canal}`;
        if (dias < (step.dias || 0)) continue;
        if (dev._reguaEnviados.includes(stepKey)) continue;
        if (step.canal !== 'whatsapp') {
          resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, skipped: `canal ${step.canal} não integrado` });
          continue;
        }
        if (!tel) { resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', skipped: 'sem telefone' }); continue; }

        const msg = renderTemplate(step.template, {
          nome: dev.nome || '', valor: fmtR(valor), doc: dev.doc || '',
          dias: String(dias), vencimento: baseData, link, credor
        });
        try {
          if (!dry) await zapiSendText(tel, msg);
          dev._reguaEnviados.push(stepKey);
          DB.reguaLog.push({ ts: new Date().toISOString(), tipo:'cobranca', devId: dev.id, devNome: dev.nome, step: stepKey, canal: step.canal });
          resultado.enviados_cobranca++;
          resultado.itens.push({ dev: dev.nome, tipo: 'cobranca', step: stepKey, status: dry ? 'dry' : 'sent' });
        } catch (e) {
          resultado.falhas++;
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

      for (const ac of acordos) {
        const parcelas = (ac.parcelas || []).filter(p => !p.pago);
        for (const p of parcelas) {
          p._reguaEnviados = Array.isArray(p._reguaEnviados) ? p._reguaEnviados : [];
          const diasParaVencer = diasAte(p.vencimento);
          // Disparar cada step cuja condição de dias/referencia case com hoje
          for (const step of reguaAcordo) {
            const stepKey = step.id || `${step.referencia}_${step.dias}_${step.canal}`;
            if (p._reguaEnviados.includes(stepKey)) continue;
            // Decide se o step deve disparar HOJE
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
            try {
              if (!dry) await zapiSendText(tel, msg);
              p._reguaEnviados.push(stepKey);
              DB.reguaLog.push({ ts: new Date().toISOString(), tipo: 'acordo', devId: dev.id, devNome: dev.nome, parcelaId: p.id, step: stepKey, canal: step.canal });
              resultado.enviados_acordo++;
              resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, status: dry ? 'dry' : 'sent' });
            } catch (e) {
              resultado.falhas++;
              resultado.itens.push({ dev: dev.nome, tipo: 'acordo', parcela: p.numero, step: stepKey, error: e.message });
            }
          }
        }
      }
    }

    if (!dry && (resultado.enviados_cobranca + resultado.enviados_acordo) > 0) {
      DB.reguaLog = DB.reguaLog.slice(-1000);
      await sbFetch(`cobrasq_data?key=eq.main`, {
        method: 'PATCH',
        body: JSON.stringify({ data: DB, updated_at: new Date().toISOString() }),
      });
    }

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
            processados: resultado.processados
          }
        })
      });
    } catch {}

    res.status(200).json({ ok: true, hoje: new Date().toISOString().slice(0,10), ...resultado });
  } catch (err) {
    console.error('[cron-regua]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
