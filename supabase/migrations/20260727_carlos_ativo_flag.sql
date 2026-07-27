-- Flag "Ativar Carlos" no CRM: marca que o Carlos (IA de negociação inicial,
-- fase "a cobrar") assumiu a primeira abordagem deste caso. Aplicada via MCP
-- em 2026-07-27; arquivo aqui só pra manter o histórico versionado.
alter table cobrancas add column if not exists carlos_ativo boolean not null default false;
comment on column cobrancas.carlos_ativo is 'true quando o operador clicou "Ativar Carlos" no CRM: Carlos (IA de negociação inicial) assumiu a primeira abordagem deste caso.';
