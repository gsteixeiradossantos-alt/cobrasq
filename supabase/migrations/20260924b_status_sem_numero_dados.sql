-- 20260924b_status_sem_numero_dados
-- PASSO 2 de 3 da limpeza dos status (pedido do Gustavo, 24/09/2026).
-- SÓ RODAR DEPOIS de 20260924a (whitelist da view `casos`) — ver o porquê lá.
--
-- Tira o número da frente dos 10 status numerados. Contagem em 24/09/2026:
--   1. Ação de Cobrança ......................... 71
--   1.1 Ação de locupletamento ilícito .......... 10
--   1.2. Ação Monitória ......................... 11  ┐ mesma coisa, dois números —
--   4. Ação Monitória ...........................  3  ┘ o rename funde as duas
--   2. Acordo Extrajudicial ..................... 19
--   2.1. Acordo Judicial ........................ 59
--   3. Cumprimento de Sentença ................. 122
--   4. Ação de Execução de Título Extrajudicial . 41
--   8. Devolvida ............................... 234
--   9. Encerrada ................................  6
--
-- A derivação de etapa da tela (cobEtapa, index.html) casa por regex
-- (/cumprimento/i, /monit[óo]ria/i, /locupletamento/i, /devolv/i …), então o rename
-- não mexe em nenhum chip do pipeline.
--
-- ATENÇÃO (CLAUDE.md): depois de rodar, recarregar qualquer aba do painel que esteja
-- aberta — senão ela regrava os status antigos por cima.
UPDATE cobrancas SET status = regexp_replace(status, '^[0-9]+(\.[0-9]+)*\.?\s+', ''), updated_at = now()
WHERE status ~ '^[0-9]+(\.[0-9]+)*\.?\s';

-- "Quita Fácil Judicial" não existe como situação: QuitaFácil é autonegociação, e o
-- único caso com essa etiqueta (Artmaq Solução Industrial, credor Machadinho Auto
-- Center) tem processo distribuído. Decisão do Gustavo em 24/09/2026: vai para
-- "Quita Fácil".
UPDATE cobrancas SET status = 'Quita Fácil', updated_at = now()
WHERE status = 'Quita Fácil Judicial';
