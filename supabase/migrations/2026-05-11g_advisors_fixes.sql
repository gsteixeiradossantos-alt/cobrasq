-- Etapa 8: corrigir advisors restantes do CRM (profiles view + REVOKE PUBLIC)
-- Aplicada em produção via MCP em 2026-05-11.
-- Resultados antes/depois:
--   Antes: 3 ERROR + 14 WARN
--   Depois: 1 ERROR (fin_custodia_judicial_alertas, não-CRM) + 6 WARN (4 não-CRM)

-- 1. profiles: marcar security_invoker=true (resolve advisors 0002 + 0010)
CREATE OR REPLACE VIEW public.profiles
WITH (security_invoker=true) AS
SELECT
  u.id,
  (au.email)::text AS email,
  u.nome,
  CASE u.papel
    WHEN 'proprietario'::text THEN 'admin'::text
    WHEN 'colaborador'::text THEN 'operador'::text
    ELSE u.papel
  END AS role,
  u.ativo,
  u.created_at,
  u.avatar_url,
  u.avatar_cor
FROM app_users u
LEFT JOIN auth.users au ON au.id = u.id
WHERE u.papel = ANY (ARRAY['proprietario'::text, 'colaborador'::text]);

-- 2. REVOKE EXECUTE FROM PUBLIC (advisors 0028/0029)
REVOKE EXECUTE ON FUNCTION public.fn_casos_insert() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_casos_update() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_casos_delete() FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_profiles_update' AND pronamespace = 'public'::regnamespace) THEN
    REVOKE EXECUTE ON FUNCTION public.fn_profiles_update() FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

-- current_user_papel é SQL function chamada por TODAS as RLS policies (staff_all etc).
-- Precisa continuar executável por authenticated.
REVOKE EXECUTE ON FUNCTION public.current_user_papel() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_papel() TO authenticated;

-- 3. function_search_path_mutable em current_user_papel
ALTER FUNCTION public.current_user_papel() SET search_path = public, pg_temp;
