# Fase A — fixes de segurança e bugs sérios

**Data:** 2026-05-11
**Branch:** `claude/analyze-crm-repositories-xSJGJ`
**Plano-fonte:** `/root/.claude/plans/analise-meus-dois-reposit-rio-quirky-deer.md`

Este documento registra o que mudou na fase A da auditoria — correções urgentes de segurança e os bugs mais graves. Riscos SEC-01..06 (já catalogados em `00-inventario.md`) **continuam pendentes** porque exigem decisão do Gustavo (remoção de credenciais hardcoded, criação de BFFs, troca de hashing).

## O que foi corrigido

| Item | Arquivo | Resumo |
|---|---|---|
| SEC-N1 | `supabase/migrations/20260511_01_intimacoes_rls.sql` (novo) | `proc_intimacoes` agora restringe SELECT/UPDATE a staff (proprietario/colaborador) e cedente apenas das intimações dos próprios devedores. |
| SEC-N6 | `supabase/migrations/20260511_02_filiais_rls.sql` (novo) | Garante `pode_ver_grupo`/`cliente_grupo_id` em `app_users` (que a migration `20260510_04` tentou criar na tabela errada) e adiciona policies de leitura por grupo em `clientes` e `devedores`. |
| SEC-N2 | `supabase/functions/escavador-webhook/index.ts` | Exige `Authorization: Bearer <ESCAVADOR_WEBHOOK_TOKEN>` em tempo constante, retorna 401 sem token. |
| B8 | `supabase/functions/escavador-webhook/index.ts` | Valida `processo_numero` contra regex CNJ antes de interpolar no filtro `.or()` e antes de gravar. |
| SEC-N3 | `supabase/functions/google-calendar-sync/index.ts` | CORS via allowlist (`GCAL_ALLOWED_ORIGINS`, default `https://cobrasq-faturamento.vercel.app`); 403 em origem não-listada; suporte opcional a `https://*.vercel.app` para previews. |
| SEC-N4 | `vercel.json` | Headers globais: HSTS (2 anos, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` zerada para câmera/mic/geo/payment, `Cross-Origin-Opener-Policy: same-origin`. CSP **não** foi adicionada nesta fase porque o app depende de `onclick=` inline e `innerHTML` — habilitar CSP estrita exige refactor (planejado em Fase E). |
| SEC-N5 | `calc-juridica.html` | (a) `error.message` agora vai por `createTextNode` (não mais `innerHTML`); (b) listagem de "Meus cálculos" passou a usar `data-calc-action` + delegação no `<div>` da lista (zero `onclick=` com interpolação de `c.id`). |
| B5 | `api/cron-regua.js` | `SUPABASE_SERVICE_ROLE_KEY` agora é o nome canônico; `SUPABASE_SERVICE_KEY` mantido como fallback para não quebrar o deploy atual. |
| B1 | `index.html` (`syncToSupabase`, `loadFromSupabase`) | Sync agora é serializado por uma `Promise` única (`_syncInflight`) e usa optimistic concurrency com `updated_at` (baseline capturada no `loadFromSupabase`). Em conflito (outra aba salvou), recarrega e avisa o usuário em vez de sobrescrever. |
| B3 | `index.html:~5251` | Adicionado `.catch` no poll do ZapSign (era a única promise `.then` sem catch real — as outras duas reportadas pelo agente já tinham). |

## O que **não** foi feito (e por quê)

- **Q3 (SRI nos CDNs):** o sandbox desta sessão bloqueia rede externa, então não consegui baixar `html-docx-js`, `html2pdf.js` e `@supabase/supabase-js@2` para gerar os hashes SHA-384. Pra fechar:

  ```sh
  for u in \
    https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js \
    https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js \
    https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2; do
      echo -n "$u  →  sha384-"
      curl -sL "$u" | openssl dgst -sha384 -binary | openssl base64 -A; echo
  done
  ```

  Depois colar cada hash no `integrity="sha384-..."` dos `<script>` em `index.html` (linhas 11, 13, 15) e `calc-juridica.html:8`.

- **B2 (listeners sem remove):** intervenção mais larga; entra na Fase C completa.
- **SEC-01..06:** decisão do Gustavo — checklist em `docs/audit/00-inventario.md:214-222`.

## Como testar

### 1. Migrations (SEC-N1, SEC-N6)

```sh
# Aplicar na nuvem (recomendado fazer em branch Supabase primeiro)
supabase db push
# OU colar conteúdo no SQL Editor:
#   supabase/migrations/20260511_01_intimacoes_rls.sql
#   supabase/migrations/20260511_02_filiais_rls.sql
```

Em seguida, com **dois usuários distintos** (um proprietário, um cedente de outro cliente), validar:

- Cedente do cliente A → `SELECT * FROM proc_intimacoes` deve voltar **apenas** as intimações de devedores do cliente A.
- Proprietário → vê tudo.
- Cedente sem `pode_ver_grupo` → não vê filiais; com flag e `cliente_grupo_id` setado → vê.

Também rodar `mcp__75579295-...__get_advisors` (security advisors do Supabase) e conferir zero warnings em `proc_intimacoes`/`clientes`/`devedores`.

### 2. Webhook Escavador (SEC-N2, B8)

```sh
# Sem token → 401
curl -i -X POST https://<proj>.supabase.co/functions/v1/escavador-webhook \
  -H 'content-type: application/json' -d '{}'
# Com token errado → 401
curl -i -X POST … -H 'authorization: Bearer wrong' -d '{}'
# Com token correto → 200
curl -i -X POST … -H "authorization: Bearer $ESCAVADOR_WEBHOOK_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"processo_numero":"0001234-56.2024.8.16.0001","conteudo":"teste"}'
# Com processo inválido → 200, mas processo_num grava NULL e devedor_id NULL
curl -i -X POST … -H "authorization: Bearer $ESCAVADOR_WEBHOOK_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"processo_numero":"abc),(injection","conteudo":"x"}'
```

Depois rodar `supabase secrets set ESCAVADOR_WEBHOOK_TOKEN=$(openssl rand -hex 32)` e configurar o header customizado correspondente no painel do Escavador.

### 3. CORS google-calendar-sync (SEC-N3)

```sh
# Origem permitida → 200
curl -i -X OPTIONS https://<proj>.supabase.co/functions/v1/google-calendar-sync \
  -H 'origin: https://cobrasq-faturamento.vercel.app'
# Origem qualquer → 403
curl -i -X OPTIONS … -H 'origin: https://evil.example.com'
```

Para liberar previews da Vercel: `supabase secrets set GCAL_ALLOWED_ORIGINS="https://cobrasq-faturamento.vercel.app,https://*.vercel.app"`.

### 4. Headers Vercel (SEC-N4)

```sh
curl -I https://cobrasq-faturamento.vercel.app/
# Conferir: Strict-Transport-Security, X-Content-Type-Options,
#           X-Frame-Options: DENY, Referrer-Policy
```

### 5. XSS calc-juridica (SEC-N5)

- Configurar Supabase URL inválida temporariamente.
- Abrir "Meus cálculos" → mensagem de erro deve aparecer literal (sem executar HTML/JS).
- Tentar criar um cálculo com `c.id` que contenha aspas (não dá pra gerar fácil em produção; teste sintético no DB) — o botão deve continuar funcional e o `id` deve aparecer no atributo `data-calc-id` corretamente escapado.

### 6. Race condition sync (B1)

- Abrir o app em duas abas.
- Editar campos diferentes em cada aba quase simultaneamente, salvar.
- Esperado: a segunda aba mostra toast "Outra aba editou o sistema — recarregando." e não sobrescreve a alteração da primeira.

### 7. Cron-regua (B5)

```sh
# Antes (deve continuar funcionando se SUPABASE_SERVICE_KEY estiver setado)
curl "https://cobrasq-faturamento.vercel.app/api/cron-regua?dry=1&secret=$CRON_SECRET"
# Depois de adicionar SUPABASE_SERVICE_ROLE_KEY no Vercel, remover SUPABASE_SERVICE_KEY
# e confirmar que ainda responde { ok: true, dry: true, ... }
```

## Próximos passos imediatos

1. **Operação:** setar no Vercel/Supabase as novas envs (`ESCAVADOR_WEBHOOK_TOKEN`, `GCAL_ALLOWED_ORIGINS`, `SUPABASE_SERVICE_ROLE_KEY`).
2. **Q3:** gerar e colar os hashes SRI (snippet acima).
3. **Decisão Gustavo:** liberar Fase B (SEC-01..06) — sem isso o app continua expondo chaves de API e credenciais no `localStorage`.
4. **Fase C completa:** terminar B2 (`AbortController` em modais), B4 (parar de mutar JSONB no cron), B6/B7.
