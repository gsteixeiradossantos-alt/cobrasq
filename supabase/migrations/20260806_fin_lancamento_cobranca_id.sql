-- fin_lancamento.cobranca_id — vincula o lançamento à cobrança/devedor do CRM
-- (cobrancas.id == devedores.id, invariante 1:1 do sistema). Antes disso a
-- ligação vivia só em raw_payload->>'devedor_id' (jsonb, sem FK, só nas linhas
-- do import pdf-lancamentos-ago2026) — o webhook do Asaas não tinha como casar
-- um recebimento com o lançamento certo de forma confiável, e criava linha nova
-- em duplicidade (ver auditoria 2026-08-06: R$1.867 contados 2x).

alter table public.fin_lancamento
  add column if not exists cobranca_id uuid references public.cobrancas(id);

create index if not exists idx_fin_lancamento_cobranca_id
  on public.fin_lancamento(cobranca_id)
  where cobranca_id is not null;

-- Backfill a partir do raw_payload das linhas já importadas.
update public.fin_lancamento
set cobranca_id = (raw_payload->>'devedor_id')::uuid
where cobranca_id is null
  and raw_payload->>'devedor_id' is not null
  and exists (select 1 from public.cobrancas c where c.id = (raw_payload->>'devedor_id')::uuid);

-- Backfill complementar a partir do devedor_id já resolvido em fin_operacao
-- (recebimentos processados pelo webhook, que já identificam o devedor mas
-- não tinham como gravar isso de volta no lançamento antes de existir a coluna).
update public.fin_lancamento fl
set cobranca_id = fo.devedor_id
from public.fin_operacao fo
where fo.lancamento_receita_id = fl.id
  and fl.cobranca_id is null
  and fo.devedor_id is not null;
