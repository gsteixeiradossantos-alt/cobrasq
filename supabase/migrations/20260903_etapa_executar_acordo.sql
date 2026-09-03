-- 03/09/2026 — "Executar acordo" caía na etapa 'acordo'
--
-- O status "Executar acordo" (criado no #628) marca acordo DESCUMPRIDO indo para
-- cobrança judicial. Mas os casos apareciam no painel sob "Acordo ativo", junto
-- dos acordos que estão sendo pagos normalmente — invisíveis como grupo.
--
-- Causa: a cadeia de `cobrancas_set_etapa` tem um ramo que capta 'execu' (e
-- portanto "EXECUtar acordo"), mas ele EXIGE processo cadastrado. Nos casos
-- extrajudiciais o ramo não dispara e a cadeia segue até `~* 'acordo'`, que casa
-- por conter a palavra.
--
-- É a MESMA armadilha já documentada no próprio gatilho para "Acordo enviado", e
-- a correção é a mesma: um ramo específico ANTES do ramo genérico.
--
-- Sem processo, a próxima providência é protocolar -> 'fazer_acao'.
-- Com processo, o ramo 'execu' acima já captou -> 'execucao'. Nada muda ali.
--
-- Afeta 4 cobranças ativas em 03/09/2026: Andrelina Marca Lembeck (16.636,60),
-- Gisele Silva dos Santos (2.932,89), Kelly Naiane Coraleski (863,49) e
-- Edivane Salete Matos (304,00).

CREATE OR REPLACE FUNCTION public.cobrancas_set_etapa()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.etapa := case
    when coalesce(new.status,'') ~* 'quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebido' then 'encerrado'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
     and coalesce(new.status,'') ~* 'execu|cumprimento|penhora|hasta|expropria' then 'execucao'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is null
     and coalesce(new.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|a[çc][ãa]o de|monit[óo]ria|locupletamento' then 'fazer_acao'
    when coalesce(new.status,'') ~* 'an[áa]lise' then 'analise'
    -- Termo no ZapSign, ainda sem assinatura: negociação em aberto, não acordo ativo.
    -- Precisa vir ANTES do ramo 'acordo', que casaria por conter a palavra.
    when coalesce(new.status,'') ~* 'acordo +enviado' then 'negociando'
    -- Acordo DESCUMPRIDO indo para cobrança judicial: NÃO é acordo ativo. Sem
    -- processo, a próxima providência é protocolar. Com processo, o ramo 'execu'
    -- lá em cima já captou. Mesma armadilha do 'acordo enviado': tem de vir ANTES
    -- do ramo 'acordo', que casaria por conter a palavra.
    when coalesce(new.status,'') ~* 'executar +acordo' then 'fazer_acao'
    when coalesce(new.status,'') ~* 'acordo' then 'acordo'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null then 'em_acao'
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

-- Backfill: recalcula a etapa dos casos já marcados. O UPDATE no-op dispara o
-- gatilho BEFORE, que reescreve `etapa` pela cadeia nova.
UPDATE public.cobrancas SET status = status
 WHERE coalesce(status,'') ~* 'executar +acordo';
