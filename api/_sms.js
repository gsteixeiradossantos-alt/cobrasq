// api/_sms.js — Adapter de SMS PLUGÁVEL. Ainda não há gateway contratado (decisão do
// usuário: WhatsApp + e-mail primeiro, SMS depois). Quando contratar (ex.: Zenvia,
// Comtele, Twilio), defina SMS_PROVIDER + credenciais e implemente o envio abaixo.
// smsDisponivel() faz a régua pular o canal sem reivindicar envio enquanto não houver
// provedor — assim o passo SMS fica configurável sem quebrar o cron.

function smsDisponivel() { return String(process.env.SMS_PROVIDER || '').trim().length > 0; }

async function sendSms(phone, message) {
  const provider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (!provider) throw new Error('SMS sem provedor configurado (defina SMS_PROVIDER)');
  // TODO: implementar o provider contratado. Esqueleto:
  //   if (provider === 'zenvia') { /* fetch para a API da Zenvia com ZENVIA_TOKEN */ }
  //   if (provider === 'twilio') { /* ... */ }
  throw new Error('SMS provider "' + provider + '" ainda não implementado');
}

module.exports = { sendSms, smsDisponivel };
