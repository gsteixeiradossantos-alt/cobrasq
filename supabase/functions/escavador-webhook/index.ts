// Supabase Edge Function: escavador-webhook
// Recebe push do Escavador quando há nova intimação/movimentação processual.
// Salva em proc_intimacoes e (se houver match com processo cadastrado) vincula ao devedor.
//
// Setup (depois de contratar Escavador e ter API key):
//   supabase secrets set ESCAVADOR_TOKEN=<seu_token>
//   supabase functions deploy escavador-webhook
//   No painel Escavador: configurar callback URL = https://<project>.supabase.co/functions/v1/escavador-webhook
//
// Spec: docs/specs/site-app.md item S13

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-escavador-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

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

  try {
    // TODO: validar assinatura do webhook quando Escavador documentar formato
    // const signature = req.headers.get('x-escavador-signature');
    // if (!verifySignature(signature, body)) return 401;

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

    // Tenta vincular ao devedor via número de processo
    let devedorId: string | null = null;
    if (payload.processo_numero) {
      // Busca devedor com esse processo no campo metadata.processoNum
      const { data: devs } = await supabase
        .from('devedores')
        .select('id')
        .or(`metadata->>processoNum.eq.${payload.processo_numero},encaminhamento_judicial->>processoNum.eq.${payload.processo_numero}`)
        .limit(1);
      if (devs && devs.length > 0) devedorId = devs[0].id;
    }

    const { data, error } = await supabase
      .from('proc_intimacoes')
      .insert({
        fonte: 'escavador',
        processo_num: payload.processo_numero || null,
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
