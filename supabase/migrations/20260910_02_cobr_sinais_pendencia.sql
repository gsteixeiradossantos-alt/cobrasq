-- ─────────────────────────────────────────────────────────────────────────────
-- cobr_sinais_pendencia() — os sinais de pendência da tela Cobranças em UMA
-- viagem, em vez de 11.
--
-- Antes, `_carregarSinaisPendencia()` no index.html disparava 11 requisições:
-- 5 chunks de `acordos` (200 devedores cada), 5 chunks de `devedor_eventos` e
-- as consultas globais de petições e intimações. Medido em produção com 854
-- cobranças: 2,7 s de relógio, com piso de ~200 ms de latência por requisição.
-- O trabalho de banco em si é irrisório — este corpo inteiro roda em ~151 ms,
-- tudo em índice. O custo era ida e volta, não consulta.
--
-- `ultimaAtividade` era o pior caso: trazia 3.327 linhas de evento ao navegador
-- só para o cliente ficar com a mais recente de cada devedor. Aqui é um
-- max(criado_em) agrupado — 491 linhas em vez de 3.327. De quebra corrige um
-- ponto cego: o cliente lia os eventos com `.limit(3000)` por chunk, então num
-- chunk que passasse disso os devedores do fim ficariam sem última atividade.
--
-- SECURITY INVOKER (o padrão — declarado aqui de propósito, para não virar
-- DEFINER numa redefinição futura, que foi exatamente o buraco do F-04 na view
-- `casos`): a RLS do chamador continua valendo, então colaborador só vê o que
-- já veria. Por isso a função também DERIVA os devedores em vez de recebê-los:
-- o conjunto sai das cobranças que o próprio chamador enxerga.
--
-- O WhatsApp NÃO entra aqui de propósito. O cliente consulta
-- `whatsapp_atendimentos.devedor_id`, coluna que não existe (a tabela tem
-- `caso_id`), e o erro é engolido por um .catch(()=>{}) — ou seja, esse sinal
-- nunca dispara hoje. Consertar isso muda o que aparece na tela e depende de
-- decidir como ligar atendimento a devedor (caso_id está nulo justamente nas
-- linhas em `aguardando_humano`); fica para uma mudança própria, consciente.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.cobr_sinais_pendencia()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with dev as (
    select distinct p.devedor_id as did
    from public.cobranca_partes p
    join public.cobrancas c on c.id = p.cobranca_id
    where coalesce(c.arquivado, false) = false
      and coalesce(c.is_draft, false) = false
      and p.devedor_id is not null
  )
  select jsonb_build_object(
    -- devedor_id → [{status, status_zapsign, metadata, parcelas}]
    'acordoPorDev', coalesce((
      select jsonb_object_agg(devedor_id::text, arr)
      from (
        select a.devedor_id,
               jsonb_agg(jsonb_build_object(
                 'status',         a.status,
                 'status_zapsign', a.status_zapsign,
                 'metadata',       a.metadata,
                 'parcelas',       a.parcelas)) as arr
        from public.acordos a
        where a.devedor_id in (select did from dev)
        group by a.devedor_id
      ) z), '{}'::jsonb),

    -- ids com peça pronta para protocolar (cobrança E devedor, como o cliente faz)
    'peticaoPreparada', coalesce((
      select jsonb_agg(distinct x)
      from (
        select p.cobranca_id::text as x from public.proc_peticionamentos p
          where p.status = 'preparado' and p.cobranca_id is not null
        union
        select p.devedor_id::text from public.proc_peticionamentos p
          where p.status = 'preparado' and p.devedor_id is not null
      ) y), '[]'::jsonb),

    -- devedores com andamento judicial novo (não lido)
    'intimacaoNova', coalesce((
      select jsonb_agg(distinct i.devedor_id::text)
      from public.proc_intimacoes i
      where i.lida = false and i.devedor_id is not null), '[]'::jsonb),

    -- devedor_id → instante do evento mais recente
    'ultimaAtividade', coalesce((
      select jsonb_object_agg(devedor_id::text, ult)
      from (
        select e.devedor_id, max(e.criado_em) as ult
        from public.devedor_eventos e
        where e.devedor_id in (select did from dev)
        group by e.devedor_id
      ) w), '{}'::jsonb)
  );
$$;

comment on function public.cobr_sinais_pendencia() is
  'Sinais de pendência da tela Cobranças (acordos, petições, intimações, última atividade) em uma chamada. SECURITY INVOKER: respeita a RLS do chamador.';

revoke all on function public.cobr_sinais_pendencia() from public;
-- `from public` NÃO alcança o grant que o Supabase dá a `anon` por default
-- privileges — conferido em produção, anon continuava com EXECUTE depois do
-- revoke acima. A tela Cobranças é só de usuário interno; a função é SECURITY
-- INVOKER e a RLS já barraria o conteúdo, mas menor privilégio é menor superfície.
revoke execute on function public.cobr_sinais_pendencia() from anon;
grant execute on function public.cobr_sinais_pendencia() to authenticated;
