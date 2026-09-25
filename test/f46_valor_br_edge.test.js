// F-46: valor BR ("1.924,80") em cobrancas.divida lido pelas edge functions.
// ~364 cobranças (sobretudo Astrea) guardam valorOriginal/totalAvista como string
// BR; `Number("1.924,80")` = NaN deixava Bia/Carlos sem valor e o carlos-teste
// no cenário fictício. Garante o parse tolerante e que ninguém volte ao Number().
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const FN = path.join(__dirname, '..', 'supabase', 'functions');

(async () => {
  const { parseValorBR } = await import(path.join(FN, '_shared', 'valor-br.ts'));
  const casos = [
    [1924.8, 1924.8], ['1.924,80', 1924.8], ['352,53', 352.53], ['1924,80', 1924.8],
    ['1386.00', 1386], ['1924.80', 1924.8], ['1.234', 1234], ['12.345.678', 12345678],
    ['R$ 1.234,56', 1234.56], ['R$1.234,56', 1234.56], [' 1.234,56 ', 1234.56],
    ['-1.234,56', -1234.56], ['', 0], [null, 0], [undefined, 0], ['abc', 0], [NaN, 0], [0, 0],
  ];
  for (const [ent, esp] of casos) {
    const r = parseValorBR(ent);
    assert.ok(Math.abs(r - esp) < 1e-9, `parseValorBR(${JSON.stringify(ent)}) = ${r}, esperado ${esp}`);
  }

  for (const f of ['bia-atendimento', 'carlos-iniciar', 'carlos-teste']) {
    const src = fs.readFileSync(path.join(FN, f, 'index.ts'), 'utf8');
    assert.ok(!/Number\(\s*\w+\.divida\?\.(valorOriginal|totalAvista)/.test(src),
      `${f}: ainda lê divida.valorOriginal/totalAvista com Number()`);
    assert.ok(/parseValorBR\(\s*\w+\.divida\?\.valorOriginal\)/.test(src), `${f}: sem parseValorBR(valorOriginal)`);
    assert.ok(/parseValorBR\(\s*\w+\.divida\?\.totalAvista\)/.test(src), `${f}: sem parseValorBR(totalAvista)`);
  }
  const calc = fs.readFileSync(path.join(FN, '_shared', 'calc-cobranca.ts'), 'utf8');
  assert.ok(/parseValorBR\(t\?\.valor\)/.test(calc), 'calc-cobranca: títulos sem parseValorBR');

  // títulos continuam aceitando valor BR
  const { titulosValidos } = await import(path.join(FN, '_shared', 'calc-cobranca.ts'));
  const t = titulosValidos({ titulos: [{ valor: '1.924,80', vencimento: '2020-12-19' }, { valor: 100, vencimento: '2021-01-10' }] });
  assert.deepStrictEqual(t.map(x => x.valor), [1924.8, 100]);

  console.log('✓ F-46 parse de valor BR nas edge functions');
})().catch(e => { console.error('✗ F-46', e.message); process.exit(1); });
