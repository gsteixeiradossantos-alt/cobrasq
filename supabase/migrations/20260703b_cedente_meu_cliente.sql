-- O cedente não consegue ler a própria linha de `clientes` via RLS
-- (clientes_cedente_self usa app_user_id = auth.uid(), mas app_user_id nunca é
-- populado — 0/108). O vínculo real é app_users.ref_id -> clientes.id.
--
-- Esta RPC security-definer devolve APENAS os campos que o portal precisa do
-- próprio cliente do cedente (premium, logo e qualificação p/ os documentos) —
-- sem expor obs/honorários/senha do metadata. Aplicar manual no SQL Editor.

create or replace function public.cedente_meu_cliente()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id',          c.id,
    'nome',        c.nome,
    'nomeFantasia', c.nome_fantasia,
    'doc',         c.doc,
    'endereco',    coalesce(c.metadata->>'endereco', ''),
    'premium',     coalesce((c.metadata->>'premium')::boolean, false),
    'logoBase64',  coalesce(c.metadata->>'logoBase64', '')
  )
  from public.app_users au
  join public.clientes c on c.id = au.ref_id::uuid
  where au.id = auth.uid()
    and au.papel = 'cedente'
    and coalesce(au.ativo, true)
    and au.ref_id ~ '^[0-9a-fA-F-]{36}$'
  limit 1;
$$;

revoke all on function public.cedente_meu_cliente() from public;
grant execute on function public.cedente_meu_cliente() to authenticated;
