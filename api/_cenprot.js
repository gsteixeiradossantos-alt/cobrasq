// api/_cenprot.js — Cliente SOAP da API CENPROT Empresas (IEPTB / CRA Nacional),
// documentação "API CENPROT EMPRESAS — Requisições e Consultas, v2.2, 04/06/2024".
//
// Quatro operações, todas por POST SOAP 1.1 no mesmo endpoint:
//   Autenticar      → token (usuario, senha, apresentante)
//   EnviarTitulo    → apresenta um título a protesto (cedente, sacador, devedor, dívida)
//   ConsultarTitulo → situação do título + ocorrências + custas + protocolo do cartório
//   OperacaoTitulo  → REMOCAO (status Coletado/Gerado), DESISTENCIA (Confirmado),
//                     CANCELAMENTO (Protestado)
//
// Sem dependência externa: o envelope é montado à mão e a resposta é lida por regex de
// tags — o XML do CRA é plano (sem atributos relevantes, sem namespaces nos filhos).
//
// Envs (Vercel):
//   CENPROT_USUARIO / CENPROT_SENHA / CENPROT_APRESENTANTE — credenciais do convênio
//   CENPROT_AMBIENTE   — 'hml' (default) | 'prod'
//   CENPROT_COD_PORTADOR / CENPROT_NOME_PORTADOR — bloco <geral> do EnviarTitulo (opcional)
//   CENPROT_URL        — sobrescreve o endpoint (testes)
// Tudo é GATED: sem credencial, `configurado()` é false e o handler devolve { pendente }.

const URLS = {
  hml: 'https://wspub.cenprotnacional.org.br/ieptb-cenprot-empresas-arquivos-hml/ProtestoInterface',
  prod: 'https://wspub.cenprotnacional.org.br/ieptb-cenprot-empresas-arquivos/ProtestoInterface',
};
const NS = {
  hml: 'https://wspub.cenprotnacional.org.br/ieptb-cenprot-empresas-arquivos-hml/services',
  prod: 'https://wspub.cenprotnacional.org.br/ieptb-cenprot-empresas-arquivos/services',
};

// Status que a consulta devolve (manual, p. 15). Integrador = ainda na CRA; CRA = já no cartório.
const STATUS_INTEGRADOR = ['INEXISTENTE', 'COLETADO', 'GERADO', 'AGENDADO', 'ENVIADO'];
const STATUS_CRA = ['CONFIRMADO', 'DEVOLVIDO', 'CANCELADO', 'PAGO', 'PROTESTADO', 'RETIRADO', 'SUSTADO', 'SUSPENSO'];

// Operação permitida por status (manual, p. 16).
const OPERACOES = {
  REMOCAO: ['COLETADO', 'GERADO'],
  DESISTENCIA: ['CONFIRMADO'],
  CANCELAMENTO: ['PROTESTADO'],
};

// Espécies aceitas pela CRA (manual, p. 17-18) — sigla → o que o cartório exige.
const ESPECIES = {
  CCB: 'Cédula de Crédito Bancário', CBI: 'CCB por Indicação', CCC: 'Cédula de Crédito Comercial',
  CCE: 'Cédula de Crédito à Exportação', CCI: 'Cédula de Crédito Industrial', CCR: 'Cédula de Crédito Rural',
  CCT: 'Cédula de Crédito Trabalhista', CHP: 'Cédula Hipotecária', CPR: 'Cédula do Produtor Rural',
  CRH: 'Cédula Rural Hipotecária', CRP: 'Cédula Rural Pignoratícia', CPH: 'Cédula Rural Pignoratícia Hipotecária',
  CDA: 'Certidão de Dívida Ativa', CDJ: 'Certidão de Decisão Judicial', CE: 'Certidão de Emolumentos',
  CH: 'Cheque', CD: 'Confissão de Dívida', CPS: 'Conta de Prestação de Serviços', CAF: 'Contrato de Alienação Fiduciária',
  CAM: 'Contrato de Arrendamento Mercantil', CA: 'Contrato de Aluguel', CC: 'Contrato de Câmbio',
  CRD: 'Contrato de Compra e Venda com Reserva de Domínio', CM: 'Contrato de Mútuo', CL: 'Contrato de Locação',
  DBT: 'Debêntures', DD: 'Diversos', DM: 'Duplicata de Venda Mercantil', DMI: 'Duplicata de Venda Mercantil por Indicação',
  DR: 'Duplicata Rural', DRI: 'Duplicata Rural por Indicação', DS: 'Duplicata de Prestação de Serviços',
  DSI: 'Duplicata de Prestação de Serviços por Indicação', EC: 'Encargos Condominiais', LC: 'Letra de Câmbio',
  NCC: 'Nota de Crédito Comercial', NCE: 'Nota de Crédito à Exportação', NCI: 'Nota de Crédito Industrial',
  NCR: 'Nota de Crédito Rural', NP: 'Nota Promissória', NPR: 'Nota Promissória Rural', SJ: 'Sentença Judicial',
  TA: 'Termo de Acordo', TC: 'Termo de Conciliação da Justiça do Trabalho', TM: 'Triplicata de Venda Mercantil',
  TS: 'Triplicata de Prestação de Serviços', W: 'Warrant',
};

// Declaração do portador (manual, p. 19): D = DMI/DSI com documentação em posse; A = título
// que exige o original; G = dispensa documentação; I = envia imagem; C = CCB/CBI em posse.
const DECLARACOES = ['D', 'A', 'G', 'I', 'C'];

function ambiente() { return (process.env.CENPROT_AMBIENTE || 'hml').toLowerCase() === 'prod' ? 'prod' : 'hml'; }
function endpoint() { return process.env.CENPROT_URL || URLS[ambiente()]; }
function configurado() { return !!(process.env.CENPROT_USUARIO && process.env.CENPROT_SENHA); }

function onlyDigits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Valores monetários: ponto decimal, 2 casas ("185.60"); sem pontuação o CRA lê como centavos 00.
function dinheiro(v) {
  const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}
// Datas: DD/MM/AAAA. Aceita ISO (2026-09-13) ou já formatada. À vista = 99/99/9999.
function data(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}
// documentoTipo: 1 = CPF, 2 = CNPJ (manual, p. 4-5).
function tipoDoc(doc) { return onlyDigits(doc).length === 14 ? '2' : '1'; }

// <tag>valor</tag>, omitida quando o valor é vazio/nulo (as tags marcadas string? são opcionais).
function tag(nome, valor) {
  if (valor == null || valor === '') return '';
  return `<${nome}>${esc(valor)}</${nome}>`;
}

function blocoPessoa(nome, p) {
  if (!p) return '';
  return `<${nome}>` +
    tag('nome', p.nome) + tag('documentoTipo', tipoDoc(p.documento)) + tag('documento', onlyDigits(p.documento)) +
    tag('endereco', p.endereco) + tag('numero', p.numero) + tag('complemento', p.complemento) +
    tag('cep', onlyDigits(p.cep)) + tag('bairro', p.bairro) + tag('municipio', p.municipio) + tag('uf', p.uf) +
    (nome === 'cedente' ? tag('codigo', p.codigo) : '') +
    (nome === 'devedor' ? tag('principal', p.principal) + tag('fone', p.fone) + tag('email', p.email) : '') +
    `</${nome}>`;
}

function envelope(operacao, corpo) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body>` +
    `<${operacao} xmlns="${NS[ambiente()]}">${corpo}</${operacao}>` +
    `</Body></Envelope>`;
}

// Valida e monta o <titulo> do EnviarTitulo. Lança Error com mensagem legível.
function montarTitulo(t, token) {
  if (!t || typeof t !== 'object') throw new Error('Título ausente.');
  const d = t.divida || {};
  const dev = t.devedor;
  if (!token) throw new Error('Token ausente — autentique antes.');
  if (!dev || !dev.nome || onlyDigits(dev.documento).length < 11) throw new Error('Devedor: nome e CPF/CNPJ são obrigatórios.');
  if (!t.cedente || !t.cedente.nome || onlyDigits(t.cedente.documento).length < 11) throw new Error('Cedente (credor): nome e CPF/CNPJ são obrigatórios.');
  if (!ESPECIES[d.especie]) throw new Error(`Espécie inválida: ${d.especie}. Ver ESPECIES.`);
  if (!d.numero) throw new Error('Dívida: número do título é obrigatório.');
  if (!dinheiro(d.valor)) throw new Error('Dívida: valor inválido.');
  if (!data(d.emissao) || !data(d.vencimento)) throw new Error('Dívida: emissão e vencimento são obrigatórios (DD/MM/AAAA).');
  if (!DECLARACOES.includes(d.declaracaoPortador)) throw new Error(`declaracaoPortador inválida: ${d.declaracaoPortador} (D, A, G, I ou C).`);

  const geral = (process.env.CENPROT_COD_PORTADOR || t.geral)
    ? '<geral>' + tag('codPortador', (t.geral && t.geral.codPortador) || process.env.CENPROT_COD_PORTADOR) +
      tag('nomePortador', (t.geral && t.geral.nomePortador) || process.env.CENPROT_NOME_PORTADOR) +
      tag('dataMovimento', data((t.geral && t.geral.dataMovimento) || new Date().toISOString())) +
      tag('versaoLayout', (t.geral && t.geral.versaoLayout) || '') + '</geral>'
    : '';

  const documento = d.documentoBase64
    ? '<documento>' + tag('extensao', d.extensao || 'pdf') + tag('documentoBase64', d.documentoBase64) + '</documento>'
    : '';
  const planilha = d.planilha
    ? '<planilha>' + tag('juros', d.planilha.juros) + tag('multa', d.planilha.multa) + tag('mora', d.planilha.mora) +
      (Array.isArray(d.planilha.calculo) ? d.planilha.calculo.map((c) => '<calculo>' +
        tag('parcela', c.parcela) + tag('vencimento', data(c.vencimento)) + tag('valor', dinheiro(c.valor)) +
        tag('saldo', dinheiro(c.saldo)) + tag('juros', dinheiro(c.juros)) + tag('multa', dinheiro(c.multa)) +
        tag('mora', dinheiro(c.mora)) + tag('observacao', c.observacao) + '</calculo>').join('') : '') +
      '</planilha>'
    : '';

  return '<titulo xmlns="">' +
    tag('token', token) + tag('alteracao', t.alteracao || 'N') + geral +
    blocoPessoa('cedente', t.cedente) + blocoPessoa('sacador', t.sacador) +
    (Array.isArray(t.devedores) ? t.devedores.map((x) => blocoPessoa('devedor', x)).join('') : blocoPessoa('devedor', dev)) +
    '<divida>' +
      tag('especie', d.especie) + tag('numero', d.numero) + tag('nossoNumero', d.nossoNumero || d.numero) +
      tag('valor', dinheiro(d.valor)) + tag('saldo', dinheiro(d.saldo != null ? d.saldo : d.valor)) +
      tag('tipoEndosso', d.tipoEndosso || 'M') + tag('aceite', d.aceite || 'N') +
      tag('finsFalimentares', d.finsFalimentares || 'N') + tag('declaracaoPortador', d.declaracaoPortador) +
      tag('emissao', data(d.emissao)) + tag('vencimento', d.vencimentoAVista ? '99/99/9999' : data(d.vencimento)) +
      documento + planilha + tag('pracaManual', d.pracaManual) + tag('anotacao', d.anotacao) +
    '</divida>' +
    '</titulo>';
}

// Leitura do XML de resposta: primeiro valor de <tag>, e lista de blocos <tag>…</tag>.
function pega(xml, nome) {
  const m = String(xml || '').match(new RegExp(`<(?:[\\w-]+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nome}>`));
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() : '';
}
function blocos(xml, nome) {
  const re = new RegExp(`<(?:[\\w-]+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nome}>`, 'g');
  const out = []; let m;
  while ((m = re.exec(String(xml || '')))) out.push(m[1]);
  return out;
}
function resposta(xml) {
  const r = pega(xml, 'resposta');
  return { codigo: pega(r, 'codigo'), mensagem: pega(r, 'mensagem'), status: pega(r, 'status') === 'true' };
}

// Interpreta o retorno do ConsultarTitulo (manual, p. 13-15).
function lerConsulta(xml) {
  const t = pega(xml, 'titulo') || xml;
  const ocorrencias = blocos(t, 'ocorrencia').map((o) => ({
    dataHora: pega(o, 'dataHora'), status: pega(o, 'status'), mensagem: pega(o, 'mensagem'),
    custas: {
      distribuidor: Number(pega(o, 'distribuidor') || 0), cartorio: Number(pega(o, 'cartorio') || 0),
      gravacao: Number(pega(o, 'gravacao') || 0), despesas: Number(pega(o, 'despesas') || 0),
    },
    protocolo: {
      dataProtocolo: pega(pega(o, 'protocolo'), 'dataProtocolo'), codigoCartorio: pega(pega(o, 'protocolo'), 'codigoCartorio'),
      protocoloCartorio: pega(pega(o, 'protocolo'), 'protocoloCartorio'),
    },
  }));
  // O bloco <cartorio> do título tem um filho também chamado <cartorio> (código); o
  // casamento não-guloso pararia no filho, então ancoramos no <protocolo> que o fecha.
  const mc = t.match(/<cartorio>(<data>[\s\S]*?<\/protocolo>)<\/cartorio>/);
  const cart = mc ? mc[1] : pega(t, 'cartorio');
  const custasTot = blocos(t, 'custas').pop() || '';
  const ultimo = ocorrencias.length ? ocorrencias[ocorrencias.length - 1].status : '';
  return {
    resposta: resposta(t),
    statusAtual: (resposta(t).codigo || ultimo || '').toUpperCase(),
    cartorio: { data: pega(cart, 'data'), comarca: pega(cart, 'comarca'), cartorio: pega(cart, 'cartorio'), protocolo: pega(cart, 'protocolo') },
    custas: {
      confirmacao: Number(pega(custasTot, 'confirmacao') || 0), retorno: Number(pega(custasTot, 'retorno') || 0),
      despesas: Number(pega(custasTot, 'despesas') || 0), gravacao_eletronica: Number(pega(custasTot, 'gravacao_eletronica') || 0),
      distribuicao_confirmacao: Number(pega(custasTot, 'distribuicao_confirmacao') || 0),
      distribuicao_retorno: Number(pega(custasTot, 'distribuicao_retorno') || 0),
    },
    ocorrencias,
  };
}

async function soap(operacao, corpo, fetchImpl) {
  const f = fetchImpl || fetch;
  const r = await f(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: envelope(operacao, corpo),
  });
  const xml = await r.text();
  if (!r.ok) throw new Error(`CENPROT ${operacao}: HTTP ${r.status} — ${xml.slice(0, 300)}`);
  const fault = pega(xml, 'faultstring');
  if (fault) throw new Error(`CENPROT ${operacao}: ${fault}`);
  return xml;
}

// Token dura a sessão; guardamos por 50 min por instância (cold start renova).
let _token = null, _tokenEm = 0;
async function autenticar(fetchImpl) {
  if (!configurado()) throw new Error('CENPROT não configurado (CENPROT_USUARIO/SENHA).');
  if (_token && Date.now() - _tokenEm < 50 * 60 * 1000) return _token;
  const corpo = '<credenciais xmlns="">' + tag('usuario', process.env.CENPROT_USUARIO) +
    tag('senha', process.env.CENPROT_SENHA) + tag('apresentante', process.env.CENPROT_APRESENTANTE) + '</credenciais>';
  const xml = await soap('Autenticar', corpo, fetchImpl);
  const resp = resposta(xml);
  const token = pega(xml, 'token');
  if (!resp.status || !token) throw new Error(`CENPROT Autenticar: ${resp.codigo} ${resp.mensagem}`);
  _token = token; _tokenEm = Date.now();
  return token;
}

async function enviarTitulo(titulo, fetchImpl) {
  const token = await autenticar(fetchImpl);
  const xml = await soap('EnviarTitulo', montarTitulo(titulo, token), fetchImpl);
  return { resposta: resposta(xml), xml };
}

async function consultarTitulo(chave, fetchImpl) {
  const token = await autenticar(fetchImpl);
  const c = chave || {};
  const corpo = tag('token', token) + tag('completa', c.completa || 'S') + tag('instrumento', c.instrumento || 'N') +
    tag('anuencia', c.anuencia || 'N') +
    '<titulo xmlns="">' +
      '<devedor>' + tag('documento', onlyDigits(c.devedorDocumento)) + tag('nome', c.devedorNome) + '</devedor>' +
      '<divida>' + tag('numero', c.numero) + tag('nossoNumero', c.nossoNumero || c.numero) + tag('especie', c.especie) +
        tag('vencimento', data(c.vencimento)) + tag('emissao', data(c.emissao)) + tag('praca', c.praca) + '</divida>' +
      (c.protocolo ? '<cartorio>' + tag('protocolo', c.protocolo) + tag('dataProtocolo', data(c.dataProtocolo)) + '</cartorio>' : '') +
    '</titulo>';
  const xml = await soap('ConsultarTitulo', corpo, fetchImpl);
  return { ...lerConsulta(xml), xml };
}

// op = { operacao: REMOCAO|DESISTENCIA|CANCELAMENTO, statusAtual, autoriza:'S'|'N', justificativa, ...chave }
async function operacaoTitulo(op, fetchImpl) {
  const o = op || {};
  const permitidos = OPERACOES[o.operacao];
  if (!permitidos) throw new Error(`Operação inválida: ${o.operacao}.`);
  if (o.statusAtual && !permitidos.includes(String(o.statusAtual).toUpperCase())) {
    throw new Error(`${o.operacao} só cabe com status ${permitidos.join('/')} (atual: ${o.statusAtual}).`);
  }
  const token = await autenticar(fetchImpl);
  const corpo = tag('token', token) + '<titulo xmlns="">' +
    tag('autoriza', o.autoriza || 'S') + tag('operacao', o.operacao) + tag('justificativa', o.justificativa || '') +
    '<devedor>' + tag('documento', onlyDigits(o.devedorDocumento)) + '</devedor>' +
    '<divida>' + tag('numero', o.numero) + tag('nossoNumero', o.nossoNumero || o.numero) +
      tag('vencimento', data(o.vencimento)) + tag('especie', o.especie) + '</divida>' +
    (o.protocolo ? '<cartorio>' + tag('protocolo', o.protocolo) + tag('dataProtocolo', data(o.dataProtocolo)) + '</cartorio>' : '') +
    '</titulo>';
  const xml = await soap('OperacaoTitulo', corpo, fetchImpl);
  return { resposta: resposta(xml), xml };
}

module.exports = {
  configurado, ambiente, endpoint, autenticar, enviarTitulo, consultarTitulo, operacaoTitulo,
  // expostos para teste
  montarTitulo, envelope, lerConsulta, resposta, dinheiro, data, tipoDoc, esc,
  STATUS_INTEGRADOR, STATUS_CRA, OPERACOES, ESPECIES, DECLARACOES,
  _resetToken() { _token = null; _tokenEm = 0; },
};
