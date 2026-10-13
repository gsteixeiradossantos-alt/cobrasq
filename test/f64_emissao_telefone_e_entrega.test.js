/*
 * Teste F-64 — o WhatsApp do boleto vai ao telefone certo e só conta como
 * enviado com o callback de entrega da Z-API.
 *
 * O caso (Taina, 07/10/2026): o cadastro tinha dois telefones no mesmo campo
 * ("46988227918, 46988261857"). api/_emitir-acordo.js limpava os dígitos ANTES
 * de chamar zapiSendText, colando os dois num número de 22 dígitos que a
 * normalização trata como id de grupo. A Z-API aceitou, devolveu messageId, o
 * acordo ficou com whatsapp_ok=true e nada foi entregue.
 *
 * Roda o handler no modo REENVIO com Supabase/Z-API mockados (sem rede) e
 * confere:
 *   1. O envio sai para o PRIMEIRO celular do cadastro, com DDI.
 *   2. Com callback em crm_mensagens_status → whatsapp_ok=true, 'confirmado'.
 *   3. Sem callback → whatsapp_ok=false, 'sem_confirmacao', e o messageId e o
 *      destino ficam gravados no acordo.
 *   4. Callback 'not_delivered' → whatsapp_ok=false.
 *
 * Como rodar:
 *   node test/f64_emissao_telefone_e_entrega.test.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const API_DIR = path.join(__dirname, '..', 'api');
const { normalizarTelefone } = require(path.join(API_DIR, '_zapi.js'));

let falhas = 0;
function checa(nome, fn) {
  try { fn(); console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}

console.log('\nF-64 · boleto no WhatsApp: telefone certo e entrega confirmada pelo callback\n');

async function rodarReenvio({ telefone, callback }) {
  const calls = { zapi: [], patches: [], eventos: [] };
  const acordo = {
    id: 'acordo-teste', devedor_id: 'dev-teste', status: 'ativo',
    metadata: { boletos_emitidos: true, asaas_invoice_url: 'https://www.asaas.com/i/fake' },
  };
  function stub(rel, exportsObj) {
    const resolved = require.resolve(path.join(API_DIR, rel));
    delete require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  }
  stub('_auth.js', { applyCors: () => {}, requireUser: async () => ({ id: 'user-teste' }) });
  stub('_data.js', { addDiasBR: () => '2099-01-01' });
  stub('_asaas.js', { ensureAsaasCustomer: async () => ({}), asaasReq: async () => ({}) });
  stub('_zapi.js', {
    normalizarTelefone,
    zapiSendText: async (tel, msg) => { calls.zapi.push({ tel, msg }); return { messageId: 'MSG-1' }; },
  });
  stub('_sb.js', {
    sbFetch: async (pq, opts) => {
      const method = (opts && opts.method) || 'GET';
      const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
      if (pq.startsWith('acordos?') && pq.includes('select=*')) return [acordo];
      if (pq.startsWith('acordos?') && method === 'PATCH') { calls.patches.push(body); return []; }
      if (pq.startsWith('devedores?')) return [{ nome: 'Taina Teste', telefone }];
      if (pq.startsWith('crm_mensagens_status')) {
        assert.ok(pq.includes('message_id=eq.MSG-1'), 'consulta o callback pelo messageId do envio');
        return callback ? [callback] : [];
      }
      if (pq.startsWith('devedor_eventos')) { calls.eventos.push(body); return []; }
      return [];
    },
  });
  const handlerPath = path.join(API_DIR, '_emitir-acordo.js');
  delete require.cache[require.resolve(handlerPath)];
  process.env.EMIT_ACORDO_SECRET = 'segredo-teste';
  const handler = require(handlerPath);
  const req = { method: 'POST', headers: { 'x-emit-secret': 'segredo-teste' }, query: {}, body: { acordo_id: acordo.id, resend: true } };
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  await handler(req, res);
  return { res, calls };
}

(async () => {
  const dois = '46988227918, 46988261857';

  const a = await rodarReenvio({ telefone: dois, callback: { status: 'sent' } });
  checa('envia ao primeiro celular do cadastro, com DDI (não aos 22 dígitos colados)', () => {
    assert.strictEqual(a.calls.zapi.length, 1);
    assert.strictEqual(a.calls.zapi[0].tel, '5546988227918');
  });
  checa('com callback: whatsapp_ok=true e situação confirmado', () => {
    const m = a.calls.patches[0].metadata;
    assert.strictEqual(m.whatsapp_ok, true);
    assert.strictEqual(m.whatsapp_situacao, 'confirmado');
    assert.strictEqual(a.res.body.reenviado, true);
    assert.strictEqual(a.calls.eventos[0].payload.message_id, 'MSG-1');
  });

  const b = await rodarReenvio({ telefone: dois, callback: null });
  checa('sem callback: whatsapp_ok=false, sem_confirmacao, com messageId e destino gravados', () => {
    const m = b.calls.patches[0].metadata;
    assert.strictEqual(m.whatsapp_ok, false);
    assert.strictEqual(m.whatsapp_situacao, 'sem_confirmacao');
    assert.strictEqual(m.whatsapp_message_id, 'MSG-1');
    assert.strictEqual(m.whatsapp_destino, '5546988227918');
    assert.strictEqual(b.res.body.reenviado, false);
  });

  const c = await rodarReenvio({ telefone: '(46) 99112-0932', callback: { status: 'not_delivered' } });
  checa('callback not_delivered: whatsapp_ok=false', () => {
    assert.strictEqual(c.calls.zapi[0].tel, '5546991120932');
    assert.strictEqual(c.calls.patches[0].metadata.whatsapp_ok, false);
    assert.strictEqual(c.calls.patches[0].metadata.whatsapp_situacao, 'nao_entregue');
  });

  const d = await rodarReenvio({ telefone: '123', callback: null });
  checa('telefone inválido: não envia nada', () => {
    assert.strictEqual(d.calls.zapi.length, 0);
    assert.strictEqual(d.res.body.reenviado, false);
  });

  console.log(falhas ? `\n${falhas} falha(s)\n` : '\ntudo ok\n');
  process.exit(falhas ? 1 : 0);
})();
