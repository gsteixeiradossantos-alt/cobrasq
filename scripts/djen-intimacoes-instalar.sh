#!/bin/zsh
# Agenda as intimações do DJEN no Mac (launchd), todo dia às 08:05
# (o cron antigo no Supabase era 11:00 UTC = 08:00 de Brasília).
#
# SÓ rodar depois de uma rodada manual ter dado certo:
#   node scripts/djen-intimacoes-local.mjs
# ("não adianta agendar algo que não está conseguindo fazer" — 25/09/2026).
#
# Copia o script para uma pasta fixa, porque o checkout principal
# (~/cobrasq-faturamento) troca de branch por baixo com outras sessões.
# Rodar de novo depois de mudar o script.
set -euo pipefail

ORIGEM="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/cobrasq-djen"
LABEL="br.com.cobrasq.djen-intimacoes"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

mkdir -p "$DEST/scripts" "$HOME/Library/Logs/cobrasq"
cp "$ORIGEM/scripts/djen-intimacoes-local.mjs" "$ORIGEM/scripts/djen-intimacoes-lotes.mjs" "$DEST/scripts/"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$DEST/scripts/djen-intimacoes-local.mjs</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>5</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/cobrasq/djen-intimacoes.launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/cobrasq/djen-intimacoes.launchd.log</string>
</dict></plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "agendado: $LABEL às 08:05 · log em ~/Library/Logs/cobrasq/djen-intimacoes.log"
