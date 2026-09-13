// api/_protesto.js — Protesto extrajudicial pela CRA (CENPROT Empresas / IEPTB).
// Ação `protesto` de api/automacao.js. Exige sessão do painel (requireUser).
//
// POST /api/automacao?action=protesto  { op, ... }
//   op = 'status'    → { configurado, ambiente }
//   op = 'enviar'    → apresenta o título. Aceita `caso_id` (devedor/credor preenchidos do
//                      banco: devedores.doc/endereço, clientes.doc/endereço) e/ou o `titulo`
//                      explícito no formato de api/_cenprot.js. Grava em protesto_titulos.
//   op = 'consultar' → { id } da linha em protesto_titulos → consulta a CRA e atualiza status,
//                      protocolo, custas e ocorrências.
//   op = 'operacao'  → { id, operacao: REMOCAO|DESISTENCIA|CANCELAMENTO, justificativa }
//                      — valida contra o status gravado antes de chamar a CRA.
//   op = 'listar'    → { caso_id? } últimos títulos.
//
// GATED: sem CENPROT_USUARIO/SENHA nada sai — 'enviar' devolve { pendente: true } e NÃO grava.
// No PR o convênio com o IEPTB-PR dispensa depósito prévio (Lei estadual 19.350/2017) para
// título com até 1 ano de vencimento; acima disso, ou em desistência/cancelamento sem
// pagamento, as custas ficam com o apresentante — por isso 'operacao' exige justificativa.

const { requireUser, applyCors } = require('./_auth.js');
const { sbFetch } = require('./_sb.js');
const cen = require('./_cenprot.js');

function onlyDigits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function lerBody(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

// devedores/clientes → bloco de pessoa do CENPROT. Endereço separado (migração 20260510_02)
// tem precedência; `endereco` livre entra como fallback.
function pessoaDoBanco(row, extra) {
  if (!row) return null;
  return {
    nome: row.nome || '', documento: onlyDigits(row.doc),
    endereco: row.rua || row.endereco || '', numero: row.numero || 'S/N', complemento: row.complemento || '',
    cep: onlyDigits(row.cep), bairro: row.bairro || '', municipio: row.cidade || '', uf: (row.uf || '').toUpperCase(),
    ...(extra || {}),
  };
}

async function montarDoCaso(casoId, sobrescrever) {
  const devs = await sbFetch(`devedores?id=eq.${encodeURIComponent(casoId)}&select=id,nome,doc,email,telefone,cep,rua,numero,complemento,bairro,cidade,uf,endereco,cliente_id&limit=1`);
  const dev = Array.isArray(devs) ? devs[0] : null;
  if (!dev) throw new Error('Caso não encontrado: ' + casoId);
  let cli = null;
  if (dev.cliente_id) {
    const cls = await sbFetch(`clientes?id=eq.${encodeURIComponent(dev.cliente_id)}&select=id,nome,doc,cep,rua,numero,complemento,bairro,cidade,uf,endereco&limit=1`);
    cli = Array.isArray(cls) ? cls[0] : null;
  }
  const s = sobrescrever || {};
  return {
    cedente: s.cedente || pessoaDoBanco(cli),
    sacador: s.sacador || null,
    devedor: s.devedor || pessoaDoBanco(dev, { principal: 'S', fone: onlyDigits(dev.telefone), email: dev.email || '' }),
    devedores: s.devedores,
    divida: s.divida || {},
    geral: s.geral,
    alteracao: s.alteracao,
    _dev: dev, _cli: cli,
  };
}

function chaveDe(row) {
  return {
    devedorDocumento: row.devedor_doc, devedorNome: row.devedor_nome, numero: row.numero,
    nossoNumero: row.nosso_numero, especie: row.especie, vencimento: row.vencimento, emissao: row.emissao,
    protocolo: row.protocolo_cartorio || undefined, dataProtocolo: row.data_protocolo || undefined,
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await requireUser(req, res);
  if (!user) return;

  const b = lerBody(req);
  const op = String(b.op || 'status');
  try {
    if (op === 'status') {
      return res.status(200).json({ ok: true, configurado: cen.configurado(), ambiente: cen.ambiente(), endpoint: cen.endpoint() });
    }

    if (op === 'listar') {
      const filtro = b.caso_id ? `&caso_id=eq.${encodeURIComponent(b.caso_id)}` : '';
      const rows = await sbFetch(`protesto_titulos?select=*&order=created_at.desc&limit=200${filtro}`);
      return res.status(200).json({ ok: true, titulos: rows });
    }

    if (op === 'enviar') {
      const t = b.caso_id ? await montarDoCaso(b.caso_id, b.titulo) : (b.titulo || {});
      if (!cen.configurado()) {
        // Monta para validar (erros de dado aparecem já aqui), mas não grava nem envia.
        cen.montarTitulo(t, 'sem-token');
        return res.status(200).json({ ok: false, pendente: true, motivo: 'CENPROT não configurado — convênio IEPTB pendente (CENPROT_USUARIO/SENHA na Vercel).', titulo_validado: true });
      }
      const r = await cen.enviarTitulo(t);
      const d = t.divida || {};
      const linha = {
        caso_id: b.caso_id || null, ambiente: cen.ambiente(),
        devedor_nome: t.devedor.nome, devedor_doc: onlyDigits(t.devedor.documento),
        credor_nome: t.cedente.nome, credor_doc: onlyDigits(t.cedente.documento),
        especie: d.especie, numero: String(d.numero), nosso_numero: String(d.nossoNumero || d.numero),
        valor: Number(cen.dinheiro(d.valor)), emissao: cen.data(d.emissao), vencimento: d.vencimentoAVista ? '99/99/9999' : cen.data(d.vencimento),
        status: r.resposta.status ? 'ENVIADO' : 'ERRO', resposta_codigo: r.resposta.codigo, resposta_msg: r.resposta.mensagem,
        enviado_por: user.email || user.id, xml_envio_ok: r.resposta.status,
      };
      const ins = await sbFetch('protesto_titulos', { method: 'POST', body: JSON.stringify(linha) });
      return res.status(r.resposta.status ? 200 : 422).json({ ok: r.resposta.status, resposta: r.resposta, titulo: Array.isArray(ins) ? ins[0] : ins });
    }

    if (op === 'consultar' || op === 'operacao') {
      if (!b.id) return res.status(400).json({ error: 'Informe o id do título (protesto_titulos.id).' });
      const rows = await sbFetch(`protesto_titulos?id=eq.${encodeURIComponent(b.id)}&select=*&limit=1`);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return res.status(404).json({ error: 'Título não encontrado.' });
      if (!cen.configurado()) return res.status(200).json({ ok: false, pendente: true, motivo: 'CENPROT não configurado.' });

      if (op === 'consultar') {
        const c = await cen.consultarTitulo(chaveDe(row));
        const ult = c.ocorrencias[c.ocorrencias.length - 1];
        const patch = {
          status: c.statusAtual || row.status,
          protocolo_cartorio: c.cartorio.protocolo || row.protocolo_cartorio,
          data_protocolo: c.cartorio.data || row.data_protocolo,
          comarca: c.cartorio.comarca || row.comarca, cartorio: c.cartorio.cartorio || row.cartorio,
          custas: c.custas, ocorrencias: c.ocorrencias, ultima_ocorrencia: ult ? ult.status : row.ultima_ocorrencia,
          consultado_em: new Date().toISOString(),
        };
        const up = await sbFetch(`protesto_titulos?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        return res.status(200).json({ ok: true, consulta: { statusAtual: c.statusAtual, cartorio: c.cartorio, custas: c.custas, ocorrencias: c.ocorrencias }, titulo: Array.isArray(up) ? up[0] : up });
      }

      const operacao = String(b.operacao || '').toUpperCase();
      if (!b.justificativa) return res.status(400).json({ error: 'Justificativa obrigatória — remoção, desistência e cancelamento podem gerar custas para o apresentante.' });
      const r = await cen.operacaoTitulo({ ...chaveDe(row), operacao, statusAtual: row.status, autoriza: 'S', justificativa: b.justificativa });
      const patch = {
        status: r.resposta.status ? { REMOCAO: 'REMOVIDO', DESISTENCIA: 'RETIRADO', CANCELAMENTO: 'CANCELADO' }[operacao] : row.status,
        operacao_pedida: operacao, operacao_msg: `${r.resposta.codigo} ${r.resposta.mensagem}`.trim(),
        operacao_em: new Date().toISOString(), operacao_por: user.email || user.id,
      };
      const up = await sbFetch(`protesto_titulos?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.resposta.status ? 200 : 422).json({ ok: r.resposta.status, resposta: r.resposta, titulo: Array.isArray(up) ? up[0] : up });
    }

    return res.status(400).json({ error: 'op desconhecida: ' + op });
  } catch (e) {
    console.error('[protesto]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
};

module.exports._pessoaDoBanco = pessoaDoBanco;
