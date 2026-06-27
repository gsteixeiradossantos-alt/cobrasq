-- Auditoria · DADOS & PERFIS — cobrasq-faturamento (projeto Supabase: jokbxzhcctcwnbhkhgru)
-- Rodar via Supabase MCP execute_sql (uma seção por vez). Só LEITURA. Sem dump de PII (contagens/estrutura).
-- Usada pela skill /auditar-cobrasq, etapas 2 e 3. Ver docs/audit/REGRESSOES.md (R-01, R-02, R-03, R-08).

-- §1 · R-01 Divergência blob × relacional (blob deve estar congelado; relacional = fonte)
select 'blob'      as origem, (select case when jsonb_typeof(data->'devedores')='array' then jsonb_array_length(data->'devedores') end from cobrasq_data where key='main') as devedores,
                              (select case when jsonb_typeof(data->'clientes')='array'  then jsonb_array_length(data->'clientes')  end from cobrasq_data where key='main') as clientes
union all
select 'relacional', (select count(*) from devedores where not coalesce(arquivado,false)),
                     (select count(*) from clientes  where not coalesce(arquivado,false));

-- §2 · R-02 Baseline F-20 por perfil: quantos devedores cada usuário ENXERGA (predicado RLS) vs blob
-- Alerta se um colaborador ativo enxerga << blob (no login a trava pode falso-positivar se o rebase #142 regredir).
select au.papel, au.nome, au.ativo,
  (select count(*) from devedores d
     where au.papel='proprietario'
        or (au.papel='colaborador' and (d.cadastrado_por=au.id or d.assigned_to=au.id))) as dev_visiveis,
  (select case when jsonb_typeof(data->'devedores')='array' then jsonb_array_length(data->'devedores') end
     from cobrasq_data where key='main') as blob_carrega
from app_users au
where au.ativo and au.papel in ('proprietario','colaborador')
order by au.papel, dev_visiveis desc;

-- §3 · R-03 Rascunho-fantasma: is_draft tem de viver na COLUNA das 2 tabelas; rascunhos velhos = suspeitos
select 'devedores' t, count(*) total, count(*) filter (where is_draft) as draft,
       count(*) filter (where is_draft and coalesce(draft_expires_at, now()) < now()) as draft_vencido
from devedores
union all
select 'cobrancas', count(*), count(*) filter (where is_draft),
       count(*) filter (where is_draft and coalesce(draft_expires_at, now()) < now())
from cobrancas
union all
select 'clientes', count(*), count(*) filter (where is_draft),
       count(*) filter (where is_draft and coalesce(draft_expires_at, now()) < now())
from clientes;

-- §3b · A view casos deve EXCLUIR draft e ser a fonte do CRM (conferir contagem coerente)
select count(*) as casos_visiveis_no_crm from casos;

-- §4 · R-08 Financeiro: devedores sem asaas_customer_id não viram fin_operacao ao receber
select count(*) as dev_total,
       count(*) filter (where asaas_customer_id is null or asaas_customer_id='') as sem_asaas_customer,
       count(*) filter (where asaas_customer_id is not null and asaas_customer_id<>'') as com_asaas_customer
from devedores
where not coalesce(arquivado,false);

-- §5 · Vazamento entre cedentes: nenhum devedor deve ter cliente_id nulo se for de carteira ativa
select count(*) as devedores_sem_cliente
from devedores where cliente_id is null and not coalesce(arquivado,false) and not coalesce(is_draft,false);
