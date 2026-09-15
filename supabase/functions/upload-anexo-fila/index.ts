// Supabase Edge Function: upload-anexo-fila
//
// Só faz UMA coisa: recebe um PDF em base64 e grava no bucket `documentos`, pronto
// para uma linha de `crm_mensagens_agendadas` (tipo='documento', media_path=<path
// devolvido>) apontar para ele. Existe porque o upload direto ao Storage via REST
// exige a `service_role` (a RLS de `storage.objects` não libera `anon` nem
// `authenticated` sem sessão de login para os caminhos que a fila usa — ver
// whatsapp-cobrasq §4), e essa chave está marcada "Sensitive" no Vercel do
// cobrasq-faturamento: não sai por `vercel env pull` nem por nenhuma ferramenta de MCP.
// Rodando como Edge Function, a `SUPABASE_SERVICE_ROLE_KEY` é injetada automaticamente
// pelo próprio Supabase — sem precisar configurar nem revelar segredo nenhum.
//
// Autenticação: mesmo padrão de cron-mensagens-agendadas — header
// `Authorization: Bearer <CRON_INVOKE_SECRET>` (o mesmo segredo já usado para disparar
// aquele worker manualmente; não precisa criar segredo novo nem novo Vault entry).
//
// Uso (a partir de uma sessão com acesso ao Supabase MCP, sem nenhuma chave do Vercel):
//   select net.http_post(
//     url := 'https://<project-ref>.functions.supabase.co/upload-anexo-fila',
//     headers := jsonb_build_object('Authorization','Bearer <CRON_INVOKE_SECRET>','Content-Type','application/json'),
//     body := jsonb_build_object('base64', '<pdf em base64>', 'filename', 'relatorio-x.pdf'),
//     timeout_milliseconds := 25000
//   );
// A resposta traz { path: 'manual/fila-whatsapp/<timestamp>-<nome>.pdf' } — esse é o
// valor que vai em `crm_mensagens_agendadas.media_path`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUCKET = 'documentos';
const MAX_BYTES = 15 * 1024 * 1024; // mesmo teto de anexo do WhatsApp via Z-API

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }

  const expected = Deno.env.get('CRON_INVOKE_SECRET');
  if (!expected) return new Response(JSON.stringify({ error: 'CRON_INVOKE_SECRET não configurado' }), { status: 500 });
  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided !== expected) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  // DELETE: limpeza de arquivo de teste/obsoleto — só dentro de manual/fila-whatsapp/,
  // mesma pasta que o POST usa. Não é uso de rotina (a fila não apaga anexo enviado);
  // existe para não deixar lixo de teste no bucket.
  if (req.method === 'DELETE') {
    let body: any;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'body inválido: esperado JSON' }), { status: 400 }); }
    const path = String(body?.path || '');
    if (!path.startsWith('manual/fila-whatsapp/')) {
      return new Response(JSON.stringify({ error: 'só apaga dentro de manual/fila-whatsapp/' }), { status: 400 });
    }
    const sbDel = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { error: delErr } = await sbDel.storage.from(BUCKET).remove([path]);
    if (delErr) return new Response(JSON.stringify({ error: 'delete falhou: ' + delErr.message }), { status: 500 });
    return new Response(JSON.stringify({ deleted: path }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'body inválido: esperado JSON' }), { status: 400 });
  }

  const base64 = String(payload?.base64 || '');
  const filenameIn = String(payload?.filename || 'documento.pdf');
  // Prefixo livre, mas preso a `manual/` — não deixa a função virar upload genérico
  // para qualquer caminho do bucket.
  const prefix = 'manual/fila-whatsapp';

  if (!base64) return new Response(JSON.stringify({ error: 'campo base64 ausente' }), { status: 400 });

  let bytes: Uint8Array;
  try {
    const bin = atob(base64.replace(/^data:application\/pdf;base64,/, ''));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return new Response(JSON.stringify({ error: 'base64 inválido' }), { status: 400 });
  }

  if (bytes.byteLength === 0) return new Response(JSON.stringify({ error: 'arquivo vazio' }), { status: 400 });
  if (bytes.byteLength > MAX_BYTES) {
    return new Response(JSON.stringify({ error: `arquivo maior que ${MAX_BYTES} bytes` }), { status: 400 });
  }

  // Só PDF de verdade — mesma barreira que _repasse-msg.js usa, para não anexar HTML
  // ou outro conteúdo por engano.
  const header = new TextDecoder('latin1').decode(bytes.slice(0, 4));
  if (header !== '%PDF') {
    return new Response(JSON.stringify({ error: 'conteúdo não começa com %PDF' }), { status: 400 });
  }

  const safeName = filenameIn.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80).replace(/\.pdf$/i, '') || 'documento';
  const path = `${prefix}/${Date.now()}-${safeName}.pdf`;

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (error) {
    return new Response(JSON.stringify({ error: 'upload falhou: ' + error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ path, bytes: bytes.byteLength }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
