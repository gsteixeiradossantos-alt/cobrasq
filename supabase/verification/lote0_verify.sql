-- ============================================================================
-- LOTE 0 — VERIFICAÇÃO READ-ONLY DO PROD (Supabase jokbxzhcctcwnbhkhgru)
-- ============================================================================
-- Casa de duas portas: este projeto Supabase é compartilhado por DOIS apps
-- (cobrasq-faturamento + crm-cobrasq). Estas queries NÃO escrevem nada.
--
-- POR QUE EXISTE: o schema de prod foi aplicado historicamente via Supabase MCP,
-- então os arquivos de migration PODEM NÃO refletir o estado real. Antes de
-- aplicar QUALQUER fix de RLS/schema (F-03, F-04, F-05, F-11), rode este script
-- no SQL Editor do Supabase e confronte cada resultado com o "CONFIRMA / REBATE"
-- anotado em cada bloco.
--
-- SEGURANÇA: somente SELECT sobre pg_catalog / information_schema / tabelas de
-- identidade. NENHUM INSERT/UPDATE/DELETE/ALTER/CREATE. Pode rodar como qualquer
-- papel; idealmente rode como o role do SQL Editor (postgres) para enxergar tudo.
-- ============================================================================


-- ============================================================================
-- F-03 — RLS em fin_custodia_judicial
-- ----------------------------------------------------------------------------
-- HIPÓTESE: a migration migrations/2026-05-09_fin_judicial.sql cria a tabela
-- SEM `enable row level security` e SEM policy. Se o prod refletir o arquivo,
-- QUALQUER autenticado lê/escreve dados financeiros e judiciais via PostgREST
-- (valores bloqueados/sacados, processo, comarca). A view *_alertas
-- (security_invoker) não protege a base sem policy.
-- ============================================================================

-- F-03.a — RLS está ENABLED na tabela base?
--   CONFIRMA a hipótese (vulnerável)  → relrowsecurity = false  (RLS DESLIGADA)
--   REBATE  a hipótese (já protegida) → relrowsecurity = true
--   Observe também relforcerowsecurity (force RLS p/ donos da tabela).
SELECT n.nspname        AS schema,
       c.relname        AS tabela,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'fin_custodia_judicial';

-- F-03.b — Quais policies existem na tabela?
--   CONFIRMA (vulnerável) → ZERO linhas (nenhuma policy). Com RLS off OU
--                           RLS on + 0 policies o acesso fica aberto/negado-
--                           -total dependendo do flag acima; o perigo real é
--                           RLS off (acesso total). Se RLS on e 0 policies,
--                           a tabela na verdade NEGA tudo a authenticated.
--   REBATE  (protegida)   → 1+ policy proprietario-only alinhada aos demais fin_*.
SELECT pol.polname                                   AS policy,
       pol.polcmd                                    AS comando,   -- r=SELECT a=INSERT w=UPDATE d=DELETE *=ALL
       pg_get_expr(pol.polqual, pol.polrelid)        AS using_expr,
       pg_get_expr(pol.polwithcheck, pol.polrelid)   AS check_expr,
       ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)) AS roles
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'fin_custodia_judicial';

-- F-03.c — Baseline de comparação: como estão os demais fin_* (devem ter RLS on
--          + policy *_owner_all proprietario-only). Mostra o "padrão correto".
--   Use para confirmar que fin_custodia_judicial está FORA do padrão.
SELECT c.relname        AS tabela,
       c.relrowsecurity AS rls_enabled,
       count(pol.polname) AS n_policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relname LIKE 'fin\_%'
  AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;


-- ============================================================================
-- F-04 — security_invoker da view `casos`
-- ----------------------------------------------------------------------------
-- HIPÓTESE: drift cross-repo. CRM setou security_invoker=true; o faturamento
-- redefiniu `casos` (20260609_view_casos_status_mesclado.sql) SEM declarar
-- security_invoker. Se a redefinição do faturamento foi a ÚLTIMA aplicada, a
-- view volta a rodar como DEFINER (dona = postgres) e ignora a RLS de
-- devedores/clientes → todo colaborador vê TODOS os casos (vazamento cross-tenant).
-- ============================================================================

-- F-04.a — Estado atual do flag security_invoker.
--   CONFIRMA (vulnerável) → security_invoker AUSENTE / 'false'  (roda como DEFINER)
--   REBATE  (seguro)      → security_invoker = 'true'
-- reloptions lista as options da view; security_invoker aparece como
-- 'security_invoker=true' quando setado.
SELECT n.nspname     AS schema,
       c.relname     AS view,
       c.relkind     AS tipo,     -- 'v' = view comum
       c.reloptions  AS opcoes,   -- procure 'security_invoker=true' aqui
       (EXISTS (
          SELECT 1 FROM unnest(COALESCE(c.reloptions, '{}')) opt
          WHERE opt ILIKE 'security_invoker=true'
       ))            AS security_invoker_on
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'casos';

-- F-04.b — Definição atual da view (confronte com o arquivo do faturamento
--          para saber QUAL versão está no prod).
SELECT pg_get_viewdef('public.casos'::regclass, true) AS casos_definition;

-- F-04.c — Dono da view (se DEFINER, é a RLS DESTE dono que é ignorada).
--   Tipicamente 'postgres' → como superuser/owner, bypassa RLS das tabelas base.
SELECT c.relname AS view, pg_get_userbyid(c.relowner) AS dono
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'casos';


-- ============================================================================
-- F-05 — app_users vs profiles são disjuntos? + def. de current_user_papel()
-- ----------------------------------------------------------------------------
-- HIPÓTESE: identidade dupla. Faturamento usa app_users (lida por
-- current_user_papel()); CRM usa profiles. Sem sync entre elas. Um usuário com
-- linha só numa das tabelas tem autorização incoerente entre os dois apps →
-- raiz das queixas (gestor não vê atividade, estagiária não vê cadastros).
-- ============================================================================

-- F-05.a — As duas tabelas existem? (pré-condição)
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('app_users','profiles')
ORDER BY table_name;

-- F-05.b — Definição de current_user_papel() (de QUAL tabela ele lê o papel?).
--   ESPERADO: lê de public.app_users WHERE id = auth.uid().
--   CONFIRMA F-05 → função olha SÓ app_users; quem só tem linha em profiles
--                   retorna NULL aqui (cai no escopo restrito do RLS multi-tenant).
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       l.lanname        AS linguagem,
       p.prosecdef      AS security_definer,
       pg_get_functiondef(p.oid) AS definicao
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language  l ON l.oid = p.prolang
WHERE n.nspname = 'public'
  AND p.proname = 'current_user_papel';

-- F-05.c — Contagens brutas em cada tabela de identidade.
SELECT 'app_users' AS tabela, count(*) AS n FROM public.app_users
UNION ALL
SELECT 'profiles'  AS tabela, count(*) AS n FROM public.profiles;

-- F-05.d — Sobreposição/disjunção por auth uid.
--   Cada linha classifica um uid: presente em ambas, só em app_users, só em profiles.
--   CONFIRMA F-05 (disjuntas/parciais) → existem linhas 'so_app_users' e/ou
--                                        'so_profiles' (e poucas/zero 'ambas').
--   REBATE  (já alinhadas)            → quase tudo cai em 'ambas'.
-- NOTA: assume app_users.id = auth uid e profiles.id = auth uid (padrão Supabase).
--       Se o seu profiles usa outra coluna p/ o uid (ex.: user_id), ajuste o JOIN.
WITH a AS (SELECT id AS uid FROM public.app_users),
     p AS (SELECT id AS uid FROM public.profiles)
SELECT
  CASE
    WHEN a.uid IS NOT NULL AND p.uid IS NOT NULL THEN 'ambas'
    WHEN a.uid IS NOT NULL                       THEN 'so_app_users'
    ELSE                                              'so_profiles'
  END AS situacao,
  count(*) AS n
FROM a FULL OUTER JOIN p ON a.uid = p.uid
GROUP BY 1
ORDER BY 1;

-- F-05.e — Detalhe: papel/role de cada lado por uid (lista os divergentes).
--   Útil pra ver gestor com papel só em profiles.role mas sem linha em app_users.
WITH a AS (SELECT id AS uid, papel FROM public.app_users),
     p AS (SELECT id AS uid, role  FROM public.profiles)
SELECT COALESCE(a.uid, p.uid) AS uid,
       a.papel  AS app_users_papel,
       p.role   AS profiles_role
FROM a FULL OUTER JOIN p ON a.uid = p.uid
WHERE a.uid IS NULL OR p.uid IS NULL          -- só os que faltam num dos lados
ORDER BY uid;

-- F-05.f — Quais policies do projeto checam profiles.role (precisarão migrar
--          para current_user_papel() se a opção B do fix for escolhida).
--   CONFIRMA o split de fonte → aparecem policies (esp. crm_*) referenciando 'profiles'.
SELECT n.nspname AS schema,
       c.relname AS tabela,
       pol.polname AS policy,
       pg_get_expr(pol.polqual, pol.polrelid)      AS using_expr,
       pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND (pg_get_expr(pol.polqual, pol.polrelid)      ILIKE '%profiles%'
    OR pg_get_expr(pol.polwithcheck, pol.polrelid) ILIKE '%profiles%')
ORDER BY c.relname, pol.polname;


-- ============================================================================
-- F-11 — Tabelas "admin-only" sem RLS de retaguarda
-- ----------------------------------------------------------------------------
-- HIPÓTESE: o RBAC do front (ADMIN_ONLY_PAGES no faturamento ~4529-4534;
-- renderAdmin/alternarRole no CRM) só esconde a UI. Sem RLS na tabela, o
-- bypass via DevTools/PostgREST lê/escreve direto. Achar tabelas SENSÍVEIS
-- com RLS desligada OU sem nenhuma policy.
-- ============================================================================

-- F-11.a — TODAS as tabelas public e seu estado de RLS + nº de policies.
--   CONFIRMA (vulnerável)  → rls_enabled=false  OU (rls_enabled=true e n_policies=0
--                            quando a intenção era ter policy)  para tabelas sensíveis.
--   Atenção especial às que aparecem na matriz como admin/staff-only:
--   fin_*, fin_custodia_judicial, pedidos_aprovacao, regua_envios,
--   user_integrations, calendar_events_sync, app_users, e quaisquer crm_*/peticao_*.
SELECT c.relname            AS tabela,
       c.relrowsecurity     AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       count(pol.polname)   AS n_policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'                 -- só tabelas comuns (views não têm RLS própria)
GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
ORDER BY c.relrowsecurity ASC, n_policies ASC, c.relname;   -- piores casos no topo

-- F-11.b — Grants diretos a anon/authenticated (defesa adicional além de RLS).
--   CONFIRMA risco → uma tabela SEM RLS com grant amplo a authenticated/anon
--                    está totalmente exposta via PostgREST.
SELECT table_name,
       grantee,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privilegios
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon','authenticated')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;

-- ============================================================================
-- FIM — nada acima escreve no banco. Salve a saída e use no apply de cada fix.
-- ============================================================================
