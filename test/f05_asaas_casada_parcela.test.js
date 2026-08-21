/*
 * Teste F-05 (Asaas) — a casada do recebimento acerta a PARCELA, não uma linha qualquer.
 *
 * Roda contra o CÓDIGO REAL (api/_processar-recebimento.js: escolherLancamento).
 * Nenhuma requisição sai da máquina.
 *
 * Como rodar:
 *   node test/f05_asaas_casada_parcela.test.js
 *
 * Contexto (21/08/2026): num acordo de parcela fixa TODAS as parcelas têm o mesmo valor
 * e o mesmo `criada_em` (nascem no mesmo INSERT). A casada antiga era
 * `order=criada_em.desc&limit=20` + primeira de valor igual — empate puro, e o Postgres
 * devolvia qualquer uma. Na prática:
 *   - pay_30shj4m6rmv4qtb8 ("Parcela 1 de 24", venc. 21/08) baixou a 11/24 da Cristiane;
 *   - pay_jniooq9iodcn7g2b ("Parcela 2 de 7", venc. 15/08) baixou a 4/7 da Aline.
 * Os dois casos reais estão travados aqui.
 */
'use strict';

const path = require('path');
const assert = require('assert');

const { escolherLancamento } = require(path.join(__dirname, '..', 'api', '_processar-recebimento.js'));

function serie(prefixo, n, valor, primeiroVenc, idBase) {
  const [a, m, d] = primeiroVenc.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const dt = new Date(Date.UTC(a, m - 1 + i, d));
    return {
      id: idBase + i,
      descricao: `${prefixo} ${i + 1}/${n}`,
      valor: String(valor.toFixed(2)),
      status: 0,
      numero_parcela: i + 1,
      total_parcelas: n,
      data_vencimento: dt.toISOString().slice(0, 10),
    };
  });
}

// 1. Caso Cristiane: 24 parcelas iguais de R$ 346, boleto avulso da parcela 1 (sem
//    installmentNumber). Só o vencimento identifica a linha.
{
  const cands = serie('Cristiane de Vargas Bueno', 24, 346, '2026-08-21', 124754);
  const escolhido = escolherLancamento(cands, 346, {
    dueDate: '2026-08-21', installmentNumber: null, billingType: 'BOLETO',
  });
  assert.strictEqual(escolhido && escolhido.numero_parcela, 1,
    'boleto de venc. 21/08 tem de casar a parcela 1, não outra de mesmo valor');
}

// 2. Caso Aline: o Asaas manda installmentNumber=2 e venc. 15/08. As duas chaves
//    apontam a mesma linha — e nenhuma delas é a 4/7 que a casada antiga pegava.
{
  const cands = serie('Aline Ceccagna', 7, 267, '2026-07-15', 123818);
  const escolhido = escolherLancamento(cands, 267, {
    dueDate: '2026-08-15', installmentNumber: 2, billingType: 'BOLETO',
  });
  assert.strictEqual(escolhido && escolhido.numero_parcela, 2,
    'boleto "Parcela 2 de 7" tem de casar a 2/7');
}

// 3. Parcela já paga não rouba a casada de outra: o vencimento manda mesmo assim
//    (idempotência — reprocessar o mesmo webhook reconfirma a MESMA linha).
{
  const cands = serie('Cristiane de Vargas Bueno', 24, 346, '2026-08-21', 124754);
  cands[0].status = 1;
  const escolhido = escolherLancamento(cands, 346, { dueDate: '2026-08-21', installmentNumber: null });
  assert.strictEqual(escolhido && escolhido.id, 124754,
    'reprocessamento tem de cair na mesma parcela já baixada, não criar divergência');
}

// 4. Vencimento reemitido (boleto vencido, cliente pagou depois com nova data): cai na
//    parcela EM ABERTO de vencimento mais próximo, nunca numa futura arbitrária.
{
  const cands = serie('Fulano', 12, 500, '2026-01-10', 900);
  cands.slice(0, 5).forEach(c => { c.status = 1; });          // 1..5 já pagas
  const escolhido = escolherLancamento(cands, 500, { dueDate: '2026-06-12', installmentNumber: null });
  assert.strictEqual(escolhido && escolhido.numero_parcela, 6,
    'sem vencimento exato, casa a parcela em aberto mais próxima (6/12, venc. 10/06)');
}

// 5. Nenhuma chave decide entre várias de mesmo valor: devolve null (baixa manual).
//    Baixar a parcela errada é pior do que não baixar.
{
  const cands = serie('Beltrano', 6, 100, '2026-03-05', 700).map(c => ({ ...c, data_vencimento: null }));
  const escolhido = escolherLancamento(cands, 100, { dueDate: '2026-03-05', installmentNumber: null });
  assert.strictEqual(escolhido, null, 'sem chave para desempatar, não pode escolher no chute');
}

// 6. Candidata única de mesmo valor: casa mesmo sem vencimento (avulsa fora de série).
{
  const cands = [{ id: 1, valor: '80.00', status: 0, numero_parcela: null, data_vencimento: null }];
  const escolhido = escolherLancamento(cands, 80, { dueDate: '2026-04-01' });
  assert.strictEqual(escolhido && escolhido.id, 1, 'candidata única tem de casar');
}

// 7. Valor diferente não casa (recebimento avulso segue o caminho de criar lançamento).
{
  const cands = serie('Fulano', 3, 200, '2026-05-10', 800);
  assert.strictEqual(escolherLancamento(cands, 145.5, { dueDate: '2026-05-10' }), null,
    'valor fora da tolerância não pode casar parcela nenhuma');
}

console.log('F-05 OK — casada da parcela por vencimento/numero (7 casos)');
