-- ONDA 0 (Unificação CRM→Cobranças) — Backfill de escopo: whatsapp_atendimentos.caso_id.
--
-- RASCUNHO GATED — NÃO aplicar em produção sem revisão + autorização explícita.
-- O hub de comunicação no caso (Onda 1 #2) já funciona SEM este backfill, escopando a
-- conversa pelo TELEFONE do devedor (fallback sancionado pelo plano). Este script apenas
-- torna o vínculo explícito (caso_id) para escopo preciso quando aplicado.
--
-- Modelo: `caso_id` referencia devedores(id) (o "caso" é o devedor — ver crm_mensagens_status).
-- Estratégia: onde caso_id é NULL, casar pelos 8 últimos dígitos do telefone com o devedor
-- correspondente. Só preenche quando o match é ÚNICO (evita vínculo errado em telefone
-- compartilhado). Idempotente (só toca linhas com caso_id NULL) e não-destrutivo.
--
-- Revisar antes de aplicar: confirmar que whatsapp_atendimentos.caso_id existe e referencia
-- devedores(id); ajustar o nome da coluna de telefone do devedor se diferente (tel/telefone).

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='whatsapp_atendimentos' and column_name='caso_id') then
    raise notice 'whatsapp_atendimentos.caso_id não existe — nada a fazer.';
    return;
  end if;

  update public.whatsapp_atendimentos wa
     set caso_id = m.dev_id
    from (
      select w.telefone, min(d.id) as dev_id, count(*) as n
        from public.whatsapp_atendimentos w
        join public.devedores d
          -- ajustar 'd.telefone' se a coluna de telefone do devedor tiver outro nome.
          on right(regexp_replace(coalesce(d.telefone, ''), '\D', '', 'g'), 8)
           = right(regexp_replace(coalesce(w.telefone, ''), '\D', '', 'g'), 8)
       where w.caso_id is null
         and length(regexp_replace(coalesce(w.telefone,''), '\D','','g')) >= 8
       group by w.telefone
      having count(*) = 1               -- só match ÚNICO
    ) m
   where wa.caso_id is null
     and wa.telefone = m.telefone;

  raise notice 'Backfill whatsapp_atendimentos.caso_id concluído (apenas matches únicos por telefone).';
end $$;
