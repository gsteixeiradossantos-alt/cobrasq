// Supabase Edge Function: zapsign-webhook
// Recebe POST do ZapSign quando documento muda de status (signed/refused/expired/etc)
// Atualiza acordos.status_zapsign + .data_assinatura + log em devedor_eventos.
//
// Autenticação: header `Authorization: Bearer <ZAPSIGN_WEBHOOK_SECRET>` OU
// query string `?token=<ZAPSIGN_WEBHOOK_SECRET>` (ZapSign suporta ambos).
// verify_jwt: false (precisa ser público pro ZapSign chamar), mas exige nosso secret.
//
// Setup (1x):
//   supabase secrets set ZAPSIGN_WEBHOOK_SECRET=<random-32-char>
//   No painel ZapSign, configure webhook URL pra:
//     https://jokbxzhcctcwnbhkhgru.functions.supabase.co/zapsign-webhook?token=<secret>
//
// Eventos esperados (conforme docs ZapSign):
//   doc_signed | doc_refused | doc_partially_signed | doc_canceled | created
//
// Body (exemplo):
//   { event_type: 'doc_signed', doc: { token: '...', external_id: '...', status: 'signed', signed_file: '...' }, signers: [...] }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// F-18: comparação do secret em tempo constante (não vaza, por timing, quantos
// caracteres do segredo bateram). Hashamos os dois lados com SHA-256 (normaliza
// o tamanho e não expõe o comprimento do segredo) e comparamos byte a byte sem
// short-circuit. Usa só Web Crypto, disponível no runtime Edge do Deno.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

function mapEvento(evt: string, docStatus?: string): string {
  const e = String(evt || '').toLowerCase();
  const s = String(docStatus || '').toLowerCase();
  if (e.includes('signed') && !e.includes('refused')) return 'assinado';
  if (e.includes('refused')) return 'recusado';
  if (e.includes('expired')) return 'expirado';
  if (e.includes('canceled') || e.includes('cancelled')) return 'cancelado';
  if (e.includes('created')) return 'enviado';
  if (e.includes('opened') || e.includes('viewed')) return 'visualizado';
  if (s === 'signed') return 'assinado';
  if (s === 'refused') return 'recusado';
  return 'enviado';
}

// Feature Y: acordo assinado cai sozinho na pasta do devedor (bucket 'documentos').
// Idempotente: path determinístico por doc_id + storage_path UNIQUE na tabela
// (webhook duplicado não duplica arquivo nem metadado). Qualquer falha aqui é
// registrada e NÃO falha o webhook — o status do acordo já foi salvo antes.
async function salvarAcordoAssinadoNaPasta(
  sb: ReturnType<typeof createClient>,
  devedorId: string,
  docId: string,
  signedUrl: string
): Promise<{ salvo: boolean; detalhe: string }> {
  try {
    const { data: dev, error } = await sb.from('devedores')
      .select('id, doc, doc_digits, cliente_id').eq('id', devedorId).single();
    if (error || !dev) return { salvo: false, detalhe: 'devedor não encontrado: ' + (error?.message || devedorId) };

    // Mesma regra de chave do front/RLS: CPF/CNPJ só dígitos, senão 'id-<uuid>'
    const digits = String(dev.doc_digits || dev.doc || '').replace(/\D/g, '');
    const chave = digits || ('id-' + dev.id);
    const path = `devedores/${chave}/${dev.cliente_id || 'sem-credor'}/acordo-assinado/${docId}.pdf`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let resp: Response;
    try {
      resp = await fetch(signedUrl, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return { salvo: false, detalhe: 'download HTTP ' + resp.status };
    const ct = resp.headers.get('content-type') || '';
    if (!/pdf|octet-stream/i.test(ct)) return { salvo: false, detalhe: 'content-type inesperado: ' + ct };
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength === 0) return { salvo: false, detalhe: 'arquivo vazio' };
    if (bytes.byteLength > 20 * 1024 * 1024) return { salvo: false, detalhe: 'acima de 20 MB' };

    const { error: upErr } = await sb.storage.from('documentos')
      .upload(path, bytes, { contentType: 'application/pdf', upsert: false });
    // "already exists" = reentrega do webhook; segue pro metadado (também idempotente)
    if (upErr && !/already exists|duplicate/i.test(String(upErr.message))) {
      return { salvo: false, detalhe: 'upload: ' + upErr.message };
    }

    const { error: insErr } = await sb.from('documentos').upsert({
      devedor_doc: chave,
      devedor_id: String(dev.id),
      credor_id: dev.cliente_id ? String(dev.cliente_id) : null,
      categoria: 'acordo-assinado',
      nome: 'Acordo assinado — ZapSign ' + docId + '.pdf',
      storage_path: path,
      mime_type: 'application/pdf',
      size_bytes: bytes.byteLength,
      obs: 'Salvo automaticamente pelo zapsign-webhook'
    }, { onConflict: 'storage_path', ignoreDuplicates: true });
    if (insErr) return { salvo: false, detalhe: 'metadado: ' + insErr.message };

    return { salvo: true, detalhe: path };
  } catch (e) {
    return { salvo: false, detalhe: String((e as Error)?.message || e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const expected = Deno.env.get('ZAPSIGN_WEBHOOK_SECRET');
  if (!expected) {
    return new Response(JSON.stringify({ error: 'ZAPSIGN_WEBHOOK_SECRET não configurado' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const auth = req.headers.get('authorization') || '';
  const url = new URL(req.url);
  const tokenQs = url.searchParams.get('token') || '';
  const provided = auth.replace(/^Bearer\s+/i, '') || tokenQs;
  if (!(await safeEqual(provided, expected))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const doc = body?.doc || body || {};
  const docId = doc.token || doc.external_id || body.token || body.external_id || body.doc_token;
  if (!docId) {
    return new Response(JSON.stringify({ error: 'doc_id não encontrado no payload' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const novoStatus = mapEvento(body.event_type, doc.status);
  const signedUrl = doc.signed_file || doc.url || null;
  const dataAssinatura = novoStatus === 'assinado' ? new Date().toISOString() : null;

  // F-18: casa o acordo SÓ por zapsign_doc_id exato. O match antigo incluía
  // link_zapsign.ilike.%docId% — um docId curto/parcial podia casar o acordo
  // ERRADO (atualizar a assinatura de outra dívida). Agora é igualdade estrita.
  const { data: acordos, error: errSel } = await sb
    .from('acordos')
    .select('id, devedor_id, status_zapsign')
    .eq('zapsign_doc_id', docId)
    .limit(1);

  if (errSel) {
    return new Response(JSON.stringify({ error: 'erro ao buscar acordo: ' + errSel.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  if (!acordos || acordos.length === 0) {
    console.warn('[zapsign-webhook] acordo não encontrado pra doc_id=' + docId);
    return new Response(JSON.stringify({ ok: true, warning: 'acordo não encontrado', doc_id: docId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const acordo = acordos[0];
  const update: Record<string, unknown> = {
    status_zapsign: novoStatus,
    zapsign_doc_id: docId,
    zapsign_evento_em: new Date().toISOString()
  };
  if (dataAssinatura) update.data_assinatura = dataAssinatura;
  if (signedUrl) update.link_zapsign = signedUrl;

  const { error: errUp } = await sb.from('acordos').update(update).eq('id', acordo.id);
  if (errUp) {
    return new Response(JSON.stringify({ error: 'falha ao atualizar acordo: ' + errUp.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Feature Y: no assinado, salva o PDF na pasta do devedor (não derruba o webhook se falhar)
  let arquivoPasta: { salvo: boolean; detalhe: string } | null = null;
  if (novoStatus === 'assinado' && signedUrl) {
    arquivoPasta = await salvarAcordoAssinadoNaPasta(sb, acordo.devedor_id, docId, signedUrl);
    if (!arquivoPasta.salvo) {
      console.warn('[zapsign-webhook] acordo assinado NÃO salvo na pasta: ' + arquivoPasta.detalhe);
    }
  }

  // PR2: emissão automática dos boletos pós-assinatura. Delega ao endpoint Vercel
  // /api/emitir-acordo (lá mora a chave Asaas). Best-effort: nunca derruba o webhook
  // — o status do acordo já foi salvo. A trava AUTO_EMIT_ACORDO=on (no servidor
  // Vercel) evita duplicar com o n8n enquanto o fluxo legado não é desligado.
  let emissao: unknown = null;
  if (novoStatus === 'assinado') {
    const base = (Deno.env.get('APP_BASE_URL') || '').replace(/\/+$/, '');
    const emitSecret = Deno.env.get('EMIT_ACORDO_SECRET');
    if (base && emitSecret) {
      try {
        const r = await fetch(base + '/api/emitir-acordo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-emit-secret': emitSecret },
          body: JSON.stringify({ acordo_id: acordo.id }),
          signal: AbortSignal.timeout(25000),
        });
        emissao = await r.json().catch(() => ({ status: r.status }));
      } catch (e) {
        emissao = { error: String((e as Error)?.message || e) };
        console.warn('[zapsign-webhook] emitir-acordo falhou: ' + JSON.stringify(emissao));
      }
    } else {
      emissao = { skipped: 'APP_BASE_URL/EMIT_ACORDO_SECRET ausentes' };
    }
  }

  await sb.from('devedor_eventos').insert({
    devedor_id: acordo.devedor_id,
    tipo: 'zapsign_' + novoStatus,
    payload: {
      acao: 'ZapSign: ' + novoStatus + ' (doc ' + docId + ')',
      raw_event: body.event_type || null,
      doc_id: docId,
      signed_url: signedUrl,
      arquivo_pasta: arquivoPasta,
      emissao
    }
  });

  return new Response(JSON.stringify({ ok: true, status: novoStatus, acordo_id: acordo.id, arquivo_pasta: arquivoPasta, emissao }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});
