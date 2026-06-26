-- Rollback de 20260626_lock_backup_tables_pii.sql (desfaz a tranca — NÃO recomendado,
-- reexpõe PII). Mantido só por completude.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    '_backup_fase1_20260625_devedores','_backup_fase1_20260625_cobrancas','_backup_fase1_20260625_blob',
    '_backup_orfas_20260625','_backup_genir_devolucao_20260625','_backup_clientes_blob_20260625',
    '_backup_grupoeco_clientes_20260625','_backup_grupoeco_appusers_20260625','_backup_recuperar_orfaos_20260625',
    '_backup_regua_failed_20260625','_backup_regua_config_20260625','_arquivo_blob_cobrasq_data_20260625'
  ] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
