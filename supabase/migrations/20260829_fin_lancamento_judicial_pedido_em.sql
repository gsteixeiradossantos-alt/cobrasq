-- Aba Judicial (handoff "Financeiro COBRASQ" 29/08/2026, Fase 4).
--
-- A aba responde uma pergunta que o sistema não sabia responder: HÁ QUANTO TEMPO este
-- dinheiro está parado no juízo. Penhora de salário, Sisbajud e desconto INSS não têm
-- vencimento — dependem de o juízo liberar —, então "dias de atraso" não significa nada
-- ali. O que significa é a espera desde o PEDIDO DE EXPEDIÇÃO do alvará/ofício.
--
-- Sem esta coluna a aba existe, mas dois dos quatro cards ficam sem lastro: "espera
-- média" (do pedido até o crédito) e "parados há +60 dias" (o que precisa ser conferido
-- no processo). Nenhum dos dois pode sair de data_vencimento: vencimento, nesse tipo de
-- lançamento, é um palpite de quando o dinheiro cai, não a data em que se pediu.
--
-- judicial_pedido_em = data do pedido de expedição do alvará/ofício (ou do bloqueio,
-- no Sisbajud). Fica NULL quando não se sabe; a tela mostra "—" na espera em vez de
-- inventar um número. A UI já lê a coluna com fallback: enquanto esta migração não for
-- aplicada, a aba Judicial funciona e só os dois cards de espera ficam em "—".

alter table public.fin_lancamento
  add column if not exists judicial_pedido_em date;

comment on column public.fin_lancamento.judicial_pedido_em is
  'Para lançamentos categorizados Sisbajud/Penhora: data do pedido de expedição do alvará/ofício (ou do bloqueio). É dela que sai a espera mostrada na aba Judicial — nunca de data_vencimento. NULL = espera desconhecida.';
