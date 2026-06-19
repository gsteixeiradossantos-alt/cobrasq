-- ============================================================================
-- Verificação FASE C (separação Devedor↔Cobrança) — READ-ONLY.
-- Rodar via Supabase MCP/SQL Editor. Esperado: coluna "resultado" = 'ok' em tudo.
-- ============================================================================
-- 1) Exatamente 1 principal por cobrança (espelha uq_cobranca_partes_principal)
select 'um_principal_por_cobranca' as checagem,
       case when count(*)=0 then 'ok'
            else 'FALHA: '||count(*)||' cobranças com != 1 principal' end as resultado
from (select c.id, count(*) filter (where p.principal) n
      from public.cobrancas c
      left join public.cobranca_partes p on p.cobranca_id=c.id
      group by c.id) t
where n <> 1
union all
-- 2) Toda cobrança tem ao menos 1 parte (devedor vinculado)
select 'cobranca_com_parte',
       case when count(*)=0 then 'ok'
            else 'FALHA: '||count(*)||' cobranças sem parte' end
from public.cobrancas c
where not exists (select 1 from public.cobranca_partes p where p.cobranca_id=c.id)
union all
-- 3) Sem CPF/CNPJ duplicado entre devedores ativos (dedup)
select 'sem_doc_duplicado_ativo',
       case when coalesce(sum(n)-count(*),0)=0 then 'ok'
            else 'FALHA: '||(sum(n)-count(*))||' linhas excedentes' end
from (select doc_digits, count(*) n
      from public.devedores
      where doc_digits is not null and doc_digits<>'' and not coalesce(arquivado,false)
      group by doc_digits having count(*)>1) g
union all
-- 4) Colunas FASE C existem (10 em cobrancas + 8 em devedores = 18)
select 'colunas_fase_c',
       case when count(*)=18 then 'ok'
            else 'FALHA: faltam colunas ('||count(*)||'/18)' end
from information_schema.columns
where table_schema='public' and (
  (table_name='cobrancas' and column_name in
    ('numero_processo','vara_tribunal','vencimento','tags','tipo_documento',
     'numero_documento','banco','agencia_conta','origem','observacoes')) or
  (table_name='devedores' and column_name in
    ('rg','nacionalidade','estado_civil','profissao','apelido',
     'data_nascimento','observacoes','tags')))
order by checagem;
