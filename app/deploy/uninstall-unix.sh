#!/bin/sh
# ForgeAI uninstaller for macOS and Linux — removes every ForgeAI install it finds on this computer.
#
#   sh uninstall-unix.sh [--silent] [--purge] [--dry-run]
#
#   --silent    no questions, no prompts (for remote removal by a management tool or over SSH)
#   --purge     ALSO delete ForgeAI's data: chats, settings, downloaded models, saved keys. Cannot be undone.
#               Without it, data is kept so a later reinstall picks up where you left off.
#   --dry-run   only list what would be removed
#
# Removes: the desktop app (/Applications, ~/Applications), the background service / LaunchDaemon,
# ForgeAI Server (/opt/forgeai, ~/.forgeai, systemd "forgeai"), start-at-login entries, and running
# ForgeAI / engine processes. Run with sudo to clean every user account; without it only your own.
set -u
SILENT=0; PURGE=0; DRY=0
for a in "$@"; do case "$a" in
  --silent|-s) SILENT=1;; --purge) PURGE=1;; --dry-run) DRY=1;;
  -h|--help) sed -n '2,14p' "$0"; exit 0;;
  *) echo "Unknown option: $a (use --silent, --purge or --dry-run)" >&2; exit 2;;
esac; done
say() { [ "$SILENT" = 1 ] || echo "$@"; }
FOUND=0
rmp() { # rmp PATH — remove a file or folder if it exists
  for p in "$@"; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    FOUND=1
    if [ "$DRY" = 1 ]; then echo "would remove: $p"; else rm -rf "${p:?}" 2>/dev/null && say "removed: $p" || echo "could not remove: $p (try again with sudo)" >&2; fi
  done
}
run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@" >/dev/null 2>&1 || true; fi; }
ROOT=0; [ "$(id -u)" = 0 ] && ROOT=1
OS=$(uname -s)

# Which home folders to clean: every user's with sudo, otherwise just yours.
if [ "$ROOT" = 1 ]; then
  if [ "$OS" = Darwin ]; then HOMES=$(ls -d /Users/* 2>/dev/null | grep -v '/Shared$'); else HOMES=$(ls -d /home/* /root 2>/dev/null); fi
else HOMES="$HOME"; fi

if [ "$SILENT" = 0 ] && [ "$DRY" = 0 ]; then
  if [ "$PURGE" = 1 ]; then printf "Remove ForgeAI AND all its data (chats, models, keys) from this computer? [y/N] "
  else printf "Remove ForgeAI from this computer? Your data is kept. [y/N] "; fi
  read -r ans; case "$ans" in y|Y|yes|YES) ;; *) echo "Nothing removed."; exit 0;; esac
fi

# 1. Stop what is running.
say "Stopping ForgeAI…"
if [ "$OS" = Darwin ]; then
  [ "$DRY" = 1 ] || osascript -e 'quit app "ForgeAI"' >/dev/null 2>&1 || true
fi
run pkill -x ForgeAI
ENG='[Ff]orge[Aa][Ii].*(llama-server|ggml-rpc-server|rpc-server)'   # only ForgeAI's own engine, not a llama.cpp you run yourself
run pkill -f "$ENG"
run pkill -f "forgeai/app/headless.js"; run pkill -f "ForgeAI/app/headless.js"; run pkill -f "\.forgeai/app/headless.js"
[ "$DRY" = 1 ] || sleep 1
run pkill -9 -x ForgeAI; run pkill -9 -f "$ENG"

# 2. Services and start-at-login entries.
if [ "$OS" = Darwin ]; then
  if [ "$ROOT" = 1 ]; then
    for pl in /Library/LaunchDaemons/com.forgeai.*.plist /Library/LaunchAgents/com.forgeai.*.plist; do
      [ -f "$pl" ] || continue; run launchctl bootout system "$pl"; run launchctl unload "$pl"; rmp "$pl"
    done
  fi
  for h in $HOMES; do
    for pl in "$h"/Library/LaunchAgents/com.forgeai.*.plist; do
      [ -f "$pl" ] || continue
      u=$(stat -f %u "$h" 2>/dev/null || id -u)
      run launchctl bootout "gui/$u" "$pl"; [ "$h" = "$HOME" ] && run launchctl unload "$pl"; rmp "$pl"
    done
  done
  # The app's own "start at login" (Login Items) for the user running this.
  [ "$DRY" = 1 ] || osascript -e 'tell application "System Events" to delete (every login item whose name is "ForgeAI")' >/dev/null 2>&1 || true
elif [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1; then
  if [ -f /etc/systemd/system/forgeai.service ]; then
    if [ "$ROOT" = 1 ]; then run systemctl disable --now forgeai.service; rmp /etc/systemd/system/forgeai.service; run systemctl daemon-reload
    else echo "A system-wide ForgeAI service is installed — run this again with sudo to remove it." >&2; fi
  fi
  for h in $HOMES; do
    uf="$h/.config/systemd/user/forgeai.service"; [ -f "$uf" ] || continue
    [ "$h" = "$HOME" ] && run systemctl --user disable --now forgeai.service
    rmp "$uf"; rmp "$h/.config/systemd/user/default.target.wants/forgeai.service"
  done
  [ "$ROOT" = 1 ] || run systemctl --user daemon-reload
fi

# 3. The programs.
if [ "$OS" = Darwin ]; then
  rmp /Applications/ForgeAI.app
  for h in $HOMES; do rmp "$h/Applications/ForgeAI.app"; done
  rmp "/Library/Application Support/ForgeAI/app"
fi
rmp /opt/forgeai/app /opt/forgeai/app.old /opt/forgeai/node /opt/forgeai/forgeai.log
for h in $HOMES; do rmp "$h/.forgeai/app" "$h/.forgeai/app.old" "$h/.forgeai/node" "$h/.forgeai/forgeai.log"; done

# 4. Settings left by the installer (one-time setup files, caches). Data only with --purge.
for h in $HOMES; do
  if [ "$OS" = Darwin ]; then
    rmp "$h/Library/Caches/local.forgeai.app" "$h/Library/Caches/ForgeAI" "$h/Library/Saved Application State/local.forgeai.app.savedState" \
        "$h/Library/HTTPStorages/local.forgeai.app" "$h/Library/Logs/ForgeAI" "$h/Library/Application Support/ForgeAI/setup.json"
  fi
done
rmp "/Library/Application Support/ForgeAI/setup.json"

if [ "$PURGE" = 1 ]; then
  say "Deleting ForgeAI data…"
  rmp /opt/forgeai "/Library/Application Support/ForgeAI"
  for h in $HOMES; do
    rmp "$h/.forgeai"
    if [ "$OS" = Darwin ]; then rmp "$h/Library/Application Support/ForgeAI" "$h/Library/Preferences/local.forgeai.app.plist"
    else rmp "$h/.config/ForgeAI"; fi
  done
  # The key that protects saved API keys (macOS Keychain, current user only).
  if [ "$OS" = Darwin ] && [ "$DRY" = 0 ]; then security delete-generic-password -s "ForgeAI Safe Storage" >/dev/null 2>&1 && say "removed: Keychain item “ForgeAI Safe Storage”" || true; fi
else
  # Remove the now-empty program folders but keep data folders.
  [ "$DRY" = 1 ] || { rmdir /opt/forgeai 2>/dev/null; for h in $HOMES; do rmdir "$h/.forgeai" 2>/dev/null; done; } || true
fi

if [ "$FOUND" = 0 ]; then say "ForgeAI was not found on this computer — nothing to remove."; exit 0; fi
if [ "$DRY" = 1 ]; then exit 0; fi
if [ "$PURGE" = 1 ]; then say "ForgeAI and its data have been removed."
else
  say "ForgeAI has been removed. Your data was kept:"
  if [ "$OS" = Darwin ]; then say "  ~/Library/Application Support/ForgeAI   (delete it, or run again with --purge, to remove it)"
  else say "  ~/.forgeai/data or /opt/forgeai/data   (delete it, or run again with --purge, to remove it)"; fi
fi
say "If this computer was linked to a ForgeAI hub, also remove it there: Computers → the computer → Remove (this revokes its access)."
exit 0
