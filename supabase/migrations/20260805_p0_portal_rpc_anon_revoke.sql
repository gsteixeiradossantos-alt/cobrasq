-- ============================================================================
-- P0 · RPCs DO PORTAL DO DEVEDOR ABERTAS AO `anon` (achado auditoria 05/08/2026)
--
-- AINDA NÃO APLICADA EM PRODUÇÃO — pendente de autorização explícita do dono.
--
-- O advisor de segurança do Supabase (lint `anon_security_definer_function_
-- executable`) aponta três funções SECURITY DEFINER no schema public com
-- EXECUTE liberado para `anon` (e `authenticated`) sem necessidade nenhuma:
--
--   public._portal_emitir_sessao(p_devedor_id uuid, p_cpf text)
--   public.portal_mint_magic(p_devedor_id uuid, p_cobranca_id uuid, p_dias integer)
--   public.buscar_empresas_por_socio(p_nome text, p_cpf text)
--
-- Confirmado por `select proacl from pg_proc ...`: as três têm
-- `anon=X/postgres` e `authenticated=X/postgres` no ACL.
--
-- ── O BURACO ─────────────────────────────────────────────────────────────
-- `_portal_emitir_sessao` (prefixo `_` = convenção do projeto para função
-- interna, nunca deveria ser RPC pública) só gera um token aleatório, insere
-- em `portal_sessoes` e devolve `sessao_token` válido por 2 horas — SEM
-- validar CPF nem devedor_id contra nada. Com um UUID de devedor em mãos
-- (nada secreto: aparece em URLs, PDFs, planilhas), qualquer visitante sem
-- login ganha sessão de portal via
-- `POST /rest/v1/rpc/_portal_emitir_sessao` com a chave anon pública.
--
-- `portal_mint_magic` gera um link mágico válido por até 30 dias para
-- QUALQUER devedor, sem checar quem chamou — único guard existente é
-- devolver null se `p_devedor_id` vier nulo. Testado via curl com a chave
-- anon pública em 05/08/2026: HTTP 200, execução anônima confirmada.
--
-- `buscar_empresas_por_socio` faz reverse lookup nome/CPF → empresas (QSA da
-- Receita Federal) sem NENHUM guard interno — não é, como se presumia
-- inicialmente, uma função que já checa papel/staff por dentro; é SQL puro
-- sobre `rf_socios`/`rf_empresas`/`rf_estabelecimentos`, sem qualquer
-- referência a `auth.uid()` ou `app_users`. Antes de escrever esta migração
-- a definição completa foi lida via
-- `pg_get_functiondef(oid)` para confirmar — não é apenas "defesa em
-- profundidade", é o único guard que essa função vai ter.
--
-- ── POR QUE O REVOKE É SEGURO (não quebra nada) ─────────────────────────
-- `admin_emitir_sessao_portal` e `portal_validar_token` chamam
-- `_portal_emitir_sessao` internamente — confirmado lendo as duas definições
-- via `pg_get_functiondef`. Ambas são SECURITY DEFINER de mesmo dono
-- (`postgres`) que `_portal_emitir_sessao`. Quando uma função SECURITY
-- DEFINER chama outra, o check de EXECUTE roda como o DONO da função
-- chamadora, não como o role da sessão que originou a chamada externa —
-- então revogar `anon`/`authenticated` de `_portal_emitir_sessao` não afeta
-- essas duas chamadas internas. `admin_emitir_sessao_portal` (botão "Ver
-- como" do painel) e `portal_validar_token` (login do portal com CPF + código
-- de 6 dígitos) continuam funcionando exatamente como antes; nenhuma delas
-- foi tocada por esta migração.
--
-- Uso client-side (grep em index.html, crm.html, api/*.js dentro do
-- worktree): NENHUMA das três é chamada por `supabase.rpc(...)` no browser.
-- As únicas chamadas encontradas são server-side, com a service_role key
-- (que não depende do grant de anon/authenticated e continua com EXECUTE
-- intacto):
--
--   api/cron-regua.js:756   -> rpc/portal_mint_magic         (sbFetch, SUPABASE_SERVICE_ROLE_KEY)
--   api/_cnpja.js:77        -> rpc/buscar_empresas_por_socio  (sbFetch, SUPABASE_SERVICE_ROLE_KEY)
--
-- (api/_cnpja.js também exige usuário autenticado via `requireUser` ANTES de
-- chegar nesse `sbFetch` — a proteção real do reverse-lookup de sócios está
-- na camada da API Vercel, não na RPC, que é exatamente o motivo de ela
-- precisar do revoke.)
--
-- Não havendo nenhum uso client-side legítimo de nenhuma das três, o revoke
-- é de `anon` E `authenticated` nas três, sem reescrever o corpo de nenhuma.
-- `service_role` e `postgres` seguem intactos.
--
-- ── CORREÇÃO PÓS-REVISÃO ADVERSARIAL (mesmo dia, antes de qualquer aplicação) ──
-- `buscar_empresas_por_socio`, diferente das outras duas, também tem um
-- GRANT EXECUTE explícito para `PUBLIC` (aparece no ACL como a entrada `=X/
-- postgres`, sem nome de role antes do `=`). Confirmado ao vivo por três
-- métodos: `proacl` textual, `aclexplode(proacl)` e
-- `has_function_privilege('public', oid, 'EXECUTE')` (só ela retorna `true`
-- entre as três). Em Postgres um grant a `PUBLIC` vale automaticamente para
-- QUALQUER role, inclusive `anon` — revogar só de `anon`/`authenticated`
-- SEM revogar de `PUBLIC` não fecha nada: `anon` continuaria conseguindo
-- chamar `/rest/v1/rpc/buscar_empresas_por_socio` mesmo depois deste revoke,
-- porque herdaria o EXECUTE via `PUBLIC`. É o mesmo padrão de erro já
-- corrigido antes neste repo para `portal_emitir_token` (migração
-- `20260704c_p0_portal_emitir_token_server_only.sql`) — replicado aqui.
-- `_portal_emitir_sessao` e `portal_mint_magic` NÃO têm grant a `PUBLIC`
-- (confirmado), então para essas duas o revoke de anon/authenticated já
-- fecha o acesso sozinho.
-- ============================================================================

begin;

revoke execute on function public._portal_emitir_sessao(uuid, text) from anon;
revoke execute on function public._portal_emitir_sessao(uuid, text) from authenticated;

revoke execute on function public.portal_mint_magic(uuid, uuid, integer) from anon;
revoke execute on function public.portal_mint_magic(uuid, uuid, integer) from authenticated;

revoke execute on function public.buscar_empresas_por_socio(text, text) from anon;
revoke execute on function public.buscar_empresas_por_socio(text, text) from authenticated;
revoke execute on function public.buscar_empresas_por_socio(text, text) from public;

commit;

-- ── VERIFICAÇÃO (externa, com a chave anon pública — rodar DEPOIS de aplicar) ──
-- for fn in "_portal_emitir_sessao" "portal_mint_magic" "buscar_empresas_por_socio"; do
--   curl -s -o /dev/null -w "$fn -> HTTP %{http_code}\n" \
--     -X POST "https://jokbxzhcctcwnbhkhgru.supabase.co/rest/v1/rpc/$fn" \
--     -H "apikey: <ANON>" -H "Authorization: Bearer <ANON>" \
--     -H "Content-Type: application/json" -d '{}'
-- done
-- Esperado depois do revoke: as três devolvem HTTP 401/403 (permission
-- denied for function), em vez do HTTP 200 confirmado antes do fix.
--
-- Query SQL de verificação pós-aplicação (rodar via Supabase MCP / SQL editor):
--   select proname, proacl,
--          has_function_privilege('anon', oid, 'EXECUTE') as anon_pode,
--          has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated_pode,
--          has_function_privilege('public', oid, 'EXECUTE') as public_daria_acesso
--   from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname in ('_portal_emitir_sessao','portal_mint_magic','buscar_empresas_por_socio');
-- Esperado: as três colunas anon_pode/authenticated_pode/public_daria_acesso
-- devem ser `false` nas três funções (checar `public_daria_acesso` é
-- obrigatório — checar só ausência de `anon=X/postgres` no proacl não
-- detecta um grant a `PUBLIC`, que aparece como entrada separada `=X/
-- postgres` e concede acesso a `anon` por tabela indireta).
--
-- Depois de aplicar, também confirmar que NADA quebrou nos dois fluxos que
-- dependem dessas funções por baixo dos panos:
--   - painel: botão "Ver como" (admin_emitir_sessao_portal) continua abrindo
--     sessão de portal para um devedor, logado como proprietário.
--   - portal do devedor: login com CPF + código de 6 dígitos
--     (portal_validar_token) continua emitindo sessão normalmente.
--   - cron da régua (api/cron-regua.js): próximo envio de link mágico não
--     deve falhar (usa service_role, não deveria ser afetado).
--   - tela de acordo: busca de sócios por CPF/nome (api/_cnpja.js) continua
--     funcionando para usuário autenticado no painel.

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- grant execute on function public._portal_emitir_sessao(uuid, text) to anon, authenticated;
-- grant execute on function public.portal_mint_magic(uuid, uuid, integer) to anon, authenticated;
-- grant execute on function public.buscar_empresas_por_socio(text, text) to anon, authenticated, public;
