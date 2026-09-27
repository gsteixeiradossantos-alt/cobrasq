-- Rollback de 20260926_05: devolve o EXECUTE de PUBLIC (estado anterior, aberto ao anon).
grant execute on function public.buscar_empresas_por_email(text)                to public;
grant execute on function public.buscar_empresas_por_telefone(text)             to public;
grant execute on function public.buscar_empresas_por_endereco(text, text, text) to public;
grant execute on function public.rf_base_status()                               to public;
