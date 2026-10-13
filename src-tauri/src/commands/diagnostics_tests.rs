use super::*;
use crate::commands::test_util::wsg_fixture;

#[test]
fn test_append_log_entry() {
    let root = wsg_fixture("test_append_log");
    let log_dir = root.join("logs");

    append_log_entry(&log_dir, "info", "App gestartet").unwrap();
    append_log_entry(&log_dir, "error", "Fehler aufgetreten").unwrap();

    let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();
    assert!(content.contains("[INFO] App gestartet"));
    assert!(content.contains("[ERROR] Fehler aufgetreten"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn test_rotate_logs() {
    let root = wsg_fixture("test_rotate_log");
    let log_dir = root.join("logs");
    fs::create_dir_all(&log_dir).unwrap();

    let main_log = log_dir.join("protium.log");
    // Erzeuge Datei ueber MAX_LOG_BYTES (z. B. Dummy)
    let large_data = vec![b'a'; (MAX_LOG_BYTES + 10) as usize];
    fs::write(&main_log, large_data).unwrap();

    rotate_logs_if_needed(&log_dir);
    assert!(!main_log.exists());
    assert!(log_dir.join("protium.log.1").exists());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn rotation_kaskadiert_ueber_zwei_generationen() {
    let root = wsg_fixture("test_rotate_chain");
    let log_dir = root.join("logs");
    fs::create_dir_all(&log_dir).unwrap();
    fs::write(log_dir.join("protium.log.1"), b"alt1").unwrap();
    fs::write(
        log_dir.join("protium.log"),
        vec![b'a'; (MAX_LOG_BYTES + 1) as usize],
    )
    .unwrap();

    rotate_logs_if_needed(&log_dir);
    assert!(log_dir.join("protium.log.1").exists());
    assert_eq!(fs::read(log_dir.join("protium.log.2")).unwrap(), b"alt1");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn log_tail_liest_den_schluss_und_ist_bei_fehlender_datei_leer() {
    let root = wsg_fixture("test_log_tail");
    let log_dir = root.join("logs");
    assert_eq!(read_log_tail_from_dir(&log_dir).unwrap(), "");

    fs::create_dir_all(&log_dir).unwrap();
    append_log_entry(&log_dir, "info", "erste zeile").unwrap();
    append_log_entry(&log_dir, "error", "zweite zeile").unwrap();

    let tail = read_log_tail_from_dir(&log_dir).unwrap();
    assert!(tail.contains("erste zeile"));
    assert!(tail.contains("zweite zeile"));

    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn log_tail_lehnt_symlink_ab() {
    let root = wsg_fixture("test_log_tail_symlink");
    let log_dir = root.join("logs");
    fs::create_dir_all(&log_dir).unwrap();
    fs::write(root.join("echt.log"), b"x").unwrap();
    std::os::unix::fs::symlink(root.join("echt.log"), log_dir.join("protium.log")).unwrap();

    assert_eq!(read_log_tail_from_dir(&log_dir).unwrap_err(), "blocked");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn log_tail_startet_nicht_mitten_in_einer_utf8_sequenz() {
    // Die tail-grenze liegt auf einer beliebigen byteposition. Beginnt sie
    // im zweiten byte eines mehrbytezeichens, darf der read nicht scheitern.
    let root = wsg_fixture("test_log_tail_utf8");
    let log_dir = root.join("logs");
    fs::create_dir_all(&log_dir).unwrap();
    let tail_bytes = usize::try_from(MAX_LOG_TAIL_BYTES).unwrap();
    let rest = format!("\n{}\n", "y".repeat(tail_bytes - 3));
    assert_eq!(rest.len(), tail_bytes - 1);
    let mut content = "x".repeat(10);
    content.push('ä');
    content.push_str(&rest);
    fs::write(log_dir.join("protium.log"), &content).unwrap();

    let start = content.len() - tail_bytes;
    assert_eq!(
        start, 11,
        "die grenze muss in der mitte des mehrbytezeichens liegen"
    );

    let tail = read_log_tail_from_dir(&log_dir).unwrap();
    assert!(tail.starts_with('y'), "tail beginnt mitten im zeichen");
    assert!(!tail.contains('\u{FFFD}'));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn append_hinterlaesst_auch_beim_wechselnden_aufrufer_genau_eine_zeile() {
    // Serialisierung: parallele Appends duerfen sich nicht verzahnen.
    let root = wsg_fixture("test_log_serialized");
    let log_dir = root.join("logs");
    let mut handles = Vec::new();
    for index in 0..4 {
        let dir = log_dir.clone();
        handles.push(std::thread::spawn(move || {
            append_log_entry(&dir, "info", &format!("zeile-{index}")).unwrap();
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }

    let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();
    assert_eq!(content.lines().count(), 4);
    for index in 0..4 {
        assert!(content.contains(&format!("[INFO] zeile-{index}")));
    }

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn panic_pfad_blockiert_nicht_wenn_die_sperre_gehalten_wird() {
    // Der Hook laeuft im panischen Thread; haelt der die Sperre, darf er
    // nicht darauf warten. try_lock schreibt die zeile trotzdem.
    let root = wsg_fixture("test_log_panic_lock");
    let log_dir = root.join("logs");
    let guard = lock_log();
    append_panic_entry(&log_dir, "panic: test");
    drop(guard);

    let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();
    assert!(content.contains("panic: test"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn log_redigiert_home_pfade_und_laesst_den_rest_stehen() {
    let with_home = redact_log_text(
        "unreadable: /home/nutzer/.local/share/Steam/config/config.vdf: Permission denied",
        Some("/home/nutzer"),
        None,
        None,
    );
    assert!(with_home.starts_with("unreadable: ~/.local/share/Steam"));
    assert!(with_home.ends_with("Permission denied"));
    assert!(!with_home.contains("/home/nutzer"));

    // ohne bekanntes home bleibt die zeile unverändert
    let without_home = redact_log_text("unreadable: /srv/steam/x", None, None, None);
    assert_eq!(without_home, "unreadable: /srv/steam/x");
}

#[test]
fn log_redigiert_account_id_kanonisches_home_und_medienpfad() {
    let account = "98765432109876543";
    let text = format!(
        "unreadable: /home/nutzer/.local/share/Steam/config.vdf and \
         /var/home/nutzer/.steam/steam/userdata/{account}/config and \
         /run/media/nutzer/SteamLibrary and /media/nutzer/games: Permission denied"
    );
    let redacted = redact_log_text(
        &text,
        Some("/home/nutzer"),
        Some("/var/home/nutzer"),
        Some("nutzer"),
    );
    assert_eq!(
        redacted,
        "unreadable: ~/.local/share/Steam/config.vdf and \
         ~/.steam/steam/userdata/<redacted>/config and \
         /run/media/~/SteamLibrary and /media/~/games: Permission denied"
    );
    assert!(!redacted.contains(account));
    assert!(!redacted.contains("nutzer"));
}

#[test]
fn home_maske_trifft_nur_ganze_pfadsegmente() {
    let text = "/home/user /home/user/x /home/user2/x /home/useraccount /home/user.alt /home/userä";
    let expected = "~ ~/x /home/user2/x /home/useraccount /home/user.alt /home/userä";
    for home in ["/home/user", "/home/user/"] {
        assert_eq!(
            redact_log_text(text, Some(home), None, None),
            expected,
            "{home}"
        );
    }
}

#[test]
fn root_oder_leeres_home_maskiert_nichts() {
    let text = "/home/user/x /";
    for home in ["/", "//", "", "home/user"] {
        assert_eq!(redact_log_text(text, Some(home), Some(home), None), text);
    }
}

#[test]
fn kanonisches_home_folgt_denselben_segmentregeln() {
    let text = "/var/home/user/x /home/user /var/home/user2/x /var/home/useraccount";
    let redacted = redact_log_text(text, Some("/home/user"), Some("/var/home/user/"), None);
    assert_eq!(redacted, "~/x ~ /var/home/user2/x /var/home/useraccount");
}

#[test]
fn home_an_der_kuerzungsgrenze_wird_vor_dem_kuerzen_maskiert() {
    // vorher gekürzt endete die zeile auf `/home/us`; der name wäre halb sichtbar.
    let prefix = format!("{} ", "ä".repeat(MAX_LOG_MESSAGE_CHARS - 9));
    let message = format!("{prefix}/home/user/x");
    let cleaned = clean_log_message(&message, Some("/home/user"), None, None);
    assert_eq!(cleaned, format!("{prefix}~/x"));

    let long = format!("{}/home/user", "ä".repeat(MAX_LOG_MESSAGE_CHARS));
    let cleaned = clean_log_message(&long, Some("/home/user"), None, None);
    assert_eq!(cleaned, "ä".repeat(MAX_LOG_MESSAGE_CHARS));
}

#[test]
fn root_home_trifft_keinen_medienpfad_desselben_nutzers() {
    let text = "/root/.steam /run/media/root/lib /media/root/lib /srv/root/x";
    let redacted = redact_log_text(text, Some("/root"), Some("/root"), Some("root"));
    assert_eq!(
        redacted,
        "~/.steam /run/media/~/lib /media/~/lib /srv/root/x"
    );
}

#[test]
fn punkt_am_satzende_beendet_home_und_account_id() {
    let text = "liegt unter /home/user. Account userdata/123. Ende /home/user.alt";
    let redacted = redact_log_text(text, Some("/home/user"), None, None);
    assert_eq!(
        redacted,
        "liegt unter ~. Account userdata/<redacted>. Ende /home/user.alt"
    );
    assert_eq!(
        redact_log_text("/home/user...", Some("/home/user"), None, None),
        "~..."
    );
}

#[test]
fn sehr_lange_nachricht_wird_vorgekuerzt_und_vorne_maskiert() {
    let message = format!("/home/user/x {}", "a".repeat(100 * MAX_LOG_MESSAGE_CHARS));
    let cleaned = clean_log_message(&message, Some("/home/user"), None, None);
    assert_eq!(cleaned.chars().count(), MAX_LOG_MESSAGE_CHARS);
    assert!(cleaned.starts_with("~/x a"), "{}", &cleaned[..20]);
}

#[test]
fn log_laesst_nicht_numerische_userdata_und_laengere_namen_stehen() {
    let text = "userdata/not-an-id /run/media/nutzer2/x /media/nutzer2/y";
    let redacted = redact_log_text(text, None, None, Some("nutzer"));
    assert_eq!(redacted, text);
}

#[test]
fn log_fixture_zeigt_maske_statt_account_id() {
    let root = wsg_fixture("test_log_redact_account");
    let log_dir = root.join("logs");
    let account = "98765432109876543";
    let home = std::env::var("HOME").unwrap_or_default();
    let user = std::env::var("USER").unwrap_or_default();
    let canonical = canonical_home_path(Some(home.as_str())).unwrap_or_default();
    let mut message = format!("userdata/{account}/config: Permission denied");
    if home.starts_with('/') {
        message = format!("{home}/.steam/steam/{message}");
    }
    if canonical.starts_with('/') {
        message = format!("{canonical}/.steam {message}");
    }
    if maskable_user(&user) {
        message = format!("/run/media/{user}/lib /media/{user}/lib {message}");
    }

    append_log_entry(&log_dir, "warn", &message).unwrap();
    let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();

    assert!(!content.contains(account), "{content}");
    assert!(content.contains("userdata/<redacted>"), "{content}");
    assert!(content.contains("Permission denied"), "{content}");
    if home.starts_with('/') {
        assert!(!content.contains(&home), "{content}");
    }
    if canonical.starts_with('/') {
        assert!(!content.contains(&canonical), "{content}");
    }
    if maskable_user(&user) {
        assert!(
            !content.contains(&format!("/run/media/{user}")),
            "{content}"
        );
        assert!(!content.contains(&format!("/media/{user}")), "{content}");
        assert!(content.contains("/run/media/~/lib"), "{content}");
        assert!(content.contains("/media/~/lib"), "{content}");
    }

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn unbekanntes_level_wird_info_und_nachricht_gekuerzt() {
    let root = wsg_fixture("test_log_level");
    let log_dir = root.join("logs");
    let lang = format!("{}\nzweite zeile", "x".repeat(MAX_LOG_MESSAGE_CHARS + 50));

    append_log_entry(&log_dir, "verbose", &lang).unwrap();

    let content = fs::read_to_string(log_dir.join("protium.log")).unwrap();
    assert!(content.contains("[INFO]"));
    assert_eq!(content.lines().count(), 1);
    assert!(content.chars().count() <= MAX_LOG_MESSAGE_CHARS + 40);

    let _ = fs::remove_dir_all(&root);
}
