// api/_repasse-ficha.js — Leva o repasse pago por PIX para a ficha do caso: aba
// "Repasses ao cliente" da cobrança, com o comprovante anexado.
//
// Por quê: até 17/08/2026 eram dois mundos separados. O PIX automático gravava em
// `fin_operacao` + Storage; a aba da cobrança lia `repasses_cliente`, que só enchia pelo
// botão "Enviar comprovantes (IA)", na mão. Resultado: o repasse saía, o credor recebia,
// e o caso continuava mostrando "Nenhum repasse registrado" — e o capital não abatia.
//
// Faz exatamente o que o fluxo manual faz (ver _repIAConfirmar no index.html): sobe o
// arquivo em cobrancas/<id>/repasse/, cria a linha em `documentos` com categoria
// 'repasse', insere em `repasses_cliente` e recomputa o saldo do capital.
//
// Best-effort: o PIX já saiu quando isto roda. Falhar aqui não pode derrubar o repasse
// nem o envio do comprovante — vira log.

const { sbFetch } = require('./_sb.js');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = 'documentos';

function fmtNum(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Sobe uma SEGUNDA cópia sob cobrancas/<id>/ em vez de apontar para a que está em
// repasses/aaaa/mm/. É de propósito: as policies de leitura do bucket são por prefixo, e
// é esse prefixo que o gestor consegue abrir pela ficha. A cópia de repasses/ continua
// sendo o arquivo do Financeiro.
async function subirNaPastaDaCobranca(cobrancaId, transferId, comprovante) {
  const ext = comprovante.ext || 'pdf';
  const path = `cobrancas/${cobrancaId}/repasse/${Date.now()}_repasse-${String(transferId || 'sem-id').replace(/[^A-Za-z0-9_-]/g, '')}.${ext}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': comprovante.content_type || 'application/pdf', 'x-upsert': 'true',
    },
    body: Buffer.from(comprovante.base64, 'base64'),
  });
  if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text().catch(() => '')}`);
  return path;
}

// Espelha recomputarSaldoCapital() do index.html: capital integralmente repassado vira
// status "Quitado ao cliente". Sem isto, o abatimento apareceria na aba mas o caso
// continuaria em cobrança.
async function recomputarCapital(cobrancaId) {
  const cobs = await sbFetch(`cobrancas?id=eq.${cobrancaId}&select=valor_capital,status,divida&limit=1`);
  const cob = cobs[0];
  if (!cob) return null;
  const cap = cob.valor_capital != null ? Number(cob.valor_capital)
    : (cob.divida && cob.divida.valorCapital != null ? Number(cob.divida.valorCapital) : null);
  if (cap == null || !(cap > 0)) return cob.status;
  const rps = await sbFetch(`repasses_cliente?cobranca_id=eq.${cobrancaId}&select=valor`);
  const enviado = (rps || []).reduce((s, r) => s + (Number(r.valor) || 0), 0);
  if (cap - enviado > 0.005 || cob.status === 'Quitado ao cliente') return cob.status;
  await sbFetch(`cobrancas?id=eq.${cobrancaId}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      status: 'Quitado ao cliente',
      divida: { ...(cob.divida || {}), valorCapital: cap },
      updated_at: new Date().toISOString(),
    }),
  });
  await sbFetch('devedor_eventos', {
    method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({
      cobranca_id: cobrancaId, devedor_id: cobrancaId, tipo: 'repasse',
      payload: { acao_completa: 'Capital integralmente repassado ao cliente — status alterado para "Quitado ao cliente".', origem: 'repasse-pix' },
    }),
  }).catch(() => {});
  return 'Quitado ao cliente';
}

// Qual cobrança recebe este repasse. NUNCA usar op.devedor_id como se fosse o id da
// cobrança: em 17/08/2026 são 585 devedores para 538 cobranças e só 504 compartilham o
// id — o palpite penduraria o repasse na ficha de outro caso. Só vale o que veio do
// lançamento, direto ou pela operação.
async function resolverCobrancaId(op) {
  const daOperacao = op && op.metadata && op.metadata.cobranca_id;
  if (daOperacao) return daOperacao;
  if (op && op.lancamento_despesa_id) {
    const l = await sbFetch(`fin_lancamento?id=eq.${op.lancamento_despesa_id}&select=cobranca_id&limit=1`).catch(() => []);
    return (l[0] && l[0].cobranca_id) || null;
  }
  return null;
}

// Retorna { repasse_id, documento_id, status_caso } ou null. Nunca lança.
async function registrarRepasseNaFicha({ cobrancaId, credor, valor, transferId, dataPix, comprovante }) {
  if (!cobrancaId) return null;
  try {
    // A cobrança precisa existir de fato — id resolvido errado não vira linha órfã.
    const alvo = await sbFetch(`cobrancas?id=eq.${cobrancaId}&select=id&limit=1`).catch(() => []);
    if (!alvo[0]) { console.warn('[repasse-ficha] cobrança inexistente:', cobrancaId); return null; }
    // Idempotência: o webhook pode reentregar, e /api/repassar pode ter concluído na hora.
    // `transacao_id` é o id do transfer no Asaas — mesmo PIX, mesma linha.
    if (transferId) {
      const ja = await sbFetch(`repasses_cliente?cobranca_id=eq.${cobrancaId}&transacao_id=eq.${encodeURIComponent(transferId)}&select=id&limit=1`).catch(() => []);
      if (ja[0]) return { repasse_id: ja[0].id, duplicado: true };
    }

    let documentoId = null;
    if (comprovante && comprovante.base64) {
      try {
        const path = await subirNaPastaDaCobranca(cobrancaId, transferId, comprovante);
        // `devedor_doc` é só a chave de agrupamento dos documentos do devedor. Tenta o
        // devedor de mesmo id (vale em 504 dos 538 casos) e, se não achar, usa a chave
        // por id — igual ao fallback do fluxo manual. Não é o vínculo do repasse: esse
        // é `cobranca_id`, já validado acima.
        const devs = await sbFetch(`devedores?id=eq.${cobrancaId}&select=doc&limit=1`).catch(() => []);
        const devDoc = String((devs[0] && devs[0].doc) || '').replace(/\D/g, '') || `id-${cobrancaId}`;
        const nome = `Repasse — ${credor.nome || 'cliente'} — ${dataPix || 'sem-data'} — R$ ${fmtNum(valor)}.${comprovante.ext || 'pdf'}`;
        const doc = await sbFetch('documentos', {
          method: 'POST', prefer: 'return=representation',
          body: JSON.stringify({
            devedor_doc: devDoc, devedor_id: cobrancaId, cobranca_id: cobrancaId,
            categoria: 'repasse', nome, storage_path: path,
            mime_type: comprovante.content_type || 'application/pdf', size_bytes: comprovante.bytes || null,
          }),
        });
        documentoId = (Array.isArray(doc) ? doc[0] : doc)?.id || null;
      } catch (e) {
        // Sem anexo ainda vale registrar o repasse: o valor precisa abater o capital.
        console.warn('[repasse-ficha] comprovante não anexado:', e.message);
      }
    }

    const novo = await sbFetch('repasses_cliente', {
      method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({
        cobranca_id: cobrancaId, cliente_id: credor.id || null,
        valor: Math.abs(Number(valor) || 0), data_pix: dataPix || null,
        transacao_id: transferId || null,
        destinatario_nome: credor.nome || null, destinatario_doc: credor.doc || null,
        documento_id: documentoId, status: 'confirmado', origem: 'pix-automatico',
      }),
    });
    const repasseId = (Array.isArray(novo) ? novo[0] : novo)?.id || null;
    const statusCaso = await recomputarCapital(cobrancaId).catch(() => null);
    return { repasse_id: repasseId, documento_id: documentoId, status_caso: statusCaso };
  } catch (e) {
    console.warn('[repasse-ficha] falhou:', e.message);
    return null;
  }
}

// Quanto ainda cabe repassar neste caso. Devolve null quando não dá para saber (sem
// cobrança ou sem capital definido) — nesse caso não há teto a aplicar.
//
// Existe porque TODAS as travas de repasse eram por parcela: lançamento já baixado,
// operação sem capital, repasse já efetuado, transfer já disparado. Nenhuma olhava o
// caso inteiro. Em 17/08/2026 a Veronilda tinha R$ 450,00 de capital, R$ 312,00 já
// repassados e R$ 1.230,00 ainda pendentes no financeiro: pagar tudo mandaria R$ 1.092,00
// a mais ao credor, sem um único aviso. Repasse feito não volta.
async function saldoDeCapital(cobrancaId) {
  if (!cobrancaId) return null;
  const cobs = await sbFetch(`cobrancas?id=eq.${cobrancaId}&select=valor_capital,divida&limit=1`).catch(() => []);
  const cob = cobs[0];
  if (!cob) return null;
  const cap = cob.valor_capital != null ? Number(cob.valor_capital)
    : (cob.divida && cob.divida.valorCapital != null ? Number(cob.divida.valorCapital) : null);
  if (cap == null || !(cap > 0)) return null;

  // O que já saiu, por dois caminhos que podem não coincidir: as linhas da ficha e as
  // saídas baixadas no financeiro. Vale o MAIOR — subestimar aqui deixaria passar.
  const rps = await sbFetch(`repasses_cliente?cobranca_id=eq.${cobrancaId}&select=valor`).catch(() => []);
  const naFicha = (rps || []).reduce((s, r) => s + (Number(r.valor) || 0), 0);
  const lancs = await sbFetch(`fin_lancamento?cobranca_id=eq.${cobrancaId}&tipo_movimento=eq.0&status=eq.1&select=valor`).catch(() => []);
  const noFinanceiro = (lancs || []).reduce((s, l) => s + Math.abs(Number(l.valor) || 0), 0);

  const enviado = Math.max(naFicha, noFinanceiro);
  return { capital: cap, enviado, saldo: Math.round((cap - enviado) * 100) / 100 };
}

module.exports = { registrarRepasseNaFicha, resolverCobrancaId, saldoDeCapital };
