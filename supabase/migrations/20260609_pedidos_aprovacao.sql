-- Approval queue: ações sensíveis do colaborador viram pedidos pendentes
-- que o proprietário aprova/rejeita. Sem DELETE policy → audit trail imutável.

DO $$ BEGIN
  CREATE TYPE pedido_aprovacao_status AS ENUM
    ('pendente','aprovado','rejeitado','executado','cancelado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.pedidos_aprovacao (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo              text NOT NULL,
  recurso_id        text NOT NULL,
  resumo            text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  solicitante_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  solicitante_nome  text NOT NULL,
  solicitado_em     timestamptz NOT NULL DEFAULT now(),
  status            pedido_aprovacao_status NOT NULL DEFAULT 'pendente',
  decisor_id        uuid REFERENCES auth.users(id),
  decidido_em       timestamptz,
  motivo_rejeicao   text,
  executado_em      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pa_status_data
  ON public.pedidos_aprovacao (status, solicitado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pa_solicitante
  ON public.pedidos_aprovacao (solicitante_id);

ALTER TABLE public.pedidos_aprovacao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pa_insert ON public.pedidos_aprovacao;
DROP POLICY IF EXISTS pa_select ON public.pedidos_aprovacao;
DROP POLICY IF EXISTS pa_update ON public.pedidos_aprovacao;

-- Qualquer staff (proprietario/colaborador) pode INSERIR; força solicitante_id = auth.uid().
CREATE POLICY pa_insert ON public.pedidos_aprovacao
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_papel() IN ('proprietario','colaborador')
    AND solicitante_id = auth.uid()
    AND status = 'pendente'
    AND decisor_id IS NULL
    AND executado_em IS NULL
    AND decidido_em IS NULL
  );

-- O dono vê os próprios; proprietário vê todos.
CREATE POLICY pa_select ON public.pedidos_aprovacao
  FOR SELECT TO authenticated
  USING (
    solicitante_id = auth.uid()
    OR public.current_user_papel() = 'proprietario'
  );

-- Apenas proprietário aprova/rejeita/marca executado.
CREATE POLICY pa_update ON public.pedidos_aprovacao
  FOR UPDATE TO authenticated
  USING (public.current_user_papel() = 'proprietario')
  WITH CHECK (public.current_user_papel() = 'proprietario');

-- Sem DELETE policy: audit trail imutável.

-- ──────────────────────────────────────────────────────────────────────────
-- Defesa em profundidade: sincroniza app_users.papel/nome/cargo
-- com auth.users.raw_user_meta_data. Frontend novo já lê de app_users,
-- mas se outra UI/CLI ler do metadata fica consistente.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_app_user_to_auth_metadata()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE auth.users
     SET raw_user_meta_data =
         COALESCE(raw_user_meta_data, '{}'::jsonb)
         || jsonb_build_object(
              'papel', NEW.papel,
              'nome',  NEW.nome,
              'cargo', COALESCE(NEW.cargo, '')
            )
   WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_sync_app_user_to_auth_metadata() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_app_user_sync_metadata ON public.app_users;
CREATE TRIGGER trg_app_user_sync_metadata
  AFTER INSERT OR UPDATE OF papel, nome, cargo ON public.app_users
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_app_user_to_auth_metadata();
