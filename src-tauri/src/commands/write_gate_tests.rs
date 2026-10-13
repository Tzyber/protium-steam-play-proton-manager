use super::*;
use crate::commands::test_util::{production_source, wsg_env, wsg_fixture};

#[test]
fn write_gate_bleibt_crash_durable_gesichert() {
    // statischer schutz: die dokumentierte write-gate-garantie (atomarer
    // rename PLUS durable inhalte) darf nicht still auf temp+rename
    // ohne fsync zurückfallen. seit N1 muss die sequenz zusätzlich
    // descriptorgebunden sein: keine pfadbasierten operationen mehr.
    // das gate lebt in write_gate.rs, die aufrufer in steam.rs; die
    // einmaligkeitsprüfungen laufen über beide, damit eine kopie in einem
    // aufrufer nicht unbemerkt bleibt.
    let production = [
        production_source(include_str!("write_gate.rs")),
        production_source(include_str!("steam.rs")),
    ]
    .concat();
    let persist_body = production
        .split("fn persist_atomic_with_ops")
        .nth(1)
        .expect("persist_atomic_with_ops must exist in production source")
        .split("fn persist_atomic<")
        .next()
        .expect("persist_atomic_with_ops must be defined before persist_atomic");

    let tmp_sync = persist_body.find("(ops.sync_file)(&mut file)");
    let check = persist_body.find("(ops.before_rename)()");
    let rename = persist_body.find("(ops.rename)(dir_fd, tmp_name, dir_fd, target_name)");
    assert!(
        tmp_sync.is_some() && check.is_some() && rename.is_some(),
        "temp-sync, letzte prüfung und rename müssen vorhanden sein"
    );
    assert!(
        tmp_sync.unwrap() < rename.unwrap(),
        "temp-sync muss vor dem rename laufen"
    );
    assert!(
        check.unwrap() < rename.unwrap(),
        "die letzte prüfung muss unmittelbar vor dem rename laufen"
    );
    assert!(
        persist_body.contains("(ops.sync_parent)(dir_fd)"),
        "parent-fsync muss über den gebundenen deskriptor laufen"
    );
    assert!(
        persist_body.contains("fd::create_exclusive_at") && persist_body.contains("fd::unlink_at"),
        "temp-anlage und aufräumen müssen über die deskriptor-helfer laufen"
    );
    for verboten in ["fs::File::create", "fs::rename", "fs::remove_file"] {
        assert!(
            !persist_body.contains(verboten),
            "pfadbasierte operation im persist-pfad: {verboten}"
        );
    }
    // beide write-pfade laufen durch die gemeinsame pipeline (R-04), die die
    // persist-sequenz genau einmal enthält
    assert_eq!(
        production
            .matches("persist_atomic(canon, patched.as_bytes(), process_reader)")
            .count(),
        1,
        "die persist-sequenz darf nur einmal im quelltext stehen"
    );
    // backup ist ebenfalls sync_alled (darf den stromausfall nicht als leere kopie überleben)
    assert!(
        production.contains("and_then(|()| file.sync_all())"),
        "backup-write muss sync_all enthalten"
    );
    assert!(
        production.contains("sync_directory(dir_fd.as_raw_fd())"),
        "backup-directory-entry muss über den gebundenen descriptor synchronisiert werden"
    );
    assert!(
        production.contains("let mut sync_directory = sync_dir_fd"),
        "produktiver backup-pfad muss den echten descriptor-fsync verwenden"
    );
    // die deskriptor-helfer selbst liegen in fd.rs; neu angelegte verzeichnisse
    // syncen ihren parent, und der directory-fsync ist kein follow-open
    let fd_source = include_str!("fd.rs");
    assert!(
        fd_source.contains("sync_dir_fd(parent_fd)"),
        "neu angelegte verzeichnisse müssen ihren parent synchronisieren"
    );
    assert!(
        fd_source.contains("libc::fsync(fd)"),
        "directory-fsync darf nicht auf einem pfad-basierten follow-open beruhen"
    );
    let backup_call = production
        .find("write_backup_no_follow(&backup_rel, backup_dir, &original)?;")
        .expect("backup muss vor dem target-write abgeschlossen werden");
    let target_call = production
        .find("let write_result = persist_atomic(canon, patched.as_bytes(), process_reader);")
        .expect("target-write muss im write-gate vorhanden sein");
    assert!(
        backup_call < target_call,
        "ein backup-fehler darf keinen nachfolgenden target-write erreichen"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn persist_atomic_temp_sync_fehler_laesst_ziel_unveraendert_und_raeumt_temp() {
    let root = wsg_fixture("persist-temp-sync-error");
    let target = root.join("config.vdf");
    let tmp_name = OsStr::new(".config.vdf.tmp");
    std::fs::write(&target, "alt").unwrap();
    let dir = open_absolute_dir(&root).unwrap();

    let mut sync_file =
        |_file: &mut std::fs::File| Err(std::io::Error::other("injected temp sync failure"));
    let mut before_rename =
        || -> Result<(), String> { panic!("prüfung darf vor temp-sync nicht erreicht werden") };
    let mut rename = |_from_dir: RawFd, _from: &OsStr, _to_dir: RawFd, _to: &OsStr| {
        panic!("rename darf vor temp-sync nicht erreicht werden")
    };
    let mut sync_parent = |_fd: RawFd| panic!("parent-sync darf vor rename nicht erreicht werden");

    let error = persist_atomic_with_ops(
        dir.as_raw_fd(),
        tmp_name,
        OsStr::new("config.vdf"),
        b"neu",
        &mut PersistOps {
            sync_file: &mut sync_file,
            before_rename: &mut before_rename,
            rename: &mut rename,
            sync_parent: &mut sync_parent,
        },
    )
    .unwrap_err();

    assert!(
        errcode::has_code(&error.to_string(), errcode::UNREADABLE),
        "unexpected error: {error}"
    );
    assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
    assert!(!root.join(tmp_name).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn persist_atomic_rename_fehler_laesst_ziel_unveraendert_und_raeumt_temp() {
    let root = wsg_fixture("persist-rename-error");
    let target = root.join("config.vdf");
    let tmp_name = OsStr::new(".config.vdf.tmp");
    std::fs::write(&target, "alt").unwrap();
    let dir = open_absolute_dir(&root).unwrap();

    let mut sync_file = |file: &mut std::fs::File| file.sync_all();
    let mut before_rename = || -> Result<(), String> { Ok(()) };
    let mut rename = |_from_dir: RawFd, _from: &OsStr, _to_dir: RawFd, _to: &OsStr| {
        Err(std::io::Error::other("injected rename failure"))
    };
    let mut sync_parent =
        |_fd: RawFd| panic!("parent-sync darf nach fehlgeschlagenem rename nicht erreicht werden");

    let error = persist_atomic_with_ops(
        dir.as_raw_fd(),
        tmp_name,
        OsStr::new("config.vdf"),
        b"neu",
        &mut PersistOps {
            sync_file: &mut sync_file,
            before_rename: &mut before_rename,
            rename: &mut rename,
            sync_parent: &mut sync_parent,
        },
    )
    .unwrap_err();

    assert!(
        errcode::has_code(&error.to_string(), errcode::UNREADABLE),
        "unexpected error: {error}"
    );
    assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
    assert!(!root.join(tmp_name).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn persist_atomic_parent_sync_fehler_signalisiert_moegliche_mutation() {
    let root = wsg_fixture("persist-parent-sync-error");
    let target = root.join("config.vdf");
    let tmp_name = OsStr::new(".config.vdf.tmp");
    std::fs::write(&target, "alt").unwrap();
    let dir = open_absolute_dir(&root).unwrap();

    let mut sync_file = |file: &mut std::fs::File| file.sync_all();
    let mut before_rename = || -> Result<(), String> { Ok(()) };
    let mut rename = |from_dir: RawFd, from: &OsStr, to_dir: RawFd, to: &OsStr| {
        fd::rename_at(from_dir, from, to_dir, to)
    };
    let mut sync_parent = |_fd: RawFd| Err(std::io::Error::other("injected parent sync failure"));

    let error = persist_atomic_with_ops(
        dir.as_raw_fd(),
        tmp_name,
        OsStr::new("config.vdf"),
        b"neu",
        &mut PersistOps {
            sync_file: &mut sync_file,
            before_rename: &mut before_rename,
            rename: &mut rename,
            sync_parent: &mut sync_parent,
        },
    )
    .unwrap_err();

    assert!(matches!(error, PersistAtomicError::AfterRename(_)));
    // Der Code muss durchkommen, sonst zeigt die Oberflaeche "nichts veraendert".
    assert!(
        error.to_string().starts_with("write-may-have-applied"),
        "unexpected error: {error}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "neu");
    assert!(!root.join(tmp_name).exists());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_folgt_keinem_vorbereiteten_temp_symlink() {
    // N1: der Temp-pfad ist vorhersagbar genug, um ihn vorzubereiten. O_EXCL
    // verhindert das folgen und damit das truncaten einer fremddatei.
    let root = wsg_fixture("persist-temp-symlink");
    let target = root.join("config.vdf");
    let victim = root.join("opfer.vdf");
    std::fs::write(&target, "alt").unwrap();
    std::fs::write(&victim, "opfer").unwrap();
    let link_parent = root.clone();
    PERSIST_TEMP_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |tmp_name: &OsStr| {
            std::os::unix::fs::symlink("opfer.vdf", link_parent.join(tmp_name)).unwrap();
        }));
    });
    let mut reader = || Ok(false);
    let error = persist_atomic(&target, b"neu", &mut reader).unwrap_err();
    PERSIST_TEMP_PROBE.with(|slot| *slot.borrow_mut() = None);

    assert!(
        errcode::has_code(&error.to_string(), errcode::UNREADABLE),
        "unexpected error: {error}"
    );
    assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "opfer");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
    // ziel, opferdatei und der fremde symlink bleiben liegen: einen eintrag,
    // den dieser vorgang nicht angelegt hat, räumt er auch nicht weg
    let entries: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap())
        .collect();
    assert_eq!(entries.len(), 3);
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.file_type().unwrap().is_symlink())
            .count(),
        1,
        "der vorbereitete symlink bleibt unangetastet liegen"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_meldet_parent_tausch_ohne_fremdmutation() {
    // N1: der Parent wird im Bindefenster zwischen Stat und Open getauscht.
    // Die Identitätsprüfung plus O_NOFOLLOW muss fail-closed enden.
    let root = wsg_fixture("persist-parent-swap");
    let parent = root.join("steamdata");
    std::fs::create_dir_all(&parent).unwrap();
    let target = parent.join("config.vdf");
    std::fs::write(&target, "alt").unwrap();
    let moved = root.join("echt");
    let fremd = root.join("fremd");
    std::fs::create_dir_all(&fremd).unwrap();
    std::fs::write(fremd.join("config.vdf"), "fremd").unwrap();

    let (swap_parent, swap_moved, swap_fremd) = (parent.clone(), moved.clone(), fremd.clone());
    PERSIST_BIND_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&swap_parent, &swap_moved).unwrap();
            std::os::unix::fs::symlink(&swap_fremd, &swap_parent).unwrap();
        }));
    });
    let mut reader = || Ok(false);
    let error = persist_atomic(&target, b"neu", &mut reader).unwrap_err();
    PERSIST_BIND_PROBE.with(|slot| *slot.borrow_mut() = None);

    assert!(matches!(error, PersistAtomicError::BeforeRename(_)));
    assert_eq!(
        std::fs::read_to_string(fremd.join("config.vdf")).unwrap(),
        "fremd",
        "das fremde verzeichnis darf nicht beschrieben werden"
    );
    assert_eq!(
        std::fs::read_to_string(moved.join("config.vdf")).unwrap(),
        "alt"
    );
    assert_eq!(
        std::fs::read_dir(&moved).unwrap().count(),
        1,
        "im echten verzeichnis darf kein temp-rest liegen bleiben"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_meldet_einen_parent_tausch_gegen_ein_echtes_verzeichnis() {
    // Der Symlink-Fall wird schon von O_NOFOLLOW abgewiesen. Hier wird der
    // Parent gegen ein ECHTES anderes Verzeichnis getauscht, damit die
    // dev/ino-Prüfung selbst greift (nur so ist sie gedeckt).
    let root = wsg_fixture("persist-parent-swap-real");
    let parent = root.join("steamdata");
    std::fs::create_dir_all(&parent).unwrap();
    let target = parent.join("config.vdf");
    std::fs::write(&target, "alt").unwrap();
    let moved = root.join("echt");
    let fremd = root.join("fremd");
    std::fs::create_dir_all(&fremd).unwrap();
    std::fs::write(fremd.join("config.vdf"), "fremd").unwrap();

    let (swap_parent, swap_moved, swap_fremd) = (parent.clone(), moved.clone(), fremd.clone());
    PERSIST_BIND_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&swap_parent, &swap_moved).unwrap();
            std::fs::rename(&swap_fremd, &swap_parent).unwrap();
        }));
    });
    let mut reader = || Ok(false);
    let error = persist_atomic(&target, b"neu", &mut reader).unwrap_err();
    PERSIST_BIND_PROBE.with(|slot| *slot.borrow_mut() = None);

    assert!(
        error
            .to_string()
            .contains("changed while opening descriptor"),
        "unexpected error: {error}"
    );
    // nach dem tausch liegt das untergeschobene verzeichnis unter dem
    // originalnamen des parents; es darf nicht beschrieben worden sein
    assert_eq!(
        std::fs::read_to_string(parent.join("config.vdf")).unwrap(),
        "fremd",
        "das untergeschobene verzeichnis darf nicht beschrieben werden"
    );
    assert_eq!(
        std::fs::read_to_string(moved.join("config.vdf")).unwrap(),
        "alt"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_ersetzt_einen_zwischendurch_gesetzten_ziel_symlink_ohne_zu_folgen() {
    // N1: das Ziel wird unmittelbar vor dem Rename durch einen Symlink auf eine
    // fremddatei ersetzt. rename ersetzt den link selbst und folgt ihm nicht.
    let root = wsg_fixture("persist-target-symlink");
    let target = root.join("config.vdf");
    let victim = root.join("opfer.vdf");
    std::fs::write(&target, "alt").unwrap();
    std::fs::write(&victim, "opfer").unwrap();
    let (link_parent, link_target) = (root.clone(), target.clone());
    PERSIST_RENAME_PROBE.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            std::fs::remove_file(&link_target).unwrap();
            std::os::unix::fs::symlink("opfer.vdf", link_parent.join("config.vdf")).unwrap();
        }));
    });
    let mut reader = || Ok(false);
    let result = persist_atomic(&target, b"neu", &mut reader);
    PERSIST_RENAME_PROBE.with(|slot| *slot.borrow_mut() = None);

    assert!(result.is_ok(), "rename muss den link selbst ersetzen");
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "opfer",
        "die verlinkte fremddatei darf unberührt bleiben"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "neu");
    assert!(!std::fs::symlink_metadata(&target).unwrap().is_symlink());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_bricht_vor_dem_rename_ab_wenn_steam_startet() {
    // N2: der letzte check liegt unmittelbar vor der irreversiblen mutation.
    let root = wsg_fixture("persist-steam-start");
    let target = root.join("config.vdf");
    std::fs::write(&target, "alt").unwrap();

    let mut reader = || Ok(true);
    let error = persist_atomic(&target, b"neu", &mut reader).unwrap_err();

    assert_eq!(error.to_string(), "steam-running");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alt");
    assert_eq!(
        std::fs::read_dir(&root).unwrap().count(),
        1,
        "nach dem abbruch darf kein temp-rest liegen bleiben"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_backup_directory_sync_fehler_raeumt_backup_auf() {
    let root = wsg_fixture("backup-directory-sync-error");
    let backup_dir = root.join("cache");
    let backup_path = backup_dir.join("backups/original.vdf");
    let target = root.join("steam-config.vdf");
    std::fs::create_dir_all(&backup_dir).unwrap();
    std::fs::write(&target, "ziel-unveraendert").unwrap();

    let mut sync_calls = 0;
    let mut sync_directory = |_fd: RawFd| {
        sync_calls += 1;
        if sync_calls == 1 {
            Err(std::io::Error::other(
                "injected backup directory sync failure",
            ))
        } else {
            Ok(())
        }
    };
    let error = write_backup_no_follow_with_sync(
        Path::new("backups/original.vdf"),
        &backup_dir,
        "backup-inhalt",
        &mut sync_directory,
    )
    .unwrap_err();

    assert!(error.contains("backup directory sync"));
    assert_eq!(
        sync_calls, 2,
        "cleanup muss den directory-entry erneut syncen"
    );
    assert!(!backup_path.exists());
    assert!(
        std::fs::read_dir(backup_path.parent().unwrap())
            .unwrap()
            .next()
            .is_none(),
        "nach einem backup-fsync-fehler darf kein backup-rest liegenbleiben"
    );
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "ziel-unveraendert"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn write_gate_backup_zwischenpfad_symlink_abgelehnt_ohne_zielveraenderung() {
    let (home, cache, steam) = wsg_env("backup-intermediate-symlink");
    let target = steam.join("config/config.vdf");
    let external_dir = home.parent().unwrap().join("externes-backup-dir");
    let external_file = external_dir.join("1.vdf");
    std::fs::create_dir_all(&external_dir).unwrap();
    std::fs::write(&external_file, "extern-unveraendert").unwrap();

    let backup_parent = cache.join("backups");
    let backup = backup_parent.join("1.vdf");
    std::fs::create_dir_all(&backup_parent).unwrap();
    std::fs::remove_dir(&backup_parent).unwrap();
    std::os::unix::fs::symlink(&external_dir, &backup_parent).unwrap();

    let relative = backup.strip_prefix(&cache).unwrap();
    let res = write_backup_no_follow(relative, &cache, "neu");

    assert!(
        res.is_err(),
        "zwischenpfad-symlink muss abgelehnt werden: {res:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&external_file).unwrap(),
        "extern-unveraendert"
    );
    assert!(std::fs::read_to_string(&target)
        .unwrap()
        .contains("GE-Proton9-27"));
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn write_gate_backup_root_swap_auf_symlink_abgelehnt_ohne_zielveraenderung() {
    let (home, cache, steam) = wsg_env("backup-root-swap");
    let target = steam.join("config/config.vdf");
    let external_dir = home.parent().unwrap().join("externes-backup-root");
    let external_file = external_dir.join("1.vdf");
    std::fs::create_dir_all(&external_dir).unwrap();
    std::fs::write(&external_file, "extern-unveraendert").unwrap();

    let backup_parent = cache.join("backups");
    let backup = backup_parent.join("1.vdf");
    std::fs::create_dir_all(&backup_parent).unwrap();
    std::fs::remove_dir_all(&cache).unwrap();
    std::os::unix::fs::symlink(&external_dir, &cache).unwrap();

    let relative = backup.strip_prefix(&cache).unwrap();
    let res = write_backup_no_follow(relative, &cache, "neu");

    assert!(
        res.is_err(),
        "geswapte backup-root symlink muss abgelehnt werden: {res:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&external_file).unwrap(),
        "extern-unveraendert"
    );
    assert!(std::fs::read_to_string(&target)
        .unwrap()
        .contains("GE-Proton9-27"));
    let _ = std::fs::remove_file(&cache);
    let _ = std::fs::remove_dir_all(home.parent().unwrap());
}

#[test]
fn write_gate_erkennt_nur_config_dateien_unter_dem_root() {
    let root = wsg_fixture("muster");
    let steam = root.join("Steam");
    let flatpak = root.join("flatpak-steam");
    assert!(is_steam_config_path(
        &steam.join("config/config.vdf"),
        &steam
    ));
    assert!(is_steam_config_path(
        &steam.join("userdata/123/config/localconfig.vdf"),
        &steam
    ));
    assert!(is_steam_config_path(
        &flatpak.join("config/config.vdf"),
        &flatpak
    ));
    assert!(!is_steam_config_path(
        &flatpak.join("config/config.vdf"),
        &steam
    ));
    assert!(!is_steam_config_path(&steam.join("etc/evil"), &steam));
    assert!(!is_steam_config_path(
        &steam.join("userdata/abc/config/localconfig.vdf"),
        &steam
    ));
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn write_gate_akzeptiert_kanonisierten_steam_symlink_alias() {
    use std::os::unix::fs::symlink;

    let root = wsg_fixture("symlink-alias");
    let home = root.join("fakehome");
    let native_root = home.join(".local/share/Steam");
    let config = native_root.join("config/config.vdf");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "\"InstallConfigStore\" {}\n").unwrap();
    std::fs::create_dir_all(home.join(".steam")).unwrap();
    let alias = home.join(".steam/steam");
    symlink(&native_root, &alias).unwrap();

    let canonical = std::fs::canonicalize(alias.join("config/config.vdf")).unwrap();
    let allowed = std::fs::canonicalize(&native_root).unwrap();
    assert!(is_steam_config_path(&canonical, &allowed));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn write_lock_for_target_teilt_pro_pfad_und_trennt_pfade() {
    let root = wsg_fixture("write-lock-registry");
    let first = write_lock_for_target(&root.join("a.vdf"));
    let second = write_lock_for_target(&root.join("a.vdf"));
    let other = write_lock_for_target(&root.join("b.vdf"));

    assert!(
        std::ptr::eq(first, second),
        "gleicher pfad muss dieselbe sperre treffen"
    );
    assert!(
        !std::ptr::eq(first, other),
        "verschiedene pfade brauchen getrennte sperren"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn write_lock_blockiert_bis_der_guard_faellt() {
    let root = wsg_fixture("write-lock-guard");
    let canon = root.join("config.vdf");
    let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let guard = lock_write_target(&canon);
    let waiter_canon = canon.clone();
    let waiter_entered = entered.clone();
    // handshake statt sleep: der waiter meldet, dass er den lock anfordert,
    // erst danach ist `!entered` aussagekräftig.
    let (asking_tx, asking_rx) = std::sync::mpsc::channel::<()>();
    let waiter = std::thread::spawn(move || {
        asking_tx.send(()).unwrap();
        let _guard = lock_write_target(&waiter_canon);
        waiter_entered.store(true, std::sync::atomic::Ordering::SeqCst);
    });

    asking_rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("der waiter muss den lock anfordern");
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(
        !entered.load(std::sync::atomic::Ordering::SeqCst),
        "der wartende thread darf erst nach dem drop weiterlaufen"
    );
    drop(guard);
    waiter.join().unwrap();
    assert!(
        entered.load(std::sync::atomic::Ordering::SeqCst),
        "nach dem drop muss die sperre frei sein"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn backup_stempel_steigen_streng_auch_in_derselben_millisekunde() {
    let stamps: Vec<u128> = (0..64).map(|_| next_backup_timestamp()).collect();
    assert!(
        stamps.windows(2).all(|pair| pair[0] < pair[1]),
        "{stamps:?}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn config_read_folgt_keinem_vorbereiteten_symlink() {
    // r-01: im fenster zwischen pfadprüfung und read kann die config gegen
    // einen symlink getauscht werden. der read darf ihm nicht folgen: fremder
    // inhalt darf weder gelesen noch ins backup gelangen.
    let root = wsg_fixture("config-read-symlink");
    let dir = root.join("userdata/123/config");
    std::fs::create_dir_all(&dir).unwrap();
    let victim = root.join("opfer.vdf");
    std::fs::write(&victim, "fremder inhalt").unwrap();
    let link = dir.join("localconfig.vdf");
    std::os::unix::fs::symlink(&victim, &link).unwrap();

    let error = read_config_text_bounded(&link, "read target").unwrap_err();

    assert!(error.contains("read target"), "unexpected error: {error}");
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "fremder inhalt",
        "die verlinkte fremddatei darf nicht angetastet werden"
    );
    // gegenprobe: die echte datei bleibt über dieselbe funktion lesbar
    let real = dir.join("localconfig-echt.vdf");
    std::fs::write(&real, "\"UserLocalConfigStore\"").unwrap();
    assert_eq!(
        read_config_text_bounded(&real, "read target").unwrap(),
        "\"UserLocalConfigStore\""
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn config_read_ist_an_den_gebundenen_parent_angebunden() {
    // r-01: statischer beleg: der linux-config-read öffnet die datei per
    // O_NOFOLLOW aus einem gebundenen parent und nicht mehr pfadbasiert. der
    // genaue tauschzeitpunkt im fenster ist ohne injektionshaken nicht
    // belegbar (prüflücke), der direkte symlink-fall darüber deckt die
    // no-follow-kette ab.
    let production = production_source(include_str!("write_gate.rs"));
    let linux_read = production
        .split("fn read_config_text_bounded")
        .nth(1)
        .expect("read_config_text_bounded muss vorhanden sein")
        .split("#[cfg(not(target_os = \"linux\"))]")
        .next()
        .expect("nicht-linux-variante muss markiert sein");
    assert!(
        linux_read.contains("open_file_at(parent_fd.as_raw_fd(), file_name)"),
        "config-read muss die datei aus dem gebundenen parent öffnen"
    );
    assert!(
        !linux_read.contains("std::fs::File::open"),
        "config-read darf nicht pfadbasiert öffnen"
    );
}
