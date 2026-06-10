-- PR-H: RPC pra arquivar cliente da tela (sem expor UPDATE direto).
-- Só staff (proprietário ou colaborador) pode arquivar.

CREATE OR REPLACE FUNCTION public.arquivar_cliente(p_id uuid, p_motivo text DEFAULT NULL)
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
  SET arquivado = true,
      arquivado_em = now(),
      arquivado_motivo = COALESCE(p_motivo, 'arquivado-via-app:' || auth.uid()::text)
  WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Cliente não encontrado.');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.arquivar_cliente(uuid, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.arquivar_cliente(uuid, text) FROM anon;
