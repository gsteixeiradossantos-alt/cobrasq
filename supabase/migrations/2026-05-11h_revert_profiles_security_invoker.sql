-- Reverte profiles pra SECURITY DEFINER: authenticated não tem GRANT em auth.users,
-- então security_invoker fazia email vir NULL. Aceitar o advisor warning é melhor que
-- quebrar leitura de email pra todos os usuários.
-- Cols expostas (nome/email/role/avatar) não são sensíveis.
-- Aplicada em produção via MCP em 2026-05-11.

CREATE OR REPLACE VIEW public.profiles
WITH (security_invoker=false) AS
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

COMMENT ON VIEW public.profiles IS 'SECURITY DEFINER intencional: authenticated não tem GRANT em auth.users.email. Cols expostas (nome/email/role/avatar) não são sensíveis.';
