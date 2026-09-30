// F-57: avisos de boleto da Bia em dia útil (3 dias antes, véspera e dia).
// Regra do Gustavo, 30/09/2026: vence segunda -> sexta e segunda; vence
// sábado/domingo -> sexta e segunda (boleto prorroga); vence em feriado -> dia
// útil anterior e o dia útil posterior (que passa a ser o vencimento).
// Caso real: Elisandra (vencimento mudado de 30/09 para 10/10 no Asaas) levou o
// aviso "vence em 10 dias" na data antiga — agora só reagenda.
const path = require('path');
const assert = require('assert');

const FN = path.join(__dirname, '..', 'supabase', 'functions');

(async () => {
  const U = await import(path.join(FN, '_shared', 'dias-uteis.ts'));

  // feriados nacionais = BrasilAPI (consultada em 30/09/2026), sem a Páscoa (domingo)
  const brasilapi = {
    2026: ['2026-01-01', '2026-02-16', '2026-02-17', '2026-04-03', '2026-04-21', '2026-05-01', '2026-06-04', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25'],
    2027: ['2027-01-01', '2027-02-08', '2027-02-09', '2027-03-26', '2027-04-21', '2027-05-01', '2027-05-27', '2027-09-07', '2027-10-12', '2027-11-02', '2027-11-15', '2027-11-20', '2027-12-25'],
  };
  for (const [ano, lista] of Object.entries(brasilapi)) {
    assert.deepStrictEqual([...U.feriadosNacionais(Number(ano))].sort(), lista.sort(), `feriados ${ano}`);
  }

  const ag = (v) => U.agendaAvisos(v);
  // vence quinta 22/10/2026: segunda 19 (3 antes), quarta 21 (véspera), quinta 22
  assert.deepStrictEqual(ag('2026-10-22'), { vencEf: '2026-10-22', vespera: '2026-10-21', antecipado: '2026-10-19' });
  // vence quinta 15/10: 3 antes cai no feriado de 12/10 -> sexta 09
  assert.deepStrictEqual(ag('2026-10-15'), { vencEf: '2026-10-15', vespera: '2026-10-14', antecipado: '2026-10-09' });
  // vence segunda 19/10: 3 antes = sexta 16 = véspera -> um aviso só, na sexta
  assert.deepStrictEqual(ag('2026-10-19'), { vencEf: '2026-10-19', vespera: '2026-10-16', antecipado: null });
  // vence sábado 10/10 -> prorroga: 12/10 é feriado (Aparecida) -> terça 13; véspera sexta 09
  assert.deepStrictEqual(ag('2026-10-10'), { vencEf: '2026-10-13', vespera: '2026-10-09', antecipado: null });
  // vence domingo 25/10 -> segunda 26; véspera sexta 23; 3 antes (quinta 22... corrido 23) = sexta 23 = véspera
  assert.deepStrictEqual(ag('2026-10-25'), { vencEf: '2026-10-26', vespera: '2026-10-23', antecipado: null });
  // vence feriado sexta 20/11 -> segunda 23; véspera quinta 19; 3 antes = sexta 20 feriado -> quinta 19 = véspera
  assert.deepStrictEqual(ag('2026-11-20'), { vencEf: '2026-11-23', vespera: '2026-11-19', antecipado: null });
  // vence quarta 04/11: véspera terça 03; 3 antes = domingo 01 -> sexta 30/10
  assert.deepStrictEqual(ag('2026-11-04'), { vencEf: '2026-11-04', vespera: '2026-11-03', antecipado: '2026-10-30' });

  // etapas no tempo (vence quinta 22/10/2026)
  const et = (h) => U.etapaPreVencimento('2026-10-22', h);
  assert.deepStrictEqual(et('2026-10-01'), { etapa: 'aguardar', proximo: '2026-10-19' });
  assert.deepStrictEqual(et('2026-10-19'), { etapa: 'antecipado', proximo: '2026-10-21' });
  assert.deepStrictEqual(et('2026-10-20'), { etapa: 'antecipado', proximo: '2026-10-21' });
  assert.deepStrictEqual(et('2026-10-21'), { etapa: 'vespera', proximo: '2026-10-22' });
  assert.deepStrictEqual(et('2026-10-22'), { etapa: 'dia', proximo: '2026-10-23' });
  assert.deepStrictEqual(et('2026-10-23'), { etapa: 'vencido' });
  // Elisandra: vencimento novo 10/10/2026, claim disparou em 30/09 -> não envia
  assert.deepStrictEqual(U.etapaPreVencimento('2026-10-10', '2026-09-30'), { etapa: 'aguardar', proximo: '2026-10-09' });
  // boleto de sábado: no próprio sábado ainda não venceu (vence de fato terça 13)
  assert.deepStrictEqual(U.etapaPreVencimento('2026-10-10', '2026-10-10'), { etapa: 'vespera', proximo: '2026-10-13' });
  // dia do vencimento numa sexta -> próximo passo é segunda
  assert.deepStrictEqual(U.etapaPreVencimento('2026-10-16', '2026-10-16'), { etapa: 'dia', proximo: '2026-10-19' });

  assert.strictEqual(U.noveHorasBRT('2026-10-14'), '2026-10-14T12:00:00.000Z');
  // textos (sem chamar ninguém de inadimplente antes do vencimento)
  const T = await import(path.join(FN, '_shared', 'bia-avisos.ts'));
  const base = { sig: '*Bia • COBRASQ*', nome: 'Elisandra Fatima Taques', valor: 206, url: 'https://x/i/1', jaCobrado: false };
  const txt = (o) => T.textosPreVencimento({ ...base, ...o }).join(' | ');
  const t1 = txt({ etapa: 'antecipado', venc: '2026-10-22', vencEf: '2026-10-22', hoje: '2026-10-19' });
  assert.ok(t1.startsWith('*Bia • COBRASQ*\nOi Elisandra, tudo bem?'), t1);
  assert.ok(t1.includes('R$ 206,00 vence na quinta-feira, dia 22/10'), t1);
  assert.ok(txt({ etapa: 'vespera', venc: '2026-10-22', vencEf: '2026-10-22', hoje: '2026-10-21' }).includes('vence amanhã, dia 22/10'));
  assert.ok(txt({ etapa: 'vespera', venc: '2026-10-25', vencEf: '2026-10-26', hoje: '2026-10-23' }).includes('vence na segunda-feira, dia 26/10'));
  assert.ok(txt({ etapa: 'dia', venc: '2026-10-22', vencEf: '2026-10-22', hoje: '2026-10-22' }).includes('vence hoje'));
  assert.ok(txt({ etapa: 'dia', venc: '2026-10-25', vencEf: '2026-10-26', hoje: '2026-10-26' }).includes('venceu no domingo (25/10), que não foi dia útil'));
  const tj = txt({ etapa: 'antecipado', venc: '2026-12-09', vencEf: '2026-12-09', hoje: '2026-12-04', jaCobrado: true });
  assert.ok(tj.includes('novo vencimento') && tj.includes('na quarta-feira, dia 09/12'), tj);
  for (const t of [t1, tj]) assert.ok(!/negativa|protesto|atraso|em aberto/i.test(t), t);

  console.log('F-57 ok');
})().catch((e) => { console.error(e); process.exit(1); });
