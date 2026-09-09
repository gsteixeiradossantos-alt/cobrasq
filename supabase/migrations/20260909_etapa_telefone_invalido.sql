-- 20260909_etapa_telefone_invalido.sql
--
-- Nova etapa do pipeline de Cobranças: "Telefone inválido".
--
-- Motivo: caso sem canal de contato continuava contado em "Cobrar" e voltava
-- para a fila de abordagem. Em 09/09/2026 isso mandou primeiras mensagens para
-- números que não recebem, e um caso marcado como telefone inválido desde
-- 17/08 apareceu na lista de "prontos para cobrar".
--
-- São TRÊS pontos, e nenhum funciona sozinho:
--   1. a constraint da coluna `etapa` precisa aceitar o valor novo;
--   2. o trigger `cobrancas_set_etapa` recalcula `etapa` a cada gravação de
--      status — sem conhecer o valor novo ele devolve 'cobrar' e desfaz a marcação;
--   3. a view `casos` tem LISTA BRANCA de status: status fora dela faz o caso
--      SUMIR do CRM inteiro. Descoberto na prática, com quatro casos fora do ar
--      por dois minutos até a reversão.

-- ── 1. constraint ────────────────────────────────────────────────────────────
-- Inclui também 'executar_acordo', 'quitado' e 'quitafacil', que o pipeline já
-- usa no front e a constraint antiga não aceitava.
alter table public.cobrancas
  drop constraint if exists cobrancas_etapa_check;

alter table public.cobrancas
  add constraint cobrancas_etapa_check
  check (etapa is null or etapa in
    ('cobrar','telefone_invalido','analise','negociando','acordo','fazer_acao',
     'em_acao','execucao','executar_acordo','travado','quitado','encerrado','quitafacil'));

-- ── 2. trigger ───────────────────────────────────────────────────────────────
-- O ramo entra DEPOIS dos que dependem de processo: caso judicial marcado com
-- telefone inválido continua em 'em_acao'/'execucao', porque a ação pendente
-- dele é processual, não achar telefone.
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
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is null
     and coalesce(new.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|a[çc][ãa]o de|monit[óo]ria|locupletamento' then 'fazer_acao'
    when coalesce(new.status,'') ~* 'an[áa]lise' then 'analise'
    when coalesce(new.status,'') ~* 'acordo +enviado' then 'negociando'
    when coalesce(new.status,'') ~* 'executar +acordo' then 'fazer_acao'
    when coalesce(new.status,'') ~* 'acordo' then 'acordo'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null then 'em_acao'
    -- Sem canal de contato: só vale para quem NÃO tem processo (os ramos acima
    -- já capturaram esses). A próxima providência é achar telefone, não cobrar.
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

-- ── 3. view casos ────────────────────────────────────────────────────────────
-- Acrescenta o status à lista branca SEM reescrever a view à mão: lê a
-- definição vigente, insere o item e recria re-declarando security_invoker
-- (guarda anti-drift F-04 — ver supabase/migrations/README.md).
do $$
declare v_def text; v_novo text;
begin
  v_def := pg_get_viewdef('public.casos'::regclass, true);
  if position('''Telefone inválido''::text' in v_def) > 0 then
    raise notice 'casos: status já presente na lista branca, nada a fazer';
    return;
  end if;
  v_novo := replace(v_def, '''Executar acordo''::text]', '''Executar acordo''::text, ''Telefone inválido''::text]');
  if v_novo = v_def then
    raise exception 'casos: âncora da lista branca não encontrada — revisar a migração antes de aplicar';
  end if;
  execute 'create or replace view public.casos with (security_invoker = true) as ' || v_novo;
end $$;
