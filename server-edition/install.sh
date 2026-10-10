#!/bin/sh
# ForgeAI Server / Worker installer for Linux (incl. Raspberry Pi) and macOS.
# Run from the unzipped folder:   sh install.sh                     (worker mode, port 4545)
#                                 sh install.sh --port 4600 --main  (full ForgeAI server, no worker sharing)
# Installs Node.js 22 if needed (official build, checksum verified), copies ForgeAI, and starts it at boot.
set -eu
PORT=4545; MODE=worker; SILENT=0; PRIORITY=low; NOYIELD=0; NAME=""
# Options: --port N  --main  --silent  --priority low|lowest|normal (default low)  --no-yield  --name NAME
#   setup.json next to this script (or FORGEAI_SETUP_JSON) is applied on first start: hub to join, enrolment key, lending…
while [ $# -gt 0 ]; do case "$1" in --port) PORT="$2"; shift 2;; --main) MODE=main; shift;; --silent) SILENT=1; shift;; --priority) PRIORITY="$2"; shift 2;; --no-yield) NOYIELD=1; shift;; --name) NAME="$2"; shift 2;; *) echo "Unknown option $1"; exit 1;; esac; done
case "$PRIORITY" in low) NICE=10;; lowest) NICE=19;; normal) NICE=0;; *) echo "--priority must be low, lowest or normal"; exit 1;; esac
SRC="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64) NODEPLAT=linux-x64;; Linux-aarch64|Linux-arm64) NODEPLAT=linux-arm64;; Linux-armv7l) NODEPLAT=linux-armv7l;;
  Darwin-arm64) NODEPLAT=darwin-arm64;; Darwin-x86_64) NODEPLAT=darwin-x64;;
  *) echo "Sorry — $OS on $ARCH is not supported (needs 64-bit Linux, 32-bit ARMv7 Linux or macOS)."; exit 1;;
esac
if [ "$(id -u)" = 0 ]; then DEST=/opt/forgeai; else DEST="$HOME/.forgeai"; fi
: "${DEST:?}"
mkdir -p "$DEST"
need_node=1
if command -v node >/dev/null 2>&1; then
  V="$(node -p 'process.versions.node')"; MAJ="${V%%.*}"; REST="${V#*.}"; MIN="${REST%%.*}"
  if [ "$MAJ" -gt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -ge 5 ]; }; then need_node=0; NODE="$(command -v node)"; fi
fi
if [ $need_node = 1 ]; then
  echo "Installing Node.js 22 (official build from nodejs.org)…"
  BASE=https://nodejs.org/dist/latest-v22.x
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")" || { echo "Could not reach nodejs.org. Check the internet connection (or install Node.js 22.5+ yourself) and run this again."; exit 1; }
  FILE="$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v22\.[0-9.]+-$NODEPLAT\.tar\.gz$" | head -n1)"
  [ -n "$FILE" ] || { echo "No Node.js 22 build for $NODEPLAT."; exit 1; }
  WANT="$(printf '%s\n' "$SUMS" | grep " $FILE\$" | awk '{print $1}')"
  curl -fsSL "$BASE/$FILE" -o "${DEST:?}/${FILE:?}"
  if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$DEST/$FILE" | awk '{print $1}')"; else GOT="$(shasum -a 256 "$DEST/$FILE" | awk '{print $1}')"; fi
  [ "$WANT" = "$GOT" ] || { rm -f "${DEST:?}/${FILE:?}"; echo "Node.js download is damaged (checksum mismatch) — nothing installed. Try again."; exit 1; }
  rm -rf "${DEST:?}/node"; mkdir -p "$DEST/node"; tar -xzf "$DEST/$FILE" -C "$DEST/node" --strip-components=1; rm -f "${DEST:?}/${FILE:?}"
  NODE="$DEST/node/bin/node"
fi
echo "Copying ForgeAI to $DEST/app…"
rm -rf "${DEST:?}/app.new"; mkdir -p "$DEST/app.new"
cp -R "$SRC/app/." "$DEST/app.new/"
rm -rf "${DEST:?}/app.old"; if [ -d "$DEST/app" ]; then mv "$DEST/app" "$DEST/app.old"; fi; mv "$DEST/app.new" "$DEST/app"
DATA="$DEST/data"; mkdir -p "$DATA"
SETUP="${FORGEAI_SETUP_JSON:-$SRC/setup.json}"
if [ -f "$SETUP" ]; then cp "$SETUP" "$DATA/setup.json"
else printf '{ "priority": "%s", "yield": %s, "name": "%s", "silent": %s }\n' "$PRIORITY" "$([ $NOYIELD = 1 ] && echo false || echo true)" "$NAME" "$([ $SILENT = 1 ] && echo true || echo false)" > "$DATA/setup.json"; fi
ARGS="--port $PORT"; if [ $MODE = worker ]; then ARGS="--worker $ARGS"; fi
INFO=""
if [ $MODE = worker ]; then INFO="$(AICORE_DATA="$DATA" "$NODE" "$DEST/app/headless.js" --worker --port "$PORT" --print-token 2>/dev/null | tail -n1)"; fi
RUNAS="${SUDO_USER:-$(id -un)}"
if [ "$OS" = Linux ] && [ -d /run/systemd/system ]; then
  if [ "$(id -u)" = 0 ]; then WANTED=multi-user.target; USERLINE="User=$RUNAS"; else WANTED=default.target; USERLINE=""; fi
  UNIT="[Unit]
Description=ForgeAI ($MODE)
After=network-online.target
Wants=network-online.target
[Service]
$USERLINE
Environment=AICORE_DATA=$DATA
ExecStart=$NODE $DEST/app/headless.js $ARGS
Nice=$NICE
$([ "$PRIORITY" = lowest ] && printf 'CPUSchedulingPolicy=idle\nIOSchedulingClass=idle')
Restart=on-failure
RestartSec=5
[Install]
WantedBy=$WANTED"
  if [ "$(id -u)" = 0 ]; then
    printf '%s\n' "$UNIT" > /etc/systemd/system/forgeai.service
    chown -R "$RUNAS" "$DEST"
    systemctl daemon-reload; systemctl enable forgeai.service; systemctl restart forgeai.service
  else
    mkdir -p "$HOME/.config/systemd/user"; printf '%s\n' "$UNIT" > "$HOME/.config/systemd/user/forgeai.service"
    systemctl --user daemon-reload; systemctl --user enable forgeai.service; systemctl --user restart forgeai.service
    if command -v loginctl >/dev/null 2>&1; then loginctl enable-linger "$RUNAS" 2>/dev/null || true; fi
  fi
  echo "ForgeAI starts automatically at boot (systemd service “forgeai”)."
  # forgeai CLI on PATH
  [ -f "$DEST/app/deploy/forgeai" ] && ln -sf "$DEST/app/deploy/forgeai" /usr/local/bin/forgeai 2>/dev/null || true
elif [ "$OS" = Darwin ]; then
  PL="$HOME/Library/LaunchAgents/com.forgeai.server.plist"; mkdir -p "$(dirname "$PL")"
  PARGS=""; for a in $ARGS; do PARGS="$PARGS<string>$a</string>"; done
  cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.forgeai.server</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/app/headless.js</string>$PARGS</array>
<key>EnvironmentVariables</key><dict><key>AICORE_DATA</key><string>$DATA</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Nice</key><integer>$NICE</integer>$([ "$PRIORITY" = lowest ] && printf '<key>ProcessType</key><string>Background</string>')
<key>StandardOutPath</key><string>$DEST/forgeai.log</string><key>StandardErrorPath</key><string>$DEST/forgeai.log</string>
</dict></plist>
PLIST
  launchctl unload "$PL" 2>/dev/null || true; launchctl load "$PL"
  echo "ForgeAI starts automatically when you log in."
else
  echo "No service manager found — start ForgeAI with: AICORE_DATA=$DATA $NODE $DEST/app/headless.js $ARGS"
fi
echo
HUBSET="$(grep -o '"hub": "[^"]*"' "$DATA/setup.json" 2>/dev/null | cut -d'"' -f4)"
if [ -n "$HUBSET" ]; then echo "Done. This computer joins the ForgeAI hub at $HUBSET by itself when it starts (CPU priority: $PRIORITY)."; exit 0; fi
if [ $MODE = worker ]; then
  echo "Done. On your main ForgeAI: Computers → Add Computer → Another computer running ForgeAI"
  printf '%s\n' "$INFO" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("  Address: "+j.addresses.map(a=>"https://"+a+":"+j.port).join("  or  "));console.log("  Computer token: "+j.token)})'
  echo "Only use this on a private network or VPN (e.g. Tailscale)."
else
  echo "Done. Open https://<this computer's address>:$PORT from another computer to finish setup."
fi
