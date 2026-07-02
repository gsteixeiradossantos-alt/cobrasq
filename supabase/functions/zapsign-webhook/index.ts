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

// ⚠️ ATIVAR SÓ APÓS TROCAR PARA HEADER NO PAINEL DO ZAPSIGN.
// O segredo via `?token=` na URL vaza em logs/histórico/referrer; o correto é mandá-lo só
// no HEADER `Authorization: Bearer <secret>`. Enquanto a URL cadastrada no painel ainda usa
// `?token=`, manter TRUE evita quebrar o webhook em produção. PASSO MANUAL para desligar:
//   1. Painel ZapSign → Configurações/Webhooks → editar a URL do webhook.
//   2. Remover `?token=<secret>` da URL e configurar o segredo no header
//      `Authorization: Bearer <secret>` (headers customizados do webhook).
//   3. Enviar evento de teste e confirmar 200.
//   4. Trocar esta flag para `false` e re-deployar. A partir daí, `?token=` é IGNORADO.
const ACEITAR_TOKEN_QUERYSTRING = true;

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
  // P1 (auditoria 2026-06) — 'doc_partially_signed': UM signatário assinou, mas o
  // documento multi-assinatura ainda NÃO está completo. Tem que ser tratado ANTES do
  // ramo genérico 'signed' abaixo (senão cairia em 'assinado' e o webhook emitiria os
  // boletos e concluiria o caso antes de todos assinarem). Status próprio que NÃO
  // dispara emissão nem conclusão (o fluxo só age em novoStatus === 'assinado').
  if (e.includes('partial')) return 'assinado_parcial';
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
      cobranca_id: String(dev.id), // cobranca.id == devedor.id → doc aparece na cobrança no CRM
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

// Item 3: documento de CLIENTE assinado cai sozinho no cadastro (bucket
// 'peticao-assets', tabela 'cliente_documentos'). Espelha salvarAcordoAssinadoNaPasta.
async function salvarClienteAssinadoNaPasta(
  sb: ReturnType<typeof createClient>,
  clienteId: string,
  docId: string,
  signedUrl: string
): Promise<{ salvo: boolean; detalhe: string }> {
  try {
    const path = `clientes/${clienteId}/assinado_${docId}.pdf`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let resp: Response;
    try { resp = await fetch(signedUrl, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
    if (!resp.ok) return { salvo: false, detalhe: 'download HTTP ' + resp.status };
    const ct = resp.headers.get('content-type') || '';
    if (!/pdf|octet-stream/i.test(ct)) return { salvo: false, detalhe: 'content-type inesperado: ' + ct };
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength === 0) return { salvo: false, detalhe: 'arquivo vazio' };
    if (bytes.byteLength > 20 * 1024 * 1024) return { salvo: false, detalhe: 'acima de 20 MB' };
    const { error: upErr } = await sb.storage.from('peticao-assets')
      .upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    if (upErr && !/already exists|duplicate/i.test(String(upErr.message))) {
      return { salvo: false, detalhe: 'upload: ' + upErr.message };
    }
    return { salvo: true, detalhe: path };
  } catch (e) {
    return { salvo: false, detalhe: String((e as Error)?.message || e) };
  }
}

// Casa o doc_id na tabela cliente_documentos (documentos de cliente, não de devedor).
// Atualiza o status e, no assinado, baixa o PDF p/ o cadastro. Retorna se encontrou.
async function tratarDocClienteAssinado(
  sb: ReturnType<typeof createClient>,
  docId: string,
  novoStatus: string,
  signedUrl: string | null
): Promise<{ encontrado: boolean; arquivo?: { salvo: boolean; detalhe: string } }> {
  const { data: docs, error } = await sb.from('cliente_documentos')
    .select('id, cliente_id, zapsign_status').eq('zapsign_doc_id', docId).limit(1);
  if (error || !docs || docs.length === 0) return { encontrado: false };
  const doc = docs[0] as { id: string; cliente_id: string };
  const update: Record<string, unknown> = { zapsign_status: novoStatus };
  if (novoStatus === 'assinado') update.zapsign_signed_at = new Date().toISOString();
  let arquivo: { salvo: boolean; detalhe: string } | undefined;
  if (novoStatus === 'assinado' && signedUrl) {
    arquivo = await salvarClienteAssinadoNaPasta(sb, String(doc.cliente_id), docId, signedUrl);
    if (arquivo.salvo) update.assinado_storage_path = arquivo.detalhe;
    else console.warn('[zapsign-webhook] doc cliente assinado NÃO salvo: ' + arquivo.detalhe);
  }
  await sb.from('cliente_documentos').update(update).eq('id', doc.id);
  return { encontrado: true, arquivo };
}

// === Pós-assinatura no CRM (cobrancas é a fonte do CRM, não acordos) ===========
// O CRM lê o caso de `cobrancas` (view `casos`); o webhook tocava só `acordos`, então
// a assinatura não refletia no caso (ficava "Acordo abandonado"). Estas duas funções
// fecham isso. Best-effort: nunca derrubam o webhook. Invariante: cobranca.id == devedor.id.

// Tira o caso de "abandonado" e marca a assinatura assim que o ZapSign confirma.
async function refletirAssinaturaNoCRM(
  sb: ReturnType<typeof createClient>,
  cobrancaId: string,
  dataAssinatura: string
): Promise<void> {
  try {
    const { data: cob } = await sb.from('cobrancas')
      .select('acordo_final, encerramento').eq('id', cobrancaId).single();
    if (!cob || cob.encerramento) return; // sem caso, ou já encerrado → não rebaixa
    const af = { ...((cob.acordo_final as Record<string, unknown>) || {}), assinado: true, data_assinatura: dataAssinatura };
    await sb.from('cobrancas').update({
      passo_atual: 'Acordo assinado', acordo_final: af, updated_at: new Date().toISOString()
    }).eq('id', cobrancaId);
  } catch (e) {
    console.warn('[zapsign-webhook] refletirAssinaturaNoCRM: ' + String((e as Error)?.message || e));
  }
}

// Conclui o caso quando os boletos saíram: encerramento {tipo:'acordo'} → o caso vai
// p/ a aba Acordos/Formalizados. Idempotente (não reencerra) e registra no histórico.
async function concluirCasoNoCRM(
  sb: ReturnType<typeof createClient>,
  cobrancaId: string,
  emissao: { parcelas?: number; total?: number } | null,
  dataAssinatura: string
): Promise<{ concluido: boolean; detalhe: string }> {
  try {
    const { data: cob } = await sb.from('cobrancas')
      .select('acordo_final, encerramento').eq('id', cobrancaId).single();
    if (!cob) return { concluido: false, detalhe: 'cobrança não encontrada' };
    if (cob.encerramento) return { concluido: false, detalhe: 'já encerrado' };
    const af = (cob.acordo_final as Record<string, unknown>) || {};
    const parc = Number(emissao?.parcelas) || Number(af.parcelas) || 1;
    const total = Number(emissao?.total) || Number(af.total) || 0;
    const formaLegivel = parc + 'x boleto' + (total ? ' · total R$ ' + total.toFixed(2).replace('.', ',') : '');
    const quando = new Date().toISOString();
    await sb.from('cobrancas').update({
      encerramento: { tipo: 'acordo', motivo: 'Acordo firmado: ' + formaLegivel, quando, encerradoPor: null, auto: true },
      acordo_final: { ...af, assinado: true, data_assinatura: dataAssinatura, boletos_emitidos: true },
      passo_atual: 'Acordo assinado', updated_at: quando
    }).eq('id', cobrancaId);
    await sb.from('devedor_eventos').insert({
      devedor_id: cobrancaId, cobranca_id: cobrancaId, tipo: 'acordo_concluido_auto',
      autor_nome: 'Automação (ZapSign → Asaas)',
      payload: { acao: '✅ Caso concluído automaticamente: acordo assinado e boletos emitidos (' + formaLegivel + ').' }
    });
    return { concluido: true, detalhe: formaLegivel };
  } catch (e) {
    return { concluido: false, detalhe: String((e as Error)?.message || e) };
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
  const tokenQs = ACEITAR_TOKEN_QUERYSTRING ? (url.searchParams.get('token') || '') : '';
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
    // Não é acordo de devedor — pode ser documento de CLIENTE (cessão/procuração/etc).
    const cli = await tratarDocClienteAssinado(sb, docId, novoStatus, signedUrl);
    if (cli.encontrado) {
      return new Response(JSON.stringify({ ok: true, tipo: 'cliente', status: novoStatus, doc_id: docId, arquivo: cli.arquivo }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    console.warn('[zapsign-webhook] doc não encontrado (nem acordo nem cliente) pra doc_id=' + docId);
    return new Response(JSON.stringify({ ok: true, warning: 'doc não encontrado', doc_id: docId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const acordo = acordos[0];
  // acordos.status_zapsign tem CHECK (chk_acordos_status_zapsign) que NÃO inclui
  // 'assinado_parcial'; persiste 'enviado' (documento ainda em assinatura) para não
  // violar o constraint e não marcar como 'assinado'. O evento real fica registrado
  // no devedor_eventos abaixo (tipo 'zapsign_assinado_parcial' + raw_event).
  const statusAcordo = novoStatus === 'assinado_parcial' ? 'enviado' : novoStatus;
  const update: Record<string, unknown> = {
    status_zapsign: statusAcordo,
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

  // Reflete a assinatura no caso do CRM já (independe da emissão dos boletos): sai de
  // "Acordo abandonado" e marca acordo_final.assinado.
  if (novoStatus === 'assinado') {
    await refletirAssinaturaNoCRM(sb, acordo.devedor_id, dataAssinatura || new Date().toISOString());
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

  // Conclusão automática do caso no CRM quando os boletos saíram (pedido do escritório:
  // após assinatura → documento → boletos, dar o caso por concluído). Só conclui com
  // emissão OK (boletos emitidos agora OU já emitidos antes); gate/erro NÃO concluem.
  let conclusao: { concluido: boolean; detalhe: string } | null = null;
  if (novoStatus === 'assinado') {
    const em = emissao as { ok?: boolean; skipped?: string; parcelas?: number; total?: number; invoice_url?: string } | null;
    const boletosOk = !!em && em.ok === true && (!!em.invoice_url || em.skipped === 'já emitido');
    if (boletosOk) {
      conclusao = await concluirCasoNoCRM(sb, acordo.devedor_id, em, dataAssinatura || new Date().toISOString());
    }
  }

  await sb.from('devedor_eventos').insert({
    devedor_id: acordo.devedor_id,
    cobranca_id: acordo.devedor_id,
    tipo: 'zapsign_' + novoStatus,
    payload: {
      acao: novoStatus === 'assinado'
        ? '✍️ Acordo assinado no ZapSign — termo salvo na aba Documentos.'
        : 'ZapSign: ' + novoStatus + ' (doc ' + docId + ')',
      raw_event: body.event_type || null,
      doc_id: docId,
      signed_url: signedUrl,
      arquivo_pasta: arquivoPasta,
      emissao,
      conclusao
    }
  });

  return new Response(JSON.stringify({ ok: true, status: novoStatus, acordo_id: acordo.id, arquivo_pasta: arquivoPasta, emissao, conclusao }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});
