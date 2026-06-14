// Supabase Edge Function: gsheet-acordo
// Recebe linha completa de acordo do CRM e faz append na planilha Google Sheets.
// Usa Service Account JWT pra autenticar (sem OAuth, sem token de usuário).
//
// Setup (1x):
//   1. Crie Service Account no Google Cloud Console
//   2. Compartilhe a planilha com o e-mail do Service Account (como Editor)
//   3. supabase secrets set GSHEET_ID=... GSHEET_ABA="Respostas ao formulário 1" GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
//   4. supabase functions deploy gsheet-acordo
//
// Body esperado: { linha: [colA, colB, colC, ...], aba?: 'nome da aba' }
// Resposta: { ok: true, range: 'A123:Z123' } | { error: '...' }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Converte PEM da private key em CryptoKey
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binary = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8',
    binary.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function getAccessToken(serviceAccountJson: any): Promise<string> {
  const now = getNumericDate(0);
  const exp = getNumericDate(60 * 50); // 50 min

  const privateKey = await importPrivateKey(serviceAccountJson.private_key);

  const jwt = await create(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: serviceAccountJson.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: exp
    },
    privateKey
  );

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt)
  });

  if (!tokenResp.ok) {
    const errTxt = await tokenResp.text();
    throw new Error('Falha ao obter access token: ' + errTxt);
  }
  const tokenJson = await tokenResp.json();
  return tokenJson.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { linha, aba } = body;

    if (!Array.isArray(linha) || linha.length === 0) {
      return new Response(JSON.stringify({ error: 'Campo "linha" obrigatório (array)' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const GSHEET_ID = Deno.env.get('GSHEET_ID');
    const GSHEET_ABA = aba || Deno.env.get('GSHEET_ABA') || 'Respostas ao formulário 1';
    const SA_JSON_RAW = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');

    if (!GSHEET_ID || !SA_JSON_RAW) {
      return new Response(JSON.stringify({ error: 'GSHEET_ID ou GOOGLE_SERVICE_ACCOUNT_JSON não configurados nos secrets do Supabase.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let saJson;
    try { saJson = JSON.parse(SA_JSON_RAW); }
    catch (e) { return new Response(JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON inválido (JSON malformado)' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }

    const accessToken = await getAccessToken(saJson);

    // Range dinâmico baseado em linha.length (suporta planilhas com >26 colunas no futuro)
    function colunaLetra(idx: number): string {
      let s = '';
      let n = idx;
      while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
      return s;
    }
    const ultimaCol = colunaLetra(Math.max(0, linha.length - 1));
    const range = encodeURIComponent("'" + GSHEET_ABA + "'!A:" + ultimaCol);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${GSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: [linha] }),
      signal: AbortSignal.timeout(15000)
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return new Response(JSON.stringify({ error: 'Sheets API retornou erro: ' + (data.error?.message || `HTTP ${r.status}`), detalhes: data }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: true, updates: data.updates }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Erro interno: ' + (e instanceof Error ? e.message : String(e)) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
