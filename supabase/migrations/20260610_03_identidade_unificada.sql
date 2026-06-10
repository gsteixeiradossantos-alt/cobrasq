-- ============================================================================
-- F-05 — Unificar identidade em app_users + current_user_papel()
-- ============================================================================
-- ACHADO CORRIGIDO (F-05, P0): identidade dupla. Há DUAS tabelas de papel
--   disjuntas no mesmo projeto: app_users (faturamento; lida por
--   current_user_papel()) e profiles (CRM). Sem sync entre elas. As policies do
--   CRM se dividem: crm_mensagens_agendadas / crm_envios_falhados checam
--   profiles.role, enquanto crm_mensagens_status / peticao_* / devedores /
--   devedor_eventos checam current_user_papel() (= app_users.papel). Um usuário
--   com linha só num dos lados tem autorização incoerente → gestor não vê
--   atividade, estagiária não vê cadastros (queixas reais de hoje).
--
-- DECISÃO DO GATE (plano, item 2): fonte única de verdade = app_users +
--   current_user_papel() (já usada pelo RLS multi-tenant do faturamento e por
--   parte do CRM). Falta DECIDIR O MECANISMO. Este arquivo apresenta DUAS
--   opções rotuladas, com trade-offs. >>> NÃO ESCOLHE — aguarda aprovação. <<<
--   Aplique APENAS UM dos blocos (A ou B), nunca os dois às cegas; podem até ser
--   combinados (A garante a linha existir; B remove a dependência de profiles
--   nas policies) — mas isso é decisão de gate, não default.
--
-- ASSUNÇÃO SOBRE O PROD (estado explícito): schema aplicado via Supabase MCP;
--   os arquivos PODEM NÃO refletir o prod. >>> VERIFICAR ANTES via
--   supabase/verification/lote0_verify.sql, blocos F-05.a..f. <<< Em especial:
--     • F-05.d/e: QUEM está só em profiles (precisa virar linha em app_users)?
--     • F-05.b: confirmar que current_user_papel() lê de app_users.
--     • F-05.f: QUAIS policies referenciam profiles.role (alvos da Opção B).
--   O mapeamento profiles.role → app_users.papel abaixo ASSUME:
--     profiles.role 'admin'|'owner'|'gestor' → 'proprietario'
--     demais (ex.: 'staff'|'colaborador'|'user') → 'colaborador'
--   AJUSTE este de-para conforme os valores reais vistos em F-05.e ANTES de aplicar.
--   ASSUME ainda profiles.id = auth uid e app_users.id = auth uid (padrão
--   Supabase). Se profiles usa outra coluna p/ o uid, ajuste os JOINs.
--
-- APPS / n8n QUE LEEM/ESCREVEM (matriz do plano):
--   • app_users: cobrasq-faturamento R/W (3) — identidade do faturamento;
--     trigger trg_app_user_sync_metadata já sincroniza p/ auth.users metadata.
--   • profiles: crm-cobrasq R/W (42) — identidade do CRM; base de RLS de
--     crm_mensagens_agendadas / crm_envios_falhados.
--   • Mudança afeta OS DOIS apps → testar login + listar casos + criar
--     devedor/cliente com 2 usuários (proprietario + estagiária) em AMBOS.
--
-- RISCO: MÉDIO. Opção A (trigger de sync) tem risco de loop/recursão e de
--   sobrescrever papel divergente; Opção B (migrar policies) muda authz do CRM.
--   Ambas reversíveis (ver rollback).
--
-- ROLLBACK: supabase/migrations/20260610_03_identidade_unificada_rollback.sql
--   (dropa o trigger/função da Opção A e/ou restaura as policies profiles.role
--   da Opção B — ver o arquivo de rollback, que tem as duas metades rotuladas).
-- ----------------------------------------------------------------------------
-- ECOSSISTEMA: Supabase jokbxzhcctcwnbhkhgru — compartilhado por
--   cobrasq-faturamento + crm-cobrasq. Aplicar só após aprovação item-a-item.
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ OPÇÃO A — TRIGGER DE SINCRONIZAÇÃO  profiles → app_users                    ║
-- ║ (mantém AMBAS as tabelas e AMBOS os estilos de policy funcionando)          ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Ideia: toda linha de profiles passa a ter linha-espelho em app_users, com   ║
-- ║   papel derivado de profiles.role. Assim current_user_papel() (e todo o RLS ║
-- ║   que depende dele) passa a "enxergar" quem só existia em profiles. As       ║
-- ║   policies que ainda checam profiles.role continuam valendo (não se mexe).   ║
-- ║                                                                              ║
-- ║ TRADE-OFFS                                                                   ║
-- ║   + Menos invasivo nas policies do CRM (não as toca).                        ║
-- ║   + Desbloqueia as queixas de hoje sem reescrever authz.                     ║
-- ║   + Reversível (drop do trigger + função).                                   ║
-- ║   - Mantém DUAS fontes de verdade (sync, não unificação real) → ainda há     ║
-- ║     espaço p/ divergência se alguém editar app_users.papel à mão.            ║
-- ║   - Direção do sync (profiles→app_users) precisa de regra de precedência se  ║
-- ║     já existir linha em app_users com papel diferente (aqui: profiles vence; ║
-- ║     reveja em F-05.e antes de aplicar).                                      ║
-- ║   - Trigger em tabela de identidade exige cuidado com recursão/loops.        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
/*  >>> DESCOMENTE PARA APLICAR A OPÇÃO A <<<

-- A.1 — Backfill: garante linha em app_users para todo profiles existente.
INSERT INTO public.app_users (id, papel)
SELECT p.id,
       CASE
         WHEN lower(p.role) IN ('admin','owner','gestor','proprietario') THEN 'proprietario'
         ELSE 'colaborador'
       END
FROM public.profiles p
ON CONFLICT (id) DO UPDATE
   SET papel = EXCLUDED.papel;   -- profiles vence; reveja precedência se necessário

-- A.2 — Função de sync (profiles → app_users). SECURITY DEFINER para escrever
--       em app_users independentemente da RLS do caller.
CREATE OR REPLACE FUNCTION public.fn_sync_profile_to_app_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  INSERT INTO public.app_users (id, papel)
  VALUES (
    NEW.id,
    CASE
      WHEN lower(NEW.role) IN ('admin','owner','gestor','proprietario') THEN 'proprietario'
      ELSE 'colaborador'
    END
  )
  ON CONFLICT (id) DO UPDATE
     SET papel = EXCLUDED.papel;
  RETURN NEW;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.fn_sync_profile_to_app_user() FROM anon, authenticated;

-- A.3 — Trigger. AFTER INSERT OR UPDATE OF role para não disparar em updates
--       de outras colunas de profiles (evita ruído/loops).
DROP TRIGGER IF EXISTS trg_profile_sync_app_user ON public.profiles;
CREATE TRIGGER trg_profile_sync_app_user
  AFTER INSERT OR UPDATE OF role ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_sync_profile_to_app_user();

-- NOTA: já existe o caminho inverso (app_users → auth.users metadata) em
--   20260609_pedidos_aprovacao.sql (trg_app_user_sync_metadata). Aqui NÃO
--   criamos app_users → profiles para evitar ciclo. Se um dia precisar do
--   inverso, use uma coluna-guarda/condição para quebrar a recursão.

    >>> FIM DA OPÇÃO A <<<  */


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ OPÇÃO B — MIGRAR AS POLICIES profiles.role → current_user_papel()           ║
-- ║ (fonte única real: app_users; profiles deixa de governar authz)             ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Ideia: reescrever as policies do CRM que checam profiles.role para usar      ║
-- ║   current_user_papel() (= app_users.papel), igualando ao resto do projeto.   ║
-- ║   Alvos típicos (CONFIRMAR em F-05.f): crm_mensagens_agendadas,              ║
-- ║   crm_envios_falhados. Mapeamento de papel: role 'admin/owner/gestor' e o    ║
-- ║   acesso de staff → ('proprietario','colaborador'); ajuste por tabela.       ║
-- ║                                                                              ║
-- ║ TRADE-OFFS                                                                   ║
-- ║   + Fonte única REAL (app_users) → elimina a divergência na raiz.            ║
-- ║   + Consistente com devedores/devedor_eventos/peticao_*/crm_mensagens_status.║
-- ║   - Exige que TODOS os staff do CRM tenham linha em app_users ANTES, senão   ║
-- ║     perdem acesso (rodar o backfill A.1 antes, mesmo escolhendo B).          ║
-- ║   - Mais invasivo: toca authz de tabelas do CRM → testar por papel nos dois  ║
-- ║     apps obrigatoriamente.                                                   ║
-- ║   - As policies abaixo são um TEMPLATE: os nomes/cláusulas REAIS vêm de       ║
-- ║     F-05.f. NÃO aplique sem casar com a saída da verificação.                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
/*  >>> DESCOMENTE E AJUSTE (com base em F-05.f) PARA APLICAR A OPÇÃO B <<<

-- PRÉ-REQUISITO de B: rodar o backfill A.1 (acima) para que ninguém do CRM
-- fique sem linha em app_users e perca acesso.

-- B.1 — crm_mensagens_agendadas: troca profiles.role por current_user_papel().
--   ⚠️ Substitua o nome da policy e o comando pelos REAIS (F-05.f).
DROP POLICY IF EXISTS "crm_mensagens_agendadas_staff" ON public.crm_mensagens_agendadas;
CREATE POLICY "crm_mensagens_agendadas_staff" ON public.crm_mensagens_agendadas
  FOR ALL TO authenticated
  USING      (public.current_user_papel() IN ('proprietario','colaborador'))
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));

-- B.2 — crm_envios_falhados: idem.
DROP POLICY IF EXISTS "crm_envios_falhados_staff" ON public.crm_envios_falhados;
CREATE POLICY "crm_envios_falhados_staff" ON public.crm_envios_falhados
  FOR ALL TO authenticated
  USING      (public.current_user_papel() IN ('proprietario','colaborador'))
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));

-- B.3 — repita para QUALQUER outra policy que F-05.f tenha listado como
--   referenciando 'profiles'. Não deixe nenhuma para trás (senão a fonte
--   continua dupla).

    >>> FIM DA OPÇÃO B <<<  */


-- ============================================================================
-- Sem nenhum bloco descomentado, este arquivo é um NO-OP seguro (só comentários).
-- Escolha A, B, ou A+B no gate, descomente, ajuste o de-para, e só então aplique.
-- ============================================================================
