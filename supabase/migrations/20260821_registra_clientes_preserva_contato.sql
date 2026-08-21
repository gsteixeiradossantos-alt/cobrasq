-- REGISTRO de trigger que já existe em produção mas nunca esteve no repositório.
--
-- public.clientes_preserva_contato() e o trigger trg_clientes_preserva_contato foram
-- criados direto no banco, sem migração. Consequências:
--   1. Recriar o banco a partir de supabase/migrations perderia a proteção.
--   2. Quem lê só o repositório não sabe que ela existe — foi o que aconteceu no
--      PR #468, escrito em 30/07/2026 para resolver no front um problema que o banco
--      já tratava pela metade.
--
-- Esta migração NÃO muda comportamento: reproduz exatamente o estado atual de produção
-- (já incluindo os campos acrescentados pelo #542). É idempotente.
--
-- O QUE A PROTEÇÃO FAZ
-- Um UPDATE que traga um campo VAZIO onde o valor antigo existia tem o valor antigo
-- restaurado. Trocar por outro valor não-vazio passa normalmente. Serve contra o
-- null-clobber de clienteToRow(), que monta a linha inteira a partir da memória do
-- navegador e grava null quando a cópia local está desatualizada.
--
-- COMO LIMPAR UM CAMPO DE PROPÓSITO
--   begin;
--     set local cobrasq.permitir_limpar_contato = 'on';
--     update clientes set nome_fantasia = null where id = '...';
--   commit;
--
-- ⚠️ EFEITO NA TELA: o modal de cliente edita fantasia, endereço, cep, rua, numero,
-- complemento, bairro, cidade, uf, doc, telefone e chave_pix. Nenhum deles pode ser
-- ESVAZIADO pelo modal — a gravação passa, mas o valor antigo volta, silenciosamente.
-- Trocar por outro valor funciona. Se algum dia isso incomodar, a saída é o front
-- acionar a válvula acima por RPC quando o usuário confirmar a limpeza.

begin;

create or replace function public.clientes_preserva_contato()
returns trigger
language plpgsql
as $fn$
declare
  liberado boolean := coalesce(
    current_setting('cobrasq.permitir_limpar_contato', true), 'off') = 'on';
  -- Chaves de metadata que a tela de cliente NÃO edita: ela remonta o metadata do zero
  -- com 7 campos e destrói o resto. Estas são reinjetadas quando o UPDATE não as traz.
  fora_da_tela text[] := array[
    'pix_key','pix_key_type','whatsapp_repasse','whatsapp_repasse_origem',
    'razao_social','pix_origem','telefone_origem'];
  k text;
begin
  if liberado then
    return new;
  end if;

  if nullif(btrim(coalesce(new.chave_pix, '')), '') is null
     and nullif(btrim(coalesce(old.chave_pix, '')), '') is not null then
    new.chave_pix := old.chave_pix;
  end if;

  if nullif(btrim(coalesce(new.telefone, '')), '') is null
     and nullif(btrim(coalesce(old.telefone, '')), '') is not null then
    new.telefone := old.telefone;
  end if;

  if nullif(btrim(coalesce(new.doc, '')), '') is null
     and nullif(btrim(coalesce(old.doc, '')), '') is not null then
    new.doc := old.doc;
  end if;

  if nullif(btrim(coalesce(new.nome_fantasia, '')), '') is null
     and nullif(btrim(coalesce(old.nome_fantasia, '')), '') is not null then
    new.nome_fantasia := old.nome_fantasia;
  end if;

  if nullif(btrim(coalesce(new.endereco, '')), '') is null
     and nullif(btrim(coalesce(old.endereco, '')), '') is not null then
    new.endereco := old.endereco;
  end if;

  if nullif(btrim(coalesce(new.cep, '')), '') is null
     and nullif(btrim(coalesce(old.cep, '')), '') is not null then
    new.cep := old.cep;
  end if;

  if nullif(btrim(coalesce(new.rua, '')), '') is null
     and nullif(btrim(coalesce(old.rua, '')), '') is not null then
    new.rua := old.rua;
  end if;

  if nullif(btrim(coalesce(new.numero, '')), '') is null
     and nullif(btrim(coalesce(old.numero, '')), '') is not null then
    new.numero := old.numero;
  end if;

  if nullif(btrim(coalesce(new.complemento, '')), '') is null
     and nullif(btrim(coalesce(old.complemento, '')), '') is not null then
    new.complemento := old.complemento;
  end if;

  if nullif(btrim(coalesce(new.bairro, '')), '') is null
     and nullif(btrim(coalesce(old.bairro, '')), '') is not null then
    new.bairro := old.bairro;
  end if;

  if nullif(btrim(coalesce(new.cidade, '')), '') is null
     and nullif(btrim(coalesce(old.cidade, '')), '') is not null then
    new.cidade := old.cidade;
  end if;

  if nullif(btrim(coalesce(new.uf, '')), '') is null
     and nullif(btrim(coalesce(old.uf, '')), '') is not null then
    new.uf := old.uf;
  end if;

  foreach k in array fora_da_tela loop
    if (old.metadata ? k) and not (coalesce(new.metadata, '{}'::jsonb) ? k) then
      new.metadata := coalesce(new.metadata, '{}'::jsonb)
                      || jsonb_build_object(k, old.metadata -> k);
    end if;
  end loop;

  return new;
end;
$fn$;

drop trigger if exists trg_clientes_preserva_contato on public.clientes;
create trigger trg_clientes_preserva_contato
  before update on public.clientes
  for each row execute function public.clientes_preserva_contato();

-- updated_at em todo UPDATE (PR #542): sem isto, um UPDATE que não traga a coluna
-- deixa a data intacta e não há como auditar quando o cadastro mudou.
create or replace function public.clientes_touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_clientes_touch_updated_at on public.clientes;
create trigger trg_clientes_touch_updated_at
  before update on public.clientes
  for each row execute function public.clientes_touch_updated_at();

commit;
