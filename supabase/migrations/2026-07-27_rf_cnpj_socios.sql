-- ============================================================
-- ✅ APLICADA EM PRODUÇÃO 2026-07-27 (via MCP, projeto jokbxzhcctcwnbhkhgru). Não
--    reaplicar. Rollback pareado em _rollback.sql. As tabelas nascem VAZIAS — a carga
--    é feita por scripts/import_cnpj_rf.py (--uf PR por enquanto).
-- ============================================================
-- Base pública de CNPJ da Receita Federal (Dados Públicos do CNPJ) — recorte para
-- consulta reversa "nome do sócio + 6 dígitos do CPF → empresas". Substitui a
-- necessidade de API paga (CNPJá/Casa dos Dados) no caminho CPF→empresas da tela de
-- acordo: os dados são os MESMOS que esses provedores revendem, baixados da fonte.
--
-- Carga: scripts/import_cnpj_rf.py (baixa o dump mensal da RFB, filtra por UF e faz
--   COPY para estas tabelas). "Por enquanto" só o Paraná (--uf PR).
--
-- Por que não guardar o Brasil todo agora: a tabela de sócios nacional tem ~24M linhas;
--   filtrada por PR cabe em algumas centenas de MB. As tabelas são reference-data
--   pública (sem PII além do que a própria RFB já publica mascarado).
--
-- Consulta: RPC public.buscar_empresas_por_socio(p_nome, p_cpf) — usada pelo proxy
--   api/_cnpja.js (service role). O CPF do sócio PF vem MASCARADO no dump (***XXXXXX**),
--   só os 6 dígitos do meio; a RPC confere esses 6 contra o miolo do CPF informado.

create extension if not exists unaccent;
create extension if not exists pg_trgm;

-- unaccent é STABLE por padrão e não pode ser indexado; wrapper IMMUTABLE p/ índice.
create or replace function public.f_unaccent(text)
  returns text language sql immutable strict parallel safe as
$$ select public.unaccent('public.unaccent', $1) $$;

-- ── Empresas (1 linha por CNPJ básico) ──────────────────────────────────────
create table if not exists public.rf_empresas (
  cnpj_basico   text primary key,
  razao_social  text,
  natureza_juridica text,
  porte         text,
  atualizado_em date
);

-- ── Estabelecimentos (matriz/filiais; UF fica aqui) ─────────────────────────
create table if not exists public.rf_estabelecimentos (
  cnpj_basico   text not null,
  cnpj_ordem    text not null,
  cnpj_dv       text not null,
  matriz_filial text,        -- 1=matriz, 2=filial
  nome_fantasia text,
  situacao      text,        -- 02=ativa, 08=baixada, ...
  uf            text,
  municipio     text,
  primary key (cnpj_basico, cnpj_ordem, cnpj_dv)
);
create index if not exists idx_rf_estab_basico on public.rf_estabelecimentos (cnpj_basico);

-- ── Sócios (quadro societário) ──────────────────────────────────────────────
create table if not exists public.rf_socios (
  id             bigint generated always as identity primary key,
  cnpj_basico    text not null,
  identificador  int,        -- 1=PJ, 2=PF, 3=estrangeiro
  nome_socio     text,
  cnpj_cpf_socio text,       -- PF: mascarado ***XXXXXX** ; PJ: CNPJ completo
  qualificacao   text,
  data_entrada   text
);
create index if not exists idx_rf_socios_basico on public.rf_socios (cnpj_basico);
-- Busca por nome (trigram, acento-insensível) e pelos 6 dígitos do CPF mascarado.
create index if not exists idx_rf_socios_nome_trgm
  on public.rf_socios using gin (public.f_unaccent(lower(nome_socio)) gin_trgm_ops);
create index if not exists idx_rf_socios_cpf6
  on public.rf_socios ((regexp_replace(cnpj_cpf_socio, '\D', '', 'g')))
  where identificador = 2;

-- RLS: reference-data pública, mas fechada por padrão (só service role/RPC leem).
alter table public.rf_empresas         enable row level security;
alter table public.rf_estabelecimentos enable row level security;
alter table public.rf_socios           enable row level security;

-- ── RPC: nome + 6 dígitos do CPF → empresas ─────────────────────────────────
-- Retorna as empresas em que a pessoa consta como sócia. Quando p_cpf é informado,
-- `confere` = os 6 dígitos do meio do CPF batem com o CPF mascarado do sócio (elimina
-- homônimo). Sem p_cpf, retorna todos os homônimos (confere = null).
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

grant execute on function public.buscar_empresas_por_socio(text, text) to authenticated, service_role;
