#!/usr/bin/env bash
# Artefakt-Smoke (A3) im Release-Job "build": die AppImage muss unter Xvfb
# starten und ein Fenster zeigen. Aufruf: dbus-run-session -- bash smoke-appimage.sh <appimage>
set -eu
appimage=${1:?AppImage-Pfad fehlt}

Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
sleep 2
export DISPLAY=:99 APPIMAGE_EXTRACT_AND_RUN=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
"$appimage" >/tmp/app.log 2>&1 &
for _ in $(seq 1 24); do
  xdotool search --name protium >/dev/null 2>&1 && break
  sleep 5
done
if ! xdotool search --name protium >/dev/null 2>&1; then
  echo "FEHLER: kein protium-Fenster nach 120 s"
  tail -20 /tmp/app.log
  exit 1
fi
echo "Fenster gefunden:"
xwininfo -root -tree | grep -i protium || true

# Der AppRun-Hook muss im gestarteten Prozess wirksam sein. Der
# Build-Container hat eine Wayland-Bibliothek, also muss
# LD_PRELOAD gesetzt sein; fehlt sie, wird der Punkt uebersprungen.
PID=$(pgrep -x protium | head -1)
if [ -e /usr/lib/x86_64-linux-gnu/libwayland-client.so.0 ] || [ -e /usr/lib/x86_64-linux-gnu/libwayland-client.so ]; then
  if [ -n "$PID" ] && tr '\0' '\n' < "/proc/$PID/environ" | grep -q '^LD_PRELOAD=.*libwayland-client'; then
    echo "OK: AppRun hat den Hook ausgefuehrt und LD_PRELOAD gesetzt"
  else
    echo "FEHLER: Hook wurde im gestarteten Prozess nicht wirksam"
    exit 1
  fi
else
  echo "Hinweis: keine Wayland-Bibliothek im Container, Hook-Pruefung uebersprungen"
fi
