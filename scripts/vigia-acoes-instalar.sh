#!/bin/zsh
# Agenda a vigia de ações no Mac (launchd), todo dia às 07:15.
#
# SÓ rodar depois de uma rodada manual completa ter dado certo:
#   node scripts/vigia-acoes-local.mjs
# ("não adianta agendar algo que não está conseguindo fazer" — 25/09/2026).
#
# Copia o script e a lógica para uma pasta fixa, porque o checkout principal
# (~/cobrasq-faturamento) troca de branch por baixo com outras sessões.
# Rodar de novo depois de mudar o script ou a logica.mjs.
set -euo pipefail

ORIGEM="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/cobrasq-vigia"
LABEL="br.com.cobrasq.vigia-acoes"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

mkdir -p "$DEST/scripts" "$DEST/supabase/functions/vigia-acoes" "$HOME/Library/Logs/cobrasq"
cp "$ORIGEM/scripts/vigia-acoes-local.mjs" "$DEST/scripts/"
cp "$ORIGEM/supabase/functions/vigia-acoes/logica.mjs" "$DEST/supabase/functions/vigia-acoes/"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$DEST/scripts/vigia-acoes-local.mjs</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/cobrasq/vigia-acoes.launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/cobrasq/vigia-acoes.launchd.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "agendado: $LABEL às 07:15 · log em ~/Library/Logs/cobrasq/vigia-acoes.log"
