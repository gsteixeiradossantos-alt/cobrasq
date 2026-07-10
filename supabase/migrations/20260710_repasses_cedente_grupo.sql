-- Acesso do CEDENTE por GRUPO econômico à tabela `repasses_cliente`.
-- Espelha 20260708_cedente_cobrancas_grupo.sql. A `repasses_cliente` só tinha a
-- política `repasses_cedente_scope` (cliente_id via clientes.app_user_id = auth.uid()),
-- que NÃO cobre o cedente de grupo — cujas cobranças/repasses ficam sob as EMPRESAS do
-- grupo, não sob o id do grupo. Efeito: o portal do cedente de grupo lê a carteira
-- (cobrancas_cedente_grupo existe) mas mostrava "Repassado a você R$ 0,00", porque
-- os repasses eram invisíveis por RLS.
--
-- Esta política permissiva (OR) usa as funções já existentes current_user_grupo_economico()
-- e current_user_grupo(), escopando por repasses_cliente.cliente_id (coluna populada em
-- todos os registros). Só SELECT: a escrita continua restrita a proprietário/colaborador.

create policy repasses_cedente_grupo on public.repasses_cliente
for select to authenticated
using (
  (current_user_grupo_economico() is not null and cliente_id in (
     select id from public.clientes where grupo_economico_id = current_user_grupo_economico()))
  or (current_user_grupo() is not null and cliente_id in (
     select id from public.clientes where cliente_grupo_id = current_user_grupo() or id = current_user_grupo()))
);
