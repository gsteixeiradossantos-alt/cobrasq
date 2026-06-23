// Supabase Edge Function: gerar-peticao-pdf
// Converte o HTML de uma petição em PDF via Gotenberg (Chromium) e devolve o PDF
// em base64. O eproc exige PDF; o app hoje salva a peça como HTML (petSalvar) —
// esta função produz o PDF "de verdade" para o peticionamento (Fase 2 eproc).
//
// Diferente de gerar-acordo-termo, NÃO mexe em ZapSign nem em storage: é um
// conversor puro, autenticado. O upload em `documentos` + registro em
// `peticao_geradas`/`proc_peticionamentos` seguem no cliente (mantém a RLS de
// storage com a sessão do usuário, reusando a lógica de petSalvar).
//
// Secrets (já existentes p/ gerar-acordo-termo):
//   GOTENBERG_URL=https://...   ·   GOTENBERG_USER / GOTENBERG_PASS (opcional)
//   SUPABASE_URL / SUPABASE_ANON_KEY (injetados pela plataforma)
//
// verify_jwt: true. Body: { html: string }. Resp: { ok:true, base64_pdf, size }.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

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

  const GOTENBERG_URL = (Deno.env.get("GOTENBERG_URL") || "").replace(/\/+$/, "");
  if (!GOTENBERG_URL) return json({ error: "GOTENBERG_URL não configurado nos secrets." }, 500);
  const gUser = Deno.env.get("GOTENBERG_USER");
  const gPass = Deno.env.get("GOTENBERG_PASS");
  const gHeaders: Record<string, string> = {};
  if (gUser && gPass) gHeaders["Authorization"] = "Basic " + btoa(`${gUser}:${gPass}`);

  try {
    const fd = new FormData();
    fd.append("files", new File([html], "index.html", { type: "text/html" }));
    fd.append("preferCssPageSize", "true");
    fd.append("printBackground", "true");
    const gResp = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, {
      method: "POST", body: fd, headers: gHeaders, signal: AbortSignal.timeout(60000),
    });
    if (!gResp.ok) {
      const t = await gResp.text().catch(() => "");
      return json({ error: `Gotenberg falhou (HTTP ${gResp.status})`, detalhes: t.slice(0, 500) }, 502);
    }
    const pdfBytes = new Uint8Array(await gResp.arrayBuffer());
    return json({ ok: true, base64_pdf: encodeBase64(pdfBytes), size: pdfBytes.length });
  } catch (e) {
    return json({ error: "Falha ao gerar PDF: " + (e instanceof Error ? e.message : String(e)) }, 502);
  }
});
