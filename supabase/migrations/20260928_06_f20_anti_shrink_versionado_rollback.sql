-- Rollback da 20260928_06 — nada a desfazer.
-- A 06 só versiona no repositório o trigger F-20 (anti-shrink) que já existia em produção
-- antes desta série; desfazê-la NÃO deve remover a proteção. Arquivo existe para manter a
-- regra "toda migração tem _rollback.sql".
select 1;
