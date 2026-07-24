import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ASAAS_KEY = Deno.env.get('ASAAS_API_KEY') || '';
const ASAAS_ENV = Deno.env.get('ASAAS_ENV') || 'production';
const BASE = ASAAS_ENV === 'production'
  ? 'https://www.asaas.com/api/v3'
  : 'https://sandbox.asaas.com/api/v3';
const SECRET = Deno.env.get('EMIT_ACORDO_SECRET') || '';

async function asaas(method: string, path: string, data?: unknown) {
  const opts: RequestInit = {
    method,
    headers: { 'access_token': ASAAS_KEY, 'Content-Type': 'application/json', 'User-Agent': 'COBRASQ-EdgeFn/1.0' },
  };
  if (data && !['GET','DELETE','HEAD'].includes(method)) opts.body = JSON.stringify(data);
  const r = await fetch(`${BASE}/${path.replace(/^\/+/,'')}`, opts);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(json?.errors?.[0]?.description || json?.message || `Asaas ${r.status}`);
  return json;
}

async function ensureCustomer(nome: string, cpf: string, tel?: string, email?: string) {
  const doc = cpf.replace(/\D/g, '');
  const found = await asaas('GET', `/customers?cpfCnpj=${encodeURIComponent(doc)}`);
  if (found?.data?.length) return { id: found.data[0].id, created: false };
  const c = await asaas('POST', '/customers', {
    name: nome, cpfCnpj: doc, notificationDisabled: true,
    ...(tel ? { mobilePhone: tel.replace(/\D/g, '') } : {}),
    ...(email ? { email } : {}),
  });
  return { id: c.id, created: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
  if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });

  const token = req.headers.get('x-emit-secret') || new URL(req.url).searchParams.get('token') || '';
  if (!SECRET || !token || token !== SECRET) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!ASAAS_KEY) return Response.json({ error: 'ASAAS_API_KEY nao configurada nos secrets do Supabase' }, { status: 500 });

  const body = await req.json();
  const devedores = body.devedores || [];
  const firstDue = body.first_due || '2026-08-15';
  const results = [];

  for (const d of devedores) {
    try {
      const cust = await ensureCustomer(d.nome, d.cpf, d.telefone, d.email);
      const total = d.parcelas * d.valor_parcela;
      const pay: Record<string, unknown> = {
        customer: cust.id,
        billingType: 'BOLETO',
        dueDate: firstDue,
        description: `Acordo ${d.nome} — ${d.parcelas}x (proc. 0000701-23)`,
        externalReference: d.external_ref || 'acordo-0000701-23-split',
        fine: { value: 2 },
        interest: { value: 1 },
      };
      if (d.parcelas > 1) { pay.installmentCount = d.parcelas; pay.totalValue = Math.round(total * 100) / 100; }
      else { pay.value = Math.round(total * 100) / 100; }
      const charge = await asaas('POST', '/payments', pay);
      results.push({
        nome: d.nome, ok: true, customer_id: cust.id, customer_created: cust.created,
        charge_id: charge.id, installment_id: charge.installment || null,
        invoice_url: charge.invoiceUrl || charge.bankSlipUrl || '',
        parcelas: d.parcelas, valor_parcela: d.valor_parcela, total,
      });
    } catch (e) {
      results.push({ nome: d.nome, ok: false, error: String((e as Error)?.message || e) });
    }
  }
  return Response.json({ ok: true, env: ASAAS_ENV, results });
});
