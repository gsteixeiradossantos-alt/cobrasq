-- 20260913 — busca por nome também na razão social (MEI / empresário individual)
--
-- Em 13/09/2026, "Rafael Marcante" (MEI 66.840.514/0001-63) não apareceu na
-- busca por sócio: MEI e empresário individual não têm quadro societário na
-- Receita — o nome da pessoa está em rf_empresas.razao_social ("66.840.514
-- RAFAEL MARCANTE"), e buscar_empresas_por_socio só olhava rf_socios.
--
-- 1) índice trigram em razao_social (o mesmo que nome_socio já tem), para o
--    LIKE '%nome%' não varrer 12,8 M de linhas;
-- 2) buscar_empresas_por_socio passa a unir os dois conjuntos. Nas linhas vindas
--    da razão social, papel = 'titular' e confere = null (a Receita não expõe
--    o CPF do titular; o miolo do CPF não tem com o que bater).
--
-- O índice é criado CONCURRENTLY (não bloqueia o painel) — por isso este arquivo
-- NÃO pode rodar dentro de uma transação: aplicar via psql, não pelo MCP.
-- scripts/import_cnpj_rf.py derruba e recria todos os índices não-PK das rf_*
-- lendo pg_indexes, então este índice entra na rotina mensal sem mudança lá.

create index concurrently if not exists idx_rf_empresas_razao_trgm
  on public.rf_empresas using gin (public.f_unaccent(lower(razao_social)) gin_trgm_ops);

create or replace function public.buscar_empresas_por_socio(p_nome text, p_cpf text default null)
  returns table (cnpj text, nome text, papel text, situacao text, confere boolean)
  language sql
  security definer
  set search_path = public
as $$
  with alvo as (
    select public.f_unaccent(lower(coalesce(p_nome, ''))) as nome_n,
           substr(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), 4, 6) as miolo
  ),
  por_socio as (
    select
      e.cnpj_basico || coalesce(est.cnpj_ordem, '0001') || coalesce(est.cnpj_dv, '00') as cnpj,
      e.razao_social as nome,
      s.qualificacao as papel,
      est.situacao   as situacao,
      case when (select miolo from alvo) = '' then null
           else regexp_replace(s.cnpj_cpf_socio, '\D', '', 'g') = (select miolo from alvo)
      end as confere
    from public.rf_socios s
    join public.rf_empresas e on e.cnpj_basico = s.cnpj_basico
    left join public.rf_estabelecimentos est
      on est.cnpj_basico = s.cnpj_basico and est.matriz_filial = '1'
    where s.nome_socio is not null
      and public.f_unaccent(lower(s.nome_socio)) like '%' || (select nome_n from alvo) || '%'
  ),
  -- MEI / empresário individual: o nome da pessoa está na razão social. Sem filtro
  -- de natureza jurídica: 'FULANO DE TAL ME' ou 'FULANO LTDA' também interessam.
  por_razao as (
    select
      e.cnpj_basico || coalesce(est.cnpj_ordem, '0001') || coalesce(est.cnpj_dv, '00') as cnpj,
      e.razao_social as nome,
      'titular'::text as papel,
      est.situacao    as situacao,
      null::boolean   as confere
    from public.rf_empresas e
    left join public.rf_estabelecimentos est
      on est.cnpj_basico = e.cnpj_basico and est.matriz_filial = '1'
    where public.f_unaccent(lower(e.razao_social)) like '%' || (select nome_n from alvo) || '%'
      and not exists (select 1 from por_socio p where p.cnpj = e.cnpj_basico || coalesce(est.cnpj_ordem, '0001') || coalesce(est.cnpj_dv, '00'))
  )
  select * from (
    select * from por_socio
    union all
    select * from por_razao
  ) u
  where (select nome_n from alvo) <> ''
  order by confere desc nulls last, nome
  limit 50;
$$;

grant execute on function public.buscar_empresas_por_socio(text, text) to authenticated, service_role;
