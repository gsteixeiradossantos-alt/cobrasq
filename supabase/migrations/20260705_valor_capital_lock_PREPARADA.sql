-- ✅ APLICADA EM PRODUÇÃO 2026-07-06 (via MCP, projeto jokbxzhcctcwnbhkhgru). Não reaplicar.
--    Revisada adversarialmente (agente de segurança) antes de aplicar: auth.role()
--    funciona dentro do trigger SECURITY DEFINER; colaborador/anon barrados (fail-closed);
--    proprietário, service_role e contextos sem JWT (cron/SQL) passam; sem falso-positivo
--    por escala numérica nem em update que não altera o campo.
-- ============================================================================
-- P2 (idx-cobrancas-acordos): a trava do "valor capital" era só client-side
-- (index.html salvarCobranca: ehColaborador() + confirmarPalavra('CONFIRMAR')).
-- A RLS cobrancas_colaborador_owned é cmd=ALL sem restrição de coluna, então um
-- colaborador (ou script com o token da sessão dele) podia fazer
--   PATCH /rest/v1/cobrancas?id=eq.X {valor_capital: 1}
-- numa cobrança própria, contornando a exigência de proprietário + CONFIRMAR.
--
-- Este trigger BEFORE UPDATE rejeita a alteração de valor_capital quando o valor
-- já estava definido (OLD.valor_capital IS NOT NULL) e o autor é um CLIENTE real
-- (auth.role() in ('authenticated','anon')) que não é 'proprietario'. O backend
-- (service_role) e contextos sem JWT (migração/cron) são ISENTOS — assim jobs
-- legítimos que corrijam valor_capital não são barrados. Primeiro preenchimento
-- (OLD NULL) é sempre permitido. Mesma classe do trg_enforce_cliente_app_user_id (#252).
--
-- Nota (âncora de confiança, fora do escopo desta migração): a trava depende de
-- app_users.papel — garanta que um colaborador não consiga elevar o próprio papel.

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
     and auth.role() in ('authenticated','anon')
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
