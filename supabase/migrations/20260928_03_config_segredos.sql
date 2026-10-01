-- ============================================================================
-- 20260928_03 — chaves de integração saem do blob (config_segredos)
-- NÃO APLICADA. Rollback: 20260928_03_config_segredos_rollback.sql
--
-- O colaborador lê o blob cobrasq_data inteiro (RLS de staff), e data->config
-- guardava asaasKey, zapsignToken, zapiInstanceId, zapiToken, zapiClientToken e
-- claudeApiKey. Os proxies da Vercel (/api/asaas, /api/zapsign, /api/zapi,
-- /api/claude) usam SÓ variáveis de ambiente — as cópias no blob não servem para
-- nada além de vazar. Esta migração:
--   1. cria config_segredos (chave, valor), que só o proprietário lê/grava;
--   2. copia para lá os valores preenchidos do blob;
--   3. grava data->config->integ = {asaas, zapsign, zapi} (ligado/desligado, sem
--      segredo) e apaga as chaves do blob;
--   4. trigger em cobrasq_data que remove essas chaves de qualquer gravação
--      (aba antiga, localStorage antigo) e mantém o integ que já estava.
-- O painel (index.html) usa integOn() e funciona antes e depois desta migração.
-- ============================================================================

create table if not exists public.config_segredos (
  chave          text primary key,
  valor          text not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid default auth.uid()
);

alter table public.config_segredos enable row level security;

drop policy if exists config_segredos_proprietario_all on public.config_segredos;
create policy config_segredos_proprietario_all on public.config_segredos
  for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');

revoke all on public.config_segredos from anon;

-- 2. copia os valores preenchidos (não sobrescreve o que já estiver na tabela)
insert into public.config_segredos (chave, valor, atualizado_por)
select k, d.data->'config'->>k, null
  from public.cobrasq_data d,
       unnest(array['asaasKey','zapsignToken','zapiInstanceId','zapiToken','zapiClientToken','claudeApiKey']) k
 where d.key = 'main'
   and coalesce(d.data->'config'->>k, '') <> ''
on conflict (chave) do nothing;

-- 4. trigger (criado antes do passo 3 para o próprio UPDATE já passar por ele)
create or replace function public.fn_cobrasq_data_sem_segredos()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(new.data->'config') = 'object' then
    new.data := jsonb_set(new.data, '{config}',
      (new.data->'config') - array['asaasKey','zapsignToken','zapiInstanceId','zapiToken','zapiClientToken','claudeApiKey']);
    -- aba antiga grava config sem integ: mantém o que o banco já tinha
    if tg_op = 'UPDATE' and not (new.data->'config' ? 'integ') and (old.data->'config' ? 'integ') then
      new.data := jsonb_set(new.data, '{config,integ}', old.data->'config'->'integ');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_cobrasq_data_sem_segredos on public.cobrasq_data;
create trigger trg_cobrasq_data_sem_segredos
  before insert or update on public.cobrasq_data
  for each row execute function public.fn_cobrasq_data_sem_segredos();

-- 3. integ a partir do que estava preenchido; o trigger acima apaga as chaves
update public.cobrasq_data d
   set data = jsonb_set(d.data, '{config,integ}', jsonb_build_object(
         'asaas',   coalesce(d.data->'config'->>'asaasKey','')     <> '',
         'zapsign', coalesce(d.data->'config'->>'zapsignToken','') <> '',
         'zapi',    coalesce(d.data->'config'->>'zapiInstanceId','') <> ''
                    and coalesce(d.data->'config'->>'zapiToken','') <> ''), true)
 where d.key = 'main';

-- Conferência (esperado: 0 chaves no blob; integ preenchido; linhas copiadas):
-- select (select count(*) from jsonb_object_keys(data->'config') k
--          where k in ('asaasKey','zapsignToken','zapiInstanceId','zapiToken','zapiClientToken','claudeApiKey')) as chaves_no_blob,
--        data->'config'->'integ' as integ,
--        (select count(*) from public.config_segredos) as segredos
--   from public.cobrasq_data where key = 'main';
