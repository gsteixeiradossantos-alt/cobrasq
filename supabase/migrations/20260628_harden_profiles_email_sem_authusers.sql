-- 20260628_harden_profiles_email_sem_authusers.sql
-- APLICADA EM PROD via MCP em 2026-06-28 (este arquivo é o registro versionado / parity).
--
-- Objetivo: limpar os advisors da view `public.profiles`
--   - auth_users_exposed (ERROR): a view fazia JOIN em auth.users só para o email.
--   - security_definer_view (ERROR): a view era SECURITY DEFINER p/ entregar o roster ao colaborador.
-- ...sem quebrar login / lista de equipe / updates de avatar-nome (INSTEAD OF trg_profiles_update).
--
-- Como: email passa a viver em app_users (auto-sincronizado por trigger a partir de auth.users);
-- a view deixa de tocar auth.users e vira security_invoker; o SELECT de app_users é alargado para
-- staff (mesma informação que a view já expunha — e conserta o roster do colaborador, que pela RLS
-- antiga só enxergava a própria linha). Idempotente.

-- 1) Coluna email em app_users
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS email text;

-- 2) Trigger que mantém email sincronizado com auth.users (robusto p/ criação manual de usuário)
CREATE OR REPLACE FUNCTION public.fn_app_users_fill_email()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  IF NEW.email IS NULL THEN
    SELECT au.email INTO NEW.email FROM auth.users au WHERE au.id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_app_users_fill_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_app_users_fill_email() FROM anon, authenticated;
DROP TRIGGER IF EXISTS trg_app_users_fill_email ON public.app_users;
CREATE TRIGGER trg_app_users_fill_email BEFORE INSERT OR UPDATE ON public.app_users
  FOR EACH ROW EXECUTE FUNCTION public.fn_app_users_fill_email();

-- 3) Backfill dos usuários existentes
UPDATE public.app_users u SET email = au.email
FROM auth.users au WHERE au.id = u.id AND u.email IS DISTINCT FROM au.email;

-- 4) Alargar SELECT de app_users para staff (equivalente ao que a view já expunha)
DROP POLICY IF EXISTS users_read_self_or_owner ON public.app_users;
CREATE POLICY users_read_self_or_staff ON public.app_users FOR SELECT
  USING ((id = auth.uid()) OR (current_user_papel() = ANY (ARRAY['proprietario','colaborador'])));

-- 5) Recriar a view sem tocar auth.users + security_invoker (preserva colunas e o INSTEAD OF trigger)
CREATE OR REPLACE VIEW public.profiles AS
SELECT u.id,
       u.email AS email,
       u.nome,
       CASE u.papel
         WHEN 'proprietario' THEN 'admin'
         WHEN 'colaborador'  THEN 'operador'
         ELSE u.papel
       END AS role,
       u.ativo,
       u.created_at,
       u.avatar_url,
       u.avatar_cor
FROM public.app_users u
WHERE u.papel = ANY (ARRAY['proprietario','colaborador']);
ALTER VIEW public.profiles SET (security_invoker = on);
