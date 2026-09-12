/*
 * Teste F-35 — a busca "CPF/nome → empresas" não responde "nenhuma" com a base vazia.
 *
 * O caso (12/09/2026): rf_socios nasceu vazia em 27/07 e a carga nunca rodou; a RPC
 * devolvia [] e o botão "Verificar sócios" dizia "Nenhuma empresa encontrada" — falso
 * negativo silencioso (caso Jessica). Agora api/_cnpja.js consulta rf_base_status()
 * antes e, com base vazia, cai no fallback (pendente + link manual). Com base carregada,
 * devolve as empresas E os cruzamentos por telefone/endereço/e-mail.
 *
 * Como rodar: node test/f35_cnpja_base_vazia.test.js
 */
'use strict';
const path = require('path');
const assert = require('assert');
let falhas = 0;
function checa(nome, fn) { try { fn(); console.log('  ok   ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); } }
console.log('\nF-35 · busca por sócio com base vazia vira "indisponível", não "nenhuma"\n');
const API_DIR = path.join(__dirname, '..', 'api');
function stub(rel, exportsObj) {
  const resolved = require.resolve(path.join(API_DIR, rel));
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
async function rodar(body, sbImpl) {
  const calls = [];
  stub('_auth.js', { applyCors: () => {}, requireUser: async () => ({ id: 'u' }) });
  stub('_sb.js', { sbFetch: async (p, o) => { calls.push(p); return sbImpl(p, o); } });
  delete process.env.CNPJA_TOKEN;
  const hp = path.join(API_DIR, '_cnpja.js'); delete require.cache[require.resolve(hp)];
  const handler = require(hp);
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
  await handler({ method: 'POST', headers: {}, query: {}, body }, res);
  return { res, calls };
}
(async () => {
  // 1. base vazia
  const r1 = await rodar({ nome: 'Fulana de Tal', cpf: '09113369903' }, async (p) => {
    if (p.startsWith('rpc/rf_base_status')) return [{ socios: 0, estabelecimentos: 0, ufs: [], atualizado_em: null }];
    if (p.startsWith('rpc/buscar_empresas_por_socio')) return [];
    return [];
  });
  checa('base vazia → pendente (não "ok, 0 empresas") e não consulta a RPC de sócio', () => {
    assert.strictEqual(r1.res.statusCode, 200);
    assert.strictEqual(r1.res.body.pendente, true, JSON.stringify(r1.res.body));
    assert.ok(/base da Receita ainda não carregada/i.test(r1.res.body.motivo), r1.res.body.motivo);
    assert.ok(!r1.calls.some((c) => c.startsWith('rpc/buscar_empresas_por_socio')));
    assert.ok(/casadosdados/.test(r1.res.body.fallbackUrl));
  });
  // 2. rf_base_status inexistente (migração não aplicada) → também pendente
  const r2 = await rodar({ nome: 'Fulana de Tal', cpf: '09113369903' }, async (p) => {
    if (p.startsWith('rpc/rf_base_status')) throw new Error('Supabase rpc/rf_base_status: 404');
    return [];
  });
  checa('sem rf_base_status (migração não aplicada) → pendente, sem quebrar', () => {
    assert.strictEqual(r2.res.statusCode, 200);
    assert.strictEqual(r2.res.body.pendente, true);
  });
  // 3. base carregada: empresas + cruzamentos
  const r3 = await rodar({ nome: 'Fulana de Tal', cpf: '09113369903', telefone: '(46) 99934-6111', email: 'x@y.com', endereco: { cep: '85660-000', numero: '380', logradouro: 'Av. Rio Grande do Sul' } }, async (p, o) => {
    const b = o && o.body ? JSON.parse(o.body) : {};
    if (p.startsWith('rpc/rf_base_status')) return [{ socios: 1500000, estabelecimentos: 3000000, ufs: ['PR', 'RS', 'SC'], atualizado_em: '2026-08-01' }];
    if (p.startsWith('rpc/buscar_empresas_por_socio')) { assert.strictEqual(b.p_cpf, '09113369903'); return [{ cnpj: '12345678000199', nome: 'FULANA LTDA', papel: '49', situacao: '02', confere: true }]; }
    if (p.startsWith('rpc/buscar_empresas_por_telefone')) { assert.strictEqual(b.p_tel, '46999346111'); return [{ cnpj: '11111111000111', nome: 'A', fantasia: '', situacao: '08', uf: 'PR', compartilhado_com: 1 }]; }
    if (p.startsWith('rpc/buscar_empresas_por_endereco')) { assert.strictEqual(b.p_cep, '85660000'); return [{ cnpj: '22222222000122', nome: 'B', fantasia: '', situacao: '02', logradouro: 'AVENIDA RIO GRANDE DO SUL', numero: '380', complemento: 'SALA 1', uf: 'PR' }]; }
    if (p.startsWith('rpc/buscar_empresas_por_email')) return [];
    return [];
  });
  checa('base carregada → empresas confirmadas + por_telefone + por_endereco + por_email + info da base', () => {
    assert.strictEqual(r3.res.statusCode, 200, JSON.stringify(r3.res.body));
    assert.strictEqual(r3.res.body.ok, true);
    assert.strictEqual(r3.res.body.empresas.length, 1);
    assert.strictEqual(r3.res.body.empresas[0].confere, true);
    assert.strictEqual(r3.res.body.por_telefone.length, 1);
    assert.strictEqual(r3.res.body.por_telefone[0].compartilhado_com, 1);
    assert.strictEqual(r3.res.body.por_endereco[0].cnpj, '22222222000122');
    assert.deepStrictEqual(r3.res.body.por_email, []);
    assert.deepStrictEqual(r3.res.body.base.ufs, ['PR', 'RS', 'SC']);
  });
  // 4. cruzamento falhando não derruba a resposta principal
  const r4 = await rodar({ nome: 'Fulana de Tal', cpf: '09113369903', telefone: '46999346111' }, async (p) => {
    if (p.startsWith('rpc/rf_base_status')) return [{ socios: 10, estabelecimentos: 10, ufs: ['PR'], atualizado_em: null }];
    if (p.startsWith('rpc/buscar_empresas_por_socio')) return [];
    if (p.startsWith('rpc/buscar_empresas_por_telefone')) throw new Error('boom');
    return [];
  });
  checa('falha no cruzamento por telefone não derruba a resposta (empresas=[] com ok:true)', () => {
    assert.strictEqual(r4.res.statusCode, 200);
    assert.strictEqual(r4.res.body.ok, true);
    assert.deepStrictEqual(r4.res.body.empresas, []);
    assert.strictEqual(r4.res.body.por_telefone, undefined);
  });
  console.log(falhas ? `\nF-35 FALHOU — ${falhas} checagem(ns).\n` : '\nF-35 ok — base vazia avisa; base carregada cruza telefone/endereço/e-mail.\n');
  process.exitCode = falhas ? 1 : 0;
})();
