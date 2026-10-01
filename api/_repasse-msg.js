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
const { sbFetch } = require('./_sb.js');
const { FUSO_BR, isoBR, addDiasBR } = require('./_data.js');

// ---------------------------------------------------------------------------------
// Horário comercial do comprovante.
//
// Em 11/09/2026, à 01h26, o Gustavo clicou em Repassar e a mensagem com o comprovante
// ia para o grupo do credor naquela hora. O PIX pode sair de madrugada; a mensagem, não:
// credor recebendo WhatsApp da COBRASQ à 1h da manhã é o tipo de coisa que queima a
// relação. Fora da janela o comprovante NÃO é enviado na hora — entra na fila
// `crm_mensagens_agendadas` (a mesma da régua e dos lembretes) com `agendada_para` no
// próximo horário útil, e o worker `cron-mensagens-agendadas` (pg_cron, 1/min) manda.
//
// Janela definida pelo Gustavo em 11/09/2026: segunda a sexta, 08h–20h (Curitiba).
// ---------------------------------------------------------------------------------
const JANELA_COMPROVANTE = { diasUteis: [1, 2, 3, 4, 5], horaInicio: 8, horaFim: 20 };

const _fmtPartes = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO_BR, weekday: 'short', hour: 'numeric', hour12: false,
});
const _DIA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Dia da semana (0=dom) e hora cheia em Curitiba para um instante.
function partesBR(d) {
  const partes = _fmtPartes.formatToParts(d);
  const dia = _DIA[(partes.find(x => x.type === 'weekday') || {}).value] ?? 0;
  // Alguns runtimes formatam meia-noite como "24" com hour12:false.
  const hora = Number((partes.find(x => x.type === 'hour') || {}).value) % 24;
  return { dia, hora };
}

// Instante em que a mensagem pode sair. `null` = agora está dentro da janela, manda já.
// Fora dela devolve o próximo dia útil às 08h00 de Curitiba. O Brasil não tem horário
// de verão desde 2019, então "-03:00" fixo é exato (mesma premissa de addDiasBR).
function proximoHorarioComercial(agora, janela) {
  const J = janela || JANELA_COMPROVANTE;
  const d = agora instanceof Date ? agora : new Date(agora == null ? Date.now() : agora);
  const { dia, hora } = partesBR(d);
  const diaUtil = J.diasUteis.includes(dia);
  if (diaUtil && hora >= J.horaInicio && hora < J.horaFim) return null;
  const hh = String(J.horaInicio).padStart(2, '0');
  // Hoje ainda não abriu (madrugada de dia útil) → hoje às 08h. Senão, anda dia a dia.
  if (diaUtil && hora < J.horaInicio) return new Date(`${isoBR(d)}T${hh}:00:00-03:00`);
  for (let n = 1; n <= 7; n++) {
    const data = addDiasBR(n, d);
    const diaN = new Date(`${data}T12:00:00-03:00`);
    if (J.diasUteis.includes(partesBR(diaN).dia)) return new Date(`${data}T${hh}:00:00-03:00`);
  }
  return null;
}

// Guarda o PDF que IRIA no WhatsApp no bucket `documentos` (o worker gera signed URL na
// hora do envio). Caminho separado do arquivamento do comprovante (_comprovante.js):
// aquele é o registro permanente do Asaas; este é o anexo exato da mensagem, que pode
// ser a página impressa do Asaas ou o PDF da COBRASQ.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET_FILA = 'documentos';
async function guardarAnexoFila(base64, nome) {
  const safe = String(nome || 'comprovante').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
  const path = `repasses/fila-whatsapp/${Date.now()}-${safe}.pdf`;
  const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET_FILA}/${path}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: Buffer.from(base64, 'base64'),
  });
  if (!up.ok) throw new Error(`upload do anexo falhou: ${up.status} ${await up.text().catch(() => '')}`);
  return path;
}

// Enfileira o comprovante para o próximo horário comercial. Uma linha por PIX, igual ao
// envio direto. `origem` começa com "manual_" DE PROPÓSITO: o worker só deixa passar por
// cima de "conversa pendente" o que tem origem manual_* ou aviso interno (R-23); o
// comprovante é disparado por um humano clicando em Repassar e não pode ficar preso
// atrás de uma pergunta do credor sem resposta.
// Espaçamento entre comprovantes agendados para a mesma janela. Em 11/09/2026 as 08h
// abriram com 27 comprovantes em 25 segundos — rajada que o WhatsApp lê como spam e
// pode derrubar o número da COBRASQ. Cada comprovante novo entra ESPACO_MS depois do
// último já agendado a partir da mesma hora (26 comprovantes → ~13 min a partir das 08h).
const ESPACO_MS = 30 * 1000;
async function horarioEspacado(quando) {
  try {
    const iso = quando.toISOString();
    const ult = await sbFetch(
      `crm_mensagens_agendadas?origem=eq.manual_repasse_comprovante&status=eq.pendente` +
      `&agendada_para=gte.${encodeURIComponent(iso)}&select=agendada_para&order=agendada_para.desc&limit=1`
    );
    const ultimo = Array.isArray(ult) && ult[0] ? Date.parse(ult[0].agendada_para) : NaN;
    if (!isNaN(ultimo) && ultimo >= quando.getTime()) return new Date(ultimo + ESPACO_MS);
  } catch (e) {
    console.warn('[repasse-msg] espaçamento da fila falhou, usa a hora cheia:', e.message);
  }
  return quando;
}

async function enfileirarComprovanteCredor({ tel, msg, base64, nomeArquivo, comprovanteUrl, quando }) {
  const row = {
    telefone: tel,
    agendada_para: (await horarioEspacado(quando)).toISOString(),
    status: 'pendente',
    origem: 'manual_repasse_comprovante',
  };
  if (base64) {
    row.tipo = 'documento';
    row.media_path = await guardarAnexoFila(base64, nomeArquivo);
    // COM ".pdf": o worker tira a extensão do nome (`/send-document/<ext>` e fileName sem
    // ela). Sem o ".pdf", ele tomou "2 - José Lentz" inteiro como extensão e o credor
    // recebeu "2 - José Lentz.2joslentz" — 26 comprovantes assim às 08h de 11/09/2026.
    // (No envio direto, acima, é o contrário: nome SEM extensão, a Z-API põe a dela.)
    row.media_nome = nomeArquivo + '.pdf';
    row.media_mime = 'application/pdf';
    row.legenda = msg;
    row.mensagem = msg;
  } else {
    row.tipo = 'texto';
    row.mensagem = comprovanteUrl ? `${msg}\n\nComprovante: ${comprovanteUrl}` : msg;
  }
  const ins = await sbFetch('crm_mensagens_agendadas', { method: 'POST', body: JSON.stringify(row) });
  const id = Array.isArray(ins) ? (ins[0] && ins[0].id) : (ins && ins.id);
  return { enviado: false, agendado: true, agendada_para: row.agendada_para, fila_id: id || null, via: row.tipo };
}

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
  let corpo = s.replace(/\s*\d+\s*\/\s*\d+\s*$/, '').trim();

  // Anotação NO COMEÇO, marcada com "#": "# Executar - Valdair Tavares dos Santos 1/5".
  // Sem descartar, o devedor virava "# Executar" e o credor receberia um PIX descrito
  // assim, com a mensagem dizendo "pagamento realizado por # Executar".
  const anotacao = corpo.match(/^#[^-]*-\s*(\S.*)$/);
  if (anotacao) corpo = anotacao[1].trim();

  // Despesa criada pela ponte de recebimento: a descrição traz o nome do CREDOR, não do
  // devedor ("Repasse ao credor — Cecato Clinica Veterinaria Ltda 2/3"). Não há devedor
  // aqui; devolver o credor faria a mensagem dizer ao credor que ele pagou a si mesmo.
  if (/^repasse ao credor\s*[—-]/i.test(corpo)) {
    return { parcela: Number(m[1]), total: Number(m[2]), devedor: '' };
  }

  const devedor = corpo.split(/\s+-\s+/)[0].trim();
  return { parcela: Number(m[1]), total: Number(m[2]), devedor };
}

// Descrição que o credor lê no extrato do PIX: "<nº parcela> - <devedor>".
// Limite do Asaas é 500 caracteres.
// "3, 8 e 9" — números das parcelas pagas num PIX só (lote), em ordem.
function listarParcelas(ps) {
  const ns = [...new Set((ps || []).map(Number).filter(n => n > 0))].sort((a, b) => a - b);
  if (ns.length <= 1) return ns.length ? String(ns[0]) : '';
  return ns.slice(0, -1).join(', ') + ' e ' + ns[ns.length - 1];
}
// Lote = PIX único para várias parcelas (pedido do Gustavo, 30/09/2026: três parcelas
// da mesma devedora ao mesmo credor não precisam de três PIX). `parcelas` com 2+
// números prevalece sobre `parcela`.
function ehLote(d) { return !!(d && Array.isArray(d.parcelas) && listarParcelas(d.parcelas).includes(' e ')); }

// Num lote, extrato do PIX, nome do arquivo e mensagem citam TODAS as parcelas ("3, 4 e 5
// - Elison …"). Decisão do Gustavo em 30/09/2026, depois de ver o comprovante do Elison
// sair como "3 - Elison" e "parcela 3 de 5": "Todas em tudo". Substitui o pedido anterior
// do mesmo dia de citar só a primeira.
function descricaoPix(d) {
  if (ehLote(d)) {
    const p = listarParcelas(d.parcelas);
    return ((d.devedor ? `${p} - ${d.devedor}` : `Repasse Cobrasq - parcelas ${p}`)).slice(0, 500);
  }
  const nome = (d && d.devedor) || '';
  // Sem devedor, "7 - " sozinho não diz nada a quem lê o extrato.
  const txt = nome
    ? (d && d.parcela ? `${d.parcela} - ${nome}` : nome)
    : (d && d.parcela ? `Repasse Cobrasq - parcela ${d.parcela}` : 'Repasse Cobrasq');
  return txt.slice(0, 500);
}

// Mensagem que acompanha o comprovante. Uma por PIX: parcela paga sozinha tem o seu;
// parcelas pagas num PIX só (lote) dividem uma mensagem, que nomeia todas.
// "039.693.609-19" -> "CPF n. 039.693.609-19" · "22.730.701/0001-19" -> "CNPJ n. …".
// Decide pelo NÚMERO DE DÍGITOS, não pelo que estiver escrito: no Astrea aparece CPF
// rotulado como CNPJ e vice-versa. Formata mesmo se vier sem pontuação.
function docPorExtenso(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11) {
    return `CPF n. ${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14) {
    return `CNPJ n. ${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return '';
}

// Junta a pessoa física com a empresa dela quando as duas são partes do mesmo caso
// (MEI, ou CNPJ cujo nome contém o nome da PF). Sem isso o credor lia "Jeferson Luciano
// Pereira (CPF …) e 50.677.114 Jeferson Luciano Pereira (MEI) (CNPJ …)" (30/09/2026).
// A PJ vira rótulo "(PF e MEI)" ou "(PF e PJ)" e os dois documentos ficam. Mesma regra
// de _extratoAgruparPartes no index.html (extrato de repasse).
function agruparPartes(partes) {
  const dig = d => String(d || '').replace(/\D/g, '');
  const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\(?\bmei\b\)?/g, ' ').replace(/[\d./\-]{2,}/g, ' ')
    .replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const lista = (partes || []).filter(p => p && p.nome)
    .map(p => ({ nome: p.nome, doc: p.doc || '', docs: p.doc ? [p.doc] : [], rotulo: '' }));
  const ehPJ = p => dig(p.doc).length === 14 || /\bmei\b/i.test(p.nome);
  const usados = new Set();
  lista.forEach((pf, i) => {
    if (usados.has(i) || ehPJ(pf)) return;
    const n = norm(pf.nome);
    if (n.split(' ').length < 2) return;
    lista.forEach((pj, j) => {
      if (j === i || usados.has(j) || !ehPJ(pj) || pf.rotulo) return;
      if (!(' ' + norm(pj.nome) + ' ').includes(' ' + n + ' ')) return;
      pf.rotulo = /\bmei\b/i.test(pj.nome) ? 'PF e MEI' : 'PF e PJ';
      if (pj.doc) pf.docs.push(pj.doc);
      usados.add(j);
    });
  });
  return lista.filter((_, i) => !usados.has(i));
}

// "A", "A e B", "A, B e C" — cada um com o documento entre parênteses quando conhecido.
function listarPagadores(partes) {
  const nomes = agruparPartes(partes).map(p => {
    const nome = p.rotulo ? `${p.nome} (${p.rotulo})` : p.nome;
    const d = p.docs.map(docPorExtenso).filter(Boolean).join(' e ');
    return d ? `${nome} (${d})` : nome;
  });
  if (nomes.length <= 1) return nomes[0] || '';
  return nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1];
}

// Pedido ao credor que acompanha o PRIMEIRO repasse de cada dívida: baixar as
// restrições que ele mesmo lançou contra o devedor e, havendo protesto, mandar a carta
// de anuência. Texto do Gustavo, 11/09/2026. Só na 1ª parcela (decisão dele no mesmo
// dia): repetir a cada parcela viraria ruído para o credor. Pagamento à vista/único
// (sem número de parcela) conta como primeiro — é o único que haverá.
//
// Sem "(s)/(es)": o parágrafo é montado com o NOME de cada parte ("no nome de Elaine
// Baranoski ou de Sidimar Pruch"), o que resolve número e gênero sem adivinhar nenhum
// dos dois — o cadastro não tem gênero e a mensagem vai ao cliente (Gustavo, 12/09/2026).
// Sem nome conhecido, cai em "no nome de quem pagou".
const RESTRICOES_INICIO = 'Se houver restrição no nome de ';
const RESTRICOES_FIM =
  ' em SPC, SERASA, Boa Vista/CDL e afins, solicitamos a retirada com urgência. '
  + 'Havendo protesto, pedimos o envio da carta de anuência em formato eletrônico.';
function paragrafoRestricoes(nomes) {
  const ns = (nomes || []).filter(Boolean);
  const quem = ns.length ? ns.join(' ou de ') : 'quem pagou';
  return RESTRICOES_INICIO + quem + RESTRICOES_FIM;
}
// Mantido para quem só quer saber se a frase está lá (testes/telas): o trecho fixo.
const PARAGRAFO_RESTRICOES = RESTRICOES_FIM.trim();

function pedeBaixaRestricoes(parcela, parcelas) {
  if (ehLote({ parcelas })) return parcelas.map(Number).includes(1);
  return !parcela || Number(parcela) === 1;
}

function msgComprovanteCredor({ parcela, parcelas, total, devedor, doc, partes }) {
  // Documento entre parênteses quando conhecido — pedido do Gustavo em 17/08/2026, para o
  // credor identificar o devedor sem depender do nome. Devedor sem cadastro não tem doc:
  // a frase sai sem, em vez de com um campo vazio.
  //
  // `partes` (todas as partes da cobrança, principal primeiro) tem precedência: cobrança
  // com dois devedores nomeia os dois — "Elaine Baranoski (CPF n. …) e Sidimar Pruch
  // (CPF n. …)". Até 11/09/2026 saía só o principal, e o credor estranhou a ausência do
  // segundo. Sem partes, cai no par devedor/doc de antes.
  const docTxt = docPorExtenso(doc);
  const quem = listarPagadores(partes) || (docTxt ? `${devedor} (${docTxt})` : devedor);
  // Nomes limpos (sem documento) para o parágrafo de restrições.
  const nomes = (partes || []).filter(p => p && p.nome).map(p => p.nome);
  if (!nomes.length && devedor) nomes.push(devedor);
  // Texto do Gustavo (12/09/2026), sem "n." nem "(s)":
  //  - 1 de 1 (ou sem número) → "do pagamento à vista realizado por X";
  //  - N de M               → "referente à parcela N de M do acordo firmado por X";
  //  - só N (sem total)      → "referente à parcela N do acordo firmado por X".
  // Sem devedor identificado (descrição da ponte de recebimento), a frase omite o
  // "realizado/firmado por" em vez de inventar um nome.
  const p = Number(parcela) || 0, t = Number(total) || 0;
  const avista = !p || (p === 1 && t === 1);
  const qual = avista ? '' : (t ? `parcela ${p} de ${t}` : `parcela ${p}`);
  let ref;
  if (ehLote({ parcelas })) {
    // Lote (3, 8 e 9 de 9): "referente às parcelas 3, 8 e 9 de 9 do acordo firmado por X"
    // — todas (ver descricaoPix).
    const quais = `parcelas ${listarParcelas(parcelas)}${t ? ` de ${t}` : ''}`;
    ref = quem ? `referente às *${quais}* do acordo firmado por *${quem}.*` : `referente às *${quais}*.`;
  } else if (avista) ref = quem ? `do pagamento à vista realizado por *${quem}.*` : `do pagamento à vista.`;
  else ref = quem ? `referente à *${qual}* do acordo firmado por *${quem}.*` : `referente à *${qual}*.`;
  return `*Setor financeiro | COBRASQ:*\n`
    + `Encaminhamos, em anexo, o comprovante de repasse ${ref}\n\n`
    + (pedeBaixaRestricoes(parcela, parcelas) ? `${paragrafoRestricoes(nomes)}\n\n` : '')
    + `Qualquer dúvida é só nos comunicar!\n\n`
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
async function enviarComprovanteCredor({ telefone, parcela, parcelas, total, devedor, doc, partes, base64, ext, comprovanteUrl, agora }) {
  // Não limpar aqui: o destino pode ser um GRUPO do WhatsApp ("1203634…-group"), que a
  // Z-API trata no mesmo campo. Quem normaliza é o _zapi.js, que sabe distinguir os dois.
  const tel = String(telefone || '').trim();
  const digitos = tel.replace(/\D/g, '');
  if (digitos.length < 10) return { enviado: false, motivo: 'credor sem telefone válido' };

  const msg = msgComprovanteCredor({ parcela, parcelas, total, devedor, doc, partes });
  // Nome do arquivo = a mesma identificação do extrato do PIX: "1 - Elen Demgenski".
  // O credor arquiva vários comprovantes; assim ele acha pelo nome sem abrir um a um.
  //
  // SEM extensão: a Z-API acrescenta a dela a partir do endpoint /send-document/{ext}.
  // Mandando "....pdf" o credor recebia "Comprovante ... .pdf.pdf" (visto em 17/08/2026).
  // Também tira o que atrapalha nome de arquivo em Windows/Android.
  const nomeArquivo = (descricaoPix({ parcela, parcelas, devedor }) || 'Comprovante de repasse')
    .replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\.(pdf|html?)$/i, '').slice(0, 90);

  // Última barreira: só anexa se for PDF de verdade. Um "%PDF" ausente aqui significa
  // que alguém passou HTML adiante — foi o que chegou à Vetclin em 17/08/2026.
  const pdfValido = !!base64 && Buffer.from(String(base64).slice(0, 16), 'base64').slice(0, 4).toString('latin1') === '%PDF';
  if (base64 && !pdfValido) console.warn('[repasse-msg] anexo descartado: não é PDF');

  // Fora do horário comercial: fila, não Z-API. Se a fila falhar (storage, PostgREST),
  // NÃO cai para o envio direto — mandar de madrugada é justamente o que se quer evitar.
  const quando = proximoHorarioComercial(agora);
  if (quando) {
    try {
      const r = await enfileirarComprovanteCredor({ tel, msg, base64: pdfValido ? base64 : '', nomeArquivo, comprovanteUrl, quando });
      console.log('[repasse-msg] fora do horário comercial: comprovante agendado para', r.agendada_para, 'fila', r.fila_id);
      return r;
    } catch (e) {
      console.warn('[repasse-msg] agendamento falhou:', e.message);
      return { enviado: false, agendado: false, motivo: 'fora do horário comercial e a fila falhou: ' + e.message };
    }
  }

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

module.exports = { lerDescricaoRepasse, descricaoPix, listarParcelas, msgComprovanteCredor, listarPagadores, agruparPartes, pedeBaixaRestricoes, PARAGRAFO_RESTRICOES, paragrafoRestricoes, enviarComprovanteCredor, destinoWhatsapp, docPorExtenso, proximoHorarioComercial, JANELA_COMPROVANTE, ESPACO_MS };
