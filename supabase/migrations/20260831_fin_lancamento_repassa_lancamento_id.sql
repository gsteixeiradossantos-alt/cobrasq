-- 20260831_fin_lancamento_repassa_lancamento_id.sql
--
-- PROBLEMA (medido em 31/08/2026)
-- O marcador "↗ a repassar" da aba Movimentações acende em saída que ainda não é
-- devida. `_finLancEhRepasse` decide por três coisas — a operação de repasse, o
-- `cedente_id` do lançamento e o credor resolvido pela cobrança — e NENHUMA pergunta
-- se o dinheiro correspondente já entrou.
--
-- O caso que abriu o assunto (Leonardo dos Santos Fortes, credor Odontomundi): a saída
-- de R$ 500,00 com vencimento em 10/10/2026 já acende como "a repassar", enquanto a
-- receita que ela repassa — a parcela 15/15, mesmo 10/10 — ainda está em aberto. Não há
-- o que repassar: o dinheiro não entrou.
--
-- Escala: 323 saídas de repasse com vencimento FUTURO, somando R$ 141.657,43, todas
-- acendendo hoje. O chip "A repassar" conta dinheiro que ainda não está em caixa — o
-- mesmo defeito que motivou tirar o judicial pendente da lista (handoff 29/08), onde
-- linha não acionável inflava o ATRASADO e a previsão de entrada.
--
-- POR QUE UMA COLUNA, E NÃO MAIS UMA INFERÊNCIA
-- Dá para adivinhar por data ("só acende quando vencer"), mas data não é recebimento:
-- devedor que atrasa faria a seta acender com o caixa vazio. A pergunta "esta saída já
-- tem lastro?" precisa de resposta GRAVADA, pela mesma razão que
-- `fin_lancamento.asaas_payment_id` existe (ver 20260821): inferência por valor e data
-- é exatamente o que já falhou em produção.
--
-- DE ONDE SAI O VÍNCULO
-- Da regra que o próprio cronograma de repasse segue: as datas do repasse COINCIDEM com
-- as datas de recebimento (o capital enche as últimas parcelas do acordo, de trás para
-- frente). Então saída e receita do mesmo caso, no mesmo dia, são o par.
--
-- O elo entre elas é a base da descrição — a descrição sem a numeração de parcela e sem
-- a marca ` · verificar` do pente-fino. Não é elegante, mas é o MESMO elo que
-- `api/_repassar.js` já usa para propagar o credor às outras parcelas, e pela mesma
-- razão: metade das saídas não tem `cobranca_id` (176 de 369), então a cadeia
-- saída → cobrança → receita não existe para elas. A diferença é que aqui o elo é
-- resolvido UMA vez e gravado, em vez de refeito a cada render.
--
-- COBERTURA MEDIDA (31/08/2026, sobre as 369 saídas de repasse em aberto):
--   225  par único  → vinculadas por este backfill
--     3  ambíguas   → mais de uma receita no mesmo dia; ficam NULL (decisão humana,
--                     mesma precedência da conciliação: ambíguo não se aplica sozinho)
--   141  sem par    → ficam NULL e seguem com o comportamento de hoje
--
-- SEGURANÇA: aditiva. Coluna nova, nullable, sem default. O backfill só ESCREVE onde o
-- par é único e a coluna está vazia; nenhuma linha existente muda de valor. O código que
-- lê trata NULL como "não sei" e cai no comportamento antigo — a tela não regride onde o
-- vínculo não existir.
--
-- NÃO APLICADA. Aplicar em produção depende de autorização explícita do Gustavo.

alter table public.fin_lancamento
  add column if not exists repassa_lancamento_id bigint
    references public.fin_lancamento(id) on delete set null;

comment on column public.fin_lancamento.repassa_lancamento_id is
  'Só em SAÍDA de repasse: qual receita esta saída repassa. NULL = vínculo desconhecido '
  '(o consumidor deve cair no comportamento anterior, nunca presumir "sem lastro"). '
  'Gravado pelo backfill de 31/08/2026 e por /api/repassar daí em diante.';

create index if not exists fin_lancamento_repassa_idx
  on public.fin_lancamento (repassa_lancamento_id)
  where repassa_lancamento_id is not null;

-- ── Backfill ────────────────────────────────────────────────────────────────────────
-- `serie` = descrição sem a numeração de parcela e sem a marca do pente-fino. A ordem
-- das duas limpezas importa: a marca fica DEPOIS da numeração (foi o que cegou os quatro
-- leitores de descrição no F-11), então ela sai primeiro.
with base as (
  select id, tipo_movimento, status, data_vencimento, credor_id,
         btrim(regexp_replace(
                 regexp_replace(descricao, '\s*·\s*verificar\s*$', ''),
                 '\s*\d+/\d+\s*$', '')) as serie
    from public.fin_lancamento
),
par as (
  select s.id as saida_id, min(r.id) as receita_id, count(r.id) as n
    from base s
    join base r
      on r.tipo_movimento = 1
     and r.serie = s.serie
     and r.data_vencimento = s.data_vencimento
   where s.tipo_movimento = 0
     and s.credor_id is not null
     and s.status = 0
   group by s.id
  having count(r.id) = 1          -- ambíguo NÃO se aplica sozinho
)
update public.fin_lancamento l
   set repassa_lancamento_id = par.receita_id
  from par
 where l.id = par.saida_id
   and l.repassa_lancamento_id is null;

-- Conferência pós-aplicação (esperado em 31/08/2026: 225).
--   select count(*) from public.fin_lancamento where repassa_lancamento_id is not null;

-- ROLLBACK
--   drop index if exists public.fin_lancamento_repassa_idx;
--   alter table public.fin_lancamento drop column if exists repassa_lancamento_id;
