-- Modo "só Carlos": liga o agente de negociação inicial sem devolver a Bia ao ar.
-- O gate global da edge function é `auto_ativo`, e ele governa as duas personas
-- (o roteamento do Carlos vive dentro de bia-atendimento). Sem esta flag, ligar
-- o Carlos reativa a Bia junto — com os P0 da auditoria de 30/07 ainda abertos.
alter table public.whatsapp_bia_config
  add column if not exists somente_carlos boolean not null default false;

comment on column public.whatsapp_bia_config.somente_carlos is
  'true = bia-atendimento só responde casos com carlos_ativo; demais conversas ficam sem resposta automática.';
