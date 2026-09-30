-- fin_recorrencia_template.dia_do_mes — a UI (index.html #mrec-dia) já pedia esse campo
-- e enviava no payload de salvarRecorrencia(), mas finApi.saveRecorrencia() descartava
-- silenciosamente (a coluna nem existia). Efeito: toda recorrência fixa criada até aqui
-- cairia sempre no dia 1 quando gerada por generateRecorrenciasMes(), não no dia
-- escolhido pelo usuário. Achado 2026-08-06 ao cadastrar as primeiras despesas fixas.

alter table public.fin_recorrencia_template
  add column if not exists dia_do_mes integer check (dia_do_mes between 1 and 31);
