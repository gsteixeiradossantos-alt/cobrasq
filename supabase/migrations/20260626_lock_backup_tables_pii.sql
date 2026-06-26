-- SEGURANÇA (achado da auditoria 2026-06-26 — advisor ERROR rls_disabled_in_public):
-- 12 tabelas de backup/arquivo contêm PII (devedores/clientes/cobranças: nome, CPF, dívida)
-- e estavam EXPOSTAS sem RLS no schema public → legíveis por QUALQUER usuário logado
-- (anon/authenticated) via PostgREST. Esta migração TRANCA o acesso: habilita RLS
-- (sem policy = nega tudo a anon/authenticated; o service_role do backend segue acessando)
-- e revoga os grants diretos. NÃO apaga os backups (são reversíveis; ver rollback).
-- Aplicar em prod: Supabase dashboard -> SQL Editor.
--
-- Obs.: quando os backups não forem mais necessários, o ideal é DROPAR (mais limpo que
-- trancar). Aqui só trancamos para parar o vazamento sem risco de perda.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    '_backup_fase1_20260625_devedores',
    '_backup_fase1_20260625_cobrancas',
    '_backup_fase1_20260625_blob',
    '_backup_orfas_20260625',
    '_backup_genir_devolucao_20260625',
    '_backup_clientes_blob_20260625',
    '_backup_grupoeco_clientes_20260625',
    '_backup_grupoeco_appusers_20260625',
    '_backup_recuperar_orfaos_20260625',
    '_backup_regua_failed_20260625',
    '_backup_regua_config_20260625',
    '_arquivo_blob_cobrasq_data_20260625'
  ] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
