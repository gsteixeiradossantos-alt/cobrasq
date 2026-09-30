-- F-52b — trava no banco contra tarifa do Asaas lançada duas vezes.
--
-- O webhook (garantirTarifaDoPagamento) e o cron (sincronizarTarifasAsaas) conferem o
-- marcador em observacoes antes de inserir; se rodarem no mesmo instante, os dois podem
-- passar pela conferência. Este índice faz o segundo INSERT falhar (23505 / HTTP 409),
-- e o código trata a falha como "já lançada".
--
-- O marcador é sempre a primeira palavra de observacoes: [asaas_tarifa:<paymentId>] ou
-- [asaas_ft:<id do extrato>]. Linhas sem marcador (lançadas à mão) ficam fora do índice.
-- Em 30/09/2026: 0 linhas com marcador em produção → cria sem conflito.
create unique index if not exists fin_lancamento_tarifa_asaas_uidx
  on public.fin_lancamento ((split_part(observacoes, ' ', 1)))
  where observacoes ~ '^\[asaas_(tarifa|ft):';
