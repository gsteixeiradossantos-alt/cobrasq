-- 20260620_01_funil_automacao_view.sql
-- Observabilidade da corrente de automação acordo→boleto (auditoria 2026-06-20).
--
-- PROBLEMA: a corrente ZapSign(assinatura) → /api/emitir-acordo (boleto Asaas) →
-- Z-API estava PARADA em produção sem ninguém ver: 6 acordos status_zapsign='assinado'
-- com 0 boletos emitidos (AUTO_EMIT_ACORDO≠on e/ou n8n não emitindo). O webhook é
-- best-effort e o skip de auto-emit é silencioso → "assinou mas não emitiu" não
-- aparecia em lugar nenhum.
--
-- Esta view expõe, por acordo, em que ETAPA do funil ele está — destacando os
-- TRAVADOS (assinado_sem_boleto). É só leitura; não altera dado nem precisa de deploy.
--
-- F-04 (CLAUDE.md): toda view re-declara WITH (security_invoker = true) — respeita a
-- RLS de quem consulta (staff vê só o que já podia ver em acordos/devedores).
--
-- ⚠️ AINDA NÃO APLICADA EM PRODUÇÃO — revisar e aplicar via fluxo de migration/MCP.

create or replace view public.funil_automacao
with (security_invoker = true) as
select
  a.id                                              as acordo_id,
  a.devedor_id,
  d.nome                                            as devedor_nome,
  a.status_zapsign,
  a.data_assinatura,
  (a.metadata->>'boletos_emitidos') = 'true'        as boletos_emitidos,
  a.metadata->>'asaas_installment_id'               as asaas_installment_id,
  a.metadata->>'emitido_em'                         as emitido_em,
  a.metadata->>'emitido_via'                        as emitido_via,
  case
    when (a.metadata->>'boletos_emitidos') = 'true'      then 'boleto_emitido'
    when a.status_zapsign = 'assinado'                   then 'assinado_sem_boleto'  -- ⚠ TRAVADO
    when a.status_zapsign = 'enviado'                    then 'aguardando_assinatura'
    when a.status_zapsign in ('recusado','expirado')     then a.status_zapsign
    else coalesce(a.status_zapsign, 'sem_status')
  end                                               as etapa_funil
from public.acordos a
left join public.devedores d on d.id = a.devedor_id;

comment on view public.funil_automacao is
  'Funil de automação acordo→boleto por acordo (etapa_funil). assinado_sem_boleto = corrente travada. security_invoker=true (F-04). Criada na auditoria 2026-06-20.';

grant select on public.funil_automacao to authenticated;
