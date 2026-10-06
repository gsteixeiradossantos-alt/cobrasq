-- ============================================================================
-- Processos vinculados / desdobramentos da cobrança (pedido do Gustavo, 06/10/2026)
--
-- Hoje a cobrança só tem cobrancas.numero_processo. Embargos de terceiro, cumprimento
-- em apenso, acordos homologados em desdobramento etc. ficavam fora da ficha, do
-- DataJud e da busca. A migração do Astrea deixou números extras em
-- cobrancas.metadata.processosRelacionados (sem rótulo), que nenhuma tela lê.
--
-- Decisões do Gustavo (06/10/2026):
--   * tabela própria, um registro por processo, com rótulo;
--   * número opcional (desdobramento sem número, ex.: acordo extrajudicial), mas,
--     se preenchido, CNJ completo; número igual ao do principal é permitido
--     (acordos no mesmo processo) — o DataJud não consulta duas vezes;
--   * só o escritório vê (proprietário tudo; colaborador nas cobranças dele).
--
-- Aditiva. Backfill de metadata.processosRelacionados. Rollback pareado.
-- ============================================================================

begin;

create table if not exists public.cobranca_processos_vinculados (
  id uuid primary key default gen_random_uuid(),
  cobranca_id uuid not null references public.cobrancas(id) on delete cascade,
  -- CNJ completo (0000505-91.2022.8.16.0068), nunca abreviado. Nulo = sem número.
  numero_processo text check (numero_processo is null or numero_processo ~ '^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$'),
  -- "Embargos de Terceiro", "Cumprimento de sentença", "Acordo 2/3"...
  rotulo text not null check (btrim(rotulo) <> ''),
  monitorar_datajud boolean not null default true,
  observacao text,
  criado_por uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_cob_proc_vinc_cobranca on public.cobranca_processos_vinculados(cobranca_id);
create index if not exists idx_cob_proc_vinc_numero on public.cobranca_processos_vinculados(numero_processo) where numero_processo is not null;
create unique index if not exists uq_cob_proc_vinc on public.cobranca_processos_vinculados(cobranca_id, coalesce(numero_processo,''), lower(btrim(rotulo)));
comment on table public.cobranca_processos_vinculados is
  'Processos vinculados / desdobramentos da cobrança (embargos, apensos, acordos). O principal continua em cobrancas.numero_processo.';

drop trigger if exists trg_cob_proc_vinc_updated_at on public.cobranca_processos_vinculados;
create trigger trg_cob_proc_vinc_updated_at before update on public.cobranca_processos_vinculados
  for each row execute function public.set_updated_at();

alter table public.cobranca_processos_vinculados enable row level security;

-- Só o escritório (mesmo predicado de bens_cobranca). Cedente e devedor: nada.
drop policy if exists cob_proc_vinc_proprietario on public.cobranca_processos_vinculados;
create policy cob_proc_vinc_proprietario on public.cobranca_processos_vinculados for all to authenticated
  using (current_user_papel()='proprietario') with check (current_user_papel()='proprietario');
drop policy if exists cob_proc_vinc_colaborador on public.cobranca_processos_vinculados;
create policy cob_proc_vinc_colaborador on public.cobranca_processos_vinculados for all to authenticated
  using (current_user_papel()='colaborador' and exists (select 1 from public.cobrancas c where c.id=cobranca_id and (c.cadastrado_por=auth.uid() or c.assigned_to=auth.uid())))
  with check (current_user_papel()='colaborador' and exists (select 1 from public.cobrancas c where c.id=cobranca_id and (c.cadastrado_por=auth.uid() or c.assigned_to=auth.uid())));

revoke all on public.cobranca_processos_vinculados from anon;
grant select, insert, update, delete on public.cobranca_processos_vinculados to authenticated;

-- Backfill: metadata.processosRelacionados (array de strings CNJ, com ou sem máscara).
-- Só entram os que dão 20 dígitos; o metadata fica intacto (não apaga a origem).
insert into public.cobranca_processos_vinculados (cobranca_id, numero_processo, rotulo, observacao)
select c.id,
       regexp_replace(d.dig, '^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$', '\1-\2.\3.\4.\5.\6'),
       'Processo relacionado (Astrea)',
       'Importado de metadata.processosRelacionados (migração do Astrea).'
from public.cobrancas c
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(c.metadata->'processosRelacionados')='array' then c.metadata->'processosRelacionados' else '[]'::jsonb end
) as r(txt)
cross join lateral (select regexp_replace(r.txt, '\D', '', 'g') as dig) d
where length(d.dig)=20
on conflict do nothing;

commit;
