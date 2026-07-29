-- ============================================================================
-- TRIGGER QUE MANTÉM `cobrancas.etapa` VIVA
--
-- NÃO APLICADA EM PRODUÇÃO. Aplicar é ação gated (CLAUDE.md).
--
-- Contexto. A coluna `etapa` foi criada e populada em 29/07 e a tela passou a
-- lê-la com precedência sobre a derivação em runtime. Faltou uma peça: mudar a
-- situação do caso grava `status` em 5+ lugares (popover de status, barra de
-- lote, Bia, importação, sync do acordo) e NENHUM deles escrevia `etapa` junto.
-- Resultado: o usuário movia 3 casos de "Cobrar" para "Fazer ação", o status
-- gravava certo e o pipeline continuava mostrando os 3 em "Cobrar" — a tela
-- contradizendo o próprio banco.
--
-- O paliativo (commit 1e4b83f) tirou a precedência da coluna: a tela voltou a
-- derivar em runtime, que nunca fica velho. Isso conserta a tela, mas deixa a
-- coluna morrendo aos poucos — e é ela que relatório e ordenação no banco leem.
--
-- Este trigger é o conserto de verdade: recalcula `etapa` sempre que `status`
-- ou `numero_processo` mudar, pelas MESMAS regras do backfill e do cobEtapa()
-- do index.html. Com ele aplicado, dá para devolver a precedência à coluna na
-- tela (reverter o 1e4b83f) — e aí a etapa passa a ser fato do banco, não
-- opinião de cada tela.
--
-- ORDEM DE APLICAÇÃO
--   1. aplicar este arquivo
--   2. conferir a verificação no fim (coluna tem que continuar batendo com a
--      derivação da tela em 100% dos casos ativos)
--   3. só então reverter o 1e4b83f no index.html
-- ============================================================================

begin;

create or replace function public.cobrancas_set_etapa()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.etapa := case
    when coalesce(new.status,'') ~* 'quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebido'
      then 'encerrado'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
     and coalesce(new.status,'') ~* 'execu|cumprimento|penhora|hasta|expropria'
      then 'execucao'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is null
     and coalesce(new.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|a[çc][ãa]o de|monit[óo]ria|locupletamento'
      then 'fazer_acao'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
      then 'em_acao'
    when coalesce(new.status,'') ~* 'acordo'
      then 'acordo'
    when coalesce(new.status,'') ~* 'negocia|proposta|em contato|contatad'
      then 'negociando'
    when coalesce(
           (select max(e.criado_em)
              from public.cobranca_partes cp
              join public.devedor_eventos e on e.devedor_id = cp.devedor_id
             where cp.cobranca_id = new.id),
           new.etapa_atualizada_em, new.updated_at, new.created_at
         ) < now() - interval '90 days'
      then 'travado'
    else 'cobrar'
  end;

  -- carimba só quando a etapa realmente virou
  if tg_op = 'UPDATE' and new.etapa is distinct from old.etapa then
    new.etapa_atualizada_em := now();
  elsif tg_op = 'INSERT' then
    new.etapa_atualizada_em := coalesce(new.etapa_atualizada_em, now());
  end if;

  return new;
end;
$$;

drop trigger if exists trg_cobrancas_set_etapa on public.cobrancas;

-- Só dispara quando muda o que importa: evita recalcular a cada toque de sync.
create trigger trg_cobrancas_set_etapa
  before insert or update of status, numero_processo
  on public.cobrancas
  for each row
  execute function public.cobrancas_set_etapa();

commit;

-- ── VERIFICAÇÃO (depois de aplicar) ─────────────────────────────────────────
-- 1) Nada mudou de lugar sem querer — a coluna tem que continuar como estava:
--      select etapa, count(*) from public.cobrancas
--       where coalesce(arquivado,false)=false and coalesce(is_draft,false)=false
--       group by 1 order by 2 desc;
--    Esperado em 29/07: cobrar 71 · em_acao 62 · execucao 44 · encerrado 30
--                       · acordo 11 · fazer_acao 3
--
-- 2) O trigger pega a mudança (rodar numa transação e desfazer):
--      begin;
--        update public.cobrancas set status='5. Quitado'
--         where id = (select id from public.cobrancas where etapa='cobrar' limit 1)
--         returning left(id::text,8), status, etapa;   -- etapa tem que vir 'encerrado'
--      rollback;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- drop trigger if exists trg_cobrancas_set_etapa on public.cobrancas;
-- drop function if exists public.cobrancas_set_etapa();
