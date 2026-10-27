// F-69: "Bia só para boleto" (27/10/2026). Com "só Carlos" e "só boleto" ligados,
// a Bia responde SOMENTE pedido de boleto; o resto fica para a equipe.
const path = require('path');
const assert = require('assert');
const FN = path.join(__dirname, '..', 'supabase', 'functions');

(async () => {
  const M = await import(path.join(FN, '_shared', 'bia-modo.ts'));
  const soBoleto = { somente_carlos: true, modo_boleto_only: true };
  const soCarlos = { somente_carlos: true, modo_boleto_only: false };
  const boletoAntigo = { somente_carlos: false, modo_boleto_only: true };
  const livre = {};

  // só Carlos + só boleto: a Bia não sai da conversa, mas só age no boleto
  assert.strictEqual(M.biaDesligadaSoCarlos(soBoleto), false);
  assert.strictEqual(M.pularAcaoBia(soBoleto, false, 'enviar_boleto'), false);
  assert.strictEqual(M.pularAcaoBia(soBoleto, true, 'enviar_boleto'), false);
  for (const a of ['negociar_prazo', 'ja_paguei', 'quer_comprovante', 'credor_info', 'lead_comercial', 'continuar', 'handoff', 'silencio', 'resolvido']) {
    assert.strictEqual(M.pularAcaoBia(soBoleto, true, a), true, a + ' com cobrança ativa');
    assert.strictEqual(M.pularAcaoBia(soBoleto, false, a), true, a + ' sem cobrança ativa');
  }
  assert.strictEqual(M.pularMidiaBia(soBoleto, true), true);
  assert.strictEqual(M.pularMidiaBia(soBoleto, false), true);
  assert.strictEqual(M.modoSoBoleto(soBoleto), true);

  // só Carlos sem "só boleto": Bia fora, como antes
  assert.strictEqual(M.biaDesligadaSoCarlos(soCarlos), true);
  assert.strictEqual(M.modoSoBoleto(soCarlos), false);

  // "só boleto" antigo, sem "só Carlos": comportamento de antes preservado
  assert.strictEqual(M.biaDesligadaSoCarlos(boletoAntigo), false);
  assert.strictEqual(M.pularAcaoBia(boletoAntigo, false, 'ja_paguei'), false);
  assert.strictEqual(M.pularAcaoBia(boletoAntigo, false, 'continuar'), true);
  assert.strictEqual(M.pularAcaoBia(boletoAntigo, true, 'negociar_prazo'), false);
  assert.strictEqual(M.pularMidiaBia(boletoAntigo, true), false);
  assert.strictEqual(M.pularMidiaBia(boletoAntigo, false), true);
  assert.strictEqual(M.modoSoBoleto(boletoAntigo), false);

  // tudo livre
  assert.strictEqual(M.pularAcaoBia(livre, false, 'continuar'), false);
  assert.strictEqual(M.biaDesligadaSoCarlos(livre), false);

  console.log('f69 ok');
})().catch((e) => { console.error(e); process.exit(1); });
