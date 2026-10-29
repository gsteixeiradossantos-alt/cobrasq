// F-71: o número de teste da Bia nunca fica travado pela humano_ate nem pelo
// 'aguardando_humano' (29/10/2026). Os outros números seguem com a trava de 24h.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const FN = path.join(__dirname, '..', 'supabase', 'functions');

(async () => {
  const { ehNumeroTeste } = await import(path.join(FN, '_shared', 'bia-numero-teste.ts'));

  // com e sem o 9, com e sem o 55
  assert.ok(ehNumeroTeste('5546999223332', '5546999223332'));
  assert.ok(ehNumeroTeste('554699223332', '5546999223332'));
  assert.ok(ehNumeroTeste('46999223332', '5546999223332'));
  // outro número trava normalmente
  assert.ok(!ehNumeroTeste('5546999110000', '5546999223332'));
  // sem número de teste configurado, ninguém escapa da trava
  assert.ok(!ehNumeroTeste('5546999223332', ''));
  assert.ok(!ehNumeroTeste('5546999223332', null));

  // as duas travas da bia-atendimento respeitam a exceção
  const src = fs.readFileSync(path.join(FN, 'bia-atendimento', 'index.ts'), 'utf8');
  assert.ok(/if \(!semTrava && at && at\.estado === 'aguardando_humano'\)/.test(src));
  assert.ok(/if \(!semTrava && at\?\.humano_ate && /.test(src));
  console.log('f71 ok');
})().catch((e) => { console.error(e); process.exit(1); });
