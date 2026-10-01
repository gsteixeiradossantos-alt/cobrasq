-- ============================================================================
-- 20260928_08 — só o proprietário altera data->config do blob
-- NÃO APLICADA. Rollback: 20260928_08_config_so_proprietario_rollback.sql
--
-- O colaborador grava o blob cobrasq_data (RLS data_update_only_staff) e o painel
-- manda o objeto `config` inteiro junto — Configurações (integrações, régua, metas,
-- colunas, etiquetas, nome do escritório) ficavam ao alcance dele por qualquer save,
-- inclusive pelo salvamento de blob inteiro (a 05 já fecha o cobrasq_merge).
-- Este trigger devolve a config que estava no banco quando quem grava é um usuário
-- logado que NÃO é o proprietário. Sem usuário (service role, cron, SQL direto)
-- segue como antes. Roda junto com trg_cobrasq_data_sem_segredos (20260928_03), que
-- continua tirando as chaves de qualquer gravação.
-- O painel avisa antes (index.html, _cfgSoDono) para a mudança não "sumir" calada.
-- ============================================================================

create or replace function public.fn_cobrasq_data_config_dono()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null
     and coalesce(public.current_user_papel(), '') <> 'proprietario'
     and (new.data->'config') is distinct from (old.data->'config') then
    if old.data ? 'config' then
      new.data := jsonb_set(new.data, '{config}', old.data->'config', true);
    else
      new.data := new.data - 'config';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_cobrasq_data_config_dono on public.cobrasq_data;
create trigger trg_cobrasq_data_config_dono
  before update on public.cobrasq_data
  for each row execute function public.fn_cobrasq_data_config_dono();

-- Conferência (dentro de BEGIN/ROLLBACK, como colaborador):
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<id colaborador>","role":"authenticated"}';
--   update cobrasq_data set data = jsonb_set(data,'{config,empresa}','"X"') where key='main';
--   select data->'config'->>'empresa' from cobrasq_data where key='main';  -- valor antigo
