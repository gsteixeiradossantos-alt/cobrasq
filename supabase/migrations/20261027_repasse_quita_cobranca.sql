-- 20261027 — repasse que cobre o capital vira "Quitado" no banco
--
-- Até aqui a regra só existia no JS do painel (recomputarSaldoCapital, index.html):
-- repasse lançado por SQL, skill ou qualquer outro caminho não mudava o status.
-- Em 27/10/2026, 375 repasses lançados por SQL deixaram 9 cobranças com o capital
-- todo repassado e o status antigo. Este trigger aplica a mesma regra a qualquer
-- INSERT/UPDATE em repasses_cliente.
--
-- Regra (idêntica à do painel):
--   capital = valor_capital → divida.valorCapital → valor_orig
--   capital > 0 e capital − soma(repasses_cliente.valor) ≤ 0,005
--   e status atual ∉ ('Quitado', 'Quitado ao cliente')
--   → status = 'Quitado', divida.valorCapital = capital, updated_at = now()
--     + evento em devedor_eventos (mesmo texto do painel).
--
-- Cuidados:
--   * etapa não é gravada aqui: vem do trg_cobrancas_sync_etapa (BEFORE UPDATE OF status).
--   * valor_capital não é tocado, então enforce_valor_capital_lock não dispara.
--   * devedor_eventos.devedor_id é NOT NULL com FK para devedores; em cobrança sem
--     linha em devedores com o mesmo id o evento é pulado (o painel falhava calado).
--   * SECURITY DEFINER: o colaborador que pode lançar o repasse (RLS de
--     repasses_cliente) também faz o caso virar "Quitado", sem depender da RLS de
--     cobrancas. A função não é exposta por RPC (só trigger).
--   * DELETE não reverte o status (o painel também não: não há como saber o anterior).

create or replace function public.repasses_cliente_quitar_cobranca()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cob     public.cobrancas%rowtype;
  v_cap     numeric;
  v_enviado numeric;
begin
  -- Trava a cobrança: dois repasses simultâneos não geram dois eventos.
  select * into v_cob from public.cobrancas where id = NEW.cobranca_id for update;
  if not found then
    return null;
  end if;

  if btrim(coalesce(v_cob.status, '')) in ('Quitado', 'Quitado ao cliente') then
    return null;
  end if;

  -- divida.valorCapital só entra se for número: texto torto no blob não pode
  -- derrubar o INSERT do repasse.
  v_cap := coalesce(v_cob.valor_capital,
                    case when btrim(v_cob.divida->>'valorCapital') ~ '^-?[0-9]+(\.[0-9]+)?$'
                         then btrim(v_cob.divida->>'valorCapital')::numeric end,
                    v_cob.valor_orig);
  if v_cap is null or v_cap <= 0 then
    return null;
  end if;

  select coalesce(sum(valor), 0) into v_enviado
    from public.repasses_cliente where cobranca_id = NEW.cobranca_id;

  if v_cap - v_enviado > 0.005 then
    return null;
  end if;

  update public.cobrancas
     set status     = 'Quitado',
         divida     = coalesce(divida, '{}'::jsonb) || jsonb_build_object('valorCapital', v_cap),
         updated_at = now()
   where id = NEW.cobranca_id;

  if exists (select 1 from public.devedores where id = NEW.cobranca_id) then
    insert into public.devedor_eventos (cobranca_id, devedor_id, tipo, payload)
    values (NEW.cobranca_id, NEW.cobranca_id, 'repasse',
            jsonb_build_object(
              'acao_completa', 'Capital integralmente repassado ao cliente — status alterado para "Quitado".',
              'origem', 'repasse'));
  end if;

  return null;
end;
$function$;

revoke all on function public.repasses_cliente_quitar_cobranca() from public, anon, authenticated;

drop trigger if exists trg_repasses_cliente_quitar_cobranca on public.repasses_cliente;
create trigger trg_repasses_cliente_quitar_cobranca
  after insert or update of valor, cobranca_id on public.repasses_cliente
  for each row execute function public.repasses_cliente_quitar_cobranca();
