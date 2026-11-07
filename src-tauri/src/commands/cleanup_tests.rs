use super::*;
use crate::commands::delete_ops::{TrashListingStage, TRASH_DIR_NAME};
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

    /// der wire-wert `dir` ist der geprüfte referenzpfad: kanonische library,
    /// ohne den endpfad erneut aufzulösen.
    fn reference_dir(&self) -> PathBuf {
        fs::canonicalize(self.library())
            .unwrap()
            .join("steamapps")
            .join(TRASH_DIR_NAME)
    }

    fn list(&self) -> Result<TrashListing, String> {
        list_trash_entries_at(&self.library())
    }

    fn list_with_hook(
        &self,
        hook: &mut dyn FnMut(TrashListingStage),
    ) -> Result<TrashListing, String> {
        list_trash_entries_at_with_hook(&self.library(), hook)
    }

    fn error_of(&self) -> String {
        self.list()
            .err()
            .expect("das papierkorb-listing muss fehlschlagen")
    }

    fn error_with_hook(&self, hook: &mut dyn FnMut(TrashListingStage)) -> String {
        self.list_with_hook(hook)
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
        fixture.reference_dir().to_string_lossy().into_owned(),
        "das dir-feld ist der geprüfte referenzpfad, aus dem das frontend eintraege baut"
    );
    // das listing legt den papierkorb nicht an: die anzeige bleibt zustandslos.
    assert!(!fixture.trash().exists());
}

#[test]
fn fehlende_library_ist_not_found_ohne_detail() {
    let fixture = Fixture::new("missing-library");
    let missing = fixture.root.join("fehlt");
    // die abwesenheit darf nicht als "kein papierkorb" durchgehen: der
    // aufrufer unterscheidet nicht-vorhanden (present=false) von nicht-lesbar.
    let error = list_trash_entries_at(&missing)
        .err()
        .expect("fehlende library muss fehlschlagen");
    assert_eq!(error, errcode::NOT_FOUND);
}

#[test]
fn fehlendes_steamapps_ist_not_found_ohne_detail() {
    let fixture = Fixture::new("missing-steamapps");
    fs::remove_dir(fixture.steamapps()).unwrap();
    assert_eq!(fixture.error_of(), errcode::NOT_FOUND);
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
fn nicht_lesbarer_papierkorb_traegt_den_io_code_mit_detail() {
    // Producer 3 (A-04): chmod 000 auf `.protium-trash`. Der pfad ist als
    // verzeichnis bestätigt (fstatat ohne Symlink-Folge), erst der gebundene
    // `open_dir_at` scheitert mit EACCES. Als nicht-root greift das — wie in
    // `prefix_tests::denied_prefix_is_unreadable`; als root umgeht der kernel die
    // rechteprüfung, dann ist der zweig nicht erreichbar und `error_of` schlägt
    // mit seiner meldung fehl, statt still zu bestehen.
    let fixture = Fixture::new("trash-unreadable");
    fs::create_dir_all(fixture.trash()).unwrap();
    fs::set_permissions(fixture.trash(), fs::Permissions::from_mode(0o000)).unwrap();
    let error = fixture.error_of();
    fs::set_permissions(fixture.trash(), fs::Permissions::from_mode(0o700)).unwrap();

    // beide richtungen: der code steht im leitfeld, das detail bleibt erhalten.
    assert!(error.starts_with("unreadable: "), "{error}");
}

#[test]
fn nicht_lesbare_library_traegt_unreadable_mit_detail() {
    if unsafe { libc::geteuid() } == 0 {
        // als root umgeht der kernel die rechteprüfung; der zweig ist dann
        // unerreichbar und der test prüft nichts.
        return;
    }
    let fixture = Fixture::new("library-unreadable");
    fs::set_permissions(fixture.library(), fs::Permissions::from_mode(0o000)).unwrap();
    let error = fixture.error_of();
    fs::set_permissions(fixture.library(), fs::Permissions::from_mode(0o700)).unwrap();

    assert!(error.starts_with("unreadable: "), "{error}");
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
    // fstatat ohne follow: ein toter verweis bleibt ein verweis und wird
    // deshalb wie ein lebender abgelehnt.
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

#[test]
fn hook_after_classify_mit_fremdem_verzeichnis_ist_unreadable() {
    let fixture = Fixture::new("trash-after-classify");
    fs::create_dir(fixture.trash()).unwrap();
    let moved = fixture.root.join("echter-papierkorb");
    let foreign = fixture.root.join("fremd");
    fs::create_dir(&foreign).unwrap();
    let (trash, moved_path, foreign_path) = (fixture.trash(), moved, foreign);

    let mut hook = move |stage: TrashListingStage| {
        if stage == TrashListingStage::AfterClassify {
            // gleicher pfad, andere identität: nur der fstatat-open-fstat-
            // vergleich sieht den tausch, ein pfadbasierter read nicht.
            fs::rename(&trash, &moved_path).unwrap();
            fs::rename(&foreign_path, &trash).unwrap();
        }
    };

    assert_eq!(fixture.error_with_hook(&mut hook), errcode::UNREADABLE);
}

#[test]
fn hook_after_trash_open_mit_rename_und_fremdem_symlink_ist_unreadable() {
    let fixture = Fixture::new("trash-after-open");
    fs::create_dir(fixture.trash()).unwrap();
    fs::write(fixture.trash().join("original-marker"), b"original").unwrap();
    let moved = fixture.root.join("echter-papierkorb");
    let foreign = fixture.root.join("fremd");
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join("fremd-marker"), b"fremd").unwrap();
    let (trash, moved_path, foreign_path) = (fixture.trash(), moved, foreign);

    let mut hook = move |stage: TrashListingStage| {
        if stage == TrashListingStage::AfterTrashOpen {
            fs::rename(&trash, &moved_path).unwrap();
            symlink(&foreign_path, &trash).unwrap();
        }
    };

    // der deskriptor zeigt nach dem rename woandershin als der referenzpfad.
    assert_eq!(fixture.error_with_hook(&mut hook), errcode::UNREADABLE);
}

#[test]
fn hook_after_check_mit_rename_und_fremdem_symlink_ist_unreadable() {
    let fixture = Fixture::new("trash-after-check");
    fs::create_dir(fixture.trash()).unwrap();
    fs::write(fixture.trash().join("original-marker"), b"original").unwrap();
    let moved = fixture.root.join("echter-papierkorb");
    let foreign = fixture.root.join("fremd");
    fs::create_dir(&foreign).unwrap();
    let (trash, moved_path, foreign_path) = (fixture.trash(), moved, foreign);

    let mut hook = move |stage: TrashListingStage| {
        if stage == TrashListingStage::AfterCheck {
            fs::rename(&trash, &moved_path).unwrap();
            symlink(&foreign_path, &trash).unwrap();
        }
    };

    // ohne die nachprüfung nach dem read käme hier ein Ok mit den einträgen
    // des verschobenen verzeichnisses zurück.
    assert_eq!(fixture.error_with_hook(&mut hook), errcode::UNREADABLE);
}

#[test]
fn papierkorb_listing_liest_nur_den_deskriptor_pfad() {
    // quelltext-pin: eine verlaufsprobe kann den deskriptor- vom
    // referenzpfad-read nicht trennen (die nachprüfung macht beide varianten
    // zu `unreadable`). Der pin belegt die eine lesestelle.
    let production = crate::commands::test_util::production_source(include_str!("cleanup.rs"))
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    assert_eq!(
        production.matches("read_dir(").count(),
        1,
        "genau eine lesestelle im papierkorb-listing"
    );
    assert!(
        production.contains("read_dir(entries_path"),
        "gelesen wird ausschliesslich der deskriptor-pfad"
    );
    assert!(
        production.contains("let entries_path = handle"),
        "der lesepfad kommt aus dem handle"
    );
    assert!(
        production.contains(".entries_path()"),
        "der lesepfad kommt aus dem handle"
    );
    assert!(
        !production.contains("entries_path = handle.wire_dir()"),
        "kein fallback auf den wire-pfad"
    );
    assert!(
        !production.contains("read_dir(wire_dir"),
        "kein read über den referenzpfad"
    );
    assert!(
        !production.contains("join(\"steamapps\")"),
        "kein pfad-join statt gebundenem referenzpfad"
    );
    assert!(
        !production.contains("join(TRASH_DIR_NAME)"),
        "kein pfad-join statt gebundenem referenzpfad"
    );
}
