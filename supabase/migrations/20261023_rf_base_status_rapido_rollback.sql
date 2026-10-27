-- Volta à versão exata (lenta) da 20260912.
create or replace function public.rf_base_status()
returns table(socios bigint, estabelecimentos bigint, ufs text[], atualizado_em date)
language sql
security definer
set search_path to 'public'
as $$
  select (select count(*) from public.rf_socios), (select count(*) from public.rf_estabelecimentos),
         (select coalesce(array_agg(distinct uf order by uf), '{}') from public.rf_estabelecimentos), (select max(atualizado_em) from public.rf_empresas);
$$;
