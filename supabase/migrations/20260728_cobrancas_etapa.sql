-- ============================================================================
-- ETAPA DO CICLO (handoff v3 §4) — cobrancas.etapa
--
-- Hoje "em que ponto do ciclo o caso está" fica espalhado entre `status`, `fase`,
-- `numero_processo` e a existência de tarefas, e é reinferido a cada render. Isso
-- torna impossível relatar/ordenar por etapa no banco e faz duas telas discordarem.
-- A etapa vira COLUNA, com backfill a partir das regras que a tela já usava.
--
-- ATENÇÃO: a view `casos` lista as colunas UMA A UMA — `etapa` NÃO aparece nela
-- só por existir na tabela. A tela de Cobranças lê `cobrancas` direto, então não
-- depende disso; expor em `casos` é uma redefinição de view à parte e, quando for
-- feita, tem de re-declarar `WITH (security_invoker = true)` (guarda anti-drift
-- F-04 — ver supabase/migrations/README.md).
--
-- APLICADA EM PRODUÇÃO em 29/07/2026, com autorização expressa do dono.
-- Backfill: 221 casos ativos, nenhum nulo — cobrar 71 · em_acao 62 · execucao 44
-- · encerrado 30 · acordo 11 · fazer_acao 3 (negociando e travado ficaram em 0:
-- não há status de negociação em uso hoje e a atividade mais antiga da carteira
-- tem 79 dias, abaixo do corte de 90).
-- O app segue derivando a etapa em runtime quando a coluna vier vazia (cobEtapa()
-- no index.html); a coluna tem precedência quando preenchida.
-- ============================================================================

begin;

alter table public.cobrancas
  add column if not exists etapa text,
  add column if not exists etapa_atualizada_em timestamptz;

alter table public.cobrancas
  drop constraint if exists cobrancas_etapa_check;

alter table public.cobrancas
  add constraint cobrancas_etapa_check
  check (etapa is null or etapa in
    ('cobrar','negociando','acordo','fazer_acao','em_acao','execucao','travado','encerrado'));

-- Filtro da tela é sempre etapa + (arquivado/is_draft): índice parcial cobre o caso real.
create index if not exists cobrancas_etapa_idx
  on public.cobrancas (etapa)
  where coalesce(arquivado,false) = false and coalesce(is_draft,false) = false;

-- ── BACKFILL ────────────────────────────────────────────────────────────────
-- Espelha cobEtapa() do index.html, na MESMA ordem de precedência (a etapa é uma
-- partição: o primeiro ramo que casa vence).
--   1 encerrado  — status terminal
--   2 execucao   — cumprimento/penhora COM processo
--   3 fazer_acao — natureza judicial e ainda SEM processo (falta protocolar)
--   4 em_acao    — judicial já protocolado
--   5 acordo     — qualquer etiqueta de acordo
--   6 negociando — conversa em curso
--   7 travado    — sem movimento há 90+ dias (evento mais recente do devedor,
--                   mesma fonte de sinais.ultimaAtividade no app)
--   8 cobrar     — o resto
update public.cobrancas c
set etapa = case
  when coalesce(c.status,'') ~* 'quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebido'
    then 'encerrado'
  when nullif(btrim(coalesce(c.numero_processo,'')),'') is not null
   and coalesce(c.status,'') ~* 'execu|cumprimento|penhora|hasta|expropria'
    then 'execucao'
  when nullif(btrim(coalesce(c.numero_processo,'')),'') is null
   and coalesce(c.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|a[çc][ãa]o de|monit[óo]ria|locupletamento'
    then 'fazer_acao'
  when nullif(btrim(coalesce(c.numero_processo,'')),'') is not null
    then 'em_acao'
  when coalesce(c.status,'') ~* 'acordo'
    then 'acordo'
  when coalesce(c.status,'') ~* 'negocia|proposta|em contato|contatad'
    then 'negociando'
  when coalesce(
         (select max(e.criado_em)
            from public.cobranca_partes cp
            join public.devedor_eventos e on e.devedor_id = cp.devedor_id
           where cp.cobranca_id = c.id),
         c.etapa_atualizada_em, c.updated_at, c.created_at
       ) < now() - interval '90 days'
    then 'travado'
  else 'cobrar'
end,
etapa_atualizada_em = coalesce(c.etapa_atualizada_em, c.updated_at, c.created_at, now())
where c.etapa is null;

commit;

-- ── VERIFICAÇÃO (rodar depois de aplicar) ───────────────────────────────────
-- select etapa, count(*), sum(coalesce(valor_atual, valor_orig, 0))
--   from public.cobrancas
--  where coalesce(arquivado,false) = false and coalesce(is_draft,false) = false
--  group by etapa order by 2 desc;
-- Nenhuma linha ativa pode ficar com etapa null.

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- drop index if exists public.cobrancas_etapa_idx;
-- alter table public.cobrancas drop constraint if exists cobrancas_etapa_check;
-- alter table public.cobrancas drop column if exists etapa;
-- (etapa_atualizada_em já era lida pelo app antes desta migração — não derrubar.)
