/*
 * Teste F-58 — perfil colaborador blindado (28/09/2026, antes do login da estagiária).
 *
 *   1) api/_papel.js: colaborador leva 403 no Asaas/Z-API; proprietário/cedente seguem;
 *      falha ao ler app_users = 503 (fail-closed).
 *   2) index.html: WhatsApp é página só do gestor; abas Pendentes/Conversas saíram;
 *      integOn desliga tudo menos ZapSign para o colaborador.
 *   3) migração 09: nenhuma policy "staff_all" sobrevive nas tabelas de WhatsApp.
 *
 * Como rodar:
 *   node test/f58_colaborador_seguro.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');

function resFalso() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

function carregarPapel(sbFetch) {
  const sbPath = require.resolve(path.join(raiz, 'api', '_sb.js'));
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { sbFetch } };
  const p = require.resolve(path.join(raiz, 'api', '_papel.js'));
  delete require.cache[p];
  return require(p);
}

(async () => {
  // 1) _papel.js
  for (const [papel, esperado, code] of [['colaborador', false, 403], ['proprietario', true, 200], ['cedente', true, 200], ['devedor', true, 200]]) {
    const { bloquearColaborador } = carregarPapel(async () => [{ papel }]);
    const res = resFalso();
    const ok = await bloquearColaborador({ id: 'u1' }, res, 'Asaas (boletos)');
    assert.strictEqual(ok, esperado, `papel ${papel}`);
    assert.strictEqual(res.code, code, `status ${papel}`);
  }
  {
    const { bloquearColaborador } = carregarPapel(async () => { throw new Error('rede'); });
    const res = resFalso();
    assert.strictEqual(await bloquearColaborador({ id: 'u1' }, res, 'X'), false);
    assert.strictEqual(res.code, 503);
  }
  for (const f of ['asaas.js', 'zapi.js']) {
    const src = fs.readFileSync(path.join(raiz, 'api', f), 'utf8');
    assert.ok(/await bloquearColaborador\(user, res,/.test(src), `${f} chama bloquearColaborador`);
  }
  const claude = fs.readFileSync(path.join(raiz, 'api', 'claude.js'), 'utf8');
  assert.ok(!/LIMITE_COLABORADOR/.test(claude), 'limite vem de app_users.ia_limite_dia, não de env');
  assert.ok(/ia_limite_dia/.test(claude));

  // 2) index.html
  const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
  const admin = html.match(/const ADMIN_ONLY_PAGES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(admin && /'wa'/.test(admin[1]), "'wa' em ADMIN_ONLY_PAGES");
  assert.ok(!/setWATab\('pendentes'/.test(html), 'aba Pendentes removida');
  assert.ok(!/setWATab\('conversas'/.test(html), 'aba Conversas removida');
  assert.ok(!/setTimeout\(\(\)=>setWATab/.test(html), 'Ver lembretes/avisos abre Agendados direto');

  const m = html.match(/function integOn\(nome\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'integOn encontrado');
  const integOn = new Function('DB', 'currentUser', `${m[0]}; return integOn;`);
  const DB = { config: { integ: { asaas: true, zapsign: true, zapi: true } } };
  const colab = integOn(DB, { papel: 'colaborador' });
  assert.strictEqual(!!colab('asaas'), false);
  assert.strictEqual(!!colab('zapi'), false);
  assert.strictEqual(!!colab('zapsign'), true);
  const dono = integOn(DB, { papel: 'proprietario' });
  assert.strictEqual(!!dono('asaas'), true);
  assert.strictEqual(!!dono('zapi'), true);

  // 3) migração 09
  const mig = fs.readFileSync(path.join(raiz, 'supabase', 'migrations', '20260928_09_colaborador_whatsapp_e_exclusoes.sql'), 'utf8');
  assert.ok(!/create policy \w*staff_all/.test(mig), 'nenhuma staff_all recriada');
  for (const t of ['crm_mensagens_recebidas', 'crm_mensagens_status', 'crm_mensagens_enviadas', 'whatsapp_atendimentos']) {
    assert.ok(new RegExp(`on public\\.${t}\\s+for select to authenticated using \\(public\\.colab_cobranca_ok\\(caso_id\\)\\)`).test(mig), `${t} escopado por caso`);
  }
  assert.ok(fs.existsSync(path.join(raiz, 'supabase', 'migrations', '20260928_09_colaborador_whatsapp_e_exclusoes_rollback.sql')));

  console.log('f58_colaborador_seguro: ok');
})().catch((e) => { console.error(e); process.exit(1); });
