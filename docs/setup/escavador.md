# Setup Escavador (S13) + DataJud

Combo decidido na triagem Fase E: **Escavador** (intimações em tempo real via DJEN) + **DataJud** (CNJ oficial, andamentos básicos, gratuito).

## Estado da implementação

- ✅ Schema `proc_intimacoes` aplicado em prod (`supabase/migrations/20260510_06_intimacoes.sql`)
  - Suporta fontes: `escavador`, `jusbrasil`, `codilo`, `datajud`, `manual`
- ✅ Edge Function stub: `supabase/functions/escavador-webhook/index.ts`
- ⏸ **Pendente: contratação Escavador + secrets + deploy**

## Como ativar (você faz)

### 1. Contratar Escavador

- Site: https://www.escavador.com/
- Plano recomendado: **Acompanhamento Processual + DJEN** (~R$ 200-400/mês)
- Cadastrar OAB do escritório (Gustavo) — captura intimações destinadas à OAB mesmo sem processo cadastrado
- Pegar o **API Token** no painel

### 2. Configurar secrets no Supabase

```bash
supabase secrets set ESCAVADOR_TOKEN=<seu_token>
supabase secrets set ESCAVADOR_OAB=<sua_oab_pr>
```

### 3. Deploy da Edge Function

Da raiz do repo:
```bash
supabase functions deploy escavador-webhook --project-ref jokbxzhcctcwnbhkhgru
```

### 4. Configurar callback no painel Escavador

Após deploy, a função fica disponível em:
```
https://jokbxzhcctcwnbhkhgru.supabase.co/functions/v1/escavador-webhook
```

No painel Escavador, em **Configurações → Webhooks**, adicionar essa URL como destino de eventos `nova_intimacao`.

### 5. Adicionar processos pra monitorar

Pra cada processo cadastrado em `devedores.encaminhamento_judicial.processoNum`, registrar no Escavador via API:

```bash
curl -X POST https://api.escavador.com/api/v2/monitoramento/processo \
  -H "Authorization: Bearer $ESCAVADOR_TOKEN" \
  -d '{"numero_processo":"0001234-56.2024.8.16.0001"}'
```

(Implementar isso como cron diário que sincroniza `devedores → escavador`. TODO no código.)

## DataJud (gratuito, pull-only)

Pra andamentos processuais (não DJEN), o CNJ tem API pública:
- Doc: https://datajud-wiki.cnj.jus.br/
- Não precisa contratar — só `Authorization: APIKey <chave_publica>`
- Latência: 24-48h
- Útil pra confirmar metadata de processos cadastrados

Implementação: cron diário que consulta DataJud pra cada `processoNum` em `devedores`, atualiza metadata. **Pendente** — fica pra próxima sessão.

## UI no app

Após ativação:

1. Widget na home: "Intimações não lidas (N)" com últimas 5
2. Página `/intimacoes` com filtros (processo, devedor, data, lida/não lida)
3. Push notification (browser API) quando webhook recebe intimação durante uso ativo
4. Vínculo automático: quando `processo_num` da intimação bater com processo cadastrado, mostra ele na linha; senão "Não vinculada — clique pra cadastrar processo"

UI ainda **não implementada** — ficam pra próxima sessão depois de credencial Escavador estar no ar.

## Custo previsto

- Escavador: R$ 200-400/mês (varia conforme volume de processos monitorados)
- DataJud: gratuito
- Supabase Edge Functions: incluído no plano Pro do projeto
- **Total estimado: R$ 200-400/mês**
