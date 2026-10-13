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
#[path = "extract_tests.rs"]
mod tests;
