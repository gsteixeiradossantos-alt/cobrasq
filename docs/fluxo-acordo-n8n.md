# Fluxo de Acordo via n8n — engenharia reversa (2026-06-11)

> Fonte: export do workflow "Acordo Judicial e Extrajudicial" (118 nós) + os 3
> templates Google Docs, fornecidos pelo gestor. Este doc é a referência para a
> futura internalização do fluxo no CRM e para a Feature X.

## Os 3 templates (Google Docs, placeholders `[var]` + âncoras ZapSign `<<tag>>`)

| Template (Drive) | Quando é usado | Características |
|---|---|---|
| `n8n - A. Extrajudicial` | Devedor FORA de Francisco Beltrão | Confissão de dívida (art. 784 III e §4º CPC), 10 cláusulas |
| `n8n - ADV A. Extrajudicial` | Devedor EM Francisco Beltrão (`If2`: Município dev1/dev2 contém "Francisco Beltrão") | Versão em nome do CLIENTE com identidade da ADVOCACIA (exigência do judiciário de Beltrão). 15 cláusulas — extras: penhora de previdência privada, cessão de cotas de cooperativa, taxa de alteração de boleto (R$50/R$100), dispensa de testemunhas em assinatura digital, autorização LGPD p/ localização (iFood/Shopee/etc.), WhatsApp fixo 46 98822-6533 p/ comprovantes |
| `Modelo - Acordo Judicial` | Planilha "Acordo Judicial - Beta n8n" | Termo p/ homologação (art. 515 II CPC): Sisbajud, SerasaJud, manutenção de penhoras, averbações premonitórias, desconto em folha 30% (FONAJE 59) |

Cláusulas comuns: boletos em até 5 dias úteis após assinatura; multa de atraso
`[multaatrasodoboleto]` + juros 1% a.m. + IGP/INPC; vencimento antecipado;
cláusula penal `[clausulapenal]`; devolução de docs (frete R$ 50); solidariedade
de sócios; foro Dois Vizinhos/PR. Suporta até 3 devedores, 2 credores e advogado
como signatários condicionais (IFs por campo vazio).

## O fluxo (3 entradas)

1. **Planilha "Acordo Extrajudicial - Form"** (a MESMA que o CRM alimenta via
   `gsheet-acordo`) → If2 (Beltrão?) → copia template certo p/ pasta nova no
   Drive → substitui ~39 variáveis (Google Docs API) → **ZapSign** cria doc a
   partir do PDF exportado do Docs (`url_pdf`), `external_id` = carimbo de
   data/hora da planilha, signers com `require_cpf` + **selfie + foto do
   documento** → avisos via Z-API.
2. **Planilha "Acordo Judicial - Beta n8n"** → mesmo padrão com template judicial.
3. **Webhook `zapsignassinado`** (chamado pelo ZapSign na assinatura) →
   aviso no grupo WhatsApp do escritório → busca linha da planilha →
   **Asaas (produção)**: cria/atualiza customer + cobrança (avulsa | parcelada
   `installmentCount` | entrada separada) → lançamentos no **Controlle** (agente
   OpenAI escolhe categoria/conta/contato) → **Z-API**: envia link dos boletos
   ao devedor.

## Achados críticos

1. **Credenciais de produção hardcoded no workflow** (token Asaas prod, Z-API
   instância/token/client-token, em texto puro no JSON). Recomendação: mover
   para credenciais nativas do n8n e **rotacionar** os tokens expostos.
2. **Conflito de webhooks ZapSign**: o n8n usa o webhook `zapsignassinado`; o
   CRM tem o `zapsign-webhook` (Supabase Edge). Conferir no painel ZapSign quais
   URLs estão cadastradas — se só o n8n recebe, o CRM nunca atualiza
   `status_zapsign`; o ZapSign suporta múltiplos webhooks, os dois podem coexistir.
3. **Gap de integração**: quem cria o doc no ZapSign é o n8n; o token do
   documento (`zapsign_doc_id`) nunca chega à tabela `acordos` do CRM — por isso
   o webhook do CRM responde "acordo não encontrado" (match é por doc_id exato).
   Correção mínima: nó extra no n8n gravando o doc token no acordo via REST do
   Supabase (match por external_id/carimbo), OU o CRM passar a criar o doc.

## Caminho de internalização (proposta, em fases)

- **Fase 1 (aplicada em 2026-06-11):** manter n8n; cadastrar o webhook do CRM no
  ZapSign em paralelo; nó extra no n8n grava `zapsign_doc_id` no acordo → CRM
  passa a rastrear status E salvar o PDF assinado na pasta (Feature Y).
- **Fase 2:** mover a geração do doc para o CRM (templates fixos com as
  cláusulas dos 3 modelos e a regra de Beltrão como campo `municipio`),
  eliminando Drive/planilha.
- **Fase 3:** mover Asaas/boletos pro CRM (o faturamento já tem proxy Asaas) e
  aposentar o workflow.

## Fase 1 — instruções de configuração (gestor)

### A. Cadastrar o webhook do CRM no ZapSign (não remove o do n8n)

1. Supabase Dashboard → projeto → **Edge Functions → Secrets**: confirme que
   `ZAPSIGN_WEBHOOK_SECRET` existe. Se não souber o valor, defina um novo
   (30+ caracteres aleatórios) — anote-o.
2. Painel ZapSign → **Configurações → Webhooks → Adicionar**:
   `https://jokbxzhcctcwnbhkhgru.supabase.co/functions/v1/zapsign-webhook?token=<SECRET>`
   Eventos: todos os de documento (doc_signed, doc_refused, etc.).
3. O webhook `zapsignassinado` do n8n permanece como está (coexistem).

### B. Nó novo no n8n: "CRM - Vincular acordo" (3 cópias)

RPC criada no banco: `vincular_zapsign_acordo` (migração
`2026-06-11a_vincular_zapsign_acordo.sql`). Idempotente; acha o devedor por
CPF (fallback: últimos 8 dígitos do telefone); reaproveita acordo aberto sem
doc vinculado ou cria um novo (`forma='boleto'`, `status_zapsign='enviado'`).

Em cada um dos 3 nós que criam o doc no ZapSign ("Gerando acordo e 1
Signatário", "…1" ADV, "…2" judicial), ligar na saída um **HTTP Request**:

- Método: POST
- URL: `https://jokbxzhcctcwnbhkhgru.supabase.co/rest/v1/rpc/vincular_zapsign_acordo`
- Autenticação: credencial n8n do tipo **Header Auth** — Name: `apikey`,
  Value: chave **service_role** do Supabase (Dashboard → Settings → API).
  NUNCA colar a chave no corpo do nó (credencial nativa, como recomendado
  para os tokens Asaas/Z-API).
- Body (JSON) — versão extrajudicial (ajustar nomes de nós nas outras):

```json
{
  "p_doc_token": "{{ $json.token }}",
  "p_external_id": "{{ $('Google Sheets Trigger1').item.json['Carimbo de data/hora'] }}",
  "p_cpf_dev": "{{ $('Dados planilha').item.json['CPF ou CNPJ dev1'] }}",
  "p_telefone": "{{ $('Dados planilha').item.json['Telefone dev1'] }}",
  "p_valor_total": "{{ $('Dados planilha').item.json['Valor da dívida'] }}",
  "p_num_parcelas": "{{ Number($('Dados planilha').item.json['Quantidade de parcelas']) || null }}",
  "p_data_primeiro_venc": "{{ $('Dados planilha').item.json.Vencimento }}",
  "p_forma": "boleto"
}
```

No ramo judicial usar `$('Google Sheets Trigger2')` e `$('Dados planilha1')`.
Resposta esperada: `{"ok":true,"acao":"criado|atualizado","acordo_id":"…"}`.

