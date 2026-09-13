// assets/js/esnfs-ponte.js — Ponte entre o painel e a extensão "NFS-e ESNFS — Emissão em
// lote" (extensao/esnfs/). A emissão de NFS-e da COBRASQ é feita no ESNFS (prefeitura de
// Dois Vizinhos), NÃO pelo Asaas: o caminho do Asaas (api/_emitir-nf*.js) nunca emitiu
// uma nota em produção e saiu da tela em 13/09/2026.
//
// A ponte é por área de transferência, de propósito — a extensão não fala com servidor
// nenhum e não precisa de token:
//   painel  →  "Copiar lote p/ ESNFS"  →  texto `Nome | CPF | valor | ref`  →  extensão
//   extensão → relatório com bloco COBRASQ-RESULTADO → "Importar resultado" → painel
//
// Só funções puras aqui (sem DOM, sem Supabase), para o teste
// test/f38_esnfs_ponte.test.js rodar em Node. Carregado pelo index.html e usado por
// assets/js/nf.js (fila) e pela aba Faturamento do Financeiro.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  Object.assign(root, api); // globais no navegador (script clássico, como nf.js)
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const onlyDigits = (s) => String(s || '').replace(/\D+/g, '');
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  function esnfsFmtValor(n) {
    return round2(n).toFixed(2).replace('.', ',');
  }
  // "3.800,00" / "R$ 3800,00" / "3800.00" → 3800
  function esnfsParseValor(s) {
    let t = String(s || '').trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
    if (!t) return 0;
    if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/\.\d{3}(\D|$)/.test(t)) t = t.replace(/\./g, '');
    else t = t.replace(/,/g, '.');
    const n = parseFloat(t);
    return isFinite(n) ? round2(n) : 0;
  }
  function esnfsFormatDoc(d) {
    d = onlyDigits(d);
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    return d;
  }

  // ── base fiscal ────────────────────────────────────────────────────────────
  // Mesma regra de api/_emitir-nf.js: quando o recebimento tem capital de terceiro
  // (repasse ao credor), a nota é só sobre o HONORÁRIO; sem repasse, o valor cheio.
  // A extensão recebe um número por linha e não sabe disso — quem sabe é o painel.
  //   q  = linha de nf_fila_analise (cpf_cnpj, valor)
  //   op = fin_operacao casada (pelo lançamento de receita ou pelo pagamento Asaas);
  //        pode não existir — recebimento baixado à mão, ou anterior ao pipeline
  //   cob = cobrança do lançamento (valor_capital = capital do credor no caso). Sem
  //        operação e com capital na cobrança, não dá para saber quanto do pago é
  //        honorário: fica em revisão em vez de emitir sobre o valor cheio.
  function esnfsBaseFiscal(q, op, cob) {
    const doc = onlyDigits(q && q.cpf_cnpj);
    if (doc.length !== 11 && doc.length !== 14) return { pronto: false, base: 0, tipo: null, motivo: 'sem CPF/CNPJ do tomador' };
    if (op && op.repasse_status === 'revisar') return { pronto: false, base: 0, tipo: null, motivo: 'rateio capital/honorário em revisão' };
    if (!op && cob && Number(cob.valor_capital) > 0) return { pronto: false, base: 0, tipo: null, motivo: 'cobrança com capital do credor e sem rateio — confira o repasse' };
    let base, tipo;
    if (op && Number(op.valor_capital) > 0) { base = round2(op.valor_honorario); tipo = 'honorario'; }
    else if (op) { base = round2(op.valor_recebido); tipo = 'valor_cheio'; }
    else { base = round2(q.valor); tipo = 'valor_cheio'; }
    if (!(base > 0)) return { pronto: false, base: 0, tipo, motivo: 'base zero' };
    return { pronto: true, base, tipo, motivo: '' };
  }

  // ── lote (painel → extensão) ───────────────────────────────────────────────
  // Uma linha por nota: `Nome | CPF | valor | ref`. A ref volta no resultado e é o que
  // liga a nota emitida à linha da fila (`fila:<uuid>`) ou à linha manual (`manual:<id>`).
  // Linhas com '#' são comentário — a extensão já as ignora.
  function esnfsMontarLote(itens, opts) {
    const quando = (opts && opts.quando) || new Date();
    const cab = '# COBRASQ — lote para o ESNFS — ' + quando.toLocaleString('pt-BR');
    const linhas = (itens || []).map((it) =>
      [String(it.nome || '').replace(/[|\r\n\t;]+/g, ' ').replace(/\s+/g, ' ').trim(), esnfsFormatDoc(it.doc), esnfsFmtValor(it.valor), String(it.ref || '')].join(' | ')
    );
    return [cab].concat(linhas).join('\n');
  }

  // ── resultado (extensão → painel) ──────────────────────────────────────────
  // O relatório da extensão (v1.2+) termina com um bloco legível por máquina:
  //   --- COBRASQ-RESULTADO v1 ---
  //   ref;status;nota;cpf;valor;nome
  //   fila:…;ok;2026/123;09113369903;3800,00;JESSICA …
  //   --- FIM ---
  // Sem o bloco (relatório antigo, ou colado da tabela), cai no fallback: lê a tabela
  // Markdown e devolve as linhas sem ref — o painel casa por CPF + valor.
  const RESULT_INI = /^-{3}\s*COBRASQ-RESULTADO v1\s*-{3}$/m;
  const RESULT_FIM = /^-{3}\s*FIM\s*-{3}$/m;

  function esnfsParseResultado(texto) {
    const t = String(texto || '').replace(/\r/g, '');
    const out = [];
    const mi = t.match(RESULT_INI);
    if (mi) {
      const depois = t.slice(mi.index + mi[0].length);
      const mf = depois.match(RESULT_FIM);
      const corpo = mf ? depois.slice(0, mf.index) : depois;
      for (const l of corpo.split('\n')) {
        const s = l.trim();
        if (!s || /^ref;/i.test(s)) continue;
        const c = s.split(';');
        if (c.length < 3) continue;
        out.push({
          ref: c[0].trim(),
          status: /^ok$/i.test(c[1].trim()) ? 'ok' : 'erro',
          nota: (c[2] || '').trim(),
          doc: onlyDigits(c[3]),
          valor: esnfsParseValor(c[4]),
          nome: (c[5] || '').trim(),
          obs: (c.slice(6).join(';') || '').trim(),
        });
      }
      return { fonte: 'bloco', itens: out };
    }
    // fallback: tabela markdown "| # | Tomador | CPF/CNPJ | Valor (R$) | Nota | Status | Observação |"
    for (const l of t.split('\n')) {
      const s = l.trim();
      if (!s.startsWith('|') || /^\|\s*#/.test(s) || /^\|\s*-/.test(s)) continue;
      const c = s.split('|').map((x) => x.trim());
      // c[0] vazio (antes do 1º pipe): # | Tomador | CPF | Valor | Nota | Status | Obs
      if (c.length < 7 || !/^\d+$/.test(c[1])) continue;
      const doc = onlyDigits(c[3]);
      if (doc.length !== 11 && doc.length !== 14) continue;
      out.push({
        ref: '',
        status: /emitida/i.test(c[6]) ? 'ok' : 'erro',
        nota: (c[5] || '').replace(/^—$/, ''),
        doc,
        valor: esnfsParseValor(c[4]),
        nome: c[2],
        obs: (c[7] || '').replace(/^—$/, ''),
      });
    }
    return { fonte: out.length ? 'tabela' : 'vazio', itens: out };
  }

  // Casa cada resultado com uma linha pendente. Por ref quando há; senão por CPF + valor
  // (e só se for única — duas parcelas iguais da mesma pessoa ficam para decisão humana).
  function esnfsCasarResultado(resultados, pendentes) {
    const porRef = new Map();
    for (const p of pendentes || []) if (p.ref) porRef.set(p.ref, p);
    const usados = new Set();
    return (resultados || []).map((r) => {
      let alvo = null, como = '';
      if (r.ref && porRef.has(r.ref)) { alvo = porRef.get(r.ref); como = 'ref'; }
      else {
        const cands = (pendentes || []).filter((p) => !usados.has(p.ref) && onlyDigits(p.doc) === r.doc && round2(p.valor) === round2(r.valor));
        if (cands.length === 1) { alvo = cands[0]; como = 'cpf+valor'; }
        else if (cands.length > 1) como = 'ambiguo';
        else como = 'sem_par';
      }
      if (alvo) usados.add(alvo.ref);
      return { resultado: r, pendente: alvo, como };
    });
  }

  // ── Faturamento ────────────────────────────────────────────────────────────
  // Data da nota: a que veio do ESNFS (metadata.emitida_em, AAAA-MM-DD) ou, na falta, o
  // dia em que a linha foi criada.
  function nfDataEmissao(r) {
    const m = (r && r.metadata) || {};
    const d = m.emitida_em || (r && r.criada_em) || '';
    return String(d).slice(0, 10);
  }
  function nfNumero(r) {
    const m = (r && r.metadata) || {};
    return m.nf_number || m.nf_numero || '';
  }
  // rows = nf_avulsa; devolve só as emitidas dentro de [ini, fim] (AAAA-MM-DD, inclusivo).
  function faturamentoFiltrar(rows, ini, fim) {
    return (rows || []).filter((r) => {
      const st = (r.metadata && r.metadata.resolved) || r.nf_status;
      if (st !== 'emitida') return false;
      const d = nfDataEmissao(r);
      return d && (!ini || d >= ini) && (!fim || d <= fim);
    });
  }
  // Série mensal para o gráfico: os `n` meses que terminam em `fimISO`.
  function faturamentoSerieMensal(rows, fimISO, n) {
    const fim = String(fimISO || '').slice(0, 7);
    const [fy, fm] = fim.split('-').map(Number);
    const meses = [];
    for (let i = (n || 12) - 1; i >= 0; i--) {
      const d = new Date(fy, fm - 1 - i, 1);
      meses.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    const soma = {}; const qtd = {};
    for (const r of faturamentoFiltrar(rows, meses[0] + '-01', fim + '-31')) {
      const k = nfDataEmissao(r).slice(0, 7);
      soma[k] = round2((soma[k] || 0) + Number(r.valor || 0));
      qtd[k] = (qtd[k] || 0) + 1;
    }
    return meses.map((k) => ({ mes: k, total: soma[k] || 0, notas: qtd[k] || 0 }));
  }
  // Previsão do Simples = faturamento × alíquota efetiva informada em Config (o % que
  // aparece no DAS). Não é a tabela do anexo: decisão do Gustavo em 13/09/2026.
  function simplesPrevisao(total, aliquotaPct) {
    const a = parseFloat(String(aliquotaPct == null ? '' : aliquotaPct).replace(',', '.'));
    if (!isFinite(a) || a <= 0) return 0;
    return round2(Number(total || 0) * a / 100);
  }
  // Lançamento do DAS: competência MM/AAAA vence dia 20 do mês seguinte
  // ("Simples Nacional — DAS de setembro" é o que vence em 20/09, sobre agosto).
  const MESES_PT = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  function simplesLancamento(competenciaAM, valor) {
    const [y, m] = String(competenciaAM).split('-').map(Number);
    const venc = new Date(y, m, 20); // mês seguinte, dia 20
    const iso = venc.getFullYear() + '-' + String(venc.getMonth() + 1).padStart(2, '0') + '-20';
    return {
      descricao: 'Simples Nacional — DAS de ' + MESES_PT[venc.getMonth()],
      data_competencia: iso,
      data_vencimento: iso,
      valor: -Math.abs(round2(valor)),
      tipo_movimento: 0,
      status: 0,
      raw_payload: { origem: 'faturamento_das', competencia: String(competenciaAM).slice(0, 7) },
    };
  }

  return {
    esnfsFmtValor, esnfsParseValor, esnfsFormatDoc,
    esnfsBaseFiscal, esnfsMontarLote, esnfsParseResultado, esnfsCasarResultado,
    nfDataEmissao, nfNumero, faturamentoFiltrar, faturamentoSerieMensal,
    simplesPrevisao, simplesLancamento,
  };
});
