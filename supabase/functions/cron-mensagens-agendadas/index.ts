// Supabase Edge Function: cron-mensagens-agendadas
// Disparada por pg_cron a cada 1 minuto via pg_net.http_post.
// Processa crm_mensagens_agendadas WHERE status='pendente' AND agendada_para <= now()
// Envia via Z-API com retry+backoff. Idempotente via lock otimista.
// Suporta tipo: texto (send-text), audio (send-audio), documento (send-document/{ext})
// e imagem (send-image). Mídia fica no bucket 'documentos'; gera signed URL (1h) no envio.
//
// Autenticação: header `Authorization: Bearer <CRON_INVOKE_SECRET>`.
// Setup: supabase secrets set CRON_INVOKE_SECRET=<random-32>
//        supabase secrets set ZAPI_INSTANCE=... ZAPI_TOKEN=... ZAPI_CLIENT_TOKEN=...
//        E criar o segredo no Vault: SELECT vault.create_secret('<random-32>', 'CRON_INVOKE_SECRET');
//        Depois rodar a migration novamente OU agendar manualmente via cron.schedule().

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const MAX_LOTE = 50;
const MAX_TENTATIVAS = 5;

async function callZapi(url: string, headers: Record<string, string>, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const delays = [1000, 2000, 4000];
  for (let i = 0; i <= delays.length; i++) {
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
    } catch (e) {
      if (i < delays.length) { await new Promise(res => setTimeout(res, delays[i])); continue; }
      return { ok: false, status: 0, data: { error: 'timeout/network: ' + (e instanceof Error ? e.message : String(e)) } };
    }
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, status: r.status, data };
    if ((r.status === 429 || r.status >= 500) && i < delays.length) { await new Promise(res => setTimeout(res, delays[i])); continue; }
    return { ok: false, status: r.status, data };
  }
  return { ok: false, status: 0, data: { error: 'esgotou tentativas' } };
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('CRON_INVOKE_SECRET');
  if (!expected) return new Response(JSON.stringify({ error: 'CRON_INVOKE_SECRET não configurado' }), { status: 500 });
  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided !== expected) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const ZAPI_INSTANCE = Deno.env.get('ZAPI_INSTANCE');
  const ZAPI_TOKEN = Deno.env.get('ZAPI_TOKEN');
  const ZAPI_CLIENT_TOKEN = Deno.env.get('ZAPI_CLIENT_TOKEN');
  if (!ZAPI_INSTANCE || !ZAPI_TOKEN) return new Response(JSON.stringify({ error: 'Z-API não configurado' }), { status: 500 });
  const zapiBase = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;
  const zapiHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ZAPI_CLIENT_TOKEN) zapiHeaders['Client-Token'] = ZAPI_CLIENT_TOKEN;

  // Bucket onde o frontend salva a mídia agendada (áudio/documento/imagem).
  const MEDIA_BUCKET = 'documentos';

  // Monta { url, body } da chamada Z-API conforme o tipo da mensagem.
  // Para mídia, gera um signed URL temporário (1h) que o Z-API baixa no envio.
  async function montarEnvio(m: any): Promise<{ ok: boolean; url?: string; body?: unknown; erro?: string }> {
    const phoneDigits = String(m.telefone || '').replace(/\D/g, '');
    const phone = phoneDigits.startsWith('55') ? phoneDigits : '55' + phoneDigits;
    const tipo = m.tipo || 'texto';

    if (tipo === 'texto') {
      return { ok: true, url: `${zapiBase}/send-text`, body: { phone, message: m.mensagem || '' } };
    }

    if (!m.media_path) return { ok: false, erro: 'media_path ausente para tipo ' + tipo };
    const { data: signed, error: signErr } = await sb.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(m.media_path, 3600);
    if (signErr || !signed?.signedUrl) {
      return { ok: false, erro: 'signed url: ' + (signErr?.message || 'desconhecido') };
    }
    const mediaUrl = signed.signedUrl;

    if (tipo === 'audio') {
      return { ok: true, url: `${zapiBase}/send-audio`, body: { phone, audio: mediaUrl } };
    }
    if (tipo === 'imagem') {
      return { ok: true, url: `${zapiBase}/send-image`, body: { phone, image: mediaUrl, caption: m.legenda || '' } };
    }
    if (tipo === 'documento') {
      const nome = m.media_nome || 'documento';
      const ext = (nome.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
      return {
        ok: true,
        url: `${zapiBase}/send-document/${ext}`,
        body: { phone, document: mediaUrl, fileName: nome, caption: m.legenda || '' }
      };
    }
    return { ok: false, erro: 'tipo desconhecido: ' + tipo };
  }

  const agora = new Date().toISOString();
  const { data: lote, error: errSel } = await sb
    .from('crm_mensagens_agendadas')
    .select('id, telefone, mensagem, tentativas, caso_id, operador_id, tipo, media_path, media_nome, media_mime, legenda')
    .eq('status', 'pendente')
    .lte('agendada_para', agora)
    .order('agendada_para', { ascending: true })
    .limit(MAX_LOTE);

  if (errSel) return new Response(JSON.stringify({ error: 'select: ' + errSel.message }), { status: 500 });
  if (!lote || lote.length === 0) {
    return new Response(JSON.stringify({ ok: true, processadas: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  let enviadas = 0, falhadas = 0;
  for (const m of lote) {
    // Lock otimista
    const { data: lock } = await sb
      .from('crm_mensagens_agendadas')
      .update({ status: 'processando' })
      .eq('id', m.id)
      .eq('status', 'pendente')
      .select('id');
    if (!lock || lock.length === 0) continue;

    const envio = await montarEnvio(m);
    const novasTentativas = (m.tentativas || 0) + 1;
    const result = envio.ok
      ? await callZapi(envio.url!, zapiHeaders, envio.body)
      : { ok: false, status: 0, data: { error: envio.erro } };

    if (result.ok) {
      await sb.from('crm_mensagens_agendadas')
        .update({ status: 'enviada', tentativas: novasTentativas, enviada_em: new Date().toISOString(), erro: null })
        .eq('id', m.id);
      enviadas++;
    } else if (novasTentativas >= MAX_TENTATIVAS) {
      await sb.from('crm_mensagens_agendadas')
        .update({ status: 'falhou', tentativas: novasTentativas, erro: JSON.stringify(result.data).slice(0, 500) })
        .eq('id', m.id);
      await sb.from('crm_envios_falhados').insert({
        caso_id: m.caso_id,
        operador_id: m.operador_id,
        telefone: m.telefone,
        mensagem: m.mensagem,
        erro: JSON.stringify(result.data).slice(0, 500),
        tentativas: novasTentativas,
        status: 'pendente'
      });
      falhadas++;
    } else {
      await sb.from('crm_mensagens_agendadas')
        .update({ status: 'pendente', tentativas: novasTentativas, erro: JSON.stringify(result.data).slice(0, 500) })
        .eq('id', m.id);
    }
  }

  return new Response(JSON.stringify({ ok: true, lote: lote.length, enviadas, falhadas }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
});
