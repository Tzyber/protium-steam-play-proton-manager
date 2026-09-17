# AppRun hook: system-libwayland-client vorladen, um EGL_BAD_PARAMETER unter
# Wayland zu verhindern. geladen von linuxdeploy's AppRun via ".
# (sourced, nicht executed, kein exit, kein shebang nötig aber schadet nicht).
#
# gesucht wird zuerst die versionierte Laufzeitbibliothek (.so.0), dann die
# unversionierte (.so). Arch liefert beide im Laufzeitpaket, Debian/Ubuntu und
# Fedora nur die versionierte; dort lief der Hook vorher ins Leere, obwohl die
# AppImage ihre eigene libwayland-client.so.0 mitbringt. findet die Pfadliste
# nichts, fragt der Hook ldconfig. keiner gefunden → no-op (X11-systeme oder
# systeme ohne wayland-client).
#
# 32-bit-Treffer des ldconfig-Caches werden ausgeschlossen: die AppImage ist
# x86_64, eine i386-Bibliothek würde den Start zerlegen.

_protium_wayland_client=""
# Reihenfolge nach Architektursicherheit: /usr/lib/x86_64-linux-gnu und
# /usr/lib64 sind auf ihren Systemen die 64-Bit-Orte, /usr/lib ist auf
# Fedora-multilib der 32-Bit-Ort und kommt deshalb zuletzt.
for _protium_lib in \
	/usr/lib/x86_64-linux-gnu/libwayland-client.so.0 \
	/usr/lib64/libwayland-client.so.0 \
	/usr/lib/libwayland-client.so.0 \
	/usr/lib/x86_64-linux-gnu/libwayland-client.so \
	/usr/lib64/libwayland-client.so \
	/usr/lib/libwayland-client.so; do
	if [ -f "$_protium_lib" ]; then
		_protium_wayland_client="$_protium_lib"
		break
	fi
done

if [ -z "$_protium_wayland_client" ] && command -v ldconfig >/dev/null 2>&1; then
	_protium_wayland_client=$(ldconfig -p 2>/dev/null | awk '/libwayland-client\.so/ && !/i386|i686|lib32/ {print $NF; exit}') || _protium_wayland_client=""
	[ -f "$_protium_wayland_client" ] || _protium_wayland_client=""
fi

if [ -n "$_protium_wayland_client" ]; then
	export DESKTOPINTEGRATION=1
	export LD_PRELOAD="$_protium_wayland_client${LD_PRELOAD:+:$LD_PRELOAD}"
fi

unset _protium_lib
