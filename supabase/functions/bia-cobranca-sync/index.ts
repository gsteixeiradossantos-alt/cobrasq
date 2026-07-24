// bia-cobranca-sync: espelha em public.bia_cobranca as cobranças que a Bia deve cobrar.
// Puxa do Asaas: (1) todas OVERDUE (vencidas) + (2) PENDING que vencem HOJE (dia do vencimento).
// Assim a cadência 'envia no dia que vence' passa a ter alvo. Só popula; envio é do bia-cobranca.
// Preserva estado/contadores de linhas existentes. Retorna só CONTAGENS (sem PII).
// Auth: exige CRON_INVOKE_SECRET se configurado; senão roda aberto (seed pontual).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
}
function normTel(raw: string): string {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  return d.startsWith('55') ? d : '55' + d;
}
function hojeSP(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get('CRON_INVOKE_SECRET');
  if (cronSecret) {
    const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (provided && provided !== cronSecret) return json({ error: 'unauthorized' }, 401);
  }

  const key = Deno.env.get('ASAAS_API_KEY');
  const env = (Deno.env.get('ASAAS_ENV') || 'production').toLowerCase();
  if (!key) return json({ error: 'sem ASAAS_API_KEY' }, 500);
  const base = env.startsWith('sand') ? 'https://sandbox.asaas.com/api/v3' : 'https://www.asaas.com/api/v3';
  const H = { 'access_token': key, 'Content-Type': 'application/json' };

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // pagina uma query de /payments (até 5000 registros)
  async function pagina(q: string): Promise<any[] | null> {
    const out: any[] = [];
    let offset = 0;
    for (let i = 0; i < 50; i++) {
      const r = await fetch(`${base}/payments?${q}&limit=100&offset=${offset}`, { headers: H });
      const j = await r.json().catch(() => null);
      if (!j || !Array.isArray(j.data)) return null;
      out.push(...j.data);
      if (!j.hasMore) break;
      offset += 100;
    }
    return out;
  }

  const hoje = hojeSP();
  // 1) vencidas + 2) a vencer HOJE (ainda PENDING)
  const overdue = await pagina('status=OVERDUE');
  if (!overdue) return json({ error: 'falha payments OVERDUE' }, 502);
  const pendHoje = await pagina(`status=PENDING&dueDate%5Bge%5D=${hoje}&dueDate%5Ble%5D=${hoje}`);
  if (!pendHoje) return json({ error: 'falha payments PENDING-hoje' }, 502);

  // dedup por id
  const mapa = new Map<string, any>();
  for (const p of [...overdue, ...pendHoje]) mapa.set(p.id, p);
  const pays = [...mapa.values()];

  // nome + telefone dos clientes (dedup)
  const ids = [...new Set(pays.map(p => p.customer).filter(Boolean))];
  const cust: Record<string, { nome: string; tel: string }> = {};
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (id) => {
      try {
        const r = await fetch(`${base}/customers/${id}`, { headers: H });
        const c = await r.json().catch(() => null);
        if (c) cust[id] = { nome: c.name || c.company || '', tel: normTel(c.mobilePhone || c.phone || '') };
      } catch { /* ignora */ }
    }));
  }

  // quais já existem (pra preservar estado)
  const payIds = pays.map(p => p.id);
  const jaExiste = new Set<string>();
  for (let i = 0; i < payIds.length; i += 100) {
    const { data } = await sb.from('bia_cobranca').select('asaas_payment_id').in('asaas_payment_id', payIds.slice(i, i + 100));
    (data || []).forEach((r: any) => jaExiste.add(r.asaas_payment_id));
  }

  const agora = new Date().toISOString();
  const novas: any[] = [], atualizadas: any[] = [];
  for (const p of pays) {
    const c = cust[p.customer] || { nome: '', tel: '' };
    if (jaExiste.has(p.id)) {
      atualizadas.push(sb.from('bia_cobranca').update({
        asaas_customer_id: p.customer, telefone: c.tel || null, nome: c.nome || null,
        valor: p.value, invoice_url: p.invoiceUrl || null, synced_em: agora, updated_at: agora,
      }).eq('asaas_payment_id', p.id));
    } else {
      novas.push({
        asaas_payment_id: p.id, asaas_customer_id: p.customer, telefone: c.tel || null, nome: c.nome || null,
        valor: p.value, venc_original: p.dueDate, venc_atual: p.dueDate, invoice_url: p.invoiceUrl || null,
        status: 'ativa', proximo_lembrete_em: agora, synced_em: agora,
      });
    }
  }
  if (novas.length) await sb.from('bia_cobranca').insert(novas);
  for (let i = 0; i < atualizadas.length; i += 10) await Promise.all(atualizadas.slice(i, i + 10));

  return json({
    ambiente: env, hoje,
    overdue_no_asaas: overdue.length, pending_hoje_no_asaas: pendHoje.length,
    total_alvo: pays.length, novas: novas.length, atualizadas: atualizadas.length,
  });
});
