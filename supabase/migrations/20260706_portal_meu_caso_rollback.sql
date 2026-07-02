-- ============================================================================
-- Rollback de 20260706_portal_meu_caso.sql — NÃO APLICAR SEM REVISÃO
-- ============================================================================
-- Reverte as RPCs do Portal do Devedor (Achados 1 e 2) e as tabelas de apoio.
-- Restaura portal_validar_token à versão anterior (sem token de sessão).
-- ============================================================================

drop function if exists public.portal_meu_caso(text);
drop function if exists public.portal_login_nascimento(text, date);
drop function if exists public._portal_emitir_sessao(uuid, text);

drop table if exists public.portal_login_tentativas;
drop table if exists public.portal_sessoes;

-- Restaura portal_validar_token ao comportamento original (retorno ok + devedor_id).
create or replace function public.portal_validar_token(p_cpf text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cpf_digits text;
  v_token_clean text;
  v_row record;
begin
  v_cpf_digits := regexp_replace(p_cpf, '\D', '', 'g');
  v_token_clean := regexp_replace(p_token, '\D', '', 'g');

  if length(v_token_clean) <> 6 then
    return jsonb_build_object('ok', false, 'erro', 'Código deve ter 6 dígitos.');
  end if;

  select t.cpf, t.token, t.devedor_id, t.expira_em, t.usado_em
    into v_row
  from public.portal_tokens t
  where t.cpf = v_cpf_digits and t.token = v_token_clean
  order by t.enviado_em desc limit 1;

  if v_row.cpf is null then
    return jsonb_build_object('ok', false, 'erro', 'Código incorreto.');
  end if;
  if v_row.usado_em is not null then
    return jsonb_build_object('ok', false, 'erro', 'Código já utilizado.');
  end if;
  if v_row.expira_em < now() then
    return jsonb_build_object('ok', false, 'erro', 'Código expirado. Solicite um novo.');
  end if;

  update public.portal_tokens
    set usado_em = now()
  where cpf = v_row.cpf and token = v_row.token;

  return jsonb_build_object('ok', true, 'devedor_id', v_row.devedor_id);
end;
$function$;

revoke all on function public.portal_validar_token(text, text) from public;
grant execute on function public.portal_validar_token(text, text) to anon, authenticated;
