-- Rollback de 20260903_etapa_executar_acordo.sql
-- Restaura o gatilho SEM o ramo de "Executar acordo" e devolve os casos à etapa
-- 'acordo'. Só use se a mudança causar efeito indesejado: sem este ramo, acordo
-- descumprido volta a aparecer misturado com acordo em pagamento.

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
    when coalesce(new.status,'') ~* 'acordo +enviado' then 'negociando'
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

UPDATE public.cobrancas SET status = status
 WHERE coalesce(status,'') ~* 'executar +acordo';
