-- 20260910_02_status_corrigir_acao.sql
--
-- Torna alcançável a etapa "Corrigir ação" criada em 20260910_01_etapa_corrigir_acao.sql
-- (#683). Aquela migração só ampliou a constraint da coluna `etapa`: o valor passou a
-- ser aceito, mas nada nunca o gravava. A `etapa` não é escolhida pela tela — é
-- DERIVADA do `status` pelo trigger `cobrancas_set_etapa`, e nenhum status levava a
-- 'corrigir_acao'. Resultado: coluna vazia no pipeline, sem forma de pôr caso nela.
--
-- Três pontos, todos aqui:
--   1. o status "Corrigir ação" precisa entrar na lista branca da view `casos` — a
--      view filtra por `status` (não por `etapa`), e caso com status fora dela some
--      do CRM em silêncio, inclusive para a Bia e o Carlos, que leem a view;
--   2. o trigger precisa mapear esse status para a etapa 'corrigir_acao';
--   3. o index.html (fora desta migração) espelha a mesma ordem em cobEtapa().
--
-- Não há backfill: o status é novo, nenhuma cobrança o tem ainda. Quem for para a
-- coluna vai por decisão do operador, uma a uma.

-- ── 1. lista branca da view `casos` ──────────────────────────────────────────
-- Mesma estratégia de 20260904_casos_view_status_negociando.sql: pega a definição
-- viva, amplia SÓ o array de status do WHERE, recria com CREATE OR REPLACE
-- preservando colunas, triggers INSTEAD OF e security_invoker.
-- Âncora: 'Hasta pública'::text, — fica no MEIO do array e só existe nele.
DO $mig$
DECLARE
  def    text;
  newdef text;
  etiq   text := 'Corrigir ação';
BEGIN
  def := pg_get_viewdef('public.casos'::regclass, true);

  IF def LIKE '%''' || etiq || '''::text%' THEN
    RAISE NOTICE 'casos view: "%" já está no whitelist — pulando', etiq;
    RETURN;
  END IF;

  newdef := replace(
    def,
    $old$'Hasta pública'::text,$old$,
    $new$'Hasta pública'::text, $new$ || quote_literal(etiq) || $new$::text,$new$
  );

  IF newdef = def THEN
    RAISE EXCEPTION 'casos view: âncora do whitelist não encontrada — abortando para não recriar errado';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || newdef;
END
$mig$;

-- ── 2. trigger ───────────────────────────────────────────────────────────────
-- Posição do ramo: DEPOIS de 'reajuizar' e ANTES de 'fazer_acao'. Antes de
-- 'fazer_acao' porque "Corrigir ação" descreve peça JÁ redigida — cair no balde de
-- "redigir e protocolar a inicial" é exatamente a confusão que a etapa nova desfaz.
-- E antes do ramo que joga qualquer caso com numero_processo em 'em_acao': ação a
-- corrigir pode conviver com número antigo (protocolo indeferido, por exemplo) sem
-- que a bola seja do juízo.
create or replace function public.cobrancas_set_etapa()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.etapa := case
    when coalesce(new.status,'') ~* 'quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebido' then 'encerrado'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
     and coalesce(new.status,'') ~* 'execu|cumprimento|penhora|hasta|expropria' then 'execucao'
    -- Título que voltou do juízo: vale com ou sem numero_processo.
    when coalesce(new.status,'') ~* 'reajuizar' then 'reajuizar'
    -- Inicial pronta, aguardando revisão antes do protocolo.
    when coalesce(new.status,'') ~* 'corrigir +a[çc][ãa]o' then 'corrigir_acao'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is null
     and coalesce(new.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|a[çc][ãa]o de|monit[óo]ria|locupletamento' then 'fazer_acao'
    when coalesce(new.status,'') ~* 'an[áa]lise' then 'analise'
    when coalesce(new.status,'') ~* 'acordo +enviado' then 'negociando'
    when coalesce(new.status,'') ~* 'executar +acordo' then 'fazer_acao'
    when coalesce(new.status,'') ~* 'acordo' then 'acordo'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null then 'em_acao'
    when coalesce(new.status,'') ~* 'telefone +inv[áa]lido' then 'telefone_invalido'
    when coalesce(new.status,'') ~* 'negocia|proposta|em contato|contatad' then 'negociando'
    when coalesce((select max(e.criado_em) from public.cobranca_partes cp
        join public.devedor_eventos e on e.devedor_id = cp.devedor_id
       where cp.cobranca_id = new.id), new.etapa_atualizada_em, new.updated_at, new.created_at)
       < now() - interval '90 days' then 'travado'
    else 'cobrar' end;
  if tg_op = 'UPDATE' and new.etapa is distinct from old.etapa then
    new.etapa_atualizada_em := now();
  elsif tg_op = 'INSERT' then
    new.etapa_atualizada_em := coalesce(new.etapa_atualizada_em, now());
  end if;
  return new;
end; $function$;

-- ── 3. verificação ───────────────────────────────────────────────────────────
do $$
declare v_def text;
begin
  v_def := pg_get_viewdef('public.casos'::regclass, true);
  if position('''Corrigir ação''::text' in v_def) = 0 then
    raise exception 'casos: status "Corrigir ação" ficou fora da lista branca da view — o caso sumiria do CRM';
  end if;
  raise notice 'casos: "Corrigir ação" na lista branca, trigger mapeando para corrigir_acao';
end $$;
