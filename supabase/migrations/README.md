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

## Project ID

Supabase: `jokbxzhcctcwnbhkhgru` (per memória persistente).

## Pendências de aplicação

Aplicar manualmente via SQL editor ou:
```
supabase db push
```
