-- ============================================================================
-- 20261016d — CAPITAL É O ÚNICO VALOR DE DÍVIDA DIGITADO OU CONFERIDO POR PESSOAS
--
-- APLICADA EM PRODUÇÃO em 16/10/2026 (MCP apply_migration
-- `cobrancas_capital_valor_unico`), com autorização do dono. Rollback pareado:
-- 20261016d_cobrancas_capital_valor_unico_rollback.sql
--
-- Por quê: `cobrancas` tem dois campos para o mesmo número — `valor_capital`
-- (base do repasse ao cliente, travado pelo trg_enforce_valor_capital_lock) e
-- `valor_orig` (lido pela view `casos`, RPCs, portais, régua, Bia,
-- exportações). O formulário de cobrança já gravava os dois iguais, mas a
-- importação do Astrea e o syncDevedorCobranca gravavam só `valor_orig`.
-- O trigger abaixo cobre também quem grava pela view `casos` (as funções
-- INSTEAD OF dela gravam em `cobrancas`). Resultado: em
-- 16/10/2026 havia 29 cobranças ativas (35 no total) com `valor_capital` nulo,
-- e a tela calculava o valor atualizado por um campo enquanto o cron
-- (api/cron-regua.js recalcularValoresAtuais) calculava pelo outro.
--
-- O que faz:
--   (1) backfill: valor_capital = coalesce(valor_capital, valor_orig,
--       (divida->>'valorCapital')::numeric) onde o capital é nulo;
--   (2) trigger BEFORE INSERT OR UPDATE em cobrancas que mantém os dois iguais:
--         - valor_capital preenchido            → valor_orig := valor_capital
--         - valor_capital nulo e valor_orig não → valor_capital := valor_orig
--       `valor_orig` vira espelho do capital, mantido pelo banco (regra R-17:
--       coluna derivada só ganha confiança quando há trigger mantendo-a).
--   Nenhuma coluna é removida. `valor_atual` (valor fixado de acordo, lido pelo
--   QuitaFácil, portal_meu_caso, régua e Bia) não é tocado.
--
-- Nome do trigger: `trg_cobrancas_capital_unico` dispara ANTES de
-- `trg_enforce_valor_capital_lock` (triggers BEFORE da mesma tabela rodam em
-- ordem alfabética: "trg_c…" < "trg_e…"). Assim a trava do capital avalia o
-- valor FINAL de valor_capital e continua barrando colaborador/anon. Efeito
-- colateral desejado: um UPDATE só de `valor_orig` numa cobrança com capital
-- definido deixa de alterar o número (o trigger devolve o capital) — fecha o
-- desvio em que se mudava a dívida por `valor_orig` sem passar pela trava.
--
-- ATENÇÃO — linhas DIVERGENTES (capital preenchido e diferente de valor_orig):
-- o backfill NÃO mexe nelas, mas o trigger faz valor_orig := valor_capital no
-- PRÓXIMO UPDATE de cada uma (qualquer update: status, etapa, cron…). Em
-- 16/10/2026 eram 17 (16 não arquivadas), entre elas uma com capital 0,00 e
-- valor_orig 5.400,00 — que passaria a ter valor_orig 0,00. Conferir com a
-- consulta (B) abaixo e decidir ANTES de aplicar.
--
-- ── CONFERÊNCIA — RODAR ANTES DE APLICAR (só leitura) ──────────────────────
-- (A) Quantas linhas o backfill preenche e quantas ficam nulas:
--
--   select
--     count(*) filter (where valor_capital is null)                          as capital_nulo_total,
--     count(*) filter (where valor_capital is null
--                        and coalesce(arquivado,false)=false
--                        and coalesce(is_draft,false)=false)                  as capital_nulo_ativas,
--     count(*) filter (where valor_capital is null and valor_orig is not null) as backfill_por_valor_orig,
--     count(*) filter (where valor_capital is null and valor_orig is null
--                        and divida->>'valorCapital' is not null)             as backfill_por_divida,
--     count(*) filter (where valor_capital is null and valor_orig is null
--                        and divida->>'valorCapital' is null)                 as continua_nulo,
--     count(*) filter (where divida->>'valorCapital' is not null
--                        and divida->>'valorCapital' !~ '^-?[0-9]+(\.[0-9]+)?$') as divida_capital_invalido
--   from public.cobrancas;
--
--   Em 16/10/2026: 35 | 29 | 14 | 0 | 21 | 0.
--   `divida_capital_invalido` PRECISA ser 0 (senão o cast ::numeric aborta a
--   migração inteira — ela roda numa transação só).
--
-- (B) Divergentes (o trigger iguala valor_orig ao capital no próximo update):
--
--   select id, status, arquivado, valor_orig, valor_capital, valor_atual,
--          acordo_final is not null as tem_acordo
--     from public.cobrancas
--    where valor_capital is not null
--      and valor_orig is distinct from valor_capital
--    order by status;
--
--   Em 16/10/2026: 17 linhas.
--
-- (C) Depois de aplicar:
--
--   select count(*) as capital_faltando            -- deve ser 0
--     from public.cobrancas
--    where valor_capital is null and valor_orig is not null;
--
--   select count(*) as trigger_instalado           -- deve ser 1
--     from pg_trigger
--    where tgname = 'trg_cobrancas_capital_unico' and not tgisinternal;
-- ============================================================================

begin;

-- (1) BACKFILL ----------------------------------------------------------------
-- Roda como dono/sem JWT: a trava do capital isenta esse contexto e, de todo
-- modo, só barra quando OLD.valor_capital já estava definido (aqui é nulo).
update public.cobrancas
   set valor_capital = coalesce(valor_capital, valor_orig, (divida->>'valorCapital')::numeric)
 where valor_capital is null
   and (valor_orig is not null or divida->>'valorCapital' is not null);

-- (2) TRIGGER -------------------------------------------------------------------
create or replace function public.cobrancas_capital_unico()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.valor_capital is not null then
    NEW.valor_orig := NEW.valor_capital;
  elsif NEW.valor_orig is not null then
    NEW.valor_capital := NEW.valor_orig;
  end if;
  return NEW;
end;
$$;

comment on function public.cobrancas_capital_unico() is
  'Mantém cobrancas.valor_orig = valor_capital (capital é o único valor digitado). Ver migração 20261016d.';

drop trigger if exists trg_cobrancas_capital_unico on public.cobrancas;
create trigger trg_cobrancas_capital_unico
  before insert or update on public.cobrancas
  for each row execute function public.cobrancas_capital_unico();

comment on column public.cobrancas.valor_orig is
  'Espelho de valor_capital, mantido pelo trigger trg_cobrancas_capital_unico (20261016d). Não digitar: grave valor_capital.';

commit;
