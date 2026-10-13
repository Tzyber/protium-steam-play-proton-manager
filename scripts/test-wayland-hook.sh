#!/usr/bin/env bash
# Prueft src-tauri/appimage-hooks/01-wayland-fix.sh im Release-Job "hook".
# Aufruf aus dem Repo-Wurzelverzeichnis: test-wayland-hook.sh system|ldconfig|silent
set -e
mode=${1:?modus fehlt: system, ldconfig oder silent}

# Der Hook wird gesourct und darf die Shell nicht beenden. Deshalb laeuft er
# in einer Subshell, die am Ende einen Sentinel ausgibt: fehlt der Sentinel,
# hat der Hook die Shell verlassen.
out=$(
  set +e
  LD_PRELOAD=
  # shellcheck source=src-tauri/appimage-hooks/01-wayland-fix.sh
  . src-tauri/appimage-hooks/01-wayland-fix.sh
  printf 'HOOK_RC=%s\nHOOK_LD=%s\nHOOK_SENTINEL=yes\n' "$?" "${LD_PRELOAD:-}"
)
echo "$out"
case "$out" in *HOOK_SENTINEL=yes*) : ;; *) echo "FEHLER: Hook hat die Shell beendet"; exit 1 ;; esac
rc=$(printf '%s\n' "$out" | sed -n 's/^HOOK_RC=//p')
ld=$(printf '%s\n' "$out" | sed -n 's/^HOOK_LD=//p')

case "$mode" in
  system)
    case "$ld" in
      *libwayland-client.so*) echo "OK: Hook laedt die Systembibliothek vor: $ld" ;;
      *) echo "FEHLER: Hook findet die Systembibliothek nicht"; exit 1 ;;
    esac ;;
  ldconfig)
    case "$ld" in
      /usr/local/lib/libwayland-client.so*) echo "OK: Hook nutzt die ldconfig-Rueckfrage: $ld" ;;
      *) echo "FEHLER: ldconfig-Rueckfrage greift nicht"; exit 1 ;;
    esac ;;
  silent)
    [ "$rc" = "0" ] || { echo "FEHLER: Hook endet mit $rc"; exit 1; }
    [ -z "$ld" ] || { echo "FEHLER: LD_PRELOAD ohne Bibliothek gesetzt: $ld"; exit 1; }
    echo "OK: Hook bleibt still" ;;
  *) echo "FEHLER: unbekannter Modus: $mode"; exit 1 ;;
esac
