-- 20260816_fin_lancamento_credor_id.sql — credor do lançamento
--
-- Em 16/08/2026, 239 dos 323 repasses em aberto (R$ 79.941,69) não chegavam a um
-- cliente: a cadeia devedor → cobrança → cliente está quebrada na origem. Dos
-- devedores conferidos, a maioria existe em `devedores` mas sem cobrança que aponte
-- cliente, e alguns não existem nem como devedor. Sem um lugar para guardar a
-- escolha do credor, esse dinheiro ficaria sem caminho de pagamento por tempo
-- indeterminado.
--
-- Precedência de leitura em todo o app: credor_id → cobrancas.cliente_id.
-- Preenchido ao escolher o credor na tela Pagar repasses, junto com as demais
-- parcelas em aberto do mesmo devedor.

alter table public.fin_lancamento
  add column if not exists credor_id uuid references public.clientes(id);

comment on column public.fin_lancamento.credor_id is
  'Credor (cliente) do lançamento, quando a cobrança não resolve. Precedência de leitura: credor_id, depois cobrancas.cliente_id.';

create index if not exists fin_lancamento_credor_idx
  on public.fin_lancamento (credor_id) where credor_id is not null;
