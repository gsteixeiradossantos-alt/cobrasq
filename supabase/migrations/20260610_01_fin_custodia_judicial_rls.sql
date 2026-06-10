-- ============================================================================
-- F-03 — RLS proprietario-only em fin_custodia_judicial
-- ============================================================================
-- ACHADO CORRIGIDO (F-03, P0): migrations/2026-05-09_fin_judicial.sql cria a
--   tabela fin_custodia_judicial SEM `enable row level security` e SEM policy.
--   Se o prod refletir o arquivo, qualquer autenticado lê/escreve dados
--   financeiros e judiciais (valores bloqueados/sacados, processo, comarca) via
--   PostgREST. A view fin_custodia_judicial_alertas (security_invoker) NÃO
--   protege a base sem policy.
--
-- ASSUNÇÃO SOBRE O PROD (estado explícito): o schema foi aplicado
--   historicamente via Supabase MCP, então os arquivos de migration PODEM NÃO
--   refletir o prod real. >>> VERIFICAR ANTES via supabase/verification/
--   lote0_verify.sql, blocos F-03.a/b/c. <<<
--     • Se F-03.a mostrar rls_enabled = true E F-03.b já listar uma policy
--       proprietario-only equivalente → NÃO aplique (já está fechado).
--     • Se rls_enabled = false (ou true sem policy) → aplique.
--   Esta migration é IDEMPOTENTE (IF NOT EXISTS / DROP POLICY IF EXISTS), então
--   reaplicar não duplica objetos.
--
-- APPS / n8n QUE LEEM/ESCREVEM (matriz do plano):
--   • cobrasq-faturamento: R/W (5 usos) + view fin_custodia_judicial_alertas.
--   • crm-cobrasq: NÃO usa (—).
--   • Edge/Webhook/n8n: NÃO usa (—).
--   => Fechar para proprietario-only NÃO afeta o CRM. No faturamento, a aba
--      Judicial é de gestor (módulo financeiro inteiro é proprietario-only,
--      alinhado a fin_conta/fin_lancamento/etc.). Colaborador deixa de ler/gravar
--      custódia judicial — comportamento desejado.
--
-- RISCO: MÉDIO (mudança de RLS na casa de duas portas). Como o CRM não toca a
--   tabela, o blast radius fica no faturamento. Principal risco: se hoje algum
--   colaborador (não-proprietario) usa a aba Judicial, ele perde acesso após o
--   fix. Testar com 2 usuários (proprietario vê tudo; colaborador é negado).
--
-- ROLLBACK: supabase/migrations/20260610_01_fin_custodia_judicial_rls_rollback.sql
--   (DROP POLICY + DISABLE ROW LEVEL SECURITY). Comando resumido:
--     DROP POLICY IF EXISTS fin_custodia_judicial_owner_all ON public.fin_custodia_judicial;
--     ALTER TABLE public.fin_custodia_judicial DISABLE ROW LEVEL SECURITY;
-- ----------------------------------------------------------------------------
-- ECOSSISTEMA: Supabase jokbxzhcctcwnbhkhgru — compartilhado por
--   cobrasq-faturamento + crm-cobrasq. Aplicar só após aprovação item-a-item.
-- ============================================================================

ALTER TABLE public.fin_custodia_judicial ENABLE ROW LEVEL SECURITY;

-- Alinhado ao padrão dos demais fin_* (ver migrations/2026-05-08_fin_module.sql
-- linhas 216-224): policy única FOR ALL, proprietario-only, via
-- current_user_papel(). current_user_papel() é STABLE SECURITY DEFINER e lê de
-- public.app_users (ver docs/supabase-security.sql linha 57).
DROP POLICY IF EXISTS fin_custodia_judicial_owner_all ON public.fin_custodia_judicial;
CREATE POLICY fin_custodia_judicial_owner_all
  ON public.fin_custodia_judicial
  FOR ALL
  TO authenticated
  USING      (public.current_user_papel() = 'proprietario')
  WITH CHECK (public.current_user_papel() = 'proprietario');

-- NOTA sobre a view fin_custodia_judicial_alertas: views NÃO têm RLS própria.
--   Se ela for security_invoker=true, herda a RLS desta base (correto). Se for
--   DEFINER, vazaria a base mesmo com esta policy → verificar o
--   security_invoker da view (mesmo princípio do F-04 para `casos`). Fora do
--   escopo desta migration; anotar para revisão.
