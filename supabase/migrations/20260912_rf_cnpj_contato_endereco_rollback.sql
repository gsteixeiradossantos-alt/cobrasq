-- Rollback de 20260912_rf_cnpj_contato_endereco.sql
drop function if exists public.rf_base_status();
drop function if exists public.buscar_empresas_por_email(text);
drop function if exists public.buscar_empresas_por_endereco(text, text, text);
drop function if exists public.buscar_empresas_por_telefone(text);
drop index if exists public.idx_rf_estab_uf;
drop index if exists public.idx_rf_estab_cep_num;
drop index if exists public.idx_rf_estab_email;
drop index if exists public.idx_rf_estab_tel2;
drop index if exists public.idx_rf_estab_tel1;
alter table public.rf_empresas drop column if exists capital_social;
alter table public.rf_estabelecimentos
  drop column if exists data_situacao, drop column if exists motivo_situacao, drop column if exists data_inicio,
  drop column if exists cnae, drop column if exists tipo_logradouro, drop column if exists logradouro,
  drop column if exists numero, drop column if exists complemento, drop column if exists bairro,
  drop column if exists cep, drop column if exists telefone1, drop column if exists telefone2, drop column if exists email;
