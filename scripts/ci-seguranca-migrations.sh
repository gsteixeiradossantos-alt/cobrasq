#!/usr/bin/env bash
# Portão de segurança (CI) — barra migrations NOVAS que reintroduzam exposição.
# Achados da skill /auditar-cobrasq (R-07 + políticas de escrita abertas).
#
# COBRE: o que entra por MIGRATION (>= BASELINE). NÃO cobre mudança ad-hoc feita
# direto no painel/SQL Editor da Supabase — isso continua sendo pego pela vistoria
# periódica /auditar-cobrasq (supabase/verification/auditoria_seguranca.sql).
#
# Escape pontual: ponha o comentário `-- ci-allow-permissive` na linha, se for
# intencional e revisado.
set -euo pipefail

BASELINE="20260627"          # só checa migrations desta data em diante (grandfather histórico)
MIG_DIR="$(dirname "$0")/../supabase/migrations"
fail=0

shopt -s nullglob
for f in "$MIG_DIR"/*.sql; do
  base="$(basename "$f")"
  case "$base" in *rollback*) continue;; esac      # rollbacks contêm o estado antigo de propósito
  ver8="${base:0:8}"
  [[ "$ver8" =~ ^[0-9]{8}$ ]] || continue
  [ "$ver8" -ge "$BASELINE" ] || continue

  content="$(grep -vE 'ci-allow-permissive' "$f" || true)"

  # (A) grant de tabela _backup_/_arquivo_ para anon/authenticated (vazamento de PII)
  if printf '%s\n' "$content" | grep -iqE 'grant[[:space:]].*\b_(backup|arquivo)[a-z0-9_]*\b.*to[[:space:]].*(anon|authenticated)'; then
    echo "❌ $base: GRANT de tabela _backup_/_arquivo_ para anon/authenticated."
    fail=1
  fi

  # (B) política de escrita aberta: WITH CHECK (true) nunca é legítimo (bypass de escrita)
  if printf '%s\n' "$content" | grep -iqE 'with[[:space:]]+check[[:space:]]*\([[:space:]]*true[[:space:]]*\)'; then
    echo "❌ $base: WITH CHECK (true) — política de escrita sem restrição."
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Portão de segurança FALHOU. Corrija a migration ou justifique com '-- ci-allow-permissive'."
  exit 1
fi
echo "Portão de segurança: OK (migrations >= $BASELINE limpas)."
