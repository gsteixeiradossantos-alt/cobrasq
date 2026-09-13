-- Rollback de 20260913_rf_busca_nome_razao_social: volta a RPC à versão de
-- 2026-07-27 (só rf_socios) e remove o índice trigram da razão social.
drop index concurrently if exists public.idx_rf_empresas_razao_trgm;

create or replace function public.buscar_empresas_por_socio(p_nome text, p_cpf text default null)
  returns table (cnpj text, nome text, papel text, situacao text, confere boolean)
  language sql
  security definer
  set search_path = public
as $$
  with alvo as (
    select public.f_unaccent(lower(coalesce(p_nome, ''))) as nome_n,
           substr(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), 4, 6) as miolo
  )
  select
    e.cnpj_basico || coalesce(est.cnpj_ordem, '0001') || coalesce(est.cnpj_dv, '00') as cnpj,
    e.razao_social as nome,
    s.qualificacao as papel,
    est.situacao   as situacao,
    case when (select miolo from alvo) = '' then null
         else regexp_replace(s.cnpj_cpf_socio, '\D', '', 'g') = (select miolo from alvo)
    end as confere
  from public.rf_socios s
  join alvo on true
  join public.rf_empresas e on e.cnpj_basico = s.cnpj_basico
  left join public.rf_estabelecimentos est
    on est.cnpj_basico = s.cnpj_basico and est.matriz_filial = '1'
  where s.nome_socio is not null
    and public.f_unaccent(lower(s.nome_socio)) like '%' || (select nome_n from alvo) || '%'
    and (select nome_n from alvo) <> ''
  order by confere desc nulls last, e.razao_social
  limit 50;
$$;
