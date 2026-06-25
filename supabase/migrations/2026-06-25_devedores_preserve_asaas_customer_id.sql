-- 2026-06-25 — Preserva devedores.asaas_customer_id contra a sobrescrita do blob.
--
-- Contexto: os dados do devedor vivem em DUAS fontes — colunas relacionais E um blob
-- JSON. Vários saves da UI montam o UPDATE a partir do blob, que NÃO carrega
-- asaas_customer_id; o relacional era sobrescrito com null e o vínculo de pagamento
-- (usado pelo asaas-webhook p/ casar o pagador) sumia silenciosamente. Já tínhamos
-- visto o id cair de 11 → 6 devedores por causa disso.
--
-- Solução defensiva no banco: se um UPDATE chega com asaas_customer_id vazio mas a
-- linha JÁ tinha um valor, mantém o antigo. Nunca apaga um vínculo existente; ainda
-- permite gravar/trocar quando o UPDATE traz um id de verdade (é o que o backfill e a
-- emissão nativa fazem).
--
-- JÁ APLICADO EM PRODUÇÃO em 2026-06-25 (via MCP execute_sql). Arquivo serve de
-- registro — não rodar `supabase db push` cego (ver CLAUDE.md / migrations/README.md).

create or replace function public.preserve_asaas_customer_id() returns trigger
language plpgsql as $$
begin
  if coalesce(NEW.asaas_customer_id, '') = '' and coalesce(OLD.asaas_customer_id, '') <> '' then
    NEW.asaas_customer_id := OLD.asaas_customer_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists devedores_preserve_asaas on public.devedores;
create trigger devedores_preserve_asaas
  before update on public.devedores
  for each row execute function public.preserve_asaas_customer_id();
