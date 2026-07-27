// Supabase Edge Function: carlos-iniciar
// Chamada pelo botão "Ativar Carlos" no CRM (crm.html, tela de conversa de
// um caso em "Cobranças"). Dá início à negociação: calcula as 3 formas de
// pagamento com o motor real (_shared/calc-cobranca.ts), manda a PRIMEIRA
// mensagem via WhatsApp (template, não gerada por IA — mesmo padrão de
// bia-cobranca, pra não arriscar a IA inventando número na 1ª mensagem),
// marca cobrancas.carlos_ativo=true e registra no histórico do caso.
//
// IMPORTANTE: isto só cobre o INÍCIO (mensagem de abertura). As RESPOSTAS
// do devedor ainda não são roteadas automaticamente pro Carlos — isso é o
// próximo passo (roteirização em bia-atendimento), ainda não conectado.
//
// Auth: JWT do Supabase (deploy padrão, SEM --no-verify-jwt) — só usuário
// logado no CRM pode chamar. Escritas usam service role internamente.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { calcularCobranca, valorFixo } from '../_shared/calc-cobranca.ts';

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function fmtBRL(v: number): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ZAPI_INSTANCE = Deno.env.get('ZAPI_INSTANCE');
  const ZAPI_TOKEN = Deno.env.get('ZAPI_TOKEN');
  const ZAPI_CLIENT_TOKEN = Deno.env.get('ZAPI_CLIENT_TOKEN');
  if (!ZAPI_INSTANCE || !ZAPI_TOKEN) return json({ error: 'faltam secrets ZAPI' }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const casoId = String(body.casoId || body.caso_id || '');
  if (!casoId) return json({ error: 'mande "casoId"' }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: co } = await sb.from('cobrancas')
    .select('id, status, divida, cliente_id, arquivado, is_draft, fora_crm, encerramento, acordo_final, carlos_ativo')
    .eq('id', casoId).maybeSingle();
  if (!co) return json({ error: 'caso não encontrado' }, 404);
  if (co.arquivado || co.is_draft || co.fora_crm || co.encerramento) return json({ error: 'caso arquivado, rascunho ou encerrado — não dá pra ativar o Carlos' }, 409);
  if (co.acordo_final) return json({ error: 'esse caso já tem acordo em andamento — Carlos é só pra negociação inicial' }, 409);
  if (co.carlos_ativo) return json({ error: 'Carlos já foi ativado nesse caso' }, 409);

  const { data: pp } = await sb.from('cobranca_partes')
    .select('devedor_id, devedores(nome, telefone)')
    .eq('cobranca_id', casoId).eq('principal', true).maybeSingle();
  const devedor = (pp as any)?.devedores;
  if (!devedor?.telefone) return json({ error: 'devedor sem telefone cadastrado' }, 400);

  const { data: cli } = co.cliente_id
    ? await sb.from('clientes').select('nome, nome_fantasia').eq('id', co.cliente_id).maybeSingle()
    : { data: null };
  const credorNome = cli?.nome_fantasia || cli?.nome || 'nosso cliente';

  const valorOriginal = Number(co.divida?.valorOriginal || 0);
  const vencimento = co.divida?.vencimento || null;
  const totalAvistaSalvo = Number(co.divida?.totalAvista || 0);
  // VALOR FIXO: sem vencimento mas com valor já definido = dívida "madura"/já
  // virou ação judicial (cumprimento de sentença, execução) — segue cálculo
  // judicial próprio, não a fórmula de cobrança extrajudicial daqui. Não
  // recalcula nada, não oferece parcelamento automático.
  const faseJudicial = !vencimento && totalAvistaSalvo > 0;
  if (!faseJudicial && (!(valorOriginal > 0) || !vencimento)) return json({ error: 'dívida não calculada — edite o caso e informe valor/vencimento (ou o valor atualizado, se for caso judicial) antes de ativar o Carlos' }, 400);

  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const calc = faseJudicial ? valorFixo(totalAvistaSalvo) : calcularCobranca(valorOriginal, vencimento!, hoje);
  if (!calc) return json({ error: 'não consegui calcular a dívida (valor/vencimento inválido)' }, 400);

  // telefone de destino: respeita o modo de teste global, se ligado (mesma
  // trava de segurança usada pelo bia-cobranca).
  const { data: cfg } = await sb.from('whatsapp_bia_config').select('cobranca_teste_telefone').eq('id', 1).maybeSingle();
  const testeTel = String(cfg?.cobranca_teste_telefone || '').replace(/\D/g, '');
  let telDestino = String(devedor.telefone || '').replace(/\D/g, '');
  if (telDestino && !telDestino.startsWith('55') && telDestino.length <= 11) telDestino = '55' + telDestino;
  if (testeTel) telDestino = testeTel;

  const primeiroNome = String(devedor.nome || '').trim().split(' ')[0] || 'tudo bem';
  const partes = [`Oi ${primeiroNome}, aqui é o Carlos, da COBRASQ.`];
  if (faseJudicial) {
    partes.push(`Você tem uma pendência de R$ ${fmtBRL(calc.totalAvista)} com ${credorNome}, e a gente ficou responsável por resolver isso.`);
    partes.push('Quer conversar sobre como quitar isso?');
  } else {
    partes.push(`Você tem uma pendência de R$ ${fmtBRL(valorOriginal)} com ${credorNome}, e a gente ficou responsável por resolver isso.`);
    let opcoes = `Você pode pagar à vista por R$ ${fmtBRL(calc.totalAvista)}`;
    if (calc.boleto12) opcoes += `, ou parcelar em até ${calc.boleto12.n}x de R$ ${fmtBRL(calc.boleto12.parcela)} no boleto`;
    opcoes += `, ou ${12}x de R$ ${fmtBRL(calc.cartao12Parcela)} no cartão.`;
    partes.push(opcoes);
    partes.push('Como você prefere seguir?');
  }
  const mensagem = partes.join('\n\n') + '\n\n*Carlos • COBRASQ*';

  const zHead: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ZAPI_CLIENT_TOKEN) zHead['Client-Token'] = ZAPI_CLIENT_TOKEN;
  const sendUrl = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

  let envioOk = false;
  let outId = '';
  try {
    const r = await fetch(sendUrl, { method: 'POST', headers: zHead, body: JSON.stringify({ phone: telDestino, message: mensagem.slice(0, 4000) }) });
    const rj = await r.json().catch(() => null);
    if (r.ok && rj && !rj.error) {
      envioOk = true;
      outId = String(rj.messageId || rj.id || rj.zaapId || '');
    } else {
      return json({ error: `Z-API recusou o envio: ${JSON.stringify(rj || {}).slice(0, 300)}` }, 502);
    }
  } catch (e: any) {
    return json({ error: `falha ao enviar via Z-API: ${e?.message || e}` }, 502);
  }

  if (outId) {
    try { await sb.from('crm_mensagens_status').upsert({ message_id: outId, telefone_enviado: telDestino, status: 'sent', evento_em: new Date().toISOString(), raw_payload: { via: 'carlos-iniciar' } }, { onConflict: 'message_id' }); } catch { /* best-effort */ }
    try { await sb.from('whatsapp_bia_enviadas').upsert({ message_id: outId, telefone: telDestino, lote_id: crypto.randomUUID() }, { onConflict: 'message_id' }); } catch { /* best-effort */ }
  }

  await sb.from('cobrancas').update({
    carlos_ativo: true,
    passo_atual: '1ª mensagem enviada (Carlos)',
    updated_at: new Date().toISOString(),
  }).eq('id', casoId);

  try {
    await sb.from('devedor_eventos').insert({
      devedor_id: (pp as any)?.devedor_id || null,
      cobranca_id: casoId,
      tipo: 'Carlos',
      payload: { acao: 'Carlos ativado — 1ª mensagem enviada', texto: mensagem },
      autor_nome: 'Carlos (IA)',
    });
  } catch { /* best-effort */ }

  return json({ ok: true, enviado: envioOk, telefone: telDestino, calc, faseJudicial, mensagem, testeUsado: !!testeTel });
});
