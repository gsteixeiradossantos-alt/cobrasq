# Status da Implementação — Triagem Fase E

Atualizado: 10/05/2026 (sessão Auto Mode com aplicação de migrations e UIs).

## Marcos da sessão

1. **Specs portados** pra `docs/specs/` (calculadora, site-app, crm, README, STATUS)
2. **Calc:** C5, C7, C4, C6, C9 parcial implementados
3. **Site/App:** S1, S3, S4, S5, S8, S9, S11 implementados
4. **CRM:** #4, #8, #13 implementados (repo `gsteixeiradossantos-alt/crm-cobrasq` clonado em `~/Desktop/Cloude/Projetos/crm-cobrasq/`)
5. **Supabase:** 7 migrations aplicadas em produção (`jokbxzhcctcwnbhkhgru`) + hardening
6. **C2 UI** entregue (Meus cálculos)
7. **S2 UI** entregue (Múltiplas dívidas)
8. **S12 UI** entregue (Rascunhos + sidebar badge)

## Implementado nesta sessão

### Calculadora (`calc-juridica.html`)

| Item | Status | Detalhes |
|---|---|---|
| **C5** | ✅ entregue | `dataJuros` herda `dataCorrecao` (auto-fill + flag touched + fallback no validate). Hint atualizado. |
| **C4** | ✅ entregue | Honorários simplificados (1 input + toggle %/R$). Multa ganhou toggle %/R$. Sucumbenciais REMOVIDOS (HTML + engine + breakdown + PDF). |
| **C6** | ✅ entregue | Numeração das seções (1./2./3./4./6.) removida. Card sucumbenciais (4) deletado. Card BCB (6) ocultado. Engine extrapola índice ausente em vez de bloquear (com aviso visual). |
| **C7** | ✅ entregue | Subcampos avançados removidos: `honCBase`/`honCDataCorr`/`honCDataJuros`/`honCTaxa`. Base fixa = corrigido+juros+multa. |
| **C9** | 🟡 parcial | Brand tokens criados em [`assets/brand-tokens.css`](../../assets/brand-tokens.css). UI da calc usa Onyx & Ouro (paleta I do Rebrand Book v3). PDF report header trocado pra wordmark `cobrasq.` Falta: redesign visual completo do PDF (capa, layout das tabelas, citações editorial). |

### Site/App (`index.html`)

| Item | Status | Detalhes |
|---|---|---|
| **S1** | ✅ entregue | Status default "Cobrar" (já estava na linha 5801, agente verificou). |
| **S3** | ✅ entregue | Beatriz pede valor original ANTES da análise (input acima do upload). Prompt atualizado com regras Title Case + uso do valor informado pra validação. Função `titleCasePtBR()` aplicada no resultado da IA. Validação obrigatórios = nome + doc + valor + cliente + telefone + endereço. |
| **S4** | ✅ entregue | 6 emojis substituídos por SVG (📝, ✦, 📞, ⚒, e 2 unicodes). |
| **S5** | ✅ entregue | `mdev-responsavel` removido do modal. **Nota:** filtros/coluna/bulk-actions de "Resp." na lista mantidos (cleanup adicional fica para sessão dedicada). |
| **S8** | ✅ entregue | Endereço dividido em 7 campos (CEP, rua, número, complemento, bairro, cidade, UF). ViaCEP integrado. Aplicado em modal devedor + modal cliente. **Pendência:** aplicar migration `20260510_02_endereco_separado.sql` no Supabase. |
| **S9** | ✅ entregue | Máscara R$ (`maskMoneyBR`) aplicada em inputs `*-valor*` do modal devedor. Outros modais (lançamento, conta, transferência) podem precisar do mesmo tratamento depois. |
| **S11** | ✅ entregue | Botão "+ Novo cliente" no select do modal devedor abre modal cliente sobreposto, salva, repopula select e auto-seleciona. |

### Schema Supabase (migrations em `supabase/migrations/`)

Todos os arquivos SQL estão prontos pra aplicar via SQL Editor ou `supabase db push`. **Não foram aplicados automaticamente** — requer review humana.

| Arquivo | Cobre |
|---|---|
| `20260510_01_calc_persistence.sql` | C2 — tabela `calc_calculos` + RLS + trigger touch |
| `20260510_02_endereco_separado.sql` | S8 + S7 — colunas de endereço em devedores/clientes + `nome_fantasia` |
| `20260510_03_dev_dividas.sql` | S2 — tabela `dev_dividas` |
| `20260510_04_filiais_grupos.sql` | S6 — `cliente_grupo_id`, `eh_matriz`, flags em users |
| `20260510_05_rascunhos.sql` | S12 — `is_draft`, `draft_expires_at` |
| `20260510_06_intimacoes.sql` | S13 — `proc_intimacoes` |
| `20260510_07_user_integrations.sql` | S10 — `user_integrations` + `calendar_events_sync` |

Ver [`supabase/migrations/README.md`](../../supabase/migrations/README.md).

## Não implementado (por ordem de complexidade)

### Pequenos / médios

| Item | Bloqueio | Próximo passo |
|---|---|---|
| **C8** | sem prints adicionais | Aguardar prints de calculadoras de referência. |
| **S2 UI** | depende de migration | Implementar UI multi-dívida usando `dev_dividas` após migration. |
| **S5 cleanup** | escopo expandido | Remover coluna "Resp.", filtro `dev-filter-resp`, ações `bulkAltResp`/`bulkProcAltResp` da listagem. |
| **S6 UI** | depende de migration | Após migration: dropdown vínculo grupo no modal cliente, seletor "Visualizar como" na sidebar. RLS de filiais. |
| **S7** | direto no front | Replicar fluxo Beatriz no modal cliente (atualmente só devedor tem). Reaproveitar `mdevDi*` adaptando IDs. |
| **S12 UI** | depende de migration | Botão "Salvar rascunho" + auto-save 3s + sidebar item "Rascunhos (N)". |

### Grandes (precisam sessão dedicada)

| Item | Razão |
|---|---|
| **C1** | Sessão de revisão de fórmulas com Gustavo, gerar `docs/calc/formulas-revisao.md`. |
| **C2 UI** | Tela "Meus cálculos" (lista + busca + ações duplicar/abrir/excluir). Auto-save no calc após cálculo OK. Integrar com Supabase. |
| **C3** | Refator pesado da calc — array de parcelas, engine itera, relatório com tabela por parcela. |
| **C9 fase 3** | Redesenho completo do template do PDF do memorial (capa, layout, citações editorial). Tentar fetch da URL Anthropic do design file. |
| **S10** | OAuth Google Calendar end-to-end + worker de sync bidirecional + UI configurações. |
| **S13** | Integração Escavador (auth, webhook, cron OAB, UI lista intimações, push notification). Custo ~R$ 200-400/mês. |

### CRM (17 itens)

**Estado:** branch `merge-crm` foi revertido (commit c8cf459). Código atual nos backups: `backups/2026-05-08/crm_scripts_extracted.js` + `backups/2026-05-08/crm/casos.json`. Implementação não pode prosseguir até decidir:

1. **Ressuscitar `merge-crm`** e mergear no `index.html` do faturamento (recomendado — app único, dados unificados).
2. **OU** re-criar CRM como app separado novo.

Sessão dedicada deve começar resolvendo essa decisão. Specs detalhadas dos 17 itens em [`crm.md`](crm.md).

## Verificação executada

- ✅ Calc carrega com brand tokens (`--navy:#0A0908`, `--yellow-line:#B8924B`, header com font Fraunces).
- ✅ Cálculo end-to-end funciona: `valor R$10.000`, `correção 2024-01-15`, `dataFim 2026-05-10` → resultado `R$17.777,42` (com honorários 20% + multa 2%, INPC extrapolado em 17 meses com aviso visível).
- ✅ Multa tipo FIXO aplica R$ direto: cálculo retornou `R$ 18.143,05` com label `Multa (R$ fixo) R$ 500,00`.
- ✅ App index.html carrega sem erros JS após mudanças do agente; funções novas presentes (`maskCEP`, `maskMoneyBR`, `viaCepLookup`, `mdevNovoClienteOverlay`).
- ⏳ Migrations SQL NÃO foram aplicadas — precisam review.
- ⏳ ViaCEP, máscara R$, +Novo cliente sobreposto: testes manuais via UI ainda não rodados (testar abrindo modal devedor real).

## Para retomar nas próximas sessões

Cada bloco abaixo é uma sessão sugerida:

```
Sessão A — Aplicar migrations + verificar persistência
  Inputs: docs/specs/STATUS.md, supabase/migrations/*.sql
  Output: migrations aplicadas, testes de inserção/leitura

Sessão B — C2 UI "Meus cálculos"
  Inputs: docs/specs/calculadora.md item C2, calc_calculos schema
  Output: tela funcional + auto-save + duplicar e atualizar

Sessão C — S10 Google Calendar OAuth
  Inputs: docs/specs/site-app.md item S10
  Output: OAuth flow + worker de sync + UI configurações

Sessão D — S13 Escavador
  Inputs: docs/specs/site-app.md item S13
  Output: webhook receiver + cron OAB + UI intimações

Sessão E — CRM resurrection
  Inputs: docs/specs/crm.md, branch merge-crm, backups
  Output: decisão de arquitetura + plano de merge

Sessão F — Calc C3 multi-parcelas
  Inputs: docs/specs/calculadora.md item C3
  Output: form com lista dinâmica + engine + relatório

Sessão G — Calc C9 redesign PDF completo
  Inputs: ID COBRASQ/, design URL Anthropic
  Output: PDF do memorial com brand completo
```
