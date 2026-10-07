use crate::commands::download::CancelSignal;
use crate::commands::errcode;
use crate::commands::path::{
    canonicalize_nearest_ancestor, is_descendant_of, is_safe_path, link_target_stays_inside,
    random_suffix,
};
use std::fs;
use std::io::{Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

/// a-p1-1-rest: einträge der größe 0 umgehen das größen-cap, eine inode- oder
/// metadatenbombe stoppt erst die eintragszahl. echte GE-Proton-builds haben
/// rund 9 000 einträge (GE-Proton11-6/11-7 gezählt), 100 000 lässt >10× luft.
pub(super) const MAX_ARCHIVE_ENTRIES: usize = 100_000;

/// Bekommt den finalen Installations-Rename und führt ihn aus; der Aufrufer
/// legt die Sperre darum (A-10).
type RenameGuard<'a> = dyn FnMut(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String> + 'a;

fn archive_entry_path(
    entry: &tar::Entry<'_, flate2::read::GzDecoder<&mut fs::File>>,
) -> Result<PathBuf, String> {
    let path = entry
        .path()
        .map_err(|error| {
            errcode::with_detail(errcode::UNREADABLE, format!("read archive path: {error}"))
        })?
        .into_owned();
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(errcode::with_detail(
            errcode::INCOMPLETE,
            format!(
                "archive path is not relative and confined: {}",
                path.display()
            ),
        ));
    }
    Ok(path)
}

/// prüft ein link-ziel gegen die archivwurzel. `base` ist die bezugsbasis des
/// ziels und unterscheidet sich je eintragsart (A-02): das ziel eines
/// `Symlink` ist relativ zum verzeichnis des links, das eines tar-`Link`
/// (hardlink) dagegen archivwurzel-relativ. mit `path.parent()` für beide war
/// die vorfilterung für hardlinks wirkungslos.
fn validate_link_target(base: &Path, path: &Path, target: &Path, kind: &str) -> Result<(), String> {
    if target.as_os_str().is_empty() {
        return Err(errcode::with_detail(errcode::INCOMPLETE, kind));
    }
    if target.is_absolute() || !link_target_stays_inside(base, target) {
        return Err(errcode::with_detail(
            errcode::INCOMPLETE,
            format!(
                "{kind} target leaves archive: {} -> {}",
                path.display(),
                target.display()
            ),
        ));
    }
    Ok(())
}

fn is_archive_metadata(entry_type: tar::EntryType) -> bool {
    entry_type == tar::EntryType::XHeader
        || entry_type == tar::EntryType::XGlobalHeader
        || entry_type == tar::EntryType::GNULongName
        || entry_type == tar::EntryType::GNULongLink
}

fn path_exists_without_following(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// a-09: `link_target_stays_inside` ist lexikalisch und sieht die kette
/// `a/l -> ..`, `m -> a/l/..` nicht. nach dem entpacken muss jedes aufgelöste
/// ziel unter `root` (`<temp>/<tag>`) bleiben, sonst abbruch.
fn ensure_extracted_symlinks_stay_inside(root: &Path) -> Result<(), String> {
    let root_canon = fs::canonicalize(root).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("canonicalize extracted tool: {error}"),
        )
    })?;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = fs::read_dir(&dir).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("read extracted tree: {error}"),
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("read extracted entry: {error}"),
                )
            })?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("inspect extracted entry: {error}"),
                )
            })?;
            if metadata.file_type().is_symlink() {
                // derselbe code wie die lexikalische ablehnung, sonst wirkt ein
                // ausbruch wie ein unvollständiges archiv.
                let resolved = fs::canonicalize(&path).map_err(|error| {
                    errcode::with_detail(
                        errcode::SYMLINK_REJECTED,
                        format!("resolve symlink: {error}"),
                    )
                })?;
                if !is_descendant_of(&resolved, &root_canon) {
                    return Err(errcode::with_detail(
                        errcode::SYMLINK_REJECTED,
                        format!(
                            "symlink target leaves archive: {} -> {}",
                            path.display(),
                            resolved.display()
                        ),
                    ));
                }
            } else if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(())
}

/// validiert und entpackt genau den bereits geöffneten download-handle.
/// kein pfad wird zwischen download, hash und extraction erneut geöffnet.
#[cfg(test)]
pub(super) fn extract_blocking_with_tag(
    file: &mut fs::File,
    dest_dir: &str,
    expected_tag: Option<&str>,
    max_unpack_bytes: u64,
    scope_ok: &dyn Fn(&Path) -> bool,
    cancel: &CancelSignal,
) -> Result<(), String> {
    extract_blocking_with_tag_with_hook(
        file,
        dest_dir,
        expected_tag,
        max_unpack_bytes,
        MAX_ARCHIVE_ENTRIES,
        scope_ok,
        cancel,
        &mut || {},
        &mut |rename| rename(),
    )
}

/// Erster Archiv-Durchgang ohne Mutation (r-10): prüft genau einen
/// Top-Level-Ordner mit dem erwarteten Tag, jede Eintragsart, die Eintragszahl
/// und die entpackte Gesamtgröße. Derselbe Code wie zuvor, nur aus
/// `extract_blocking_with_tag` herausgezogen; Fehler und deren Reihenfolge
/// bleiben unverändert.
fn validate_archive_entries(
    file: &mut fs::File,
    expected_tag: &str,
    max_unpack_bytes: u64,
    max_entries: usize,
    cancel: &CancelSignal,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    file.seek(SeekFrom::Start(0)).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("rewind archive before validation: {error}"),
        )
    })?;
    let mut root_seen = false;
    let mut total = 0u64;
    let mut entries = 0usize;
    {
        let decoder = GzDecoder::new(&mut *file);
        let mut archive = Archive::new(decoder);
        for entry_result in archive.entries().map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("read archive: {error}"),
            )
        })? {
            if cancel.is_cancelled() {
                return Err(errcode::CANCELLED.into());
            }
            let entry = entry_result.map_err(|error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("read archive entry: {error}"),
                )
            })?;
            let entry_type = entry.header().entry_type();
            if is_archive_metadata(entry_type) {
                continue;
            }
            entries += 1;
            if entries > max_entries {
                return Err(errcode::with_detail(
                    errcode::SIZE_LIMIT,
                    "too many archive entries",
                ));
            }
            let path = archive_entry_path(&entry)?;
            let mut components = path.components();
            let Some(Component::Normal(root)) = components.next() else {
                return Err(errcode::INCOMPLETE.into());
            };
            if root != expected_tag {
                return Err(errcode::with_detail(errcode::INCOMPLETE, expected_tag));
            }
            if components.next().is_none() {
                if entry_type != tar::EntryType::Directory || root_seen {
                    return Err(errcode::INCOMPLETE.into());
                }
                root_seen = true;
            }

            match entry_type {
                tar::EntryType::Regular => {}
                tar::EntryType::Directory => {
                    // a-08: modus kommt per chmod, nicht über die umask. fehlt
                    // u+rwx (z. b. 0o500), scheitern entpacken und aufräumen und
                    // der `.protium-extract-*`-rest blockiert die nächste
                    // installation. abweisen, die rechte nicht anheben. ein
                    // leeres mode-feld lässt `mode()` scheitern; tar chmodet
                    // dann nicht, mkdir behält u+rwx.
                    if let Ok(mode) = entry.header().mode() {
                        if mode & 0o700 != 0o700 {
                            return Err(errcode::with_detail(
                                errcode::INCOMPLETE,
                                format!("directory mode lacks 0o700: {}", path.display()),
                            ));
                        }
                    }
                }
                tar::EntryType::Link => {
                    let target = entry
                        .link_name()
                        .map_err(|error| {
                            errcode::with_detail(
                                errcode::code_for_io(&error),
                                format!("read hardlink target: {error}"),
                            )
                        })?
                        .ok_or_else(|| {
                            errcode::with_detail(errcode::INCOMPLETE, "hardlink target is missing")
                        })?
                        .into_owned();
                    validate_link_target(Path::new(""), &path, &target, "hardlink")?;
                }
                tar::EntryType::Symlink => {
                    let target = entry
                        .link_name()
                        .map_err(|error| {
                            errcode::with_detail(
                                errcode::code_for_io(&error),
                                format!("read symlink target: {error}"),
                            )
                        })?
                        .ok_or_else(|| {
                            errcode::with_detail(errcode::INCOMPLETE, "symlink target is missing")
                        })?
                        .into_owned();
                    validate_link_target(
                        path.parent().unwrap_or(Path::new("")),
                        &path,
                        &target,
                        "symlink",
                    )?;
                    if path.components().count() == 1 {
                        return Err(errcode::SYMLINK_REJECTED.into());
                    }
                }
                _ => {
                    return Err(errcode::with_detail(
                        errcode::INCOMPLETE,
                        format!("archive contains unsupported entry type: {entry_type:?}"),
                    ));
                }
            }

            // header().size() ignoriert die pax-größe, entry.size() nicht.
            total = total.checked_add(entry.size()).ok_or_else(|| {
                errcode::with_detail(errcode::SIZE_LIMIT, "archive size overflow")
            })?;
            if total > max_unpack_bytes {
                return Err(errcode::with_detail(errcode::SIZE_LIMIT, total));
            }
        }
    }
    if !root_seen {
        return Err(errcode::INCOMPLETE.into());
    }
    Ok(())
}

/// wie `extract_blocking_with_tag`, zusätzlich mit Hooks: `before_bind` (Tests)
/// läuft zwischen Stat und Open der Parent-Bindung, `guard_rename` bekommt den
/// finalen Installations-Rename und führt ihn aus, etwa unter dem
/// Environment-Mutex. Ein Fehler davor (etwa ein gewechselter Steam-Root)
/// bricht ab, ohne umzubenennen.
#[allow(clippy::too_many_arguments)]
pub(super) fn extract_blocking_with_tag_with_hook(
    file: &mut fs::File,
    dest_dir: &str,
    expected_tag: Option<&str>,
    max_unpack_bytes: u64,
    max_entries: usize,
    scope_ok: &dyn Fn(&Path) -> bool,
    cancel: &CancelSignal,
    before_bind: &mut dyn FnMut(),
    guard_rename: &mut RenameGuard<'_>,
) -> Result<(), String> {
    let dest = Path::new(dest_dir);
    let dest_ancestor_canon = canonicalize_nearest_ancestor(dest, "extract dest")?;
    if !scope_ok(&dest_ancestor_canon) {
        return Err(errcode::BLOCKED_LOCATION.into());
    }
    fs::create_dir_all(dest).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("create extract destination: {error}"),
        )
    })?;
    let dest_canon = fs::canonicalize(dest).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("canonicalize extract destination: {error}"),
        )
    })?;
    if !dest_canon.is_dir() || !is_safe_path(&dest_canon.to_string_lossy()) {
        return Err(errcode::BLOCKED_LOCATION.into());
    }

    let expected_tag = expected_tag.ok_or_else(|| {
        errcode::with_detail(errcode::INVALID_ID, "archive install name is required")
    })?;
    if expected_tag.is_empty()
        || expected_tag.contains('\0')
        || expected_tag.contains('/')
        || expected_tag.contains('\\')
        || !matches!(
            Path::new(expected_tag)
                .components()
                .collect::<Vec<_>>()
                .as_slice(),
            [Component::Normal(_)]
        )
    {
        return Err(errcode::INVALID_ID.into());
    }
    let target = dest_canon.join(expected_tag);
    if path_exists_without_following(&target) {
        return Err(errcode::with_detail(errcode::TOOL_EXISTS, "extract target"));
    }

    validate_archive_entries(file, expected_tag, max_unpack_bytes, max_entries, cancel)?;

    extract_archive_into_bound_parent(
        file,
        &dest_canon,
        expected_tag,
        max_unpack_bytes,
        cancel,
        before_bind,
        guard_rename,
    )
}

/// Zweiter Archiv-Pass mit Mutation. Der autorisierte `compatibilitytools.d`-
/// Parent bleibt von der Bindung bis zum finalen Rename deskriptorgebunden:
/// Temp-Anlage, Entpacken und der Installations-Rename laufen über den
/// gebundenen Deskriptor (`/proc/self/fd`), der finale Rename über
/// `renameat2(RENAME_NOREPLACE)` direkt im Parent-Deskriptor. Ein Parent- oder
/// Ziel-Tausch installiert dadurch nie außerhalb dieses Parents und
/// überschreibt kein zwischenzeitlich aufgetauchtes Ziel. Fehler und Cancel
/// räumen das Temp-Verzeichnis auf; ein Crash hinterlässt einen sichtbaren
/// `.protium-extract-*`-Rest, den der nächste Lauf meldet statt löscht.
#[cfg(target_os = "linux")]
fn extract_archive_into_bound_parent(
    file: &mut fs::File,
    dest_canon: &Path,
    expected_tag: &str,
    max_unpack_bytes: u64,
    cancel: &CancelSignal,
    before_bind: &mut dyn FnMut(),
    guard_rename: &mut RenameGuard<'_>,
) -> Result<(), String> {
    use crate::commands::delete_ops::renameat2_no_replace;
    use crate::commands::fd::{open_bound_root_fd, sync_dir_fd};
    use flate2::read::GzDecoder;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    use tar::Archive;

    let dest_fd = open_bound_root_fd(dest_canon, before_bind)
        .map_err(|error| errcode::with_context("bind extract destination", &error))?;
    let dest_dir_file = fs::File::from(dest_fd);
    let temp_name = format!(
        ".protium-extract-{}-{}",
        std::process::id(),
        random_suffix()
    );
    let temp_path = Path::new("/proc/self/fd")
        .join(dest_dir_file.as_raw_fd().to_string())
        .join(&temp_name);
    fs::create_dir(&temp_path).map_err(|error| {
        errcode::with_detail(
            errcode::code_for_io(&error),
            format!("create extract temp directory: {error}"),
        )
    })?;
    let result = (|| -> Result<(), String> {
        file.seek(SeekFrom::Start(0)).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("rewind archive before extraction: {error}"),
            )
        })?;
        let decoder = GzDecoder::new(&mut *file);
        let mut archive = Archive::new(decoder);
        // a-08: explizites chmod (`mode & 0o777`) umgeht die prozess-umask.
        // 0o022 nimmt gruppen- und weltschreibrechte, ein 0o777-binary wird 0o755.
        archive.set_mask(0o022);
        let mut total = 0u64;
        for entry_result in archive.entries().map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("read archive: {error}"),
            )
        })? {
            if cancel.is_cancelled() {
                return Err(errcode::CANCELLED.into());
            }
            let mut entry = entry_result.map_err(|error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("read archive entry: {error}"),
                )
            })?;
            if is_archive_metadata(entry.header().entry_type()) {
                continue;
            }
            total = total.checked_add(entry.size()).ok_or_else(|| {
                errcode::with_detail(errcode::SIZE_LIMIT, "archive size overflow")
            })?;
            if total > max_unpack_bytes {
                return Err(errcode::with_detail(errcode::SIZE_LIMIT, total));
            }
            entry.unpack_in(&temp_path).map_err(|error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("unpack archive entry: {error}"),
                )
            })?;
        }
        if cancel.is_cancelled() {
            return Err(errcode::CANCELLED.into());
        }
        let unpacked = temp_path.join(expected_tag);
        let metadata = fs::symlink_metadata(&unpacked).map_err(|error| {
            errcode::with_detail(
                errcode::code_for_io(&error),
                format!("inspect extracted top-level directory: {error}"),
            )
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(errcode::INCOMPLETE.into());
        }
        ensure_extracted_symlinks_stay_inside(&unpacked)?;
        if path_exists_without_following(&dest_canon.join(expected_tag)) {
            return Err(errcode::TOOL_EXISTS.into());
        }
        let mut relative_source = PathBuf::from(&temp_name);
        relative_source.push(expected_tag);
        guard_rename(&mut || {
            renameat2_no_replace(
                &dest_dir_file,
                relative_source.as_os_str(),
                &dest_dir_file,
                std::ffi::OsStr::from_bytes(expected_tag.as_bytes()),
            )
            .map_err(|error| {
                errcode::with_detail(
                    errcode::code_for_io(&error),
                    format!("atomically install extracted tool: {error}"),
                )
            })
        })?;
        // r-08: ohne verzeichnis-fsync kann die tool-installation nach absturz
        // driftig sichtbar sein. quell- und zielendpunkt des renames liegen
        // beide in dest_dir_file, ein sync deckt den neuen dirent ab; ein
        // zusätzlicher sync des temp-verzeichnisses hätte keine wirkung, weil
        // es direkt danach entfernt wird. ein sync-fehler meldet die möglich
        // angewandte mutation statt "nichts passiert"
        sync_dir_fd(dest_dir_file.as_raw_fd()).map_err(|error| {
            errcode::with_detail(
                errcode::WRITE_UNCERTAIN,
                format!("extract target sync: {error}"),
            )
        })?;
        Ok(())
    })();
    let _ = fs::remove_dir_all(&temp_path);
    result
}

#[cfg(not(target_os = "linux"))]
fn extract_archive_into_bound_parent(
    _file: &mut fs::File,
    _dest_canon: &Path,
    _expected_tag: &str,
    _max_unpack_bytes: u64,
    _cancel: &CancelSignal,
    _before_bind: &mut dyn FnMut(),
    _guard_rename: &mut RenameGuard<'_>,
) -> Result<(), String> {
    Err(errcode::UNSUPPORTED_PLATFORM.into())
}

#[cfg(test)]
mod tests {
    use super::{
        extract_archive_into_bound_parent, extract_blocking_with_tag,
        extract_blocking_with_tag_with_hook, validate_archive_entries, MAX_ARCHIVE_ENTRIES,
    };
    use crate::commands::download::CancelSignal;
    use crate::commands::errcode;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn fixture(
        tag: &str,
        build: impl FnOnce(&mut tar::Builder<flate2::write::GzEncoder<&mut Vec<u8>>>),
    ) -> (PathBuf, PathBuf) {
        let mut bytes = Vec::new();
        {
            let encoder = flate2::write::GzEncoder::new(&mut bytes, flate2::Compression::default());
            let mut archive = tar::Builder::new(encoder);
            build(&mut archive);
            archive.finish().unwrap();
        }
        let root =
            std::env::temp_dir().join(format!("protium-extract-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("download");
        File::create(&source).unwrap().write_all(&bytes).unwrap();
        let destination = root.join("compatibilitytools.d");
        fs::create_dir(&destination).unwrap();
        (source, destination)
    }

    fn directory_header(path: &str) -> tar::Header {
        let mut header = tar::Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_cksum();
        header
    }

    #[test]
    fn handle_extractor_installiert_exakten_top_level_ordner() {
        let (source, destination) = fixture("valid", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            let mut file = tar::Header::new_gnu();
            file.set_path("GE-Proton11-5-x86_64/version").unwrap();
            file.set_size(3);
            file.set_cksum();
            archive.append(&file, &b"ok\n"[..]).unwrap();
        });
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        let result = extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel,
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            fs::read_to_string(destination.join("GE-Proton11-5-x86_64/version")).unwrap(),
            "ok\n"
        );
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn handle_extractor_lehnt_flaches_archiv_ab() {
        let (source, destination) = fixture("flat", |archive| {
            let mut file = tar::Header::new_gnu();
            file.set_path("version").unwrap();
            file.set_size(2);
            file.set_cksum();
            archive.append(&file, &b"ok"[..]).unwrap();
        });
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel
        )
        .is_err());
        assert!(!destination.join("GE-Proton11-5-x86_64").exists());
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn handle_extractor_lehnt_fremden_top_level_ordner_ab() {
        let (source, destination) = fixture("wrong-root", |archive| {
            archive
                .append(&directory_header("Other"), std::io::empty())
                .unwrap();
        });
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel
        )
        .is_err());
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn handle_extractor_lehnt_top_level_symlink_ab() {
        let (source, destination) = fixture("top-symlink", |archive| {
            let mut link = tar::Header::new_gnu();
            link.set_path("GE-Proton11-5-x86_64").unwrap();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_link_name("/etc").unwrap();
            link.set_size(0);
            link.set_cksum();
            archive.append(&link, std::io::empty()).unwrap();
        });
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel
        )
        .is_err());
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn handle_extractor_lehnt_mehrere_top_level_ordner_ab() {
        let (source, destination) = fixture("multiple-roots", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            archive
                .append(&directory_header("Other"), std::io::empty())
                .unwrap();
        });
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel
        )
        .is_err());
        assert!(!destination.join("GE-Proton11-5-x86_64").exists());
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn handle_extractor_ueberschreibt_keinen_bestehenden_target_ordner() {
        let (source, destination) = fixture("existing", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
        });
        let target = destination.join("GE-Proton11-5-x86_64");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("sentinel"), b"keep").unwrap();
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel
        )
        .is_err());
        assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"keep");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn handle_extractor_parent_tausch_vor_rename_installiert_in_gebundenen_parent() {
        use std::os::unix::fs::symlink;

        // compatibilitytools.d wird unmittelbar vor dem finalen rename durch
        // einen symlink auf einen fremden ordner ersetzt: die installation
        // landet im gebundenen alten parent, der fremde baum bleibt leer.
        let (source, destination) = fixture("swap-rename", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            let mut file = tar::Header::new_gnu();
            file.set_path("GE-Proton11-5-x86_64/version").unwrap();
            file.set_size(3);
            file.set_cksum();
            archive.append(&file, &b"ok\n"[..]).unwrap();
        });
        let moved = destination.with_extension("moved");
        let evil = destination.with_extension("evil");
        let _ = fs::remove_dir_all(&evil);
        fs::create_dir_all(&evil).unwrap();
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        let mut guard_rename = |rename: &mut dyn FnMut() -> Result<(), String>| {
            fs::rename(&destination, &moved).unwrap();
            symlink(&evil, &destination).unwrap();
            assert!(!moved.join("GE-Proton11-5-x86_64").exists());
            let renamed = rename();
            assert!(
                moved.join("GE-Proton11-5-x86_64").exists(),
                "rename im guard"
            );
            renamed
        };
        let result = extract_blocking_with_tag_with_hook(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            MAX_ARCHIVE_ENTRIES,
            &|_| true,
            &no_cancel,
            &mut || {},
            &mut guard_rename,
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            fs::read_to_string(moved.join("GE-Proton11-5-x86_64/version")).unwrap(),
            "ok\n"
        );
        assert!(
            !evil.join("GE-Proton11-5-x86_64").exists(),
            "fremder baum darf nichts erhalten"
        );
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn handle_extractor_parent_tausch_zwischen_stat_und_open_bricht_ab() {
        let (source, destination) = fixture("swap-bind", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
        });
        let moved = destination.with_extension("moved");
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        let mut before_bind = || {
            fs::rename(&destination, &moved).unwrap();
            fs::create_dir_all(&destination).unwrap();
        };
        let result = extract_blocking_with_tag_with_hook(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            MAX_ARCHIVE_ENTRIES,
            &|_| true,
            &no_cancel,
            &mut before_bind,
            &mut |rename| rename(),
        );
        assert!(
            result.is_err(),
            "tausch zwischen stat und open muss abbrechen: {result:?}"
        );
        assert!(
            result.unwrap_err().contains("changed while opening"),
            "meldung soll die bindung nennen"
        );
        assert!(!moved.join("GE-Proton11-5-x86_64").exists());
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn handle_extractor_cancel_raeumt_temp_auf_und_laesst_kein_ziel() {
        let (source, destination) = fixture("cancel-extract", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            let mut file = tar::Header::new_gnu();
            file.set_path("GE-Proton11-5-x86_64/version").unwrap();
            file.set_size(3);
            file.set_cksum();
            archive.append(&file, &b"ok\n"[..]).unwrap();
        });
        let mut handle = File::open(&source).unwrap();
        let cancel = CancelSignal::new();
        // cancel wird erst im zweiten pass gesetzt (nach der validierung):
        // der erste entry-check bricht ab, das temp wird aufgeräumt.
        let mut before_bind = || cancel.cancel();
        let result = extract_blocking_with_tag_with_hook(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            MAX_ARCHIVE_ENTRIES,
            &|_| true,
            &cancel,
            &mut before_bind,
            &mut |rename| rename(),
        );
        assert_eq!(result.unwrap_err(), "cancelled");
        assert!(!destination.join("GE-Proton11-5-x86_64").exists());
        let leftovers: Vec<_> = fs::read_dir(&destination)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".protium-extract-")
            })
            .collect();
        assert!(leftovers.is_empty(), "cancel muss das temp aufräumen");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn installations_rename_synchronisiert_das_zielverzeichnis() {
        // r-08: der installations-rename braucht nach der mutation ein
        // verzeichnis-fsync auf dem ziel-dirent. der fsync-fehlerpfad ist ohne
        // injektionshaken nicht testbar (prüflücke); dieser statische beleg
        // fällt beim verlust des syncs auf.
        let production = crate::commands::test_util::production_source(include_str!("extract.rs"));
        let rename = production
            .find("renameat2_no_replace(")
            .expect("installations-rename muss vorhanden sein");
        assert!(
            production[rename..].contains("sync_dir_fd(dest_dir_file.as_raw_fd())"),
            "installations-rename braucht ein verzeichnis-fsync auf dem ziel"
        );
    }

    // ---- erster durchgang: link-ziele, pfadguard und der größen-cap ----

    fn first_pass(source: &Path, tag: &str, cap: u64) -> Result<(), String> {
        let mut handle = File::open(source).unwrap();
        let no_cancel = CancelSignal::new();
        validate_archive_entries(&mut handle, tag, cap, MAX_ARCHIVE_ENTRIES, &no_cancel)
    }

    /// Baut ein gzip-tar mit einem oder zwei einträgen und erlaubt es, den
    /// 512-byte-kopf des letzten eintrags VOR dem gzip zu verändern (name,
    /// größenfeld, …). Nötig, weil der builder `..`-namen und unlesbare
    /// größenfelder selbst ablehnt. `root_dir` legt einen gültigen
    /// toplevel-ordner als ersten eintrag davor (dann liegt der gepatchte kopf
    /// bei offset 512). Die prüfsumme wird über den gepatchten kopf neu gebildet.
    fn tampered_archive(
        tag: &str,
        root_dir: Option<&str>,
        header: &tar::Header,
        data: &[u8],
        patch: impl FnOnce(&mut [u8]),
    ) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("protium-extract-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("download");

        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            if let Some(dir) = root_dir {
                builder
                    .append(&directory_header(dir), std::io::empty())
                    .unwrap();
            }
            builder.append(header, data).unwrap();
            builder.finish().unwrap();
        }
        let at = if root_dir.is_some() { 512 } else { 0 };
        patch(&mut tar_bytes[at..at + 512]);
        let mut sum: u32 = 0;
        for (index, byte) in tar_bytes[at..at + 512].iter().enumerate() {
            let value = if (148..156).contains(&index) {
                b' '
            } else {
                *byte
            };
            sum += u32::from(value);
        }
        let cksum = format!("{sum:06o}\0 ");
        tar_bytes[at + 148..at + 156].copy_from_slice(cksum.as_bytes());

        let file = File::create(&source).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap();
        source
    }

    /// A-02: das ziel eines tar-`Link` ist archivwurzel-relativ. Mit
    /// `path.parent()` als basis galt `../../etc/passwd` aus einem tiefen
    /// link-pfad als „innerhalb" (tiefe 2 − 2 + 2 = 2 > 0); die vorfilterung war
    /// für hardlinks damit wirkungslos.
    #[test]
    fn erster_durchgang_lehnt_hardlink_ausbruch_ab() {
        let (source, _destination) = fixture("hardlink-escape", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            let mut link = tar::Header::new_gnu();
            link.set_path("GE-Proton11-5-x86_64/a/b.lnk").unwrap();
            link.set_entry_type(tar::EntryType::Link);
            link.set_link_name("../../etc/passwd").unwrap();
            link.set_size(0);
            link.set_cksum();
            archive.append(&link, std::io::empty()).unwrap();
        });

        let error = first_pass(&source, "GE-Proton11-5-x86_64", 1024).unwrap_err();
        assert!(errcode::has_code(&error, errcode::INCOMPLETE), "{error}");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// Gegenprobe zu A-02: ein hardlink auf ein ziel innerhalb des archivs
    /// bleibt erlaubt, auch aus einem unterordner.
    #[test]
    fn erster_durchgang_erlaubt_hardlink_auf_archivinternes_ziel() {
        let (source, _destination) = fixture("hardlink-inside", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            let mut file = tar::Header::new_gnu();
            file.set_path("GE-Proton11-5-x86_64/real.txt").unwrap();
            file.set_size(3);
            file.set_cksum();
            archive.append(&file, &b"ok\n"[..]).unwrap();
            let mut link = tar::Header::new_gnu();
            link.set_path("GE-Proton11-5-x86_64/a/b.lnk").unwrap();
            link.set_entry_type(tar::EntryType::Link);
            link.set_link_name("GE-Proton11-5-x86_64/real.txt").unwrap();
            link.set_size(0);
            link.set_cksum();
            archive.append(&link, std::io::empty()).unwrap();
        });

        let result = first_pass(&source, "GE-Proton11-5-x86_64", 1024);
        assert!(result.is_ok(), "{result:?}");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// a-p1-1-rest: leere einträge zählen gegen das eintrags-cap. genau an der
    /// grenze installiert, ein eintrag darüber bricht im ersten durchgang ab,
    /// ohne ziel und ohne temp-rest.
    #[test]
    fn eintrags_cap_stoppt_leere_eintraege_vor_dem_entpacken() {
        for (cap, allowed) in [(4usize, true), (3, false)] {
            let (source, destination) = fixture(&format!("entry-cap-{cap}"), |archive| {
                archive
                    .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                    .unwrap();
                for index in 0..3 {
                    let mut file = tar::Header::new_gnu();
                    file.set_path(format!("GE-Proton11-5-x86_64/leer-{index}"))
                        .unwrap();
                    file.set_size(0);
                    file.set_cksum();
                    archive.append(&file, std::io::empty()).unwrap();
                }
            });
            let mut handle = File::open(&source).unwrap();
            let result = extract_blocking_with_tag_with_hook(
                &mut handle,
                destination.to_str().unwrap(),
                Some("GE-Proton11-5-x86_64"),
                1024,
                cap,
                &|_| true,
                &CancelSignal::new(),
                &mut || {},
                &mut |rename| rename(),
            );
            if allowed {
                assert!(result.is_ok(), "{result:?}");
            } else {
                let error = result.unwrap_err();
                assert!(errcode::has_code(&error, errcode::SIZE_LIMIT), "{error}");
                assert!(error.contains("too many archive entries"), "{error}");
                assert!(!destination.join("GE-Proton11-5-x86_64").exists());
            }
            assert_no_extract_leftovers(&destination);
            let _ = fs::remove_dir_all(source.parent().unwrap());
        }
    }

    /// A-13: der cap gilt für die summe der angesagten größen. Genau an der
    /// grenze bleibt erlaubt, ein byte darüber nicht.
    #[test]
    fn erster_durchgang_haelt_den_groessen_cap_exakt_ein() {
        for (size, allowed) in [(1024usize, true), (1025, false)] {
            let (source, _destination) = fixture(&format!("size-cap-{size}"), |archive| {
                archive
                    .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                    .unwrap();
                let mut file = tar::Header::new_gnu();
                file.set_path("GE-Proton11-5-x86_64/payload.bin").unwrap();
                file.set_size(u64::try_from(size).unwrap());
                file.set_cksum();
                archive.append(&file, vec![0u8; size].as_slice()).unwrap();
            });

            let result = first_pass(&source, "GE-Proton11-5-x86_64", 1024);
            if allowed {
                assert!(result.is_ok(), "{result:?}");
            } else {
                let error = result.unwrap_err();
                assert!(errcode::has_code(&error, errcode::SIZE_LIMIT), "{error}");
            }
            let _ = fs::remove_dir_all(source.parent().unwrap());
        }
    }

    /// Schreibt `name` samt NUL-terminator als namensfeld des ersten kopfs. Die
    /// länge kommt aus der quelle, damit ein zählfehler nicht als fixture-panik
    /// auftaucht statt als assertion.
    fn patch_name(raw: &mut [u8], name: &[u8]) {
        raw[..name.len()].copy_from_slice(name);
        raw[name.len()] = 0;
    }

    /// A-13: ein pfad außerhalb der wurzel wird abgewiesen, bevor irgendetwas
    /// geschrieben wird (erste schranke gegen zip-slip). Der name ist
    /// verschachtelt (`<tag>/../escape`), damit genau die `ParentDir`-klausel in
    /// `archive_entry_path` geprüft wird und nicht schon die wurzelprüfung
    /// greift. `set_path` lehnt `..` ab, deshalb wird der name im rohstrom
    /// gepatcht.
    #[test]
    fn erster_durchgang_lehnt_pfad_ausserhalb_der_wurzel_ab() {
        let mut header = tar::Header::new_gnu();
        header.set_path("GE-Proton11-5-x86_64/platzhalter").unwrap();
        header.set_size(3);
        header.set_cksum();
        let source = tampered_archive(
            "zip-slip",
            Some("GE-Proton11-5-x86_64"),
            &header,
            b"bad",
            |raw| {
                patch_name(raw, b"GE-Proton11-5-x86_64/../escape");
            },
        );

        let error = first_pass(&source, "GE-Proton11-5-x86_64", 1024).unwrap_err();
        assert!(errcode::has_code(&error, errcode::INCOMPLETE), "{error}");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// A-13: ein symlink, dessen ziel aus dem archiv herauszeigt, wird
    /// abgewiesen (ziel relativ zum verzeichnis des links).
    #[test]
    fn erster_durchgang_lehnt_symlink_ausbruch_ab() {
        let (source, _destination) = fixture("symlink-escape", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            let mut link = tar::Header::new_gnu();
            link.set_path("GE-Proton11-5-x86_64/a/link").unwrap();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_link_name("../../../outside").unwrap();
            link.set_size(0);
            link.set_cksum();
            archive.append(&link, std::io::empty()).unwrap();
        });

        let error = first_pass(&source, "GE-Proton11-5-x86_64", 1024).unwrap_err();
        assert!(errcode::has_code(&error, errcode::INCOMPLETE), "{error}");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// Producer 8 (A-04): ein link-eintrag ohne ziel wird mit `incomplete`
    /// abgewiesen, nicht mit einer rohmeldung.
    #[test]
    fn erster_durchgang_meldet_leeres_linkziel_mit_code() {
        for entry_type in [tar::EntryType::Link, tar::EntryType::Symlink] {
            let (source, _destination) = fixture("empty-link-target", |archive| {
                archive
                    .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                    .unwrap();
                let mut link = tar::Header::new_gnu();
                link.set_path("GE-Proton11-5-x86_64/leer.lnk").unwrap();
                link.set_entry_type(entry_type);
                // kein set_link_name: das feld bleibt leer, `link_name()` liefert
                // damit `Ok(None)`.
                link.set_size(0);
                link.set_cksum();
                archive.append(&link, std::io::empty()).unwrap();
            });

            let error = first_pass(&source, "GE-Proton11-5-x86_64", 1024).unwrap_err();
            assert!(errcode::has_code(&error, errcode::INCOMPLETE), "{error}");
            let _ = fs::remove_dir_all(source.parent().unwrap());
        }
    }

    /// A-04/8, pin: ein kaputter eintragskopf wird als codiertes `unreadable`
    /// gemeldet. Gemessen kommt der fehler aus dem iterator
    /// (`read archive entry: numeric field was not a number …`), weil die
    /// `tar`-kiste das größenfeld schon beim header-lesen prüft. Die prüfsumme
    /// des gepatchten kopfs wird neu gebildet, damit nicht schon sie den
    /// eintrag verwirft.
    #[test]
    fn erster_durchgang_meldet_kaputten_eintragskopf_mit_code() {
        let mut header = tar::Header::new_gnu();
        header.set_path("GE-Proton11-5-x86_64/payload.bin").unwrap();
        header.set_size(3);
        header.set_cksum();
        let source = tampered_archive("bad-entry-size", None, &header, b"ok", |raw| {
            // das größenfeld sind die 12 byte ab offset 124.
            raw[124..135].copy_from_slice(b"xxxxxxxxxxx");
        });

        let error = first_pass(&source, "GE-Proton11-5-x86_64", 1024).unwrap_err();
        assert!(errcode::has_code(&error, errcode::UNREADABLE), "{error}");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// header-größe 0, pax-`size` 4096, leerer body. der iterator springt um
    /// die pax-größe weiter; ohne die nullen danach endet der strom vor dem
    /// sprung und der durchgang scheitert an eof statt am cap.
    fn pax_size_archive(tag: &str) -> (PathBuf, PathBuf) {
        fixture(tag, |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            let pax: [(&str, &[u8]); 1] = [("size", b"4096")];
            archive.append_pax_extensions(pax).unwrap();
            let mut file = tar::Header::new_gnu();
            file.set_path("GE-Proton11-5-x86_64/payload.bin").unwrap();
            file.set_size(0);
            file.set_cksum();
            archive.append(&file, std::io::empty()).unwrap();
            archive.get_mut().write_all(&[0u8; 4096]).unwrap();
        })
    }

    fn assert_payload_header_zero_pax_4096(source: &Path) {
        use flate2::read::GzDecoder;
        use tar::Archive;

        let mut handle = File::open(source).unwrap();
        let decoder = GzDecoder::new(&mut handle);
        let mut archive = Archive::new(decoder);
        let mut saw_payload = false;
        for entry_result in archive.entries().unwrap() {
            let entry = entry_result.expect("fixture muss bis zum payload lesbar sein");
            if super::is_archive_metadata(entry.header().entry_type()) {
                continue;
            }
            if entry.path().unwrap().ends_with("payload.bin") {
                assert_eq!(entry.header().size().unwrap(), 0, "fixture: header-größe");
                assert_eq!(entry.size(), 4096, "fixture: pax-größe");
                saw_payload = true;
                break;
            }
        }
        assert!(saw_payload, "fixture ohne payload.bin");
    }

    /// A-P1-1: der cap sieht die pax-größe. verzeichnisgröße 0, datei 4096.
    #[test]
    fn erster_durchgang_zaehlt_pax_groesse_gegen_den_cap() {
        let (source, _destination) = pax_size_archive("pax-size-first");
        assert_payload_header_zero_pax_4096(&source);

        let limited = first_pass(&source, "GE-Proton11-5-x86_64", 1024).unwrap_err();
        assert!(
            errcode::has_code(&limited, errcode::SIZE_LIMIT),
            "{limited}"
        );

        let allowed = first_pass(&source, "GE-Proton11-5-x86_64", 4096);
        assert!(allowed.is_ok(), "{allowed:?}");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// A-P1-1: der zweite durchgang zählt vor `unpack_in`. über dem cap kommt
    /// `size-limit-exceeded`, nicht ein kurzer read, und die datei bleibt weg.
    #[test]
    fn zweiter_durchgang_lehnt_pax_groesse_vor_dem_entpacken_ab() {
        let (source, destination) = pax_size_archive("pax-size-second");
        assert_payload_header_zero_pax_4096(&source);
        let mut handle = File::open(&source).unwrap();
        let dest_canon = fs::canonicalize(&destination).unwrap();
        let no_cancel = CancelSignal::new();
        let error = extract_archive_into_bound_parent(
            &mut handle,
            &dest_canon,
            "GE-Proton11-5-x86_64",
            1024,
            &no_cancel,
            &mut || {},
            &mut |rename| rename(),
        )
        .unwrap_err();
        assert!(errcode::has_code(&error, errcode::SIZE_LIMIT), "{error}");
        assert!(!errcode::has_code(&error, errcode::UNREADABLE), "{error}");
        assert!(!destination
            .join("GE-Proton11-5-x86_64/payload.bin")
            .exists());
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    fn directory_header_with_mode(path: &str, mode: u32) -> tar::Header {
        let mut header = directory_header(path);
        header.set_mode(mode);
        header.set_cksum();
        header
    }

    fn assert_no_extract_leftovers(destination: &Path) {
        let leftovers: Vec<_> = fs::read_dir(destination)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".protium-extract-")
            })
            .collect();
        assert!(leftovers.is_empty(), "temp-rest muss weg sein");
    }

    /// a-08: `set_mask(0o022)` zieht gruppen- und weltschreibrechte ab.
    /// 0o777 wird 0o755, das verzeichnis mit 0o755 bleibt installierbar.
    #[test]
    fn entpacken_maskiert_weltschreibbares_binary() {
        use std::os::unix::fs::PermissionsExt;

        let (source, destination) = fixture("mask-binary", |archive| {
            archive
                .append(
                    &directory_header_with_mode("GE-Proton11-5-x86_64", 0o755),
                    std::io::empty(),
                )
                .unwrap();
            let mut file = tar::Header::new_gnu();
            file.set_path("GE-Proton11-5-x86_64/proton").unwrap();
            file.set_mode(0o777);
            file.set_size(3);
            file.set_cksum();
            archive.append(&file, &b"ok\n"[..]).unwrap();
        });
        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        let result = extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel,
        );
        assert!(result.is_ok(), "{result:?}");
        let mode = fs::metadata(destination.join("GE-Proton11-5-x86_64/proton"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o755,
            "0o777 darf nicht stehen bleiben: {mode:o}"
        );
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// a-08: verzeichnis ohne u+rwx wird im ersten durchgang abgewiesen.
    /// nichts wird entpackt, kein `.protium-extract-*`-rest.
    #[test]
    fn erster_durchgang_lehnt_verzeichnis_ohne_0700_ab() {
        let (source, destination) = fixture("dir-mode-0500", |archive| {
            archive
                .append(
                    &directory_header_with_mode("GE-Proton11-5-x86_64", 0o755),
                    std::io::empty(),
                )
                .unwrap();
            archive
                .append(
                    &directory_header_with_mode("GE-Proton11-5-x86_64/compat", 0o500),
                    std::io::empty(),
                )
                .unwrap();
        });
        let error = first_pass(&source, "GE-Proton11-5-x86_64", 1024).unwrap_err();
        assert!(errcode::has_code(&error, errcode::INCOMPLETE), "{error}");
        assert!(error.contains("0o700"), "{error}");

        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        let installed = extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel,
        );
        let installed = installed.unwrap_err();
        assert!(
            errcode::has_code(&installed, errcode::INCOMPLETE),
            "{installed}"
        );
        assert!(!destination.join("GE-Proton11-5-x86_64").exists());
        assert_no_extract_leftovers(&destination);
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// Gegenprobe zu a-09: interne links, wie echte builds sie tragen
    /// (datei-link, verzeichnis-link, `../x` im baum, `.`), installieren.
    #[test]
    fn entpacken_installiert_legitime_interne_symlinks() {
        fn link(path: &str, target: &str) -> tar::Header {
            let mut header = tar::Header::new_gnu();
            header.set_path(path).unwrap();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_link_name(target).unwrap();
            header.set_size(0);
            header.set_cksum();
            header
        }
        const TAG: &str = "GE-Proton11-5-x86_64";
        let (source, destination) = fixture("symlink-legit", |archive| {
            for dir in ["", "/files", "/files/lib"] {
                archive
                    .append(&directory_header(&format!("{TAG}{dir}")), std::io::empty())
                    .unwrap();
            }
            for (path, data) in [("version", &b"ok\n"[..]), ("files/lib/libfoo.so.1", b"lib")] {
                let mut file = tar::Header::new_gnu();
                file.set_path(format!("{TAG}/{path}")).unwrap();
                file.set_size(data.len() as u64);
                file.set_cksum();
                archive.append(&file, data).unwrap();
            }
            for (path, target) in [
                ("files/lib/libfoo.so", "libfoo.so.1"),
                ("files/lib64", "lib"),
                ("files/version", "../version"),
                ("self", "."),
            ] {
                archive
                    .append(&link(&format!("{TAG}/{path}"), target), std::io::empty())
                    .unwrap();
            }
        });

        let mut handle = File::open(&source).unwrap();
        let result = extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some(TAG),
            1024,
            &|_| true,
            &CancelSignal::new(),
        );
        assert!(result.is_ok(), "{result:?}");
        let tool = destination.join(TAG);
        let read = |path: &str| fs::read_to_string(tool.join(path)).unwrap();
        assert_eq!(
            fs::read_link(tool.join("files/lib/libfoo.so")).unwrap(),
            Path::new("libfoo.so.1")
        );
        assert_eq!(read("files/lib/libfoo.so"), "lib");
        assert_eq!(read("files/lib64/libfoo.so.1"), "lib");
        assert_eq!(read("files/version"), "ok\n");
        assert_eq!(
            fs::canonicalize(tool.join("self")).unwrap(),
            fs::canonicalize(&tool).unwrap()
        );
        assert_no_extract_leftovers(&destination);
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// a-09: `a/l -> ..`, `m -> a/l/..` bleibt lexikalisch im baum und zeigt
    /// aufgelöst auf das temp-verzeichnis über `<temp>/<tag>`.
    #[test]
    fn entpacken_lehnt_symlink_kette_aus_dem_baum_ab() {
        let (source, destination) = fixture("symlink-chain", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            archive
                .append(
                    &directory_header("GE-Proton11-5-x86_64/a"),
                    std::io::empty(),
                )
                .unwrap();
            let mut link = tar::Header::new_gnu();
            link.set_path("GE-Proton11-5-x86_64/a/l").unwrap();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_link_name("..").unwrap();
            link.set_size(0);
            link.set_cksum();
            archive.append(&link, std::io::empty()).unwrap();
            let mut out = tar::Header::new_gnu();
            out.set_path("GE-Proton11-5-x86_64/m").unwrap();
            out.set_entry_type(tar::EntryType::Symlink);
            out.set_link_name("a/l/..").unwrap();
            out.set_size(0);
            out.set_cksum();
            archive.append(&out, std::io::empty()).unwrap();
        });

        let lexical = first_pass(&source, "GE-Proton11-5-x86_64", 1024);
        assert!(
            lexical.is_ok(),
            "kette muss lexikalisch im baum bleiben: {lexical:?}"
        );

        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        let error = extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel,
        )
        .unwrap_err();
        assert!(
            errcode::has_code(&error, errcode::SYMLINK_REJECTED),
            "{error}"
        );
        assert!(error.contains("symlink target leaves archive"), "{error}");
        assert!(!destination.join("GE-Proton11-5-x86_64").exists());
        assert!(
            destination.exists(),
            "zielordner darf nicht mitgelöscht werden"
        );
        assert_no_extract_leftovers(&destination);
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }

    /// a-09: ein dangling symlink bleibt lexikalisch im baum, lässt sich aber
    /// nicht auflösen; derselbe code wie beim ausbruch, kein temp-rest.
    #[test]
    fn entpacken_lehnt_dangling_symlink_ab() {
        let (source, destination) = fixture("symlink-dangling", |archive| {
            archive
                .append(&directory_header("GE-Proton11-5-x86_64"), std::io::empty())
                .unwrap();
            let mut link = tar::Header::new_gnu();
            link.set_path("GE-Proton11-5-x86_64/l").unwrap();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_link_name("fehlt").unwrap();
            link.set_size(0);
            link.set_cksum();
            archive.append(&link, std::io::empty()).unwrap();
        });

        let lexical = first_pass(&source, "GE-Proton11-5-x86_64", 1024);
        assert!(
            lexical.is_ok(),
            "ziel muss lexikalisch im baum bleiben: {lexical:?}"
        );

        let mut handle = File::open(&source).unwrap();
        let no_cancel = CancelSignal::new();
        let error = extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
            &no_cancel,
        )
        .unwrap_err();
        assert!(
            errcode::has_code(&error, errcode::SYMLINK_REJECTED),
            "{error}"
        );
        assert!(error.contains("resolve symlink"), "{error}");
        assert!(!destination.join("GE-Proton11-5-x86_64").exists());
        assert_no_extract_leftovers(&destination);
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }
}
