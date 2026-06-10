-- Cron diário às 3h UTC pra remover tokens vencidos do portal do devedor.
-- Função `limpar_portal_tokens_vencidos()` foi criada em
-- 20260609_portal_tokens.sql. Esta migration só agenda.
--
-- Idempotente: tenta criar; se já existe, ignora silenciosamente.

DO $$
BEGIN
  PERFORM cron.schedule(
    'cleanup_portal_tokens',
    '0 3 * * *',
    'SELECT public.limpar_portal_tokens_vencidos();'
  );
EXCEPTION
  WHEN unique_violation THEN NULL;  -- job já existe
  WHEN OTHERS THEN
    RAISE NOTICE 'Não foi possível agendar cron cleanup_portal_tokens: %', SQLERRM;
END $$;
