// api/_sms.js — Adapter de SMS. Provider ativo: APIBrasil (gateway via celular Android
// com chip próprio — SMS_PROVIDER=apibrasil). smsDisponivel() faz a régua pular o canal
// sem reivindicar envio enquanto as credenciais não estiverem configuradas na Vercel.
//
// Setup (env vars na Vercel):
//   SMS_PROVIDER=apibrasil
//   APIBRASIL_EMAIL=...           (conta apibrasil.com.br)
//   APIBRASIL_PASSWORD=...        (ou APIBRASIL_BEARER=... para pular o login)
//   APIBRASIL_DEVICE_TOKEN=...    (device cadastrado no painel APIBrasil — app rodando
//                                  num Android com chip ativo; SMS sai pela linha dele)
//
// Volume: este gateway é um CELULAR real. Operadoras podem limitar/bloquear a linha em
// disparo alto. Serve como reforço pontual (ex.: passo SMS da régua QuitaFácil); se o
// volume crescer, trocar de provider fica isolado nesta função.
//
// Doc: https://doc.apibrasil.io — POST /api/v2/auth/login (email/password → bearer),
// POST /api/v2/sms/send (headers Authorization: Bearer + DeviceToken; body number/message).

const APIBRASIL_BASE = 'https://gateway.apibrasil.io/api/v2';

let _tokenCache = { token: null, exp: 0 };

function smsDisponivel() {
  const provider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (provider !== 'apibrasil') return false;
  const temDeviceToken = !!process.env.APIBRASIL_DEVICE_TOKEN;
  const temCredencial = !!process.env.APIBRASIL_BEARER || !!(process.env.APIBRASIL_EMAIL && process.env.APIBRASIL_PASSWORD);
  return temDeviceToken && temCredencial;
}

async function _apibrasilToken() {
  const bearerFixo = String(process.env.APIBRASIL_BEARER || '').trim();
  if (bearerFixo) return bearerFixo;

  const now = Date.now();
  if (_tokenCache.token && _tokenCache.exp > now) return _tokenCache.token;

  const email = process.env.APIBRASIL_EMAIL;
  const password = process.env.APIBRASIL_PASSWORD;
  if (!email || !password) throw new Error('APIBRASIL_EMAIL/APIBRASIL_PASSWORD ausentes');

  const r = await fetch(`${APIBRASIL_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await r.json().catch(() => ({}));
  const token = data?.authorization?.token || data?.token;
  if (!r.ok || !token) throw new Error('APIBrasil login falhou: ' + (data?.message || r.status));

  // Renova com folga — não sabemos o TTL real do token, 50min é conservador.
  _tokenCache = { token, exp: now + 50 * 60 * 1000 };
  return token;
}

function _numeroComPais(phone) {
  const digitos = String(phone || '').replace(/\D/g, '');
  if (!digitos) return '';
  return digitos.length <= 11 ? '55' + digitos : digitos;
}

async function sendSms(phone, message) {
  const provider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (!provider) throw new Error('SMS sem provedor configurado (defina SMS_PROVIDER)');
  if (provider !== 'apibrasil') throw new Error('SMS provider "' + provider + '" ainda não implementado');

  const deviceToken = process.env.APIBRASIL_DEVICE_TOKEN;
  if (!deviceToken) throw new Error('APIBRASIL_DEVICE_TOKEN ausente');

  const numero = _numeroComPais(phone);
  if (!numero) throw new Error('telefone inválido para SMS');

  const token = await _apibrasilToken();
  const r = await fetch(`${APIBRASIL_BASE}/sms/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'DeviceToken': deviceToken,
    },
    body: JSON.stringify({ number: numero, message: String(message || '').slice(0, 600) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.error || data?.success === false) {
    throw new Error('APIBrasil SMS falhou: ' + (data?.message || data?.error || r.status));
  }
  return data;
}

module.exports = { sendSms, smsDisponivel };
