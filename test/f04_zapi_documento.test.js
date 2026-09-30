/*
 * Teste F-04 (Z-API) — zapiSendDocument monta a chamada certa e barra entrada ruim.
 *
 * Roda contra o CÓDIGO REAL (api/_zapi.js), com fetch e env vars mockados —
 * nenhuma requisição sai da máquina.
 *
 * Como rodar:
 *   node test/f04_zapi_documento.test.js
 *
 * Contexto: o envio de documento é o caminho da carta de devolução / relatório ao
 * credor. Três coisas quebram na prática e ficam travadas aqui:
 *   1. telefone sem DDI 55 -> a Z-API aceita e não entrega (falha silenciosa);
 *   2. extensão vinda do fileName -> o endpoint é /send-document/{ext}, não fixo em pdf;
 *   3. base64 gigante -> Vercel corta o body em ~4,5 MB e o erro chega opaco.
 */
'use strict';

const path = require('path');
const assert = require('assert');

process.env.ZAPI_TOKEN = 'tok-teste';
process.env.ZAPI_INSTANCE_ID = 'inst-teste';
process.env.ZAPI_CLIENT_TOKEN = 'client-teste';

const { zapiSendDocument, normalizarTelefone } = require(path.join(__dirname, '..', 'api', '_zapi.js'));

let chamadas = [];
global.fetch = async (url, opts) => {
  chamadas.push({ url, opts });
  return { ok: true, status: 200, text: async () => JSON.stringify({ messageId: 'ok' }) };
};

const b64 = Buffer.from('%PDF-1.4 arquivo de teste').toString('base64');
let falhas = 0;
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}
async function checaAsync(nome, fn) {
  try { await fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}
async function rejeita(nome, fn, trecho) {
  try {
    await fn();
    falhas++; console.log('  FALHA ' + nome + '\n        deveria ter lançado erro');
  } catch (e) {
    if (String(e.message).includes(trecho)) console.log('  ok   ' + nome);
    else { falhas++; console.log('  FALHA ' + nome + '\n        erro inesperado: ' + e.message); }
  }
}

(async () => {
  console.log('F-04 · Z-API envio de documento');

  checa('telefone local ganha DDI 55', () => {
    assert.strictEqual(normalizarTelefone('46988226533'), '5546988226533');
    assert.strictEqual(normalizarTelefone('(46) 98822-6533'), '5546988226533');
    assert.strictEqual(normalizarTelefone('5546988226533'), '5546988226533');
  });

  await checaAsync('base64 vira data URI e cai em /send-document/pdf', async () => {
    chamadas = [];
    await zapiSendDocument('46988226533', { document: b64, fileName: 'Devolucao.pdf', caption: 'Segue' });
    assert.strictEqual(chamadas.length, 1);
    const { url, opts } = chamadas[0];
    assert.ok(url.endsWith('/send-document/pdf'), 'endpoint errado: ' + url);
    assert.ok(url.includes('/instances/inst-teste/token/tok-teste'), 'credenciais fora da URL');
    assert.strictEqual(opts.headers['Client-Token'], 'client-teste');
    const corpo = JSON.parse(opts.body);
    assert.strictEqual(corpo.phone, '5546988226533');
    assert.strictEqual(corpo.fileName, 'Devolucao.pdf');
    assert.strictEqual(corpo.caption, 'Segue');
    assert.ok(corpo.document.startsWith('data:application/pdf;base64,'), 'faltou o data URI');
  });

  await checaAsync('extensão sai do fileName', async () => {
    chamadas = [];
    await zapiSendDocument('46988226533', { document: b64, fileName: 'planilha.xlsx' });
    assert.ok(chamadas[0].url.endsWith('/send-document/xlsx'), chamadas[0].url);
  });

  await checaAsync('URL https passa intacta', async () => {
    chamadas = [];
    const url = 'https://exemplo.com/carta.pdf';
    await zapiSendDocument('46988226533', { document: url, fileName: 'carta.pdf' });
    assert.strictEqual(JSON.parse(chamadas[0].opts.body).document, url);
  });

  await rejeita('recusa http sem TLS', () =>
    zapiSendDocument('46988226533', { document: 'http://exemplo.com/x.pdf', fileName: 'x.pdf' }), 'https');

  await rejeita('recusa documento ausente', () =>
    zapiSendDocument('46988226533', { fileName: 'x.pdf' }), 'ausente');

  await rejeita('recusa sem fileName', () =>
    zapiSendDocument('46988226533', { document: b64 }), 'fileName');

  await rejeita('recusa base64 acima de 3.5 MB', () =>
    zapiSendDocument('46988226533', { document: 'A'.repeat(5 * 1024 * 1024), fileName: 'g.pdf' }), 'limite');

  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})();
