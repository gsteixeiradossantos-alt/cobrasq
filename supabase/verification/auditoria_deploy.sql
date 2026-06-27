-- Auditoria · VERDADE DE DEPLOY (banco) — cobrasq-faturamento (projeto: jokbxzhcctcwnbhkhgru)
-- Rodar via Supabase MCP. Cruzar com: gh pr list (PR mergeado?), list_migrations, e grep no index.html do main.
-- Usada pela skill /auditar-cobrasq, etapa 4. Ver REGRESSOES.md (R-04, R-05, R-06).

-- §1 · R-06 Triggers presentes em prod (cruzar com supabase/migrations/ — todo objeto deve ter migration)
select t.tgrelid::regclass::text as tabela, t.tgname as trigger,
       case t.tgenabled when 'O' then 'enabled' else t.tgenabled::text end as estado
from pg_trigger t
where not t.tgisinternal
  and t.tgrelid::regclass::text in ('cobrasq_data','devedores','cobrancas','clientes','acordos')
order by tabela, trigger;

-- §2 · F-04 A view casos/view_casos DEVE manter security_invoker=true
select c.relname, array_to_string(c.reloptions, ',') as reloptions
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='v' and c.relname in ('casos','view_casos');

-- §3 · Colunas-chave presentes (drift de esquema): is_draft, assigned_to, cadastrado_por, asaas_customer_id,
--      cobrancas.divida (a dívida mudou p/ cobrancas; devedores.divida foi dropada em tempo2)
select table_name, column_name
from information_schema.columns
where table_schema='public'
  and (table_name='devedores'  and column_name in ('is_draft','assigned_to','cadastrado_por','asaas_customer_id','divida'))
   or (table_name='cobrancas'  and column_name in ('is_draft','assigned_to','cadastrado_por','divida','acordo_final','encerramento'))
order by table_name, column_name;

-- §4 · Últimas migrations aplicadas (cruzar com os arquivos em supabase/migrations/)
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 15;

-- Lembrete (fora do SQL): R-05 funções Vercel ≤ 12 → no shell: ls api/*.js | grep -v '^_' | wc -l  (deve dar ≤12)
--                        R-04 conserto no ar? → git -C <repo> fetch && git log origin/main | grep <commit>;
--                                                gh pr list --state open  (aberto = NÃO está no ar)
