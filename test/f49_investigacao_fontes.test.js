/*
 * Teste F-49 — fontes da investigação patrimonial v8
 * (supabase/functions/investigacao-patrimonial-worker/fontes.mjs).
 *
 * O HTML abaixo reproduz a estrutura medida no pePI do INPI em 26/09/2026 (dados
 * fictícios): link do titular com "&pos=N", CPF inteiro colado ao nome, linha de
 * marca <tr bgColor=…> com 8 células, âncora de patente com class='visitado' sem ">"
 * na mesma linha e patente recente sem título/IPC (sigilo). Trava também o índice do
 * DataJud por número CNJ e os sinais de bem/dinheiro no texto do DJEN.
 *
 * Como rodar:
 *   node test/f49_investigacao_fontes.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const LISTA = `
<td><font class="normal">
  <a href="/pePI/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_CNPJ_NOME&pos=0" class="normal">
    FULANO DE TAL SILVA 12345678901
  </a></font></td>
<td><font class="normal">
  <a href="/pePI/servlet/MarcasServletController?Action=searchMarca&tipoPesquisa=BY_CNPJ_NOME&pos=1" class="normal">
    EMPRESA EXEMPLO LTDA 11222333000181
  </a></font></td>`;

const linhaMarca = (num, marca, situacao, titular, classe) => `
  <tr bgColor="#E0E0E0" class=normal>
    <td align="center"><font class="normal">
      <a href='/pePI/servlet/MarcasServletController?Action=detail&CodPedido=1' class="visitado">
        ${num}
      </a></font></td>
    <td align="center"><font class="normal">19/03/2021</font></td>
    <td align="center"><img src="/pePI/jsp/imagens/M.gif" alt="Marca Mista"></td>
    <td align="left"><font class="normal"><b>${marca}</b></font></td>
    <td align="center"><img src="/pePI/jsp/imagens/registro_ok.gif" alt="Marca Registrada"></td>
    <td class="left padding-5"><font class="normal">${situacao}</font></td>
    <td class="left"><font class="normal titular-marcas">${titular}</font></td>
    <td class="left"><font class="normal titulo-marcas">${classe}</font></td>
  </tr>`;

const MARCAS = `<table>
  ${linhaMarca('922000001', 'EXEMPLO RECUPERADORA', 'Registro de marca em vigor', 'FULANO DE TAL SILVA 12345678901', 'NCL(11) 36')}
  ${linhaMarca('922000002', '-', 'Registro de marca extinto', 'FULANO DE TAL SILVA 12345678901', 'NCL(11) 35')}
  <tr><td><font><br>Foram encontrados <b>2</b> processos que satisfazem à pesquisa.</font></td></tr>
</table>`;

const linhaPatente = (pedido, titulo, ipc) => `
  <tr bgColor=#E0E0E0>
    <td align="center"><font class="normal">
      <a href='/pePI/servlet/PatenteServletController?Action=detail&CodPedido=1809698&SearchParameter=11222333000181   &Resumo=&Titulo=' class='visitado'
      >
        ${pedido}
      </a></font></td>
    <td align="center"><font class="normal">30/07/2026</font></td>
    <td align="left"><font class="normal"><b>${titulo}</b></font></td>
    <td align="left"><font class="alerta">${ipc}</font></td>
  </tr>`;

const PATENTES = `<table>
  ${linhaPatente('BR 10 2026 018956 1', '', '-')}
  ${linhaPatente('PI 0501234-5', 'SEMEADORA DE PRECISÃO', 'A01C 7/04')}
  <tr><td>Foram encontrados <b>417</b> processos</td></tr>
</table>`;

(async () => {
  const F = await import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'investigacao-patrimonial-worker', 'fontes.mjs')).href);

  // ── INPI: titulares ──
  const tit = F.inpiTitulares(LISTA);
  assert.deepStrictEqual(tit, [
    { pos: 0, nome: 'FULANO DE TAL SILVA', doc: '12345678901' },
    { pos: 1, nome: 'EMPRESA EXEMPLO LTDA', doc: '11222333000181' },
  ]);

  // Pessoa física: só o CPF inteiro igual.
  assert.strictEqual(F.titularConfere(tit[0], { cpf: '12345678901' }), true);
  assert.strictEqual(F.titularConfere(tit[0], { cpf: '12345678900' }), false, 'homônimo com outro CPF não é o devedor');
  // Empresa: CNPJ igual.
  assert.strictEqual(F.titularConfere(tit[1], { cnpj: '11222333000181' }), true);
  assert.strictEqual(F.titularConfere(tit[1], { cpf: '12345678901' }), false);
  // Sócio: 6 dígitos do meio (QSA) + nome, sem acento/caixa.
  assert.strictEqual(F.titularConfere(tit[0], { miolo: '456789', nome: 'Fulano de Tal Silva' }), true);
  assert.strictEqual(F.titularConfere(tit[0], { miolo: '456789', nome: 'Fulano de Tal' }), false, 'nome diferente não confirma');
  assert.strictEqual(F.titularConfere(tit[0], { miolo: '000000', nome: 'Fulano de Tal Silva' }), false, 'miolo diferente não confirma');
  assert.strictEqual(F.titularConfere(tit[1], { miolo: '223330', nome: 'EMPRESA EXEMPLO LTDA' }), false, 'CNPJ não serve como CPF de sócio');
  assert.strictEqual(F.titularConfere({ nome: 'X', doc: null }, { cpf: '' }), false);

  // ── INPI: marcas ──
  const m = F.inpiMarcas(MARCAS);
  assert.strictEqual(m.total, 2);
  assert.strictEqual(m.itens.length, 2);
  assert.deepStrictEqual(m.itens[0], {
    numero: '922000001', prioridade: '19/03/2021', marca: 'EXEMPLO RECUPERADORA',
    situacao: 'Registro de marca em vigor', titular: 'FULANO DE TAL SILVA', classe: 'NCL(11) 36',
  });
  assert.strictEqual(m.itens[1].marca, '(figurativa)', 'marca sem nome ("-") é figurativa');

  assert.strictEqual(F.marcaViva('Registro de marca em vigor'), true);
  assert.strictEqual(F.marcaViva('Aguardando exame de mérito'), true);
  assert.strictEqual(F.marcaViva('Registro de marca extinto'), false);
  assert.strictEqual(F.marcaViva('Pedido definitivamente arquivado'), false);
  assert.strictEqual(F.marcaViva('Pedido indeferido'), false);
  assert.strictEqual(F.marcaViva(null), false);

  // ── INPI: patentes ──
  const p = F.inpiPatentes(PATENTES);
  assert.strictEqual(p.total, 417, 'total vem do rodapé, não das 20 linhas da página');
  assert.deepStrictEqual(p.itens[0], { pedido: 'BR 10 2026 018956 1', deposito: '30/07/2026', titulo: null, ipc: null });
  assert.deepStrictEqual(p.itens[1], { pedido: 'PI 0501234-5', deposito: '30/07/2026', titulo: 'SEMEADORA DE PRECISÃO', ipc: 'A01C 7/04' });
  assert.deepStrictEqual(F.inpiPatentes('<html>Nenhum resultado</html>'), { total: 0, itens: [] });

  // ── DataJud: índice por número CNJ ──
  assert.strictEqual(F.aliasDatajud('0001220-30.2024.8.16.0209'), 'api_publica_tjpr');
  assert.strictEqual(F.aliasDatajud('0001220-30.2024.8.24.0209'), 'api_publica_tjsc');
  assert.strictEqual(F.aliasDatajud('0001220-30.2024.8.26.0100'), 'api_publica_tjsp');
  assert.strictEqual(F.aliasDatajud('0001220-30.2024.8.07.0001'), 'api_publica_tjdft');
  assert.strictEqual(F.aliasDatajud('0000100-10.2024.5.09.0001'), 'api_publica_trt9');
  assert.strictEqual(F.aliasDatajud('5000100-10.2024.4.04.7000'), 'api_publica_trf4');
  assert.strictEqual(F.aliasDatajud('5000100-10.2024.4.07.7000'), null, 'não existe TRF7');
  assert.strictEqual(F.aliasDatajud('1220-30'), null, 'número incompleto não localiza');

  const r = F.datajudResumo({
    classe: { nome: 'Execução de Título Extrajudicial' },
    assuntos: [{ nome: 'Duplicata' }, { nome: 'Cheque' }],
    orgaoJulgador: { nome: 'Vara Cível de Dois Vizinhos' }, grau: 'G1',
    dataAjuizamento: '20240315000000', nivelSigilo: 0,
    movimentos: [
      { nome: 'Distribuição', dataHora: '2024-03-15T10:00:00.000Z' },
      { nome: 'Penhora', dataHora: '2026-08-02T14:00:00.000Z' },
      { nome: 'Citação', dataHora: '2024-05-01T09:00:00.000Z' },
    ],
  });
  assert.deepStrictEqual(r, {
    classe: 'Execução de Título Extrajudicial', assuntos: ['Duplicata', 'Cheque'],
    orgao: 'Vara Cível de Dois Vizinhos', grau: 'G1', ajuizamento: '2024-03-15',
    ultimo_andamento: { nome: 'Penhora', data: '2026-08-02' }, andamentos: 3, sigilo: 0,
  });
  assert.strictEqual(F.datajudResumo(null), null);
  assert.strictEqual(F.datajudResumo({ dataAjuizamento: '2024-03-15T00:00:00' }).ajuizamento, '2024-03-15');

  // ── DJEN: sinais no texto ──
  const s = F.sinaisTexto('<p>Expeça-se <b>alvará</b> em favor do exequente. Defiro a pesquisa via SISBAJUD e RENAJUD. '
    + 'Oficial certifica que o executado não foi localizado.</p>');
  assert.deepStrictEqual(s.map(x => x.tipo), ['alvara', 'bloqueio', 'veiculo', 'endereco']);
  assert.ok(s[0].trecho.includes('alvará em favor'), 'trecho sem tags HTML');
  assert.ok(!/</.test(s[0].trecho));
  assert.deepStrictEqual(F.sinaisTexto('Intime-se a parte para manifestação.'), []);
  const longo = F.sinaisTexto('x'.repeat(1000) + ' penhora do bem ' + 'y'.repeat(1000));
  assert.strictEqual(longo[0].tipo, 'penhora');
  assert.ok(longo[0].trecho.startsWith('…') && longo[0].trecho.endsWith('…'));
  assert.ok(longo[0].trecho.length < 400, 'trecho é recorte, não o texto inteiro');

  console.log('F-49 ok — INPI (titulares, marcas, patentes), DataJud e sinais do DJEN');
})().catch(e => { console.error(e); process.exit(1); });
