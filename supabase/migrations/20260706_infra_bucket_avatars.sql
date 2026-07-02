-- ============================================================
-- PREPARADA — NÃO APLICAR SEM REVISÃO
-- ============================================================
-- Bucket de Storage `avatars` (fotos de perfil dos usuários) + policies.
--
-- Motivação: crm.html já FAZ upload em `sb.storage.from('avatars')` e lê via
-- getPublicUrl (path = `<user_id>/avatar-<ts>-<arquivo>`), mas o bucket nunca foi criado
-- — a subida falha. Este arquivo cria o bucket e as policies para o fluxo funcionar.
--
-- DECISÕES (documentadas):
--   * LEITURA: pública. O app monta a foto via getPublicUrl e a exibe em topbar/listas;
--     avatar não é dado sensível. Bucket `public = true`.
--   * ESCRITA (insert/update/delete): autenticado E (dono da pasta OU staff). "Dono" =
--     primeiro segmento do path == auth.uid() (é como o CRM grava: `<uid>/...`). Isso
--     deixa cada usuário trocar a PRÓPRIA foto; e o staff (proprietario/colaborador)
--     pode gerenciar qualquer avatar (ex.: definir a foto de um usuário recém-criado).
--   * Limites: só imagens, até 5 MB.
--
-- APLICAR MANUALMENTE no SQL Editor do projeto jokbxzhcctcwnbhkhgru. Rollback em _rollback.sql.

-- 1) Bucket (idempotente). Público p/ leitura; limite 5 MB; só imagens.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars', 'avatars', true, 5242880,
  ARRAY['image/png','image/jpeg','image/jpg','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2) Policies em storage.objects (RLS já habilitada por padrão no schema storage).

-- Leitura pública (qualquer um, inclusive anon) — coerente com bucket público.
DROP POLICY IF EXISTS avatars_public_select ON storage.objects;
CREATE POLICY avatars_public_select ON storage.objects
  FOR SELECT
  USING (bucket_id = 'avatars');

-- Escrita: dono da própria pasta (<uid>/...) OU staff.
DROP POLICY IF EXISTS avatars_insert ON storage.objects;
CREATE POLICY avatars_insert ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid() IS NOT NULL
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR current_user_papel() = ANY (ARRAY['proprietario','colaborador'])
    )
  );

DROP POLICY IF EXISTS avatars_update ON storage.objects;
CREATE POLICY avatars_update ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND auth.uid() IS NOT NULL
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR current_user_papel() = ANY (ARRAY['proprietario','colaborador'])
    )
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid() IS NOT NULL
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR current_user_papel() = ANY (ARRAY['proprietario','colaborador'])
    )
  );

DROP POLICY IF EXISTS avatars_delete ON storage.objects;
CREATE POLICY avatars_delete ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND auth.uid() IS NOT NULL
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR current_user_papel() = ANY (ARRAY['proprietario','colaborador'])
    )
  );
