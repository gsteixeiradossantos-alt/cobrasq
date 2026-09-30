-- ============================================================================
-- IDEMPOTÊNCIA DE "LANÇAR PARCELAS" (handoff v3 §11)
--
-- "Lançar parcelas" cria N fin_lancamento previstos a partir das parcelas do
-- acordo. A proteção era uma flag em acordos.metadata.parcelasLancadas — um
-- read-then-write: dois cliques rápidos leem "false" antes de qualquer um
-- gravar e o acordo entra duplicado no caixa.
--
-- A chave passa a viver no banco: (acordo_id, numero_parcela) UNIQUE. O app faz
-- upsert com ignoreDuplicates, então o segundo clique simplesmente não faz nada.
--
-- APLICADA EM PRODUÇÃO em 29/07/2026, com autorização expressa do dono. Não
-- houve backfill: a coluna nasceu vazia, então nenhum índice podia colidir.
-- O fallback no app (insert antigo quando a coluna não existe) fica de pé para
-- ambientes que ainda não tenham a migração.
-- ============================================================================

begin;

alter table public.fin_lancamento
  add column if not exists acordo_id uuid references public.acordos(id) on delete set null;

-- Parcial: lançamento avulso (sem acordo) não entra na restrição.
create unique index if not exists fin_lancamento_acordo_parcela_uidx
  on public.fin_lancamento (acordo_id, numero_parcela)
  where acordo_id is not null;

create index if not exists fin_lancamento_acordo_idx
  on public.fin_lancamento (acordo_id)
  where acordo_id is not null;

commit;

-- ── ANTES DE APLICAR ────────────────────────────────────────────────────────
-- O índice único falha se já houver duplicata histórica. Conferir:
--   select acordo_id, numero_parcela, count(*)
--     from public.fin_lancamento
--    where acordo_id is not null
--    group by 1,2 having count(*) > 1;
-- (Com acordo_id recém-criado o resultado é vazio; a checagem vale em reaplicação.)

-- ── BACKFILL OPCIONAL ───────────────────────────────────────────────────────
-- Lançamentos antigos não têm acordo_id. Dá para ligar pela descrição
-- ("Parcela i/N · <devedor>"), mas é heurística: fica de fora de propósito.
-- Sem backfill, o histórico segue sem proteção e os novos já nascem protegidos.

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- drop index if exists public.fin_lancamento_acordo_parcela_uidx;
-- drop index if exists public.fin_lancamento_acordo_idx;
-- alter table public.fin_lancamento drop column if exists acordo_id;
