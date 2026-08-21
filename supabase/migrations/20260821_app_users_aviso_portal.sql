-- Aviso configurável exibido no topo do portal do cedente, por usuário.
-- Preenchido = banner aparece só para aquele login; NULL/vazio = nada aparece.
-- Editável direto no banco, sem deploy.
alter table public.app_users
  add column if not exists aviso_portal text;

comment on column public.app_users.aviso_portal is
  'Aviso exibido no topo do portal do cedente para ESTE usuário. NULL ou vazio = sem aviso. Editável sem deploy.';
