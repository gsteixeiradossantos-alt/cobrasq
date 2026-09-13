/*
 * Teste F-40 — cliente SOAP da API CENPROT Empresas (api/_cenprot.js).
 *
 * O contrato é o manual v2.2 (04/06/2024) do IEPTB: envelope SOAP 1.1, valores com
 * ponto e 2 casas ("185.60" — sem ponto o CRA lê centavos 00), datas DD/MM/AAAA,
 * vencimento à vista = 99/99/9999, documentoTipo 1=CPF/2=CNPJ, operações só nos
 * status permitidos (REMOCAO ← Coletado/Gerado; DESISTENCIA ← Confirmado;
 * CANCELAMENTO ← Protestado). O retorno de ConsultarTitulo é lido a partir do
 * exemplo literal das páginas 13-14 do manual.
 *
 * Como rodar: node test/f40_cenprot_envelope.test.js
 */
'use strict';
const path = require('path');
const assert = require('assert');
let falhas = 0;
function checa(nome, fn) { try { fn(); console.log('  ok   ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); } }
async function checaAsync(nome, fn) { try { await fn(); console.log('  ok   ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); } }
console.log('\nF-40 · CENPROT: envelope, formatos, parser da consulta e regras de operação\n');

delete process.env.CENPROT_AMBIENTE; delete process.env.CENPROT_URL;
process.env.CENPROT_USUARIO = 'admin'; process.env.CENPROT_SENHA = 'admin12121'; process.env.CENPROT_APRESENTANTE = '999';
const cen = require(path.join(__dirname, '..', 'api', '_cenprot.js'));

checa('ambiente default é homologação (nunca protestar de verdade por engano)', () => {
  assert.strictEqual(cen.ambiente(), 'hml');
  assert.ok(cen.endpoint().includes('-hml/ProtestoInterface'));
});

checa('dinheiro: ponto decimal e 2 casas; aceita "1.234,56" e number', () => {
  assert.strictEqual(cen.dinheiro(185.6), '185.60');
  assert.strictEqual(cen.dinheiro('450'), '450.00');
  assert.strictEqual(cen.dinheiro('18.000,22'), '18000.22');
  assert.strictEqual(cen.dinheiro('abc'), '');
});

checa('data: ISO vira DD/MM/AAAA; já formatada passa', () => {
  assert.strictEqual(cen.data('2026-09-13'), '13/09/2026');
  assert.strictEqual(cen.data('2026-09-13T10:00:00Z'), '13/09/2026');
  assert.strictEqual(cen.data('20/04/2020'), '20/04/2020');
});

checa('documentoTipo: 11 dígitos = 1 (CPF), 14 = 2 (CNPJ)', () => {
  assert.strictEqual(cen.tipoDoc('014.640.018-63'), '1');
  assert.strictEqual(cen.tipoDoc('12.345.678/0001-90'), '2');
});

const titulo = {
  cedente: { nome: 'COBRASQ RECUPERADORA <LTDA>', documento: '12.345.678/0001-90', endereco: 'Rua Centro', numero: '123', cep: '85.660-000', bairro: 'Centro', municipio: 'Dois Vizinhos', uf: 'PR' },
  devedor: { nome: 'DEVEDOR & CIA', documento: '014.640.018-63', endereco: 'Rua do Brasil', numero: '321', cep: '04316000', bairro: 'Distrito 1', municipio: 'Agua Funda', uf: 'PR', principal: 'S' },
  divida: { especie: 'DMI', numero: '12458785', valor: '18.000,22', emissao: '2020-02-20', vencimento: '2020-04-20', declaracaoPortador: 'D', aceite: 'S' },
};

checa('montarTitulo: envelope com token, cedente, devedor, dívida e escape de XML', () => {
  const x = cen.montarTitulo(titulo, 'TOK');
  assert.ok(x.startsWith('<titulo xmlns=""><token>TOK</token><alteracao>N</alteracao>'));
  assert.ok(x.includes('<nome>COBRASQ RECUPERADORA &lt;LTDA&gt;</nome>'), 'escape de < >');
  assert.ok(x.includes('<nome>DEVEDOR &amp; CIA</nome>'), 'escape de &');
  assert.ok(x.includes('<cedente>') && x.includes('<documentoTipo>2</documentoTipo><documento>12345678000190</documento>'));
  assert.ok(x.includes('<devedor>') && x.includes('<documentoTipo>1</documentoTipo><documento>01464001863</documento>'));
  assert.ok(x.includes('<cep>85660000</cep>'), 'cep só dígitos');
  assert.ok(x.includes('<especie>DMI</especie><numero>12458785</numero><nossoNumero>12458785</nossoNumero><valor>18000.22</valor><saldo>18000.22</saldo>'));
  assert.ok(x.includes('<tipoEndosso>M</tipoEndosso><aceite>S</aceite><finsFalimentares>N</finsFalimentares><declaracaoPortador>D</declaracaoPortador>'));
  assert.ok(x.includes('<emissao>20/02/2020</emissao><vencimento>20/04/2020</vencimento>'));
  assert.ok(!x.includes('<sacador>'), 'sacador opcional omitido');
  assert.ok(!x.includes('<documento><'), 'bloco documento omitido sem base64');
});

checa('montarTitulo: vencimento à vista vira 99/99/9999', () => {
  const x = cen.montarTitulo({ ...titulo, divida: { ...titulo.divida, vencimentoAVista: true } }, 'TOK');
  assert.ok(x.includes('<vencimento>99/99/9999</vencimento>'));
});

checa('montarTitulo: recusa espécie inválida, declaração inválida, devedor sem CPF', () => {
  assert.throws(() => cen.montarTitulo({ ...titulo, divida: { ...titulo.divida, especie: 'XYZ' } }, 'T'), /Espécie inválida/);
  assert.throws(() => cen.montarTitulo({ ...titulo, divida: { ...titulo.divida, declaracaoPortador: 'Z' } }, 'T'), /declaracaoPortador/);
  assert.throws(() => cen.montarTitulo({ ...titulo, devedor: { nome: 'X', documento: '123' } }, 'T'), /Devedor/);
  assert.throws(() => cen.montarTitulo(titulo, ''), /Token/);
});

checa('envelope SOAP 1.1 com namespace do ambiente', () => {
  const e = cen.envelope('Autenticar', '<credenciais xmlns=""></credenciais>');
  assert.ok(e.includes('<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body><Autenticar xmlns="https://wspub.cenprotnacional.org.br/ieptb-cenprot-empresas-arquivos-hml/services">'));
});

const RESPOSTA_AUTH = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<ns2:AutenticarResponse xmlns:ns2="https://wspub.cenprotnacional.org.br/ieptb-cenprot-empresas-arquivos-hml/services">
<credenciais><resposta><codigo>WS_SUC_101</codigo><mensagem>Autenticado com Sucesso</mensagem><status>true</status></resposta>
<ns2:token>4658314f04dc2fd427e90bdcaa1f0e1445f6ba5a560c5a50432fdddcaaed3e37</ns2:token></credenciais>
</ns2:AutenticarResponse></soap:Body></soap:Envelope>`;

const RESPOSTA_CONSULTA = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<ns2:ConsultarTituloResponse xmlns:ns2="https://wspub.cenprotnacional.org.br/ieptb-cenprot-empresas-arquivos-hml/services">
<titulo><sacador><documento>07203467000150</documento></sacador><devedor><documento>98810356743</documento></devedor>
<divida><numero>162090393</numero><nossoNumero>1939390</nossoNumero><especie>DMI</especie><vencimento>10/05/2019</vencimento><emissao>08/01/2019</emissao></divida>
<cartorio><data>22/05/2020</data><comarca>4210100</comarca><cartorio>02</cartorio><protocolo>23901494-4</protocolo></cartorio>
<ocorrencia><dataHora>21/05/2020 13:01:15</dataHora><status>GERADO</status><mensagem>IMPORTADO POR ARQUIVO</mensagem><custas><distribuidor>0.0</distribuidor><cartorio>0.0</cartorio><gravacao>0.0</gravacao><despesas>0.0</despesas></custas><protocolo/></ocorrencia>
<ocorrencia><dataHora>22/05/2020 15:20:00</dataHora><status>CONFIRMADO</status><mensagem>01/23900594-4</mensagem><custas><distribuidor>15.15</distribuidor><cartorio>0.0</cartorio><gravacao>5.0</gravacao><despesas>0.0</despesas></custas><protocolo><dataProtocolo>22/05/2020</dataProtocolo><codigoCartorio>02</codigoCartorio><protocoloCartorio>23900594-4</protocoloCartorio></protocolo></ocorrencia>
<ocorrencia><dataHora>01/06/2020 15:23:00</dataHora><status>PROTESTADO</status><mensagem>02/23900594-4</mensagem><custas><distribuidor>0.0</distribuidor><cartorio>580.8</cartorio><gravacao>0.0</gravacao><despesas>0.0</despesas></custas><protocolo><dataProtocolo>22/05/2020</dataProtocolo><codigoCartorio>02</codigoCartorio><protocoloCartorio>23900594-4</protocoloCartorio></protocolo></ocorrencia>
<custas><confirmacao>0.0</confirmacao><retorno>500.8</retorno><despesas>0.0</despesas><gravacao_eletronica>5.0</gravacao_eletronica><distribuicao_confirmacao>15.15</distribuicao_confirmacao><distribuicao_retorno>0.0</distribuicao_retorno></custas>
<resposta><codigo>PROTESTADO</codigo><mensagem>02/23900594-4 CRA: Protestado</mensagem><status>true</status></resposta>
</titulo></ns2:ConsultarTituloResponse></soap:Body></soap:Envelope>`;

checa('lerConsulta: exemplo do manual → PROTESTADO, protocolo, custas e 3 ocorrências', () => {
  const c = cen.lerConsulta(RESPOSTA_CONSULTA);
  assert.strictEqual(c.statusAtual, 'PROTESTADO');
  assert.strictEqual(c.resposta.status, true);
  assert.deepStrictEqual(c.cartorio, { data: '22/05/2020', comarca: '4210100', cartorio: '02', protocolo: '23901494-4' });
  assert.strictEqual(c.ocorrencias.length, 3);
  assert.strictEqual(c.ocorrencias[1].status, 'CONFIRMADO');
  assert.strictEqual(c.ocorrencias[1].custas.distribuidor, 15.15);
  assert.strictEqual(c.ocorrencias[1].protocolo.protocoloCartorio, '23900594-4');
  assert.strictEqual(c.ocorrencias[2].custas.cartorio, 580.8);
  assert.strictEqual(c.custas.retorno, 500.8);
  assert.strictEqual(c.custas.distribuicao_confirmacao, 15.15);
});

// fetch falso: responde conforme a operação do envelope e guarda o que foi enviado.
function fetchFalso(log) {
  return async (url, opts) => {
    log.push({ url, body: opts.body });
    const b = opts.body;
    let xml = '';
    if (b.includes('<Autenticar ')) xml = RESPOSTA_AUTH;
    else if (b.includes('<ConsultarTitulo ')) xml = RESPOSTA_CONSULTA;
    else xml = '<soap:Envelope><soap:Body><r><resposta><codigo>WS_SUC_201</codigo><mensagem>ok</mensagem><status>true</status></resposta></r></soap:Body></soap:Envelope>';
    return { ok: true, status: 200, text: async () => xml };
  };
}

(async () => {
  await checaAsync('autenticar: envia credenciais, lê token com prefixo ns2 e reaproveita na 2ª chamada', async () => {
    cen._resetToken();
    const log = [];
    const f = fetchFalso(log);
    const t1 = await cen.autenticar(f);
    assert.strictEqual(t1, '4658314f04dc2fd427e90bdcaa1f0e1445f6ba5a560c5a50432fdddcaaed3e37');
    assert.ok(log[0].body.includes('<usuario>admin</usuario><senha>admin12121</senha><apresentante>999</apresentante>'));
    assert.ok(log[0].url.includes('-hml/ProtestoInterface'));
    await cen.autenticar(f);
    assert.strictEqual(log.length, 1, 'token em cache — não autentica de novo');
  });

  await checaAsync('enviarTitulo: autentica e manda EnviarTitulo com o token', async () => {
    cen._resetToken();
    const log = [];
    const r = await cen.enviarTitulo(titulo, fetchFalso(log));
    assert.strictEqual(r.resposta.status, true);
    assert.ok(log[1].body.includes('<EnviarTitulo ') && log[1].body.includes('<token>4658314f04dc'));
  });

  await checaAsync('consultarTitulo: monta chave (devedor, dívida, cartório) e devolve status', async () => {
    cen._resetToken();
    const log = [];
    const r = await cen.consultarTitulo({ devedorDocimento: '', devedorDocumento: '988.103.567-43', numero: '162090393', especie: 'DMI', vencimento: '2019-05-10', emissao: '2019-01-08', protocolo: '23901494-4', dataProtocolo: '22/05/2020' }, fetchFalso(log));
    assert.strictEqual(r.statusAtual, 'PROTESTADO');
    const b = log[1].body;
    assert.ok(b.includes('<completa>S</completa><instrumento>N</instrumento><anuencia>N</anuencia>'));
    assert.ok(b.includes('<devedor><documento>98810356743</documento></devedor>'));
    assert.ok(b.includes('<vencimento>10/05/2019</vencimento><emissao>08/01/2019</emissao>'));
    assert.ok(b.includes('<cartorio><protocolo>23901494-4</protocolo><dataProtocolo>22/05/2020</dataProtocolo></cartorio>'));
  });

  await checaAsync('operacaoTitulo: respeita a tabela status→operação do manual', async () => {
    cen._resetToken();
    const log = [];
    const f = fetchFalso(log);
    const base = { devedorDocumento: '98810356743', numero: '12334', vencimento: '00/02/2020', especie: 'DMI', justificativa: 'pago direto ao credor' };
    await assert.rejects(cen.operacaoTitulo({ ...base, operacao: 'CANCELAMENTO', statusAtual: 'CONFIRMADO' }, f), /só cabe com status PROTESTADO/);
    await assert.rejects(cen.operacaoTitulo({ ...base, operacao: 'DESISTENCIA', statusAtual: 'PROTESTADO' }, f), /só cabe com status CONFIRMADO/);
    await assert.rejects(cen.operacaoTitulo({ ...base, operacao: 'REMOCAO', statusAtual: 'CONFIRMADO' }, f), /só cabe com status COLETADO\/GERADO/);
    await assert.rejects(cen.operacaoTitulo({ ...base, operacao: 'SUMIR' }, f), /Operação inválida/);
    const r = await cen.operacaoTitulo({ ...base, operacao: 'CANCELAMENTO', statusAtual: 'PROTESTADO' }, f);
    assert.strictEqual(r.resposta.status, true);
    const b = log[log.length - 1].body;
    assert.ok(b.includes('<OperacaoTitulo ') && b.includes('<autoriza>S</autoriza><operacao>CANCELAMENTO</operacao><justificativa>pago direto ao credor</justificativa>'));
  });

  await checaAsync('sem credencial: configurado() false e autenticar recusa antes de bater na rede', async () => {
    const u = process.env.CENPROT_USUARIO; delete process.env.CENPROT_USUARIO; cen._resetToken();
    assert.strictEqual(cen.configurado(), false);
    let chamou = false;
    await assert.rejects(cen.autenticar(async () => { chamou = true; }), /não configurado/);
    assert.strictEqual(chamou, false);
    process.env.CENPROT_USUARIO = u;
  });

  checa('_protesto: devedores/clientes → bloco de pessoa (endereço separado tem precedência)', () => {
    const h = require(path.join(__dirname, '..', 'api', '_protesto.js'));
    const p = h._pessoaDoBanco({ nome: 'Fulano', doc: '014.640.018-63', rua: 'Rua A', numero: '10', cep: '85660-000', bairro: 'B', cidade: 'Marmeleiro', uf: 'pr', endereco: 'texto livre' }, { principal: 'S' });
    assert.deepStrictEqual(p, { nome: 'Fulano', documento: '01464001863', endereco: 'Rua A', numero: '10', complemento: '', cep: '85660000', bairro: 'B', municipio: 'Marmeleiro', uf: 'PR', principal: 'S' });
    const q = h._pessoaDoBanco({ nome: 'X', doc: '1', endereco: 'Av. Livre, 5' });
    assert.strictEqual(q.endereco, 'Av. Livre, 5'); assert.strictEqual(q.numero, 'S/N');
  });

  console.log(falhas ? `\n${falhas} falha(s)\n` : '\nTodos passaram.\n');
  process.exit(falhas ? 1 : 0);
})();
