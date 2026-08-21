-- 20260821_fin_lancamento_asaas_payment_id.sql
--
-- PROBLEMA (medido em 21/08/2026)
-- Não existe vínculo entre um pagamento do Asaas e o lançamento que ele quitou.
-- Para saber qual parcela baixar, o /api/processar-recebimento pedia os lançamentos
-- do caso ordenados por data de criação com LIMIT 20 e escolhia o de valor igual.
-- Dois modos de falha, ambos observados em produção:
--
--   1. A janela de 20 é pequena. Marinalva da Rosa Alves tem 22 lançamentos: a parcela
--      5/25 é de 26/07 e em 06/08 nasceram de uma vez as parcelas 6/25 a 25/25 —
--      exatamente 20 linhas. A parcela certa ficou na posição 21. Como a busca aceita
--      lançamentos já pagos (status in 0,1), um caso com muitas parcelas quitadas
--      empurra a parcela aberta para fora da janela do mesmo jeito (Fatima Cordova,
--      que tinha UMA parcela aberta com o valor exato e mesmo assim não casou).
--   2. A comparação é por valor exato (5 centavos). Quem paga atrasado paga juros e
--      multa, e aí nenhum valor bate (Sidimar Ferreira: pagou 343,82 numa parcela
--      de 312,00).
--
-- O desfecho dependia da forma de pagamento: BOLETO não criava nada (o pagamento
-- sumia do financeiro, com aviso só no log); PIX criava um lançamento novo e deixava
-- a parcela aberta — o mesmo dinheiro contado duas vezes (6 casos, R$ 1.680,18).
--
-- CURA
-- Guardar o id do pagamento no próprio lançamento. A partir daí a pergunta "qual
-- parcela este pagamento quitou" tem resposta gravada, não inferida — e a mesma
-- coluna torna a conciliação do passado verificável em vez de adivinhada.
--
-- SEGURANÇA: aditiva. Coluna nova, nullable, sem default e sem backfill. Nenhuma
-- linha existente muda; nenhum caminho de leitura atual enxerga a coluna. O código
-- que a preenche trata ausência como "sem vínculo" e cai no comportamento antigo.
--
-- NÃO APLICADA. Aplicar em produção depende de autorização explícita do Gustavo.

alter table public.fin_lancamento
  add column if not exists asaas_payment_id text;

comment on column public.fin_lancamento.asaas_payment_id is
  'Id do pagamento no Asaas (pay_*) que quitou este lançamento. Gravado por '
  '/api/processar-recebimento na baixa. NULL = baixa manual, importada ou anterior '
  'a 21/08/2026.';

-- Um pagamento do Asaas quita UM lançamento. O índice único impede que um webhook
-- reenviado (o Asaas reenvia até receber 200) baixe uma segunda parcela com o mesmo
-- pagamento — a duplicidade que este PR existe para matar. Parcial: linhas antigas
-- com NULL não disputam o índice.
create unique index if not exists fin_lancamento_asaas_payment_id_uidx
  on public.fin_lancamento (asaas_payment_id)
  where asaas_payment_id is not null;

-- ROLLBACK
--   drop index if exists public.fin_lancamento_asaas_payment_id_uidx;
--   alter table public.fin_lancamento drop column if exists asaas_payment_id;
