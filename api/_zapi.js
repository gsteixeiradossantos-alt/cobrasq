// api/_zapi.js — Envio de WhatsApp via Z-API no runtime Vercel. Mesmas env vars de
// api/cron-regua.js (ZAPI_TOKEN / ZAPI_INSTANCE_ID / ZAPI_CLIENT_TOKEN). Observação:
// a edge function enviar-whatsapp usa ZAPI_INSTANCE (sem _ID) no runtime do Supabase
// — são secrets de runtimes diferentes.

// Normaliza p/ o formato que a Z-API espera (DDI 55), igual ao waTel55 do front
// (ZApiAPI._tel em index.html). Sem isso, número local (DDD+9+8 díg.) vai sem DDI
// e a Z-API não entrega.
function normalizarTelefone(phone) {
  const bruto = String(phone || '').trim();
  // Grupo do WhatsApp ("120363417597227442-group"): a Z-API aceita o id do grupo no
  // mesmo campo `phone`. Só que ele tem 18 dígitos e sufixo — passar pelo tratamento
  // de número o deixaria irreconhecível. Vai como está.
  if (/-group$/i.test(bruto)) return bruto.replace(/[^0-9A-Za-z-]/g, '');

  // Um cadastro pode trazer VÁRIOS telefones no mesmo campo, separados por vírgula,
  // ponto-e-vírgula, barra ou quebra de linha — 52 devedores em 02/09/2026, ex.:
  // "42999642631, 42988521878, 42988568804, 43991694283". O `replace(/\D/g,'')` que
  // havia aqui colava tudo num número de 43 dígitos, que então casava com o teste de
  // id de grupo e ia para a Z-API como grupo inexistente: nada entregue, nenhum erro.
  // Separadores INTERNOS de um número só ("(46) 99999-1111") não entram nesta lista,
  // senão o DDD viraria um número à parte.
  const partes = bruto.split(/[,;|\n]+|\s\/\s/).map((s) => s.replace(/\D/g, '')).filter(Boolean);
  if (!partes.length) return '';

  // Id de grupo sem o sufixo: 15+ dígitos num valor único (uma lista de telefones
  // também passa de 15 dígitos depois de limpa, por isso o teste é depois do split).
  if (partes.length === 1 && partes[0].length >= 15) return partes[0];

  // Primeiro número plausível da lista: DDD + 8 ou 9 dígitos, com ou sem o DDI.
  let fone = partes.find((p) => p.length >= 10 && p.length <= 13) || '';
  // Nenhum plausível: não dá para escolher com segurança, e mandar recibo para o
  // número errado expõe dado de terceiro. Melhor não enviar — quem chama já trata
  // telefone vazio como "sem telefone" e registra o motivo na resposta.
  if (!fone) return '';

  if (fone.length <= 11 && !fone.startsWith('55')) fone = '55' + fone;
  return fone;
}

function credenciais() {
  const token = process.env.ZAPI_TOKEN || '';
  const instance = process.env.ZAPI_INSTANCE_ID || '';
  const clientTk = process.env.ZAPI_CLIENT_TOKEN || '';
  if (!token || !instance) throw new Error('Z-API não configurada');
  const headers = { 'Content-Type': 'application/json' };
  if (clientTk) headers['Client-Token'] = clientTk;
  const base = `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}`;
  return { base, headers };
}

async function postZapi(url, headers, corpo) {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(corpo) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Z-API HTTP ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function zapiSendText(phone, message) {
  const { base, headers } = credenciais();
  return postZapi(`${base}/send-text`, headers, { phone: normalizarTelefone(phone), message });
}

// Limite do payload aceito pela função serverless (Vercel corta o body acima de ~4,5 MB).
// Cortamos antes, com erro legível, em vez de deixar a Z-API/Vercel devolver 413 opaco.
const MAX_BASE64_BYTES = 3.5 * 1024 * 1024;

// Envia documento (padrão: PDF). `document` aceita:
//   - URL https pública        -> a Z-API baixa o arquivo
//   - data URI base64          -> "data:application/pdf;base64,JVBERi0..."
//   - base64 puro              -> convertido em data URI com o mime da extensão
// Preferir base64 quando o arquivo for confidencial: URL pública fica acessível a
// quem tiver o link. Endpoint: POST /send-document/{extensao}.
async function zapiSendDocument(phone, { document, fileName, caption, extension } = {}) {
  if (!document) throw new Error('Documento ausente (informe URL https ou base64)');
  if (!fileName) throw new Error('fileName é obrigatório — é o nome que o destinatário vê');

  const ext = String(extension || fileName.split('.').pop() || 'pdf').toLowerCase();
  if (!/^[a-z0-9]{2,5}$/.test(ext)) throw new Error(`Extensão inválida: ${ext}`);

  const bruto = String(document);
  const ehUrl = /^https:\/\//i.test(bruto);
  let payloadDoc = bruto;

  if (!ehUrl) {
    if (/^http:\/\//i.test(bruto)) throw new Error('URL de documento precisa ser https');
    const soBase64 = bruto.replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(soBase64)) throw new Error('Documento não é URL https nem base64 válido');
    const bytes = Math.floor(soBase64.replace(/\s/g, '').length * 3 / 4);
    if (bytes > MAX_BASE64_BYTES) {
      throw new Error(`Documento tem ~${(bytes / 1024 / 1024).toFixed(1)} MB; o limite por envio é 3.5 MB. Use URL https.`);
    }
    const mime = ext === 'pdf' ? 'application/pdf' : `application/${ext}`;
    payloadDoc = bruto.startsWith('data:') ? bruto : `data:${mime};base64,${soBase64.replace(/\s/g, '')}`;
  }

  const { base, headers } = credenciais();
  return postZapi(`${base}/send-document/${ext}`, headers, {
    phone: normalizarTelefone(phone),
    document: payloadDoc,
    fileName,
    caption: caption || '',
  });
}

// Atalho para o caso mais comum: mandar um PDF já em base64. Existe porque
// _processar-recebimento.js e _reenviar-recibo.js sempre chamaram um
// `zapiSendDocumentPdf(tel, base64, nome)` que NUNCA foi exportado daqui — o #488
// escreveu os chamadores, o #515 criou o sender com outro nome e outra assinatura, e
// ninguém casou os dois. Resultado: `undefined(...)` estourava TypeError, o catch do
// chamador engolia, e o recibo do devedor nunca era anexado (três falhas registradas
// em `recibo_pdf_falhou` entre 18 e 20/08/2026 — Aline, Cristiane e Marinalva).
// Devolve boolean: só é verdadeiro quando a Z-API confirma com um messageId.
async function zapiSendDocumentPdf(phone, base64, fileName, caption) {
  const r = await zapiSendDocument(phone, {
    document: base64,
    fileName: fileName || 'Documento.pdf',
    extension: 'pdf',
    caption: caption || '',
  });
  return !!(r && (r.messageId || r.id || r.zaapId));
}

module.exports = { zapiSendText, zapiSendDocument, zapiSendDocumentPdf, normalizarTelefone };
