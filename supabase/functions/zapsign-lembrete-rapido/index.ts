// Supabase Edge Function: zapsign-lembrete-rapido
// Disparada por pg_cron a cada 5 minutos via pg_net.http_post.
//
// Complementa api/cron-regua.js (Vercel, roda 1x/dia às 12:00 UTC — cron do plano
// Hobby não dá pra ser mais frequente): aquele cuida dos estágios 24h/48h/72h de
// acordo "aguardando assinatura" no ZapSign; este cuida do estágio de 30 MINUTOS,
// que precisa rodar com granularidade de minutos pra fazer sentido (um cron diário
// levaria até quase 24h pra disparar "30 minutos").
//
// O QUE FAZ: acordo com status_zapsign em (enviado,visualizado,pendente), status
// 'ativo', com 30min–24h desde o envio (zapsign_evento_em || created_at) e que
// ainda não recebeu o lembrete de 30min → agenda 1 mensagem em
// crm_mensagens_agendadas (origem='auto_cobranca_30min'), a MESMA fila que o
// cron-mensagens-agendadas (pg_cron 1x/min) já processa e envia via Z-API.
// Teto de 24h evita pisar no lembrete de 24h do cron-regua diário.
//
// IDEMPOTÊNCIA: flag em acordos.metadata.auto_cobranca_30min (evita reprocessar) +
// índice único uq_crm_msg_agendadas_auto_cobranca (caso_id, origem) WHERE origem
// LIKE 'auto_cobranca%' (já em prod, migração 20260706) — segunda tentativa de
// INSERT do mesmo par vira 23505/duplicate, tratado como no-op.
//
// Respeita vw_conversas_pendentes (não cobra por cima de mensagem do devedor sem
// resposta) e whatsapp_atendimentos.regua_bloqueada (número marcado como spam),
// igual ao cron-regua.js.
//
// Autenticação: header `Authorization: Bearer <CRON_INVOKE_SECRET>` (mesmo
// segredo já usado por cron-mensagens-agendadas/bia-cobranca/etc.).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const LIMIAR_HORAS = 0.5;   // 30 minutos
const TETO_HORAS = 24;      // acima disso, quem assume é o cron-regua.js diário (24h/48h/72h)
const ORIGEM = 'auto_cobranca_30min';
const MENSAGEM = 'Oi! Te mandei o acordo pra assinar e ainda não vi retornar. Já deu uma olhada? Qualquer dúvida, é só me chamar aqui.';

function horasDesde(dataStr: string | null | undefined): number | null {
  if (!dataStr) return null;
  const d = new Date(dataStr);
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3600000;
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('CRON_INVOKE_SECRET');
  if (!expected) return new Response(JSON.stringify({ error: 'CRON_INVOKE_SECRET não configurado' }), { status: 500 });
  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided !== expected) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: acordos, error } = await sb
    .from('acordos')
    .select('id, devedor_id, status, status_zapsign, zapsign_evento_em, created_at, metadata, devedor:devedores(telefone,assigned_to)')
    .in('status_zapsign', ['enviado', 'visualizado', 'pendente'])
    .eq('status', 'ativo')
    .limit(1000);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const out: { candidatos: number; agendados: number; pulados: number; falhas: number; itens: any[] } =
    { candidatos: 0, agendados: 0, pulados: 0, falhas: 0, itens: [] };

  for (const ac of acordos || []) {
    const meta = (ac.metadata && typeof ac.metadata === 'object') ? ac.metadata as Record<string, unknown> : {};
    if (meta[ORIGEM]) continue;

    const horas = horasDesde((ac as any).zapsign_evento_em || (ac as any).created_at);
    if (horas == null || horas < LIMIAR_HORAS || horas >= TETO_HORAS) continue;

    out.candidatos++;
    const dev = Array.isArray((ac as any).devedor) ? (ac as any).devedor[0] : (ac as any).devedor;
    const telefoneDigits = String(dev?.telefone || '').replace(/\D/g, '');
    if (!telefoneDigits) { out.itens.push({ acordo: ac.id, skipped: 'sem telefone do devedor' }); out.pulados++; continue; }
    const ultimos8 = telefoneDigits.slice(-8);

    // Conversa pendente (devedor já escreveu e ainda não respondemos) → não cobra por cima.
    const { data: pend } = await sb
      .from('vw_conversas_pendentes')
      .select('telefone')
      .ilike('telefone', '%' + ultimos8);
    if (pend && pend.length) { out.itens.push({ acordo: ac.id, skipped: 'conversa_pendente' }); out.pulados++; continue; }

    // Número marcado como spam/engano → não insiste.
    const { data: bloq } = await sb
      .from('whatsapp_atendimentos')
      .select('telefone')
      .ilike('telefone', '%' + ultimos8)
      .eq('regua_bloqueada', true)
      .limit(1);
    if (bloq && bloq.length) { out.itens.push({ acordo: ac.id, skipped: 'regua_bloqueada' }); out.pulados++; continue; }

    const { error: insErr } = await sb.from('crm_mensagens_agendadas').insert({
      caso_id: (ac as any).devedor_id,
      operador_id: dev?.assigned_to || null,
      telefone: telefoneDigits,
      mensagem: MENSAGEM,
      agendada_para: new Date(Date.now() + 60000).toISOString(),
      status: 'pendente',
      origem: ORIGEM,
    });
    if (insErr && !/duplicate|23505|unique/i.test(insErr.message)) {
      out.falhas++; out.itens.push({ acordo: ac.id, error: insErr.message }); continue;
    }

    await sb.from('acordos').update({
      metadata: { ...meta, [ORIGEM]: true, [ORIGEM + '_em']: new Date().toISOString() },
    }).eq('id', ac.id);

    out.agendados++;
    out.itens.push({ acordo: ac.id, horas: Math.round(horas * 100) / 100, status: 'agendado' });
  }

  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
});
