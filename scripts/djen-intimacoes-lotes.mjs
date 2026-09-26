// Lógica pura do repasse Mac → djen-intimacoes (testada em test/f48_djen_intimacoes_lotes.test.js).

// "112743/PR" → { numero:'112743', uf:'PR' }; lixo → null.
export function partirOab(oab) {
  const m = String(oab || '').trim().match(/^(\d{1,7})\/([A-Za-z]{2})$/);
  return m ? { numero: m[1], uf: m[2].toUpperCase() } : null;
}

// Quebra o que o Mac baixou em corpos de POST de até `tamanho` itens cada, para
// não mandar megabytes numa chamada só (texto de cada comunicação vai até 60 mil
// caracteres). Só o ÚLTIMO corpo leva finalizar:true (cruzar com e-mail + timeline);
// os demais vão com finalizar:false. OAB com erro vai sozinha, sem itens.
// OAB sem nenhuma comunicação vai com itens:[] (a função registra total 0).
export function montarRepasses(resultados, { inicio, fim, tamanho = 100 } = {}) {
  const corpos = [];
  for (const r of resultados || []) {
    if (r.erro) { corpos.push([{ oab: r.oab, erro: r.erro }]); continue; }
    const itens = Array.isArray(r.itens) ? r.itens : [];
    if (!itens.length) { corpos.push([{ oab: r.oab, itens: [] }]); continue; }
    for (let i = 0; i < itens.length; i += tamanho) corpos.push([{ oab: r.oab, itens: itens.slice(i, i + tamanho) }]);
  }
  if (!corpos.length) corpos.push([]);
  return corpos.map((resultados, i) => ({
    modo: 'resultados', inicio, fim, resultados, finalizar: i === corpos.length - 1,
  }));
}

// Soma os contadores por OAB das várias respostas da função.
export function somarRespostas(respostas) {
  const oabs = {};
  let novas = 0, cruzadas = null, eventos = null;
  for (const r of respostas || []) {
    novas += Number(r?.novas) || 0;
    if (r?.cruzadas != null) cruzadas = r.cruzadas;
    if (r?.eventos != null) eventos = r.eventos;
    for (const [oab, c] of Object.entries(r?.oabs || {})) {
      const a = oabs[oab] || (oabs[oab] = { total: 0, novas: 0, repetidas: 0, erros: 0 });
      if (c.erro) { a.erro = c.erro; continue; }
      for (const k of ['total', 'novas', 'repetidas', 'erros']) a[k] += Number(c[k]) || 0;
    }
  }
  return { novas, cruzadas, eventos, oabs };
}
