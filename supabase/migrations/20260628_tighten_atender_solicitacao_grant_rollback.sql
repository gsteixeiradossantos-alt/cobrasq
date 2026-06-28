-- ROLLBACK de 20260628_tighten_atender_solicitacao_grant.sql
-- Restaura o EXECUTE para anon (estado anterior). PUBLIC não é re-concedido de propósito
-- (o grant a anon basta para o uso via PostgREST; PUBLIC era redundante).
GRANT EXECUTE ON FUNCTION public.atender_solicitacao_contato(uuid) TO anon;
