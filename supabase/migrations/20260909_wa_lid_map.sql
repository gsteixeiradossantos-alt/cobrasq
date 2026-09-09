-- 20260909_wa_lid_map.sql
--
-- PROBLEMA: o WhatsApp passou a identificar parte das conversas por um
-- identificador interno "<numero>@lid" no lugar do telefone. O callback do
-- Z-API para as mensagens que SAEM da nossa conta (fromMe — inclusive a
-- resposta MANUAL digitada no WhatsApp Web/celular) chega com esse @lid em
-- `phone`. A função `zapi-recebidas` gravava isso cru em
-- `crm_mensagens_status.telefone_enviado`, então o cruzamento feito por
-- `vw_conversas_pendentes` (telefone_enviado = telefone da recebida) falhava e
-- a conversa continuava marcada como PENDENTE mesmo já respondida. O mesmo
-- ocorria na entrada, criando "contatos-fantasma" com o @lid virando telefone.
--
-- PONTE: toda mensagem RECEBIDA traz os dois campos no mesmo payload —
-- `phone` (telefone real) e `chatLid` (o identificador). Basta persistir esse
-- par e resolver o @lid na chegada.
--
-- Em 09/09/2026, em produção: 333 pares mapeáveis, 0 ambíguos,
-- 2.588 linhas de saída e 59 de entrada corrigíveis pelo backfill abaixo.
--
-- Rollback pareado: 20260909_wa_lid_map_rollback.sql

begin;

-- ---------------------------------------------------------------- mapa
create table if not exists public.wa_lid_map (
  lid           text primary key,
  telefone      text not null,
  nome          text,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists wa_lid_map_telefone_idx on public.wa_lid_map (telefone);

comment on table public.wa_lid_map is
  'Correspondencia entre o identificador @lid do WhatsApp e o telefone real. Alimentada pelas mensagens recebidas (trg_wa_lid_map) e consultada pela edge function zapi-recebidas para gravar as saidas na conversa certa.';

alter table public.wa_lid_map enable row level security;

drop policy if exists wa_lid_map_staff_all on public.wa_lid_map;
create policy wa_lid_map_staff_all on public.wa_lid_map
  for all
  using      (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

-- ------------------------------------------------- alimentacao automatica
-- So aceita telefone em formato BR plausivel (55 + DDD + 8/9 digitos): sem
-- isso o proprio @lid normalizado entraria como "telefone" e o mapa passaria a
-- ter dois destinos para o mesmo lid.
create or replace function public.wa_lid_map_upsert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lid text;
begin
  v_lid := new.raw ->> 'chatLid';

  if v_lid is null or v_lid = '' or new.telefone !~ '^55[0-9]{10,11}$' then
    return new;
  end if;

  insert into public.wa_lid_map (lid, telefone, nome)
  values (v_lid, new.telefone, nullif(new.raw ->> 'chatName', ''))
  on conflict (lid) do update
    set telefone      = excluded.telefone,
        nome          = coalesce(excluded.nome, public.wa_lid_map.nome),
        atualizado_em = now();

  return new;
end;
$$;

-- E' funcao de gatilho: ninguem deve poder chama-la via /rest/v1/rpc.
-- (Sem isto o advisor 0028/0029 acusa "SECURITY DEFINER executavel por anon".)
revoke execute on function public.wa_lid_map_upsert() from public, anon, authenticated;

drop trigger if exists trg_wa_lid_map on public.crm_mensagens_recebidas;
create trigger trg_wa_lid_map
  after insert or update on public.crm_mensagens_recebidas
  for each row execute function public.wa_lid_map_upsert();

-- --------------------------------------------------------------- backfill
-- Mapa, a partir do historico ja recebido (o par mais recente vence).
insert into public.wa_lid_map (lid, telefone, nome)
select distinct on (r.raw ->> 'chatLid')
       r.raw ->> 'chatLid',
       r.telefone,
       nullif(r.raw ->> 'chatName', '')
from public.crm_mensagens_recebidas r
where coalesce(r.raw ->> 'chatLid', '') <> ''
  and r.telefone ~ '^55[0-9]{10,11}$'
order by r.raw ->> 'chatLid', r.recebida_em desc
on conflict (lid) do nothing;

-- Guarda o identificador original das saidas, para auditoria.
alter table public.crm_mensagens_status add column if not exists lid text;

comment on column public.crm_mensagens_status.lid is
  'Identificador @lid como veio do Z-API, quando o telefone_enviado foi resolvido pelo wa_lid_map.';

-- Saidas ja gravadas sob o @lid.
update public.crm_mensagens_status s
set telefone_enviado = m.telefone,
    lid              = coalesce(s.lid, s.raw_payload ->> 'phone')
from public.wa_lid_map m
where s.raw_payload ->> 'phone' = m.lid
  and s.telefone_enviado is distinct from m.telefone;

-- Entradas ja gravadas sob o @lid (contatos-fantasma).
update public.crm_mensagens_recebidas r
set telefone = m.telefone
from public.wa_lid_map m
where r.raw ->> 'phone' = m.lid
  and r.telefone !~ '^55[0-9]{10,11}$';

commit;
