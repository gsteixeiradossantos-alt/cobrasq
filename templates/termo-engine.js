/* ============================================================================
 * termo-engine.js — Motor de preenchimento do termo de acordo (Fase 2, recorte 1)
 * ----------------------------------------------------------------------------
 * Puro (sem DOM/rede além de fetch do template). A UI monta o objeto `dados`
 * (de caso + formulário + seletor M/F) e chama montarTermoExtrajudicial().
 * Lógica de extenso/frases VALIDADA contra o "golden" do v3 (Edivânia).
 *
 * dados = {
 *   credor:  { nome, qualificacao, genero:'F'|'M', assNome, assDoc },
 *   devedor: { nome, tipo:'PF'|'PJ', genero:'M'|'F', documento, endereco:{rua,numero,complemento,bairro,cidade,uf,cep}, telefone, assNome, assDoc },
 *   acordo:  { total, parcelas, valorParcela, vencimento:'YYYY-MM-DD', multa, penal, entrada:{valor,vencimento}|null },
 *   dataAcordo: 'YYYY-MM-DD'
 * }
 * ========================================================================== */
(function (global) {
  'use strict';

  const U = ["zero","um","dois","três","quatro","cinco","seis","sete","oito","nove","dez","onze","doze","treze","quatorze","quinze","dezesseis","dezessete","dezoito","dezenove"];
  const DEZ = ["","","vinte","trinta","quarenta","cinquenta","sessenta","setenta","oitenta","noventa"];
  const CEM = ["","cento","duzentos","trezentos","quatrocentos","quinhentos","seiscentos","setecentos","oitocentos","novecentos"];

  function fem(w) { return w.replace(/\bum\b/g, "uma").replace(/\bdois\b/g, "duas"); }

  function extCentena(n, isFem) {
    if (n === 0) return "";
    if (n === 100) return "cem";
    const c = Math.floor(n / 100), resto = n % 100, parts = [];
    if (c) parts.push(CEM[c]);
    if (resto) {
      let w = resto < 20 ? U[resto] : (DEZ[Math.floor(resto / 10)] + (resto % 10 ? " e " + U[resto % 10] : ""));
      if (isFem) w = fem(w);
      parts.push(c ? "e " + w : w);
    }
    return parts.join(" ");
  }

  function extInt(n, isFem) {
    n = Math.floor(n);
    if (n === 0) return "zero";
    const milhao = Math.floor(n / 1000000), mil = Math.floor((n % 1000000) / 1000), cent = n % 1000, parts = [];
    if (milhao) parts.push(milhao === 1 ? "um milhão" : extInt(milhao) + " milhões");
    if (mil) parts.push(mil === 1 ? "mil" : extCentena(mil) + " mil");
    if (cent) parts.push(extCentena(cent, isFem));
    let txt = parts[0];
    for (let i = 1; i < parts.length; i++) {
      const ehUltima = i === parts.length - 1;
      const usaE = ehUltima && cent && (cent < 100 || cent % 100 === 0);
      txt += (usaE ? " e " : ", ") + parts[i];
    }
    return txt;
  }

  function fmtBRL(v) {
    return "R$ " + Number(v).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  function reaisExt(valor) {
    const reais = Math.floor(valor), cent = Math.round((valor - reais) * 100);
    let r = extInt(reais) + (reais === 1 ? " real" : " reais");
    if (cent) r += " e " + extInt(cent) + (cent === 1 ? " centavo" : " centavos");
    return r;
  }
  function valorCompleto(v) { return fmtBRL(v) + " (" + reaisExt(v) + ")"; }
  function pctExt(p) { p = Number(p); return p + "% (" + extInt(p) + " por cento)"; }

  const MES = ["", "janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  function dataExtenso(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return d + " de " + MES[m] + " de " + y;
  }

  // UF → "Estado do/de X" (preposição correta)
  const UF = {
    AC:"do Acre", AL:"de Alagoas", AP:"do Amapá", AM:"do Amazonas", BA:"da Bahia", CE:"do Ceará",
    DF:"do Distrito Federal", ES:"do Espírito Santo", GO:"de Goiás", MA:"do Maranhão", MT:"do Mato Grosso",
    MS:"do Mato Grosso do Sul", MG:"de Minas Gerais", PA:"do Pará", PB:"da Paraíba", PR:"do Paraná",
    PE:"de Pernambuco", PI:"do Piauí", RJ:"do Rio de Janeiro", RN:"do Rio Grande do Norte",
    RS:"do Rio Grande do Sul", RO:"de Rondônia", RR:"de Roraima", SC:"de Santa Catarina",
    SP:"de São Paulo", SE:"de Sergipe", TO:"do Tocantins"
  };
  function estadoFrase(uf) { uf = String(uf || "").trim().toUpperCase(); return UF[uf] ? "Estado " + UF[uf] : (uf || ""); }

  function qualifDevedor(dev) {
    const e = dev.endereco || {};
    const endereco = [
      e.rua ? "com endereço na " + e.rua : "",
      e.numero ? "n. " + e.numero : "",
      e.complemento ? e.complemento : "",
      e.bairro ? "no bairro " + e.bairro : "",
      e.cep ? "CEP. " + e.cep : "",
      e.cidade ? "município de " + e.cidade : "",
      e.uf ? estadoFrase(e.uf) : ""
    ].filter(Boolean).join(", ");
    const tel = dev.telefone ? "telefone n. " + dev.telefone : "";
    let base;
    if (dev.tipo === "PJ") {
      base = "pessoa jurídica de direito privado, inscrita no CNPJ sob n. " + (dev.documento || "");
    } else {
      const nac = dev.genero === "M" ? "brasileiro" : "brasileira";
      const insc = dev.genero === "M" ? "inscrito" : "inscrita";
      base = nac + ", " + insc + " no CPF sob. n. " + (dev.documento || "");
    }
    // Junta só os trechos não-vazios — endereço ausente/parcial não gera ", ," nem vírgula órfã.
    return [base, endereco, tel].filter(Boolean).join(", ") + ".";
  }

  // Credor: usa a qualificação verbatim guardada no cadastro; senão, monta uma básica.
  function qualifCredor(cred) {
    if (cred.qualificacao && cred.qualificacao.trim()) return cred.qualificacao.trim();
    return "pessoa jurídica de direito privado, inscrita no CNPJ sob n. " + (cred.documento || "") +
      (cred.endereco ? ", com endereço na " + cred.endereco : "") + ".";
  }

  function frasePagamento(ac) {
    const venc = "<strong>" + dataExtenso(ac.vencimento) + "</strong>";
    if (ac.entrada && ac.entrada.valor) {
      const ent = "<strong>" + valorCompleto(ac.entrada.valor) + "</strong>";
      const entVenc = ac.entrada.vencimento ? ", com vencimento em <strong>" + dataExtenso(ac.entrada.vencimento) + "</strong>," : "";
      const np = ac.parcelas, plural = np === 1
        ? "1 (uma) parcela mensal"
        : np + " (" + extInt(np, true) + ") parcelas mensais e sucessivas";
      return "mediante o pagamento de uma entrada de " + ent + entVenc +
        " e o remanescente em " + plural + " no valor de <strong>" + valorCompleto(ac.valorParcela) + "</strong>" +
        (np === 1 ? "" : " cada") + ", sendo que a primeira parcela será considerada vencida em " + venc;
    }
    if (ac.parcelas === 1) {
      return "mediante o pagamento de 1 (uma) parcela mensal no valor de <strong>" + valorCompleto(ac.valorParcela) +
        "</strong>, sendo que a primeira parcela será considerada vencida em " + venc;
    }
    return "mediante o pagamento de " + ac.parcelas + " (" + extInt(ac.parcelas, true) + ") parcelas mensais e sucessivas no valor de <strong>" +
      valorCompleto(ac.valorParcela) + "</strong> cada, sendo que a primeira parcela será considerada vencida em " + venc;
  }

  function escAttr(s) { return String(s == null ? "" : s); }
  function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function generoDevedorLabel(dv) {
    return dv.tipo === "PJ" ? "devedora" : (dv.genero === "M" ? "devedor" : "devedora");
  }

  // Preâmbulo: um bloco de parte por devedor (qualificação reusa qualifDevedor).
  function preambuloDevedores(devs) {
    return (devs || []).map(function (dv) {
      const g = generoDevedorLabel(dv);
      const label = g === "devedor" ? "Devedor" : "Devedora";
      return '<div><div class="party-label">' + label + '</div>' +
        '<p>Como ' + g + ', <span class="party-name">' + escHtml(dv.nome || "") + '</span>, ' + qualifDevedor(dv) + '</p></div>';
    }).join("");
  }

  // Assinaturas: um bloco por devedor, com a âncora <<assdevN>> (1-based).
  function assinaturasDevedores(devs) {
    return (devs || []).map(function (dv, i) {
      const g = generoDevedorLabel(dv);
      const role = g === "devedor" ? "Devedor" : "Devedora";
      const nome = dv.assNome || (dv.nome || "").split(" ")[0];
      return '<div class="sig">' +
        '<div class="sig-token">&lt;&lt;assdev' + (i + 1) + '&gt;&gt;</div>' +
        '<div class="sig-line"></div>' +
        '<div class="sig-name">' + escHtml(nome) + '</div>' +
        '<div class="sig-doc">' + escHtml(dv.assDoc || "") + '</div>' +
        '<div class="sig-role">' + role + '</div></div>';
    }).join("");
  }

  // Mapa placeholder → valor
  function placeholders(dados) {
    const cr = dados.credor || {}, ac = dados.acordo || {};
    const devs = (dados.devedores && dados.devedores.length) ? dados.devedores : (dados.devedor ? [dados.devedor] : []);
    const dv0 = devs[0] || {};
    return {
      generoCredor: cr.genero === "M" ? "credor" : "credora",
      credorNome: cr.nome || "",
      credorQualificacao: qualifCredor(cr),
      devedoresPreambulo: preambuloDevedores(devs),
      assinaturasDevedores: assinaturasDevedores(devs),
      valorDivida: valorCompleto(ac.total),
      frasePagamento: frasePagamento(ac),
      multaBoleto: pctExt(ac.multa != null ? ac.multa : 10),
      clausulaPenal: pctExt(ac.penal != null ? ac.penal : 50),
      dataAcordo: dataExtenso(dados.dataAcordo),
      credorAssNome: cr.assNome || cr.nome || "",
      credorAssDoc: cr.assDoc || "",
      // compat (template single-devedor antigo)
      generoDevedor: generoDevedorLabel(dv0),
      devedorNome: dv0.nome || "",
      devedorQualificacao: devs.length ? qualifDevedor(dv0) : "",
      dev1AssNome: dv0.assNome || (dv0.nome || "").split(" ")[0],
      dev1AssDoc: dv0.assDoc || ""
    };
  }

  function preencher(templateHtml, dados) {
    const map = placeholders(dados);
    return templateHtml.replace(/\{\{(\w+)\}\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(map, k) ? escAttr(map[k]) : m);
  }

  // Busca + memoiza o template
  let _tpl = null;
  async function carregarTemplate() {
    if (_tpl) return _tpl;
    const r = await fetch("/templates/acordo-extrajudicial.html", { cache: "force-cache" });
    if (!r.ok) throw new Error("Falha ao carregar o template do termo (HTTP " + r.status + ")");
    _tpl = await r.text();
    return _tpl;
  }

  async function montarTermoExtrajudicial(dados) {
    const tpl = await carregarTemplate();
    return preencher(tpl, dados);
  }

  /* ==========================================================================
   * JUDICIAL — termo de acordo p/ homologação (art. 515, II, CPC)
   * Mesma base do extrajudicial + placeholders judiciais: endereçamento ao juízo,
   * nº do processo, cláusula 4 variável (Sisbajud | concentração/desistência |
   * consolidação) e o contato da parte ré (cláusula 7).
   * dados.judicial = { numeroProcesso, comarca, foro:'jec'|'vara',
   *   clausula4:{ mode:'desistencia'|'sisbajud'|'consolidacao',
   *               procPrincipal, proc2, comarca2, valorBloqueado } }
   * ======================================================================== */
  function enderecamentoJudicial(j) {
    const comarca = (j && j.comarca ? String(j.comarca).trim() : "") || "____";
    const foro = (j && j.foro) === "vara"
      ? "Ao Juízo da Vara Cível da Comarca de "
      : "Ao Juizado Especial Cível da Comarca de ";
    return foro + comarca;
  }

  function clausula4Judicial(dados) {
    const j = dados.judicial || {};
    const c4 = j.clausula4 || {};
    const mode = c4.mode || "consolidacao";
    if (mode === "sisbajud") {
      const v = c4.valorBloqueado ? valorCompleto(c4.valorBloqueado) : "____";
      return {
        titulo: "Do Sisbajud",
        corpo:
          "<p>A parte executada informou que houve o bloqueio do valor de <strong>" + v + "</strong>, por meio do Sistema Sisbajud. Deste modo, a parte exequente não se opõe à liberação do referido valor bloqueado para a executada.</p>" +
          "<p>Fica pactuado que, caso posteriormente seja constatado bloqueio de valores realizado em data anterior à assinatura deste acordo, em montante superior ao descrito nesta cláusula, as partes deverão protocolar contrato aditivo no prazo de 5 (cinco) dias, a fim de definir a destinação do valor remanescente.</p>"
      };
    }
    if (mode === "desistencia") {
      const principal = escHtml(c4.procPrincipal || dados.judicial.numeroProcesso || "____");
      const proc2 = escHtml(c4.proc2 || "____");
      const com2 = escHtml((c4.comarca2 || "").trim() || "____");
      return {
        titulo: "Da concentração do débito e desistência",
        corpo:
          "<p>As partes convencionam concentrar a totalidade da dívida e do presente acordo nestes autos n. " + principal +
          ", comprometendo-se a parte autora a requerer a desistência da ação que tramita perante a Comarca de " + com2 +
          " sob os autos n. " + proc2 + ", com o que expressamente anui a parte requerida, respondendo cada parte pelos honorários de seus respectivos patronos naquele feito.</p>"
      };
    }
    return {
      titulo: "Da consolidação do débito neste feito",
      corpo:
        "<p>As partes convencionam que a totalidade da dívida discutida encontra-se consolidada e composta exclusivamente no presente feito, comprometendo-se a parte autora a promover as baixas e comunicações pertinentes após o cumprimento integral do acordo.</p>"
    };
  }

  function contatoReJudicial(dados) {
    const devs = (dados.devedores && dados.devedores.length) ? dados.devedores : (dados.devedor ? [dados.devedor] : []);
    const dv = devs[0] || {};
    const e = dv.endereco || {};
    const endereco = [
      e.rua ? e.rua : "",
      e.numero ? "n. " + e.numero : "",
      e.complemento ? e.complemento : "",
      e.bairro ? e.bairro : "",
      e.cep ? "CEP " + e.cep : "",
      e.cidade ? e.cidade : "",
      e.uf ? estadoFrase(e.uf) : ""
    ].filter(Boolean).join(", ");
    const nome = escHtml(dv.nome || "");
    const partes = [];
    if (endereco) partes.push("o seguinte endereço: " + escHtml(endereco));
    if (dv.telefone) partes.push("telefone: " + escHtml(dv.telefone));
    const info = partes.length ? partes.join("; ") + "." : "os dados de contato constantes dos autos.";
    return "A parte ré " + nome + " indica " + info;
  }

  function placeholdersJudicial(dados) {
    const base = placeholders(dados);
    const j = dados.judicial || {};
    const c4 = clausula4Judicial(dados);
    base.enderecamento = enderecamentoJudicial(j);
    base.numeroProcesso = escAttr(j.numeroProcesso || "");
    base.clausula4Titulo = c4.titulo;
    base.clausula4Corpo = c4.corpo;
    base.contatoRe = contatoReJudicial(dados);
    return base;
  }

  // preenche já permitindo HTML nos valores de cláusula 4 / contato (não escapa esses)
  function preencherJudicial(templateHtml, dados) {
    const map = placeholdersJudicial(dados);
    const rawHtml = { clausula4Corpo: 1, contatoRe: 1, devedoresPreambulo: 1, assinaturasDevedores: 1, frasePagamento: 1, credorQualificacao: 1 };
    return templateHtml.replace(/\{\{(\w+)\}\}/g, function (m, k) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) return m;
      return rawHtml[k] ? String(map[k] == null ? "" : map[k]) : escAttr(map[k]);
    });
  }

  let _tplJud = null;
  async function carregarTemplateJudicial() {
    if (_tplJud) return _tplJud;
    const r = await fetch("/templates/acordo-judicial.html", { cache: "force-cache" });
    if (!r.ok) throw new Error("Falha ao carregar o template do acordo judicial (HTTP " + r.status + ")");
    _tplJud = await r.text();
    return _tplJud;
  }

  async function montarTermoJudicial(dados) {
    const tpl = await carregarTemplateJudicial();
    return preencherJudicial(tpl, dados);
  }

  global.TermoEngine = {
    extInt, reaisExt, valorCompleto, pctExt, dataExtenso, estadoFrase,
    qualifDevedor, qualifCredor, frasePagamento, placeholders,
    preambuloDevedores, assinaturasDevedores, generoDevedorLabel,
    preencher, carregarTemplate, montarTermoExtrajudicial,
    enderecamentoJudicial, clausula4Judicial, contatoReJudicial,
    placeholdersJudicial, preencherJudicial, carregarTemplateJudicial, montarTermoJudicial
  };
})(typeof window !== "undefined" ? window : globalThis);
