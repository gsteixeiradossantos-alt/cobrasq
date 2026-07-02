-- ============================================================
-- ROLLBACK de 20260706_infra_bucket_avatars.sql
-- ============================================================
-- Remove as policies e o bucket `avatars`.
-- ATENÇÃO: só é possível apagar o bucket se ele estiver VAZIO. Se já houver avatares
-- enviados, esvazie antes (via painel Storage ou deletando os objects) — este rollback
-- NÃO apaga arquivos de usuários para evitar perda de dado silenciosa.

DROP POLICY IF EXISTS avatars_public_select ON storage.objects;
DROP POLICY IF EXISTS avatars_insert ON storage.objects;
DROP POLICY IF EXISTS avatars_update ON storage.objects;
DROP POLICY IF EXISTS avatars_delete ON storage.objects;

-- Só remove o bucket se estiver vazio (evita erro/perda). Descomente se tiver certeza:
-- DELETE FROM storage.buckets WHERE id = 'avatars';
