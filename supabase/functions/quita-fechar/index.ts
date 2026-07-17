// Supabase Edge Function: quita-fechar  — ONDA 2 (QuitaFácil)
// Fecha a autonegociação de uma dívida pequena feita pelo próprio devedor no portal.
// Roda como EDGE (Deno) de propósito: o teto de 12 funções da Vercel (Hobby) já está
// cheio, e o portal é ANON — a prova de posse é o token de sessão, validado server-side.
//
// Fluxo:
//   1. { sessao, modo, parcelas } → valida a oferta AUTORITATIVA via quita_oferta
//      (elegibilidade + política do credor). Nunca confia em valores do front.
//   2. Garante o customer no Asaas (por CPF) — porta ensureAsaasCustomer do api/_asaas.js.
//   3. Grava o acordo em `acordos` (mesmas colunas do fluxo n8n/zapsign).
//   4. Cria a cobrança no Asaas (1x = boleto único; 2x+ = installment) e devolve o link.
//   5. Atualiza o acordo com os ids/URL do Asaas (idempotência + reconciliação webhook).
//
// A baixa por parcela e o repasse são fechados pelo asaas-webhook já existente
// (externalReference = acordo.id).
//
// Secrets: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (plataforma) · ASAAS_API_KEY ·
//          ASAAS_ENV (sandbox|production, default sandbox).
//
// Body:  { sessao: string, modo: 'avista'|'parcelado', parcelas?: number }
// Resp:  { ok:true, link, acordoId, parcelas, total } | { ok:false, erro }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const onlyDigits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const addDaysISO = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

// Divide `valor` em `n` parcelas, jogando o residual de centavos na 1ª.
function dividirParcelas(valor: number, n: number, firstDue: string): { numero: number; valor: number; vencimento: string; pago: boolean }[] {
  const vals: number[] = [];
  if (n <= 1) vals.push(round2(valor));
  else {
    const base = Math.floor((valor / n) * 100) / 100;
    for (let i = 0; i < n; i++) vals.push(base);
    vals[0] = round2(valor - base * (n - 1));
  }
  const d0 = new Date(firstDue + "T12:00:00");
  return vals.map((v, i) => {
    const dv = new Date(d0); dv.setMonth(dv.getMonth() + i);
    return { numero: i + 1, valor: v, vencimento: dv.toISOString().slice(0, 10), pago: false };
  });
}

// ── Asaas (porta o api/_asaas.js para Deno) ────────────────────────────────
const ASAAS_ENV = Deno.env.get("ASAAS_ENV") || "sandbox";
const ASAAS_BASE = ASAAS_ENV === "production"
  ? "https://www.asaas.com/api/v3"
  : "https://sandbox.asaas.com/api/v3";

async function asaasReq(method: string, path: string, data?: unknown) {
  const key = Deno.env.get("ASAAS_API_KEY");
  if (!key) throw new Error("ASAAS_API_KEY não configurada no servidor.");
  const opts: RequestInit = {
    method,
    headers: { access_token: key, "Content-Type": "application/json", "User-Agent": "COBRASQ-Server/1.0" },
  };
  if (data && !["GET", "DELETE", "HEAD"].includes(method)) opts.body = JSON.stringify(data);
  const r = await fetch(`${ASAAS_BASE}/${String(path).replace(/^\/+/, "")}`, opts);
  const text = await r.text();
  let j: any; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(j?.errors?.[0]?.description || j?.message || `Asaas ${r.status}`);
  return j;
}

function buildAsaasAddress(dev: any) {
  const ec = (dev && dev.endereco_crm) || {};
  const a: Record<string, string> = {};
  const cep = onlyDigits(dev.cep || ec.cep);
  if (cep) a.postalCode = cep;
  const rua = String(ec.rua || ec.logradouro || dev.endereco || "").trim();
  if (rua) a.address = rua;
  const num = String(dev.numero || ec.numero || "").trim();
  if (num) a.addressNumber = num;
  const comp = String(dev.complemento || ec.complemento || "").trim();
  if (comp) a.complement = comp;
  const bairro = String(dev.bairro || ec.bairro || "").trim();
  if (bairro) a.province = bairro;
  return a;
}

async function ensureAsaasCustomer(dev: any): Promise<{ customerId: string; created: boolean }> {
  const addr = buildAsaasAddress(dev);
  const hasAddr = Object.keys(addr).length > 0;
  if (dev.asaas_customer_id) {
    if (hasAddr) { try { await asaasReq("PUT", `/customers/${dev.asaas_customer_id}`, addr); } catch { /* best-effort */ } }
    return { customerId: dev.asaas_customer_id, created: false };
  }
  const doc = onlyDigits(dev.doc);
  if (!doc) throw new Error("Devedor sem CPF/CNPJ cadastrado.");
  const found = await asaasReq("GET", `/customers?cpfCnpj=${encodeURIComponent(doc)}`);
  if (found?.data?.length) {
    const id = found.data[0].id;
    if (hasAddr) { try { await asaasReq("PUT", `/customers/${id}`, addr); } catch { /* best-effort */ } }
    return { customerId: id, created: false };
  }
  const created = await asaasReq("POST", "/customers", {
    name: dev.nome || "Devedor",
    cpfCnpj: doc,
    email: dev.email || undefined,
    mobilePhone: dev.telefone ? onlyDigits(dev.telefone) : undefined,
    ...addr,
    notificationDisabled: true,
  });
  return { customerId: created.id, created: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, erro: "Method not allowed" }, 405);

  try {
    const { sessao, modo, parcelas } = await req.json().catch(() => ({}));
    if (!sessao || typeof sessao !== "string") return json({ ok: false, erro: "Sessão ausente." }, 400);
    if (modo !== "avista" && modo !== "parcelado") return json({ ok: false, erro: "Modo inválido." }, 400);

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 1) Oferta autoritativa (prova de posse via token de sessão).
    const { data: oferta, error: ofErr } = await supa.rpc("quita_oferta", { p_sessao_token: sessao });
    if (ofErr) return json({ ok: false, erro: "Falha ao validar a oferta." }, 502);
    if (!oferta?.ok || !oferta?.elegivel) return json({ ok: false, erro: "Esta dívida não está elegível à autonegociação." }, 409);

    const devedorId = oferta.devedor_id;
    const cobrancaId = oferta.cobranca_id || null;
    const valor = Number(oferta.valor_atual) || 0;
    const desc = Number(oferta.desc_avista) || 0;
    const maxP = Number(oferta.max_parcelas) || 12;
    const parcMin = Number(oferta.parcela_min) || 150;
    if (!devedorId || !(valor > 0)) return json({ ok: false, erro: "Dívida sem valor válido." }, 409);

    // 2) Plano (revalida modo/parcelas contra a política).
    const firstDue = addDaysISO(3);
    let n: number, valorTotal: number, forma: string;
    if (modo === "avista") {
      n = 1; forma = "avista"; valorTotal = round2(valor * (1 - desc / 100));
    } else {
      n = Math.max(1, Math.min(Number(parcelas) || 1, maxP, Math.floor(valor / parcMin) || 1));
      forma = n > 1 ? "boleto" : "avista";
      valorTotal = round2(valor); // parcelado = valor cheio (desconto só à vista)
    }
    const plano = dividirParcelas(valorTotal, n, firstDue);

    // 3) Devedor (service role — anon não lê).
    const { data: devs } = await supa.from("devedores")
      .select("id,nome,doc,email,telefone,asaas_customer_id,cep,numero,complemento,bairro,cidade,uf,endereco,endereco_crm")
      .eq("id", devedorId).limit(1);
    const dev = devs?.[0];
    if (!dev) return json({ ok: false, erro: "Cadastro não encontrado." }, 404);

    // 4) Idempotência leve: acordo QuitaFácil já emitido p/ esta cobrança → devolve o link.
    if (cobrancaId) {
      const { data: jaAcs } = await supa.from("acordos")
        .select("id,metadata").eq("cobranca_id", cobrancaId).limit(20);
      const ja = (jaAcs || []).find((a: any) => a?.metadata?.origem === "quitafacil" && a?.metadata?.asaas_invoice_url);
      if (ja) return json({ ok: true, link: ja.metadata.asaas_invoice_url, acordoId: ja.id, reaproveitado: true });
    }

    // 5) Customer Asaas (cria/acha por CPF); persiste o id se novo.
    const { customerId } = await ensureAsaasCustomer(dev);
    if (customerId && customerId !== dev.asaas_customer_id) {
      await supa.from("devedores").update({ asaas_customer_id: customerId }).eq("id", dev.id).then(() => {}, () => {});
    }

    // 6) Grava o acordo (status ativo; origem quitafacil).
    const { data: acIns, error: acErr } = await supa.from("acordos").insert({
      devedor_id: dev.id,
      cobranca_id: cobrancaId,
      forma,
      status: "ativo",
      num_parcelas: n,
      valor_total: valorTotal,
      data_primeiro_venc: firstDue,
      parcelas: plano,
      metadata: { origem: "quitafacil", criado_via: "portal", desconto_avista_pct: modo === "avista" ? desc : 0 },
    }).select("id").single();
    if (acErr || !acIns?.id) return json({ ok: false, erro: "Falha ao registrar o acordo." }, 500);
    const acordoId = acIns.id;

    // 7) Cobrança no Asaas (1x = boleto único; 2x+ = installment). externalReference = acordo.id.
    const pay: Record<string, unknown> = {
      customer: customerId,
      billingType: "BOLETO",
      dueDate: firstDue,
      description: `QuitaFácil ${dev.nome}${n > 1 ? ` — ${n}x` : " — à vista"}`,
      externalReference: acordoId,
      fine: { value: 2 },
      interest: { value: 1 },
    };
    if (n > 1) { pay.installmentCount = n; pay.totalValue = valorTotal; }
    else { pay.value = valorTotal; }

    let charge: any;
    try { charge = await asaasReq("POST", "/payments", pay); }
    catch (e) {
      // Reverte o acordo p/ não deixar registro sem cobrança.
      await supa.from("acordos").update({ status: "cancelado", metadata: { origem: "quitafacil", erro_emissao: String((e as Error)?.message || e) } }).eq("id", acordoId).then(() => {}, () => {});
      return json({ ok: false, erro: "Não foi possível gerar o pagamento agora. Tente de novo em instantes." }, 502);
    }
    const invoiceUrl = charge.invoiceUrl || charge.bankSlipUrl || "";

    // 8) Atualiza o acordo com os ids/URL do Asaas.
    await supa.from("acordos").update({
      metadata: {
        origem: "quitafacil", criado_via: "portal",
        desconto_avista_pct: modo === "avista" ? desc : 0,
        boletos_emitidos: true, emitido_em: new Date().toISOString(),
        asaas_installment_id: charge.installment || null,
        asaas_first_payment_id: charge.id || null,
        asaas_invoice_url: invoiceUrl,
        asaas_customer_id: customerId,
      },
    }).eq("id", acordoId).then(() => {}, () => {});

    // 9) Trilha (best-effort).
    await supa.from("devedor_eventos").insert({
      devedor_id: dev.id, cobranca_id: cobrancaId, tipo: "quita_acordo_fechado",
      payload: { acordo_id: acordoId, modo, parcelas: n, total: valorTotal, invoice_url: invoiceUrl },
      autor_nome: "QuitaFácil (autonegociação)",
    }).then(() => {}, () => {});

    return json({ ok: true, link: invoiceUrl, acordoId, parcelas: n, total: valorTotal });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
