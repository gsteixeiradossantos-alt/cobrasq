-- ============================================================
--  COBRASQ FATURAMENTO — Setup completo do Supabase (Sprint 1)
-- ============================================================
--  Script único e idempotente (pode rodar várias vezes sem
--  quebrar). Cria as tabelas base, aplica RLS endurecido e
--  prepara tabelas auxiliares para Sprints seguintes.
--
--  COMO USAR:
--    1. Abra o SQL Editor no painel do Supabase
--    2. Cole todo o conteúdo deste arquivo
--    3. Clique em "Run"
--    4. Verifique em Database → Policies que cada tabela
--       mostra RLS ativo (ícone verde)
--
--  Requer: extensão pgcrypto ativa (necessária para
--          gen_random_uuid()). A Supabase já vem com ela.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 0. Extensão necessária para gen_random_uuid()
-- ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- 1. TABELAS BASE (o app usa essas hoje)
-- ─────────────────────────────────────────────────────────────

-- 1.1 Tabela principal: todo o DB do app (JSONB único)
CREATE TABLE IF NOT EXISTS public.cobrasq_data (
  key        TEXT PRIMARY KEY DEFAULT 'main',
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

-- 1.2 Tabela de usuários do app (papéis e acessos)
CREATE TABLE IF NOT EXISTS public.app_users (
  id         UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  nome       TEXT NOT NULL DEFAULT '',
  papel      TEXT NOT NULL DEFAULT 'colaborador'
             CHECK (papel IN ('proprietario','colaborador','cedente','devedor')),
  ref_id     TEXT DEFAULT '',   -- id do cliente/devedor quando aplicável
  cargo      TEXT DEFAULT '',
  ativo      BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1.3 Linha inicial vazia (evita erro no primeiro acesso do app)
INSERT INTO public.cobrasq_data (key, data) VALUES ('main', '{}')
  ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 2. HELPER: função que retorna o papel do usuário autenticado
--    Usada nas policies abaixo.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_user_papel()
RETURNS TEXT
LANGUAGE SQL
STABLE SECURITY DEFINER
AS $$
  SELECT papel FROM public.app_users WHERE id = auth.uid();
$$;

-- ─────────────────────────────────────────────────────────────
-- 3. RLS: app_users
--    • usuário lê/edita o próprio registro
--    • proprietário vê e gerencia todos
--    • apenas proprietário deleta
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own_read_users"               ON public.app_users;
DROP POLICY IF EXISTS "own_insert_users"             ON public.app_users;
DROP POLICY IF EXISTS "own_update_users"             ON public.app_users;
DROP POLICY IF EXISTS "users_read_self_or_owner"     ON public.app_users;
DROP POLICY IF EXISTS "users_insert_only_owner"      ON public.app_users;
DROP POLICY IF EXISTS "users_update_self_or_owner"   ON public.app_users;
DROP POLICY IF EXISTS "users_delete_only_owner"      ON public.app_users;

CREATE POLICY "users_read_self_or_owner" ON public.app_users
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR public.current_user_papel() = 'proprietario'
  );

CREATE POLICY "users_insert_only_owner" ON public.app_users
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_papel() = 'proprietario'
    OR id = auth.uid()  -- self-provision no primeiro login
  );

CREATE POLICY "users_update_self_or_owner" ON public.app_users
  FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    OR public.current_user_papel() = 'proprietario'
  );

CREATE POLICY "users_delete_only_owner" ON public.app_users
  FOR DELETE TO authenticated
  USING (public.current_user_papel() = 'proprietario');

-- ─────────────────────────────────────────────────────────────
-- 4. RLS: cobrasq_data
--    Leitura: qualquer autenticado (filtro por escopo é no app)
--    Escrita: apenas proprietario/colaborador (gestor)
--    Delete: só proprietario
--    Nota: o filtro fino por tenant é feito pelo app. A migração
--    futura quebra isso em tabelas dedicadas (ver bloco 7).
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.cobrasq_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authed_read_data"      ON public.cobrasq_data;
DROP POLICY IF EXISTS "authed_insert_data"    ON public.cobrasq_data;
DROP POLICY IF EXISTS "authed_update_data"    ON public.cobrasq_data;
DROP POLICY IF EXISTS "data_read_all_authed"  ON public.cobrasq_data;
DROP POLICY IF EXISTS "data_insert_only_staff" ON public.cobrasq_data;
DROP POLICY IF EXISTS "data_update_only_staff" ON public.cobrasq_data;
DROP POLICY IF EXISTS "data_delete_only_owner" ON public.cobrasq_data;

CREATE POLICY "data_read_all_authed" ON public.cobrasq_data
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "data_insert_only_staff" ON public.cobrasq_data
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));

CREATE POLICY "data_update_only_staff" ON public.cobrasq_data
  FOR UPDATE TO authenticated
  USING (public.current_user_papel() IN ('proprietario','colaborador'));

CREATE POLICY "data_delete_only_owner" ON public.cobrasq_data
  FOR DELETE TO authenticated
  USING (public.current_user_papel() = 'proprietario');

-- ─────────────────────────────────────────────────────────────
-- 5. AUDIT LOG — substitui DB.auditLog do localStorage
--    Append-only com RLS por papel.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  actor_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,       -- ex: 'devedor.update', 'cobranca.create'
  entity     TEXT,                -- ex: 'devedor', 'cobranca'
  entity_id  TEXT,                -- id do alvo
  metadata   JSONB NOT NULL DEFAULT '{}',
  ip         INET,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx      ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx     ON public.audit_logs(entity, entity_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_insert_authed" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_read"           ON public.audit_logs;

-- Inserts: autenticado só registra ações próprias
CREATE POLICY "audit_insert_authed" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_id = auth.uid() OR actor_id IS NULL
  );

-- Leitura: proprietário vê tudo; colaborador vê só próprio histórico
CREATE POLICY "audit_read" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    public.current_user_papel() = 'proprietario'
    OR actor_id = auth.uid()
  );

-- Sem policies de UPDATE/DELETE → append-only.

-- ─────────────────────────────────────────────────────────────
-- 6. RATE LIMITING — tentativas de login (registro)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  ip         INET,
  actor      TEXT,                  -- email ou CPF truncado
  success    BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS login_attempts_ip_created_idx
  ON public.login_attempts(ip, created_at DESC);

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "login_attempts_insert"      ON public.login_attempts;
DROP POLICY IF EXISTS "login_attempts_read_owner"  ON public.login_attempts;

CREATE POLICY "login_attempts_insert" ON public.login_attempts
  FOR INSERT TO authenticated, anon WITH CHECK (true);

CREATE POLICY "login_attempts_read_owner" ON public.login_attempts
  FOR SELECT TO authenticated
  USING (public.current_user_papel() = 'proprietario');

-- ─────────────────────────────────────────────────────────────
-- 7. [PREPARAÇÃO] Tabelas dedicadas (multi-tenant real)
--    Criadas mas ainda não usadas pelo app. A migração
--    gradual será feita no Sprint 3 (Portal Cedente + permissões).
-- ─────────────────────────────────────────────────────────────

-- Clientes (cedentes)
CREATE TABLE IF NOT EXISTS public.clientes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id UUID REFERENCES public.app_users(id),
  nome        TEXT NOT NULL,
  doc         TEXT,
  email       TEXT,
  telefone    TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clientes_staff_all"     ON public.clientes;
DROP POLICY IF EXISTS "clientes_cedente_self"  ON public.clientes;

CREATE POLICY "clientes_staff_all" ON public.clientes
  FOR ALL TO authenticated
  USING (public.current_user_papel() IN ('proprietario','colaborador'))
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));

CREATE POLICY "clientes_cedente_self" ON public.clientes
  FOR SELECT TO authenticated
  USING (app_user_id = auth.uid());

-- Devedores
CREATE TABLE IF NOT EXISTS public.devedores (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id     UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  nome           TEXT NOT NULL,
  doc            TEXT,
  doc_hash       TEXT,
  email          TEXT,
  telefone       TEXT,
  status         TEXT,
  fase           TEXT DEFAULT 'extrajudicial',
  valor_orig     NUMERIC(14,2),
  valor_atual    NUMERIC(14,2),
  data_entrada   DATE,
  responsavel_id UUID REFERENCES public.app_users(id),
  arquivado      BOOLEAN DEFAULT FALSE,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS devedores_cliente_idx  ON public.devedores(cliente_id);
CREATE INDEX IF NOT EXISTS devedores_doc_hash_idx ON public.devedores(doc_hash);
ALTER TABLE public.devedores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "devedores_staff_all"     ON public.devedores;
DROP POLICY IF EXISTS "devedores_cedente_scope" ON public.devedores;
DROP POLICY IF EXISTS "devedores_self"          ON public.devedores;

CREATE POLICY "devedores_staff_all" ON public.devedores
  FOR ALL TO authenticated
  USING (public.current_user_papel() IN ('proprietario','colaborador'))
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));

CREATE POLICY "devedores_cedente_scope" ON public.devedores
  FOR SELECT TO authenticated
  USING (
    cliente_id IN (SELECT id FROM public.clientes WHERE app_user_id = auth.uid())
  );

CREATE POLICY "devedores_self" ON public.devedores
  FOR SELECT TO authenticated
  USING (
    id::text = (SELECT ref_id FROM public.app_users WHERE id = auth.uid() AND papel = 'devedor')
  );

-- ─────────────────────────────────────────────────────────────
-- FIM. Confira em Database → Policies que tudo está com RLS
-- ativo (ícone verde). Depois crie seu primeiro usuário admin:
--
--   1. Authentication → Users → Invite user (seu e-mail)
--   2. Depois de criar, pegue o UUID em Authentication → Users
--   3. Rode aqui:
--        INSERT INTO app_users (id, nome, papel)
--        VALUES ('SEU_UUID_AQUI', 'Seu Nome', 'proprietario');
--
-- Pronto — você é o proprietário do sistema.
-- ─────────────────────────────────────────────────────────────
