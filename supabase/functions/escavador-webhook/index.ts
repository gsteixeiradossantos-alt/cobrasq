// Supabase Edge Function: escavador-webhook
// Recebe push do Escavador quando há nova intimação/movimentação processual.
// Salva em proc_intimacoes e (se houver match com processo cadastrado) vincula ao devedor.
//
// Setup (depois de contratar Escavador e ter API key):
//   supabase secrets set ESCAVADOR_WEBHOOK_TOKEN=<token-aleatorio-forte>
//   supabase functions deploy escavador-webhook
//   No painel Escavador: callback URL = https://<project>.supabase.co/functions/v1/escavador-webhook
//   No painel Escavador: header customizado Authorization: Bearer <token-aleatorio-forte>
//
// Spec: docs/specs/site-app.md item S13

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-escavador-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Aceita formatos comuns de número CNJ: 0001234-56.2024.8.16.0001
// (NNNNNNN-DD.AAAA.J.TR.OOOO). Aceita também só dígitos (20 chars).
const CNJ_FORMATADO = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;
const CNJ_NUMERICO  = /^\d{20}$/;

function isProcessoValido(num: unknown): num is string {
  if (typeof num !== 'string') return false;
  return CNJ_FORMATADO.test(num) || CNJ_NUMERICO.test(num);
}

// Comparação em tempo constante (mesmo padrão do asaas/zapsign/zapi-webhook, F-18):
// compara o SHA-256 dos dois lados, o que normaliza o comprimento e não faz
// short-circuit — não vaza o tamanho do segredo por timing.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Autorização: exige bearer token configurado em ESCAVADOR_WEBHOOK_TOKEN.
  // (Quando Escavador publicar HMAC assinado, trocar para verifySignature.)
  const expected = Deno.env.get('ESCAVADOR_WEBHOOK_TOKEN') || '';
  if (!expected) {
    return new Response(JSON.stringify({ error: 'Webhook não configurado no servidor (ESCAVADOR_WEBHOOK_TOKEN ausente).' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const auth = req.headers.get('authorization') || '';
  const provided = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!provided || !(await safeEqual(provided, expected))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const payload = await req.json().catch(() => ({}));

    // Formato esperado (genérico — ajustar conforme docs do Escavador):
    // {
    //   processo_numero: "0001234-56.2024.8.16.0001",
    //   data_publicacao: "2026-05-10",
    //   data_intimacao: "2026-05-12",
    //   conteudo: "...texto da intimação...",
    //   link_diario: "https://...",
    //   oab: "PR12345"
    // }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Tenta vincular ao devedor via número de processo (apenas se for CNJ válido).
    // Fonte única do número é cobrancas.numero_processo (Fase C, 2026-06-19a). Pela
    // invariante 2026-06-15 (cobranca.id = id do devedor principal), o devedor_id é
    // o próprio cobranca.id. O número pode estar gravado formatado ou só dígitos,
    // então casamos as duas formas. Os valores derivam do CNJ já validado pelo
    // regex acima (sem injeção no .or() do PostgREST).
    let devedorId: string | null = null;
    if (isProcessoValido(payload.processo_numero)) {
      const dig = payload.processo_numero.replace(/\D/g, '');
      const formatado = `${dig.slice(0, 7)}-${dig.slice(7, 9)}.${dig.slice(9, 13)}.${dig.slice(13, 14)}.${dig.slice(14, 16)}.${dig.slice(16, 20)}`;
      const { data: cobs } = await supabase
        .from('cobrancas')
        .select('id')
        .or(`numero_processo.eq.${formatado},numero_processo.eq.${dig}`)
        .limit(1);
      if (cobs && cobs.length > 0) devedorId = cobs[0].id;
    }

    const { data, error } = await supabase
      .from('proc_intimacoes')
      .insert({
        fonte: 'escavador',
        processo_num: isProcessoValido(payload.processo_numero) ? payload.processo_numero : null,
        oab: payload.oab || null,
        data_publicacao: payload.data_publicacao || null,
        data_intimacao: payload.data_intimacao || null,
        conteudo: payload.conteudo || '',
        link_diario: payload.link_diario || null,
        devedor_id: devedorId,
        lida: false
      })
      .select()
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: 'DB insert failed: ' + error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ ok: true, id: data.id, vinculado_a_devedor: devedorId }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Erro interno: ' + (e instanceof Error ? e.message : String(e)) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
