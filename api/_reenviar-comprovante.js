// api/_reenviar-comprovante.js — Reenvia ao credor o comprovante de um repasse JÁ FEITO.
//
// Por quê: quando o envio falha (Z-API fora, credor sem telefone na hora, ou — como em
// 17/08/2026 — o anexo sair quebrado), não havia como remediar. `/api/repassar` recusa
// operação já efetuada e o webhook é idempotente, ambos por segurança. Sem este caminho,
// a única saída seria mexer no status de um repasse concluído, o que é perigoso.
//
// NÃO MOVE DINHEIRO. Só relê o comprovante da transferência que já existe e reenvia.
// Nenhuma chamada a /transfers, nenhum status alterado.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const { guardarComprovante } = require('./_comprovante.js');
const { gerarComprovanteRepassePdf } = require('./_comprovante-pdf.js');
const { lerDescricaoRepasse, enviarComprovanteCredor, destinoWhatsapp } = require('./_repasse-msg.js');

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireUser(req, res);
  if (!user) return;

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const id = body.operacao_id;
  if (!id) return res.status(400).json({ error: 'operacao_id ausente' });

  try {
    const ops = await sbFetch(`fin_operacao?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    const op = ops[0];
    if (!op) return res.status(404).json({ error: 'operação não encontrada' });
    // Só reenvia o que de fato foi pago — senão isto viraria um jeito de avisar credor
    // sobre repasse que não aconteceu.
    if (op.repasse_status !== 'efetuado') {
      return res.status(400).json({ error: `repasse não está efetuado (${op.repasse_status}) — nada a reenviar` });
    }
    if (!op.credor_id) return res.status(400).json({ error: 'operação sem credor' });

    const cls = await sbFetch(`clientes?id=eq.${op.credor_id}&select=nome,telefone,metadata&limit=1`);
    const credor = cls[0] || {};

    let devNome = (op.metadata && op.metadata.repasse_devedor_nome) || '';
    if (!devNome && op.devedor_id) {
      const dvs = await sbFetch(`devedores?id=eq.${op.devedor_id}&select=nome&limit=1`).catch(() => []);
      devNome = (dvs[0] && dvs[0].nome) || '';
    }
    if (!devNome && op.metadata && op.metadata.lancamento_descricao) {
      devNome = lerDescricaoRepasse(op.metadata.lancamento_descricao).devedor;
    }

    const url = op.repasse_comprovante_url || '';
    const arq = await guardarComprovante(url, op.repasse_asaas_transfer_id);
    let pdf = (arq && arq.base64) || '';
    if (!pdf) {
      pdf = await gerarComprovanteRepassePdf({
        credorNome: credor.nome, devedor: devNome, parcela: op.parcela,
        valor: op.valor_capital,
        dataISO: String(op.repasse_efetuado_em || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        transferId: op.repasse_asaas_transfer_id,
        chavePix: (op.metadata && op.metadata.repasse_pix_key) || '', urlAsaas: url,
      });
    }

    const envio = await enviarComprovanteCredor({
      telefone: destinoWhatsapp(credor), parcela: op.parcela, devedor: devNome,
      base64: pdf, ext: 'pdf', comprovanteUrl: url,
    });

    if (arq && arq.storage_path) {
      await sbFetch(`fin_operacao?id=eq.${op.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ metadata: { ...(op.metadata || {}), comprovante_storage_path: arq.storage_path, comprovante_bytes: arq.bytes } }),
      }).catch(() => {});
    }

    return res.status(200).json({
      ok: true, operacao_id: op.id, credor: credor.nome, devedor: devNome, parcela: op.parcela,
      enviado: !!envio.enviado, via: envio.via || null, motivo: envio.motivo || null,
      origem_pdf: (arq && arq.base64) ? 'asaas' : (pdf ? 'cobrasq' : 'nenhum'),
      arquivo_guardado: (arq && arq.storage_path) || null,
    });
  } catch (e) {
    console.error('[reenviar-comprovante]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
