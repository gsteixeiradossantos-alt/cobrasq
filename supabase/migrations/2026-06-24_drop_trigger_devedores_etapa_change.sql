-- 2026-06-24 — Remove trigger órfão em devedores. Aplicado em produção via Supabase MCP.
--
-- O trigger `devedores_etapa_change` (BEFORE UPDATE ON devedores) chamava
-- set_etapa_atualizada(), que referencia NEW.passo_atual / NEW.etapa_atualizada_em —
-- colunas que NÃO existem em `devedores` (pertencem a `cobrancas`). Resultado: TODO
-- UPDATE em devedores falhava com "record new has no field passo_atual".
--
-- Impacto do bug: nenhuma edição de devedor funcionava, e o loop recebimento→financeiro
-- não conseguia popular devedores.asaas_customer_id (chave que o asaas-webhook usa para
-- casar o pagador). O trigger nunca fez nada útil em devedores (as colunas não existem),
-- então removê-lo é seguro.
--
-- A função set_etapa_atualizada() era usada SOMENTE por este trigger; fica órfã (inócua).
-- Se no futuro quiser carimbar etapa_atualizada_em, recrie o trigger na tabela CERTA
-- (cobrancas, que tem passo_atual).

drop trigger if exists devedores_etapa_change on public.devedores;
