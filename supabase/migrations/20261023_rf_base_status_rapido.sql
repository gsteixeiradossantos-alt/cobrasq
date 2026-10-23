-- rf_base_status estourava statement timeout (57014) com a base carregada (5,8 mi sócios,
-- 13 mi estabelecimentos): count(*) + distinct uf + max(atualizado_em) sem índice.
-- Resultado: a busca por sócio do painel caía em "indisponível". Agora usa estimativa do
-- catálogo para as contagens (a API só testa socios > 0), skip-scan no índice idx_rf_estab_uf
-- para as UFs e uma linha de rf_empresas para a data (a carga do dump é única).
create or replace function public.rf_base_status()
returns table(socios bigint, estabelecimentos bigint, ufs text[], atualizado_em date)
language sql
security definer
set search_path to 'public'
as $$
  with recursive u as (
    (select uf from public.rf_estabelecimentos where uf is not null order by uf limit 1)
    union all
    select (select e.uf from public.rf_estabelecimentos e where e.uf > u.uf order by e.uf limit 1)
    from u where u.uf is not null
  )
  select (select greatest(reltuples, 0)::bigint from pg_class where oid = 'public.rf_socios'::regclass),
         (select greatest(reltuples, 0)::bigint from pg_class where oid = 'public.rf_estabelecimentos'::regclass),
         coalesce((select array_agg(uf order by uf) from u where uf is not null), '{}'),
         (select r.atualizado_em from public.rf_empresas r where r.atualizado_em is not null limit 1);
$$;
grant execute on function public.rf_base_status() to authenticated, service_role;
