-- ============================================================================
-- Base CNPJ: busca por telefone e por e-mail volta a usar o índice
--
-- Os índices de 20260912 são parciais (telefone1 <> '', telefone2 <> '',
-- email <> ''). Dentro das RPCs o valor procurado é parâmetro, e o Postgres não
-- consegue provar que "telefone1 = $1" implica "telefone1 <> ''": ignorava o
-- índice e varria os 13,4 milhões de estabelecimentos. Medido em 26/09/2026:
-- telefone 23 s, e-mail 18 s, acima do limite de 8 s. O robô da investigação
-- patrimonial caía em "statement timeout", e a tela do CRM também.
-- Com a condição "<> ''" escrita na consulta, o plano usa o índice (7 ms).
-- Só as duas funções mudam; nenhuma tabela ou dado é alterado.
-- ============================================================================

create or replace function public.buscar_empresas_por_telefone(p_tel text)
  returns table (cnpj text, nome text, fantasia text, situacao text, municipio text, uf text, compartilhado_com int)
  language sql
  security definer
  set search_path = public
as $$
  with d as (
    select regexp_replace(coalesce(p_tel,''), '\D', '', 'g') as dig
  ), alvo as (
    select right(dig, 11) as t11, right(dig, 10) as t10 from d where length(dig) >= 10
  ), hits as (
    select est.*
    from public.rf_estabelecimentos est, alvo
    where (est.telefone1 <> '' and est.telefone1 in (alvo.t10, alvo.t11))
       or (est.telefone2 <> '' and est.telefone2 in (alvo.t10, alvo.t11))
  )
  select h.cnpj_basico || h.cnpj_ordem || h.cnpj_dv as cnpj,
         e.razao_social as nome, h.nome_fantasia as fantasia, h.situacao, h.municipio, h.uf,
         (select count(*) from hits)::int as compartilhado_com
  from hits h
  left join public.rf_empresas e on e.cnpj_basico = h.cnpj_basico
  order by h.situacao, e.razao_social
  limit 50;
$$;

create or replace function public.buscar_empresas_por_email(p_email text)
  returns table (cnpj text, nome text, fantasia text, situacao text, uf text)
  language sql
  security definer
  set search_path = public
as $$
  select est.cnpj_basico || est.cnpj_ordem || est.cnpj_dv, e.razao_social, est.nome_fantasia, est.situacao, est.uf
  from public.rf_estabelecimentos est
  left join public.rf_empresas e on e.cnpj_basico = est.cnpj_basico
  where lower(trim(coalesce(p_email,''))) <> '' and est.email <> '' and est.email = lower(trim(p_email))
  order by est.situacao, e.razao_social
  limit 50;
$$;
