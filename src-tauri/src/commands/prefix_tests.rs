use super::*;
use crate::commands::scope::EnvironmentSnapshot;
use crate::commands::test_util::fixture_dir;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::PathBuf;

type HandlerCall = (String, Vec<String>, PathBuf);

struct Fixture {
    root: PathBuf,
    library: PathBuf,
    state: EnvironmentState,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = fixture_dir("prefix-open", tag);
        let library = root.join("library");
        fs::create_dir_all(library.join("steamapps/compatdata/620/pfx")).unwrap();
        fs::write(
            library.join("steamapps/appmanifest_620.acf"),
            "\"AppState\" { \"appid\" \"620\" }",
        )
        .unwrap();
        let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
            library.clone(),
            vec![library.clone()],
            vec![],
            root.join("cache"),
            root.join("config"),
        ));
        Self {
            root,
            library,
            state,
        }
    }

    fn run(
        &self,
        app_id: &str,
        hook: &mut dyn FnMut(PrefixReadStage),
    ) -> Result<Vec<HandlerCall>, &'static str> {
        let mut calls = Vec::new();
        open_prefix_folder_with(
            &self.state,
            self.library.to_str().unwrap(),
            app_id,
            hook,
            &mut |program, args, path| {
                calls.push((
                    program.to_owned(),
                    args.iter().map(|arg| (*arg).to_owned()).collect(),
                    path.into(),
                ));
                Ok(())
            },
        )?;
        Ok(calls)
    }

    fn assert_error(&self, expected: &'static str, hook: &mut dyn FnMut(PrefixReadStage)) {
        let mut spawned = false;
        let result = open_prefix_folder_with(
            &self.state,
            self.library.to_str().unwrap(),
            "620",
            hook,
            &mut |_, _, _| {
                spawned = true;
                Ok(())
            },
        );
        assert_eq!(result, Err(expected));
        assert!(!spawned);
        assert!([
            "blocked",
            "unreadable",
            "not-found",
            "handler-unavailable",
            "unchecked",
            "external-target"
        ]
        .contains(&expected));
        assert!(!expected.contains('/'));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn opens_only_validated_prefix_and_no_extra_argument() {
    let fixture = Fixture::new("success");
    assert_eq!(
        fixture.run("620", &mut |_| {}).unwrap(),
        vec![(
            "xdg-open".into(),
            vec![],
            fixture.library.join("steamapps/compatdata/620/pfx")
        )]
    );
}

#[test]
fn rejects_all_invalid_wire_app_ids() {
    let fixture = Fixture::new("invalid-ids");
    for app_id in [
        "",
        "0",
        "4294967296",
        " 620",
        "620\n",
        "+620",
        "٦٢٠",
        "../620",
    ] {
        assert_eq!(fixture.run(app_id, &mut |_| {}), Err("blocked"));
    }
}

#[test]
fn blocks_existing_library_outside_snapshot() {
    let fixture = Fixture::new("outside");
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    let result = open_prefix_folder_with(
        &fixture.state,
        outside.to_str().unwrap(),
        "620",
        &mut |_| {},
        &mut |_, _, _| panic!("must not spawn"),
    );
    assert_eq!(result, Err("blocked"));
}

#[test]
fn blocks_library_symlink() {
    let fixture = Fixture::new("library-link");
    let alias = fixture.root.join("alias");
    symlink(&fixture.library, &alias).unwrap();
    assert_eq!(
        open_prefix_folder_with(
            &fixture.state,
            alias.to_str().unwrap(),
            "620",
            &mut |_| {},
            &mut |_, _, _| panic!("must not spawn")
        ),
        Err("blocked")
    );
}

#[test]
fn blocks_library_identity_swap_before_descriptor_open() {
    let fixture = Fixture::new("library-identity");
    // Der Ersatz ist ein vollständiger Baum am autorisierten Pfad; nur die Identität unterscheidet ihn.
    let replacement = fixture.root.join("replacement");
    fs::create_dir_all(replacement.join("steamapps/compatdata/620/pfx")).unwrap();
    fs::copy(
        fixture.library.join("steamapps/appmanifest_620.acf"),
        replacement.join("steamapps/appmanifest_620.acf"),
    )
    .unwrap();
    fixture.assert_error("blocked", &mut |stage| {
        if stage == PrefixReadStage::BeforeLibraryOpen {
            fs::rename(&fixture.library, fixture.root.join("old")).unwrap();
            fs::rename(&replacement, &fixture.library).unwrap();
        }
    });
}

#[test]
fn blocks_manifest_only_in_other_library() {
    let fixture = Fixture::new("foreign-manifest");
    fs::rename(
        fixture.library.join("steamapps/appmanifest_620.acf"),
        fixture.root.join("appmanifest_620.acf"),
    )
    .unwrap();
    fixture.assert_error("blocked", &mut |_| {});
}

#[test]
fn blocks_manifest_app_id_mismatch() {
    let fixture = Fixture::new("manifest-mismatch");
    fs::write(
        fixture.library.join("steamapps/appmanifest_620.acf"),
        "\"AppState\" { \"appid\" \"570\" }",
    )
    .unwrap();
    fixture.assert_error("blocked", &mut |_| {});
}

fn check_symlink(tag: &str, component: &str) {
    let fixture = Fixture::new(tag);
    let target = fixture.library.join(component);
    let outside = fixture.root.join("outside");
    fs::rename(&target, &outside).unwrap();
    symlink(&outside, &target).unwrap();
    fixture.assert_error("blocked", &mut |_| {});
}

#[test]
fn blocks_steamapps_symlink() {
    check_symlink("steamapps-link", "steamapps");
}
#[test]
fn blocks_compatdata_symlink() {
    check_symlink("compatdata-link", "steamapps/compatdata");
}
#[test]
fn blocks_app_id_symlink() {
    check_symlink("app-link", "steamapps/compatdata/620");
}
#[test]
fn blocks_pfx_symlink() {
    check_symlink("pfx-link", "steamapps/compatdata/620/pfx");
}

#[test]
fn blocks_manifest_symlink() {
    let fixture = Fixture::new("manifest-link");
    let target = fixture.library.join("steamapps/appmanifest_620.acf");
    let outside = fixture.root.join("outside.acf");
    fs::rename(&target, &outside).unwrap();
    symlink(&outside, target).unwrap();
    fixture.assert_error("blocked", &mut |_| {});
}

#[test]
fn blocks_pfx_regular_file() {
    let fixture = Fixture::new("pfx-file");
    let pfx = fixture.library.join("steamapps/compatdata/620/pfx");
    fs::remove_dir(&pfx).unwrap();
    fs::write(pfx, "").unwrap();
    fixture.assert_error("blocked", &mut |_| {});
}

#[test]
fn missing_prefix_components_are_not_found() {
    for (tag, component) in [
        ("missing-pfx", "steamapps/compatdata/620/pfx"),
        ("missing-app", "steamapps/compatdata/620"),
        ("missing-compatdata", "steamapps/compatdata"),
    ] {
        let fixture = Fixture::new(tag);
        fs::remove_dir_all(fixture.library.join(component)).unwrap();
        fixture.assert_error("not-found", &mut |_| {});
    }
}

#[test]
fn unreadable_manifest_is_distinct_from_blocked() {
    let fixture = Fixture::new("bad-manifest");
    fs::write(
        fixture.library.join("steamapps/appmanifest_620.acf"),
        "\"AppState\" {",
    )
    .unwrap();
    fixture.assert_error("unreadable", &mut |_| {});
}

#[test]
fn denied_prefix_is_unreadable() {
    let fixture = Fixture::new("denied");
    let pfx = fixture.library.join("steamapps/compatdata/620/pfx");
    fs::set_permissions(&pfx, fs::Permissions::from_mode(0o0)).unwrap();
    fixture.assert_error("unreadable", &mut |_| {});
    fs::set_permissions(pfx, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn fifo_manifest_is_unreadable_without_blocking_snapshot() {
    use std::os::unix::ffi::OsStrExt;
    use std::sync::mpsc;
    use std::time::Duration;

    let fixture = Fixture::new("fifo-manifest");
    let manifest = fixture.library.join("steamapps/appmanifest_620.acf");
    fs::remove_file(&manifest).unwrap();
    let name = std::ffi::CString::new(manifest.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        fixture.assert_error("unreadable", &mut |_| {});
        fixture
            .state
            .with_authorized_library(fixture.library.to_str().unwrap(), |_| Ok(()))
            .unwrap();
        sender.send(()).unwrap();
    });
    let completed = receiver.recv_timeout(Duration::from_secs(2));
    // Bei Regression den blockierten Reader lösen, damit kein Testthread zurückbleibt.
    let rescue = if completed.is_err() {
        Some(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&manifest)
                .unwrap(),
        )
    } else {
        None
    };
    worker.join().unwrap();
    drop(rescue);
    assert!(
        completed.is_ok(),
        "FIFO manifest blocked prefix/snapshot access"
    );
}

#[test]
fn unavailable_handlers_return_only_code_and_fallback_uses_gio() {
    let fixture = Fixture::new("handlers");
    let mut programs = Vec::new();
    let result = open_prefix_folder_with(
        &fixture.state,
        fixture.library.to_str().unwrap(),
        "620",
        &mut |_| {},
        &mut |program, args, _| {
            programs.push((
                program.to_owned(),
                args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>(),
            ));
            Err(io::Error::from(io::ErrorKind::NotFound))
        },
    );
    assert_eq!(result, Err("handler-unavailable"));
    assert_eq!(
        programs,
        vec![
            ("xdg-open".into(), vec![]),
            ("gio".into(), vec!["open".into()])
        ]
    );
    let mut attempts = 0;
    assert_eq!(
        open_prefix_folder_with(
            &fixture.state,
            fixture.library.to_str().unwrap(),
            "620",
            &mut |_| {},
            &mut |_, _, _| {
                attempts += 1;
                if attempts == 1 {
                    Err(io::Error::from(io::ErrorKind::NotFound))
                } else {
                    Ok(())
                }
            }
        ),
        Ok(())
    );
    assert_eq!(attempts, 2);
}

#[test]
fn handler_path_rejects_relative_path() {
    // Relative Library, damit die Absolutprüfung nicht hinter starts_with verschwindet.
    assert_eq!(
        validate_handler_path(Path::new("library/pfx"), Path::new("library")),
        Err(PrefixError::Blocked)
    );
    assert_eq!(
        validate_handler_path(Path::new("-option"), Path::new("/library")),
        Err(PrefixError::Blocked)
    );
}
#[test]
fn handler_path_rejects_library_root_itself() {
    assert_eq!(
        validate_handler_path(Path::new("/library"), Path::new("/library")),
        Err(PrefixError::Blocked)
    );
}
#[test]
fn handler_path_rejects_nul() {
    assert_eq!(
        validate_handler_path(Path::new("/library/pfx\0"), Path::new("/library")),
        Err(PrefixError::Blocked)
    );
}
#[test]
fn handler_path_preserves_non_utf8() {
    let path = Path::new(OsStr::from_bytes(b"/library/\xff/pfx"));
    assert_eq!(validate_handler_path(path, Path::new("/library")), Ok(()));
}
#[test]
fn handler_path_checks_components_not_string_prefix() {
    assert_eq!(
        validate_handler_path(Path::new("/library-other/pfx"), Path::new("/library")),
        Err(PrefixError::Blocked)
    );
}

#[test]
fn manifest_uses_original_steamapps_descriptor_after_swap() {
    let fixture = Fixture::new("steamapps-swap");
    fs::remove_file(fixture.library.join("steamapps/appmanifest_620.acf")).unwrap();
    fixture.assert_error("blocked", &mut |stage| {
        if stage == PrefixReadStage::SteamappsOpened {
            let steamapps = fixture.library.join("steamapps");
            fs::rename(&steamapps, fixture.library.join("old-steamapps")).unwrap();
            fs::create_dir(&steamapps).unwrap();
            fs::write(
                steamapps.join("appmanifest_620.acf"),
                "\"AppState\" { \"appid\" \"620\" }",
            )
            .unwrap();
        }
    });
}

#[test]
fn removed_open_prefix_is_blocked() {
    let fixture = Fixture::new("removed-pfx");
    fixture.assert_error("blocked", &mut |stage| {
        if stage == PrefixReadStage::PrefixOpened {
            fs::remove_dir(fixture.library.join("steamapps/compatdata/620/pfx")).unwrap();
        }
    });
}

#[test]
fn renamed_library_outside_authorized_root_is_blocked() {
    let fixture = Fixture::new("renamed-library");
    fixture.assert_error("blocked", &mut |stage| {
        if stage == PrefixReadStage::LibraryOpened {
            fs::rename(&fixture.library, fixture.root.join("renamed")).unwrap();
        }
    });
}

#[test]
fn documents_residual_path_swap_before_handler() {
    let fixture = Fixture::new("residual-race");
    let pfx = fixture.library.join("steamapps/compatdata/620/pfx");
    let calls = fixture
        .run("620", &mut |stage| {
            if stage == PrefixReadStage::BeforeHandler {
                fs::rename(&pfx, pfx.with_extension("old")).unwrap();
                fs::create_dir(&pfx).unwrap();
            }
        })
        .unwrap();
    // SECURITY: Der Handler löst diesen Namen erneut auf, nicht unseren Deskriptor.
    assert_eq!(calls.first().map(|call| &call.2), Some(&pfx));
}

#[test]
fn replaced_snapshot_does_not_authorize_old_library() {
    let fixture = Fixture::new("snapshot");
    let new_root = fixture.root.join("new");
    fs::create_dir(&new_root).unwrap();
    fixture
        .state
        .replace_for_test(EnvironmentSnapshot::for_test(
            new_root.clone(),
            vec![new_root],
            vec![],
            fixture.root.join("cache"),
            fixture.root.join("config"),
        ));
    fixture.assert_error("blocked", &mut |_| {});
}
