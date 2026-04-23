-- ============================================================
--  COBRASQ FATURAMENTO — Segurança do Supabase (Sprint 1)
-- ============================================================
--  Este script reforça as policies de Row-Level Security (RLS)
--  do banco existente. Rode no SQL Editor do Supabase.
--
--  Assume que você já rodou o schema base que cria:
--    • cobrasq_data (key, data jsonb, updated_at, updated_by)
--    • app_users (id, nome, papel, ref_id, cargo, ativo)
--
--  Se ainda não tem, o script base está em index.html → Configurações
--  → Integrações → Supabase → "Ver SQL". Rode esse PRIMEIRO.
--
--  Depois, rode tudo abaixo.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Helper: função que retorna o papel do usuário autenticado
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_user_papel()
RETURNS TEXT
LANGUAGE SQL
STABLE SECURITY DEFINER
AS $$
  SELECT papel FROM public.app_users WHERE id = auth.uid();
$$;

-- ─────────────────────────────────────────────────────────────
-- 2. Endurece policies de app_users
--    • Usuário comum lê/edita apenas o próprio registro
--    • Proprietário enxerga e gerencia todos
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "own_read_users" ON public.app_users;
DROP POLICY IF EXISTS "own_insert_users" ON public.app_users;
DROP POLICY IF EXISTS "own_update_users" ON public.app_users;

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
-- 3. Endurece policies de cobrasq_data
--    • Leitura: qualquer autenticado (o filtro fino vive no app)
--      Nota: idealmente deveria ser por escopo, mas o modelo
--      atual é single-row JSON. Migração futura quebra isso em
--      tabelas por entidade (ver bloco 5 abaixo).
--    • Escrita: apenas proprietario e colaborador
--      (cedente e devedor NUNCA gravam na tabela gestor)
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authed_read_data"   ON public.cobrasq_data;
DROP POLICY IF EXISTS "authed_insert_data" ON public.cobrasq_data;
DROP POLICY IF EXISTS "authed_update_data" ON public.cobrasq_data;

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
-- 4. Audit Log (substitui DB.auditLog em localStorage)
--    Tabela append-only, com RLS por papel.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  actor_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,                -- ex: 'devedor.update', 'cobranca.create'
  entity     TEXT,                         -- ex: 'devedor', 'cobranca'
  entity_id  TEXT,                         -- id do alvo
  metadata   JSONB NOT NULL DEFAULT '{}',
  ip         INET,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx      ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx     ON public.audit_logs(entity, entity_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Inserts: qualquer autenticado (só registra suas próprias ações)
DROP POLICY IF EXISTS "audit_insert_authed" ON public.audit_logs;
CREATE POLICY "audit_insert_authed" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_id = auth.uid()
    OR actor_id IS NULL
  );

-- Leitura: proprietário vê tudo; colaborador vê só próprio histórico
DROP POLICY IF EXISTS "audit_read" ON public.audit_logs;
CREATE POLICY "audit_read" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    public.current_user_papel() = 'proprietario'
    OR actor_id = auth.uid()
  );

-- Ninguém faz UPDATE/DELETE em audit_logs (append-only)

-- ─────────────────────────────────────────────────────────────
-- 5. [PREPARAÇÃO] Tabelas por escopo para migração futura
--    Hoje tudo vive em cobrasq_data.data (JSON gigante). A
--    migração para essas tabelas permite RLS de verdade:
--    cada cedente só vê seus próprios devedores etc.
--
--    Essas tabelas são CRIADAS mas ainda não usadas pelo app.
--    O app vai migrar gradualmente no Sprint 3.
-- ─────────────────────────────────────────────────────────────

-- Clientes (cedentes)
CREATE TABLE IF NOT EXISTS public.clientes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id  UUID REFERENCES public.app_users(id),
  nome         TEXT NOT NULL,
  doc          TEXT,
  email        TEXT,
  telefone     TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clientes_staff_all" ON public.clientes;
CREATE POLICY "clientes_staff_all" ON public.clientes
  FOR ALL TO authenticated
  USING (public.current_user_papel() IN ('proprietario','colaborador'))
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));

DROP POLICY IF EXISTS "clientes_cedente_self" ON public.clientes;
CREATE POLICY "clientes_cedente_self" ON public.clientes
  FOR SELECT TO authenticated
  USING (app_user_id = auth.uid());

-- Devedores
CREATE TABLE IF NOT EXISTS public.devedores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id    UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  nome          TEXT NOT NULL,
  doc           TEXT,                  -- CPF/CNPJ
  doc_hash      TEXT,                  -- hash para login devedor (se for só por CPF+nasc)
  email         TEXT,
  telefone      TEXT,
  status        TEXT,
  fase          TEXT DEFAULT 'extrajudicial',
  valor_orig    NUMERIC(14,2),
  valor_atual   NUMERIC(14,2),
  data_entrada  DATE,
  responsavel_id UUID REFERENCES public.app_users(id),
  arquivado     BOOLEAN DEFAULT FALSE,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS devedores_cliente_idx ON public.devedores(cliente_id);
CREATE INDEX IF NOT EXISTS devedores_doc_hash_idx ON public.devedores(doc_hash);
ALTER TABLE public.devedores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "devedores_staff_all" ON public.devedores;
CREATE POLICY "devedores_staff_all" ON public.devedores
  FOR ALL TO authenticated
  USING (public.current_user_papel() IN ('proprietario','colaborador'))
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));

DROP POLICY IF EXISTS "devedores_cedente_scope" ON public.devedores;
CREATE POLICY "devedores_cedente_scope" ON public.devedores
  FOR SELECT TO authenticated
  USING (
    cliente_id IN (SELECT id FROM public.clientes WHERE app_user_id = auth.uid())
  );

-- devedor vê só a própria dívida (via função que confere ref_id = devedor.id)
DROP POLICY IF EXISTS "devedores_self" ON public.devedores;
CREATE POLICY "devedores_self" ON public.devedores
  FOR SELECT TO authenticated
  USING (
    id::text = (SELECT ref_id FROM public.app_users WHERE id = auth.uid() AND papel = 'devedor')
  );

-- ─────────────────────────────────────────────────────────────
-- 6. Rate limiting básico (tenta bloquear força bruta em login devedor)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id BIGSERIAL PRIMARY KEY,
  ip INET,
  actor TEXT,           -- email ou CPF truncado
  success BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS login_attempts_ip_created_idx ON public.login_attempts(ip, created_at DESC);

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "login_attempts_insert" ON public.login_attempts
  FOR INSERT TO authenticated, anon WITH CHECK (true);
CREATE POLICY "login_attempts_read_owner" ON public.login_attempts
  FOR SELECT TO authenticated
  USING (public.current_user_papel() = 'proprietario');

-- ─────────────────────────────────────────────────────────────
-- FIM. Teste rodando este script inteiro e conferindo em
-- Database → Policies que todas as tabelas mostram RLS ATIVO.
-- ─────────────────────────────────────────────────────────────
