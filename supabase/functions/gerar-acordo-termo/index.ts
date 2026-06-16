// Supabase Edge Function: gerar-acordo-termo
// Fase 2 / recorte 1 (extrajudicial). Recebe o HTML do termo (montado no CRM),
// renderiza em PDF via Gotenberg, cria o documento no ZapSign (base64_pdf) e
// grava/vincula em `acordos` via RPC. Substitui o caminho planilha→n8n→Google Doc
// para o acordo extrajudicial. O n8n só permanece no pós-assinatura.
//
// Secrets (supabase secrets set ...):
//   GOTENBERG_URL=https://...up.railway.app
//   ZAPSIGN_TOKEN=<token da API do ZapSign>
//   GOTENBERG_USER / GOTENBERG_PASS  (opcional — basic auth do Gotenberg)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (injetados pela plataforma)
//
// Body: { casoId, html, dados }  (dados = shape do TermoEngine; dados.devedores = N signatários)
// Resp: { ok:true, token, link, signers:[{nome,phone,link}] } | { error: '...' , detalhes? }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const onlyDigits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
// A RPC espera valor BR ("1.234,56") e data "dd/mm/aaaa".
const valorBR = (v: unknown) => String(v ?? "").replace(".", ",");
const isoToBR = (iso: unknown) => {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { casoId, html, dados } = await req.json().catch(() => ({}));
    if (!html || typeof html !== "string") return json({ error: 'Campo "html" obrigatório.' }, 400);
    if (!dados || !dados.devedor) return json({ error: 'Campo "dados" obrigatório.' }, 400);

    const GOTENBERG_URL = (Deno.env.get("GOTENBERG_URL") || "").replace(/\/+$/, "");
    const ZAPSIGN_TOKEN = Deno.env.get("ZAPSIGN_TOKEN");
    if (!GOTENBERG_URL || !ZAPSIGN_TOKEN) {
      return json({ error: "GOTENBERG_URL ou ZAPSIGN_TOKEN não configurados nos secrets." }, 500);
    }
    const gUser = Deno.env.get("GOTENBERG_USER");
    const gPass = Deno.env.get("GOTENBERG_PASS");
    const gHeaders: Record<string, string> = {};
    if (gUser && gPass) gHeaders["Authorization"] = "Basic " + btoa(`${gUser}:${gPass}`);

    // 1) HTML -> PDF (Gotenberg / Chromium)
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
    const base64_pdf = encodeBase64(pdfBytes);

    // 2) Cria o documento no ZapSign (mesmos campos do nó n8n; url_pdf -> base64_pdf)
    const devs = (Array.isArray(dados.devedores) && dados.devedores.length)
      ? dados.devedores : (dados.devedor ? [dados.devedor] : []);
    const dev = devs[0] || {};
    const zapBody = {
      name: (String(dev.nome || "Devedor").trim() + " - Acordo Extrajudicial"),
      base64_pdf,
      external_id: String(casoId ?? ""),
      // Um signer por devedor; cada um assina na sua âncora <<assdevN>> (1-based).
      // O CRM envia o link por WhatsApp via Z-API (número COBRASQ); o ZapSign NÃO envia
      // automaticamente (senão o devedor receberia duas mensagens).
      signers: devs.map((d: any, i: number) => ({
        name: d.nome || "",
        email: null,
        auth_mode: "assinaturaTela",
        send_automatic_email: false,
        send_automatic_whatsapp: false,
        phone_country: "55",
        phone_number: onlyDigits(d.telefone),
        require_cpf: true,
        cpf: onlyDigits(d.documento),
        require_selfie_photo: true,
        require_document_photo: true,
        selfie_validation_type: "none",
        signature_placement: "<<assdev" + (i + 1) + ">>",
      })),
      lang: "pt-br",
      disable_signer_emails: false,
      folder_path: "/",
      date_limit_to_sign: null,
      signature_order_active: false,
      observers: [],
      reminder_every_n_days: 0,
      allow_refuse_signature: false,
      disable_signers_get_original_file: false,
    };
    const zResp = await fetch("https://api.zapsign.com.br/api/v1/docs/", {
      method: "POST",
      headers: { "Authorization": `Bearer ${ZAPSIGN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(zapBody),
      signal: AbortSignal.timeout(30000),
    });
    const zap = await zResp.json().catch(() => ({}));
    if (!zResp.ok) {
      return json({ error: "ZapSign recusou: " + (zap?.detail || zap?.error || `HTTP ${zResp.status}`), detalhes: zap }, 502);
    }
    const token = zap.token || (zap.doc && zap.doc.token);
    const linkDe = (s: any) => (s && (s.sign_url || s.signing_link || s.signUrl || s.link)) || null;
    // Casa cada devedor (na ordem enviada) com o signer devolvido pelo ZapSign.
    const mapSigners = (z: any) => {
      const arr = (z && z.signers) || [];
      return devs.map((d: any, i: number) => ({
        nome: d.nome || "",
        phone: onlyDigits(d.telefone),
        link: linkDe(arr[i]),
      }));
    };
    let signersOut = mapSigners(zap);
    // A resposta de criação nem sempre traz sign_url; nesse caso, consulta o doc criado.
    if (signersOut.some((s) => !s.link) && token) {
      try {
        const dResp = await fetch(`https://api.zapsign.com.br/api/v1/docs/${token}/`, {
          headers: { "Authorization": `Bearer ${ZAPSIGN_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        });
        if (dResp.ok) {
          const remapped = mapSigners(await dResp.json().catch(() => ({})));
          signersOut = signersOut.map((s, i) => (s.link ? s : remapped[i]));
        }
      } catch (_) { /* mantém links null — o front avisa e o operador envia manualmente */ }
    }
    const link = (signersOut[0] && signersOut[0].link) || null;

    // 3) Grava/vincula em `acordos` (F-08 — server-side, via RPC existente)
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    let vinculo = "skip";
    if (SUPABASE_URL && SERVICE_KEY && token) {
      const ac = dados.acordo || {};
      const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/vincular_zapsign_acordo`, {
        method: "POST",
        headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          p_doc_token: token,
          p_external_id: String(casoId ?? ""),
          p_cpf_dev: onlyDigits(dev.documento),
          p_telefone: onlyDigits(dev.telefone),
          p_valor_total: valorBR(ac.total),
          p_num_parcelas: parseInt(String(ac.parcelas ?? "1"), 10) || null,
          p_data_primeiro_venc: isoToBR(ac.vencimento),
          p_forma: "boleto",
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (rpcResp.ok) {
        const rj = await rpcResp.json().catch(() => null);
        vinculo = (rj && typeof rj === "object")
          ? (rj.ok ? (rj.acao || "ok") : ("nao_vinculado: " + (rj.motivo || "?")))
          : "ok";
      } else {
        vinculo = "erro:" + rpcResp.status + ":" + (await rpcResp.text().catch(() => "")).slice(0, 200);
      }
    }

    return json({ ok: true, token, link, signers: signersOut, vinculo });
  } catch (e) {
    return json({ error: "Erro interno: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
