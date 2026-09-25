/*
 * Teste F-46 — vigia de ações (supabase/functions/vigia-acoes/logica.mjs).
 *
 * O devedor Wesley Cechin Gobatto (executado por nós no 0005569-82.2025.8.16.0131)
 * era AUTOR do 0002110-19.2025.8.16.0181 (JEC Marmeleiro) e levantou ~R$ 4.600 sem
 * sabermos. A Edge Function busca cada devedor ativo no DJEN; este teste trava as
 * três armadilhas medidas na API em 25/09/2026:
 *   1) `nomeParte` casa por prefixo ("Adilson Ferreira" trouxe "… DA SILVA" etc.);
 *   2) nome de cadastro sujo ("50.677.114 Fulano (MEI)", "Fulano | Fantasia");
 *   3) processo nosso (OAB do escritório, parte COBRASQ, CNJ já cadastrado) não é alerta.
 *
 * Como rodar:
 *   node test/f46_vigia_acoes_logica.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const item = (o) => Object.assign({
  id: 1, data_disponibilizacao: '2026-09-20', siglaTribunal: 'TJPR',
  nomeOrgao: 'Juizado Especial Cível de Marmeleiro', nomeClasse: 'EXECUÇÃO DE TÍTULO EXTRAJUDICIAL',
  numero_processo: '00021101920258160181', link: 'https://projudi.tjpr.jus.br/x', texto: '<p>Intimação</p>',
  destinatarios: [{ nome: 'WESLEY CECHIN GOBATTO', polo: 'A' }, { nome: 'FULANO DE TAL', polo: 'P' }],
  destinatarioadvogados: [{ advogado: { nome: 'ADILSON INHANCE JUNIOR', numero_oab: '65083', uf_oab: 'PR' } }],
}, o);

(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'vigia-acoes', 'logica.mjs')).href);
  let n = 0; const ok = (nome, fn) => { fn(); n++; console.log('  ok  ' + nome); };
  console.log('\nF-46 · vigia de ações — lógica de casamento.\n');

  ok('nome sujo de MEI vira nome de busca limpo', () => {
    assert.deepStrictEqual(L.nomeDeBusca('50.677.114 Jeferson Luciano Pereira (MEI)'), { busca: 'Jeferson Luciano Pereira', motivo: null });
    assert.strictEqual(L.nomeDeBusca('52.768.123 Luciano Alves de Meira | Design Gesso').busca, 'Luciano Alves de Meira');
    assert.strictEqual(L.nomeDeBusca('Edenilson dos Santos 07238395908').busca, 'Edenilson dos Santos');
    assert.strictEqual(L.nomeDeBusca('Claudemir Mattei "Peixe"').busca, 'Claudemir Mattei');
    assert.strictEqual(L.nomeDeBusca('SS Funilaria e Vidraçaria / 54.687.183 Silvano Mezzalira').busca, 'Silvano Mezzalira');
    assert.strictEqual(L.nomeDeBusca('Katarina Feitosa da Silva LTDA - Lojas BBB').busca, 'Katarina Feitosa da Silva LTDA');
    assert.strictEqual(L.nomeDeBusca('Ana Patrícia dos Santos (resp. por Taina Vitoria dos Santos)').busca, 'Ana Patrícia dos Santos');
    assert.strictEqual(L.nomeDeBusca('Luiz Henrique M. de Oliveira.').busca, 'Luiz Henrique M. de Oliveira');
  });
  ok('nome curto não é buscado (homônimo demais)', () => {
    assert.strictEqual(L.nomeDeBusca('A Guerra').busca, null);
    assert.strictEqual(L.nomeDeBusca('Maria').motivo, 'nome_curto');
  });
  ok('acento, caixa e sufixo societário não atrapalham', () => {
    assert.strictEqual(L.chaveNome('José da Silva Ltda - ME'), L.chaveNome('JOSE DA SILVA LTDA'));
    assert.ok(L.destinatarioCasa('MARIA (menor) REPRESENTADA POR JOSÉ DA SILVA', L.chaveNome('Jose da Silva')));
  });
  ok('Wesley: polo A no 0002110-19.2025.8.16.0181 vira achado', () => {
    const r = L.agruparAchados([item({ id: 1 }), item({ id: 2, data_disponibilizacao: '2026-09-22' })], 'Wesley Cechin Gobatto', new Set());
    assert.strictEqual(r.achados.length, 1);
    const a = r.achados[0];
    assert.strictEqual(a.numero_processo, '0002110-19.2025.8.16.0181');
    assert.strictEqual(a.polo, 'A');
    assert.deepStrictEqual([a.primeira_data, a.ultima_data], ['2026-09-20', '2026-09-22']);
    assert.deepStrictEqual(a.comunicacoes, ['1', '2']);
    assert.ok(a.advogados[0].includes('65083/PR'));
    assert.strictEqual(a.ultimo_texto, 'Intimação');
  });
  ok('busca por prefixo: "ADILSON FERREIRA DA SILVA" não casa com "Adilson Ferreira"', () => {
    const it = item({ destinatarios: [{ nome: 'ADILSON FERREIRA DA SILVA', polo: 'P' }] });
    const r = L.agruparAchados([it], 'Adilson Ferreira', new Set());
    assert.strictEqual(r.achados.length, 0);
    assert.strictEqual(r.descartados.nome_diferente, 1);
    const r2 = L.agruparAchados([item({ destinatarios: [{ nome: 'ADILSON FERREIRA', polo: 'P' }] })], 'Adilson Ferreira', new Set());
    assert.strictEqual(r2.achados[0].polo, 'P');
  });
  ok('processo com OAB nossa (112743/PR, 119424/PR) é descartado', () => {
    for (const oab of ['112743', '119424']) {
      const it = item({ destinatarioadvogados: [{ advogado: { nome: 'X', numero_oab: oab, uf_oab: 'PR' } }] });
      const r = L.agruparAchados([it], 'Wesley Cechin Gobatto', new Set());
      assert.strictEqual(r.achados.length, 0); assert.strictEqual(r.descartados.nosso, 1);
    }
  });
  ok('parte COBRASQ / Teixeira & Azzolin é descartada', () => {
    const it = item({ destinatarios: [{ nome: 'WESLEY CECHIN GOBATTO', polo: 'P' }, { nome: 'COBRASQ RECUPERACAO DE CREDITO LTDA', polo: 'A' }] });
    assert.strictEqual(L.agruparAchados([it], 'Wesley Cechin Gobatto', new Set()).achados.length, 0);
    assert.strictEqual(L.ehProcessoNosso({ destinatarios: [{ nome: 'Teixeira & Azzolin Advogados' }] }, new Set()), 'parte_nossa');
  });
  ok('CNJ já cadastrado em cobranças (nossa execução) é descartado', () => {
    const it = item({ numero_processo: '00055698220258160131' });
    const r = L.agruparAchados([it], 'Wesley Cechin Gobatto', new Set(['00055698220258160131']));
    assert.strictEqual(r.achados.length, 0);
  });
  ok('polo A prevalece quando o mesmo processo traz A e P', () => {
    const r = L.agruparAchados([item({ id: 1, destinatarios: [{ nome: 'WESLEY CECHIN GOBATTO', polo: 'P' }] }), item({ id: 2 })], 'Wesley Cechin Gobatto', new Set());
    assert.strictEqual(r.achados[0].polo, 'A');
  });

  console.log(`\nF-46 · ${n} verificações ok.`);
})().catch(e => { console.error('  FALHOU', e.message); process.exit(1); });
