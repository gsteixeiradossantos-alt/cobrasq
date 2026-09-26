/*
 * Teste F-47 — vigia de ações (supabase/functions/vigia-acoes/logica.mjs).
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
 *   node test/f47_vigia_acoes_logica.test.js
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
  console.log('\nF-47 · vigia de ações — lógica de casamento.\n');

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

  // ── Filtro por UF (decisão do Gustavo, 25/09/2026: "nosso processo no Paraná, corta por Paraná")
  ok('UF do CNJ: TJPR, TRT9 e TRF4 (região com várias UFs)', () => {
    assert.deepStrictEqual(L.ufsDoCNJ('00055698220258160131'), ['PR']);       // 8.16 = TJPR
    assert.deepStrictEqual(L.ufsDoCNJ('00001231220255090001'), ['PR']);       // 5.09 = TRT9
    assert.ok(L.ufsDoCNJ('50001231220254047000').includes('PR'));             // 4.04 = TRF4
    assert.ok(L.ufsDoCNJ('50001231220254047000').includes('SC'));
    assert.deepStrictEqual(L.ufsDoCNJ('123'), []);
  });
  ok('UF de referência: CNJ → devedor → credor → PR', () => {
    assert.deepStrictEqual(L.ufReferencia({ cnj: '00055698220258160131', ufDevedor: 'SC' }), { uf: 'PR', fonte: 'cnj' });
    assert.deepStrictEqual(L.ufReferencia({ cnj: null, ufDevedor: 'sc', ufCredor: 'PR' }), { uf: 'SC', fonte: 'devedor' });
    assert.deepStrictEqual(L.ufReferencia({ cnj: null, ufDevedor: null, ufCredor: 'MT' }), { uf: 'MT', fonte: 'credor' });
    assert.deepStrictEqual(L.ufReferencia({}), { uf: 'PR', fonte: 'padrao' });
  });
  ok('achado em TJSP é cortado quando o nosso processo é no PR; TRF4 fica', () => {
    const sp = item({ numero_processo: '10001231220258260100', siglaTribunal: 'TJSP' });
    const r = L.agruparAchados([sp], 'Wesley Cechin Gobatto', new Set(), ['PR']);
    assert.strictEqual(r.achados.length, 0); assert.strictEqual(r.descartados.fora_da_uf, 1);
    const trf = item({ numero_processo: '50001231220254047000', siglaTribunal: 'TRF4' });
    assert.strictEqual(L.agruparAchados([trf], 'Wesley Cechin Gobatto', new Set(), ['PR']).achados.length, 1);
    const seeu = item({ numero_processo: '00001231220258160001', siglaTribunal: 'SEEU' });
    assert.strictEqual(L.agruparAchados([seeu], 'Wesley Cechin Gobatto', new Set(), ['PR']).descartados.outro_ramo, 1);
    assert.strictEqual(L.agruparAchados([item()], 'Wesley Cechin Gobatto', new Set(), ['PR']).achados.length, 1);
  });

  // ── Executados dos processos do escritório
  ok('campo executado: separa "A; B" e "A, B" sem quebrar "Ltda, ME"; tira COBRASQ', () => {
    assert.deepStrictEqual(L.nomesExecutados('Creative Soluções Visuais Ltda; Wesley Cechin Gobatto'), ['Creative Soluções Visuais Ltda', 'Wesley Cechin Gobatto']);
    assert.deepStrictEqual(L.nomesExecutados('Fulano Ltda, ME'), ['Fulano Ltda, ME']);
    assert.deepStrictEqual(L.nomesExecutados('A Silva, B Souza, C Lima'), ['A Silva', 'B Souza', 'C Lima']);
    assert.deepStrictEqual(L.nomesExecutados('COBRASQ RECUPERACAO DE CREDITO LTDA; Beltrano'), ['Beltrano']);
  });
  ok('Wesley entra como executado do escritório (0005569-82.2025.8.16.0131, UF PR)', () => {
    const alvos = L.montarAlvos([
      { origem: 'cobrasq', devedor_id: 'd1', cobranca_id: 'c1', nome: 'Ciclano de Tal', processo_ref: null, uf_devedor: 'SC', uf_credor: 'PR' },
      { origem: 'escritorio', nome: 'Creative Soluções Visuais Ltda; Wesley Cechin Gobatto', processo_ref: '00055698220258160131' },
      { origem: 'escritorio', nome: 'CICLANO DE TAL', processo_ref: '00001231220258160001' },   // já é devedor COBRASQ
    ]);
    const w = alvos.find(a => /Wesley/.test(a.nome));
    assert.strictEqual(w.alvo, 'esc:WESLEY CECHIN GOBATTO');
    assert.strictEqual(w.origem, 'escritorio');
    assert.strictEqual(w.processo_ref, '0005569-82.2025.8.16.0131');
    assert.deepStrictEqual(w.ufs, ['PR']);
    assert.strictEqual(alvos.filter(a => /ciclano/i.test(a.nome)).length, 1);   // sem alvo duplicado
    assert.deepStrictEqual(alvos.find(a => a.alvo === 'dev:d1').ufs, ['SC']);
  });

  // ── Decisões de 25/09/2026: instituições fora, teto de 5, CPF confere
  ok('banco, seguradora, cooperativa e ente público não viram alvo do escritório', () => {
    for (const n of ['BANCO BRADESCO S/A', 'UNIÃO - ADVOCACIA GERAL DA UNIÃO', 'Porto Seguro Companhia de Seguros Gerais',
                     'INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS', 'DEPARTAMENTO DE TRÂNSITO DO ESTADO DO PARANÁ - DETRAN/PR',
                     'Cooperativa de Crédito Sicredi', 'Estado do Paraná', 'Município de Cascavel', 'Caixa Econômica Federal'])
      assert.ok(L.ehInstituicao(n), n);
    for (const n of ['Wesley Cechin Gobatto', 'Braspress Transportes Urgentes Ltda', 'Silvano Martins José Vieira'])
      assert.ok(!L.ehInstituicao(n), n);
    const alvos = L.montarAlvos([
      { origem: 'escritorio', nome: 'BANCO BRADESCO S/A; Wesley Cechin Gobatto', processo_ref: '00055698220258160131' },
      { origem: 'escritorio', nome: 'UNIÃO - ADVOCACIA GERAL DA UNIÃO', processo_ref: '00001231220254047000' },
    ]);
    assert.deepStrictEqual(alvos.map(a => a.alvo), ['esc:WESLEY CECHIN GOBATTO']);
  });
  ok('CPF/CNPJ do devedor no texto do diário marca cpf_confere (formatado ou não)', () => {
    assert.ok(L.docConfere('executado FULANO, CPF 123.456.789-09, residente', '12345678909'));
    assert.ok(L.docConfere('CPF: 12345678909', '123.456.789-09'));
    assert.ok(L.docConfere('CNPJ nº 12.345.678/0001-95', '12345678000195'));
    assert.ok(!L.docConfere('CPF 111.222.333-44', '12345678909'));
    assert.ok(!L.docConfere('CPF 123.456.789-09', null));
    const r = L.agruparAchados([item({ texto: 'Autor WESLEY CECHIN GOBATTO, CPF 123.456.789-09' })], 'Wesley Cechin Gobatto', new Set(), ['PR'], '12345678909');
    assert.strictEqual(r.achados[0].cpf_confere, true);
    assert.strictEqual(L.agruparAchados([item()], 'Wesley Cechin Gobatto', new Set(), ['PR'], '12345678909').achados[0].cpf_confere, false);
  });
  ok('mais de 5 processos na mesma busca viram 1 aviso "Vários processos (N)" sem perder nenhum', () => {
    const mk = (i, polo) => ({ digitos: String(i).padStart(20, '1'), numero_processo: 'P' + i, polo, tribunal: i % 2 ? 'TJPR' : 'TRT9',
      primeira_data: '2026-09-2' + i, ultima_data: '2026-09-2' + i, comunicacoes: ['c' + i], cpf_confere: i === 3 });
    const cinco = [1, 2, 3, 4, 5].map(i => mk(i, 'P'));
    assert.strictEqual(L.resumirMuitos(cinco), cinco);   // até 5: um aviso por processo
    const seis = [...cinco, mk(6, 'A')];
    const [v, ...resto] = L.resumirMuitos(seis);
    assert.strictEqual(resto.length, 0);
    assert.strictEqual(v.digitos, '00000000000000000000');
    assert.strictEqual(v.numero_processo, 'Vários processos (6)');
    assert.strictEqual(v.polo, 'A');
    assert.strictEqual(v.processos.length, 6);
    assert.strictEqual(v.processos[0].polo, 'A');          // autor primeiro na lista
    assert.strictEqual(v.comunicacoes.length, 6);
    assert.strictEqual(v.cpf_confere, true);
    assert.strictEqual(v.primeira_data, '2026-09-21'); assert.strictEqual(v.ultima_data, '2026-09-26');
    assert.deepStrictEqual(v.tribunal.split(', ').sort(), ['TJPR', 'TRT9']);
  });

  ok('podarItens: repasse do Mac leva só o que tem o nome exato, sem homônimo "JUNIOR"', () => {
    const itens = [
      item({ id: 1, extra_grande: 'x'.repeat(100) }),
      item({ id: 2, destinatarios: [{ nome: 'WESLEY CECHIN GOBATTO JUNIOR', polo: 'A' }] }),
      item({ id: 3, destinatarios: [{ nome: 'OUTRA PESSOA', polo: 'P' }] }),
    ];
    const p = L.podarItens(itens, 'Wesley Cechin Gobatto');
    assert.deepStrictEqual(p.map(x => x.id), [1]);
    assert.strictEqual(p[0].extra_grande, undefined);           // só os campos que a função usa
    // o que sobrou continua virando o mesmo aviso do lado da função
    const { achados } = L.agruparAchados(p, 'Wesley Cechin Gobatto', new Set(), ['PR']);
    assert.strictEqual(achados.length, 1);
    assert.strictEqual(achados[0].polo, 'A');
  });

  console.log(`\nF-47 · ${n} verificações ok.`);
})().catch(e => { console.error('  FALHOU', e.message); process.exit(1); });
