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

## 20260910_03 — lembretes do tipo `prazo` sem o aviso "Em 10 minutos"

**Aplicada em 10/09/2026** (MCP `apply_migration`, nome `lembretes_prazo_sem_min10`). Só `CREATE OR REPLACE` de `lembretes_agendar_avisos()`; tabela,
RLS e trigger ficam como estão. `origem = 'prazo'` gera véspera 19h + dia 08h (sem
`min10`) e usa texto próprio ("Prazo vence amanhã/hoje", "Prazo fatal: dd/mm/aaaa");
`origem` passa a contar como mudança que recria os avisos. Decisão do gestor em
10/09/2026 — prazos processuais deixam de viver só na Google Agenda e passam a
avisar no WhatsApp; prazo não tem hora, então o terceiro aviso (07:50) era ruído.
Dry-run R-18 em prod dentro de begin/rollback, gestor e colaborador: prazo → 2
avisos, tarefa → 3, `UPDATE origem` manual→prazo → 2 pendentes/3 cancelados,
concluir → 0, colaborador barrado no INSERT e lendo 2. A tela grava só
`origem = 'manual'`; prazos nascem pela skill. Rollback pareado.

## 20260910_04 — resumo diário da agenda no WhatsApp (07:00 BRT)

**Aplicada em 10/09/2026** (MCP `apply_migration`, nome `resumo_diario_agenda`; cron `resumo-diario-agenda` ativo). Função `resumo_diario_agenda(p_dry_run, p_dia)` (SECURITY DEFINER,
REVOKE de PUBLIC/anon/authenticated) + pg_cron `resumo-diario-agenda` às `0 10 * * *`
(10:00 UTC = 07:00 BRT). Lê `audiencias` e `lembretes` do dia e enfileira UMA mensagem
(origem `resumo_diario`) para o número do escritório; idempotente por dia; dia útil
vazio avisa "Nenhuma audiência, prazo ou lembrete", fim de semana vazio fica em
silêncio. Fonte é só o banco — a Google Agenda é espelho (decisão de 10/09/2026);
os "Debito DDA" da agenda são automação externa e ficam de fora. Dry-run em prod
(begin/rollback) com `p_dry_run = true` para 10, 11, 12, 14 e 16/09: mensagens
conferidas, nada persistiu. Rollback pareado.

## 20260911_01 — cedente só lê documento de repasse

**Aplicada em 11/09/2026** (MCP `apply_migration`). Reescreve `documentos_cedente_scope`
(tabela) e `documentos_cedente_select` (bucket): o cedente passa a ler só
`categoria = 'repasse'` ou documento referenciado por `repasses_cliente.documento_id`
do próprio cliente. Antes lia qualquer documento das cobranças dele (contrato, acordo
assinado, petição) — o portal não listava, mas a API entregava. Decisão do gestor em
11/09/2026. Dry-run R-18 em prod: cedente `bfc42619` 69 repasse + 1 acordo sintético →
69 repasse; gestor inalterado. Rollback pareado.

## 20260911_02 — colaborador em `cobrancas/…` no bucket; cedente de grupo lê repasse

**Não aplicada.** Só policies, aditivas. (A) `documentos_cobranca_staff_insert/select`
em `storage.objects`: paths `cobrancas/<id>/…` resolvidos pela RLS de `cobrancas` e
restritos a `proprietario`/`colaborador` — as policies antigas avaliam
`pode_ver_devedor(foldername[2])`, que nunca casa com id de cobrança (R-24). (B)
`documentos_cedente_grupo` + `documentos_cedente_grupo_select`: espelham o predicado
de `repasses_cedente_grupo`, mantendo a regra da `_01`. Dry-run R-18 em prod:
colaborador 0 → 7 objetos, INSERT em caso dele passa e em caso alheio é negado;
cedente de grupo 0/16 → 16/16 comprovantes; cedente próprio e gestor iguais.
Rollback pareado.

## 20260911 — resumo das 07h com o CNJ inteiro

**Aplicada em 11/09/2026** (MCP `apply_migration`, nome `resumo_cnj_inteiro`). Só `CREATE OR
REPLACE` de `resumo_diario_agenda()`: os três `left(numero_processo, 10)` viram o número inteiro,
porque o Gustavo pesquisa pelo CNJ completo (mesma decisão do título dos eventos na agenda).
Rollback = reaplicar a função de `20260910_04`.

## 20260912 — base da Receita: contato/endereço + busca reversa (`rf_*`)

**Aplicada em 12/09/2026** (MCP, `rf_cnpj_contato_endereco`). `20260912_rf_cnpj_contato_endereco.sql` (+ `_rollback`). Aditiva:
colunas de contato/endereço em `rf_estabelecimentos`, `capital_social` em
`rf_empresas`, índices, e as RPCs `buscar_empresas_por_telefone`,
`buscar_empresas_por_endereco`, `buscar_empresas_por_email` e `rf_base_status`.
Validada em 12/09/2026 num `begin … rollback` em produção (compila; com uma linha
sintética, telefone/endereço/e-mail acham a COBRASQ e rua errada no mesmo CEP+nº → 0).

Ordem: **aplicar a migração → rodar `scripts/import_cnpj_rf.py --uf PR,SC,RS`**
(precisa de `scripts/.env.local` com `DATABASE_URL`; baixa ~7,6 GB do WebDAV da
Receita; a carga faz TRUNCATE + COPY das 3 tabelas numa transação). Enquanto a base
está vazia, `api/_cnpja.js` responde "indisponível" + link manual (F-35) em vez do
falso "nenhuma empresa".

## 20260912_02 — tribunal pelo segmento do CNJ + intimações do DJEN

**Não aplicada.** `20260912_02_intimacoes_djen.sql` (+ `_rollback`). Aditiva:
função `cnj_tribunal(text)` (tabela J.TR completa da Res. CNJ 65/2008) + backfill de
`intimacoes_email.tribunal` onde era NULL (R-25: 18 linhas em prod — TRF4/TRT9/TJMT,
que sumiam da aba "Urgentes"); tabela `intimacoes_djen` (RLS = `intimacoes_email`:
staff lê, proprietário escreve), função `intimacoes_djen_cruzar(p_dias)` (SECURITY
DEFINER, REVOKE de PUBLIC/anon/authenticated — só o worker chama), view
`vw_intimacoes_so_diario` (security_invoker), índice `uq_dev_eventos_djen_dedup` e
cron `djen-intimacoes` às `0 11 * * *` (08:00 BRT) chamando a Edge Function nova.

Dry-run em prod (begin/rollback) em 12/09/2026: compila; `cnj_tribunal` devolve
TRF4/TRT9/TJMT/TJPR/TJRS/TRE-PR/TJMSP e NULL p/ lixo; backfill acerta 18/19 (a 19ª não
tem número); com as 107 comunicações reais de 10–20/08 inseridas, o cruzamento casa 13
pela publicação ± 3 e 58 pela data do ato citada no texto — sobram 38 TJPR + as 2 do
TJRS "só no diário". RLS (R-18): cedente 0 linhas e INSERT/UPDATE negados; colaborador
lê 1 e não escreve; proprietário tudo; `authenticated` sem EXECUTE na RPC.

**Ordem:** aplicar a migração → `supabase functions deploy djen-intimacoes` (secrets já
existentes: `CRON_INVOKE_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; opcional
`DJEN_OABS`) → `supabase functions deploy email-intimacoes` (tabela de tribunais nova)
→ backfill manual `POST /djen-intimacoes {"inicio":"2026-08-01","fim":"<hoje>"}` com
o bearer do cron. Enquanto a migração não estiver aplicada, a aba "Só no diário" abre
com a mensagem "Não foi possível ler o diário" e as outras abas seguem iguais.

## 20260912_03 — `proc_intimacoes` aceita fonte `email`/`djen` + backfill (R-27)

**Não aplicada.** Depende só do CHECK antigo (2026-06-23a); é independente da
`20260912_02`, mas o rollback desta apaga também linhas `djen` se existirem. Amplia o
CHECK e insere os 309 atos de e-mail vinculados (com devedor existente) como `lida=true`
— o badge de não-lidas não muda. Dry-run em prod (begin/rollback) em 12/09/2026:
309 inseridos, INSERT novo com `fonte='email'` passa, rollback restaura o CHECK e zera
as linhas. Depois de aplicar: **recarregar o painel** (a aba "Andamentos" passa a ter
a fonte "email" nos chips).

## 20260913_01 — fila `vw_intimacoes_agenda_pendente` para as skills de agenda

**Não aplicada.** `20260913_01_intimacoes_agenda_pendente.sql` (+ `_rollback`). Só leitura:
funções `dia_util_forense(date)` (seg–sex sem feriado nacional = `feriadosBR()` do painel),
`somar_dias_uteis(date,int)`, `intimacao_parse_audiencia(ato, ato_curado)` (lê "Agendada para:
26 de outubro de 2026 às 14:00, em <órgão>, Modalidade: <x>" do PROJUDI ou "dd/mm/aaaa hh:mm")
e a view `vw_intimacoes_agenda_pendente` (security_invoker): `audiencia` (PROJUDI com data+hora,
futura, sem linha igual em `audiencias`), `audiencia_sem_data` (eproc, sem audiência futura nem
lembrete) e `prazo` (intimação de tribunal ≠ TJPR sem lembrete, com fatal ESTIMADO de 15 dias
úteis). **Nada entra em `audiencias`/`lembretes` sozinho** — decisão do gestor em 13/09/2026: só
a skill grava, porque só ela faz tabela + Google Agenda + WhatsApp juntos; a view é a fila que
`/audiencias-cobrasq` e `/lembretes-cobrasq` leem. Dry-run em prod (begin/rollback) em
13/09/2026: 8 audiências, 9 prazos, 0 sem data; sem falso positivo do texto longo do PROJUDI.
