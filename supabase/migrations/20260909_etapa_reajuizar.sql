-- 20260909_etapa_reajuizar.sql
--
-- Nova etapa do pipeline de Cobranças: "Reajuizar".
--
-- Motivo: título que já foi a juízo e voltou (extinção por incompetência,
-- indeferimento da inicial, cessão a reajuizar) ficava indistinguível do que
-- nunca foi ajuizado. Com processo antigo ainda preenchido, pior: o trigger o
-- classificava em 'em_acao' e o painel dizia "aguardar / responder o juízo" para
-- um processo extinto. Foi o que aconteceu com o caso 0000946-45.2025.8.16.0140,
-- extinto por incompetência territorial em 21/08/2026 e que precisa de ação nova
-- em outra comarca. São 36 cobranças nas quatro variantes do status.
--
-- Três pontos, e o terceiro já está resolvido:
--   1. a constraint da coluna `etapa` precisa aceitar o valor novo;
--   2. o trigger `cobrancas_set_etapa` recalcula `etapa` a cada gravação de
--      status — sem conhecer o valor novo ele devolve 'em_acao'/'fazer_acao';
--   3. a view `casos` tem lista branca de status — 'Reajuizar', 'Reajuizar -
--      Cessão', 'Reajuizar de bens' e '7. Reajuizar' JÁ constam dela, conferido
--      em 09/09/2026, então aqui não se mexe na view. A verificação abaixo falha
--      alto se isso deixar de ser verdade.

-- ── 1. constraint ────────────────────────────────────────────────────────────
alter table public.cobrancas
  drop constraint if exists cobrancas_etapa_check;

alter table public.cobrancas
  add constraint cobrancas_etapa_check
  check (etapa is null or etapa in
    ('cobrar','telefone_invalido','analise','negociando','acordo','fazer_acao',
     'reajuizar','em_acao','execucao','executar_acordo','travado','quitado',
     'encerrado','quitafacil'));

-- ── 2. trigger ───────────────────────────────────────────────────────────────
-- Posição do ramo: DEPOIS de 'execucao' e ANTES de 'fazer_acao', espelhando a
-- ordem de cobEtapa() no index.html. Vem antes do ramo que joga qualquer caso
-- com numero_processo em 'em_acao' — é justamente o caso do título extinto, que
-- conserva o número antigo mas não tem ação em curso.
-- O 'reajuizar' sai do regex de 'fazer_acao' porque agora é capturado acima; se
-- ficasse lá seria letra morta, e letra morta em regex confunde quem vier depois.
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

-- ── 3. verificação da lista branca da view ───────────────────────────────────
-- Não recria a view: só falha alto se o pressuposto mudar. Recriar sem
-- necessidade é que faz o security_invoker se perder (guarda F-04).
do $$
declare v_def text;
begin
  v_def := pg_get_viewdef('public.casos'::regclass, true);
  if position('''Reajuizar''::text' in v_def) = 0 then
    raise exception 'casos: status Reajuizar fora da lista branca da view — os casos sumiriam do CRM; incluir antes de aplicar';
  end if;
  raise notice 'casos: Reajuizar já consta da lista branca, view intocada';
end $$;

-- ── 4. backfill ──────────────────────────────────────────────────────────────
-- O trigger só dispara em insert/update; sem isto as cobranças já existentes
-- ficariam com a etapa antiga até alguém tocá-las.
update public.cobrancas
   set updated_at = updated_at
 where status ~* 'reajuizar'
   and coalesce(etapa,'') is distinct from 'reajuizar';
