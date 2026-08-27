use crate::commands::path::{
    canonicalize_nearest_ancestor, is_safe_path, link_target_stays_inside, random_suffix,
};
use std::fs;
use std::io::{Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

fn archive_entry_path(
    entry: &tar::Entry<'_, flate2::read::GzDecoder<&mut fs::File>>,
) -> Result<PathBuf, String> {
    let path = entry
        .path()
        .map_err(|error| format!("read archive path: {error}"))?
        .into_owned();
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "archive path is not relative and confined: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn validate_link_target(path: &Path, target: &Path, kind: &str) -> Result<(), String> {
    if target.as_os_str().is_empty() {
        return Err(format!("{kind} target is empty"));
    }
    if target.is_absolute()
        || !link_target_stays_inside(path.parent().unwrap_or(Path::new("")), target)
    {
        return Err(format!(
            "{kind} target leaves archive: {} -> {}",
            path.display(),
            target.display()
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

/// validiert und entpackt genau den bereits geöffneten download-handle.
/// kein pfad wird zwischen download, hash und extraction erneut geöffnet.
pub(super) fn extract_blocking_with_tag(
    file: &mut fs::File,
    dest_dir: &str,
    expected_tag: Option<&str>,
    max_unpack_bytes: u64,
    scope_ok: &dyn Fn(&Path) -> bool,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    let dest = Path::new(dest_dir);
    let dest_ancestor_canon = canonicalize_nearest_ancestor(dest, "extract dest")?;
    if !scope_ok(&dest_ancestor_canon) {
        return Err("extract destination outside allowed scope".into());
    }
    fs::create_dir_all(dest).map_err(|error| format!("create extract destination: {error}"))?;
    let dest_canon = fs::canonicalize(dest)
        .map_err(|error| format!("canonicalize extract destination: {error}"))?;
    if !dest_canon.is_dir() || !is_safe_path(&dest_canon.to_string_lossy()) {
        return Err("extract destination in blocked location".into());
    }

    let expected_tag =
        expected_tag.ok_or_else(|| "archive install name is required".to_string())?;
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
        return Err("invalid archive install name".into());
    }
    let target = dest_canon.join(expected_tag);
    if path_exists_without_following(&target) {
        return Err("extract target already exists".into());
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("rewind archive before validation: {error}"))?;
    let mut root_seen = false;
    let mut total = 0u64;
    {
        let decoder = GzDecoder::new(&mut *file);
        let mut archive = Archive::new(decoder);
        for entry_result in archive
            .entries()
            .map_err(|error| format!("read archive: {error}"))?
        {
            let entry = entry_result.map_err(|error| format!("read archive entry: {error}"))?;
            let entry_type = entry.header().entry_type();
            if is_archive_metadata(entry_type) {
                continue;
            }
            let path = archive_entry_path(&entry)?;
            let mut components = path.components();
            let Some(Component::Normal(root)) = components.next() else {
                return Err("archive entry has no top-level directory".into());
            };
            if root != expected_tag {
                return Err(format!("archive top-level directory is not {expected_tag}"));
            }
            if components.next().is_none() {
                if entry_type != tar::EntryType::Directory || root_seen {
                    return Err("archive must contain exactly one top-level directory".into());
                }
                root_seen = true;
            }

            match entry_type {
                tar::EntryType::Regular | tar::EntryType::Directory => {}
                tar::EntryType::Link => {
                    let target = entry
                        .link_name()
                        .map_err(|error| format!("read hardlink target: {error}"))?
                        .ok_or_else(|| "hardlink target is missing".to_string())?
                        .into_owned();
                    validate_link_target(&path, &target, "hardlink")?;
                }
                tar::EntryType::Symlink => {
                    let target = entry
                        .link_name()
                        .map_err(|error| format!("read symlink target: {error}"))?
                        .ok_or_else(|| "symlink target is missing".to_string())?
                        .into_owned();
                    validate_link_target(&path, &target, "symlink")?;
                    if path.components().count() == 1 {
                        return Err("top-level symlink is not allowed".into());
                    }
                }
                _ => {
                    return Err(format!(
                        "archive contains unsupported entry type: {entry_type:?}"
                    ));
                }
            }

            total = total
                .checked_add(
                    entry
                        .header()
                        .size()
                        .map_err(|error| format!("read entry size: {error}"))?,
                )
                .ok_or_else(|| "archive size overflow".to_string())?;
            if total > max_unpack_bytes {
                return Err(format!("extracted size limit exceeded ({total} bytes)"));
            }
        }
    }
    if !root_seen {
        return Err("archive must contain exactly one top-level directory".into());
    }

    let temp = dest_canon.join(format!(
        ".protium-extract-{}-{}",
        std::process::id(),
        random_suffix()
    ));
    fs::create_dir(&temp).map_err(|error| format!("create extract temp directory: {error}"))?;
    let result = (|| -> Result<(), String> {
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("rewind archive before extraction: {error}"))?;
        let decoder = GzDecoder::new(&mut *file);
        let mut archive = Archive::new(decoder);
        for entry_result in archive
            .entries()
            .map_err(|error| format!("read archive: {error}"))?
        {
            let mut entry = entry_result.map_err(|error| format!("read archive entry: {error}"))?;
            if is_archive_metadata(entry.header().entry_type()) {
                continue;
            }
            entry
                .unpack_in(&temp)
                .map_err(|error| format!("unpack archive entry: {error}"))?;
        }
        let unpacked = temp.join(expected_tag);
        let metadata = fs::symlink_metadata(&unpacked)
            .map_err(|error| format!("inspect extracted top-level directory: {error}"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("extracted top-level entry is not a regular directory".into());
        }
        if path_exists_without_following(&target) {
            return Err("extract target appeared during extraction".into());
        }
        fs::rename(&unpacked, &target)
            .map_err(|error| format!("atomically install extracted tool: {error}"))?;
        Ok(())
    })();
    let _ = fs::remove_dir_all(&temp);
    result
}

#[cfg(test)]
mod tests {
    use super::extract_blocking_with_tag;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::PathBuf;

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
        let result = extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true,
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
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true
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
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true
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
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true
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
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true
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
        assert!(extract_blocking_with_tag(
            &mut handle,
            destination.to_str().unwrap(),
            Some("GE-Proton11-5-x86_64"),
            1024,
            &|_| true
        )
        .is_err());
        assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"keep");
        let _ = fs::remove_dir_all(source.parent().unwrap());
    }
}
