# AppRun hook: system-libwayland-client.so vorladen, um EGL_BAD_PARAMETER
# unter Wayland zu verhindern. geladen von linuxdeploy's AppRun via "."
# (sourced, nicht executed, kein exit, kein shebang nötig aber schadet nicht).
#
# probing mehrerer distributionsüblicher pfade. keiner gefunden → no-op
# (X11-systeme oder systeme ohne wayland-client).

for lib in \
	/usr/lib/libwayland-client.so \
	/usr/lib64/libwayland-client.so \
	/usr/lib/x86_64-linux-gnu/libwayland-client.so; do
	if [ -f "$lib" ]; then
		export DESKTOPINTEGRATION=1
		export LD_PRELOAD="$lib${LD_PRELOAD:+:$LD_PRELOAD}"
		break
	fi
done
