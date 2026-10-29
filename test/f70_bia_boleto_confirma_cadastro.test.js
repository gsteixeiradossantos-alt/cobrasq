// F-70: a Bia só manda boleto depois de confirmar de quem é o cadastro (29/10/2026).
// Telefone achado: "Vi que seu número está vinculado ao cadastro de X. Confere?" + 3
// primeiros dígitos do CPF/CNPJ. Não confere / não achou: CPF/CNPJ + nome completo,
// procurando também entre homônimos.
const path = require('path');
const assert = require('assert');
const FN = path.join(__dirname, '..', 'supabase', 'functions');

(async () => {
  const M = await import(path.join(FN, '_shared', 'bia-boleto-identidade.ts'));

  // texto pedido pelo Gustavo
  assert.strictEqual(M.msgConfirmarCadastro('Maria Souza'),
    'Vi que seu número está vinculado ao cadastro de Maria Souza. Confere? Se sim, me envia os 3 primeiros dígitos do seu CPF ou CNPJ.');

  // pessoa física: primeiro nome; empresa: razão social inteira
  assert.strictEqual(M.nomeParaConfirmar('Maria da Silva Souza', '12345678901'), 'Maria');
  assert.strictEqual(M.nomeParaConfirmar('Mercado Bom Preço Ltda', '12345678000190'), 'Mercado Bom Preço Ltda');

  // cadastros duplicados do mesmo CPF = uma pessoa; CPF diferente = outra pessoa
  const g1 = M.agruparPorDoc([
    { id: 'a', name: 'Maria Souza', cpfCnpj: '123.456.789-01' },
    { id: 'b', name: 'MARIA SOUZA', cpfCnpj: '12345678901' },
  ]);
  assert.strictEqual(g1.length, 1);
  assert.deepStrictEqual(g1[0].ids, ['a', 'b']);
  assert.strictEqual(M.agruparPorDoc([
    { id: 'a', name: 'Maria', cpfCnpj: '12345678901' },
    { id: 'c', name: 'João', cpfCnpj: '98765432100' },
  ]).length, 2);
  assert.strictEqual(M.agruparPorDoc([{ id: 'x', name: 'Sem doc', cpfCnpj: '' }]).length, 0);

  // resposta ao "Confere?"
  assert.deepStrictEqual(M.lerRespostaConfirmacao('sim, 123'), { tipo: 'digitos', digitos: '123' });
  assert.deepStrictEqual(M.lerRespostaConfirmacao('123.456'), { tipo: 'digitos', digitos: '123456' });
  assert.strictEqual(M.lerRespostaConfirmacao('Não confere').tipo, 'nega');
  assert.strictEqual(M.lerRespostaConfirmacao('nao sou eu').tipo, 'nega');
  assert.strictEqual(M.lerRespostaConfirmacao('errado').tipo, 'nega');
  assert.strictEqual(M.lerRespostaConfirmacao('sim').tipo, 'outro');
  assert.strictEqual(M.lerRespostaConfirmacao('12').tipo, 'outro');

  // 3 primeiros dígitos
  assert.strictEqual(M.digitosConferem('123', '123.456.789-01'), true);
  assert.strictEqual(M.digitosConferem('12345678901', '12345678901'), true);
  assert.strictEqual(M.digitosConferem('124', '12345678901'), false);
  assert.strictEqual(M.digitosConferem('12', '12345678901'), false);
  assert.strictEqual(M.digitosConferem('123', ''), false);

  // CPF/CNPJ + nome numa mensagem só
  assert.deepStrictEqual(M.lerDocENome('Maria da Silva Souza 123.456.789-01'), { doc: '12345678901', nome: 'Maria da Silva Souza' });
  assert.deepStrictEqual(M.lerDocENome('meu nome é João dos Santos, cpf 98765432100'), { doc: '98765432100', nome: 'João dos Santos' });
  assert.deepStrictEqual(M.lerDocENome('12.345.678/0001-90 Mercado Bom Preço Ltda'), { doc: '12345678000190', nome: 'Mercado Bom Preço Ltda' });
  assert.strictEqual(M.lerDocENome('Maria da Silva 1234').doc, '');

  // homônimos: fica só quem tem o documento informado
  const homs = [
    { id: 'h1', name: 'José Pereira', cpfCnpj: '11111111111' },
    { id: 'h2', name: 'José Pereira', cpfCnpj: '22222222222' },
  ];
  assert.deepStrictEqual(M.homonimosComDoc(homs, '222.222.222-22').map((c) => c.id), ['h2']);
  assert.strictEqual(M.homonimosComDoc(homs, '33333333333').length, 0);

  // confirmação vale 24h
  const agora = Date.parse('2026-10-29T12:00:00Z');
  assert.strictEqual(M.confirmacaoValida({ ids: ['a'], nome: 'M', em: '2026-10-29T00:00:00Z' }, agora), true);
  assert.strictEqual(M.confirmacaoValida({ ids: ['a'], nome: 'M', em: '2026-10-28T11:00:00Z' }, agora), false);
  assert.strictEqual(M.confirmacaoValida({ ids: [], nome: 'M', em: '2026-10-29T00:00:00Z' }, agora), false);
  assert.strictEqual(M.confirmacaoValida(undefined, agora), false);

  console.log('f70 ok');
})().catch((e) => { console.error(e); process.exit(1); });
