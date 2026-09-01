-- Rollback de 20260831_fin_saldos_roll_forward: devolve a fin_saldos_realizados sem a coluna
-- realizado_pos_ancora. O cliente que espera a coluna cai no fallback (saldo do razão), então
-- este rollback é seguro mesmo com o index.html já publicado.

DROP FUNCTION IF EXISTS public.fin_saldos_realizados();

CREATE FUNCTION public.fin_saldos_realizados()
RETURNS TABLE(
  conta_id bigint,
  saldo_inicial numeric,
  total_realizado numeric,
  total_pendente_entrada numeric,
  total_pendente_saida numeric,
  saldo_atual numeric,
  qtd_pago integer,
  qtd_pendente integer
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  with mov as (
    select
      case
        when l.status in (1,2)
          and (l.raw_payload->>'id_accounts_paid') is not null
          and (l.raw_payload->>'id_accounts_paid')::bigint != 0
        then (
          select c2.id from fin_conta c2
          where c2.controlle_id = (l.raw_payload->>'id_accounts_paid')::bigint
        )
        else l.conta_id
      end as conta_efetiva,
      coalesce(l.valor_pago, l.valor) as v_pago,
      l.valor as v_orig,
      l.status,
      l.tipo_movimento
    from fin_lancamento l
    where l.conta_id is not null or (l.raw_payload->>'id_accounts_paid') is not null
  ),
  transf as (
    select conta_origem_id as cid, -coalesce(sum(valor), 0) as net
    from fin_transferencia
    where status = 1 and conta_origem_id is not null
    group by conta_origem_id
    union all
    select conta_destino_id as cid, coalesce(sum(valor), 0) as net
    from fin_transferencia
    where status = 1 and conta_destino_id is not null
    group by conta_destino_id
  ),
  transf_conta as (
    select cid, sum(net) as net_transf from transf group by cid
  )
  select
    c.id as conta_id,
    coalesce(c.saldo_inicial, 0) as saldo_inicial,
    coalesce(sum(case when m.status in (1,2) then m.v_pago end), 0) as total_realizado,
    coalesce(sum(case when m.status = 0 and m.tipo_movimento = 1 then m.v_orig end), 0) as total_pendente_entrada,
    coalesce(sum(case when m.status = 0 and m.tipo_movimento = 0 then abs(m.v_orig) end), 0) as total_pendente_saida,
    coalesce(c.saldo_inicial, 0)
      + coalesce(sum(case when m.status in (1,2) then m.v_pago end), 0)
      + coalesce(t.net_transf, 0) as saldo_atual,
    count(*) filter (where m.status in (1,2))::int as qtd_pago,
    count(*) filter (where m.status = 0)::int as qtd_pendente
  from fin_conta c
  left join mov m on m.conta_efetiva = c.id
  left join transf_conta t on t.cid = c.id
  where c.ativa = true
  group by c.id, c.saldo_inicial, t.net_transf;
$function$;

GRANT EXECUTE ON FUNCTION public.fin_saldos_realizados() TO anon, authenticated, service_role;
