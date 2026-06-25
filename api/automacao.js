// api/automacao.js — Roteador ÚNICO dos endpoints de automação financeira.
//
// Motivo: o plano Hobby do Vercel limita a 12 Serverless Functions por deploy. Os 7
// endpoints da automação (emitir-acordo, processar-recebimento, repassar,
// repasse-concluido, emitir-nf, importar-asaas, diagnostico-financeiro) estouravam o
// limite. Cada um agora vive num módulo "_"-prefixado (que o Vercel NÃO conta como
// função) e é despachado aqui por ?action=. O vercel.json reescreve os caminhos
// públicos antigos (/api/emitir-acordo, etc.) para /api/automacao?action=... — então
// os callers (webhooks Supabase e a UI) continuam idênticos, sem mudança.

const handlers = {
  'emitir-acordo': require('./_emitir-acordo.js'),
  'processar-recebimento': require('./_processar-recebimento.js'),
  'repassar': require('./_repassar.js'),
  'repasse-concluido': require('./_repasse-concluido.js'),
  'emitir-nf': require('./_emitir-nf.js'),
  'importar-asaas': require('./_importar-asaas.js'),
  'diagnostico-financeiro': require('./_diagnostico-financeiro.js'),
  'eproc-peticionamento': require('./_eproc-peticionamento.js'),
  // require preguiçoso: o Chromium/puppeteer (pesado) só carrega quando a ação de
  // PDF é chamada — as demais ações não pagam esse custo no cold start.
  'gerar-pdf': (req, res) => require('./_gerar-pdf.js')(req, res),
};

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  const h = handlers[action];
  if (typeof h !== 'function') {
    res.status(404).json({ error: 'ação desconhecida: ' + action });
    return;
  }
  return h(req, res);
};
