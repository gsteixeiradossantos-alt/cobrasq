// bia-cobranca-sync: espelha em public.bia_cobranca as cobranças que a Bia deve cobrar.
// Puxa do Asaas: (1) todas OVERDUE (vencidas) + (2) PENDING que vencem HOJE (dia do vencimento).
// Assim a cadência 'envia no dia que vence' passa a ter alvo. Só popula; envio é do bia-cobranca.
// Preserva estado/contadores de linhas existentes. Retorna só CONTAGENS (sem PII).
// Auth: EXIGE CRON_INVOKE_SECRET, sempre. Ver o bloco de autenticação abaixo.
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

// Comparação em tempo constante — mesmo padrão do asaas-webhook/zapsign-webhook.
// Hashar antes normaliza o tamanho e não vaza o comprimento do segredo.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  // ENDPOINT ABERTO até 31/08/2026. O código era:
  //
  //   if (cronSecret) {
  //     const provided = (headers.authorization || '').replace(/^Bearer\s+/i, '');
  //     if (provided && provided !== cronSecret) return 401;
  //   }
  //
  // Sem header nenhum, `provided` é string vazia, o `&&` curto-circuita e a função
  // SEGUIA. A trava barrava quem chutava errado e deixava passar quem não mandava
  // nada — e esta função escreve em bia_cobranca (insert, update, cancelamento).
  // Com verify_jwt=false, o gateway também não segurava: bastava a URL, que é
  // derivável do ref do projeto. Confirmado com um POST sem header: HTTP 200 e 29
  // linhas sincronizadas.
  //
  // Agora falha FECHADO: sem segredo configurado no servidor, recusa em vez de
  // rodar aberto — endpoint que escreve não tem "modo seed pontual".
  const cronSecret = Deno.env.get('CRON_INVOKE_SECRET');
  if (!cronSecret) return json({ error: 'CRON_INVOKE_SECRET não configurado no servidor.' }, 500);
  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!provided || !(await safeEqual(provided, cronSecret))) {
    return json({ error: 'unauthorized' }, 401);
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
  // Janela do AVISO PRÉVIO. Até 21/08/2026 o sync só puxava vencidas e as que venciam
  // HOJE — então o devedor nunca era avisado ANTES de vencer, e as notificações
  // nativas do Asaas estão desligadas de propósito (api/_asaas.js cria todo customer
  // com notificationDisabled: true). Resultado: zero canal de aviso prévio.
  // Agora puxamos também as PENDING que vencem nos próximos N dias.
  const avisoDias = Math.max(0, Number(Deno.env.get('AVISO_PREVIO_DIAS') ?? 3));
  const ateAviso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
    .format(new Date(Date.now() + avisoDias * 864e5));

  // 1) vencidas + 2) a vencer de hoje até hoje+N (ainda PENDING)
  const overdue = await pagina('status=OVERDUE');
  if (!overdue) return json({ error: 'falha payments OVERDUE' }, 502);
  const pendHoje = await pagina(`status=PENDING&dueDate%5Bge%5D=${hoje}&dueDate%5Ble%5D=${ateAviso}`);
  if (!pendHoje) return json({ error: 'falha payments PENDING-hoje' }, 502);

  // dedup por id; separa deletados (Asaas retorna OVERDUE mesmo com deleted=true)
  const mapa = new Map<string, any>();
  const deletados: string[] = [];
  for (const p of [...overdue, ...pendHoje]) {
    if (p.deleted === true) { deletados.push(p.id); continue; }
    mapa.set(p.id, p);
  }
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
      // Boleto que ainda não venceu entra agendado para o dia do AVISO (D-N às 9h BRT),
      // não para agora — senão o devedor receberia o aviso no instante em que o boleto
      // é emitido. Vencido/vencendo hoje segue imediato, como antes.
      const aVencer = String(p.dueDate || '') > hoje;
      const diaAviso = aVencer
        ? new Date(Date.parse(p.dueDate + 'T12:00:00Z') - avisoDias * 864e5).toISOString()
        : agora;
      novas.push({
        asaas_payment_id: p.id, asaas_customer_id: p.customer, telefone: c.tel || null, nome: c.nome || null,
        valor: p.value, venc_original: p.dueDate, venc_atual: p.dueDate, invoice_url: p.invoiceUrl || null,
        status: 'ativa', proximo_lembrete_em: diaAviso, synced_em: agora,
      });
    }
  }
  if (novas.length) await sb.from('bia_cobranca').insert(novas);
  for (let i = 0; i < atualizadas.length; i += 10) await Promise.all(atualizadas.slice(i, i + 10));

  // marca como cancelada boletos que foram deletados no Asaas mas ainda estão ativos localmente
  let canceladas = 0;
  if (deletados.length) {
    for (let i = 0; i < deletados.length; i += 50) {
      const { data } = await sb.from('bia_cobranca')
        .update({ status: 'cancelada', observacao: 'boleto deletado no Asaas (sync)', updated_at: agora })
        .in('asaas_payment_id', deletados.slice(i, i + 50))
        .in('status', ['ativa', 'adiada'])
        .select('asaas_payment_id');
      canceladas += (data || []).length;
    }
  }

  return json({
    ambiente: env, hoje,
    overdue_no_asaas: overdue.length, pending_hoje_no_asaas: pendHoje.length,
    deletados_no_asaas: deletados.length, canceladas_localmente: canceladas,
    total_alvo: pays.length, novas: novas.length, atualizadas: atualizadas.length,
  });
});
