-- ============================================================================
-- Consultas da base Receita fechadas ao `anon` (auditoria 26/09/2026)
--
-- buscar_empresas_por_email/_telefone/_endereco e rf_base_status são SECURITY
-- DEFINER e não checam auth no corpo. A 20260912 deu grant para authenticated
-- e service_role, mas não revogou o EXECUTE padrão de PUBLIC — então `anon`
-- (chave publicável, embutida no index.html) executava as três buscas e lia
-- CNPJ/nome/contato da base inteira sem login. Conferido em prod em 26/09:
-- has_function_privilege('anon', …, 'execute') = true nas quatro.
--
-- Mesmo tratamento que buscar_empresas_por_socio já recebeu (anon = false).
-- Quem chama hoje: api/_cnpja.js via api/_sb.js (service_role) — não muda.
-- ============================================================================

revoke execute on function public.buscar_empresas_por_email(text)                 from public, anon;
revoke execute on function public.buscar_empresas_por_telefone(text)              from public, anon;
revoke execute on function public.buscar_empresas_por_endereco(text, text, text)  from public, anon;
revoke execute on function public.rf_base_status()                                from public, anon;

grant execute on function public.buscar_empresas_por_email(text)                  to authenticated, service_role;
grant execute on function public.buscar_empresas_por_telefone(text)               to authenticated, service_role;
grant execute on function public.buscar_empresas_por_endereco(text, text, text)   to authenticated, service_role;
grant execute on function public.rf_base_status()                                 to authenticated, service_role;
