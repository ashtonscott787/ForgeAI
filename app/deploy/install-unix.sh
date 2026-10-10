#!/bin/sh
# ForgeAI command-line installer for macOS and Linux.
#
#   sh install-unix.sh [options]
#
#   --silent              no questions, no window on first start (for remote / mass installs)
#   --hub HOST:PORT       join this ForgeAI hub after installing
#   --key KEY             enrolment key from the hub (Computers -> Remote link -> Roll out)
#   --zip FILE            install from a ForgeAI zip you already have (otherwise downloaded from the hub)
#   --priority LEVEL      low (default) | lowest | normal   - CPU priority for ForgeAI and its models
#   --no-yield            don't step back when your other apps need the computer (default: step back)
#   --lend MODE           idle (default for joined computers) | always | never
#   --hide-icon           no menu-bar icon (macOS desktop app)
#   --autostart           start at login, hidden in the background
#   --no-start            install only; don't start ForgeAI now
#   --name NAME           how this computer appears to the others
#
# macOS installs the ForgeAI desktop app into /Applications (or ~/Applications without admin rights).
# Linux installs ForgeAI Server (headless) as a service. Both read the same settings.
set -eu
HUB="__HUB__"; KEY="__KEY__"; PIN="__PIN__"; JOIN="__JOIN__"
case "$HUB" in __*) HUB="";; esac; case "$KEY" in __*) KEY="";; esac; case "$PIN" in __*) PIN="";; esac; case "$JOIN" in __*) JOIN="";; esac
SILENT=0; ZIP=""; PRIORITY="low"; YIELD=true; LEND=""; SHOWICON=true; AUTOSTART=false; START=1; NAME=""; SERVICE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --silent) SILENT=1;; --hub) HUB="$2"; shift;; --key) KEY="$2"; shift;; --zip) ZIP="$2"; shift;;
    --priority) PRIORITY="$2"; shift;; --no-yield) YIELD=false;; --lend) LEND="$2"; shift;;
    --hide-icon) SHOWICON=false;; --autostart) AUTOSTART=true;; --no-start) START=0;; --name) NAME="$2"; shift;;
    --join) JOIN="$2"; shift;; --service) SERVICE=1; AUTOSTART=true;;
    -h|--help) sed -n '2,22p' "$0"; exit 0;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac; shift
done
case "$PRIORITY" in low|lowest|normal) ;; *) echo "--priority must be low, lowest or normal" >&2; exit 2;; esac
if [ -n "$JOIN" ] && { [ -z "$HUB" ] || [ -z "$KEY" ]; }; then
  _dec=$(printf '%s' "${JOIN#FGJ1.}" | tr '_-' '/+'); _pad=$(( (4 - ${#_dec} % 4) % 4 )); _i=0; while [ $_i -lt $_pad ]; do _dec="${_dec}="; _i=$((_i+1)); done
  _json=$(printf '%s' "$_dec" | base64 -d 2>/dev/null || printf '%s' "$_dec" | base64 --decode 2>/dev/null)
  [ -z "$KEY" ] && KEY=$(printf '%s' "$_json" | sed -n 's/.*"k"[ ]*:[ ]*"\([^"]*\)".*/\1/p')
  [ -z "$HUB" ] && HUB=$(printf '%s' "$_json" | sed -n 's/.*"a"[ ]*:[ ]*\[[ ]*"\([^"]*\)".*/\1/p')
fi
[ -n "$HUB" ] && [ -z "$LEND" ] && LEND="idle"
say() { [ "$SILENT" = 1 ] || echo "$@"; }
die() { echo "ForgeAI install failed: $*" >&2; exit 1; }
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t forgeai); trap 'rm -rf "${TMP:?}"' EXIT
fetch() { # fetch NAME DEST  — from the hub, pinned to its certificate key when known
  [ -n "$HUB" ] && [ -n "$KEY" ] || die "no --zip given and no hub to download from (use --zip FILE, or --hub and --key)"
  if [ -n "$PIN" ]; then curl -fsSk --pinnedpubkey "$PIN" -o "$2" "https://$HUB/node/deploy/file/$1?key=$KEY" || die "could not download $1 from $HUB"
  else curl -fsSk -o "$2" "https://$HUB/node/deploy/file/$1?key=$KEY" || die "could not download $1 from $HUB"; fi
}
verify() { # verify FILE NAME — against the hub's SHA256SUMS.txt when available
  [ -n "$HUB" ] && [ -n "$KEY" ] || return 0
  fetch SHA256SUMS.txt "$TMP/SUMS" 2>/dev/null || { say "(no checksum list on the hub — skipping check)"; return 0; }
  want=$(grep " $2\$" "$TMP/SUMS" | awk '{print $1}'); [ -n "$want" ] || return 0
  if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$1" | awk '{print $1}'); else got=$(sha256sum "$1" | awk '{print $1}'); fi
  [ "$want" = "$got" ] || die "checksum mismatch for $2 — the download was damaged or changed"
  say "Checksum OK"
}
setup_json() { # setup_json FILE
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<EOF
{ "silent": $([ "$SILENT" = 1 ] && echo true || echo false), $([ -n "$JOIN" ] && echo "\"join\": \"$JOIN\",") "hub": "$HUB", "key": "$KEY", "priority": "$PRIORITY", "yield": $YIELD, "showIcon": $SHOWICON, "startAtLogin": $AUTOSTART, "startHidden": $AUTOSTART, "lend": "$LEND", "name": "$NAME", "worker": $([ -n "$HUB" ] && echo true || echo false) }
EOF
}

OS=$(uname -s)
if [ "$OS" = "Darwin" ]; then
  ARCH=$(uname -m); FILE=ForgeAI-Mac-Intel.zip; DIRNAME="ForgeAI (Intel)"; [ "$ARCH" = "arm64" ] && { FILE=ForgeAI-Mac-AppleSilicon.zip; DIRNAME="ForgeAI (Apple Silicon)"; }
  if [ -z "$ZIP" ]; then say "Downloading $FILE from $HUB…"; fetch "$FILE" "$TMP/$FILE"; verify "$TMP/$FILE" "$FILE"; ZIP="$TMP/$FILE"; fi
  say "Unpacking…"; ditto -x -k "$ZIP" "$TMP/x" || die "could not unpack $ZIP"
  APP=$(find "$TMP/x" -maxdepth 3 -name ForgeAI.app -type d | head -1); [ -n "$APP" ] || die "ForgeAI.app not found in $ZIP"
  DEST=/Applications; [ -w "$DEST" ] || DEST="$HOME/Applications"; mkdir -p "$DEST"
  osascript -e 'quit app "ForgeAI"' >/dev/null 2>&1 || true; pkill -x ForgeAI >/dev/null 2>&1 || true; sleep 1
  [ -d "$DEST/ForgeAI.app" ] && rm -rf "${DEST:?}/ForgeAI.app"
  ditto "$APP" "$DEST/ForgeAI.app" || die "could not copy ForgeAI.app to $DEST"
  xattr -dr com.apple.quarantine "$DEST/ForgeAI.app" 2>/dev/null || true
  if [ "$(id -u)" = 0 ]; then setup_json "/Library/Application Support/ForgeAI/setup.json"; else setup_json "$HOME/Library/Application Support/ForgeAI/setup.json"; fi
  if [ "$SERVICE" = 1 ]; then
    [ "$(id -u)" = 0 ] || die "--service on a Mac needs sudo (it installs a system-wide background service)"
    NODEBIN="$DEST/ForgeAI.app/Contents/MacOS/ForgeAI"; HLJS="$DEST/ForgeAI.app/Contents/Resources/app/headless.js"
    DDATA="/Library/Application Support/ForgeAI/data"; mkdir -p "$DDATA"
    [ -f "/Library/Application Support/ForgeAI/setup.json" ] && mv "/Library/Application Support/ForgeAI/setup.json" "$DDATA/setup.json" 2>/dev/null || true
    cat > /Library/LaunchDaemons/com.forgeai.service.plist <<PL
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.forgeai.service</string>
<key>ProgramArguments</key><array><string>$NODEBIN</string><string>$HLJS</string><string>--worker</string><string>--service</string></array>
<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string><key>AICORE_DATA</key><string>$DDATA</string><key>FORGEAI_SERVICE</key><string>1</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>$DDATA/service.log</string><key>StandardErrorPath</key><string>$DDATA/service.log</string>
</dict></plist>
PL
    launchctl bootout system /Library/LaunchDaemons/com.forgeai.service.plist 2>/dev/null || launchctl unload /Library/LaunchDaemons/com.forgeai.service.plist 2>/dev/null || true
    launchctl bootstrap system /Library/LaunchDaemons/com.forgeai.service.plist 2>/dev/null || launchctl load /Library/LaunchDaemons/com.forgeai.service.plist 2>/dev/null || true
    say "Installed ForgeAI as a background service (starts at boot, no window or icon)."
    [ -n "$HUB$JOIN" ] && say "It joins your hub by itself when it starts."
    exit 0
  fi
  if [ "$AUTOSTART" = true ] && [ "$(id -u)" != 0 ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$HOME/Library/LaunchAgents/com.forgeai.app.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.forgeai.app</string><key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>-a</string><string>$DEST/ForgeAI.app</string><string>--args</string><string>--hidden</string></array><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string></dict></plist>
EOF
  fi
  # Put the `forgeai` command on PATH (best effort; needs write access to /usr/local/bin).
  CLI="$DEST/ForgeAI.app/Contents/Resources/app/deploy/forgeai"
  if [ -f "$CLI" ]; then
    if [ -w /usr/local/bin ] || mkdir -p /usr/local/bin 2>/dev/null && [ -w /usr/local/bin ]; then ln -sf "$CLI" /usr/local/bin/forgeai && say "The 'forgeai' command is ready (try: forgeai status)."
    elif [ "$(id -u)" = 0 ]; then ln -sf "$CLI" /usr/local/bin/forgeai; fi
  fi
  say "Installed ForgeAI into $DEST"
  if [ "$START" = 1 ]; then open -g -a "$DEST/ForgeAI.app" --args --hidden 2>/dev/null || launchctl asuser "$(id -u)" open -g -a "$DEST/ForgeAI.app" --args --hidden 2>/dev/null || say "ForgeAI will start at the next login."; fi
  [ -n "$HUB" ] && say "It joins $HUB by itself when it starts."
  exit 0
fi

if [ "$OS" = "Linux" ]; then
  FILE=ForgeAI-Server.zip
  if [ -z "$ZIP" ]; then say "Downloading $FILE from $HUB…"; fetch "$FILE" "$TMP/$FILE"; verify "$TMP/$FILE" "$FILE"; ZIP="$TMP/$FILE"; fi
  command -v unzip >/dev/null 2>&1 || { command -v apt-get >/dev/null 2>&1 && apt-get install -y unzip >/dev/null 2>&1; } || true
  command -v unzip >/dev/null 2>&1 || die "unzip is needed (sudo apt install unzip)"
  unzip -q "$ZIP" -d "$TMP/x" || die "could not unpack $ZIP"
  setup_json "$TMP/x/ForgeAI Server/setup.json"
  set -- --silent --priority "$PRIORITY"; [ -n "$NAME" ] && set -- "$@" --name "$NAME"; [ "$YIELD" = false ] && set -- "$@" --no-yield
  (cd "$TMP/x/ForgeAI Server" && FORGEAI_SETUP_JSON="$TMP/x/ForgeAI Server/setup.json" sh install.sh "$@") || die "ForgeAI Server install failed"
  [ -n "$HUB" ] && say "It joins $HUB by itself when it starts."
  exit 0
fi
die "unsupported system: $OS (use the Windows installer on Windows)"
