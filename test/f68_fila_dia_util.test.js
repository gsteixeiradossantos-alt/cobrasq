// F-68: fila do WhatsApp não envia a devedor em sábado, domingo ou feriado o que
// foi agendado antes; o que entrou na fila no próprio dia sai.
// Caso real: Sidimar, posto na fila à 00:51 de sábado 24/10/2026 para "amanhã 9h",
// saiu às 09:00 de domingo 25/10.
const path = require('path');
const assert = require('assert');
const fs = require('fs');

const FN = path.join(__dirname, '..', 'supabase', 'functions');

(async () => {
  const F = await import(path.join(FN, '_shared', 'fila-dia-util.ts'));

  assert.strictEqual(F.dataBrasilia('2026-10-24T03:52:04Z'), '2026-10-24'); // 00:52 de sábado em Brasília
  assert.strictEqual(F.dataBrasilia('2026-10-26T02:30:00Z'), '2026-10-25'); // 23:30 de domingo

  // Sidimar: criada sábado 00:52, disparo domingo 09:00 -> segunda 26/10 09:00
  assert.strictEqual(F.adiarParaDiaUtil('2026-10-25T12:00:20Z', '2026-10-24T03:52:04Z'), '2026-10-26T12:00:00.000Z');
  // criada sexta para sábado -> segunda
  assert.strictEqual(F.adiarParaDiaUtil('2026-10-24T13:00:00Z', '2026-10-23T18:00:00Z'), '2026-10-26T12:00:00.000Z');
  // posta na fila no próprio domingo para sair na hora -> sai
  assert.strictEqual(F.adiarParaDiaUtil('2026-10-25T15:00:30Z', '2026-10-25T15:00:00Z'), null);
  // dia útil -> sai
  assert.strictEqual(F.adiarParaDiaUtil('2026-10-26T12:00:00Z', '2026-10-24T03:52:04Z'), null);
  // feriado: sexta 20/11/2026 (Consciência Negra) -> segunda 23/11
  assert.strictEqual(F.adiarParaDiaUtil('2026-11-20T12:00:00Z', '2026-11-19T20:00:00Z'), '2026-11-23T12:00:00.000Z');
  // sábado antes de feriado na segunda: sábado 10/10/2026, 12/10 é feriado -> terça 13/10
  assert.strictEqual(F.adiarParaDiaUtil('2026-10-10T12:00:00Z', '2026-10-09T12:00:00Z'), '2026-10-13T12:00:00.000Z');
  // sem created_at -> segura (não dá para saber se foi agendada no dia)
  assert.ok(F.adiarParaDiaUtil('2026-10-25T12:00:00Z', null));

  // horário: fora das 08h-20h, agendada antes -> 09h do próximo dia útil
  // terça 27/10 22:00 BRT, agendada na segunda -> quarta 28/10 09:00
  assert.strictEqual(F.adiarParaHorario('2026-10-28T01:00:00Z', '2026-10-26T15:00:00Z'), '2026-10-28T12:00:00.000Z');
  // terça 27/10 06:00 BRT, agendada na véspera -> mesma terça 09:00
  assert.strictEqual(F.adiarParaHorario('2026-10-27T09:00:00Z', '2026-10-26T20:00:00Z'), '2026-10-27T12:00:00.000Z');
  // sexta 30/10 21:00 BRT -> segunda 02/11 é feriado (Finados) -> terça 03/11 09:00
  assert.strictEqual(F.adiarParaHorario('2026-10-31T00:00:00Z', '2026-10-30T10:00:00Z'), '2026-11-03T12:00:00.000Z');
  // posta na fila agora às 22h (há 1 min) -> sai
  assert.strictEqual(F.adiarParaHorario('2026-10-28T01:01:00Z', '2026-10-28T01:00:00Z'), null);
  // dentro da janela -> sai; limites 08:00 sai e 20:00 segura
  assert.strictEqual(F.adiarParaHorario('2026-10-27T15:00:00Z', '2026-10-20T15:00:00Z'), null);
  assert.strictEqual(F.adiarParaHorario('2026-10-27T11:00:00Z', '2026-10-20T15:00:00Z'), null);
  assert.ok(F.adiarParaHorario('2026-10-27T23:00:00Z', '2026-10-20T15:00:00Z'));
  // sem created_at -> segura
  assert.ok(F.adiarParaHorario('2026-10-28T01:00:00Z', null));

  // o worker usa a trava e lê created_at; aviso interno e grupo ficam de fora
  const src = fs.readFileSync(path.join(FN, 'cron-mensagens-agendadas', 'index.ts'), 'utf8');
  assert.ok(/origem, created_at'\)/.test(src), 'select traz created_at');
  assert.ok(/\(!souGrupo && !avisoInterno\)\s*\? \(adiarParaDiaUtil\(new Date\(\), m\.created_at\) \|\| adiarParaHorario\(new Date\(\), m\.created_at\)\)/.test(src), 'travas aplicadas fora de grupo e aviso interno');

  console.log('f68 ok');
})().catch((e) => { console.error(e); process.exit(1); });
