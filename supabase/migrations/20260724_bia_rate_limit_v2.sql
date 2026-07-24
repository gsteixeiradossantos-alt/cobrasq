-- ============================================================
-- Blindagem anti-spam da Bia v2: trigger com lote_id
-- ============================================================
-- Corrige 3 bugs do trigger v1:
--  1. Coluna errada (created_at -> enviada_em)
--  2. Bloqueava blocos 2-4 do mesmo lote (sem conceito de lote)
--  3. Auto-disable setava so auto_ativo, nao cobranca_ativa
--
-- Logica: cada chamada de enviarBlocos gera um lote_id (UUID).
-- Blocos do MESMO lote passam livremente. Lotes DIFERENTES para o
-- mesmo telefone em < 10s sao bloqueados. Se 3+ lotes distintos
-- chegam em 60s, auto_ativo E cobranca_ativa sao desligados.
--
-- Auto-disable usa RETURN NEW + RAISE WARNING (nao EXCEPTION) para
-- que o UPDATE em whatsapp_bia_config persista (EXCEPTION faria rollback).

-- 1. Coluna lote_id
ALTER TABLE whatsapp_bia_enviadas ADD COLUMN IF NOT EXISTS lote_id text;

-- 2. Limpar trigger e funcao antigos (nomes cruzados da v1)
DROP TRIGGER IF EXISTS bia_rate_limit_check ON whatsapp_bia_enviadas;
DROP TRIGGER IF EXISTS trg_bia_rate_limit ON whatsapp_bia_enviadas;
DROP FUNCTION IF EXISTS trg_bia_rate_limit();
DROP FUNCTION IF EXISTS bia_rate_limit_check();

-- 3. Funcao nova
CREATE OR REPLACE FUNCTION bia_rate_limit_check() RETURNS trigger AS $$
DECLARE
  outro_lote text;
  n_outros_lotes int;
BEGIN
  -- === Auto-disable: 3+ lotes distintos em 60s (check independente) ===
  IF NEW.lote_id IS NOT NULL THEN
    SELECT count(DISTINCT lote_id) INTO n_outros_lotes
    FROM whatsapp_bia_enviadas
    WHERE telefone = NEW.telefone
      AND enviada_em > now() - interval '60 seconds'
      AND lote_id IS NOT NULL
      AND lote_id != NEW.lote_id;

    IF n_outros_lotes >= 2 THEN
      UPDATE whatsapp_bia_config
      SET auto_ativo = false, cobranca_ativa = false
      WHERE id = 1;
      RAISE WARNING 'BIA_AUTO_DISABLED: % lotes distintos + este para % em 60s — Bia desligada', n_outros_lotes, NEW.telefone;
      RETURN NEW;
    END IF;
  END IF;

  -- === Cooldown: lote diferente em < 10s ===
  SELECT lote_id INTO outro_lote
  FROM whatsapp_bia_enviadas
  WHERE telefone = NEW.telefone
    AND enviada_em > now() - interval '10 seconds'
    AND lote_id IS NOT NULL
    AND NEW.lote_id IS NOT NULL
    AND lote_id != NEW.lote_id
  ORDER BY enviada_em DESC LIMIT 1;

  IF outro_lote IS NOT NULL THEN
    RAISE EXCEPTION 'RATE_LIMIT: cooldown 10s para %', NEW.telefone;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Trigger
CREATE TRIGGER trg_bia_rate_limit
  BEFORE INSERT ON whatsapp_bia_enviadas
  FOR EACH ROW EXECUTE FUNCTION bia_rate_limit_check();
