// Supabase Edge Function: enviar-whatsapp (v3)
// Antes de enviar, verifica se o número tem WhatsApp via Z-API /phone-exists.
// Tenta com e sem o 9 do DDD (alguns números são registrados no WhatsApp
// sem o 9, outros com). Retorna 422 se nenhuma variação existe.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function variantesComEsem9(phoneFinal: string): string[] {
  // phoneFinal: 55 + DDD(2) + 8 ou 9 dígitos
  const variantes = [phoneFinal];
  if (phoneFinal.length === 13) {
    // 55 + DDD(2) + 9 + 8 dígitos -> tenta sem o 9
    const semNove = phoneFinal.substring(0, 4) + phoneFinal.substring(5);
    variantes.push(semNove);
  } else if (phoneFinal.length === 12) {
    // 55 + DDD(2) + 8 dígitos -> insere 9 após DDD
    const comNove = phoneFinal.substring(0, 4) + '9' + phoneFinal.substring(4);
    variantes.push(comNove);
  }
  return variantes;
}

async function phoneExistsOnWhatsApp(instance: string, token: string, clientToken: string | undefined, phone: string): Promise<boolean> {
  try {
    const url = `https://api.z-api.io/instances/${instance}/token/${token}/phone-exists/${phone}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (clientToken) headers['Client-Token'] = clientToken;
    const r = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(7000) });
    if (!r.ok) return false;
    const data = await r.json().catch(() => null);
    if (data == null) return false;
    if (typeof data.exists === 'boolean') return data.exists;
    if (typeof data.isUser === 'boolean') return data.isUser;
    return false;
  } catch {
    return false;
  }
}

// Z-API às vezes responde HTTP 200 mesmo sem entregar (instância desconectada):
// o corpo vem sem identificador de mensagem ou com campo de erro. Só consideramos
// enviado quando há messageId/zaapId/id E não há indicação de erro. (Mesma lógica
// das funções irmãs cron-mensagens-agendadas e bia-atendimento.)
function envioConfirmado(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  const temId = !!(data.messageId || data.zaapId || data.id || data.messageID);
  const temErro = !!data.error || !!data.errorDescription || data.value === false || data.success === false;
  return temId && !temErro;
}

async function callZapiSendText(url: string, headers: Record<string, string>, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const delays = [1000, 2000, 4000];
  for (let i = 0; i <= delays.length; i++) {
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
    } catch (e) {
      if (i < delays.length) { await new Promise(res => setTimeout(res, delays[i])); continue; }
      return { ok: false, status: 0, data: { error: 'timeout/network: ' + (e instanceof Error ? e.message : String(e)) } };
    }
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, status: r.status, data };
    if ((r.status === 429 || r.status >= 500) && i < delays.length) {
      await new Promise(res => setTimeout(res, delays[i]));
      continue;
    }
    return { ok: false, status: r.status, data };
  }
  return { ok: false, status: 0, data: { error: 'esgotou tentativas' } };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json().catch(() => ({}));
    const { telefone, mensagem, skipPhoneExists } = body;

    if (!telefone || !mensagem) {
      return new Response(JSON.stringify({ error: 'Campos "telefone" e "mensagem" são obrigatórios.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (typeof mensagem !== 'string' || mensagem.length > 4096) {
      return new Response(JSON.stringify({ error: 'Mensagem inválida ou muito longa.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const phoneDigits = String(telefone).replace(/\D/g, '');
    const phoneNormalizado = phoneDigits.startsWith('55') ? phoneDigits : '55' + phoneDigits;
    if (phoneNormalizado.length < 12 || phoneNormalizado.length > 13) {
      return new Response(JSON.stringify({ error: 'Telefone inválido. Formato esperado: DDD + número.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const ZAPI_INSTANCE = Deno.env.get('ZAPI_INSTANCE');
    const ZAPI_TOKEN = Deno.env.get('ZAPI_TOKEN');
    const ZAPI_CLIENT_TOKEN = Deno.env.get('ZAPI_CLIENT_TOKEN');
    if (!ZAPI_INSTANCE || !ZAPI_TOKEN) {
      return new Response(JSON.stringify({ error: 'Z-API não configurado.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 1) Tenta encontrar variação (com 9 / sem 9) que tem WhatsApp ativo
    let phoneFinal = phoneNormalizado;
    const tentativas: string[] = [];
    if (!skipPhoneExists) {
      const variantes = variantesComEsem9(phoneNormalizado);
      let achou = false;
      for (const v of variantes) {
        tentativas.push(v);
        if (await phoneExistsOnWhatsApp(ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, v)) {
          phoneFinal = v;
          achou = true;
          break;
        }
      }
      if (!achou) {
        return new Response(JSON.stringify({
          error: 'numero_sem_whatsapp',
          message: 'Nenhuma variação do número (' + tentativas.join(', ') + ') tem WhatsApp ativo.',
          tentativas
        }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // 2) Envia mensagem pro número que existe
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
    const zapiHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN) zapiHeaders['Client-Token'] = ZAPI_CLIENT_TOKEN;
    const result = await callZapiSendText(url, zapiHeaders, { phone: phoneFinal, message: mensagem });

    // HTTP 200 não basta: exige confirmação real do Z-API (messageId, sem erro).
    // Sem isso, uma instância desconectada que responde 200-sem-id seria tratada
    // como enviada (ok:true, messageId:undefined) — a cobrança nunca sairia.
    if (!result.ok || !envioConfirmado(result.data)) {
      return new Response(JSON.stringify({
        error: 'Z-API retornou erro: ' + (result.data?.error || result.data?.message || `HTTP ${result.status} sem confirmação (messageId ausente)`),
        detalhes: result.data,
        phoneUsed: phoneFinal
      }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      ok: true,
      messageId: result.data.messageId || result.data.id,
      phoneUsed: phoneFinal,
      mudancaPhone: phoneFinal !== phoneNormalizado,
      tentativas,
      zaapi: result.data
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Erro interno: ' + (e instanceof Error ? e.message : String(e)) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
