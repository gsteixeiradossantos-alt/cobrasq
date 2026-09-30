-- ============================================================================
-- FIX: trigger `cobrancas_set_etapa` fora de sincronia com a regra de negócio
-- da tela (drift — classe R-17 do catálogo, docs/audit/REGRESSOES.md)
--
-- O PR #479 (mergeado 05/08/2026, commit 2b4b544) mudou a ORDEM de precedência
-- em cobEtapa() (index.html): a partir dele, 'acordo' vence 'em_acao' — uma vez
-- que as partes fecharam acordo, a próxima ação é acompanhar parcelas, não o
-- juízo, mesmo que o acordo tenha sido homologado dentro de um processo com
-- numero_processo preenchido.
--
-- O trigger `cobrancas_set_etapa()` (criado em 20260729_cobrancas_etapa_trigger.sql)
-- continuou com a ORDEM ANTIGA: 'em_acao' (tem numero_processo) na frente de
-- 'acordo'. Resultado: toda cobrança com processo distribuído E status de
-- acordo grava etapa='em_acao' no banco, embora a tela (que deriva em runtime,
-- sem usar a coluna — ver comentário de cobEtapa() no index.html) mostre
-- corretamente 'acordo'. A COLUNA mente sobre a regra vigente — exatamente o
-- padrão do R-17.
--
-- Achado na auditoria de 05/08/2026: 8 linhas ativas hoje nessa situação
-- (numero_processo preenchido + status contém "acordo" + não é execução/
-- encerrado, mas etapa gravada = 'em_acao'):
--   7 com status '2.1. Acordo Judicial'
--   1 com status 'Acordo'
-- (reconfirmado logo antes de aplicar esta migração — ver query no rodapé)
--
-- CORREÇÃO (única mudança real): inverter a posição relativa dos blocos
-- 'acordo' e 'em_acao' no CASE do trigger, para bater com a ordem do
-- cobEtapa() pós-#479. Todos os demais blocos (encerrado, execucao,
-- fazer_acao, negociando, travado, cobrar) permanecem exatamente onde estavam,
-- na mesma ordem relativa entre si.
--
-- NÃO APLICADA EM PRODUÇÃO. Pendente de autorização explícita do dono
-- (merge de PR / migração em prod são decisões gated).
-- ============================================================================

begin;

create or replace function public.cobrancas_set_etapa()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.etapa := case
    when coalesce(new.status,'') ~* 'quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebido'
      then 'encerrado'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
     and coalesce(new.status,'') ~* 'execu|cumprimento|penhora|hasta|expropria'
      then 'execucao'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is null
     and coalesce(new.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|a[çc][ãa]o de|monit[óo]ria|locupletamento'
      then 'fazer_acao'
    when coalesce(new.status,'') ~* 'acordo'
      then 'acordo'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
      then 'em_acao'
    when coalesce(new.status,'') ~* 'negocia|proposta|em contato|contatad'
      then 'negociando'
    when coalesce(
           (select max(e.criado_em)
              from public.cobranca_partes cp
              join public.devedor_eventos e on e.devedor_id = cp.devedor_id
             where cp.cobranca_id = new.id),
           new.etapa_atualizada_em, new.updated_at, new.created_at
         ) < now() - interval '90 days'
      then 'travado'
    else 'cobrar'
  end;

  -- carimba só quando a etapa realmente virou
  if tg_op = 'UPDATE' and new.etapa is distinct from old.etapa then
    new.etapa_atualizada_em := now();
  elsif tg_op = 'INSERT' then
    new.etapa_atualizada_em := coalesce(new.etapa_atualizada_em, now());
  end if;

  return new;
end;
$function$;

-- ── BACKFILL ────────────────────────────────────────────────────────────────
-- Conserta o estoque já afetado pela ordem antiga: casos ativos, não-rascunho,
-- com numero_processo preenchido, status contendo "acordo", que NÃO são
-- execução/cumprimento/encerrado (esses continuam vencendo acordo, sem mudança),
-- e que hoje estão gravados como 'em_acao' por causa da ordem velha.
update public.cobrancas
set etapa = 'acordo',
    etapa_atualizada_em = now()
where coalesce(arquivado,false) = false
  and coalesce(is_draft,false) = false
  and nullif(btrim(coalesce(numero_processo,'')),'') is not null
  and coalesce(status,'') ~* 'acordo'
  and not coalesce(status,'') ~* 'execu|cumprimento|penhora|hasta|expropria|quitad|encerrad|baixad|devolvid'
  and etapa = 'em_acao';

commit;

-- ── VERIFICAÇÃO (rodar depois de aplicar) ───────────────────────────────────
-- 1) Não deve sobrar nenhuma linha ativa nessa situação:
--      select count(*) from public.cobrancas
--       where coalesce(arquivado,false) = false
--         and coalesce(is_draft,false) = false
--         and nullif(btrim(coalesce(numero_processo,'')),'') is not null
--         and coalesce(status,'') ~* 'acordo'
--         and not coalesce(status,'') ~* 'execu|cumprimento|penhora|hasta|expropria|quitad|encerrad|baixad|devolvid'
--         and etapa <> 'acordo';
--    Esperado: 0.
--
-- 2) O trigger passa a classificar corretamente daqui pra frente (rodar numa
--    transação e desfazer):
--      begin;
--        update public.cobrancas
--           set status = '2.1. Acordo Judicial'
--         where id = (
--           select id from public.cobrancas
--            where nullif(btrim(coalesce(numero_processo,'')),'') is not null
--              and etapa = 'em_acao'
--            limit 1
--         )
--         returning left(id::text,8), status, numero_processo, etapa; -- etapa tem que vir 'acordo'
--      rollback;

-- ── ROLLBACK (volta à ordem antiga, NÃO recomendado — reintroduz o drift) ───
-- create or replace function public.cobrancas_set_etapa()
-- returns trigger language plpgsql set search_path to 'public' as $function$
-- begin
--   new.etapa := case
--     when coalesce(new.status,'') ~* 'quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebido' then 'encerrado'
--     when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
--      and coalesce(new.status,'') ~* 'execu|cumprimento|penhora|hasta|expropria' then 'execucao'
--     when nullif(btrim(coalesce(new.numero_processo,'')),'') is null
--      and coalesce(new.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|a[çc][ãa]o de|monit[óo]ria|locupletamento' then 'fazer_acao'
--     when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null then 'em_acao'
--     when coalesce(new.status,'') ~* 'acordo' then 'acordo'
--     when coalesce(new.status,'') ~* 'negocia|proposta|em contato|contatad' then 'negociando'
--     when coalesce(
--            (select max(e.criado_em) from public.cobranca_partes cp
--             join public.devedor_eventos e on e.devedor_id = cp.devedor_id
--             where cp.cobranca_id = new.id),
--            new.etapa_atualizada_em, new.updated_at, new.created_at
--          ) < now() - interval '90 days' then 'travado'
--     else 'cobrar'
--   end;
--   if tg_op = 'UPDATE' and new.etapa is distinct from old.etapa then new.etapa_atualizada_em := now();
--   elsif tg_op = 'INSERT' then new.etapa_atualizada_em := coalesce(new.etapa_atualizada_em, now());
--   end if;
--   return new;
-- end;
-- $function$;
