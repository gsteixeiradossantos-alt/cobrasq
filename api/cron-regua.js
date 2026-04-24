// api/cron-regua.js — Executa a régua de cobrança diariamente.
// Configurado em vercel.json como cron job (default: 09:00 BRT).
// Pode ser invocado manualmente em GET /api/cron-regua?dry=1 para dry-run.
//
// Requer variáveis de ambiente:
//   SUPABASE_URL           URL do projeto Supabase
//   SUPABASE_SERVICE_KEY   service_role key (bypassa RLS). OBTER em
//                          Supabase → Settings → API → service_role
//   CRON_SECRET            (opcional) se definido, requer header
//                          "x-cron-secret" ou ?secret= para rodar
//   ZAPI_TOKEN + ZAPI_INSTANCE_ID (reusa as do /api/zapi)
//   ZAPI_CLIENT_TOKEN      opcional
//
// Segurança: a Vercel injeta header user-agent=vercel-cron/1.0 em
// crons oficiais. Fora disso, exige CRON_SECRET.

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

async function sbFetch(path, opts) {
  if (!SB_URL || !SB_KEY) {
    const missing = [];
    if (!SB_URL) missing.push('SUPABASE_URL');
    if (!SB_KEY) missing.push('SUPABASE_SERVICE_KEY');
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
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
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

function diasEmAberto(dataEntrada) {
  if (!dataEntrada) return 0;
  const d = new Date(dataEntrada);
  if (isNaN(d)) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

async function zapiSendText(phone, message) {
  const token      = process.env.ZAPI_TOKEN || '';
  const instance   = process.env.ZAPI_INSTANCE_ID || '';
  const clientTk   = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!token || !instance) throw new Error('Z-API não configurada');
  const url = `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (clientTk) headers['Client-Token'] = clientTk;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone: String(phone).replace(/\D/g, ''), message }),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Z-API HTTP ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

module.exports = async function handler(req, res) {
  // Segurança: aceita user-agent da Vercel OU CRON_SECRET
  const ua = req.headers['user-agent'] || '';
  const secret = req.headers['x-cron-secret'] || req.query?.secret || '';
  const expect = process.env.CRON_SECRET || '';
  const isVercelCron = /vercel-cron/i.test(ua);
  if (expect && !isVercelCron && secret !== expect) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  try {
    // Lê DB monolítico (linha única 'main')
    const rows = await sbFetch(`cobrasq_data?key=eq.main&select=data,updated_at`);
    if (!rows || rows.length === 0) {
      return res.status(200).json({ ok: true, msg: 'Nenhum dado para processar (cobrasq_data vazia).' });
    }
    const DB = rows[0].data || {};

    // Régua ativa?
    if (DB.config?.reguaAtiva === false) {
      return res.status(200).json({ ok: true, msg: 'Régua está pausada (reguaAtiva=false).' });
    }
    const regra = Array.isArray(DB.config?.regraCobranca) ? DB.config.regraCobranca : [];
    if (regra.length === 0) {
      return res.status(200).json({ ok: true, msg: 'Nenhum passo configurado na régua.' });
    }
    const credor = DB.config?.empresa || 'COBRASQ';
    const linkBase = process.env.PORTAL_URL || '';

    const devedores = Array.isArray(DB.devedores) ? DB.devedores : [];
    const ativos = devedores.filter(d => !d.arquivado && !['Quitado', 'Recebido', 'Devolvida', 'Sem êxito'].includes(d.status));

    const resultado = { processados: ativos.length, enviados: 0, falhas: 0, dry, itens: [] };
    DB.reguaLog = DB.reguaLog || [];
    const hoje = new Date().toISOString().slice(0, 10);

    for (const dev of ativos) {
      const dias = diasEmAberto(dev.createdAt || dev.entrada);
      dev._reguaEnviados = Array.isArray(dev._reguaEnviados) ? dev._reguaEnviados : [];

      for (const step of regra) {
        const stepKey = `${step.id || step.dias + '_' + step.canal}`;
        if (dias < (step.dias || 0)) continue;                   // cedo demais
        if (dev._reguaEnviados.includes(stepKey)) continue;      // já enviado
        if (step.canal !== 'whatsapp') {
          // Somente WhatsApp integrado por enquanto. Outros canais ficam no log.
          resultado.itens.push({ dev: dev.nome, step: stepKey, skipped: `canal ${step.canal} não integrado` });
          continue;
        }
        const tel = (dev.tel || dev.telefone || '').replace(/\D/g, '');
        if (!tel) {
          resultado.itens.push({ dev: dev.nome, step: stepKey, skipped: 'sem telefone' });
          continue;
        }
        const valor = parseValorBR(dev.valorAtual) || parseValorBR(dev.valorOrig) || 0;
        const ctx = {
          nome: dev.nome || '',
          valor: fmtR(valor),
          doc: dev.doc || '',
          dias: String(dias),
          vencimento: (dev.entrada || dev.createdAt || '').split('T')[0],
          link: linkBase,
          credor,
        };
        const msg = renderTemplate(step.template, ctx);
        try {
          if (!dry) {
            await zapiSendText(tel, msg);
          }
          dev._reguaEnviados.push(stepKey);
          DB.reguaLog.push({ ts: new Date().toISOString(), devId: dev.id, devNome: dev.nome, step: stepKey, canal: step.canal, tel });
          resultado.enviados++;
          resultado.itens.push({ dev: dev.nome, step: stepKey, tel, status: dry ? 'dry' : 'sent' });
        } catch (e) {
          resultado.falhas++;
          resultado.itens.push({ dev: dev.nome, step: stepKey, error: e.message });
        }
      }
    }

    // Escreve de volta no Supabase (se não for dry)
    if (!dry && resultado.enviados > 0) {
      DB.reguaLog = DB.reguaLog.slice(-500); // limita histórico
      await sbFetch(`cobrasq_data?key=eq.main`, {
        method: 'PATCH',
        body: JSON.stringify({ data: DB, updated_at: new Date().toISOString() }),
      });
    }

    // Registra execução em audit_logs (best-effort)
    try {
      await sbFetch('audit_logs', {
        method: 'POST',
        body: JSON.stringify({
          action: dry ? 'regua.dry_run' : 'regua.exec',
          entity: 'sistema',
          metadata: { enviados: resultado.enviados, falhas: resultado.falhas, processados: resultado.processados }
        })
      });
    } catch {}

    res.status(200).json({ ok: true, hoje, ...resultado });
  } catch (err) {
    console.error('[cron-regua]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
