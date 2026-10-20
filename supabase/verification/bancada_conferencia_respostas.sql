-- Bancada de conferência: o que cada cliente já respondeu (migração 20261019).
-- Somente leitura. Rodar no SQL Editor como proprietário/service role.

-- 1) Placar por cliente
select c.nome as cliente,
       count(p.*)                                   as perguntas,
       count(p.resposta)                            as respondidas,
       count(*) filter (where p.resposta is null)   as faltam,
       max(p.respondida_em)                         as ultima_resposta
  from public.conferencia_perguntas p
  join public.clientes c on c.id = p.cliente_id
 group by c.nome
 order by c.nome;

-- 2) Respostas, devedor por devedor (pergunta geral aparece como "(geral)")
select c.nome                              as cliente,
       coalesce(i.devedor, '(geral)')      as devedor,
       i.titulo,
       p.ordem,
       p.pergunta,
       p.resposta,
       to_char(p.respondida_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as em,
       jsonb_array_length(p.historico)     as trocas
  from public.conferencia_perguntas p
  join public.clientes c on c.id = p.cliente_id
  left join public.conferencia_itens i on i.id = p.item_id
 order by c.nome, i.ordem nulls first, p.ordem;
