// bia-cobranca: worker de COBRANÇA ATIVA (saída). Cron a cada poucos minutos.
// Dirige a régua de lembretes das cobranças vencidas espelhadas em bia_cobranca.
// NÃO responde conversa (isso é do bia-atendimento) — só INICIA/insiste a cobrança.
//
// Segurança: só age se whatsapp_bia_config.cobranca_ativa=true. Se
// cobranca_teste_telefone estiver setado, age SÓ nesse número. Cede a vez ao
// humano/negociação viva. Valida WhatsApp e horário comercial antes de mandar.
// Auth: Authorization: Bearer <CRON_INVOKE_SECRET>.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SIG = '*Bia • COBRASQ*';
const MAX_POR_RUN = 5; // cada contato envia vários blocos; menos contatos por run p/ não estourar o cron

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
}
function brDate(d: string | null): string {
  if (!d) return '';
  const [y, m, dd] = String(d).split('-');
  return dd && m && y ? `${dd}/${m}/${y}` : String(d);
}
function brMoney(v: any): string {
  const n = Number(v) || 0;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// data de hoje em São Paulo, 'YYYY-MM-DD'
function hojeSP(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// data (YYYY-MM-DD, SP) de um timestamp qualquer
function spDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
}
// horário comercial em São Paulo: seg-sex, 09:00–17:59 (via Intl parts — robusto)
function horarioComercial(): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date());
  const wd = parts.find(p => p.type === 'weekday')?.value || '';
  let h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  if (h === 24) h = 0;
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd) && h >= 9 && h < 18;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_INVOKE_SECRET');
  if (!secret) return json({ error: 'CRON_INVOKE_SECRET ausente' }, 500);
  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided !== secret) return json({ error: 'unauthorized' }, 401);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: cfg } = await sb.from('whatsapp_bia_config').select('*').eq('id', 1).maybeSingle();
  if (!cfg) return json({ ok: true, skipped: 'sem config' });
  const diaMax = cfg.cobranca_dia_max ?? 15;
  const testeTel = String(cfg.cobranca_teste_telefone || '').replace(/\D/g, '');

  const ZI = Deno.env.get('ZAPI_INSTANCE'); const ZT = Deno.env.get('ZAPI_TOKEN'); const ZCT = Deno.env.get('ZAPI_CLIENT_TOKEN');
  const AK = Deno.env.get('ASAAS_API_KEY'); const AENV = (Deno.env.get('ASAAS_ENV') || 'production').toLowerCase();
  if (!ZI || !ZT || !AK) return json({ error: 'faltam secrets ZAPI/ASAAS' }, 500);
  const zHead: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ZCT) zHead['Client-Token'] = ZCT;
  const zBase = `https://api.z-api.io/instances/${ZI}/token/${ZT}`;
  const aBase = AENV.startsWith('sand') ? 'https://sandbox.asaas.com/api/v3' : 'https://www.asaas.com/api/v3';
  const aHead = { 'access_token': AK, 'Content-Type': 'application/json' };

  const grupoTel = String(cfg.grupo_empresa_tel || '').trim();
  let adminTel = '';
  try { const { data: blob } = await sb.from('cobrasq_data').select('data').eq('key', 'main').maybeSingle(); adminTel = String(blob?.data?.config?.adminTel || '').replace(/\D/g, ''); } catch { /* */ }
  if (adminTel && !adminTel.startsWith('55') && adminTel.length <= 11) adminTel = '55' + adminTel;
  async function notificar(texto: string) {
    for (const dest of [adminTel, grupoTel]) {
      if (!dest) continue;
      try { await fetch(`${zBase}/send-text`, { method: 'POST', headers: zHead, body: JSON.stringify({ phone: dest, message: texto }) }); } catch { /* */ }
    }
  }
  async function enviarTexto(tel: string, msg: string) {
    try { await fetch(`${zBase}/send-text`, { method: 'POST', headers: zHead, body: JSON.stringify({ phone: tel, message: msg.slice(0, 4000) }) }); } catch { /* */ }
  }
  // envia uma mensagem em BLOCOS (várias mensagens curtas) e registra status/enviadas por bloco
  async function enviarBlocos(tel: string, blocos: string[]): Promise<{ ok: boolean; outId: string }> {
    let ok = false, outId = '';
    for (const bloco of blocos) {
      try {
        const e = await fetch(`${zBase}/send-text`, { method: 'POST', headers: zHead, body: JSON.stringify({ phone: tel, message: bloco.slice(0, 4000) }) });
        const ej = await e.json().catch(() => null);
        if (e.ok && ej && !ej.error && (ej.messageId || ej.id || ej.zaapId)) {
          ok = true;
          const oid = String(ej.messageId || ej.id || ej.zaapId);
          if (!outId) outId = oid;
          await sb.from('crm_mensagens_status').upsert({ message_id: oid, telefone_enviado: tel, status: 'sent', evento_em: new Date().toISOString(), raw_payload: { via: 'bia-cobranca' } }, { onConflict: 'message_id' });
          try { await sb.from('whatsapp_bia_enviadas').upsert({ message_id: oid, telefone: tel }, { onConflict: 'message_id' }); } catch { /* */ }
        }
      } catch { /* */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ok, outId };
  }
  async function whatsappExiste(tel: string): Promise<boolean> {
    try {
      const r = await fetch(`${zBase}/phone-exists/${tel}`, { headers: zHead });
      const j = await r.json().catch(() => null);
      if (j && typeof j.exists === 'boolean') return j.exists;
    } catch { /* */ }
    return true; // fail-open: é o celular cadastrado no Asaas
  }
  async function alterarVenc(paymentId: string, novaISO: string, novoValor?: number | null, descricao?: string): Promise<{ ok: boolean; erro?: string; invoiceUrl?: string; value?: number }> {
    try {
      const body: any = { dueDate: novaISO };
      if (descricao) body.description = descricao;
      if (novoValor != null && novoValor > 0) { body.value = novoValor; body.fine = { value: 0 }; } // +11% embutido + zera multa 10%
      const r = await fetch(`${aBase}/payments/${paymentId}`, { method: 'PUT', headers: aHead, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && String(j.dueDate) === novaISO) return { ok: true, invoiceUrl: j.invoiceUrl, value: Number(j.value) };
      return { ok: false, erro: j?.errors?.[0]?.description || ('status ' + r.status) };
    } catch (e) { return { ok: false, erro: e instanceof Error ? e.message : String(e) }; }
  }
  const brD = (d: any) => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';

  // ===== EXECUTOR DE APROVAÇÕES (roda SEMPRE, mesmo com a cobrança desligada) =====
  // Pega decisões (WhatsApp ou painel) e aplica: aprovada -> muda venc no Asaas + avisa devedor.
  try {
    const { data: decididas } = await sb.from('bia_aprovacoes').select('*').in('status', ['aprovada', 'negada']).is('resultado', null).limit(10);
    for (const ap of (decididas || [])) {
      const tel = String(ap.telefone || '').replace(/\D/g, '');
      const dataISO = String(ap.data_pedida || '').slice(0, 10);
      // VENCIMENTO RECORRENTE: aprovar move TODOS os boletos A VENCER (PENDING) pro dia dd
      // do mês de cada um (sem 11%: não é atraso, é alinhamento da data combinada).
      if (ap.tipo === 'data_recorrente') {
        const dd = String(dataISO).slice(8, 10); // '24'
        if (ap.status === 'aprovada') {
          let cid = '';
          try { const { data: cr } = await sb.from('bia_cobranca').select('asaas_customer_id').eq('asaas_payment_id', ap.asaas_payment_id).maybeSingle(); cid = cr?.asaas_customer_id || ''; } catch { /* */ }
          if (!cid) { try { const r = await fetch(`${aBase}/payments/${ap.asaas_payment_id}`, { headers: aHead }); const p = await r.json().catch(() => null); cid = p?.customer || ''; } catch { /* */ } }
          const novasDatas: string[] = [];
          if (cid) {
            try {
              const r = await fetch(`${aBase}/payments?customer=${cid}&status=PENDING&limit=100`, { headers: aHead });
              const d = await r.json().catch(() => null);
              const semAcresc = ap.sem_acrescimo === true;
              for (const p of (d?.data || [])) {
                const due = String(p.dueDate || '').slice(0, 10);
                if (!due) continue;
                const nova = due.slice(0, 8) + dd; // YYYY-MM-24
                if (nova === due) { novasDatas.push(brD(due)); continue; } // já no dia certo
                // alteração de vencimento a pedido -> +11% e zera multa (salvo override do gestor)
                const novoV = semAcresc ? null : Math.round(Number(p.value || 0) * 1.11 * 100) / 100;
                const rr = await alterarVenc(String(p.id), nova, novoV, `Vencimento recorrente no dia ${dd} (mediante pedido)`);
                if (rr.ok) { novasDatas.push(brD(nova)); await sb.from('bia_cobranca').update({ venc_atual: nova, valor: rr.value ?? novoV ?? p.value }).eq('asaas_payment_id', String(p.id)); }
              }
            } catch { /* */ }
          }
          const acr = ap.sem_acrescimo === true ? '' : ' (com o acréscimo de 11% por alteração a pedido)';
          const lista = novasDatas.length ? ` Seus próximos vencimentos ficaram: ${[...new Set(novasDatas)].sort().join(', ')}${acr}.` : '';
          if (tel) await enviarTexto(tel, `${SIG}\nConfirmado! A partir de agora seu vencimento fica sempre no dia ${dd}.${lista} Qualquer coisa, é só me chamar.`);
          await sb.from('bia_aprovacoes').update({ status: 'aplicada', resultado: `ok (recorrente; ${novasDatas.length} boletos no dia ${dd})` }).eq('id', ap.id);
        } else {
          if (tel) await enviarTexto(tel, `${SIG}\nSobre deixar o vencimento fixo todo dia ${dd}, não consegui liberar dessa vez. Mas seguimos te ajudando a cada mês, tá?`);
          await sb.from('bia_aprovacoes').update({ resultado: 'avisado (recorrente negada)' }).eq('id', ap.id);
        }
        continue;
      }
      if (ap.status === 'aprovada') {
        // regra de contrato: pagamento após o venc original -> +11% no valor e zera multa de 10%
        const { data: cRow } = await sb.from('bia_cobranca').select('valor, venc_original, invoice_url, adiamentos, asaas_customer_id').eq('asaas_payment_id', ap.asaas_payment_id).maybeSingle();
        const vencOrig = String(cRow?.venc_original || '').slice(0, 10);
        const aposVenc = !!vencOrig && dataISO > vencOrig;
        const semAcresc = ap.sem_acrescimo === true;                     // gestor mandou não adicionar?
        const novoValor = (aposVenc && !semAcresc) ? Math.round(Number(cRow?.valor || 0) * 1.11 * 100) / 100 : null;
        const descricao = `Vencimento original em ${brD(vencOrig)} - alterado mediante pedido em ${brD(hojeSP())}`;
        const alt = await alterarVenc(ap.asaas_payment_id, dataISO, novoValor, descricao);
        if (alt.ok) {
          const valorFinal = alt.value ?? novoValor ?? Number(cRow?.valor || 0);
          const linkAtual = alt.invoiceUrl || cRow?.invoice_url || '';
          await sb.from('bia_cobranca').update({ venc_atual: dataISO, valor: valorFinal, invoice_url: linkAtual || cRow?.invoice_url, data_prometida: dataISO, adiamentos: (cRow?.adiamentos ?? 0) + 1, status: 'adiada', proximo_lembrete_em: new Date(dataISO + 'T12:00:00-03:00').toISOString(), observacao: 'prazo aprovado pelo gestor' + (novoValor ? ' (+11%, multa zerada)' : ''), updated_at: new Date().toISOString() }).eq('asaas_payment_id', ap.asaas_payment_id);
          const linhaVal = (aposVenc && !semAcresc) ? ` Com o acréscimo de 11% pelo novo prazo, o valor fica R$ ${brMoney(valorFinal)}.` : '';
          // descobre ANTES se há próxima parcela a vencer — pra decidir a despedida.
          let prox: any = null;
          try {
            const cid = cRow?.asaas_customer_id;
            if (cid) {
              const pr = await fetch(`${aBase}/payments?customer=${cid}&status=PENDING&limit=100`, { headers: aHead });
              const pj = await pr.json().catch(() => null);
              const futuras = (pj?.data || []).filter((p: any) => String(p.id) !== ap.asaas_payment_id && String(p.dueDate || '') > hojeSP()).sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
              prox = futuras[0] || null;
            }
          } catch { /* best-effort */ }
          // "Qualquer coisa, é só me chamar" só entra se for a ÚLTIMA mensagem (sem pergunta seguinte).
          const despedida = prox ? '' : `\nQualquer coisa, é só me chamar.`;
          if (tel) await enviarTexto(tel, `${SIG}\nBoa notícia! Consegui reagendar sua parcela para ${brD(dataISO)}.${linhaVal}${linkAtual ? `\n${linkAtual}` : ''}${despedida}`);
          if (prox && tel) await enviarTexto(tel, `${SIG}\nE sobre a sua próxima parcela de R$ ${brMoney(prox.value)}, que vence em ${brD(prox.dueDate)}: você acha que consegue acertar ela também no mês que vem? Me avisa pra eu já deixar tudo alinhado.`);
          await sb.from('bia_aprovacoes').update({ status: 'aplicada', resultado: 'ok' }).eq('id', ap.id);
        } else {
          await sb.from('bia_aprovacoes').update({ resultado: 'erro asaas: ' + (alt.erro || '') }).eq('id', ap.id);
          await notificar(`Falha ao aplicar prazo aprovado (#${ap.id}) no Asaas: ${alt.erro || ''}`);
        }
      } else { // negada
        if (tel) await enviarTexto(tel, `${SIG}\nOi! Sobre a data que você pediu, não consegui liberar dessa vez. Se ajudar, a gente ajeita dentro deste mês. Qual o melhor dia pra você?`);
        await sb.from('bia_aprovacoes').update({ resultado: 'avisado' }).eq('id', ap.id);
      }
    }
  } catch { /* executor best-effort */ }

  // ===== Daqui pra baixo, só a cobrança de saída (gated) =====
  if (!cfg.cobranca_ativa) return json({ ok: true, skipped: 'cobranca desligada (aprovações processadas)' });
  if (!testeTel && !horarioComercial()) return json({ ok: true, skipped: 'fora do horario comercial' });

  // candidatas: cobranças que ainda cobram e cujo próximo lembrete venceu.
  // Em modo teste, escopar JÁ na query (senão as reais ocupam o limite e a de teste nunca entra).
  let q = sb.from('bia_cobranca').select('*')
    .in('status', ['ativa', 'adiada'])
    .not('telefone', 'is', null)
    .lte('proximo_lembrete_em', new Date().toISOString());
  if (testeTel) q = q.like('telefone', '%' + testeTel.slice(-8));
  q = q.order('proximo_lembrete_em', { ascending: true }).limit(MAX_POR_RUN);
  const { data: rows, error } = await q;
  if (error) return json({ error: 'select bia_cobranca: ' + error.message }, 500);

  let enviadas = 0, pagas = 0, paraAcao = 0, puladas = 0, followups = 0;
  const agoraIso = new Date().toISOString();

  for (const c of (rows || [])) {
    const tel = String(c.telefone || '').replace(/\D/g, '');
    if (!tel) { puladas++; continue; }
    if (testeTel && tel.slice(-8) !== testeTel.slice(-8)) { puladas++; continue; }

    // cede a vez ao humano / negociação viva
    const { data: at } = await sb.from('whatsapp_atendimentos').select('estado, humano_ate').eq('telefone', tel).maybeSingle();
    if (at?.estado === 'aguardando_humano') { puladas++; continue; }
    if (at?.humano_ate && Date.now() < new Date(at.humano_ate).getTime()) { puladas++; continue; }

    // se o cliente escreveu DEPOIS do último lembrete, está conversando -> pausa a régua
    const { data: msgs } = await sb.from('crm_mensagens_recebidas').select('recebida_em').eq('telefone', tel).order('recebida_em', { ascending: false }).limit(1);
    const ultimaRecv = msgs?.[0]?.recebida_em ? new Date(msgs[0].recebida_em).getTime() : 0;
    const ultimoLemb = c.ultimo_lembrete_em ? new Date(c.ultimo_lembrete_em).getTime() : 0;
    // só pausa se o cliente respondeu DEPOIS de já termos cobrado (no 1º contato, mensagem antiga não pausa)
    if (ultimoLemb > 0 && ultimaRecv > ultimoLemb) {
      // cliente respondeu mas não pagou nem mudou o vencimento: pausa HOJE, cobra de novo AMANHÃ.
      const amanha = new Date(Date.parse(hojeSP() + 'T12:00:00-03:00') + 864e5).toISOString();
      await sb.from('bia_cobranca').update({ status: 'ativa', ultimo_lembrete_em: agoraIso, proximo_lembrete_em: amanha, observacao: 'cliente respondeu; retomar amanhã', updated_at: agoraIso }).eq('asaas_payment_id', c.asaas_payment_id);
      puladas++; continue;
    }

    // confere no Asaas se já pagou / pega venc/link atualizado
    let pago = false, venc = c.venc_atual, url = c.invoice_url;
    try {
      const r = await fetch(`${aBase}/payments/${c.asaas_payment_id}`, { headers: aHead });
      if (r.ok) {
        const p = await r.json();
        const st = String(p.status || '');
        if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(st)) pago = true;
        venc = p.dueDate || venc; url = p.invoiceUrl || url;
      }
    } catch { /* mantém cache */ }
    if (pago) {
      await sb.from('bia_cobranca').update({ status: 'paga', updated_at: agoraIso }).eq('asaas_payment_id', c.asaas_payment_id);
      pagas++; continue;
    }

    const hoje = hojeSP();
    const primeiroNome = String(c.nome || '').split(' ')[0] || '';
    const ola = primeiroNome ? `Oi ${primeiroNome}, tudo bem?` : 'Oi, tudo bem?';
    const val = brMoney(c.valor);

    // ===== FOLLOW-UP DO MESMO DIA =====
    // Se já cobramos HOJE (de manhã) e o cliente NÃO respondeu, e chegou aqui é porque
    // o proximo_lembrete_em (13h30) já passou. Manda UM follow-up firme e reagenda a régua
    // normal pra amanhã (sem contar como novo lembrete/escalada).
    if (spDate(c.ultimo_lembrete_em) === hoje) {
      const blocos = [
        `${ola} Passei mais cedo sobre sua parcela de R$ ${val} e até agora não tive seu retorno.`,
        `Preciso de um posicionamento ainda hoje. Sem resposta, vou entender que não há intenção de resolver por aqui e o caso segue para as próximas providências.`,
        `Se você não consegue responder agora, me manda só uma palavra avisando que retorna mais tarde — assim eu aguardo. Combinado?`,
      ];
      blocos[0] = `${SIG}\n${blocos[0]}`;
      const { ok } = await enviarBlocos(tel, blocos);
      if (!ok) { puladas++; continue; }
      const nAtual = c.lembretes_enviados ?? 1;
      const proxMs = Date.now() + (nAtual <= 2 ? 1 : 2) * 864e5;
      await sb.from('bia_cobranca').update({ ultimo_lembrete_em: agoraIso, proximo_lembrete_em: new Date(proxMs).toISOString(), observacao: 'follow-up enviado; sem resposta até 13h30', updated_at: agoraIso }).eq('asaas_payment_id', c.asaas_payment_id);
      await sb.from('bia_cobranca_log').insert({ asaas_payment_id: c.asaas_payment_id, telefone: tel, lembrete_num: nAtual, texto: 'FOLLOW-UP: ' + blocos.join('\n\n') });
      followups++; continue;
    }

    // marcar para ação: >= diaMax dias vencido sem NENHUMA resposta, ou 2+ promessas quebradas
    const diasVencido = Math.floor((Date.now() - new Date(c.venc_original).getTime()) / 864e5);
    const respondeuAlguemDia = ultimaRecv > 0;
    if ((diasVencido >= diaMax && !respondeuAlguemDia) || (c.promessas_quebradas ?? 0) >= 2) {
      await sb.from('bia_cobranca').update({ status: 'para_acao', marcada_acao_em: agoraIso, updated_at: agoraIso }).eq('asaas_payment_id', c.asaas_payment_id);
      paraAcao++;
      await notificar(`COBRANÇA -> PARA AÇÃO\n${c.nome || ('+' + tel)} | R$ ${brMoney(c.valor)} | venceu ${brDate(c.venc_original)}\nSem resposta há ${diasVencido} dias. Encaminhar ao Teixeira & Azzolin.`);
      continue;
    }

    // valida WhatsApp
    if (!(await whatsappExiste(tel))) {
      await sb.from('bia_cobranca').update({ status: 'pausada', observacao: 'numero sem WhatsApp', updated_at: agoraIso }).eq('asaas_payment_id', c.asaas_payment_id);
      puladas++; continue;
    }

    // monta a mensagem: escalada por dias de atraso (contra a data ATUAL) + firmeza real.
    const n = (c.lembretes_enviados ?? 0) + 1;
    const vencAtualStr = String(venc || c.venc_atual || '').slice(0, 10);
    const diasVencAtual = vencAtualStr ? Math.round((Date.parse(hoje) - Date.parse(vencAtualStr)) / 864e5) : diasVencido;
    // só ameaça (judicial/negativação/protesto) se JÁ houve lembrete anterior do MESMO boleto
    // sem resultado e o atraso passou de 7 dias — no 1º contato, nunca ameaça.
    const jaCobrado = (c.lembretes_enviados ?? 0) >= 1;
    const pertoAcao = jaCobrado && diasVencAtual >= (diaMax - 2);
    const promessaQuebrada = c.status === 'adiada' && !!c.data_prometida &&
      Date.parse(hoje) > Date.parse(String(c.data_prometida).slice(0, 10));

    // quantos boletos em aberto esse cliente tem (pra pegar mais firme com quem acumula)
    let nAberto = 1;
    try {
      if (c.asaas_customer_id) {
        const { count } = await sb.from('bia_cobranca').select('asaas_payment_id', { count: 'exact', head: true })
          .eq('asaas_customer_id', c.asaas_customer_id).in('status', ['ativa', 'adiada', 'para_acao']);
        if (count && count > 0) nAberto = count;
      }
    } catch { /* ignora */ }
    const multi = nAberto > 1 ? ` Constam ${nAberto} boletos em aberto em seu nome.` : '';
    // mensagem em BLOCOS (várias mensagens curtas, como um humano digita), não um textão.
    let blocos: string[];
    if (promessaQuebrada) {
      blocos = [
        `${ola} Você tinha se comprometido a pagar a parcela de R$ ${val} até ${brDate(c.data_prometida)}, e o pagamento não entrou.`,
        `Isso deixa o acordo descumprido.${multi}`,
        `Regularize hoje pra gente evitar o encaminhamento pra cobrança judicial e a negativação do seu nome:\n${url}`,
        `Se aconteceu algum imprevisto, me chama agora.`,
      ];
    } else if (pertoAcao) {
      blocos = [
        `${ola} Vou precisar ser bem direta com você agora.`,
        `Sua parcela de R$ ${val} está vencida desde ${brDate(venc)} e continua em aberto.${multi}`,
        `Vou te dar um prazo final de 48 horas. Passando disso sem pagamento, o caso vai pra protesto em cartório, negativação (SPC/Serasa) e cobrança judicial, com custas e honorários.`,
        `Ainda dá tempo de resolver por aqui:\n${url}`,
      ];
    } else if (jaCobrado && diasVencAtual >= 7) {
      blocos = [
        `${ola} Sua parcela de R$ ${val} está vencida desde ${brDate(venc)} e ainda não foi paga.${multi}`,
        `Preciso que você regularize com urgência. Continuando sem pagamento, o caso vai ser encaminhado pra cobrança judicial e negativação.`,
        `Dá pra resolver por aqui:\n${url}`,
        `Se precisar acertar uma data, me chama.`,
      ];
    } else if (diasVencAtual <= 0) {
      blocos = [
        `${ola} Aqui é da COBRASQ. Passando pra lembrar que sua parcela de R$ ${val} vence ${diasVencAtual === 0 ? `hoje (${brDate(venc)})` : `no dia ${brDate(venc)}`}.${multi}`,
        `Pra já deixar quitado, é só usar o link:\n${url}`,
        `Qualquer coisa, estou à disposição.`,
      ];
    } else {
      blocos = [
        `${ola} Sua parcela de R$ ${val} venceu em ${brDate(venc)} e ainda consta em aberto.${multi}`,
        `Pedimos que regularize o quanto antes pra evitar encargos e o prosseguimento da cobrança:\n${url}`,
        `Estou à disposição pra acertar.`,
      ];
    }
    blocos[0] = `${SIG}\n${blocos[0]}`; // assinatura só no 1º bloco
    const msgLog = blocos.join('\n\n');

    // envia bloco a bloco (mensagens separadas), com um pequeno intervalo
    const { ok } = await enviarBlocos(tel, blocos);
    if (!ok) { puladas++; continue; }

    // avança a régua. Se a parcela está EM ATRASO e ainda dá tempo, agenda o FOLLOW-UP
    // pra hoje 13h30 (se o cliente não responder até lá). Senão, cadência normal (n<=2 +1d; n>=3 +2d).
    const followUpAtISO = new Date(`${hoje}T13:30:00-03:00`).toISOString();
    const podeFupHoje = diasVencAtual >= 1 && Date.now() < Date.parse(followUpAtISO);
    const proxMs = Date.now() + (n <= 2 ? 1 : 2) * 864e5;
    const upd: any = {
      lembretes_enviados: n, ultimo_lembrete_em: agoraIso,
      proximo_lembrete_em: podeFupHoje ? followUpAtISO : new Date(proxMs).toISOString(),
      primeiro_contato_em: c.primeiro_contato_em || agoraIso, venc_atual: venc, invoice_url: url, updated_at: agoraIso,
    };
    if (promessaQuebrada) {
      // registra a quebra e retoma cobrança normal (2ª quebra dispara o para_acao no próximo run)
      upd.promessas_quebradas = (c.promessas_quebradas ?? 0) + 1;
      upd.status = 'ativa';
      upd.data_prometida = null;
    }
    await sb.from('bia_cobranca').update(upd).eq('asaas_payment_id', c.asaas_payment_id);
    await sb.from('bia_cobranca_log').insert({ asaas_payment_id: c.asaas_payment_id, telefone: tel, lembrete_num: n, texto: msgLog });
    enviadas++;
  }

  return json({ ok: true, candidatas: rows?.length || 0, enviadas, followups, pagas, para_acao: paraAcao, puladas });
});
