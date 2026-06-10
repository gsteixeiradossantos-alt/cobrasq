-- Follow-ups: RPCs auxiliares pras 3 telas adicionadas.
--
-- 1) reativar_cliente: desfaz arquivamento (PR-H deixou só via SQL).
-- 2) atender_solicitacao_contato: marca solicitação como atendida +
--    atualiza o telefone do devedor + grava quem atendeu.

CREATE OR REPLACE FUNCTION public.reativar_cliente(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_papel text;
BEGIN
  v_papel := public.current_user_papel();
  IF v_papel NOT IN ('proprietario','colaborador') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  END IF;

  UPDATE public.clientes
  SET arquivado = false,
      arquivado_em = NULL,
      arquivado_motivo = NULL
  WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Cliente não encontrado.');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reativar_cliente(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reativar_cliente(uuid) FROM anon;

-- Atende solicitação: marca solicitacoes_contato.atendido_em/por +
-- atualiza devedores.telefone do devedor que tem o CPF informado.
CREATE OR REPLACE FUNCTION public.atender_solicitacao_contato(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_papel text;
  v_sol record;
  v_atualizado integer;
BEGIN
  v_papel := public.current_user_papel();
  IF v_papel NOT IN ('proprietario','colaborador') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  END IF;

  SELECT id, cpf, telefone_novo, atendido_em
    INTO v_sol
  FROM public.solicitacoes_contato
  WHERE id = p_id;

  IF v_sol.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Solicitação não encontrada.');
  END IF;
  IF v_sol.atendido_em IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Já atendida.');
  END IF;

  -- Atualiza telefone do devedor que bate com o CPF (se existir cadastro).
  UPDATE public.devedores
  SET telefone = v_sol.telefone_novo,
      updated_at = now()
  WHERE regexp_replace(COALESCE(doc,''), '\D', '', 'g') = v_sol.cpf
    AND NOT COALESCE(arquivado, false);
  GET DIAGNOSTICS v_atualizado = ROW_COUNT;

  UPDATE public.solicitacoes_contato
  SET atendido_em = now(),
      atendido_por = auth.uid()
  WHERE id = p_id;

  RETURN jsonb_build_object(
    'ok', true,
    'devedores_atualizados', v_atualizado
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.atender_solicitacao_contato(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.atender_solicitacao_contato(uuid) FROM anon;
