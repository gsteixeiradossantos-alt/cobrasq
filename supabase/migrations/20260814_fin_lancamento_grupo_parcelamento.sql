-- 20260814_fin_lancamento_grupo_parcelamento.sql
--
-- Problema: `createLancamentoParcelado` (Financeiro › lançamento parcelado) marca as
-- parcelas de um mesmo parcelamento escrevendo `Grupo: PARC-<timestamp>-<rand>` no
-- campo de texto `observacoes`. Texto livre não é chave: nada impede criar o mesmo
-- parcelamento duas vezes, porque o banco não tem como conferir, e também não dá
-- para listar com segurança "todas as parcelas deste grupo".
--
-- Contexto: a conciliação contra o Controlle em 14/08/2026 achou 69 parcelas
-- duplicadas (R$ 60.486,58 de receita que não existia). Nenhuma veio deste caminho
-- — vieram de lançamento avulso digitado à mão —, mas o buraco aqui é o mesmo e
-- ainda estava aberto. Acordos já têm proteção equivalente em
-- `fin_lancamento_acordo_parcela_uidx`; isto estende a mesma ideia ao parcelamento
-- genérico, que não tem acordo por trás.
--
-- Aditiva e reversível: coluna nova aceita NULL, e o índice é PARCIAL, então
-- nenhuma das 833 linhas existentes é afetada nem revalidada.

alter table public.fin_lancamento
  add column if not exists grupo_parcelamento uuid;

comment on column public.fin_lancamento.grupo_parcelamento is
  'Agrupa as parcelas criadas juntas por createLancamentoParcelado. Substitui a '
  'etiqueta de texto "Grupo: PARC-..." em observacoes, que não servia de chave. '
  'NULL para lançamento avulso e para parcela de acordo (esta usa acordo_id).';

-- Impede a mesma parcela do mesmo grupo entrar duas vezes. Parcial: só vale quando
-- as duas colunas estão preenchidas, então não atrapalha o que já existe.
create unique index if not exists fin_lancamento_grupo_parcela_uidx
  on public.fin_lancamento (grupo_parcelamento, numero_parcela)
  where grupo_parcelamento is not null and numero_parcela is not null;

-- Busca por grupo (listar/editar/excluir o parcelamento inteiro).
create index if not exists fin_lancamento_grupo_idx
  on public.fin_lancamento (grupo_parcelamento)
  where grupo_parcelamento is not null;
