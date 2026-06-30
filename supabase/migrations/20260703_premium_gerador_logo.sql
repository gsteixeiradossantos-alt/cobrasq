-- Premium (gerador de documentos do cedente) — logo white-label.
--
-- A flag `premium` e o `logoBase64` do cliente vivem em clientes.metadata (jsonb),
-- então NÃO há ALTER TABLE. A flag é gravada pelo operador no save normal do cliente.
-- O LOGO é gravado pelo PRÓPRIO cedente (que tem sessão Supabase, mas sem UPDATE em
-- clientes) — por isso esta RPC security-definer, que só deixa o cedente mexer no
-- metadata.logoBase64 do SEU cliente (resolvido por app_users.ref_id do auth.uid()).
--
-- Aplicar manual no SQL Editor (NÃO usar db push). Idempotente.

create or replace function public.cedente_set_logo(p_logo text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
begin
  -- limite de tamanho (data URL base64 ~ até ~800 KB)
  if p_logo is not null and length(p_logo) > 850000 then
    raise exception 'Logotipo muito grande.';
  end if;

  select ref_id into v_ref
    from public.app_users
   where id = auth.uid()
     and papel = 'cedente'
     and coalesce(ativo, true);

  if v_ref is null then
    raise exception 'Sem cliente vinculado a este acesso.';
  end if;

  update public.clientes
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('logoBase64', coalesce(p_logo, ''))
   where id = v_ref::uuid;
end;
$$;

revoke all on function public.cedente_set_logo(text) from public;
grant execute on function public.cedente_set_logo(text) to authenticated;
