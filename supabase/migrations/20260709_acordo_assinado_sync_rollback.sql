-- 20260709_acordo_assinado_sync_rollback
-- Remove o trigger e a funcao de sync de acordo assinado. Nao desfaz o backfill (dado).

DROP TRIGGER IF EXISTS trg_acordo_assinado_sync ON public.acordos;
DROP FUNCTION IF EXISTS public.fn_acordo_assinado_sync();
