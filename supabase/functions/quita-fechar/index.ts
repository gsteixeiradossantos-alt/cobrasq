// Supabase Edge Function: quita-fechar  ⛔ ESQUELETO — ONDA 2 (QuitaFácil)
// **NÃO DEPLOYADA.** Fecha a autonegociação de uma dívida pequena feita pelo
// devedor no portal: reconfere a oferta no servidor, cria o acordo (à vista ou
// parcelado) e gera boleto/PIX (Asaas), devolvendo o link de pagamento.
//
// Fluxo (a completar):
//   1. Recebe { sessao, modo, parcelas } do portal (sessao = token de posse).
//   2. Chama a RPC quita_oferta(sessao) → oferta AUTORITATIVA (elegível? valor,
//      desconto, máx parcelas, parcela mínima, cobranca_id). NUNCA confiar em
//      valores vindos do front — só em modo/parcelas (validados contra a oferta).
//   3. Calcula o acordo: à vista = valor*(1-desc/100); parcelado = valor em N
//      parcelas (respeitando parcela mínima e o teto).
//   4. Cria cobrança no Asaas (boleto/PIX) — reaproveitar o caminho já usado no
//      corrente acordo→boleto (ver asaas-webhook + AUTO_EMIT_ACORDO).
//   5. Grava em `acordos` (forma, valor_total, parcelas[], origem='quitafacil').
//   6. Devolve { ok:true, link } (invoiceUrl/pixQrCode do Asaas).
//
// Secrets: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (plataforma) · ASAAS_API_KEY.
//
// Body:  { sessao: string, modo: 'avista'|'parcelado', parcelas?: number }
// Resp:  { ok:true, link, acordoId } | { ok:false, erro }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const round2 = (n: number) => Math.round(n * 100) / 100;

// Divide `valor` em `n` parcelas, jogando os centavos residuais na 1ª parcela.
function dividirParcelas(valor: number, n: number): number[] {
  if (n <= 1) return [round2(valor)];
  const base = Math.floor((valor / n) * 100) / 100;
  const parcelas = Array(n).fill(base);
  parcelas[0] = round2(valor - base * (n - 1));
  return parcelas;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, erro: "Method not allowed" }, 405);

  try {
    const { sessao, modo, parcelas } = await req.json().catch(() => ({}));
    if (!sessao || typeof sessao !== "string") return json({ ok: false, erro: "Sessão ausente." }, 400);
    if (modo !== "avista" && modo !== "parcelado") return json({ ok: false, erro: "Modo inválido." }, 400);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY");
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 2) Oferta autoritativa (elegibilidade + política do credor) via prova de posse.
    const { data: oferta, error: ofErr } = await supa.rpc("quita_oferta", { p_sessao_token: sessao });
    if (ofErr) return json({ ok: false, erro: "Falha ao validar a oferta." }, 502);
    if (!oferta?.ok || !oferta?.elegivel) return json({ ok: false, erro: "Esta dívida não está elegível à autonegociação." }, 409);

    const valor = Number(oferta.valor_atual) || 0;
    const desc = Number(oferta.desc_avista) || 0;
    const maxP = Number(oferta.max_parcelas) || 12;
    const parcMin = Number(oferta.parcela_min) || 150;

    // 3) Calcula o acordo, revalidando modo/parcelas contra a política.
    let valorTotal: number;
    let plano: number[];
    if (modo === "avista") {
      valorTotal = round2(valor * (1 - desc / 100));
      plano = [valorTotal];
    } else {
      const n = Math.max(1, Math.min(Number(parcelas) || 1, maxP, Math.floor(valor / parcMin) || 1));
      valorTotal = round2(valor);
      plano = dividirParcelas(valorTotal, n);
    }

    // 4) TODO: criar cobrança no Asaas (boleto/PIX) e obter o link de pagamento.
    //    Reaproveitar o caminho do corrente acordo→boleto (asaas-webhook + AUTO_EMIT_ACORDO):
    //    - garantir asaas_customer_id do devedor (criar se faltar, casando por CPF)
    //    - à vista: 1 cobrança BOLETO/PIX; parcelado: installment com `installmentCount`
    if (!ASAAS_API_KEY) return json({ ok: false, erro: "ASAAS_API_KEY não configurada (skeleton)." }, 501);
    const link = ""; // TODO: invoiceUrl / pixQrCode devolvido pelo Asaas

    // 5) TODO: gravar em `acordos` (forma, valor_total=valorTotal, parcelas=plano,
    //    origem='quitafacil', devedor_id/cobranca_id da oferta) e disparar a régua.

    // 6) Resposta (stub até 4 e 5 estarem implementados).
    return json({ ok: false, erro: "quita-fechar ainda não implementado (esqueleto).", debug: { valorTotal, plano, link } }, 501);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
