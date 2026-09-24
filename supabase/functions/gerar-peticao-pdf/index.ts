// Supabase Edge Function: gerar-peticao-pdf
// Converte o HTML de uma petição em PDF via /api/gerar-pdf (Chromium na Vercel) e devolve o PDF
// em base64. O eproc exige PDF; o app hoje salva a peça como HTML (petSalvar) —
// esta função produz o PDF "de verdade" para o peticionamento (Fase 2 eproc).
//
// Diferente de gerar-acordo-termo, NÃO mexe em ZapSign nem em storage: é um
// conversor puro, autenticado. O upload em `documentos` + registro em
// `peticao_geradas`/`proc_peticionamentos` seguem no cliente (mantém a RLS de
// storage com a sessão do usuário, reusando a lógica de petSalvar).
//
// Secrets (já existentes p/ gerar-acordo-termo e asaas-webhook):
//   APP_BASE_URL (onde mora /api/gerar-pdf) · EMIT_ACORDO_SECRET (header x-emit-secret)
//   SUPABASE_URL / SUPABASE_ANON_KEY (injetados pela plataforma)
//
// verify_jwt: true. Body: { html: string }. Resp: { ok:true, base64_pdf, size }.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Autenticação: só usuário logado (mesmo padrão de peticao-assistente).
  const authHeader = req.headers.get("authorization") || "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: errAuth } = await userClient.auth.getUser();
  if (errAuth || !user) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "JSON inválido" }, 400); }

  const html = body?.html;
  if (!html || typeof html !== "string") return json({ error: 'Campo "html" obrigatório.' }, 400);

  const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") || "").replace(/\/+$/, "");
  const EMIT_SECRET = Deno.env.get("EMIT_ACORDO_SECRET");
  if (!APP_BASE_URL || !EMIT_SECRET) return json({ error: "APP_BASE_URL ou EMIT_ACORDO_SECRET não configurados nos secrets." }, 500);

  try {
    const gResp = await fetch(`${APP_BASE_URL}/api/gerar-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-emit-secret": EMIT_SECRET },
      body: JSON.stringify({ html }),
      signal: AbortSignal.timeout(60000),
    });
    const gJson = await gResp.json().catch(() => ({} as Record<string, unknown>));
    if (!gResp.ok || !gJson?.base64) {
      return json({ error: `Geração do PDF falhou (HTTP ${gResp.status})`, detalhes: String(gJson?.error || "").slice(0, 500) }, 502);
    }
    const base64_pdf = String(gJson.base64);
    // size = bytes do PDF (base64 → 3/4, descontando o padding)
    const size = Math.floor(base64_pdf.length * 3 / 4) - (base64_pdf.endsWith("==") ? 2 : base64_pdf.endsWith("=") ? 1 : 0);
    return json({ ok: true, base64_pdf, size });
  } catch (e) {
    return json({ error: "Falha ao gerar PDF: " + (e instanceof Error ? e.message : String(e)) }, 502);
  }
});
