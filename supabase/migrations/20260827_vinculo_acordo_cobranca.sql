-- 20260827_vinculo_acordo_cobranca
--
-- PROBLEMA (incidente 27/08/2026, devedora Juliana Pinto Ribeiro)
-- ---------------------------------------------------------------
-- O sistema nasceu com o invariante 1:1 `cobrancas.id == devedores.id`. A partir da
-- SEGUNDA cobranca de um mesmo devedor esse invariante deixa de valer, e todo fluxo que
-- resolve "o caso" pelo id do DEVEDOR passa a escrever na cobranca ERRADA — em silencio,
-- porque o UPDATE encontra a linha (a do outro credor) e retorna sucesso.
--
-- Foi o que aconteceu: um acordo do credor S.O.S Animal marcou "Acordo enviado" na
-- cobranca da Arte Estofados, que estava em "2.1. Acordo Judicial".
--
-- Alcance medido em 27/08/2026: 39 devedores com mais de uma cobranca, 35 deles com
-- colisao de id (93 cobrancas envolvidas) e 43 acordos com `cobranca_id` NULO.
--
-- ESTRATEGIA
-- ----------
-- O codigo tem ~40 pontos com esse pressuposto. Em vez de perseguir todos, a garantia vai
-- para o BANCO, por onde todos os fluxos passam. A regra e:
--
--   nunca escrever numa cobranca "adivinhada" pelo id do devedor.
--   Resolver pelo vinculo real (cobranca_partes); se for ambiguo, NAO agir e ALERTAR.
--
-- O sistema passa a errar para o lado de nao fazer nada e deixar rastro, em vez de fazer
-- na cobranca errada sem ninguem ver.
--
-- ROLLBACK: ver bloco comentado no fim do arquivo.

begin;

-- ---------------------------------------------------------------------------
-- 1. Tabela de alertas — o que o banco se recusou a adivinhar
-- ---------------------------------------------------------------------------
create table if not exists public.alertas_vinculo (
  id           bigint generated always as identity primary key,
  origem       text        not null,          -- 'acordo_insert', 'acordo_assinado', ...
  acordo_id    uuid        null references public.acordos(id) on delete cascade,
  devedor_id   uuid        null,
  motivo       text        not null,
  detalhe      jsonb       not null default '{}'::jsonb,
  resolvido_em timestamptz null,
  criado_em    timestamptz not null default now()
);

comment on table public.alertas_vinculo is
  'Casos em que o banco NAO conseguiu resolver a cobranca de forma inequivoca e se recusou '
  'a adivinhar pelo id do devedor. Cada linha exige decisao humana: apontar acordos.cobranca_id.';

create index if not exists idx_alertas_vinculo_abertos
  on public.alertas_vinculo (criado_em desc) where resolvido_em is null;

alter table public.alertas_vinculo enable row level security;

drop policy if exists alertas_vinculo_leitura on public.alertas_vinculo;
create policy alertas_vinculo_leitura on public.alertas_vinculo
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2. Resolucao segura: cobranca a partir do devedor, SO quando inequivoca
-- ---------------------------------------------------------------------------
-- Retorna NULL quando o devedor tem 0 ou 2+ cobrancas ativas. NULL aqui significa
-- "nao sei", e todo chamador deve tratar como "nao agir" — jamais cair no devedor_id.
create or replace function public.fn_cobranca_inequivoca_do_devedor(p_devedor_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_n  integer;
begin
  if p_devedor_id is null then
    return null;
  end if;

  select count(distinct cp.cobranca_id)
    into v_n
    from public.cobranca_partes cp
    join public.cobrancas c on c.id = cp.cobranca_id
   where cp.devedor_id = p_devedor_id
     and coalesce(c.arquivado, false) = false;

  if v_n <> 1 then
    return null;                       -- 0 = nenhuma; 2+ = ambiguo. Nos dois casos: nao sei.
  end if;

  select distinct cp.cobranca_id
    into v_id
    from public.cobranca_partes cp
    join public.cobrancas c on c.id = cp.cobranca_id
   where cp.devedor_id = p_devedor_id
     and coalesce(c.arquivado, false) = false;

  return v_id;
end;
$$;

revoke execute on function public.fn_cobranca_inequivoca_do_devedor(uuid) from public, anon;
grant  execute on function public.fn_cobranca_inequivoca_do_devedor(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Acordo nunca mais nasce orfao (fecha a torneira)
-- ---------------------------------------------------------------------------
-- Qualquer INSERT em acordos sem cobranca_id — venha do n8n, da RPC, do painel ou de SQL
-- manual — passa por aqui. Se der para resolver, resolve. Se nao der, deixa NULL e alerta.
create or replace function public.fn_acordo_set_cobranca()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if new.cobranca_id is not null then
    return new;
  end if;

  v_id := public.fn_cobranca_inequivoca_do_devedor(new.devedor_id);

  if v_id is not null then
    new.cobranca_id := v_id;
    return new;
  end if;

  insert into public.alertas_vinculo (origem, acordo_id, devedor_id, motivo, detalhe)
  values ('acordo_insert', new.id, new.devedor_id,
          'acordo sem cobranca_id e devedor com 0 ou 2+ cobrancas ativas — apontar a cobranca a mao',
          jsonb_build_object(
            'valor_total',    new.valor_total,
            'num_parcelas',   new.num_parcelas,
            'zapsign_doc_id', new.zapsign_doc_id,
            'external_id',    new.metadata->>'external_id'));

  return new;
end;
$$;

revoke execute on function public.fn_acordo_set_cobranca() from anon, authenticated;

drop trigger if exists trg_acordo_set_cobranca on public.acordos;
create trigger trg_acordo_set_cobranca
  before insert on public.acordos
  for each row
  execute function public.fn_acordo_set_cobranca();

-- ---------------------------------------------------------------------------
-- 4. Assinatura deixa de cair no devedor_id
-- ---------------------------------------------------------------------------
-- Substitui a versao de 20260709_acordo_assinado_sync.sql, cujo
-- `COALESCE(NEW.cobranca_id, NEW.devedor_id)` marcava "Acordo assinado" + fora_crm=true na
-- cobranca errada — tirando do CRM uma divida viva de OUTRO credor.
create or replace function public.fn_acordo_assinado_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cobranca_id uuid;
  v_data        text := coalesce(new.data_assinatura::text, now()::text);
begin
  if new.status_zapsign is distinct from 'assinado' then
    return new;
  end if;

  -- NUNCA cair para new.devedor_id: e exatamente o que escrevia na cobranca errada.
  v_cobranca_id := coalesce(new.cobranca_id,
                            public.fn_cobranca_inequivoca_do_devedor(new.devedor_id));

  if v_cobranca_id is null then
    insert into public.alertas_vinculo (origem, acordo_id, devedor_id, motivo, detalhe)
    values ('acordo_assinado', new.id, new.devedor_id,
            'acordo assinado sem cobranca identificavel — CRM nao foi atualizado de proposito',
            jsonb_build_object('data_assinatura', v_data,
                               'zapsign_doc_id',  new.zapsign_doc_id));
    return new;
  end if;

  update public.cobrancas c
     set passo_atual  = 'Acordo assinado',
         fora_crm     = true,
         acordo_final = jsonb_set(coalesce(c.acordo_final, '{}'::jsonb), '{assinado}', 'true'::jsonb)
                        || jsonb_build_object('data_assinatura', v_data),
         updated_at   = now()
   where c.id = v_cobranca_id
     and c.encerramento is null
     and (coalesce(c.passo_atual, '') is distinct from 'Acordo assinado'
          or coalesce(c.fora_crm, false) = false);

  return new;
end;
$$;

revoke execute on function public.fn_acordo_assinado_sync() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. RPC do n8n passa a gravar cobranca_id
-- ---------------------------------------------------------------------------
-- Duas correcoes sobre 20260806_vincular_zapsign_acordo_entrada.sql:
--   (a) o INSERT nao listava cobranca_id — origem dos 43 acordos orfaos;
--   (b) ao reaproveitar um acordo aberto do devedor, pegava QUALQUER um, de qualquer
--       credor. Agora so reaproveita quando o devedor tem uma unica cobranca ativa;
--       havendo mais de uma, cria acordo novo e deixa o alerta decidir o vinculo.
create or replace function public.vincular_zapsign_acordo(
  p_doc_token          text,
  p_external_id        text default null,
  p_cpf_dev            text default null,
  p_telefone           text default null,
  p_valor_total        text default null,
  p_num_parcelas       integer default null,
  p_data_primeiro_venc text default null,
  p_forma              text default null,
  p_valor_entrada      text default null
) returns jsonb
language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_dev_id    uuid;
  v_cob_id    uuid;
  v_acordo_id uuid;
  v_valor     numeric;
  v_entrada   numeric;
  v_venc      date;
  v_cpf text := nullif(regexp_replace(coalesce(p_cpf_dev,''), '\D', '', 'g'), '');
  v_tel text := nullif(right(regexp_replace(coalesce(p_telefone,''), '\D', '', 'g'), 8), '');
begin
  if coalesce(btrim(p_doc_token),'') = '' then
    return jsonb_build_object('ok', false, 'motivo', 'doc_token vazio');
  end if;

  select id into v_acordo_id from acordos where zapsign_doc_id = p_doc_token limit 1;
  if v_acordo_id is not null then
    return jsonb_build_object('ok', true, 'acao', 'ja_vinculado', 'acordo_id', v_acordo_id);
  end if;

  if v_cpf is not null then
    select d.id into v_dev_id from devedores d
     where nullif(regexp_replace(coalesce(d.doc_digits, d.doc, ''), '\D', '', 'g'), '') = v_cpf
     order by d.updated_at desc limit 1;
  end if;
  if v_dev_id is null and v_tel is not null then
    select d.id into v_dev_id from devedores d
     where right(regexp_replace(coalesce(d.telefone,''), '\D', '', 'g'), 8) = v_tel
     order by d.updated_at desc limit 1;
  end if;
  if v_dev_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'devedor não encontrado por CPF/telefone',
                              'cpf', v_cpf, 'tel', v_tel);
  end if;

  v_cob_id := public.fn_cobranca_inequivoca_do_devedor(v_dev_id);

  begin
    v_valor := nullif(replace(regexp_replace(coalesce(p_valor_total,''), '[^0-9,]', '', 'g'), ',', '.'), '')::numeric;
  exception when others then v_valor := null; end;
  begin
    v_entrada := nullif(replace(regexp_replace(coalesce(p_valor_entrada,''), '[^0-9,]', '', 'g'), ',', '.'), '')::numeric;
  exception when others then v_entrada := null; end;
  begin
    if p_data_primeiro_venc ~ '^\d{2}/\d{2}/\d{4}$' then
      v_venc := to_date(p_data_primeiro_venc, 'DD/MM/YYYY');
    end if;
  exception when others then v_venc := null; end;

  -- So reaproveita acordo aberto quando o vinculo e inequivoco. Com 2+ cobrancas, um
  -- acordo do credor A seria "reaproveitado" para o credor B.
  if v_cob_id is not null then
    select id into v_acordo_id from acordos
     where devedor_id = v_dev_id and zapsign_doc_id is null
       and coalesce(status_zapsign,'') <> 'assinado' and status = 'ativo'
       and (cobranca_id is null or cobranca_id = v_cob_id)
     order by created_at desc limit 1;
  end if;

  if v_acordo_id is not null then
    update acordos
       set zapsign_doc_id = p_doc_token,
           status_zapsign = coalesce(status_zapsign, 'enviado'),
           linha_gsheet   = coalesce(linha_gsheet, p_external_id),
           valor_entrada  = coalesce(valor_entrada, v_entrada),
           cobranca_id    = coalesce(cobranca_id, v_cob_id),
           metadata = coalesce(metadata,'{}'::jsonb)
                      || jsonb_build_object('vinculado_por','n8n','external_id',p_external_id),
           updated_at = now()
     where id = v_acordo_id;
    return jsonb_build_object('ok', true, 'acao', 'atualizado', 'acordo_id', v_acordo_id,
                              'devedor_id', v_dev_id, 'cobranca_id', v_cob_id);
  end if;

  -- cobranca_id vai explicito; se vier NULL, o trigger trg_acordo_set_cobranca alerta.
  insert into acordos (devedor_id, cobranca_id, forma, status, num_parcelas, valor_total,
                       valor_entrada, data_primeiro_venc, zapsign_doc_id, status_zapsign,
                       linha_gsheet, metadata)
  values (v_dev_id, v_cob_id,
          case when p_forma in ('avista','boleto','cartao','outro') then p_forma else 'boleto' end,
          'ativo', p_num_parcelas, v_valor, v_entrada, v_venc,
          p_doc_token, 'enviado', p_external_id,
          jsonb_build_object('vinculado_por','n8n','external_id',p_external_id))
  returning id into v_acordo_id;

  return jsonb_build_object('ok', true, 'acao', 'criado', 'acordo_id', v_acordo_id,
                            'devedor_id', v_dev_id, 'cobranca_id', v_cob_id);
end $$;

revoke execute on function public.vincular_zapsign_acordo(text,text,text,text,text,integer,text,text,text) from public, anon, authenticated;
grant  execute on function public.vincular_zapsign_acordo(text,text,text,text,text,integer,text,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. ANTES do backfill: preservar a semantica de "ja emitido"
-- ---------------------------------------------------------------------------
-- CUIDADO. Ate aqui, `api/_emitir-acordo.js` usava `acordos.cobranca_id` como FLAG de
-- "boletos ja emitidos" (idempotencia). A partir desta migracao cobranca_id passa a ser o
-- VINCULO com a divida e e preenchido em todo acordo novo — os dois sentidos nao cabem na
-- mesma coluna. O codigo foi corrigido para olhar so `metadata.boletos_emitidos`.
--
-- Este passo transporta a informacao antes que ela se perca: todo acordo que hoje tem
-- cobranca_id preenchido E prova real de emissao (invoice do Asaas ou parcelas lancadas no
-- financeiro) recebe a flag no metadata. Sem isso, o emissor os trataria como nao emitidos
-- e geraria BOLETO EM DUPLICIDADE para o devedor.
--
-- Prova real, nao a mera presenca de cobranca_id: acordos cujo cobranca_id foi preenchido a
-- mao (sem emissao) nao podem ser marcados, senao nunca emitiriam.
update public.acordos a
   set metadata   = coalesce(a.metadata, '{}'::jsonb) || jsonb_build_object('boletos_emitidos', true),
       updated_at = now()
 where a.cobranca_id is not null
   and (a.metadata->>'boletos_emitidos') is null
   and (
        (a.metadata->>'asaas_invoice_url') is not null
     or (a.metadata->>'asaas_installment') is not null
     or exists (select 1 from public.fin_lancamento fl
                 where fl.acordo_id = a.id and fl.tipo_movimento = 1)
   );

-- ---------------------------------------------------------------------------
-- 7. Backfill do passivo
-- ---------------------------------------------------------------------------
-- Em 27/08/2026: 42 acordos com cobranca_id nulo — 41 resolviveis sem ambiguidade e 1 sem
-- cobranca ativa. Preenche so os inequivocos; o resto vira alerta.
update public.acordos a
   set cobranca_id = public.fn_cobranca_inequivoca_do_devedor(a.devedor_id),
       updated_at  = now()
 where a.cobranca_id is null
   and public.fn_cobranca_inequivoca_do_devedor(a.devedor_id) is not null;

insert into public.alertas_vinculo (origem, acordo_id, devedor_id, motivo, detalhe)
select 'backfill_20260827', a.id, a.devedor_id,
       'acordo antigo sem cobranca_id e sem vinculo inequivoco — apontar a cobranca a mao',
       jsonb_build_object('valor_total', a.valor_total, 'status_zapsign', a.status_zapsign)
  from public.acordos a
 where a.cobranca_id is null
   and not exists (select 1 from public.alertas_vinculo av
                    where av.acordo_id = a.id and av.origem = 'backfill_20260827');

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- begin;
--   drop trigger if exists trg_acordo_set_cobranca on public.acordos;
--   drop function if exists public.fn_acordo_set_cobranca();
--   -- reaplicar fn_acordo_assinado_sync de 20260709_acordo_assinado_sync.sql
--   -- reaplicar vincular_zapsign_acordo de 20260806_vincular_zapsign_acordo_entrada.sql
--   drop function if exists public.fn_cobranca_inequivoca_do_devedor(uuid);
--   drop table if exists public.alertas_vinculo;
-- commit;
-- O backfill do item 6 NAO precisa de rollback: preencheu apenas vinculos inequivocos,
-- que sao os corretos independentemente desta migracao.
