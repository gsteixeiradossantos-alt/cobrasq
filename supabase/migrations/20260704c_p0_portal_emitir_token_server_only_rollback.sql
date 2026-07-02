-- Rollback do 20260704c — restaura o EXECUTE para anon/authenticated na RPC
-- portal_emitir_token. Use apenas se o fluxo server-side (api/mfa.js?action=
-- portal-challenge + frontend) precisar ser revertido; reabre o P0.

GRANT EXECUTE ON FUNCTION public.portal_emitir_token(text) TO anon, authenticated;
