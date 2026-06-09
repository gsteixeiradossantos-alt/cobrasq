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

// Comparação de tokens em tempo constante para mitigar timing attack.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
  if (!provided || !timingSafeEqual(provided, expected)) {
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

    // Tenta vincular ao devedor via número de processo (apenas se for CNJ válido)
    let devedorId: string | null = null;
    if (isProcessoValido(payload.processo_numero)) {
      // .or() interpola direto na query do PostgREST; sem validação prévia,
      // vírgula ou parêntese no payload quebra o filtro. Por isso só rodamos
      // a busca depois de validar contra o regex CNJ.
      const num = payload.processo_numero;
      const { data: devs } = await supabase
        .from('devedores')
        .select('id')
        .or(`metadata->>processoNum.eq.${num},encaminhamento_judicial->>processoNum.eq.${num}`)
        .limit(1);
      if (devs && devs.length > 0) devedorId = devs[0].id;
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
