#!/bin/zsh
# Agenda a vigia de ações no Mac (launchd), toda segunda às 07:15, olhando 8 dias para trás
# (semanal desde 05/10/2026: processo novo contra devedor não corre prazo nosso).
# Roda sob caffeinate -i: às 07:15 o Mac costuma estar dormindo na bateria e,
# sem isso, volta a dormir no meio da rodada.
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
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE</string>
    <string>$DEST/scripts/vigia-acoes-local.mjs</string>
    <string>--dias</string><string>8</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/cobrasq/vigia-acoes.launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/cobrasq/vigia-acoes.launchd.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "agendado: $LABEL segundas às 07:15 · log em ~/Library/Logs/cobrasq/vigia-acoes.log"
