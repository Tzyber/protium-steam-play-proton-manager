use super::*;
use crate::commands::test_util::fixture_dir;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::PathBuf;

/// tempdir-fixture mit `library/steamapps`: `list_trash_entries_at` ist
/// pfadlogik ohne Environment-Snapshot, deshalb reicht der baum.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = fixture_dir("trash", tag);
        fs::create_dir_all(root.join("library/steamapps")).unwrap();
        Self { root }
    }

    fn library(&self) -> PathBuf {
        self.root.join("library")
    }

    fn steamapps(&self) -> PathBuf {
        self.library().join("steamapps")
    }

    fn trash(&self) -> PathBuf {
        self.steamapps().join(TRASH_DIR_NAME)
    }

    fn list(&self) -> Result<TrashListing, String> {
        list_trash_entries_at(&self.library())
    }

    fn error_of(&self) -> String {
        self.list()
            .err()
            .expect("das papierkorb-listing muss fehlschlagen")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn fehlender_papierkorb_ist_present_false_und_kein_fehler() {
    let fixture = Fixture::new("missing-trash");
    let listing = fixture.list().unwrap();
    assert!(!listing.present);
    assert!(listing.entries.is_empty());
    assert_eq!(
        listing.dir,
        fixture.trash().to_string_lossy().into_owned(),
        "das dir-feld ist der zusammengesetzte pfad, aus dem das frontend eintraege baut"
    );
}

#[test]
fn fehlende_library_ist_ein_lesefehler() {
    let fixture = Fixture::new("missing-library");
    let missing = fixture.root.join("fehlt");
    // die abwesenheit darf nicht als "kein papierkorb" durchgehen: der
    // aufrufer unterscheidet nicht-vorhanden (present=false) von nicht-lesbar.
    let error = list_trash_entries_at(&missing)
        .err()
        .expect("fehlende library muss fehlschlagen");
    assert!(!error.is_empty());
}

#[test]
fn fehlendes_steamapps_ist_ein_lesefehler() {
    let fixture = Fixture::new("missing-steamapps");
    fs::remove_dir(fixture.steamapps()).unwrap();
    assert!(!fixture.error_of().is_empty());
}

#[test]
fn library_symlink_ist_kein_verzeichnis() {
    let fixture = Fixture::new("library-symlink");
    let through_link = fixture.root.join("library-verweis");
    symlink(fixture.library(), &through_link).unwrap();

    // ein verweis als library wird abgelehnt, nicht verfolgt: sonst läge der
    // gelesene papierkorb ausserhalb des autorisierten pfads.
    let error = list_trash_entries_at(&through_link)
        .err()
        .expect("symlink-library muss fehlschlagen");
    assert_eq!(error, errcode::NOT_A_DIRECTORY);
}

#[test]
fn library_datei_ist_kein_verzeichnis() {
    let fixture = Fixture::new("library-file");
    fs::remove_dir_all(fixture.library()).unwrap();
    fs::write(fixture.library(), "keine library").unwrap();
    assert_eq!(fixture.error_of(), errcode::NOT_A_DIRECTORY);
}

#[test]
fn steamapps_symlink_ist_kein_verzeichnis() {
    let fixture = Fixture::new("steamapps-symlink");
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::remove_dir(fixture.steamapps()).unwrap();
    symlink(&outside, fixture.steamapps()).unwrap();
    assert_eq!(fixture.error_of(), errcode::NOT_A_DIRECTORY);
}

#[test]
fn nicht_lesbarer_papierkorb_traegt_den_io_code() {
    // Producer 3 (A-04): chmod 000 auf `.protium-trash`. Der pfad ist als
    // verzeichnis bestätigt (symlink_metadata + is_dir), erst `read_dir`
    // scheitert mit EACCES. Als nicht-root greift das — wie in
    // `prefix_tests::denied_prefix_is_unreadable`; als root umgeht der kernel die
    // rechteprüfung, dann ist der zweig nicht erreichbar und `error_of` schlägt
    // mit seiner meldung fehl, statt still zu bestehen.
    let fixture = Fixture::new("trash-unreadable");
    fs::create_dir_all(fixture.trash()).unwrap();
    fs::set_permissions(fixture.trash(), fs::Permissions::from_mode(0o000)).unwrap();
    let error = fixture.error_of();
    fs::set_permissions(fixture.trash(), fs::Permissions::from_mode(0o700)).unwrap();

    assert!(errcode::has_code(&error, errcode::UNREADABLE), "{error}");
}

#[test]
fn papierkorb_symlink_wird_abgelehnt() {
    let fixture = Fixture::new("trash-symlink");
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, fixture.trash()).unwrap();
    assert_eq!(fixture.error_of(), errcode::SYMLINK_REJECTED);
}

#[test]
fn papierkorb_symlink_auf_fehlendes_ziel_wird_abgelehnt() {
    let fixture = Fixture::new("trash-broken-symlink");
    // symlink_metadata folgt dem verweis nicht; ein toter verweis bleibt ein
    // verweis und wird deshalb wie ein lebender abgelehnt.
    symlink(fixture.root.join("nirgendwo"), fixture.trash()).unwrap();
    assert_eq!(fixture.error_of(), errcode::SYMLINK_REJECTED);
}

#[test]
fn papierkorb_datei_ist_kein_verzeichnis() {
    let fixture = Fixture::new("trash-file");
    fs::write(fixture.trash(), "kein papierkorb").unwrap();
    assert_eq!(fixture.error_of(), errcode::NOT_A_DIRECTORY);
}

#[test]
fn eintraege_tragen_verzeichnis_datei_und_symlink_flags() {
    let fixture = Fixture::new("entries");
    fs::create_dir(fixture.trash()).unwrap();
    fs::create_dir(fixture.trash().join("compatdata_620_1000")).unwrap();
    fs::write(fixture.trash().join("compatdata_570_1000"), "kaputt").unwrap();
    symlink("/etc", fixture.trash().join("compatdata_730_1000")).unwrap();

    let listing = fixture.list().unwrap();

    assert!(listing.present);
    assert_eq!(listing.entries.len(), 3);
    let compatdata_620 = listing
        .entries
        .iter()
        .find(|entry| entry.name == "compatdata_620_1000")
        .expect("verzeichniseintrag fehlt");
    let compatdata_570 = listing
        .entries
        .iter()
        .find(|entry| entry.name == "compatdata_570_1000")
        .expect("dateieintrag fehlt");
    let compatdata_730 = listing
        .entries
        .iter()
        .find(|entry| entry.name == "compatdata_730_1000")
        .expect("symlinkeintrag fehlt");
    assert!(compatdata_620.is_dir);
    assert!(!compatdata_620.is_symlink);
    assert!(!compatdata_570.is_dir);
    assert!(!compatdata_570.is_symlink);
    assert!(!compatdata_730.is_dir);
    assert!(compatdata_730.is_symlink);
}

#[test]
fn leerer_papierkorb_ist_present_mit_null_eintraegen() {
    let fixture = Fixture::new("empty-trash");
    fs::create_dir(fixture.trash()).unwrap();
    let listing = fixture.list().unwrap();
    // present=true bei leerem verzeichnis: vorhanden, aber nichts aufzuraeumen.
    assert!(listing.present);
    assert!(listing.entries.is_empty());
}
