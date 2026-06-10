-- PR-I: solicitações de atualização de contato (devedor mudou de telefone).
--
-- Fluxo no portal:
-- 1. Devedor digita CPF → "Receber código".
-- 2. Não recebe (mudou de número) → clica "Esse não é meu telefone".
-- 3. Preenche nome + novo telefone + preferência → submit.
-- 4. Sistema grava em solicitacoes_contato + envia WhatsApp Z-API pro
--    admin notificando.

CREATE TABLE IF NOT EXISTS public.solicitacoes_contato (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cpf text NOT NULL,
  nome text,
  telefone_novo text NOT NULL,
  preferencia text,
  motivo text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atendido_em timestamptz,
  atendido_por uuid REFERENCES public.app_users(id),
  ip text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS idx_solicitacoes_contato_pendentes
  ON public.solicitacoes_contato(criado_em DESC) WHERE atendido_em IS NULL;

ALTER TABLE public.solicitacoes_contato ENABLE ROW LEVEL SECURITY;

-- Staff vê tudo
CREATE POLICY solicitacoes_staff_all ON public.solicitacoes_contato
  FOR ALL TO authenticated
  USING (public.current_user_papel() = ANY (ARRAY['proprietario','colaborador']))
  WITH CHECK (public.current_user_papel() = ANY (ARRAY['proprietario','colaborador']));

-- Anon usa só via RPC abaixo (não dá SELECT/INSERT direto)
-- (Sem policy = sem acesso pra anon.)

-- RPC para devedor (anônimo) criar solicitação: valida CPF, normaliza
-- telefone, retorna ok sem revelar nada sensível.
CREATE OR REPLACE FUNCTION public.portal_criar_solicitacao_contato(
  p_cpf text,
  p_nome text,
  p_telefone_novo text,
  p_preferencia text DEFAULT NULL,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cpf_digits text;
  v_tel_digits text;
BEGIN
  v_cpf_digits := regexp_replace(COALESCE(p_cpf,''), '\D', '', 'g');
  v_tel_digits := regexp_replace(COALESCE(p_telefone_novo,''), '\D', '', 'g');

  IF length(v_cpf_digits) <> 11 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'CPF inválido.');
  END IF;
  IF length(v_tel_digits) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Telefone inválido (informe DDD + número).');
  END IF;
  IF length(trim(COALESCE(p_nome,''))) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Nome obrigatório.');
  END IF;

  -- Rate limit suave: máximo 3 solicitações por CPF nas últimas 24h.
  IF (SELECT count(*) FROM public.solicitacoes_contato
      WHERE cpf = v_cpf_digits AND criado_em > now() - interval '24 hours') >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Já recebemos solicitações suas hoje. Aguarde nosso contato.');
  END IF;

  INSERT INTO public.solicitacoes_contato (cpf, nome, telefone_novo, preferencia, motivo)
  VALUES (v_cpf_digits, trim(p_nome), v_tel_digits, p_preferencia, p_motivo);

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.portal_criar_solicitacao_contato(text, text, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.portal_criar_solicitacao_contato(text, text, text, text, text) TO authenticated;
