// api/_repasse-msg.js — Como o repasse se apresenta ao credor: a descrição que vai no
// PIX do Asaas e a mensagem de WhatsApp que leva o comprovante em anexo.
//
// Fica separado porque os DOIS caminhos que concluem um repasse precisam do mesmo
// texto: /api/repassar (quando o Asaas devolve DONE na hora) e o webhook
// TRANSFER_DONE (quando conclui depois). Texto duplicado nos dois arquivos já seria
// divergente na primeira alteração.
//
// A parcela e o nome do devedor vêm da descrição do lançamento, não de colunas: os
// repasses importados do Controlle não têm numero_parcela/total_parcelas preenchidos
// (são 100% nulos em 16/08/2026) e não têm devedor cadastrado. A descrição é o único
// lugar onde essa informação existe.

const { zapiSendText, zapiSendDocument } = require('./_zapi.js');

// "Fernanda da Silva - Avisar e pagar - conferido 1/9" -> { parcela:1, total:9, devedor:'Fernanda da Silva' }
//
// O nome é o que vem ANTES do primeiro " - ": o resto são anotações de trabalho do
// escritório ("pagar", "conferido", "Avisar", "depende do Sisbajud", "SISBAJUD"), que
// não devem aparecer nem no extrato do credor nem na mensagem.
function lerDescricaoRepasse(descricao) {
  const s = String(descricao || '').trim();
  // Só desmonta o texto quando ele termina em "N/M" — a assinatura da descrição de
  // lançamento vinda do Controlle. Fora disso, o texto já é o que deve sair no extrato:
  // é o caso da tela "Repasses a clientes", que manda "<nº editado> - <devedor>" pronto.
  // Cortar sempre no primeiro " - " fazia o PIX sair descrito só com o número, e
  // estragaria nome de devedor que legitimamente contenha " - ".
  const m = s.match(/(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) {
    const pronto = s.match(/^(\d+)\s*-\s*(\S.*)$/);
    return pronto
      ? { parcela: Number(pronto[1]), total: null, devedor: pronto[2].trim() }
      : { parcela: null, total: null, devedor: s };
  }
  // Descrição de lançamento: o nome é o que vem ANTES do primeiro " - "; o resto são
  // anotações de trabalho ("pagar", "conferido", "Avisar", "depende do Sisbajud"), que
  // não devem aparecer nem no extrato do credor nem na mensagem.
  const devedor = s.replace(/\s*\d+\s*\/\s*\d+\s*$/, '').split(/\s+-\s+/)[0].trim();
  return { parcela: Number(m[1]), total: Number(m[2]), devedor };
}

// Descrição que o credor lê no extrato do PIX: "<nº parcela> - <devedor>".
// Limite do Asaas é 500 caracteres.
function descricaoPix(d) {
  const nome = (d && d.devedor) || '';
  const txt = d && d.parcela ? `${d.parcela} - ${nome}` : nome;
  return txt.slice(0, 500);
}

// Mensagem que acompanha o comprovante. Uma por PIX — cada parcela é uma transferência
// e um comprovante distintos, então agrupar credor confundiria a conferência.
function msgComprovanteCredor({ parcela, devedor }) {
  const ref = parcela
    ? `do pagamento referente a *parcela n. ${parcela}* do pagamento realizado por *${devedor}.*`
    : `do pagamento realizado por *${devedor}.*`;
  return `*Setor financeiro | COBRASQ:*\n`
    + `Encaminhamos, em anexo, o comprovante de repasse ${ref}\n\n`
    + `Ficamos à disposição para quaisquer esclarecimentos.\n\n`
    + `Atenciosamente,\n`
    + `*COBRASQ Recuperadora de Crédito e Cobrança*`;
}

// Para onde vai o comprovante deste credor. `metadata.whatsapp_repasse` tem
// precedência sobre `telefone` porque alguns credores são atendidos num GRUPO do
// WhatsApp (Arte Estofados, Odontomundi, S.O.S Animal — confirmado pelo Gustavo em
// 16/08/2026), e o id do grupo não é um telefone: guardá-lo na coluna `telefone`
// quebraria qualquer outro fluxo que espere um número ali.
function destinoWhatsapp(credor) {
  const meta = (credor && credor.metadata) || {};
  return meta.whatsapp_repasse || (credor && credor.telefone) || '';
}

// Envia o comprovante ao credor. Preferimos o PDF em anexo (base64, não URL: o link do
// Asaas é público e o comprovante tem dados bancários das duas partes). Sem o arquivo,
// cai para texto com o link — melhor um aviso com link do que credor sem comprovante.
//
// Best-effort por design: o PIX já saiu quando isto roda. Falha aqui vira log, nunca
// erro do repasse.
async function enviarComprovanteCredor({ telefone, parcela, devedor, base64, ext, comprovanteUrl }) {
  // Não limpar aqui: o destino pode ser um GRUPO do WhatsApp ("1203634…-group"), que a
  // Z-API trata no mesmo campo. Quem normaliza é o _zapi.js, que sabe distinguir os dois.
  const tel = String(telefone || '').trim();
  const digitos = tel.replace(/\D/g, '');
  if (digitos.length < 10) return { enviado: false, motivo: 'credor sem telefone válido' };

  const msg = msgComprovanteCredor({ parcela, devedor });
  // Nome do arquivo = a mesma identificação do extrato do PIX: "1 - Elen Demgenski".
  // O credor arquiva vários comprovantes; assim ele acha pelo nome sem abrir um a um.
  //
  // SEM extensão: a Z-API acrescenta a dela a partir do endpoint /send-document/{ext}.
  // Mandando "....pdf" o credor recebia "Comprovante ... .pdf.pdf" (visto em 17/08/2026).
  // Também tira o que atrapalha nome de arquivo em Windows/Android.
  const nomeArquivo = (descricaoPix({ parcela, devedor }) || 'Comprovante de repasse')
    .replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\.(pdf|html?)$/i, '').slice(0, 90);

  // Última barreira: só anexa se for PDF de verdade. Um "%PDF" ausente aqui significa
  // que alguém passou HTML adiante — foi o que chegou à Vetclin em 17/08/2026.
  const pdfValido = !!base64 && Buffer.from(String(base64).slice(0, 16), 'base64').slice(0, 4).toString('latin1') === '%PDF';
  if (base64 && !pdfValido) console.warn('[repasse-msg] anexo descartado: não é PDF');
  if (pdfValido) {
    try {
      const r = await zapiSendDocument(tel, { document: base64, fileName: nomeArquivo, caption: msg, extension: ext || 'pdf' });
      return { enviado: !!(r && r.messageId), via: 'documento', resposta: r };
    } catch (e) {
      console.warn('[repasse-msg] anexo falhou, tentando texto:', e.message);
    }
  }

  try {
    const texto = comprovanteUrl ? `${msg}\n\nComprovante: ${comprovanteUrl}` : msg;
    const r = await zapiSendText(tel, texto);
    return { enviado: !!(r && r.messageId), via: 'texto', resposta: r };
  } catch (e) {
    console.warn('[repasse-msg] envio falhou:', e.message);
    return { enviado: false, motivo: e.message };
  }
}

module.exports = { lerDescricaoRepasse, descricaoPix, msgComprovanteCredor, enviarComprovanteCredor, destinoWhatsapp };
