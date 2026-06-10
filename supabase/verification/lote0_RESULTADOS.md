# Lote 0 — Resultados da verificação READ-ONLY no prod

**Data:** 2026-06-10 · **Projeto:** `jokbxzhcctcwnbhkhgru` (Site COBRASQ) · **Método:** `supabase db query --linked` (Management API, somente SELECT). Nenhuma escrita.

> Regra confirmada na prática: **o prod foi endurecido via MCP e DIVERGE dos arquivos de migration.** Por isso verificamos antes de aplicar. Três P0 "suspeitos por código" caíram.

## Veredito por achado

| Achado | Hipótese | Resultado no prod | Severidade revisada |
|---|---|---|---|
| **F-03** | `fin_custodia_judicial` sem RLS | `rls_enabled=true`, policy `fin_custodia_judicial_owner_all` = `current_user_papel()='proprietario'` (ALL) | **FECHADO** — já protegido, no padrão dos demais `fin_*` |
| **F-04** | view `casos` rodando como DEFINER (drift) | `reloptions=[security_invoker=true]`, dono `postgres` → roda como INVOKER, respeita a RLS das tabelas base | **FECHADO** — manter só a nota anti-drift no README |
| **F-05** | `app_users` × `profiles` disjuntos, sem sync | **5/5 usuários em AMBAS** as tabelas; papéis batem (`proprietario↔admin`, `colaborador↔operador`); **0 policies** referenciam `profiles` | **REBAIXADO de P0** — identidade está sincronizada; não é a causa |
| **F-11** | tabelas admin-only sem RLS de retaguarda | **TODAS** as tabelas `public` têm `rls_enabled=true`; único `n_policies=0` é `portal_tokens` (RLS on + 0 policy = nega tudo a anon/auth, correto — só via RPC SECURITY DEFINER) | **FECHADO** — sem tabela exposta |

## `current_user_papel()`
`STABLE SECURITY DEFINER`, `SET search_path=public,pg_temp`, `SELECT papel FROM app_users WHERE id = auth.uid()`. Correta. Dr. Gustavo = `proprietario`.

## RLS de `devedores` / `devedor_eventos` (corretas)
- `*_proprietario_all`: `current_user_papel()='proprietario'` → ALL (gestor vê tudo).
- `*_colaborador_owned`: colaborador limitado a `cadastrado_por = auth.uid() OR assigned_to = auth.uid()`.
- `casos` é view `security_invoker=true` → herda essas policies (sem policy própria).

## View `casos` — dois pontos
1. `created_by` **e** `assigned_to` mapeiam para `d.assigned_to`. Se `assigned_to` é NULL, o caso fica **sem dono** no CRM.
2. Filtro: `NOT arquivado AND (passo_atual IS NOT NULL OR encerramento OR origem='migracao_crm_2026-05-08' OR status IN (lista ampla))`. A lista inclui "Cobrar" etc. → não esconde nada além dos arquivados.

## Forma dos dados (contagens, sem PII)
- **devedores: 28 total · 21 com `assigned_to` NULL · 16 com `cadastrado_por` NULL · 7 arquivados**
- `devedor_eventos`: 157 · `casos` (como postgres) visíveis: 21 (= 28 − 7 arquivados)
- `cobrasq_data` key=`main`: ~16 KB

## Causa-raiz real das queixas (com evidência)
- **Estagiária não vê cadastros:** 21/28 devedores têm `assigned_to` **e** `cadastrado_por` NULL (dados legados/migrados). A RLS de colaborador exclui esses corretamente → ela vê quase nada. **Fix:** backfill de dono nos 21 órfãos (decisão do gestor sobre a quem atribuir) + Request A já evita NULL em cadastros novos.
- **Mesa do gestor vazia:** proprietário vê os 21 no nível do banco. A queixa é consistente com **F-21** (sessão cai no refresh → vira anon → `current_user_papel()` nulo → RLS devolve vazio). **F-21 já corrigido** (branch `fix/login-refresh` no CRM).

## Itens que NÃO precisam mais de migration de RLS
F-03, F-04, F-11 — prod já correto. Os arquivos `20260610_01..04` ficam como **referência/anti-regressão**; não aplicar (seriam no-op ou redundantes). Manter a nota anti-drift do `casos` no README.

## Próxima ação que envolve ESCRITA (precisa decisão + rollback antes)
**Backfill dos 21 devedores órfãos** (`assigned_to`/`cadastrado_por` NULL). Decisão do gestor: atribuir todos a ele (proprietário) como default seguro, ou triagem manual por carteira. Script de UPDATE + rollback (snapshot dos ids/valores antigos) a escrever ANTES de rodar.
