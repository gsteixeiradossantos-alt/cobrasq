-- Protege nome_fantasia e o endereço do cliente contra o null-clobber do save da tela,
-- e passa a manter updated_at em todo UPDATE de clientes.
--
-- DEFEITO: clienteToRow() (index.html) monta a linha inteira a partir da memória do
-- navegador — inclusive `nome_fantasia: c.nomeFantasia || null` e os campos de endereço.
-- Quando o painel carregou o cadastro ANTES de uma alteração feita fora da tela (SQL,
-- import, API), a memória está desatualizada e o upsert grava null por cima, apagando o
-- dado. O trigger clientes_preserva_contato já resolvia isso para chave_pix, telefone e
-- doc; nome_fantasia e endereço ficaram de fora.
--
-- OCORRÊNCIA: 20/08/2026 — o nome_fantasia da matriz Arte Estofados (06.287.433/0001-56)
-- foi definido por SQL e apareceu como NULL na conferência seguinte, sem que ninguém
-- tivesse editado o cadastro pela tela.
--
-- AGRAVANTE: public.clientes não tem trigger de updated_at (o now() é só DEFAULT de
-- INSERT). Um UPDATE que não traga a coluna deixa a data intacta, então não havia como
-- auditar quando o campo foi zerado. Esta migração corrige isso também.
--
-- Válvula de escape para limpar um campo de propósito (a mesma que já existia):
--   set local cobrasq.permitir_limpar_contato = 'on';

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

  -- Identificação e endereço: mesmo null-clobber, mesma proteção.
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

-- updated_at em todo UPDATE, para que dê para auditar alteração de cadastro.
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
