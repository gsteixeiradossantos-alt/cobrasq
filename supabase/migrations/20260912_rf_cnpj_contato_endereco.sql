-- ============================================================
-- ⏳ NÃO APLICADA. Aditiva (colunas novas + índices + RPCs); rollback pareado em
--    _rollback.sql. Aplicar ANTES de rodar scripts/import_cnpj_rf.py --uf PR,SC,RS,
--    que passa a escrever as colunas novas. As tabelas continuam VAZIAS até a carga.
-- ============================================================
-- Base pública de CNPJ (Receita Federal) — 2ª etapa, decidida no piloto de 12/09/2026:
-- além de "pessoa → empresas" (migração 2026-07-27), a base passa a responder
-- "telefone → empresas", "endereço → empresas" e "e-mail → empresas" — perguntas que
-- nenhuma API pública faz (elas só aceitam o CNPJ como entrada). Para isso o
-- estabelecimento guarda contato e endereço, que o dump já traz.
--
-- Filtros de plausibilidade (aprendidos no piloto, ficam DENTRO das RPCs):
--   · telefone usado por mais de 3 CNPJs é de contador/escritório, não do devedor —
--     a RPC devolve `compartilhado_com` (quantos CNPJs usam) e a tela avisa;
--   · cidade pequena tem UM CEP só (Dois Vizinhos = 85660-000), então CEP+número
--     casa com qualquer rua: endereço exige logradouro parecido (trigram) além de
--     CEP e número, e ignora número '0', 'S/N', 'SN' e vazio (zona rural).
-- Dados: reference-data pública; PII só o que a própria RFB publica.

alter table public.rf_estabelecimentos
  add column if not exists data_situacao   text,
  add column if not exists motivo_situacao text,
  add column if not exists data_inicio     text,
  add column if not exists cnae            text,
  add column if not exists tipo_logradouro text,
  add column if not exists logradouro      text,
  add column if not exists numero          text,
  add column if not exists complemento     text,
  add column if not exists bairro          text,
  add column if not exists cep             text,
  add column if not exists telefone1       text,   -- DDD+número, só dígitos
  add column if not exists telefone2       text,
  add column if not exists email           text;   -- minúsculo

alter table public.rf_empresas
  add column if not exists capital_social numeric;

create index if not exists idx_rf_estab_tel1  on public.rf_estabelecimentos (telefone1) where telefone1 <> '';
create index if not exists idx_rf_estab_tel2  on public.rf_estabelecimentos (telefone2) where telefone2 <> '';
create index if not exists idx_rf_estab_email on public.rf_estabelecimentos (email) where email <> '';
create index if not exists idx_rf_estab_cep_num on public.rf_estabelecimentos (cep, numero);
create index if not exists idx_rf_estab_uf on public.rf_estabelecimentos (uf);

-- ── RPC: telefone → empresas ────────────────────────────────────────────────
-- p_tel: qualquer formato; compara pelos 10 ou 11 dígitos finais (com/sem o 9).
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
    where est.telefone1 in (alvo.t10, alvo.t11) or est.telefone2 in (alvo.t10, alvo.t11)
  )
  select h.cnpj_basico || h.cnpj_ordem || h.cnpj_dv as cnpj,
         e.razao_social as nome, h.nome_fantasia as fantasia, h.situacao, h.municipio, h.uf,
         (select count(*) from hits)::int as compartilhado_com
  from hits h
  left join public.rf_empresas e on e.cnpj_basico = h.cnpj_basico
  order by h.situacao, e.razao_social
  limit 50;
$$;

-- ── RPC: endereço → empresas ────────────────────────────────────────────────
-- Exige CEP + número + logradouro parecido (similaridade trigram ≥ 0.4, sem acento).
create or replace function public.buscar_empresas_por_endereco(p_cep text, p_numero text, p_logradouro text)
  returns table (cnpj text, nome text, fantasia text, situacao text, logradouro text, numero text, complemento text, uf text)
  language sql
  security definer
  set search_path = public
as $$
  with alvo as (
    select regexp_replace(coalesce(p_cep,''), '\D', '', 'g') as cep,
           regexp_replace(coalesce(p_numero,''), '\D', '', 'g') as num,
           public.f_unaccent(lower(coalesce(p_logradouro,''))) as logr
  )
  select est.cnpj_basico || est.cnpj_ordem || est.cnpj_dv as cnpj,
         e.razao_social, est.nome_fantasia, est.situacao,
         coalesce(est.tipo_logradouro,'') || ' ' || coalesce(est.logradouro,''), est.numero, est.complemento, est.uf
  from public.rf_estabelecimentos est
  join alvo on true
  left join public.rf_empresas e on e.cnpj_basico = est.cnpj_basico
  where length(alvo.cep) = 8
    and alvo.num <> '' and alvo.num <> '0'
    and est.cep = alvo.cep
    and regexp_replace(coalesce(est.numero,''), '\D', '', 'g') = alvo.num
    and alvo.logr <> ''
    and similarity(public.f_unaccent(lower(coalesce(est.logradouro,''))), alvo.logr) >= 0.4
  order by est.situacao, e.razao_social
  limit 50;
$$;

-- ── RPC: e-mail → empresas ──────────────────────────────────────────────────
create or replace function public.buscar_empresas_por_email(p_email text)
  returns table (cnpj text, nome text, fantasia text, situacao text, uf text)
  language sql
  security definer
  set search_path = public
as $$
  select est.cnpj_basico || est.cnpj_ordem || est.cnpj_dv, e.razao_social, est.nome_fantasia, est.situacao, est.uf
  from public.rf_estabelecimentos est
  left join public.rf_empresas e on e.cnpj_basico = est.cnpj_basico
  where lower(trim(coalesce(p_email,''))) <> '' and est.email = lower(trim(p_email))
  order by est.situacao, e.razao_social
  limit 50;
$$;

-- ── Sanidade: a base está carregada? (para a API não responder "nenhuma" com base vazia)
create or replace function public.rf_base_status()
  returns table (socios bigint, estabelecimentos bigint, ufs text[], atualizado_em date)
  language sql
  security definer
  set search_path = public
as $$
  select (select count(*) from public.rf_socios),
         (select count(*) from public.rf_estabelecimentos),
         (select coalesce(array_agg(distinct uf order by uf), '{}') from public.rf_estabelecimentos),
         (select max(atualizado_em) from public.rf_empresas);
$$;

grant execute on function public.buscar_empresas_por_telefone(text) to authenticated, service_role;
grant execute on function public.buscar_empresas_por_endereco(text, text, text) to authenticated, service_role;
grant execute on function public.buscar_empresas_por_email(text) to authenticated, service_role;
grant execute on function public.rf_base_status() to authenticated, service_role;
