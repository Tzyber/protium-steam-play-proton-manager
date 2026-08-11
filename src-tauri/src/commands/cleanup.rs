// ---- papierkorb-logik (remove_orphan_dir, remove_trash_entry, list_trash_entries) ----

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

use crate::commands::path::{
    canonicalize_no_symlink, canonicalize_safe, is_safe_path, sanitize_path,
};
use crate::commands::scope::{
    allow_library_scope_inner, library_of, parse_compat_id, suffix_after_steamapps,
};
use crate::commands::spawn_blocking_io;

/// name des papierkorb-verzeichnisses — existiert genau einmal hier, weil der
/// papierkorb in rust konstruiert wird (der webview-fs-scope erfasst
/// verzeichnisse mit führendem punkt nicht zuverlässig, s. list_trash_entries).
const TRASH_DIR_NAME: &str = ".protium-trash";

/// testbare validierungskette für den command-wrapper: sanitized input
/// (kein `..`, absolut) → symlink-guard auf roh-input → canonicalize →
/// library-derive. der symlink-guard auf roh-input ist nötig, weil
/// canonicalize symlinks folgt und der nachgelagerte symlink-check in
/// inner dann effektiv tot wäre. library wird hier einmal berechnet und
/// an inner weitergereicht (entfernt das doppelte `rfind` aus inner,
/// ohne die guard-reihenfolge zu verändern).
pub(super) fn validate_and_prepare(path_str: &str) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    sanitize_path(path_str, "remove_orphan_dir")?;
    // symlink-guard auf roh-input: ein orphan-eintrag, der selbst ein symlink
    // ist, ist nie ein legitimer löschkandidat (findOrphans skippt symlinks) —
    // siehe canonicalize_no_symlink für die begründung der reihenfolge.
    let canonical = canonicalize_no_symlink(path_str)?;
    let binding = canonical.to_string_lossy();
    let lib_str = library_of(&binding)?;
    Ok((std::path::PathBuf::from(lib_str), canonical))
}

/// reine lösch-logik: validierung (blocklist, symlink-defense-in-depth, is_dir,
/// muster, appid) + tatsächliches löschen/trash. `library` wird vom
/// command-wrapper durchgereicht (nicht erneut abgeleitet) — guard-reihenfolge
/// bleibt unverändert: erst sicherheit, dann parsing, dann delete.
pub(super) fn remove_orphan_dir_inner(
    canonical: &Path,
    library: &Path,
    scope_ok: &dyn Fn(&Path) -> bool,
) -> Result<String, String> {
    // scope-gate auf das library-root (nicht den zielpfad — der trash-pfad
    // liegt in einem punkt-verzeichnis, das der glob nicht erfasst). der
    // command prüft zusätzlich VOR dem scope-grant.
    if !scope_ok(library) {
        return Err("library outside allowed scope".into());
    }
    let canon_str = canonical.to_string_lossy();
    if !is_safe_path(&canon_str) {
        return Err("blocked path".into());
    }

    // symlink-guard bleibt als defense-in-depth: validate_and_prepare im
    // command-wrapper hat symlinks auf roh-input bereits abgewiesen, sodass
    // dieser check im normalen aufruf nie zuschlägt. er schützt direkte
    // inner-aufrufer (tests, zukünftige code-pfade) und kostet nichts.
    let meta = fs::symlink_metadata(canonical).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("symlink rejected — will not recurse".into());
    }
    if !meta.is_dir() {
        return Err("not a directory".into());
    }

    let suffix = suffix_after_steamapps(&canon_str)?;

    let (typ, app_id_str) = parse_compat_id(
        suffix
            .split_once('/')
            .ok_or_else(|| "invalid suffix structure".to_string())?,
    )?;

    match typ {
        "shadercache" => {
            // hard delete; trash-ordner wird NICHT angelegt (würde leer zurückbleiben)
            fs::remove_dir_all(canonical).map_err(|e| e.to_string())?;
            Ok("deleted".into())
        }
        "compatdata" => {
            let trash_dir = library.join("steamapps").join(TRASH_DIR_NAME);
            fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let trash_name = format!("compatdata_{app_id_str}_{ts}");
            let trash_target = trash_dir.join(&trash_name);
            fs::rename(canonical, &trash_target).map_err(|e| e.to_string())?;
            Ok(format!("trashed → {}", trash_target.display()))
        }
        _ => unreachable!(),
    }
}

pub(super) fn remove_trash_entry_inner(path: &str, scope_ok: &dyn Fn(&Path) -> bool) -> Result<String, String> {
    sanitize_path(&path, "remove_trash_entry")?;

    // canonicalize VOR allen weiteren prüfungen (sonst umgeht .. die
    // musterprüfung) — symlink-guard auf roh-input in canonicalize_no_symlink
    let canonical = canonicalize_no_symlink(&path)?;

    let meta = fs::symlink_metadata(&canonical).map_err(|e| e.to_string())?;
    // defense-in-depth: der roh-input-check oben hat symlinks bereits abgewiesen
    if meta.file_type().is_symlink() {
        return Err("symlink rejected — will not recurse".into());
    }
    if !meta.is_dir() {
        return Err("not a directory".into());
    }

    let canon_str = canonical.to_string_lossy();
    if !is_safe_path(&canon_str) {
        return Err("blocked path".into());
    }

    // scope-gate auf das library-root (nicht den trash-pfad — punkt-verzeichnis,
    // nicht vom glob erfasst). der papierkorb bleibt damit nur innerhalb
    // session-bestätigter libraries leerbar.
    let lib_str = library_of(&canon_str)?;
    if !scope_ok(Path::new(lib_str)) {
        return Err("library outside allowed scope".into());
    }

    let suffix = suffix_after_steamapps(&canon_str)?;

    // suffix muss exakt .protium-trash/<name> sein
    let (trash_marker, name) = suffix
        .split_once('/')
        .ok_or_else(|| "invalid suffix structure".to_string())?;

    if trash_marker != TRASH_DIR_NAME {
        return Err(format!(
            "expected .protium-trash, got: {trash_marker}"
        ));
    }

    if name.contains('/') {
        return Err("name must not contain '/'".into());
    }

    // name parsen: (compatdata|shadercache)_<appId>_<ms>
    let (rest, ms_str) = name
        .rsplit_once('_')
        .ok_or_else(|| "missing timestamp suffix".to_string())?;

    if ms_str.is_empty() || !ms_str.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("non-numeric timestamp: {ms_str}"));
    }

    parse_compat_id(
        rest.split_once('_')
            .ok_or_else(|| "missing type/appId separator".to_string())?,
    )?;

    fs::remove_dir_all(&canonical).map_err(|e| e.to_string())?;
    Ok("deleted".into())
}

/// ein verzeichniseintrag im papierkorb. is_symlink kommt aus file_type() des
/// read_dir-eintrags, folgt also KEINEM symlink.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// ergebnis von list_trash_entries. `present` unterscheidet "kein papierkorb
/// vorhanden" (normalfall, kein fehler) von einem lesefehler (Err).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashListing {
    /// kanonischer pfad des papierkorbs, den wir wirklich gelesen haben.
    /// das frontend baut eintragspfade daraus, statt selbst zu joinen —
    /// sonst driftet die anzeige bei symlinks vom echten ort ab.
    pub dir: String,
    pub present: bool,
    pub entries: Vec<TrashDirEntry>,
}

pub(super) fn list_trash_entries_inner(library: &str) -> Result<TrashListing, String> {
    let real = canonicalize_safe(library, "list_trash_entries")?;

    let trash_dir = real.join("steamapps").join(TRASH_DIR_NAME);
    let dir = trash_dir.to_string_lossy().into_owned();

    // symlink_metadata: ein symlink an dieser stelle wird nicht verfolgt
    let md = match fs::symlink_metadata(&trash_dir) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TrashListing { dir, present: false, entries: Vec::new() });
        }
        Err(e) => return Err(e.to_string()),
    };
    if md.file_type().is_symlink() {
        return Err("trash dir is a symlink — refusing to read".into());
    }
    if !md.is_dir() {
        return Err("trash path is not a directory".into());
    }

    let mut entries = Vec::new();
    for e in fs::read_dir(&trash_dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let ft = e.file_type().map_err(|e| e.to_string())?;
        entries.push(TrashDirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir: ft.is_dir(),
            is_symlink: ft.is_symlink(),
        });
    }

    Ok(TrashListing { dir, present: true, entries })
}

/// löscht ein verwaistes compatdata- oder shadercache-verzeichnis.
/// leitet library + typ selbst ab (defense-in-depth: backend traut frontend nicht).
/// compatdata → trash (rename), shadercache → hard delete.
/// async + spawn_blocking: remove_dir_all/rename auf GB-großen prefixes
/// darf den main-thread nicht blockieren.
#[tauri::command]
pub async fn remove_orphan_dir(app: AppHandle, path: String) -> Result<String, String> {
    let app2 = app.clone();
    spawn_blocking_io(move || {
        let (library, canonical) = validate_and_prepare(&path)?;
        // scope-gate VOR dem grant (S5): ohne diesen check würde der grant
        // unten das library-root selbst in den scope heben und der is_allowed-
        // check in inner wäre trivial true — löschung außerhalb bestätigter
        // libraries wäre möglich.
        if !app.fs_scope().is_allowed(&library) {
            return Err("library outside allowed scope".into());
        }
        allow_library_scope_inner(app, &library)?;
        remove_orphan_dir_inner(&canonical, &library, &|p| app2.fs_scope().is_allowed(p))
    })
    .await
}

/// löscht einen eintrag aus .protium-trash endgültig (kein zweiter papierkorb).
/// muster: `.protium-trash/(compatdata|shadercache)_<appId>_<ms>`.
/// keinerlei gates (kein steam-läuft, kein scope-check): der papierkorb ist
/// keine steam-datei, löschen kann nichts korrumpieren.
/// async + spawn_blocking (remove_dir_all auf GB-bäumen).
#[tauri::command]
pub async fn remove_trash_entry(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let app2 = app.clone();
    spawn_blocking_io(move || {
        remove_trash_entry_inner(&path, &|p| app2.fs_scope().is_allowed(p))
    })
    .await
}

/// listet `<library>/steamapps/.protium-trash`.
///
/// WARUM in rust und nicht per plugin-fs readDir im frontend: der fs-scope des
/// webviews wird über globs vergeben (`<library>/**`). ein verzeichnis mit
/// führendem punkt wird davon nicht zuverlässig erfasst, und das lesen des
/// papierkorbs schlug in externen libraries still fehl — die app zeigte einen
/// leeren papierkorb, obwohl vier prefixes darin lagen. rust hat keinen
/// webview-scope; dieselbe begründung wie bei dir_size und remove_trash_entry.
/// async + spawn_blocking (verzeichnis-read auf dem main-thread vermeiden).
#[tauri::command]
pub async fn list_trash_entries(library: String) -> Result<TrashListing, String> {
    spawn_blocking_io(move || list_trash_entries_inner(&library)).await
}

#[cfg(test)]
mod tests {
    use super::{remove_orphan_dir_inner, validate_and_prepare};
    use crate::commands::scope::library_of;
    use crate::commands::test_util::{orphan_fixture, touch, trash_fixture};
    use std::os::unix::fs as unixfs;

    // ---- remove_orphan_dir (T-H-01) ----
    // gehärtete logik via remove_orphan_dir_inner (extrahiert, AppHandle-frei)
    // + validate_and_prepare (wrapper-kette, AppHandle-frei).
    // tests nutzen temp-fixtures unter /tmp; keine berührung von /mnt o. ä.

    // helper: ruft inner mit korrekt abgeleiteter library auf, damit die
    // bestehenden tests nicht jeden library-pfad selbst berechnen müssen.
    fn call_inner(canonical: &std::path::Path) -> Result<String, String> {
        let lib = std::path::PathBuf::from(
            library_of(&canonical.to_string_lossy()).map_err(|e| e.to_string())?,
        );
        remove_orphan_dir_inner(canonical, &lib, &|_| true)
    }

    #[test]
    fn compatdata_orphan_wird_in_trash_verschoben() {
        let root = orphan_fixture("compat-trash");
        let lib = root.join("lib");
        let compat = lib.join("steamapps/compatdata/12345");
        touch(&compat);

        let canonical = std::fs::canonicalize(&compat).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_ok(), "sollte klappen: {res:?}");
        assert!(res.unwrap().contains("trashed"));
        assert!(!compat.exists(), "quelle muss weg sein");

        let trash = lib.join("steamapps/.protium-trash");
        assert!(trash.is_dir(), ".protium-trash muss angelegt sein");
        let entries: Vec<_> = std::fs::read_dir(&trash)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("compatdata_12345_")
            })
            .collect();
        assert_eq!(entries.len(), 1, "genau ein trash-eintrag für 12345");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shadercache_orphan_wird_hard_deleted() {
        let root = orphan_fixture("shadercache-del");
        let lib = root.join("lib");
        let cache = lib.join("steamapps/shadercache/67890");
        touch(&cache);

        let canonical = std::fs::canonicalize(&cache).unwrap();
        let res = call_inner(&canonical);
        assert_eq!(res.as_deref(), Ok("deleted"));
        assert!(!cache.exists(), "shadercache muss weg sein");

        // KEIN trash-eintrag (nur compatdata wird getrasht)
        let trash = lib.join("steamapps/.protium-trash");
        assert!(
            !trash.exists(),
            "shadercache darf keinen trash-ordner anlegen"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn symlink_als_ziel_wird_abgelehnt() {
        // defense-in-depth: der command-wrapper lehnt bereits in
        // validate_and_prepare ab, aber inner soll auch direkte aufrufer
        // schützen (z. b. tests, zukünftige code-pfade). canonicalize wurde
        // hier absichtlich übersprungen, damit symlink_metadata den symlink
        // selbst sieht (sonst folgt canonicalize und der guard wäre tot).
        let root = orphan_fixture("symlink");
        let lib = root.join("lib");
        let compat_dir = lib.join("steamapps/compatdata");
        std::fs::create_dir_all(&compat_dir).unwrap();
        let target = lib.join("steamapps/compatdata/22222");
        std::fs::create_dir_all(&target).unwrap();
        let link = compat_dir.join("99999");
        unixfs::symlink(&target, &link).unwrap();

        let lib_path = std::path::PathBuf::from(library_of(&link.to_string_lossy()).unwrap());
        let res = remove_orphan_dir_inner(&link, &lib_path, &|_| true);
        assert!(res.is_err(), "symlink muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("symlink"));
        assert!(link.exists(), "symlink selbst darf nicht angetastet werden");
        assert!(target.exists(), "ziel darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pfad_ohne_steamapps_anker_wird_abgelehnt() {
        let root = orphan_fixture("no-anchor");
        let random = root.join("lib/some/other/dir");
        touch(&random);

        let canonical = std::fs::canonicalize(&random).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "ohne /steamapps/ muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("/steamapps/"),
            "fehler soll den marker nennen: {:?}",
            res
        );
        assert!(random.exists(), "verzeichnis darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nichtnumerische_appid_wird_abgelehnt() {
        let root = orphan_fixture("nonnumeric");
        let lib = root.join("lib");
        let bad = lib.join("steamapps/compatdata/foo");
        touch(&bad);

        let canonical = std::fs::canonicalize(&bad).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "nicht-numerische appid muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("non-numeric"));
        assert!(bad.exists(), "quelle darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    // defense-in-depth: JS-seitiges findOrphans filtert appId 0 bereits, aber
    // ein direkter IPC-aufruf (oder zukünftiger code-pfad) darf nicht zum
    // löschen / trash-renamen eines 0-verzeichnisses führen. 0 ist in steam
    // reserviert (kein spiel) und darf nie ein löschkandidat sein.
    #[test]
    fn appid_zero_compatdata_wird_abgelehnt() {
        let root = orphan_fixture("zero-compat");
        let lib = root.join("lib");
        let compat = lib.join("steamapps/compatdata/0");
        touch(&compat);

        let canonical = std::fs::canonicalize(&compat).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "compatdata/0 muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("appId 0"),
            "fehlermeldung soll appId 0 nennen: {:?}",
            res
        );
        assert!(compat.exists(), "compatdata/0 darf nicht gelöscht werden");
        let trash = lib.join("steamapps/.protium-trash");
        assert!(
            !trash.exists(),
            ".protium-trash darf für appId 0 NICHT angelegt werden"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn appid_zero_shadercache_wird_abgelehnt() {
        let root = orphan_fixture("zero-shader");
        let lib = root.join("lib");
        let cache = lib.join("steamapps/shadercache/0");
        touch(&cache);

        let canonical = std::fs::canonicalize(&cache).unwrap();
        let res = call_inner(&canonical);
        assert!(res.is_err(), "shadercache/0 muss abgelehnt werden");
        assert!(
            res.as_ref().unwrap_err().contains("appId 0"),
            "fehlermeldung soll appId 0 nennen: {:?}",
            res
        );
        assert!(cache.exists(), "shadercache/0 darf nicht gelöscht werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn doppelter_steamapps_anker_bleibt_innerhalb_des_scopes() {
        // /tmp/.../lib/steamapps/compatdata/123/steamapps/compatdata/456
        // rfind("/steamapps/") findet den letzten anker → library wird zu
        // /tmp/.../lib/steamapps/compatdata/123. das ist INNERHALB des inputs.
        // akzeptiert: erfolgreich (in trash) ODER reject.
        // nicht akzeptabel: ein delete der outer (lib/steamapps/compatdata/123) zerstört.
        let root = orphan_fixture("double-anchor");
        let lib = root.join("lib");
        let outer = lib.join("steamapps/compatdata/123");
        let inner = outer.join("steamapps/compatdata/456");
        touch(&inner);
        // marker in outer, um zu prüfen dass outer nicht gelöscht wird
        std::fs::write(outer.join("keep"), b"important").unwrap();

        let canonical = std::fs::canonicalize(&inner).unwrap();
        let res = call_inner(&canonical);

        // outer (lib + steamapps + compatdata/123) muss IMMER noch existieren
        assert!(outer.exists(), "outer darf nicht gelöscht werden");
        assert!(outer.join("keep").exists(), "marker in outer muss bleiben");
        assert!(lib.exists(), "library-root muss bleiben");
        assert!(lib.join("steamapps").exists(), "steamapps muss bleiben");

        match res {
            Ok(msg) => {
                assert!(msg.contains("trashed"));
                assert!(!inner.exists());
            }
            Err(_) => {
                // reject ist auch ok, solange nichts zerstört wurde
                assert!(inner.exists(), "bei reject: inner muss noch da sein");
            }
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    // validate_and_prepare: testbare wrapper-kette (sanitize + symlink-guard
    // auf roh-input + canonicalize + library-derive). symlink-guard auf dem
    // nicht-kanonisierten input ist nötig, weil canonicalize symlinks folgt
    // und der nachgelagerte symlink-check in inner dann effektiv tot wäre.
    #[test]
    fn validate_and_prepare_lehnt_symlink_auf_roh_input_ab() {
        let root = orphan_fixture("raw-symlink");
        let lib = root.join("lib");
        let compat_dir = lib.join("steamapps/compatdata");
        std::fs::create_dir_all(&compat_dir).unwrap();
        let target = lib.join("steamapps/compatdata/22222");
        std::fs::create_dir_all(&target).unwrap();
        let link = compat_dir.join("99999");
        unixfs::symlink(&target, &link).unwrap();

        let res = validate_and_prepare(link.to_str().unwrap());
        assert!(res.is_err(), "symlink auf roh-input muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("symlink"));
        assert!(link.exists(), "symlink selbst darf nicht angetastet werden");
        assert!(target.exists(), "ziel darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- remove_trash_entry ----
    // selbes tempdir-muster wie remove_orphan_dir.
    // tests prüfen remove_trash_entry_inner — die komplette validierungs- und
    // löschkette (der async-command darüber ist nur spawn_blocking).

    use super::remove_trash_entry_inner;

    #[test]
    fn gueltiger_eintrag_wird_geloescht() {
        let root = trash_fixture("valid");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let entry = trash.join("compatdata_1091500_1753372800123");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::write(entry.join("marker"), b"x").unwrap();

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| true);
        assert_eq!(res.as_deref(), Ok("deleted"));
        assert!(!entry.exists(), "eintrag muss gelöscht sein");
        // trash-verzeichnis selbst darf stehen bleiben (enthält evtl. andere einträge)
        assert!(trash.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pfad_mit_dotdot_wird_abgelehnt() {
        let root = trash_fixture("dotdot");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let entry = trash.join("compatdata_1_2");
        std::fs::create_dir_all(&entry).unwrap();

        // konstruiere einen pfad mit .., der auf den eintrag zeigt
        let tricky = trash.join("../.protium-trash/compatdata_1_2");
        let res = remove_trash_entry_inner(&tricky.to_string_lossy(), &|_| true);
        assert!(res.is_err(), ".. muss abgelehnt werden");
        assert!(entry.exists(), "ziel darf nicht gelöscht worden sein");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn symlink_statt_verzeichnis_wird_abgelehnt() {
        let root = trash_fixture("symlink");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        std::fs::create_dir_all(&trash).unwrap();
        let target = lib.join("steamapps/compatdata");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(target.join("42")).unwrap();
        let link = trash.join("compatdata_42_100");
        unixfs::symlink(&target.join("42"), &link).unwrap();

        let res = remove_trash_entry_inner(&link.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "symlink muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("symlink"));
        assert!(link.exists(), "symlink selbst darf nicht angetastet werden");
        assert!(target.join("42").exists(), "ziel darf nicht angetastet werden");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn eintrag_ausserhalb_protium_trash_wird_abgelehnt() {
        let root = trash_fixture("outside");
        let lib = root.join("lib");
        let dir = lib.join("steamapps/compatdata/42");
        std::fs::create_dir_all(&dir).unwrap();

        let res = remove_trash_entry_inner(&dir.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "pfad nicht in .protium-trash muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains(".protium-trash"));
        assert!(dir.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn name_ohne_timestamp_wird_abgelehnt() {
        let root = trash_fixture("no-ts");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let entry = trash.join("compatdata_1091500");
        std::fs::create_dir_all(&entry).unwrap();

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "ohne timestamp muss abgelehnt werden");
        assert!(entry.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn appid_zero_wird_abgelehnt() {
        let root = trash_fixture("zero");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let entry = trash.join("compatdata_0_123");
        std::fs::create_dir_all(&entry).unwrap();

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "appId 0 muss abgelehnt werden");
        assert!(res.as_ref().unwrap_err().contains("appId 0"));
        assert!(entry.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tiefer_pfad_mit_zweitem_slash_wird_abgelehnt() {
        let root = trash_fixture("deep");
        let lib = root.join("lib");
        let trash = lib.join("steamapps/.protium-trash");
        let deep = trash.join("compatdata_1_2/pfx");
        std::fs::create_dir_all(&deep).unwrap();

        let res = remove_trash_entry_inner(&deep.to_string_lossy(), &|_| true);
        assert!(res.is_err(), "tiefer pfad mit / muss abgelehnt werden");
        assert!(deep.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn steamapps_im_library_namen_rfind_nimmt_letztes_vorkommen() {
        let root = trash_fixture("rfind");
        // /tmp/.../lib/steamapps-alt/steamapps/.protium-trash/compatdata_1_2
        let lib = root.join("lib");
        let nested = lib.join("steamapps-alt/steamapps/.protium-trash");
        let entry = nested.join("compatdata_1_2");
        std::fs::create_dir_all(&entry).unwrap();

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| true);
        assert!(res.is_ok(), "rfind muss das letzte /steamapps/ nehmen: {res:?}");
        assert!(!entry.exists(), "eintrag muss gelöscht sein");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- lösch-scope-gates (S5: nur session-bestätigte libraries) ----

    #[test]
    fn remove_orphan_unscoped_library_abgelehnt() {
        let root = orphan_fixture("orphan-noscope");
        let lib = root.join("lib");
        let target = lib.join("steamapps").join("shadercache").join("12345");
        touch(&target);

        let canonical = std::fs::canonicalize(&target).unwrap();
        let res = remove_orphan_dir_inner(&canonical, &lib, &|_| false);
        assert!(res.is_err(), "unscoped library muss abgelehnt werden: {res:?}");
        assert!(
            res.unwrap_err().contains("outside allowed scope"),
            "fehlermeldung soll scope nennen"
        );
        assert!(target.join("marker").is_file(), "nichts darf gelöscht sein");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_trash_unscoped_library_abgelehnt() {
        let root = orphan_fixture("trash-noscope");
        let lib = root.join("lib");
        let entry = lib
            .join("steamapps")
            .join(".protium-trash")
            .join("compatdata_12345_1700000000000");
        touch(&entry);

        let res = remove_trash_entry_inner(&entry.to_string_lossy(), &|_| false);
        assert!(res.is_err(), "unscoped library muss abgelehnt werden: {res:?}");
        assert!(
            res.unwrap_err().contains("outside allowed scope"),
            "fehlermeldung soll scope nennen"
        );
        assert!(entry.join("marker").is_file(), "nichts darf gelöscht sein");

        let _ = std::fs::remove_dir_all(&root);
    }
}
