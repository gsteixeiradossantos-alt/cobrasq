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
      e.bairro ? "no bairro " + e.bairro : "",
      e.cep ? "CEP. " + e.cep : "",
      e.cidade ? "município de " + e.cidade : "",
      e.uf ? estadoFrase(e.uf) : ""
    ].filter(Boolean).join(", ");
    const tel = dev.telefone ? ", telefone n. " + dev.telefone : "";
    if (dev.tipo === "PJ") {
      return "pessoa jurídica de direito privado, inscrita no CNPJ sob n. " + (dev.documento || "") + ", " + endereco + tel + ".";
    }
    const nac = dev.genero === "M" ? "brasileiro" : "brasileira";
    const insc = dev.genero === "M" ? "inscrito" : "inscrita";
    return nac + ", " + insc + " no CPF sob. n. " + (dev.documento || "") + ", " + endereco + tel + ".";
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

  // Mapa placeholder → valor
  function placeholders(dados) {
    const cr = dados.credor || {}, dv = dados.devedor || {}, ac = dados.acordo || {};
    return {
      generoCredor: cr.genero === "M" ? "credor" : "credora",
      credorNome: cr.nome || "",
      credorQualificacao: qualifCredor(cr),
      generoDevedor: dv.tipo === "PJ" ? "devedora" : (dv.genero === "M" ? "devedor" : "devedora"),
      devedorNome: dv.nome || "",
      devedorQualificacao: qualifDevedor(dv),
      valorDivida: valorCompleto(ac.total),
      frasePagamento: frasePagamento(ac),
      multaBoleto: pctExt(ac.multa != null ? ac.multa : 10),
      clausulaPenal: pctExt(ac.penal != null ? ac.penal : 50),
      dataAcordo: dataExtenso(dados.dataAcordo),
      credorAssNome: cr.assNome || cr.nome || "",
      credorAssDoc: cr.assDoc || "",
      dev1AssNome: dv.assNome || (dv.nome || "").split(" ")[0],
      dev1AssDoc: dv.assDoc || ""
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

  global.TermoEngine = {
    extInt, reaisExt, valorCompleto, pctExt, dataExtenso, estadoFrase,
    qualifDevedor, qualifCredor, frasePagamento, placeholders,
    preencher, carregarTemplate, montarTermoExtrajudicial
  };
})(typeof window !== "undefined" ? window : globalThis);
