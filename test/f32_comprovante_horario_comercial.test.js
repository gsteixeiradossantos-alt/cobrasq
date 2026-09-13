/*
 * Teste F-32 (api/_repasse-msg.js) — comprovante de repasse não sai fora do horário
 * comercial: entra na fila `crm_mensagens_agendadas` para o próximo dia útil às 08h.
 *
 * Em 11/09/2026, à 01h26, o Gustavo clicou em Repassar e a mensagem com o comprovante
 * ia para o grupo do credor naquela hora. Janela definida por ele: seg–sex, 08h–20h
 * (Curitiba). Fora dela: fila, nunca Z-API — e se a fila falhar, tampouco Z-API.
 *
 * O teste força TZ=UTC de propósito — é o fuso do servidor real (Vercel).
 *
 * Como rodar:
 *   node test/f32_comprovante_horario_comercial.test.js
 */
'use strict';

const assert = require('assert');

if (process.env.TZ !== 'UTC') {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit', env: Object.assign({}, process.env, { TZ: 'UTC' }),
  });
  process.exit(r.status == null ? 1 : r.status);
}

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ZAPI_TOKEN = 't';
process.env.ZAPI_INSTANCE_ID = 'i';

const { proximoHorarioComercial, enviarComprovanteCredor } = require('../api/_repasse-msg.js');

// ---- 1. A régua do horário ------------------------------------------------------
const iso = (d) => d && d.toISOString();
// sex 11/09/2026 01:26 BRT = 04:26Z → hoje às 08h BRT (11:00Z)
assert.strictEqual(iso(proximoHorarioComercial(new Date('2026-09-11T04:26:00Z'))), '2026-09-11T11:00:00.000Z');
// sex 11/09 14:00 BRT → dentro da janela
assert.strictEqual(proximoHorarioComercial(new Date('2026-09-11T17:00:00Z')), null);
// sex 11/09 08:00 BRT em ponto → dentro
assert.strictEqual(proximoHorarioComercial(new Date('2026-09-11T11:00:00Z')), null);
// sex 11/09 19:59 BRT → dentro
assert.strictEqual(proximoHorarioComercial(new Date('2026-09-11T22:59:00Z')), null);
// sex 11/09 20:00 BRT → fechou; próximo dia útil é seg 14/09 08h
assert.strictEqual(iso(proximoHorarioComercial(new Date('2026-09-11T23:00:00Z'))), '2026-09-14T11:00:00.000Z');
// sáb 12/09 10:00 BRT → seg 14/09 08h
assert.strictEqual(iso(proximoHorarioComercial(new Date('2026-09-12T13:00:00Z'))), '2026-09-14T11:00:00.000Z');
// dom 13/09 23:30 BRT (= seg 02:30Z — o servidor UTC já virou o dia) → seg 14/09 08h, não ter 15
assert.strictEqual(iso(proximoHorarioComercial(new Date('2026-09-14T02:30:00Z'))), '2026-09-14T11:00:00.000Z');
// qua 16/09 21:00 BRT (= qui 00:00Z) → qui 17/09 08h
assert.strictEqual(iso(proximoHorarioComercial(new Date('2026-09-17T00:00:00Z'))), '2026-09-17T11:00:00.000Z');

// ---- 2. Fora da janela: fila, nunca Z-API -----------------------------------------
const PDF = Buffer.from('%PDF-1.4 fake').toString('base64');
let chamadas = [];
global.fetch = async (url, opts) => {
  chamadas.push({ url: String(url), opts });
  if (/z-api\.io.*phone-exists/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ exists: true }) };
  if (/z-api\.io/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ messageId: 'zapi-1' }) };
  if (/storage\/v1\/object/.test(url)) return { ok: true, status: 200, text: async () => '' };
  if (/rest\/v1\/crm_mensagens_agendadas/.test(url) && (!opts || !opts.method || opts.method === 'GET')) {
    // Último comprovante já agendado para a janela (vazio por padrão; o teste do
    // espaçamento preenche).
    return { ok: true, status: 200, text: async () => JSON.stringify(global.__ultimoAgendado ? [{ agendada_para: global.__ultimoAgendado }] : []) };
  }
  if (/rest\/v1\/crm_mensagens_agendadas/.test(url)) return { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'fila-1' }]) };
  throw new Error('fetch inesperado: ' + url);
};

(async () => {
  const madrugada = new Date('2026-09-11T04:26:00Z');
  let r = await enviarComprovanteCredor({
    telefone: '120363400743792709-group', parcela: 2, devedor: 'Fernanda Dambros',
    base64: PDF, ext: 'pdf', comprovanteUrl: 'https://asaas/x', agora: madrugada,
  });
  assert.strictEqual(r.enviado, false);
  assert.strictEqual(r.agendado, true);
  assert.strictEqual(r.agendada_para, '2026-09-11T11:00:00.000Z');
  assert.strictEqual(r.fila_id, 'fila-1');
  assert.ok(!chamadas.some(c => /z-api\.io/.test(c.url)), 'não pode chamar a Z-API de madrugada');
  const up = chamadas.find(c => /storage\/v1\/object\/documentos\//.test(c.url));
  assert.ok(up, 'PDF vai para o bucket documentos');
  const ins = chamadas.find(c => /crm_mensagens_agendadas/.test(c.url) && c.opts && c.opts.method === 'POST');
  const row = JSON.parse(ins.opts.body);
  assert.strictEqual(row.telefone, '120363400743792709-group', 'grupo passa intacto');
  assert.strictEqual(row.tipo, 'documento');
  assert.strictEqual(row.status, 'pendente');
  assert.strictEqual(row.origem, 'manual_repasse_comprovante', 'manual_* para não ficar preso atrás de conversa pendente (R-23)');
  assert.strictEqual(row.agendada_para, '2026-09-11T11:00:00.000Z');
  assert.ok(up.url.endsWith('/' + row.media_path), 'media_path aponta para o arquivo subido');
  // Com ".pdf": o worker deriva a extensão do nome e tira ela do fileName. Sem, o credor
  // recebeu "2 - José Lentz.2joslentz" (11/09/2026, 08h).
  assert.strictEqual(row.media_nome, '2 - Fernanda Dambros.pdf');
  // Texto de 12/09/2026: "parcela 2" (sem "n.", com "de M" quando há total) + o nome.
  assert.ok(/\*parcela 2\*/.test(row.legenda) && /Fernanda Dambros/.test(row.legenda) && !/parcela n\./.test(row.legenda), row.legenda);

  // ---- Espaçamento anti-spam: cada comprovante entra 30 s depois do último agendado --
  // 11/09/2026: 27 comprovantes em 25 s às 08h. Com dois já na fila (08:00:00 e
  // 08:00:30), o terceiro vai para 08:01:00 — não para 08:00:00.
  global.__ultimoAgendado = '2026-09-11T11:00:30.000Z';
  chamadas = [];
  r = await enviarComprovanteCredor({ telefone: '46999289933', parcela: 3, devedor: 'Y', base64: PDF, agora: madrugada });
  assert.strictEqual(r.agendada_para, '2026-09-11T11:01:00.000Z', 'terceiro comprovante 30 s depois do segundo');
  const rowEsp = JSON.parse(chamadas.find(c => /crm_mensagens_agendadas/.test(c.url) && c.opts && c.opts.method === 'POST').opts.body);
  assert.strictEqual(rowEsp.agendada_para, '2026-09-11T11:01:00.000Z');
  // Último agendado ANTES da janela (sobra de ontem) não empurra: vai na hora cheia.
  global.__ultimoAgendado = '2026-09-10T11:05:00.000Z';
  r = await enviarComprovanteCredor({ telefone: '46999289933', parcela: 4, devedor: 'Y', base64: PDF, agora: madrugada });
  assert.strictEqual(r.agendada_para, '2026-09-11T11:00:00.000Z');
  global.__ultimoAgendado = null;

  // Sem PDF: texto com o link, ainda na fila.
  chamadas = [];
  r = await enviarComprovanteCredor({ telefone: '46999289933', parcela: 1, devedor: 'X', base64: '', comprovanteUrl: 'https://asaas/y', agora: madrugada });
  assert.strictEqual(r.agendado, true);
  const row2 = JSON.parse(chamadas.find(c => /crm_mensagens_agendadas/.test(c.url) && c.opts && c.opts.method === 'POST').opts.body);
  assert.strictEqual(row2.tipo, 'texto');
  assert.ok(/Comprovante: https:\/\/asaas\/y/.test(row2.mensagem));
  assert.ok(!chamadas.some(c => /storage/.test(c.url)), 'sem PDF não sobe nada');

  // Fila falhou: NÃO cai para o envio direto.
  chamadas = [];
  const fetchOk = global.fetch;
  global.fetch = async (url, opts) => {
    if (/crm_mensagens_agendadas/.test(url) && opts && opts.method === 'POST') return { ok: false, status: 500, text: async () => 'boom' };
    return fetchOk(url, opts);
  };
  r = await enviarComprovanteCredor({ telefone: '46999289933', parcela: 1, devedor: 'X', base64: PDF, agora: madrugada });
  assert.strictEqual(r.enviado, false);
  assert.strictEqual(r.agendado, false);
  assert.ok(/fila falhou/.test(r.motivo));
  assert.ok(!chamadas.some(c => /z-api\.io/.test(c.url)), 'fila quebrada não vira envio de madrugada');
  global.fetch = fetchOk;

  // ---- 3. Dentro da janela: Z-API direto, nada na fila ----------------------------
  chamadas = [];
  r = await enviarComprovanteCredor({ telefone: '46999289933', parcela: 2, devedor: 'Fernanda Dambros', base64: PDF, ext: 'pdf', agora: new Date('2026-09-11T17:00:00Z') });
  assert.strictEqual(r.enviado, true);
  assert.strictEqual(r.via, 'documento');
  assert.ok(chamadas.some(c => /z-api\.io.*send-document/.test(c.url)));
  assert.ok(!chamadas.some(c => /crm_mensagens_agendadas/.test(c.url)), 'dentro da janela não enfileira');

  // Telefone inválido continua sendo recusado antes de qualquer coisa.
  r = await enviarComprovanteCredor({ telefone: '123', parcela: 1, devedor: 'X', base64: PDF, agora: madrugada });
  assert.strictEqual(r.enviado, false);
  assert.ok(/telefone/.test(r.motivo));

  console.log('F-32 ok — comprovante respeita seg–sex 08h–20h e vai para a fila fora disso.');
})().catch((e) => { console.error(e); process.exit(1); });
