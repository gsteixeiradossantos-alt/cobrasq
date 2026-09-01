-- 20260831_fin_saldos_roll_forward
--
-- Problema: o saldo das contas na tela do Financeiro ficava congelado. A precedência era
-- "saldo bancário declarado > saldo do razão > saldo inicial", e o declarado
-- (fin_conta.bank_balance) só muda quando alguém importa um OFX. A conta Asaas passou 25 dias
-- exibindo R$ 4.893,82, de 06/08, enquanto o saldo real era R$ 9.592,26.
--
-- Usar o saldo do razão puro também não serve: fin_conta.saldo_inicial já embute a posição de
-- uma data de corte, e os lançamentos anteriores a ela são somados por cima — na conta Asaas
-- isso inflava o saldo em R$ 8.934,48 (25 lançamentos pagos antes de 01/08).
--
-- Solução (roll-forward): ancorar no último saldo bancário conferido e somar só o que se
-- movimentou DEPOIS dele. Esta migração acrescenta a coluna `realizado_pos_ancora`, que é o
-- movimento realizado após `fin_conta.bank_balance_at` — lançamentos pagos e transferências.
-- A conta sem âncora devolve 0 e o cliente cai no comportamento antigo (saldo do razão).
--
-- LIMITE CONHECIDO — o dia da âncora fica de fora. `fin_lancamento.data_pagamento` é DATE, sem
-- hora, e `bank_balance_at` é um instante: não dá para saber se um pagamento do mesmo dia entrou
-- antes ou depois da foto do banco. O corte é `> bank_balance_at::date`, ou seja, o movimento do
-- próprio dia da âncora não é somado. Isso subestima o saldo por no máximo um dia, e some no
-- import seguinte. O contrário (`>=`) contaria em dobro tudo que a âncora já continha, o que é
-- pior num saldo de caixa. Foi esse buraco que estragou a âncora de 06/08/2026: a sync rodou às
-- 16h31 e gravou R$ 4.893,82, enquanto o extrato fechou o dia em R$ 5.515,91.
--
-- Assinatura do RETURNS TABLE muda, então precisa de DROP antes do CREATE.

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
  qtd_pendente integer,
  realizado_pos_ancora numeric
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
      l.tipo_movimento,
      l.data_pagamento
    from fin_lancamento l
    where l.conta_id is not null or (l.raw_payload->>'id_accounts_paid') is not null
  ),
  transf as (
    select conta_origem_id as cid, -coalesce(sum(valor), 0) as net,
           max(data) as ult_data
    from fin_transferencia
    where status = 1 and conta_origem_id is not null
    group by conta_origem_id
    union all
    select conta_destino_id as cid, coalesce(sum(valor), 0) as net,
           max(data) as ult_data
    from fin_transferencia
    where status = 1 and conta_destino_id is not null
    group by conta_destino_id
  ),
  transf_conta as (
    select cid, sum(net) as net_transf from transf group by cid
  ),
  -- Transferências posteriores à âncora de cada conta, somadas separadamente: a âncora é um
  -- saldo bancário, então tudo que já estava nela não pode ser contado de novo.
  transf_pos as (
    select c.id as cid,
           coalesce(sum(case when t.conta_destino_id = c.id then t.valor
                             when t.conta_origem_id  = c.id then -t.valor end), 0) as net_pos
      from fin_conta c
      join fin_transferencia t
        on (t.conta_origem_id = c.id or t.conta_destino_id = c.id)
     where t.status = 1
       and c.bank_balance_at is not null
       and t.data > c.bank_balance_at::date
     group by c.id
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
    count(*) filter (where m.status = 0)::int as qtd_pendente,
    -- Movimento posterior à âncora. Sem âncora (bank_balance_at nulo) devolve 0 e o cliente
    -- usa o saldo do razão, como antes.
    case when c.bank_balance_at is null then 0 else
      coalesce(sum(case when m.status in (1,2)
                         and m.data_pagamento is not null
                         and m.data_pagamento > c.bank_balance_at::date
                    then m.v_pago end), 0)
      + coalesce(tp.net_pos, 0)
    end as realizado_pos_ancora
  from fin_conta c
  left join mov m on m.conta_efetiva = c.id
  left join transf_conta t on t.cid = c.id
  left join transf_pos tp on tp.cid = c.id
  where c.ativa = true
  group by c.id, c.saldo_inicial, c.bank_balance_at, t.net_transf, tp.net_pos;
$function$;

-- Permissões idênticas às da função anterior. O DROP zera os grants e o default do Postgres já
-- devolve EXECUTE ao PUBLIC, que é como a função estava; os grants abaixo são explícitos só para
-- o estado ficar declarado no arquivo.
-- NOTA: a função está acessível ao `anon`. Isso vem de antes e NÃO é alterado aqui — fechar esse
-- acesso é uma decisão à parte, para não vir de carona numa mudança de saldo.
GRANT EXECUTE ON FUNCTION public.fin_saldos_realizados() TO anon, authenticated, service_role;
