use super::*;
use crate::commands::test_util::fixture_dir;
use std::io::Write;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::PathBuf;

/// tempdir-fixture fuer die deskriptorhelfer. geprüft wird die fehlerklasse
/// (code + errno), nicht eine textzeile: die codes sind der vertrag.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = fixture_dir("fd", tag);
        Self { root }
    }

    fn bound_dir(&self) -> PathBuf {
        let dir = self.root.join("bound");
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn absolute_fd(&self) -> OwnedFd {
        open_absolute_dir(&self.bound_dir()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn hex_lower_ist_leer_fuer_leere_eingabe() {
    assert_eq!(hex_lower(&[]), "");
}

#[test]
fn hex_lower_schreibt_klein_und_immer_zweistellig() {
    // fuehrende nullen und werte ab 0x10 muessen erhalten bleiben, sonst
    // kollabieren hashes und token.
    assert_eq!(hex_lower(&[0x00, 0x0f, 0x10, 0xa5, 0xff]), "000f10a5ff");
    assert_eq!(hex_lower(&[0u8; 3]), "000000");
}

#[test]
fn component_name_lehnt_nul_im_namen_ab() {
    let error = component_name(OsStr::from_bytes(b"a\0b")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn open_dir_at_lehnt_nul_im_namen_ab() {
    let fixture = Fixture::new("nul-component");
    let root_fd = fixture.absolute_fd();
    let error = open_dir_at(root_fd.as_raw_fd(), OsStr::from_bytes(b"a\0b")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn open_absolute_dir_lehnt_nul_im_pfad_ab() {
    let error = open_absolute_dir(Path::new("/tmp/a\0b")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn open_absolute_dir_unterscheidet_fehlend_und_datei() {
    let fixture = Fixture::new("absolute");
    let missing = fixture.root.join("fehlt");
    assert_eq!(
        open_absolute_dir(&missing).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );

    let file = fixture.root.join("datei");
    fs::write(&file, "x").unwrap();
    assert_eq!(
        open_absolute_dir(&file).unwrap_err().raw_os_error(),
        Some(libc::ENOTDIR)
    );
}

#[test]
fn open_absolute_dir_folgt_keinem_symlink() {
    let fixture = Fixture::new("absolute-symlink");
    let target = fixture.root.join("ziel");
    fs::create_dir_all(&target).unwrap();
    let link = fixture.root.join("verweis");
    symlink(&target, &link).unwrap();

    // O_NOFOLLOW: der deskriptor darf nie ueber einen verweis laufen.
    assert!(open_absolute_dir(&link).is_err());
}

#[test]
fn sync_dir_fd_synchronisiert_und_meldet_einen_ungueltigen_deskriptor() {
    let fixture = Fixture::new("sync");
    let root_fd = fixture.absolute_fd();
    sync_dir_fd(root_fd.as_raw_fd()).unwrap();
    let error = sync_dir_fd(-1).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EBADF));
}

#[test]
fn open_bound_root_fd_meldet_fehlenden_ordner_als_not_found() {
    let fixture = Fixture::new("bound-missing");
    let missing = fixture.root.join("fehlt");
    let error = open_bound_root_fd(&missing, &mut || {}).unwrap_err();
    assert!(errcode::has_code(&error, errcode::NOT_FOUND), "{error}");
}

#[test]
fn open_bound_root_fd_meldet_eine_datei_als_not_a_directory() {
    let fixture = Fixture::new("bound-file");
    let file = fixture.root.join("datei");
    fs::write(&file, "x").unwrap();
    let error = open_bound_root_fd(&file, &mut || {}).unwrap_err();
    assert!(
        errcode::has_code(&error, errcode::NOT_A_DIRECTORY),
        "{error}"
    );
}

#[test]
fn open_bound_root_fd_lehnt_einen_symlink_als_wurzel_ab() {
    let fixture = Fixture::new("bound-symlink");
    let target = fixture.root.join("ziel");
    fs::create_dir_all(&target).unwrap();
    let link = fixture.root.join("wurzel");
    symlink(&target, &link).unwrap();

    // metadata folgt dem verweis, der O_NOFOLLOW-open nicht: der aufruf muss
    // fehlschlagen statt einen deskriptor mit fremder identitaet zu liefern.
    let error = open_bound_root_fd(&link, &mut || {}).unwrap_err();
    assert!(errcode::has_code(&error, errcode::UNREADABLE), "{error}");
}

#[test]
fn open_bound_root_fd_belegt_die_identitaet_des_geoeffneten_deskriptors() {
    let fixture = Fixture::new("bound-identity");
    fs::create_dir_all(fixture.bound_dir()).unwrap();
    let expected = FdIdentity::of(&fs::metadata(fixture.bound_dir()).unwrap());

    let mut hooked = false;
    let fd = open_bound_root_fd(&fixture.bound_dir(), &mut || hooked = true).unwrap();

    // der hook laeuft zwischen stat und open; ohne ihn waere der
    // identitaetsvergleich nicht belegbar.
    assert!(hooked);
    assert_eq!(fd_identity(fd.as_raw_fd()).unwrap(), expected);
}

#[test]
fn open_bound_root_fd_bricht_bei_identitaetswechsel_ab() {
    let fixture = Fixture::new("bound-swap");
    let bound = fixture.bound_dir();
    let replacement = fixture.root.join("ersatz");
    fs::create_dir_all(&bound).unwrap();
    fs::create_dir_all(&replacement).unwrap();

    let mut swapped = false;
    let error = open_bound_root_fd(&bound, &mut || {
        if !swapped {
            // gleicher pfad, andere identitaet: nur der stat-open-fstat-vergleich
            // sieht den tausch, ein pfadbasierter read nicht.
            fs::rename(&bound, fixture.root.join("alt")).unwrap();
            fs::rename(&replacement, &bound).unwrap();
            swapped = true;
        }
    })
    .unwrap_err();

    assert!(
        errcode::has_code(&error, errcode::TARGET_CHANGED),
        "{error}"
    );
}

#[test]
fn read_fd_bytes_liest_bis_genau_max_bytes() {
    let fixture = Fixture::new("read-exact");
    let path = fixture.root.join("datei");
    let payload = vec![b'a'; 16];
    fs::write(&path, &payload).unwrap();

    let mut file = fs::File::open(&path).unwrap();
    let bytes = read_fd_bytes(&mut file, "fixture", 16, &mut |_| {}).unwrap();

    assert_eq!(bytes, payload);
}

#[test]
fn read_fd_bytes_lehnt_eine_datei_ueber_max_bytes_ab() {
    let fixture = Fixture::new("read-too-large");
    let path = fixture.root.join("datei");
    fs::write(&path, vec![b'a'; 17]).unwrap();

    let mut file = fs::File::open(&path).unwrap();
    let error = read_fd_bytes(&mut file, "fixture", 16, &mut |_| {}).unwrap_err();

    assert!(errcode::has_code(&error, errcode::SIZE_LIMIT), "{error}");
    assert!(error.contains("fixture"), "{error}");
}

#[test]
fn read_fd_bytes_liest_erst_nach_dem_hook() {
    let fixture = Fixture::new("read-hook");
    let path = fixture.root.join("datei");
    fs::write(&path, "abcd").unwrap();

    let mut file = fs::File::open(&path).unwrap();
    let mut calls = 0;
    let bytes = read_fd_bytes(&mut file, "fixture", 16, &mut |_| calls += 1).unwrap();

    assert_eq!(calls, 1);
    assert_eq!(bytes.as_slice(), b"abcd");
}

#[test]
fn read_fd_bytes_prueft_die_groesse_nach_dem_lesen_erneut() {
    let fixture = Fixture::new("read-growth");
    let path = fixture.root.join("datei");
    fs::write(&path, vec![b'a'; 16]).unwrap();

    let mut file = fs::File::open(&path).unwrap();
    // zwischen stat und read waechst die datei. Der take(max+1)-read liefert
    // dann ein byte zu viel; ohne die nachpruefung ginge der cap durch.
    let error = read_fd_bytes(&mut file, "fixture", 16, &mut |_| {
        let mut appended = fs::OpenOptions::new().append(true).open(&path).unwrap();
        appended.write_all(b"x").unwrap();
    })
    .unwrap_err();

    assert!(errcode::has_code(&error, errcode::SIZE_LIMIT), "{error}");
}

#[test]
fn read_fd_bytes_lehnt_ein_verzeichnis_ab() {
    let fixture = Fixture::new("read-directory");
    let mut dir = fs::File::open(fixture.bound_dir()).unwrap();

    let error = read_fd_bytes(&mut dir, "fixture", 16, &mut |_| {}).unwrap_err();

    assert!(
        errcode::has_code(&error, errcode::NOT_A_DIRECTORY),
        "{error}"
    );
}

#[test]
fn open_or_create_dir_at_legt_fehlendes_verzeichnis_mit_700_an() {
    let fixture = Fixture::new("create-missing");
    let root_fd = fixture.absolute_fd();

    let created = open_or_create_dir_at(root_fd.as_raw_fd(), OsStr::new("neu")).unwrap();

    let target = fixture.bound_dir().join("neu");
    let metadata = fs::metadata(&target).unwrap();
    assert!(metadata.is_dir());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    assert_eq!(
        fd_identity(created.as_raw_fd()).unwrap(),
        FdIdentity::of(&metadata)
    );
}

#[test]
fn open_or_create_dir_at_ist_idempotent() {
    let fixture = Fixture::new("create-existing");
    let root_fd = fixture.absolute_fd();

    let first = open_or_create_dir_at(root_fd.as_raw_fd(), OsStr::new("neu")).unwrap();
    let second = open_or_create_dir_at(root_fd.as_raw_fd(), OsStr::new("neu")).unwrap();

    // zweiter aufruf: kein mkdir, dieselbe verzeichnisidentitaet.
    assert_eq!(
        fd_identity(first.as_raw_fd()).unwrap(),
        fd_identity(second.as_raw_fd()).unwrap()
    );
}

#[test]
fn open_or_create_dir_at_lehnt_eine_vorhandene_datei_ab() {
    let fixture = Fixture::new("create-file");
    let root_fd = fixture.absolute_fd();
    fs::write(fixture.bound_dir().join("eintrag"), "x").unwrap();

    let error = open_or_create_dir_at(root_fd.as_raw_fd(), OsStr::new("eintrag")).unwrap_err();

    // ENOTDIR ist kein NotFound: der AlreadyExists-zweig darf hier nicht greifen.
    assert_eq!(error.raw_os_error(), Some(libc::ENOTDIR));
}

#[test]
fn open_or_create_dir_at_folgt_keinem_symlink() {
    let fixture = Fixture::new("create-symlink");
    let root_fd = fixture.absolute_fd();
    let target = fixture.root.join("ziel");
    fs::create_dir_all(&target).unwrap();
    symlink(&target, fixture.bound_dir().join("verweis")).unwrap();

    assert!(open_or_create_dir_at(root_fd.as_raw_fd(), OsStr::new("verweis")).is_err());
    assert!(fs::symlink_metadata(fixture.bound_dir().join("verweis"))
        .unwrap()
        .file_type()
        .is_symlink());
}
