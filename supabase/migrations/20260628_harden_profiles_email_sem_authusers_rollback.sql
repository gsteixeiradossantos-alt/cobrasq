-- ROLLBACK de 20260628_harden_profiles_email_sem_authusers.sql
-- Restaura a view profiles (SECURITY DEFINER + JOIN em auth.users), a policy antiga de app_users,
-- e remove o trigger/função/coluna de email. (Volta ao estado com os 2 advisors da profiles.)

CREATE OR REPLACE VIEW public.profiles AS
SELECT u.id,
       au.email::text AS email,
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
  LEFT JOIN auth.users au ON au.id = u.id
WHERE (u.papel = ANY (ARRAY['proprietario','colaborador']))
  AND (current_user_papel() = ANY (ARRAY['proprietario','colaborador']));
ALTER VIEW public.profiles RESET (security_invoker);

DROP POLICY IF EXISTS users_read_self_or_staff ON public.app_users;
CREATE POLICY users_read_self_or_owner ON public.app_users FOR SELECT
  USING ((id = auth.uid()) OR (current_user_papel() = 'proprietario'::text));

DROP TRIGGER IF EXISTS trg_app_users_fill_email ON public.app_users;
DROP FUNCTION IF EXISTS public.fn_app_users_fill_email();
ALTER TABLE public.app_users DROP COLUMN IF EXISTS email;
