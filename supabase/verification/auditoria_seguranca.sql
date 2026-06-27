-- Auditoria · SEGURANÇA — cobrasq-faturamento (projeto Supabase: jokbxzhcctcwnbhkhgru)
-- Rodar via Supabase MCP execute_sql + get_advisors(security). Só LEITURA.
-- Usada pela skill /auditar-cobrasq, etapa 5. Ver REGRESSOES.md (R-07).

-- §1 · R-07 ⚠️ Tabelas exposta a anon/authenticated SEM RLS (vazamento de PII em _backup_*/_arquivo_*)
-- Qualquer linha aqui com 'anon' é lível pela chave pública via /rest/v1/<tabela>.
select c.relname as tabela,
       c.relrowsecurity as rls_ligada,
       string_agg(distinct g.grantee, ',') filter (where g.grantee in ('anon','authenticated')) as exposto_a,
       c.reltuples::bigint as linhas_aprox
from pg_class c
join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
left join information_schema.role_table_grants g
       on g.table_schema='public' and g.table_name=c.relname and g.grantee in ('anon','authenticated')
where c.relkind='r'
group by c.relname, c.relrowsecurity, c.reltuples
having bool_or(g.grantee in ('anon','authenticated')) and c.relrowsecurity = false
order by c.reltuples desc nulls last;

-- §2 · Políticas RLS permissivas demais (using/with_check = true) em INSERT/UPDATE/DELETE/ALL
-- (SELECT using(true) é intencional p/ o blob cobrasq_data — ignorar esse caso.)
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname='public'
  and cmd <> 'SELECT'
  and (qual='true' or with_check='true')
order by tablename, cmd;

-- §3 · Views SECURITY DEFINER e/ou que expõem auth.users (ex.: view profiles)
select c.relname as view_nome,
       (c.reloptions::text ilike '%security_invoker=true%') as e_invoker,
       pg_get_viewdef(c.oid) ilike '%auth.users%' as referencia_auth_users
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='v'
order by e_invoker nulls first, c.relname;

-- §4 · Funções SECURITY DEFINER executáveis por anon (portal_* costuma ser intencional; o resto, revisar)
select p.proname as funcao,
       pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_pode,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed_pode
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prosecdef
  and has_function_privilege('anon', p.oid, 'EXECUTE')
order by p.proname;

-- §5 · Cobertura RLS: tabelas públicas com RLS desligada (não deveria haver nenhuma de negócio)
select c.relname as tabela, c.relrowsecurity as rls_ligada
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and c.relrowsecurity=false
order by c.relname;
