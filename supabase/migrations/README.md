# Migrations COBRASQ — Triagem Fase E

Migrations geradas em 10/05/2026 a partir das specs em `docs/specs/`. **NÃO foram aplicadas automaticamente** — review e aplicar manualmente via SQL Editor do Supabase ou `supabase db push`.

## Ordem sugerida de aplicação

1. **20260510_01_calc_persistence.sql** — `calc_calculos` (C2)
2. **20260510_02_endereco_separado.sql** — colunas de endereço em `clientes` e `devedores` + `nome_fantasia` (S7, S8)
3. **20260510_03_dev_dividas.sql** — `dev_dividas` (S2)
4. **20260510_04_filiais_grupos.sql** — `cliente_grupo_id`, `eh_matriz`, flags em `users` (S6)
5. **20260510_05_rascunhos.sql** — `is_draft`, `draft_expires_at` (S12)
6. **20260510_06_intimacoes.sql** — `proc_intimacoes` (S13)
7. **20260510_07_user_integrations.sql** — `user_integrations` + `calendar_events_sync` (S10)

## Verificações pós-aplicação

- [ ] Confirmar que tabelas existentes (`clientes`, `devedores`, `processos`, `users`) tinham os schemas esperados.
- [ ] Revisar políticas RLS — algumas presumem padrões de auth.uid() que podem precisar ajuste conforme política existente.
- [ ] Para S6 (filiais), as RLS de visibilidade de grupo precisam ser adicionadas às políticas existentes de `clientes` e `devedores` — não foi feito automaticamente porque depende das políticas atuais.
- [ ] Para S12 (rascunhos), filtros aplicacionais já presumem `is_draft=false` em listagens normais. Verificar.

## Guarda anti-drift da view `casos` (F-04)

A view `public.casos` é compartilhada pelos DOIS repos (faturamento + CRM). O
bug F-04 nasceu de duas redefinições concorrentes da view onde uma esqueceu de
declarar `security_invoker`, fazendo a view rodar como DEFINER e ignorar a RLS
(vazamento cross-tenant). **Regra:** todo `CREATE OR REPLACE VIEW public.casos`
— em qualquer um dos dois repos — DEVE re-declarar a option:

```sql
CREATE OR REPLACE VIEW public.casos
  WITH (security_invoker = true) AS  ...;
```

Migrations de `casos` ficam num único lugar, com data no nome. Use o bloco
F-04.a de `../verification/lote0_verify.sql` como teste de fumaça pós-deploy.

## Lote 0 — fixes de RLS/schema (F-03/F-04/F-05/F-11)

Drafts em `20260610_0{1..4}_*.sql` (+ `_rollback.sql` pareado). **Nenhum
aplicado.** Verificar prod com `../verification/lote0_verify.sql` ANTES;
detalhes e ordem em `../verification/README.md`.

## Project ID

Supabase: `jokbxzhcctcwnbhkhgru` (per memória persistente).

## Pendências de aplicação

Aplicar manualmente via SQL editor ou:
```
supabase db push
```

## 20260829 — `fin_lancamento.judicial_pedido_em` (aba Judicial)

**Não aplicada.** Uma coluna, aditiva, sem backfill:

```sql
alter table public.fin_lancamento add column if not exists judicial_pedido_em date;
```

É a data do pedido de expedição do alvará/ofício — a origem da espera mostrada na
aba Judicial. A UI já lê a coluna com fallback (`_finTemColunaPedidoJud()` pergunta
uma vez por sessão): enquanto a migração não for aplicada, a aba funciona inteira e
apenas os cards **espera média** e **parados há +60 dias** ficam em "—", com a nota
dizendo que a migração está pendente. Depois de aplicar, a data se informa pelo
diálogo "Alterar data prevista" do menu ⋮ de cada linha.

## 20260905 — `lembretes` (menu Lembretes, irmão de Audiências)

**Não aplicada.** Aditiva: tabela `public.lembretes`, coluna
`crm_mensagens_agendadas.lembrete_id` (FK cascade), RLS (proprietário tudo,
colaborador lê) e trigger `lembretes_agendar_avisos()` que enfileira 3 avisos
de WhatsApp (véspera 19h, dia 08h, 10 min antes) com origem `lembrete_aviso_*`.
Dry-run completo em prod dentro de `DO ... RAISE EXCEPTION` (R-18, gestor e
colaborador) antes de abrir o PR. Enquanto não aplicada, a tela "Lembretes"
abre e mostra "Erro ao carregar lembretes" (tabela inexistente) — sem efeito
sobre as demais telas. Depois de aplicar: mover para `lembretes` o registro
de 04/09/2026 gravado em `audiencias` (processo 0005592-24.2024.8.16.0079,
"NÃO É AUDIÊNCIA") e excluí-lo de lá.
