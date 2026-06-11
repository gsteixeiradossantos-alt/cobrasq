# Onda 2 — desenhos para aprovação (NADA aplicado no banco)

> Investigação read-only feita em 2026-06-11 no Supabase `jokbxzhcctcwnbhkhgru`.
> Cada bloco abaixo precisa de um "sim" do gestor antes de qualquer aplicação.
> Rollback escrito junto, como manda a regra da casa.

## O que a investigação encontrou (estado atual)

- **Storage:** bucket único `peticao-assets` — privado, limite 20 MB/arquivo, mimes:
  PDF, PNG, JPEG, WEBP, DOC, DOCX.
- **RLS do Storage:** SELECT para qualquer autenticado; INSERT/UPDATE/DELETE só se a
  **primeira pasta do path = auth.uid() de quem envia**. Consequência: o esquema de
  pastas por devedor (`devedores/<cpf>/...`) **não cabe no bucket atual** sem quebrar
  a política — é preciso bucket novo com política própria.
- **`cliente_documentos`** (metadados de docs do credor): id, cliente_id, tipo, nome,
  storage_path, mime_type, size_bytes, validade, ativo (soft-delete), uploaded_by,
  uploaded_at, obs. **RLS: qualquer autenticado lê/escreve/apaga tudo** — sem
  segmentação por papel/responsável (anotar como dívida, alinhada ao F-11).
- **Item 5 (resolvido sem pergunta):** o cadastro do devedor JÁ tem o radio
  obrigatório Física/Digital (`input[name="mdev-tipo-cobranca"]`, valores
  `fisica`/`digital`, persistido em `tipoCobranca` e na coluna `tipo_cobranca`,
  default `digital`). A folha de qualificação condiciona a `tipoCobranca==='fisica'`.

## Item 4 + Feature Y — documentos por devedor (proposta)

**Bucket novo** `documentos` (privado, 20 MB, mesmos mimes + `image/heic` se quiser
fotos de celular). Path determinístico:

```
devedores/<doc_normalizado>/<credor_id>/<categoria>/<arquivo>
  categoria ∈ contrato | nota-promissoria | comprovante | acordo-assinado
            | peticao | procuracao | calculo | outros
```

**Tabela nova `documentos`** (generaliza `cliente_documentos`, sem migrar a antiga
por enquanto — as duas convivem):

```sql
-- APLICAR SÓ COM APROVAÇÃO
create table public.documentos (
  id           uuid primary key default gen_random_uuid(),
  devedor_doc  text not null,            -- CPF/CNPJ só dígitos (chave da pasta)
  devedor_id   text,                     -- id do blob/tabela quando houver
  credor_id    text,                     -- id do cliente/credor (subpasta)
  categoria    text not null check (categoria in
    ('contrato','nota-promissoria','comprovante','acordo-assinado',
     'peticao','procuracao','calculo','outros')),
  nome         text not null,
  storage_path text not null unique,     -- unique = idempotência do webhook (Feature Y)
  mime_type    text,
  size_bytes   integer,
  ativo        boolean not null default true,
  uploaded_by  uuid references auth.users(id),
  uploaded_at  timestamptz not null default now(),
  obs          text
);
alter table public.documentos enable row level security;
create policy doc_select on public.documentos for select using (auth.uid() is not null);
create policy doc_insert on public.documentos for insert with check (auth.uid() is not null);
create policy doc_update on public.documentos for update using (auth.uid() is not null);
-- DELETE proposital sem policy: soft-delete via ativo=false (igual cliente_documentos).
```

RLS do bucket `documentos` (storage.objects): SELECT/INSERT/UPDATE para autenticado
com `bucket_id='documentos'`; sem DELETE (lixeira = mover para `_lixeira/`).
*Opção mais rígida (decidir): SELECT só para gestor + responsável pelo devedor —
exige resolver F-11 antes; começar permissivo-autenticado e apertar depois.*

**Rollback:** `drop table public.documentos;` + remover policies do bucket + apagar
bucket (se vazio). Nada toca `peticao-assets`/`cliente_documentos`.

**Feature Y (acordo assinado → pasta):** no `zapsign-webhook` (CRM), evento
`assinado` já entrega `doc.signed_file` (URL do PDF, hoje só gravada em
`link_zapsign`). Passo novo (Edge, service_role): baixar o PDF (timeout +
Content-Type `application/pdf`), subir em
`devedores/<doc>/<credor_id>/acordo-assinado/<zapsign_doc_id>.pdf` com
`upsert=false` + `storage_path` unique = idempotente (webhook duplicado não
duplica arquivo). Falha de download NÃO falha o webhook (grava aviso e segue).

**Migração do OneDrive (decisão do gestor: migrar tudo):** script local (na máquina
do gestor, fora de git) que percorre a pasta do OneDrive, normaliza CPF/CNPJ do
nome das pastas e sobe via API com a estrutura acima. Pedir: volume em GB e como
as pastas estão organizadas hoje (para escrever o mapeamento).

## Item 7 — home do colaborador (4 blocos escolhidos)

Front-only, PR separado. `renderPainel` já bifurca por `ehGestorView`; criar
`renderPainelColaborador()` com: (1) fila "o que fazer agora" = casos do próprio
usuário ordenados por `calcScore` desc; (2) casos sem interação há 7+ dias
(reaproveita a lógica do `calcScore`); (3) acordos aguardando assinatura
(`status_zapsign`) + promessas vencendo; (4) mini-resumo da carteira própria
(filtro `d.responsavel === currentUser.nome`). Gestor mantém a home atual.

## Itens 5+6 — folha de qualificação com a marca

Botão "Folha de qualificação" no drawer do devedor, visível só quando
`tipoCobranca==='fisica'`. Gera página de impressão (HTML + print CSS) com os
tokens do kit (`docs/design_handoff_cobrasq_b/README.md`: navy #002060, gold
#FABE44, Inter/JetBrains Mono) e os campos do modelo: Qualificação (credor,
recebida em, devedor, CPF/CNPJ, valor capital), SETOR COBRANÇAS EXTRAJUDICIAIS,
Telefones 1–6, RESULTADO (Acordo / Ajuizar–Sem contato / Ajuizar–Consegui
contato–Opção nº), Observações. O RESULTADO gravado no devedor prepara o gancho
da Feature X (Ajuizar → petição no CRM).

## Item 10 — backup diário automático

Função `api/backup.js` no padrão do `cron-regua.js` (mesmo CRON_SECRET +
timingSafeEqual), agendada 1×/dia no `vercel.json`: exporta `cobrasq_data` (blob)
+ tabelas relacionais em JSON para destino externo. **Pendente do gestor:**
destino (Google Drive do gestor? bucket Storage separado com retenção? e-mail?).
Sem PII em git; arquivo cifrado se o destino for compartilhado.

## Decisões do gestor (2026-06-11)

1. **Item 4 — volume OneDrive:** 5–50 GB → migração em lotes (1–2 dias de upload).
2. **Item 4 — organização atual do OneDrive:** uma pasta por CREDOR, devedores
   dentro. Gestor decidiu INVERTER na migração: **uma pasta por devedor, subpastas
   por credor + categorias** (boletos, acordos, recibos, provas...) — exatamente a
   estrutura `devedores/<doc>/<credor_id>/<categoria>/` proposta acima. O script de
   migração lê `credor/devedor/...` e grava invertido; pastas de devedor sem
   CPF/CNPJ identificável vão para relatório de pendências (resolução manual).
3. **Item 4 — quem vê documentos: SÓ gestor + responsável.** Consequência: o
   **F-11 (RLS por papel/responsável) vira PRÉ-REQUISITO do item 4** — a policy
   `doc_select` do rascunho acima deve checar papel/responsável, não só
   `auth.uid() is not null`. O desenho do F-11 entra antes do bucket.
4. **Item 10 — backup diário → Google Drive do gestor** (OAuth/credencial a
   configurar pelo gestor; a rotina sobe o JSON numa pasta dedicada).
5. **Envs confirmadas no Vercel** → fallbacks de credencial via header removidos
   dos proxies (asaas/zapsign/zapi) no PR #38. `x-asaas-env` (não-segredo) mantido.

## Feature X — requisitos levantados (2026-06-11)

**Tipos de ação:** execução de título extrajudicial · ação monitória · ação de
cobrança comum · ação de locupletamento ilícito.

**Checklist de documentos por tipo:**
- *Execução:* inicial, procuração, documentos do exequente, título executivo, cálculo.
- *Conhecimento (monitória/cobrança/locupletamento):* inicial, procuração,
  documentos do autor, prova da dívida, cálculo.
- **Campo por ação: "ajuizada em nome de"** = CobraSQ | cliente contratante. Se
  CobraSQ, itens condicionais (toggle por caso, decisão do gestor): declaração de
  cessão + Anexo I (comprovação da cessão de crédito).

**Protocolo:** Projudi em ~99% dos casos (PJe residual).

**Fluxo de revisão (estados da ação no CRM):**
`rascunho (colaboradora elabora) → revisão (gestor corrige) → aprovada →
protocolada (colaboradora protocola no Projudi e anexa nº do processo)`.

Encaixe com o resto: a folha de qualificação (itens 5+6) grava RESULTADO
"Ajuizar", que dispara a criação da ação em `rascunho`; as categorias do bucket
`documentos` já cobrem o checklist (`peticao`, `contrato`, `nota-promissoria`,
`comprovante` etc. — adicionar `procuracao` e `calculo` à lista de categorias).

## F-11 — RLS "só gestor + responsável" (✅ APLICADO em 2026-06-11, aprovação do gestor)

Migrações no Supabase: `f11_documentos_bucket_e_rls` + `f11_pode_ver_devedor_revoke_anon`
(esta última revoga EXECUTE de anon/public na função — higiene apontada pelo advisor).
Verificado pós-aplicação: 3 policies na tabela, 3 no storage, bucket privado 20 MB,
helper executa sem erro (retorna NULL/false sem sessão).

**Investigação (2026-06-11):** a infra de papéis JÁ existe e está saudável:
- `app_users.papel` ∈ `proprietario` (1 = gestor) | `colaborador` (4);
  `app_users.id` = `auth.users.id` nos 5 usuários (auth.uid() mapeia direto).
- Helper `public.current_user_papel()` (SECURITY DEFINER, search_path fixo) já criado.
- Responsável pelo devedor = **`devedores.assigned_to`** (uuid, preenchido nos 26).
  ⚠️ `devedores.responsavel_id` existe mas está NULL em todos — coluna legada,
  NÃO usar (anotar para limpeza futura).

**Proposta (aplicar JUNTO com o bucket/tabela `documentos`, mesma aprovação):**

```sql
-- Helper único, evita recursão de RLS nas policies
create or replace function public.pode_ver_devedor(p_doc text)
returns boolean language sql stable security definer
set search_path to 'public','pg_temp' as $$
  select public.current_user_papel() = 'proprietario'
      or exists (select 1 from public.devedores d
                  where d.doc_digits = p_doc and d.assigned_to = auth.uid());
$$;

-- Tabela documentos: substitui as policies permissivas do rascunho acima
create policy doc_select on public.documentos for select
  using (public.pode_ver_devedor(devedor_doc));
create policy doc_insert on public.documentos for insert
  with check (public.pode_ver_devedor(devedor_doc));
create policy doc_update on public.documentos for update
  using (public.pode_ver_devedor(devedor_doc));

-- Bucket documentos (storage.objects): path devedores/<doc>/... → folder[2] = doc
-- SELECT/INSERT/UPDATE: bucket_id='documentos'
--   and public.pode_ver_devedor((storage.foldername(name))[2])
```

Webhook ZapSign (Feature Y) usa service_role → ignora RLS, não é afetado.

**⚠️ Ajuste descoberto em 2026-06-11: 17 dos 26 devedores estão SEM CPF/CNPJ.**
A chave de pasta `devedores/<doc>/...` não funciona para eles. Decisão de
implementação: chave = `doc_digits` quando houver, senão `id-<uuid do devedor>`;
`pode_ver_devedor` ganha overload/ajuste para casar também por id. A migração do
OneDrive e a tela de documentos usam a mesma regra.
**Rollback:** drop das policies + `drop function public.pode_ver_devedor;`.
Dívidas que continuam abertas (fora deste pacote, apontadas pelo advisor):
- `cliente_documentos` segue permissiva-autenticado.
- **View `public.profiles` exposta a `anon` e SECURITY DEFINER** (pode vazar dados
  de `auth.users`) — pré-existente, nível ERROR no advisor; tratar em PR próprio.
- Leaked password protection do Auth desabilitada (toggle no dashboard).

## Perguntas ainda em aberto

Nenhuma — tudo respondido. Pacote pronto para aprovação do gestor:
F-11 (acima) + bucket/tabela `documentos`, aplicados juntos.
