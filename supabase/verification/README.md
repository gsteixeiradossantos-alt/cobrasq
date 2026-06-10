# Lote 0 — Verificação read-only + fixes de RLS/schema (F-03, F-04, F-05, F-11)

**Ecossistema:** Supabase `jokbxzhcctcwnbhkhgru` é a *casa de duas portas* —
compartilhado por **cobrasq-faturamento** + **crm-cobrasq**. Qualquer mudança de
RLS/trigger/view afeta os DOIS apps. A segurança depende inteiramente de RLS
(os dois fronts usam a anon/publishable key no browser).

**Premissa que governa tudo aqui:** o schema de prod foi aplicado
historicamente via Supabase MCP, então os arquivos de migration **podem não
refletir o prod real**. Por isso **NADA se aplica sem rodar antes
`lote0_verify.sql`** e confrontar o resultado com cada hipótese. Toda mudança
exige **aprovação item-a-item** e **rollback escrito antes** (já incluído).

> Estes arquivos são **drafts**. Nenhum foi aplicado. Não rode `supabase db push`
> nem aplique nada sem o "ok" item-a-item do gestor.

## Arquivos

| Arquivo | O que é | Risco (1 linha) |
|---|---|---|
| `lote0_verify.sql` | Queries **read-only** (só SELECT/pg_catalog/information_schema) p/ confirmar F-03/F-04/F-05/F-11. Cada bloco diz o que CONFIRMA vs REBATE. | Nenhum — não escreve nada. |
| `../migrations/20260610_01_fin_custodia_judicial_rls.sql` | F-03: ENABLE RLS + policy proprietario-only em `fin_custodia_judicial` (alinha aos demais `fin_*`). | Médio — RLS; CRM não usa a tabela, blast no faturamento (colaborador perde a aba Judicial). |
| `../migrations/20260610_01_fin_custodia_judicial_rls_rollback.sql` | Rollback F-03 (DROP POLICY + DISABLE RLS). | Reabre acesso financeiro/judicial a todo autenticado — emergência só. |
| `../migrations/20260610_02_casos_security_invoker.sql` | F-04: `ALTER VIEW casos SET (security_invoker=true)` + nota anti-drift. | Baixo — 1 ALTER, não muda o corpo da view; testar junto com F-05. |
| `../migrations/20260610_02_casos_security_invoker_rollback.sql` | Rollback F-04 (`security_invoker=false`). | Reabre vazamento cross-tenant no CRM — emergência só. |
| `../migrations/20260610_03_identidade_unificada.sql` | F-05: DUAS opções rotuladas (A: trigger sync `profiles`→`app_users`; B: migrar policies `profiles.role`→`current_user_papel()`). NO-OP até descomentar. **Não escolhe.** | Médio — toca identidade dos dois apps; aplicar só A **ou** B (ou A+B) por decisão de gate. |
| `../migrations/20260610_03_identidade_unificada_rollback.sql` | Rollback F-05 (duas metades A/B rotuladas). | Médio — restaura estado anterior; backfill de `app_users` não é auto-revertido. |
| `../migrations/20260610_04_admin_backstop_rls.sql` | F-11: template ENABLE RLS + policy staff/owner por tabela admin-only **desprotegida** (lista vem de F-11.a). NO-OP até preencher. | Médio — depende de F-03/F-05; aplicar tabela-a-tabela. |
| `../migrations/20260610_04_admin_backstop_rls_rollback.sql` | Rollback F-11 (DROP POLICY + DISABLE RLS por tabela). | Reexpõe a tabela revertida — emergência só. |

## Ordem de aplicação

1. **`lote0_verify.sql`** (read-only) — rodar no SQL Editor do Supabase, salvar a
   saída. **Gate:** confirmar ou rebaixar cada hipótese antes de seguir.
2. **F-03** (`20260610_01_...`) — se F-03.a/b mostrarem a tabela desprotegida.
3. **F-04** (`20260610_02_...`) — se F-04.a mostrar `security_invoker` ausente/false
   (idempotente: pode aplicar mesmo se já true).
4. **F-05** (`20260610_03_...`) — **escolher A ou B (ou A+B) no gate**, ajustar o
   de-para `profiles.role → app_users.papel` conforme F-05.e, descomentar, aplicar.
5. **F-11** (`20260610_04_...`) — por último (usa `current_user_papel()`, depende de
   F-05 estar coerente). Preencher só com as tabelas que F-11.a listou desprotegidas.

Após **cada** passo: testar **os dois apps** (login, listar casos, criar
devedor/cliente) com **2 usuários** (1 proprietario + 1 estagiária) — a RLS se
comporta diferente por papel. Em falha, aplicar o `_rollback.sql` pareado.

## Notas

- F-03 e F-11 dependem de `current_user_papel()` (lê de `app_users`) — por isso
  **F-05 deve estar resolvido** para que gestor/estagiária não caiam no escopo
  restrito por estarem só em `profiles`.
- F-04 e F-05 se testam **juntos** por papel: pinar `security_invoker=true` só
  ajuda se a RLS de `devedores`/`clientes` reconhecer o papel do usuário.
- **Anti-drift (`casos`):** qualquer `CREATE OR REPLACE VIEW casos` futuro (em
  qualquer um dos dois repos) deve re-declarar `WITH (security_invoker = true)`.
  Migrations de `casos` ficam num lugar só, com data no nome.
