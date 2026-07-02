-- P0 (AUDITORIA-2026-07) — Portal do devedor: token de acesso deixa de ser
-- exposto ao cliente. A RPC portal_emitir_token é SECURITY DEFINER e devolve no
-- JSON, ao próprio chamador, o código de 6 dígitos (`token`) e o telefone completo
-- (`telefone`). Como o EXECUTE estava concedido a `anon`, qualquer pessoa que
-- digitasse o CPF de uma vítima recebia o OTP e o telefone direto na resposta da
-- RPC (visível no DevTools/Network), contornando o 2FA por WhatsApp e vazando PII.
--
-- Correção: a emissão passa a ser SERVER-ONLY. Só `service_role` pode executar a
-- função; o disparo do WhatsApp acontece no servidor (api/mfa.js?action=portal-challenge),
-- que chama esta RPC com a service key, envia o código via Z-API e devolve ao
-- navegador apenas telefone_mask (nunca o token nem o telefone em claro).
--
-- ATENÇÃO (deploy coordenado): esta migração SÓ pode ir ao ar junto com o deploy
-- do frontend (index.html: portalEnviarToken passa a chamar /api/mfa) e do
-- api/mfa.js (nova action portal-challenge). Aplicar a migração isolada quebra o
-- login do portal, pois o frontend antigo ainda chama a RPC como anon.
--
-- Não altera o corpo da função (o retorno com token/telefone é inofensivo quando
-- só o servidor a chama). Fecha também o P1 index.html:6022 (entrega dependia do
-- Z-API guardado no blob staff-only, ilegível para o anônimo).

REVOKE EXECUTE ON FUNCTION public.portal_emitir_token(text) FROM anon, authenticated;

-- portal_validar_token continua com EXECUTE para anon: ela não devolve segredo
-- (apenas devedor_id após conferir CPF+token), então o fluxo de validação segue
-- client-side sem alteração.
