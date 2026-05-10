# Setup Google Calendar (S10)

Decisão: agenda compartilhada `ccobrasq@gmail.com` via Service Account (não OAuth por user).

## Estado da implementação

- ✅ Schema `user_integrations` + `calendar_events_sync` aplicado em prod
- ✅ Edge Function stub: `supabase/functions/google-calendar-sync/index.ts`
- ⏸ **Pendente: criar projeto GCP + service account + secrets + deploy + UI**

## Como ativar (você faz)

### 1. Criar projeto no Google Cloud Console

- Site: https://console.cloud.google.com/
- "Create Project" → nome "COBRASQ Calendar"
- Em "APIs & Services → Library", ativar **Google Calendar API**

### 2. Criar Service Account

- "IAM & Admin → Service Accounts → Create Service Account"
- Nome: `cobrasq-calendar`
- Role: nenhuma especial (acesso vem do compartilhamento da agenda)
- Após criar, abre a service account → "Keys → Add Key → Create new key → JSON"
- Baixa o JSON (vai ter `client_email` e `private_key`)

### 3. Compartilhar a agenda com a service account

- Abre Google Calendar logado em `ccobrasq@gmail.com`
- Configurações da agenda principal → "Compartilhar com pessoas específicas"
- Adicionar o `client_email` da service account com permissão "Fazer alterações em eventos"

### 4. Configurar secrets no Supabase

```bash
# JSON em uma linha (escapar quebras de linha do private_key como \n)
supabase secrets set GCAL_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"...","client_email":"...",...}'
supabase secrets set GCAL_CALENDAR_ID='ccobrasq@gmail.com'
```

### 5. Deploy da Edge Function

```bash
supabase functions deploy google-calendar-sync --project-ref jokbxzhcctcwnbhkhgru
```

### 6. Testar

```bash
curl -X POST https://jokbxzhcctcwnbhkhgru.supabase.co/functions/v1/google-calendar-sync \
  -H "Authorization: Bearer <SUPABASE_ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "create",
    "event": {
      "summary": "Teste COBRASQ",
      "description": "Evento de teste",
      "start": {"dateTime": "2026-05-15T14:00:00-03:00"},
      "end":   {"dateTime": "2026-05-15T15:00:00-03:00"}
    }
  }'
```

Se OK, retorna `{ok: true, event: {id: "...", htmlLink: "..."}}`. Confirma no Calendar.

## UI no app (pendente)

Após Edge Function ativa, implementar:

1. **Configurações → Integrações:** botão "Conectar Google Agenda" (mostra status: ativo / não-conectado)
2. **Trigger automático em:**
   - Acordo fechado → cria evento com 1 evento por parcela na data de vencimento
   - Lembrete agendado pelo operador (CRM #11) → cria evento na hora marcada
   - Vencimento de cobrança → cria evento na data de vencimento
   - Audiência cadastrada em processo → cria evento

3. **Salvar mapeamento em `calendar_events_sync`** (tabela já criada): `(google_event_id, source_table, source_id, event_type)` pra permitir delete/update depois

4. **Frontend chama a Edge Function:**
```js
async function syncToCalendar(action, event, eventId) {
  const { data: { session } } = await supa.auth.getSession();
  const r = await fetch('https://jokbxzhcctcwnbhkhgru.supabase.co/functions/v1/google-calendar-sync', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, event, eventId })
  });
  return r.json();
}
```

UI ainda **não implementada** — fica pra próxima sessão depois do GCP estar configurado.

## Custo

Google Calendar API: gratuito até 1M requests/dia. Suficiente.

Service Account: gratuito.

**Total: R$ 0/mês**
