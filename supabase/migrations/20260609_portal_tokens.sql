-- PR-E: tokens de acesso ao portal do devedor via Z-API (WhatsApp).
-- Substitui o uso de data de nascimento como segundo fator de autenticação.
--
-- Fluxo:
-- 1. Devedor digita CPF na tela de login do portal.
-- 2. Frontend chama RPC portal_emitir_token(cpf) — server valida CPF, gera
--    token 6 dígitos, persiste em portal_tokens com TTL 10min, retorna token
--    + telefone (mascarado pra UI e completo pra envio).
-- 3. Frontend envia mensagem via Z-API com o token.
-- 4. Devedor digita o token.
-- 5. Frontend chama RPC portal_validar_token(cpf, token) — marca como
--    usado e retorna devedor_id.
-- 6. Frontend cria sessão.
--
-- Rate-limit: 1 token a cada 60s por CPF.
-- Fallback: tela tem link "Não recebi" que volta pro fluxo nascimento (compat
-- com devedores sem telefone cadastrado).

CREATE TABLE IF NOT EXISTS public.portal_tokens (
  cpf text NOT NULL,
  token text NOT NULL,
  devedor_id uuid REFERENCES public.devedores(id) ON DELETE CASCADE,
  telefone text,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  usado_em timestamptz,
  ip text,
  user_agent text,
  PRIMARY KEY (cpf, token)
);

CREATE INDEX IF NOT EXISTS idx_portal_tokens_cpf_expira ON public.portal_tokens(cpf, expira_em DESC);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_devedor ON public.portal_tokens(devedor_id);

-- RLS: ninguém acessa diretamente; só via RPCs SECURITY DEFINER.
ALTER TABLE public.portal_tokens ENABLE ROW LEVEL SECURITY;

-- Limpeza de tokens vencidos (chamar via cron)
CREATE OR REPLACE FUNCTION public.limpar_portal_tokens_vencidos()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removidos integer;
BEGIN
  DELETE FROM public.portal_tokens WHERE expira_em < now() - interval '7 days';
  GET DIAGNOSTICS removidos = ROW_COUNT;
  RETURN removidos;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.limpar_portal_tokens_vencidos() FROM anon;
REVOKE EXECUTE ON FUNCTION public.limpar_portal_tokens_vencidos() FROM authenticated;

-- Emite token: valida CPF, rate-limit, gera código, retorna telefone pro frontend.
CREATE OR REPLACE FUNCTION public.portal_emitir_token(p_cpf text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cpf_digits text;
  v_devedor record;
  v_token text;
  v_ultimo_envio timestamptz;
  v_tel_mask text;
BEGIN
  v_cpf_digits := regexp_replace(p_cpf, '\D', '', 'g');
  IF length(v_cpf_digits) <> 11 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'CPF inválido.');
  END IF;

  SELECT id, telefone, nome
    INTO v_devedor
  FROM public.devedores
  WHERE regexp_replace(doc, '\D', '', 'g') = v_cpf_digits
    AND COALESCE(arquivado, false) = false
  LIMIT 1;

  IF v_devedor.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'CPF não encontrado no sistema.');
  END IF;

  IF v_devedor.telefone IS NULL OR v_devedor.telefone = '' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Sem telefone cadastrado. Use a opção "Não recebi o código" para entrar com nascimento.');
  END IF;

  SELECT enviado_em INTO v_ultimo_envio
  FROM public.portal_tokens
  WHERE cpf = v_cpf_digits
  ORDER BY enviado_em DESC LIMIT 1;

  IF v_ultimo_envio IS NOT NULL AND v_ultimo_envio > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Aguarde 1 minuto antes de pedir um novo código.');
  END IF;

  v_token := lpad((floor(random() * 1000000))::text, 6, '0');

  INSERT INTO public.portal_tokens (cpf, token, devedor_id, telefone, expira_em)
  VALUES (v_cpf_digits, v_token, v_devedor.id, v_devedor.telefone, now() + interval '10 minutes');

  v_tel_mask := CASE
    WHEN length(regexp_replace(v_devedor.telefone, '\D', '', 'g')) >= 4
      THEN '(••) ••••• -' || right(regexp_replace(v_devedor.telefone, '\D', '', 'g'), 4)
    ELSE '••••'
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'devedor_id', v_devedor.id,
    'devedor_nome', v_devedor.nome,
    'token', v_token,
    'telefone', v_devedor.telefone,
    'telefone_mask', v_tel_mask,
    'expira_em', (now() + interval '10 minutes')::text
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.portal_emitir_token(text) TO anon;
GRANT EXECUTE ON FUNCTION public.portal_emitir_token(text) TO authenticated;

-- Valida token (cpf+token), marca como usado, retorna devedor_id.
CREATE OR REPLACE FUNCTION public.portal_validar_token(p_cpf text, p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cpf_digits text;
  v_token_clean text;
  v_row record;
BEGIN
  v_cpf_digits := regexp_replace(p_cpf, '\D', '', 'g');
  v_token_clean := regexp_replace(p_token, '\D', '', 'g');

  IF length(v_token_clean) <> 6 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Código deve ter 6 dígitos.');
  END IF;

  SELECT t.cpf, t.token, t.devedor_id, t.expira_em, t.usado_em
    INTO v_row
  FROM public.portal_tokens t
  WHERE t.cpf = v_cpf_digits AND t.token = v_token_clean
  ORDER BY t.enviado_em DESC LIMIT 1;

  IF v_row.cpf IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Código incorreto.');
  END IF;
  IF v_row.usado_em IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Código já utilizado.');
  END IF;
  IF v_row.expira_em < now() THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Código expirado. Solicite um novo.');
  END IF;

  UPDATE public.portal_tokens
    SET usado_em = now()
  WHERE cpf = v_row.cpf AND token = v_row.token;

  RETURN jsonb_build_object('ok', true, 'devedor_id', v_row.devedor_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.portal_validar_token(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.portal_validar_token(text, text) TO authenticated;
