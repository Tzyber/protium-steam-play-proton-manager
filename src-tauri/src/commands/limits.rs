// gemeinsame obergrenzen der commands (P12b1): eine zahl für jede aufzählung,
// die ein angreifer mit leerem inhalt aufblähen kann (walk, papierkorb,
// archiv), und ein eigener entpack-cap.

/// eintrags-cap für walk, papierkorb-listing und archiv. echte GE-Proton-builds
/// haben rund 9 000 einträge (GE-Proton11-6/11-7 gezählt), 100 000 lässt >10×
/// luft; ein eintrag der größe 0 umgeht jeden byte-cap, erst die eintragszahl
/// stoppt eine inode- oder metadatenbombe.
pub(crate) const MAX_ENTRIES: usize = 100_000;

/// eigener entpack-cap (6.9): ein legitimes GE-Archiv liegt entpackt bei rund
/// 2 GB, 4 GiB lässt luft und bleibt weit unter dem download-cap. Der
/// download-cap (8 GiB) deckelt die datei auf der platte, nicht die entpackten
/// bytes.
pub(crate) const MAX_UNPACK_BYTES: u64 = 4 * 1024 * 1024 * 1024;

// Restrisiko 6.10 (IPC-rohgröße): ein Tauri-command sieht den request erst
// nach der deserialisierung, ein 200-MB-payload wird also vollständig
// allokiert, bevor eine längenprüfung greifen kann. Ohne IPC-hook auf seiten
// Tauris ist das nicht begrenzbar; hier steht deshalb bewusst kein fake-cap,
// der eine grenze nur behaupten würde. Erreichbar nur mit kompromittierter
// webview (self-DoS).
