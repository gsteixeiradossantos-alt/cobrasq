// F-67: mensagem manual pela fila pausa a Bia e o prazo "até dd/mm" é respeitado.
// Caso real: Cristiane, 19/10/2026 17:32 BRT, "Preciso do pagamento até sexta-feira,
// 23/10" — a Bia cobrou em 20/10 9h02 e em 23/10 9h02 por cima do prazo.
const path = require('path');
const assert = require('assert');
const FN = path.join(__dirname, '..', 'supabase', 'functions');

(async () => {
  const A = await import(path.join(FN, '_shared', 'bia-avisos.ts'));

  assert.strictEqual(A.ehOrigemManual('manual_dura_cristiane'), true);
  assert.strictEqual(A.ehOrigemManual('negociacao'), true);
  assert.strictEqual(A.ehOrigemManual('lembrete_aviso_dia'), false);
  assert.strictEqual(A.ehOrigemManual(null), false);

  const txt = 'Preciso do pagamento até sexta-feira, 23/10. Sem ele, o acordo fica descumprido';
  assert.strictEqual(A.prazoDaMensagem(txt, '2026-10-19'), '2026-10-23');
  assert.strictEqual(A.prazoDaMensagem('pague até 05/01', '2026-12-20'), '2027-01-05');
  assert.strictEqual(A.prazoDaMensagem('pague até 10/11/2026', '2026-10-19'), '2026-11-10');
  // data sem "até" (vencimento antigo) não é prazo
  assert.strictEqual(A.prazoDaMensagem('Sua parcela venceu em 10/10.', '2026-10-19'), null);
  assert.strictEqual(A.prazoDaMensagem('Assim que pagar, me manda o comprovante.', '2026-10-19'), null);

  const msgs = [
    { origem: 'manual_dura_cristiane', mensagem: txt, enviada_em: '2026-10-19T20:32:05Z' },
    { origem: 'manual_dura_cristiane', mensagem: 'Assim que pagar, me manda o comprovante aqui.', enviada_em: '2026-10-19T20:32:06Z' },
  ];
  const ms = (s) => Date.parse(s);
  // 20/10 9h02 e 23/10 9h02 (BRT): quieta, volta 24/10 9h BRT
  assert.strictEqual(A.retomadaAposManual(msgs, ms('2026-10-20T12:02:00Z'), 1440), '2026-10-24T12:00:00.000Z');
  assert.strictEqual(A.retomadaAposManual(msgs, ms('2026-10-23T12:02:00Z'), 1440), '2026-10-24T12:00:00.000Z');
  // depois do prazo: libera
  assert.strictEqual(A.retomadaAposManual(msgs, ms('2026-10-26T12:00:00Z'), 1440), null);

  // manual sem prazo: só a pausa de 24h
  const semPrazo = [{ origem: 'manual_x', mensagem: 'Oi, tudo bem?', enviada_em: '2026-10-19T20:00:00Z' }];
  assert.strictEqual(A.retomadaAposManual(semPrazo, ms('2026-10-20T12:00:00Z'), 1440), '2026-10-20T20:00:00.000Z');
  assert.strictEqual(A.retomadaAposManual(semPrazo, ms('2026-10-20T21:00:00Z'), 1440), null);
  // automação (lembrete) não pausa
  assert.strictEqual(A.retomadaAposManual([{ origem: 'lembrete_aviso_dia', mensagem: 'até 30/10', enviada_em: '2026-10-19T20:00:00Z' }], ms('2026-10-20T12:00:00Z'), 1440), null);

  console.log('f67 ok');
})().catch((e) => { console.error(e); process.exit(1); });
