# Fase C — bugs sérios sem refactor arquitetural

**Data:** 2026-05-11
**Branch:** `claude/analyze-crm-repositories-xSJGJ` (mesmo PR da Fase A)
**Plano-fonte:** `/root/.claude/plans/analise-meus-dois-reposit-rio-quirky-deer.md`

Sequência da Fase A — agora pega os bugs que precisavam de novo schema (B4, B7) e o vazamento de listeners mais óbvio (B2). B6 foi descartado.

## O que foi corrigido

| Item | Arquivos | Resumo |
|---|---|---|
| **B4** | `supabase/migrations/20260511_03_fase_C_regua_e_calendar.sql`, `api/cron-regua.js` | Cron-regua **parou de mutar `cobrasq_data`**. Idempotência por passo migrada para a tabela `regua_envios` (com UNIQUE em `(tipo, devedor_id, parcela_id, step_key)`). Histórico de execução vai pra `audit_logs`. Inclui back-fill automático na primeira run a partir do `_reguaEnviados` ainda presente no JSONB. |
| **B7** | mesma migration + `api/cron-regua.js` | `calendar_events_sync` ganhou `pending_delete` + `deleted_at`. Trigger `AFTER DELETE` em `devedores` marca os eventos órfãos. O cron, no fim de cada run, chama `google-calendar-sync` com `action: 'delete'` para cada pendente e marca `deleted_at`. |
| **B2** | `index.html` (helpers, drawer, popover de filtro, bulk dropdown) | Helpers `scopedOn(scope, target, type, handler)` + `disposeScope(scope)` baseados em `AbortController`. Aplicados nos 2 pontos que geravam vazamento real (`document.addEventListener` deixado pelo popover de filtros e pelo dropdown de bulk actions), além de `disposeScope('drawer')` em `closeDrawer`/`openDrawer` pra qualquer listener futuro adicionado nesse escopo. |
| **B6** | — | **Descartado.** O agente Explore reportou `getElementById('modal-rascunhos')` antes da criação dinâmica em `calc-juridica.html`, mas `grep -n "rascunh"` retorna 0 ocorrências no arquivo. Falso positivo. |

## Onde a Fase C **não** mexe (de propósito)

- Os ~55 `addEventListener` restantes do `index.html` ficam nos elementos recriados via `innerHTML` (filtros, tabs, inputs de modal). Quando o elemento some, o GC limpa o handler. Os **únicos** que vazavam de verdade eram os 2 em `document` que já tratamos. Estendir o padrão `scopedOn` ao resto entra como item de Fase E (modularização do `index.html`).
- O `calc-juridica.html` tem 4 `addEventListener` (linhas 860, 1003, 1015, 2239 — esse último já adicionado pela Fase A com `_meusCalculosDelegado`). Os outros 3 são em elementos que vivem o tempo todo da página (não vazam). Não vale o custo agora.
- Não migramos `devedores` / `cobrancas` / `processos` pra tabelas próprias (continua o JSONB). O cron passou a **ler** o JSONB sem **escrever** nele, que é o que importava pra B4.

## Como testar

### B4 — Cron sem mutar JSONB

```sh
# 1. Aplicar a migration
supabase db push   # ou colar 20260511_03_fase_C_regua_e_calendar.sql no SQL Editor

# 2. Snapshot do JSONB antes
psql "$SUPABASE_DB_URL" -c "select md5(data::text), updated_at from cobrasq_data where key='main';"

# 3. Dry run (não envia)
curl -s "https://cobrasq-faturamento.vercel.app/api/cron-regua?dry=1&secret=$CRON_SECRET" | jq
#   Esperado: { ok:true, dry:true, backfilled:N, ... }

# 4. Run real
curl -s "https://cobrasq-faturamento.vercel.app/api/cron-regua?secret=$CRON_SECRET" | jq
#   Esperado: enviados_*>=0; ZERO escritas no cobrasq_data

# 5. Snapshot do JSONB depois — md5 e updated_at devem permanecer iguais
psql "$SUPABASE_DB_URL" -c "select md5(data::text), updated_at from cobrasq_data where key='main';"

# 6. Confirma persistência da idempotência:
psql "$SUPABASE_DB_URL" -c "select tipo, count(*) from regua_envios group by tipo;"
```

Edição simultânea do usuário durante a janela do cron: agora o usuário pode salvar (`syncToSupabase`) que **não tem conflito** com a régua — antes, `cron` e `save` brigavam pelo mesmo blob.

### B7 — Cleanup de Google Calendar

```sh
# 1. Cria um devedor de teste com evento no Calendar (via app).
# 2. Apaga o devedor no app/SQL: DELETE FROM devedores WHERE id='...'
# 3. Confirma que o trigger marcou:
psql -c "select id, google_event_id, pending_delete, deleted_at
         from calendar_events_sync
         where source_table='devedores' and source_id='...'"
#    Esperado: pending_delete = true, deleted_at = null

# 4. Roda cron real (ou aguarda 12:00 UTC)
curl -s "https://…/api/cron-regua?secret=$CRON_SECRET" | jq '.calendar'
#    Esperado: { tentados: N, removidos: N, falhas: 0 }

# 5. Confirma que sumiu do Google Calendar (UI) e que deleted_at foi gravado.
```

### B2 — Listeners não vazam

- Abrir DevTools → Console → `getEventListeners(document)` (Chrome) antes de mexer.
- Clicar 20× no botão "Filtrar" da tela de devedores, abrir/fechar 20× o bulk dropdown.
- Voltar a `getEventListeners(document)` — número de listeners em `mousedown`/`click` deve voltar ao baseline (não cresce indefinidamente).
- Abrir/fechar o drawer 20×: sem aumento de listeners.

## Próximos passos (não nesta Fase)

- **Q3 (SRI)** continua pendente — comando no `01-fase-A-fixes.md`.
- **SEC-01..06** continuam aguardando decisão (`00-inventario.md:214-222`).
- **B2 completo** + extração de módulos JS do `index.html`: Fase E (arquitetural).
- **Migração JSONB → tabelas** (A2 do plano): Fase E.

## Variáveis novas no servidor

Nada novo nesta fase além do que já consta na Fase A (`ESCAVADOR_WEBHOOK_TOKEN`, `GCAL_ALLOWED_ORIGINS`, `SUPABASE_SERVICE_ROLE_KEY`). O cron-regua passa a **chamar** a edge function `google-calendar-sync` — confira que o Vercel env `SUPABASE_SERVICE_ROLE_KEY` e a edge function estão deployadas.
