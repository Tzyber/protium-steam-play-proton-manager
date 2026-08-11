use std::fs;
use std::path::Path;
use tauri_plugin_fs::FsExt;
use crate::commands::path::{
    canonicalize_nearest_ancestor, is_safe_path, link_target_stays_inside, random_suffix,
    sanitize_path,
};
use crate::commands::spawn_blocking_io;

// ---- R-1: .tar.gz entpacken (extract_blocking) ----

pub(super) fn extract_blocking(
    src: &str,
    dest_dir: &str,
    max_unpack_bytes: u64,
    scope_ok: &dyn Fn(&Path) -> bool,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::io::Seek;
    use tar::Archive;

    let dest = Path::new(dest_dir);
    // scope-check VOR create_dir_all — kein mkdir vor der ablehnung. für
    // nicht-existierende dests prüft der nächste existierende vorfahre.
    let dest_ancestor_canon = canonicalize_nearest_ancestor(dest, "extract dest")?;
    if !scope_ok(&dest_ancestor_canon) {
        return Err("extract destination outside allowed scope".into());
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let canon = fs::canonicalize(dest).map_err(|e| e.to_string())?;
    if !canon.is_dir() || !is_safe_path(&canon.to_string_lossy()) {
        return Err("extract destination in blocked location".into());
    }

    let src_path = Path::new(src);
    let src_canon = fs::canonicalize(src_path).map_err(|e| format!("extract source canonicalize: {e}"))?;
    if !is_safe_path(&src_canon.to_string_lossy()) {
        return Err("extract source in blocked location".into());
    }
    if !src_canon.is_file() {
        return Err("extract source not a regular file".into());
    }

    // unpredictable temp name (pid + nanos) → kein race auf statischen pfad
    let tag = format!(".protium-extract-{}-{}", std::process::id(), random_suffix());
    let tmp = dest.join(&tag);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // symlink-guard: temp-dir darf selbst kein symlink sein (TOCTOU absicherung)
    if fs::symlink_metadata(&tmp)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(true)
    {
        let _ = fs::remove_dir_all(&tmp);
        return Err("temp dir is symlink — extraction aborted".into());
    }

    let result = (|| -> Result<(), String> {
        // pre-check: tar-crate legt block-devices, fifos und char-devices auf
        // linux fall-back als reguläre dateien ab (mknod fehlt ohne CAP_MKNOD,
        // tar fällt auf "treat as regular file" zurück). unsere post-unpack
        // filterung (is_file() || is_dir()) würde sie dann durchlassen. der
        // tar-entry-type ist also die einzige zuverlässige quelle für die
        // entscheidung "ist das ein device?".
        //
        // erlaubt: Regular, Directory, Link (hardlinks — link-target muss
        // innerhalb des archives zeigen, sonst pfad-traversal-leck) und
        // Symlink (legitime lib-versionslinks in GE-tarballs — ausbruch wird
        // lexikalisch via link_target_stays_inside geprüft statt pauschal
        // verboten). alles andere (Block, Char, Fifo, Continuous) wird
        // abgelehnt.
        //
        // post-unpack-filter bleibt als defense-in-depth, ist aber nicht
        // mehr die primäre schutzlinie (filter iteriert nur top-level, ein
        // subdir mit bad entry würde ungeprüft durchkommen).
        // datei EINMAL auf dem kanonischen pfad öffnen — kein TOCTOU
        let f = fs::File::open(&src_canon).map_err(|e| e.to_string())?;
        let mut f2 = f.try_clone().map_err(|e| e.to_string())?;
        {
            let mut ar = Archive::new(GzDecoder::new(f));
            for entry in ar.entries().map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let typ = entry.header().entry_type();
                match typ {
                    tar::EntryType::Regular | tar::EntryType::Directory => {}
                    tar::EntryType::Link => {
                        // hardlink-target muss innerhalb des archives sein.
                        // ein absoluter target oder .. würde aus dem unpack-root
                        // ausbrechen — und da der post-unpack-filter nur top-level
                        // iteriert, würde so ein hardlink in einem subdir ungeprüft
                        // durchkommen. pre-check ist die einzige zuverlässige
                        // schutzlinie für hardlinks.
                        let link_name = entry.link_name().map_err(|e| e.to_string())?;
                        match link_name {
                            None => return Err("hardlink ohne link-target".into()),
                            Some(target) => {
                                if target.as_os_str().is_empty() {
                                    return Err("hardlink-target ist leer".into());
                                }
                                if target.is_absolute() {
                                    return Err(format!(
                                        "hardlink-target ist absolut: {}",
                                        target.display()
                                    ));
                                }
                                if target.components().any(|c| {
                                    matches!(c, std::path::Component::ParentDir)
                                }) {
                                    return Err(format!(
                                        "hardlink-target enthält ..: {}",
                                        target.display()
                                    ));
                                }
                            }
                        }
                    }
                    tar::EntryType::Symlink => {
                        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
                        if path.is_absolute()
                            || path.components().any(|c| matches!(c, std::path::Component::ParentDir))
                        {
                            return Err(format!("symlink-eintragspfad ungültig: {}", path.display()));
                        }
                        let target = entry
                            .link_name()
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| "symlink ohne link-target".to_string())?
                            .into_owned();
                        if target.as_os_str().is_empty() {
                            return Err("symlink-target ist leer".into());
                        }
                        let base = path.parent().unwrap_or_else(|| Path::new(""));
                        if !link_target_stays_inside(base, &target) {
                            return Err(format!(
                                "symlink-target verlässt das archiv: {} -> {}",
                                path.display(),
                                target.display()
                            ));
                        }
                    }
                    _ => {
                        return Err(format!(
                            "tar enthält unerwarteten eintragstyp: {typ:?} (path: {:?})",
                            entry.path()
                        ));
                    }
                }
            }
        }
        // try_clone teilt den file-offset mit dem original — vor dem zweiten
        // durchlauf explizit zurücksetzen. unpack läuft manuell statt
        // ar.unpack: nur so lässt sich ein größenlimit über die deklarierten
        // entry-größen summiert durchsetzen (gzip-bomb-schutz, M1.4).
        f2.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut ar = Archive::new(GzDecoder::new(f2));
        let mut total: u64 = 0;
        for entry in ar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let entry_size = entry.header().size().map_err(|e| e.to_string())?;
            total += entry_size;
            if total > max_unpack_bytes {
                return Err(format!(
                    "extracted size limit exceeded ({total} bytes)"
                ));
            }
            entry.unpack_in(&tmp).map_err(|e| e.to_string())?;
        }
        for entry in fs::read_dir(&tmp).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            // defense-in-depth: post-unpack-filter fängt nochmal alles ab,
            // was kein file und kein dir ist (z. b. symlinks, falls tar-crate
            // sie doch mal preserved). pre-check oben ist die primäre schutzlinie.
            if ft.is_symlink() || !(ft.is_file() || ft.is_dir()) {
                let _ = fs::remove_file(entry.path());
                continue;
            }
            let target = dest.join(entry.file_name());
            if target.exists() {
                let _ = fs::remove_dir_all(&target);
            }
            fs::rename(entry.path(), &target).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    let _ = fs::remove_dir_all(&tmp);
    result
}

/// R-1: .tar.gz entpacken. temp im ziel-fs (EXDEV-safe), dann rename ins ziel.
/// dest-allowlist (M1.3): der scope-check läuft VOR create_dir_all und prüft
/// den nächsten existierenden vorfahren — der einzige legitime dest ist
/// `compatibilitytools.d` unter einem session-bestätigten steam-root.
#[tauri::command]
pub async fn extract_tarball(
    app: tauri::AppHandle,
    src: String,
    dest: String,
) -> Result<(), String> {
    sanitize_path(&src, "extract source")?;
    sanitize_path(&dest, "extract destination")?;
    let app2 = app.clone();
    spawn_blocking_io(move || {
        extract_blocking(&src, &dest, MAX_EXTRACT_BYTES, &|p: &Path| {
            app2.fs_scope().is_allowed(p)
        })
    })
    .await
}

const MAX_EXTRACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::extract_blocking;
    use crate::commands::download::MAX_DOWNLOAD_BYTES;

    // ---- extract_tarball (T-H-02) ----
    // die produktion entpackt github-release-tarballs (fremde, nicht-vertrauenswürdige
    // artefakte). die hier dokumentierten beschreibungen ("symlinks werden gefiltert",
    // "devices werden gefiltert", "kein path-traversal", "kein halbes ziel bei fehler")
    // waren bisher ungetestet. tests bauen tarballs programmatisch mit dem tar-crate,
    // rufen extract_blocking direkt (kein AppHandle, kein tokio).
    //
    // befund-basis (vor tests, durch code-lesen):
    // - post-unpack-filter iteriert nur top-level-eintraege (read_dir nicht rekursiv).
    //   subdirs werden als ganzes nach dest verschoben, ohne inhalt zu prüfen.
    //   *die hier geschriebenen tests zielen auf top-level-eintraege* — der subdir-befund
    //   ist ein separater punkt (siehe report).

    fn extract_dest(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-dest-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn extract_tarball<F>(tag: &str, populate: F) -> std::path::PathBuf
    where
        F: FnOnce(&mut tar::Builder<flate2::write::GzEncoder<&mut Vec<u8>>>),
    {
        let mut data = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
            let mut builder = tar::Builder::new(gz);
            populate(&mut builder);
            builder.finish().unwrap();
        }
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-src-{tag}-{}", std::process::id()));
        std::fs::write(&p, &data).unwrap();
        p
    }

    fn extract_cleanup(tarball: &std::path::Path, dest: &std::path::Path) {
        let _ = std::fs::remove_file(tarball);
        let _ = std::fs::remove_dir_all(dest);
    }

    // helper: append_data setzt die size NICHT automatisch — der header
    // braucht sie vorher. ohne size kann das tar-archiv nicht gelesen werden
    // ("numeric field was not a number").
    fn make_data_header(path: &str, data: &[u8]) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_path(path).unwrap();
        h.set_size(data.len() as u64);
        h
    }

    #[test]
    fn happy_path_extrahiert_dateien_und_verzeichnisse() {
        let tarball = extract_tarball("happy", |b| {
            b.append_data(&mut make_data_header("file.txt", b"hello"), "file.txt", &b"hello"[..])
                .unwrap();
            b.append_data(
                &mut make_data_header("subdir/nested.txt", b"world"),
                "subdir/nested.txt",
                &b"world"[..],
            )
            .unwrap();
        });
        let dest = extract_dest("happy");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_ok(), "extract sollte klappen: {res:?}");
        assert!(dest.join("file.txt").is_file(), "top-level-datei fehlt");
        assert_eq!(
            std::fs::read_to_string(dest.join("file.txt")).unwrap(),
            "hello"
        );
        assert!(
            dest.join("subdir").is_dir(),
            "subdir fehlt: {:?}",
            std::fs::read_dir(&dest).unwrap().collect::<Vec<_>>()
        );
        assert!(
            dest.join("subdir/nested.txt").is_file(),
            "nested datei fehlt"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_mit_absolutem_target_wird_abgelehnt() {
        // symlink auf absoluten pfad (/etc/passwd) muss via
        // link_target_stays_inside abgelehnt werden — target.is_absolute()
        // liefert false. der ganze extract wird abgebrochen, nichts im ziel.
        let tarball = extract_tarball("symlink", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Symlink);
            {
                let bytes = header.as_mut_bytes();
                let path = b"evil-link\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                let link = b"/etc/passwd\0";
                for (i, b) in link.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "tar mit symlink muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("evil-link")).is_err(),
            "evil-link darf nicht ins ziel"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_legitim_wird_extrahiert_und_bleibt_als_symlink() {
        let tarball = extract_tarball("symlink-legit", |b| {
            let mut dir_h = tar::Header::new_gnu();
            dir_h.set_path("dir").unwrap();
            dir_h.set_entry_type(tar::EntryType::Directory);
            dir_h.set_size(0);
            dir_h.set_cksum();
            b.append(&dir_h, std::io::empty()).unwrap();

            let mut libdir_h = tar::Header::new_gnu();
            libdir_h.set_path("dir/lib").unwrap();
            libdir_h.set_entry_type(tar::EntryType::Directory);
            libdir_h.set_size(0);
            libdir_h.set_cksum();
            b.append(&libdir_h, std::io::empty()).unwrap();

            b.append_data(
                &mut make_data_header("dir/lib/libfoo.so.1.2.3", b"fake-lib"),
                "dir/lib/libfoo.so.1.2.3",
                &b"fake-lib"[..],
            )
            .unwrap();

            let mut hy = tar::Header::new_gnu();
            hy.set_path("dir/lib/libfoo.so.1").unwrap();
            hy.set_entry_type(tar::EntryType::Symlink);
            hy.set_size(0);
            {
                let bytes = hy.as_mut_bytes();
                let ln = b"libfoo.so.1.2.3\0";
                for (i, b) in ln.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            hy.set_cksum();
            b.append(&hy, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink-legit");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_ok(), "legitimer symlink muss durchlaufen: {res:?}");
        assert!(
            dest.join("dir/lib/libfoo.so.1.2.3").is_file(),
            "target-datei fehlt"
        );
        let md = std::fs::symlink_metadata(dest.join("dir/lib/libfoo.so.1")).unwrap();
        assert!(
            md.file_type().is_symlink(),
            "symlink muss als symlink im ziel sein"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_mit_traversal_target_wird_abgelehnt() {
        let tarball = extract_tarball("symlink-traversal", |b| {
            let mut dir_h = tar::Header::new_gnu();
            dir_h.set_path("dir").unwrap();
            dir_h.set_entry_type(tar::EntryType::Directory);
            dir_h.set_size(0);
            dir_h.set_cksum();
            b.append(&dir_h, std::io::empty()).unwrap();

            let mut libdir_h = tar::Header::new_gnu();
            libdir_h.set_path("dir/lib").unwrap();
            libdir_h.set_entry_type(tar::EntryType::Directory);
            libdir_h.set_size(0);
            libdir_h.set_cksum();
            b.append(&libdir_h, std::io::empty()).unwrap();

            let mut hy = tar::Header::new_gnu();
            hy.set_path("dir/lib/x").unwrap();
            hy.set_entry_type(tar::EntryType::Symlink);
            hy.set_size(0);
            {
                let bytes = hy.as_mut_bytes();
                let ln = b"../../../../etc/passwd\0";
                for (i, b) in ln.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            hy.set_cksum();
            b.append(&hy, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink-traversal");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "symlink mit traversal-target muss abgelehnt werden: {res:?}");
        assert!(
            !dest.join("dir").exists(),
            "kein inhalt darf ins ziel bei abbruch"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn symlink_mit_legitimen_parentdir_wird_extrahiert() {
        let tarball = extract_tarball("symlink-parent", |b| {
            let mut dir_h = tar::Header::new_gnu();
            dir_h.set_path("dir").unwrap();
            dir_h.set_entry_type(tar::EntryType::Directory);
            dir_h.set_size(0);
            dir_h.set_cksum();
            b.append(&dir_h, std::io::empty()).unwrap();

            let mut a_h = tar::Header::new_gnu();
            a_h.set_path("dir/a").unwrap();
            a_h.set_entry_type(tar::EntryType::Directory);
            a_h.set_size(0);
            a_h.set_cksum();
            b.append(&a_h, std::io::empty()).unwrap();

            let mut bdir_h = tar::Header::new_gnu();
            bdir_h.set_path("dir/a/b").unwrap();
            bdir_h.set_entry_type(tar::EntryType::Directory);
            bdir_h.set_size(0);
            bdir_h.set_cksum();
            b.append(&bdir_h, std::io::empty()).unwrap();

            let mut c_h = tar::Header::new_gnu();
            c_h.set_path("dir/c").unwrap();
            c_h.set_entry_type(tar::EntryType::Directory);
            c_h.set_size(0);
            c_h.set_cksum();
            b.append(&c_h, std::io::empty()).unwrap();

            b.append_data(
                &mut make_data_header("dir/c/y", b"data"),
                "dir/c/y",
                &b"data"[..],
            )
            .unwrap();

            let mut hy = tar::Header::new_gnu();
            hy.set_path("dir/a/b/x").unwrap();
            hy.set_entry_type(tar::EntryType::Symlink);
            hy.set_size(0);
            {
                let bytes = hy.as_mut_bytes();
                let ln = b"../c/y\0";
                for (i, b) in ln.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            hy.set_cksum();
            b.append(&hy, std::io::empty()).unwrap();
        });
        let dest = extract_dest("symlink-parent");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_ok(), "symlink mit legitimem parentdir muss durchlaufen: {res:?}");
        let md = std::fs::symlink_metadata(dest.join("dir/a/b/x")).unwrap();
        assert!(
            md.file_type().is_symlink(),
            "symlink mit legitimem .. muss im ziel sein"
        );

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn block_device_eintrag_wird_gefiltert() {
        // dokumentation: tar mit block-device-entry wird per pre-check
        // ABGELEHNT (Err). der tar ist suspect, der ganze extract wird
        // abgebrochen. das ist strenger als selektives skippen, aber
        // sicherer: ein tar mit einem device-entry hat dort nichts zu suchen.
        let tarball = extract_tarball("blockdev", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Block);
            {
                let bytes = header.as_mut_bytes();
                let path = b"blockdev\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("blockdev");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "tar mit block-device muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("blockdev")).is_err(),
            "block-device darf nicht ins ziel"
        );
        // ziel-dir selbst existiert, aber KEINE inhalte aus dem tar
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn fifo_eintrag_wird_gefiltert() {
        // siehe block_device: pre-check lehnt den tar ab, dest bleibt leer.
        let tarball = extract_tarball("fifo", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Fifo);
            {
                let bytes = header.as_mut_bytes();
                let path = b"fifo\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("fifo");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "tar mit fifo muss abgelehnt werden");
        assert!(
            std::fs::symlink_metadata(dest.join("fifo")).is_err(),
            "fifo darf nicht ins ziel"
        );
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn path_traversal_escaped_nicht_in_tmp() {
        // KRITISCH: ein tar-eintrag mit "../"-pfad darf NIE ausserhalb von
        // dest landen. wir umgehen die `..`-validierung in `set_path` mit
        // `as_mut_bytes()` (ein angreifer könnte den tar mit einem anderen
        // tool bauen) und prüfen das beobachtbare ergebnis: /tmp/{filename}
        // darf NIE existieren.
        //
        // der pre-check lehnt den tar ab, sobald er einen eintrag mit bad
        // path findet — also nichts wird geschrieben.
        let escaped_filename = format!("protium-escape-{}.txt", std::process::id());
        let escaped_path = std::path::PathBuf::from("/tmp").join(&escaped_filename);
        let _ = std::fs::remove_file(&escaped_path);

        let malicious_path = format!("../../../../../../tmp/{escaped_filename}");
        let tarball = extract_tarball("traversal", |b| {
            let mut header = tar::Header::new_gnu();
            header.set_size(8);
            {
                let bytes = header.as_mut_bytes();
                let path = malicious_path.as_bytes();
                for (i, b) in path.iter().enumerate() {
                    if i < 100 {
                        bytes[i] = *b;
                    }
                }
                for i in path.len()..100 {
                    bytes[i] = 0;
                }
            }
            header.set_cksum();
            b.append(&header, &b"escaped!"[..]).unwrap();
        });
        let dest = extract_dest("traversal");

        let _ = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);

        assert!(
            !escaped_path.exists(),
            "path-traversal ist gelungen: {} wurde geschrieben",
            escaped_path.display()
        );

        let _ = std::fs::remove_file(&escaped_path);
        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn hardlink_wird_wie_regulaere_datei_behandelt() {
        // dokumentation: hardlinks (EntryType::Link) sind im pre-check
        // erlaubt. ar.unpack erstellt sie als reguläre datei (oder hardlink,
        // je nach fs) im tmp-dir, und der post-unpack-filter lässt sie durch
        // (is_file() == true). sie landen im ziel — das ist das definierte
        // verhalten. tar-crate prüft, dass der link-target innerhalb des
        // archives existiert und nicht aus dem unpack-root ausbricht.
        let tarball = extract_tarball("hardlink", |b| {
            b.append_data(
                &mut make_data_header("original.txt", b"data"),
                "original.txt",
                &b"data"[..],
            )
            .unwrap();
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Link);
            {
                let bytes = header.as_mut_bytes();
                let path = b"hardlink-to-original\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                let link = b"original.txt\0";
                for (i, b) in link.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            header.set_cksum();
            b.append(&header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("hardlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_ok(), "hardlink sollte extrahiert werden: {res:?}");
        assert!(dest.join("original.txt").is_file(), "original.txt fehlt");
        // hardlink landet im ziel als reguläre datei mit gleichem inhalt
        let hl = dest.join("hardlink-to-original");
        assert!(hl.is_file(), "hardlink muss als file im ziel sein");
        assert_eq!(
            std::fs::read(&hl).unwrap(),
            b"data",
            "hardlink muss inhalt von original haben"
        );

        extract_cleanup(&tarball, &dest);
    }

    // hardlink-target-validierung: ein hardlink in einem subdir auf einen
    // pfad ausserhalb des archives würde vom post-unpack-filter nicht
    // erfasst (der filter iteriert nur top-level und folgt subdirs ungeprüft).
    // der pre-check fängt das ab, weil er link-target-pfade gegen absolute
    // pfade und `..` prüft — unabhängig von der entry-position.
    #[test]
    fn hardlink_in_subdir_auf_aussenhardlink_wird_abgelehnt() {
        // konkrete lage: tar mit subdir + hardlink `subdir/inner-hardlink`
        // dessen target = `../../etc/shadow` ist. ohne pre-check würde der
        // hardlink entpackt, das subdir (inkl. hardlink) per rename ins ziel
        // wandern, und der hardlink hätte ein link auf /etc/shadow. pre-check
        // lehnt den tar ab.
        let tarball = extract_tarball("subdir-hardlink", |b| {
            // subdir entry
            let mut dir_header = tar::Header::new_gnu();
            dir_header.set_size(0);
            dir_header.set_entry_type(tar::EntryType::Directory);
            {
                let bytes = dir_header.as_mut_bytes();
                let path = b"subdir\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
            }
            dir_header.set_cksum();
            b.append(&dir_header, std::io::empty()).unwrap();

            // hardlink im subdir, target ausserhalb archives
            let mut link_header = tar::Header::new_gnu();
            link_header.set_size(0);
            link_header.set_entry_type(tar::EntryType::Link);
            {
                let bytes = link_header.as_mut_bytes();
                let path = b"subdir/inner-hardlink\0";
                for (i, b) in path.iter().enumerate() {
                    bytes[i] = *b;
                }
                // linkname (offset 157) = "../../etc/shadow"
                let target = b"../../etc/shadow\0";
                for (i, b) in target.iter().enumerate() {
                    bytes[157 + i] = *b;
                }
            }
            link_header.set_cksum();
            b.append(&link_header, std::io::empty()).unwrap();
        });
        let dest = extract_dest("subdir-hardlink");

        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(
            res.is_err(),
            "hardlink mit ..-target muss abgelehnt werden: {res:?}"
        );
        // weder subdir noch inner-hardlink im ziel
        assert!(
            !dest.join("subdir").exists(),
            "subdir darf nicht entpackt sein"
        );
        assert!(
            std::fs::symlink_metadata(dest.join("subdir/inner-hardlink")).is_err(),
            "inner-hardlink darf nicht entpackt sein"
        );
        // zieldir selbst existiert, aber leer
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.is_empty(), "zieldir muss leer sein, ist: {entries:?}");

        extract_cleanup(&tarball, &dest);
    }

    #[test]
    fn fehler_beim_entpacken_laesst_kein_halbes_ziel() {
        // wir bauen einen gültigen tarball (zwei eintraege) und schneiden
        // ihn bei der hälfte ab. GzDecoder schlägt mid-stream fehl → ar.unpack
        // returnt Err → unser code verschiebt NICHTS ins ziel (rename läuft
        // erst NACH erfolgreichem unpack). das ziel muss nach dem aufruf leer sein.
        let mut data = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
            let mut builder = tar::Builder::new(gz);
            builder
                .append_data(
                    &mut make_data_header("file1.txt", b"ok"),
                    "file1.txt",
                    &b"ok"[..],
                )
                .unwrap();
            builder
                .append_data(
                    &mut make_data_header("file2.txt", b"ok2"),
                    "file2.txt",
                    &b"ok2"[..],
                )
                .unwrap();
            builder.finish().unwrap();
        }
        assert!(data.len() > 64, "tar.gz sollte nicht trivial klein sein");
        // gzip-stream in der mitte abschneiden → dekompression schlägt fehl
        let truncated = data[..data.len() / 2].to_vec();
        let mut p = std::env::temp_dir();
        p.push(format!("protium-extract-src-truncated-{}", std::process::id()));
        std::fs::write(&p, &truncated).unwrap();
        let dest = extract_dest("truncated");

        let res = extract_blocking(p.to_str().unwrap(), dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "korrupter tarball muss Err liefern: {res:?}");

        // KRITISCH: kein halbes verzeichnis im ziel. (das ziel-dir selbst
        // existiert, aber es darf KEINE datei drin sein, die aus dem tar stammt.)
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            entries.is_empty(),
            "ziel muss leer sein, enthält aber: {entries:?}"
        );
        // auch die interne temp-dir (".protium-extract-...") darf nicht übrig sein
        for name in &entries {
            assert!(
                !name.starts_with(".protium-extract-"),
                "temp-dir wurde nicht aufgeräumt: {name}"
            );
        }

        let _ = std::fs::remove_file(&p);
        extract_cleanup(&p, &dest);
    }

    #[test]
    fn blockierte_pfade_als_src_werden_abgelehnt() {
        // S-H-02: src muss canonicalize + is_safe_path durchlaufen,
        // nicht nur sanitize_path. /etc als tarball-source ist blockiert.
        let res = extract_blocking("/etc", "/tmp/protium-extract-blocked-src-test", MAX_DOWNLOAD_BYTES, &|_| true);
        assert!(res.is_err(), "/etc darf nicht als tarball-source akzeptiert werden: {res:?}");
        assert!(
            res.as_ref().unwrap_err().contains("blocked"),
            "fehlermeldung soll blockiert nennen: {:?}",
            res
        );
    }

    #[test]
    fn entpack_größenlimit_bricht_ab_und_räumt_auf() {
        let tarball = extract_tarball("limit", |b| {
            b.append_data(
                &mut make_data_header("big.bin", &[0u8; 512]),
                "big.bin",
                &[0u8; 512][..],
            )
            .unwrap();
        });
        let dest = extract_dest("limit");

        // cap kleiner als die deklarierte größe → abbruch vor dem unpack
        let res = extract_blocking(tarball.to_str().unwrap(), dest.to_str().unwrap(), 100, &|_| true);
        assert!(res.is_err(), "limit muss abbrechen: {res:?}");
        assert!(
            res.unwrap_err().contains("limit exceeded"),
            "fehlermeldung soll limit nennen"
        );

        // kein halbes ziel, kein temp-dir-rest
        let entries: Vec<String> = std::fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            entries.iter().all(|n| !n.starts_with(".protium-extract-")),
            "temp-dir nicht aufgeräumt: {entries:?}"
        );

        extract_cleanup(&tarball, &dest);
    }

    // ---- extract-dest-scope (S2: allowlist statt blocklist) ----

    #[test]
    fn extract_dest_ausserhalb_scope_abgelehnt_ohne_mkdir() {
        let mut dest = std::env::temp_dir();
        dest.push(format!("protium-extract-noscope-{}", std::process::id()));

        let res = extract_blocking("/etc", dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|_| false);
        assert!(res.is_err(), "unscoped dest muss abgelehnt werden: {res:?}");
        assert!(
            res.unwrap_err().contains("outside allowed scope"),
            "fehlermeldung soll scope nennen"
        );
        assert!(
            !dest.exists(),
            "kein mkdir vor der ablehnung — dest darf nicht entstehen"
        );
    }

    #[test]
    fn extract_dest_ancestor_im_scope_ok() {
        // dest existiert nicht, der parent ist im scope → der check greift auf
        // den nächsten existierenden vorfahren. der src-check (/etc, blockiert)
        // muss danach greifen — beweist, dass der dest-check bestanden wurde.
        let mut dest = std::env::temp_dir();
        dest.push(format!("protium-extract-ancestor-{}", std::process::id()));
        let canon = std::fs::canonicalize(std::env::temp_dir()).unwrap();

        let res = extract_blocking("/etc", dest.to_str().unwrap(), MAX_DOWNLOAD_BYTES, &|p| p == canon);
        assert!(res.is_err());
        assert!(
            res.unwrap_err().contains("blocked"),
            "src-check muss greifen (dest-check hat bestanden)"
        );
        let _ = std::fs::remove_dir_all(&dest);
    }
}
