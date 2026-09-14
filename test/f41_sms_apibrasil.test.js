/*
 * Teste F-41 (SMS) — adapter APIBrasil em api/_sms.js.
 *
 * Contexto (14/09/2026): régua QuitaFácil (QUITA_STEPS, api/cron-regua.js) tem um passo
 * SMS no d12 que ficava sempre pulado por falta de provedor (api/_sms.js só tinha um
 * TODO). Este teste cobre o adapter: smsDisponivel() só liga com as env vars certas,
 * sendSms() faz login na APIBrasil, normaliza o telefone para 55+DDD+número e manda
 * Authorization+DeviceToken certos — sem isso o SMS sai sem chegar, do jeito silencioso
 * que já mordeu o WhatsApp (telefone em formato errado nunca dá erro).
 *
 * Como rodar:
 *   node test/f41_sms_apibrasil.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const RAIZ = path.join(__dirname, '..');
const alvo = path.join(RAIZ, 'api', '_sms.js');

function limparEnvSms() {
  delete process.env.SMS_PROVIDER;
  delete process.env.APIBRASIL_EMAIL;
  delete process.env.APIBRASIL_PASSWORD;
  delete process.env.APIBRASIL_BEARER;
  delete process.env.APIBRASIL_DEVICE_TOKEN;
}

function carregarFresco() {
  delete require.cache[require.resolve(alvo)];
  return require(alvo);
}

// --- 1) smsDisponivel(): sem provider, ou provider errado, ou faltando credencial ---
limparEnvSms();
let { smsDisponivel } = carregarFresco();
assert.strictEqual(smsDisponivel(), false, 'sem SMS_PROVIDER deveria ficar indisponível');

process.env.SMS_PROVIDER = 'zenvia';
assert.strictEqual(carregarFresco().smsDisponivel(), false, 'provider não-apibrasil ainda não implementado');

process.env.SMS_PROVIDER = 'apibrasil';
assert.strictEqual(carregarFresco().smsDisponivel(), false, 'apibrasil sem DEVICE_TOKEN/credencial deveria ficar indisponível');

process.env.APIBRASIL_DEVICE_TOKEN = 'device-teste';
assert.strictEqual(carregarFresco().smsDisponivel(), false, 'device token sozinho não basta — falta email/senha ou bearer');

process.env.APIBRASIL_EMAIL = 'conta@cobrasq.com.br';
process.env.APIBRASIL_PASSWORD = 'segredo';
assert.strictEqual(carregarFresco().smsDisponivel(), true, 'com device token + email/senha deveria ficar disponível');

// --- 2) sendSms(): login + envio, telefone normalizado, headers corretos ---
limparEnvSms();
process.env.SMS_PROVIDER = 'apibrasil';
process.env.APIBRASIL_EMAIL = 'conta@cobrasq.com.br';
process.env.APIBRASIL_PASSWORD = 'segredo';
process.env.APIBRASIL_DEVICE_TOKEN = 'device-teste';

const chamadas = [];
global.fetch = async (url, opts) => {
  chamadas.push({ url, opts });
  if (String(url).endsWith('/auth/login')) {
    const corpo = JSON.parse(opts.body);
    assert.strictEqual(corpo.email, 'conta@cobrasq.com.br');
    assert.strictEqual(corpo.password, 'segredo');
    return { ok: true, status: 200, json: async () => ({ authorization: { token: 'bearer-fake' } }) };
  }
  if (String(url).endsWith('/sms/send')) {
    return { ok: true, status: 200, json: async () => ({ success: true, id: 'sms-1' }) };
  }
  throw new Error('URL inesperada: ' + url);
};

let mod = carregarFresco();
(async () => {
  await mod.sendSms('46999002946', 'oi, teste');

  assert.strictEqual(chamadas.length, 2, 'deveria logar e depois enviar (2 chamadas)');
  const login = chamadas[0], envio = chamadas[1];
  assert.ok(login.url.endsWith('/api/v2/auth/login'), 'primeira chamada é o login');
  assert.ok(envio.url.endsWith('/api/v2/sms/send'), 'segunda chamada é o envio');
  assert.strictEqual(envio.opts.headers['Authorization'], 'Bearer bearer-fake', 'usa o token retornado pelo login');
  assert.strictEqual(envio.opts.headers['DeviceToken'], 'device-teste', 'manda o DeviceToken configurado');
  const corpoEnvio = JSON.parse(envio.opts.body);
  assert.strictEqual(corpoEnvio.number, '5546999002946', 'telefone de 11 dígitos ganha o 55 na frente');
  assert.strictEqual(corpoEnvio.message, 'oi, teste');

  // --- 3) telefone já com DDI (13 dígitos) não dobra o 55; login não repete (token
  //        cacheado) — a 2ª rodada de sendSms faz só 1 chamada (o envio).
  chamadas.length = 0;
  await mod.sendSms('5546999002946', 'oi de novo');
  assert.strictEqual(chamadas.length, 1, 'segunda chamada a sendSms deveria reaproveitar o token, sem logar de novo');
  const corpoEnvio2 = JSON.parse(chamadas[0].opts.body);
  assert.strictEqual(corpoEnvio2.number, '5546999002946', 'telefone já com DDI não deveria ganhar outro 55');

  // --- 4) erro do gateway vira exceção, não silêncio ---
  global.fetch = async (url) => {
    if (String(url).endsWith('/sms/send')) {
      return { ok: true, status: 200, json: async () => ({ success: false, message: 'device offline' }) };
    }
    return { ok: true, status: 200, json: async () => ({ authorization: { token: 'bearer-fake' } }) };
  };
  mod = carregarFresco();
  await assert.rejects(
    () => mod.sendSms('46999002946', 'falha'),
    /device offline/,
    'resposta success:false deveria virar erro, não sucesso silencioso'
  );

  // --- 5) APIBRASIL_BEARER pula o login ---
  process.env.APIBRASIL_BEARER = 'bearer-fixo';
  let chamouLogin = false;
  global.fetch = async (url) => {
    if (String(url).endsWith('/auth/login')) { chamouLogin = true; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  mod = carregarFresco();
  await mod.sendSms('46999002946', 'com bearer fixo');
  assert.strictEqual(chamouLogin, false, 'com APIBRASIL_BEARER configurado, não deveria chamar /auth/login');

  console.log('OK — f41_sms_apibrasil');
})().catch((e) => { console.error('FALHOU — f41_sms_apibrasil:', e.message); process.exit(1); });
