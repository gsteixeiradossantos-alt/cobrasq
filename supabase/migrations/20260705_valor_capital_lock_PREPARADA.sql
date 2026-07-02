-- PREPARADA — NÃO APLICAR SEM REVISÃO
-- ============================================================================
-- P2 (idx-cobrancas-acordos): a trava do "valor capital" é só client-side
-- (index.html salvarCobranca: ehColaborador() + confirmarPalavra('CONFIRMAR')).
-- A RLS cobrancas_colaborador_owned é cmd=ALL sem restrição de coluna, então um
-- colaborador (ou script com o token da sessão dele) pode fazer
--   PATCH /rest/v1/cobrancas?id=eq.X {valor_capital: 1}
-- numa cobrança própria, contornando a exigência de proprietário + CONFIRMAR.
--
-- Este trigger BEFORE UPDATE rejeita a alteração de valor_capital quando o valor
-- já estava definido (OLD.valor_capital IS NOT NULL) e o autor não é proprietário.
-- Mesma classe do trg_enforce_cliente_app_user_id (PR #252).
--
-- SECURITY DEFINER: current_user_papel() já é usada nas policies; aqui só lemos o
-- papel do usuário corrente para decidir a permissão.
--
-- REVISAR ANTES DE APLICAR:
--   1. Confirmar que public.current_user_papel() existe e devolve o papel esperado.
--   2. Confirmar que nenhum job/rotina server-side legítima altera valor_capital
--      rodando como papel != 'proprietario' (senão passaria a falhar).
--   3. Rodar em staging/branch antes de produção (jokbxzhcctcwnbhkhgru).
-- ============================================================================

create or replace function public.enforce_valor_capital_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE'
     and OLD.valor_capital is not null
     and NEW.valor_capital is distinct from OLD.valor_capital
     and coalesce(public.current_user_papel(), '') <> 'proprietario' then
    raise exception 'valor_capital só pode ser alterado pelo proprietário (campo crítico travado).'
      using errcode = '42501';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_valor_capital_lock on public.cobrancas;
create trigger trg_enforce_valor_capital_lock
before update on public.cobrancas
for each row execute function public.enforce_valor_capital_lock();

-- Rollback:
--   drop trigger if exists trg_enforce_valor_capital_lock on public.cobrancas;
--   drop function if exists public.enforce_valor_capital_lock();
