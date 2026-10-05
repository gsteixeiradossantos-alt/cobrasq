-- 20261005_01_rotinas_mac_avisos.sql
-- Avisos no WhatsApp do escritório para as rotinas que rodam no Mac (05/10/2026):
--   1) "devedor é AUTOR": cada achado novo da vigia com polo A (crédito a penhorar no
--      rosto dos autos) vai no zap uma vez só (vigia_acoes.avisado_em);
--   2) "rotina não rodou": a busca de intimações no DJEN (todo dia 08:05) e a vigia
--      (segunda 07:15) rodam no Mac. Se o Mac ficou desligado ou a chamada falhou, a
--      função não recebe nada — então o aviso é pela AUSÊNCIA de execução registrada.
-- As edge functions djen-intimacoes e vigia-acoes passam a gravar 1 linha em
-- rotinas_execucoes a cada repasse do Mac (modo 'resultados').
-- Por quê: falha da rodada no Mac (desligado, dormindo, sem rede) só aparecia no log
-- local; e os achados "autor" (182 novos em 05/10/2026) só apareciam na tela.
-- Origem 'vigia_seguranca': já está na lista de avisos internos do worker
-- cron-mensagens-agendadas (não cede a vez a conversa pendente, R-23).

begin;

create table if not exists public.rotinas_execucoes (
  id      bigint generated always as identity primary key,
  rotina  text not null,                 -- 'djen-intimacoes' | 'vigia-acoes'
  em      timestamptz not null default now(),
  ok      boolean not null,
  resumo  jsonb
);
create index if not exists rotinas_execucoes_rotina_em on public.rotinas_execucoes (rotina, em desc);
alter table public.rotinas_execucoes enable row level security;
-- leitura só do proprietário; escrita só service_role (edge functions), que ignora RLS
drop policy if exists rotinas_execucoes_owner_select on public.rotinas_execucoes;
create policy rotinas_execucoes_owner_select on public.rotinas_execucoes
  for select using (public.current_user_papel() = 'proprietario');
revoke insert, update, delete on public.rotinas_execucoes from anon, authenticated;
-- Semente: a última rodada real da vigia (vigia_acoes_busca), para a conferência não
-- acusar "sem rodada nesta semana" só porque a tabela nasceu depois dela.
insert into public.rotinas_execucoes (rotina, em, ok, resumo)
select 'vigia-acoes', max(buscado_ts), true, '{"origem":"semente da migração 20261005_01"}'::jsonb
  from public.vigia_acoes_busca having max(buscado_ts) is not null;

alter table public.vigia_acoes add column if not exists avisado_em timestamptz;
comment on column public.vigia_acoes.avisado_em is
  'Quando o achado "devedor é autor" foi avisado no WhatsApp (rotinas_mac_conferir). Nulo = ainda não avisado.';
-- O que já está na tela não vira aviso: só o que a vigia achar daqui em diante.
update public.vigia_acoes set avisado_em = now() where avisado_em is null;

create or replace function public.rotinas_mac_conferir(p_dry boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tel   constant text := '46999223332';   -- mesmo número de lembretes e do resumo diário
  v_agora timestamp := now() at time zone 'America/Sao_Paulo';
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
  v_seg   date := v_hoje - (extract(isodow from v_hoje)::int - 1);  -- segunda desta semana
  v_ult_int timestamptz;
  v_ult_vig timestamptz;
  v_falhas text[] := '{}';
  v_msg   text;
  v_ids   uuid[];
  v_lista text;
  v_qtd   int;
  v_res   jsonb := '{}'::jsonb;
begin
  -- 1) Rotinas que não rodaram
  select max(em) into v_ult_int from rotinas_execucoes where rotina = 'djen-intimacoes' and ok;
  select max(em) into v_ult_vig from rotinas_execucoes where rotina = 'vigia-acoes' and ok;
  -- intimações: todo dia às 08:05; conferida a partir das 10h
  if v_agora::time >= time '10:00'
     and (v_ult_int is null or (v_ult_int at time zone 'America/Sao_Paulo')::date < v_hoje) then
    v_falhas := v_falhas || format('• Intimações do DJEN: sem rodada boa hoje (última boa: %s)',
      coalesce(to_char(v_ult_int at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nunca'));
  end if;
  -- vigia: segunda às 07:15; conferida a partir das 10h de segunda (e nos dias seguintes)
  if (v_hoje > v_seg or v_agora::time >= time '10:00')
     and (v_ult_vig is null or (v_ult_vig at time zone 'America/Sao_Paulo')::date < v_seg) then
    v_falhas := v_falhas || format('• Vigia de ações: sem rodada boa nesta semana (última boa: %s)',
      coalesce(to_char(v_ult_vig at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nunca'));
  end if;
  if coalesce(array_length(v_falhas, 1), 0) > 0 then
    v_msg := E'⚠️ *Rotina do Mac não rodou ou falhou*\n\n' || array_to_string(v_falhas, E'\n')
          || E'\n\nO Mac estava desligado ou sem internet no horário? Ao ligar, a próxima rodada recupera os dias perdidos (intimações: 5 dias; vigia: 8 dias). Log: ~/Library/Logs/cobrasq/';
    v_res := v_res || jsonb_build_object('falhas', to_jsonb(v_falhas), 'msg_falha', v_msg);
    if not p_dry then
      insert into crm_mensagens_agendadas (telefone, tipo, mensagem, agendada_para, status, origem)
      values (v_tel, 'texto', v_msg, now(), 'pendente', 'vigia_seguranca');
    end if;
  end if;

  -- 2) Achados novos em que o devedor é AUTOR
  select array_agg(id), count(*) into v_ids, v_qtd
    from vigia_acoes where polo = 'A' and status = 'novo' and avisado_em is null;
  if v_qtd > 0 then
    select string_agg(format('• %s — %s (%s%s)', nome_devedor,
             coalesce(nullif(numero_processo, ''), 'vários processos'), coalesce(tribunal, '?'),
             case when cpf_confere then ', CPF confere' else '' end), E'\n' order by ultima_data desc)
      into v_lista
      from (select * from vigia_acoes where id = any(v_ids) order by ultima_data desc limit 10) x;
    v_msg := format(E'💰 *Vigia: devedor é AUTOR* (%s novo%s)\n\nCrédito a receber — conferir no tribunal se é a mesma pessoa e pedir penhora no rosto dos autos:\n\n%s%s\n\nPainel → Jurídico → Intimações → Vigia de ações.',
             v_qtd, case when v_qtd = 1 then '' else 's' end, v_lista,
             case when v_qtd > 10 then format(E'\n… e mais %s', v_qtd - 10) else '' end);
    v_res := v_res || jsonb_build_object('autor', v_qtd, 'msg_autor', v_msg);
    if not p_dry then
      insert into crm_mensagens_agendadas (telefone, tipo, mensagem, agendada_para, status, origem)
      values (v_tel, 'texto', v_msg, now(), 'pendente', 'vigia_seguranca');
      update vigia_acoes set avisado_em = now() where id = any(v_ids);
    end if;
  end if;
  if p_dry then v_res := v_res || jsonb_build_object('dry', true); end if;
  return v_res;
end;
$$;
revoke all on function public.rotinas_mac_conferir(boolean) from public, anon, authenticated;

-- 10:00 BRT (13:00 UTC), todo dia
select cron.unschedule('rotinas-mac-conferir') where exists (select 1 from cron.job where jobname = 'rotinas-mac-conferir');
select cron.schedule('rotinas-mac-conferir', '0 13 * * *', $$select public.rotinas_mac_conferir()$$);

commit;
