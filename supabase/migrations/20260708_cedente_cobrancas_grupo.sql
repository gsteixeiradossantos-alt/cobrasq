-- Acesso do CEDENTE por GRUPO econômico.
-- As políticas de leitura por grupo já existiam em `clientes` (clientes_cedente_grupo)
-- e `devedores` (devedores_cedente_grupo / _parte), mas FALTAVAM em `cobrancas` e
-- `cobranca_partes` — sem elas o cedente de grupo lê as empresas e os devedores do
-- grupo, mas NÃO as cobranças. Estas duas políticas fecham o elo, espelhando o padrão
-- de devedores_cedente_grupo. Usam as funções já existentes current_user_grupo_economico()
-- (lê app_users.grupo_economico_id quando pode_ver_grupo=true) e current_user_grupo()
-- (matriz/filial via cliente_grupo_id). São permissivas (OR com as políticas _scope
-- de cliente único), então não afetam o cedente de cliente único.

create policy cobrancas_cedente_grupo on public.cobrancas
for select to authenticated
using (
  (current_user_grupo_economico() is not null and cliente_id in (
     select id from public.clientes where grupo_economico_id = current_user_grupo_economico()))
  or (current_user_grupo() is not null and cliente_id in (
     select id from public.clientes where cliente_grupo_id = current_user_grupo() or id = current_user_grupo()))
);

create policy cobranca_partes_cedente_grupo on public.cobranca_partes
for select to authenticated
using (
  cobranca_id in (
    select c.id from public.cobrancas c where
      (current_user_grupo_economico() is not null and c.cliente_id in (
         select id from public.clientes where grupo_economico_id = current_user_grupo_economico()))
      or (current_user_grupo() is not null and c.cliente_id in (
         select id from public.clientes where cliente_grupo_id = current_user_grupo() or id = current_user_grupo()))
  )
);
