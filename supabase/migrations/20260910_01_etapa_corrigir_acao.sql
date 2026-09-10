-- Etapa "Corrigir ação": a inicial já foi redigida e a pasta montada, mas a peça
-- ainda depende de revisão antes do protocolo.
--
-- Sem ela o caso ficava preso em "Fazer ação", cujo próprio rótulo diz "redigir e
-- protocolar a inicial" e não distingue o que ainda não foi escrito do que já está
-- pronto esperando conferência. Na prática o caso acabava ficando em "Negociando"
-- mesmo com a negociação encerrada (caso Maria Eduarda Krafczinsk, 09/2026: execução
-- montada em 03/09 e o CRM ainda mostrando "Acordo enviado" em 10/09).
--
-- A view public.casos filtra por `status`, não por `etapa` — então este valor novo
-- não torna nenhum caso invisível no CRM.
alter table public.cobrancas drop constraint if exists cobrancas_etapa_check;

alter table public.cobrancas add constraint cobrancas_etapa_check
  check (etapa is null or etapa = any (array[
    'cobrar','telefone_invalido','analise','negociando','acordo',
    'fazer_acao','corrigir_acao','reajuizar','em_acao','execucao',
    'executar_acordo','travado','quitado','encerrado','quitafacil'
  ]::text[]));
