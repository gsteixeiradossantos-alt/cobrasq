-- Rollback de 20260928_03_config_segredos.sql
-- Devolve as chaves ao blob (a partir de config_segredos), tira o integ e o trigger.
-- Antes de rodar: reverter o index.html (integOn tem fallback, mas o formulário grava em config_segredos).
drop trigger if exists trg_cobrasq_data_sem_segredos on public.cobrasq_data;
drop function if exists public.fn_cobrasq_data_sem_segredos();

update public.cobrasq_data d
   set data = jsonb_set(d.data, '{config}',
         ((d.data->'config') - 'integ') || coalesce(
           (select jsonb_object_agg(s.chave, s.valor) from public.config_segredos s
             where s.chave in ('asaasKey','zapsignToken','zapiInstanceId','zapiToken','zapiClientToken','claudeApiKey')),
           '{}'::jsonb))
 where d.key = 'main';

drop table if exists public.config_segredos;
