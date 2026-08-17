// api/_comprovante.js — Baixa o comprovante da transferência no Asaas e guarda o
// ARQUIVO no Storage, em vez de só a URL.
//
// Por quê: até 14/08/2026 o repasse guardava apenas `repasse_comprovante_url`, um
// link do Asaas. Comprovante de repasse é o documento que a COBRASQ precisa poder
// mostrar ao credor meses depois — se o Asaas expirar ou mudar a URL, ele some, e
// não há como reemitir o comprovante de um pagamento antigo.
//
// Best-effort de propósito: guardar o arquivo NÃO pode derrubar o repasse. O PIX
// já saiu quando isto roda; falhar aqui e estourar deixaria o dinheiro transferido
// e a operação marcada como erro — o pior dos dois mundos. Erro vira log e o
// chamador segue com a URL do Asaas.

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = 'documentos';

// aaaa/mm/repasse-<transferId>.pdf — agrupado por competência, nome estável e único.
function caminho(transferId, ext) {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const safe = String(transferId || 'sem-id').replace(/[^A-Za-z0-9_-]/g, '');
  return `repasses/${d.getFullYear()}/${mm}/repasse-${safe}.${ext || 'pdf'}`;
}

function extDe(contentType, url) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  const m = String(url || '').match(/\.([a-z0-9]{3,4})(?:\?|$)/i);
  return (m && m[1].toLowerCase()) || 'pdf';
}

// Retorna { storage_path, bytes, content_type } ou null. Nunca lança.
async function guardarComprovante(comprovanteUrl, transferId) {
  if (!comprovanteUrl || !SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(comprovanteUrl);
    if (!r.ok) { console.warn('[comprovante] download falhou:', r.status); return null; }
    const ct = r.headers.get('content-type') || 'application/pdf';
    const buf = Buffer.from(await r.arrayBuffer());
    // O `transactionReceiptUrl` do Asaas devolve uma PÁGINA (text/html), não um arquivo.
    // Em 17/08/2026 essa página foi anexada no WhatsApp com nome ".pdf" e o credor
    // recebeu algo que não abre. Só tratamos como documento o que É documento: PDF
    // começa com "%PDF". Fora disso, guarda como .html (registro) e NÃO devolve base64
    // para envio — quem manda o comprovante é _comprovante-pdf.js.
    const ehPdf = buf.slice(0, 4).toString('latin1') === '%PDF';
    // Comprovante do Asaas é um PDF pequeno. Acima de 10 MB é sinal de que veio
    // uma página de erro ou HTML, não o documento — não guarda.
    if (!buf.length || buf.length > 10 * 1024 * 1024) {
      console.warn('[comprovante] tamanho suspeito:', buf.length); return null;
    }
    const path = caminho(transferId, ehPdf ? 'pdf' : (ct.includes('html') ? 'html' : extDe(ct, comprovanteUrl)));
    const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': ct, 'x-upsert': 'true',
      },
      body: buf,
    });
    if (!up.ok) console.warn('[comprovante] upload falhou:', up.status, await up.text().catch(() => ''));
    // Devolve o conteúdo junto: quem chama manda esse mesmo PDF por WhatsApp logo em
    // seguida e não faz sentido baixar duas vezes do Asaas. `storage_path` vem null se
    // o arquivamento falhou — o envio ao credor não depende dele.
    return {
      storage_path: up.ok ? path : null,
      bytes: buf.length, content_type: ct, eh_pdf: ehPdf,
      base64: ehPdf ? buf.toString('base64') : null,
      ext: ehPdf ? 'pdf' : null,
    };
  } catch (e) {
    console.warn('[comprovante] erro:', e.message);
    return null;
  }
}

module.exports = { guardarComprovante };
