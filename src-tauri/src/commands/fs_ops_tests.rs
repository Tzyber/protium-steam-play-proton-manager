use super::*;
use crate::commands::scope::{EnvironmentSnapshot, EnvironmentState};
use serde::ser::{self, Impossible, Serialize, SerializeStruct, Serializer};
use std::os::unix::fs as unixfs;
use std::path::Path;

#[derive(Debug, PartialEq)]
enum WireValue {
    Object(Vec<(String, WireValue)>),
    String(String),
    Number(u64),
    Null,
}

#[derive(Debug)]
struct WireError(String);

impl std::fmt::Display for WireError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for WireError {}

impl ser::Error for WireError {
    fn custom<T: std::fmt::Display>(message: T) -> Self {
        Self(message.to_string())
    }
}

struct WireSerializer;

struct WireStruct {
    fields: Vec<(String, WireValue)>,
}

impl SerializeStruct for WireStruct {
    type Ok = WireValue;
    type Error = WireError;

    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Self::Error> {
        self.fields
            .push((key.to_string(), value.serialize(WireSerializer)?));
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Object(self.fields))
    }
}

impl Serializer for WireSerializer {
    type Ok = WireValue;
    type Error = WireError;
    type SerializeSeq = Impossible<Self::Ok, Self::Error>;
    type SerializeTuple = Impossible<Self::Ok, Self::Error>;
    type SerializeTupleStruct = Impossible<Self::Ok, Self::Error>;
    type SerializeTupleVariant = Impossible<Self::Ok, Self::Error>;
    type SerializeMap = Impossible<Self::Ok, Self::Error>;
    type SerializeStruct = WireStruct;
    type SerializeStructVariant = Impossible<Self::Ok, Self::Error>;

    fn serialize_bool(self, value: bool) -> Result<Self::Ok, Self::Error> {
        if value {
            Ok(WireValue::Number(1))
        } else {
            Ok(WireValue::Number(0))
        }
    }

    fn serialize_i8(self, value: i8) -> Result<Self::Ok, Self::Error> {
        self.serialize_i64(value.into())
    }

    fn serialize_i16(self, value: i16) -> Result<Self::Ok, Self::Error> {
        self.serialize_i64(value.into())
    }

    fn serialize_i32(self, value: i32) -> Result<Self::Ok, Self::Error> {
        self.serialize_i64(value.into())
    }

    fn serialize_i64(self, value: i64) -> Result<Self::Ok, Self::Error> {
        u64::try_from(value)
            .map(WireValue::Number)
            .map_err(|_| WireError("negative number unsupported".to_string()))
    }

    fn serialize_u8(self, value: u8) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Number(value.into()))
    }

    fn serialize_u16(self, value: u16) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Number(value.into()))
    }

    fn serialize_u32(self, value: u32) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Number(value.into()))
    }

    fn serialize_u64(self, value: u64) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Number(value))
    }

    fn serialize_u128(self, value: u128) -> Result<Self::Ok, Self::Error> {
        u64::try_from(value)
            .map(WireValue::Number)
            .map_err(|_| WireError("u128 unsupported".to_string()))
    }

    fn serialize_i128(self, value: i128) -> Result<Self::Ok, Self::Error> {
        u64::try_from(value)
            .map(WireValue::Number)
            .map_err(|_| WireError("i128 unsupported".to_string()))
    }

    fn serialize_f32(self, _value: f32) -> Result<Self::Ok, Self::Error> {
        Err(WireError("float unsupported".to_string()))
    }

    fn serialize_f64(self, _value: f64) -> Result<Self::Ok, Self::Error> {
        Err(WireError("float unsupported".to_string()))
    }

    fn serialize_char(self, value: char) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::String(value.to_string()))
    }

    fn serialize_str(self, value: &str) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::String(value.to_string()))
    }

    fn serialize_bytes(self, _value: &[u8]) -> Result<Self::Ok, Self::Error> {
        Err(WireError("bytes unsupported".to_string()))
    }

    fn serialize_none(self) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Null)
    }

    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<Self::Ok, Self::Error> {
        value.serialize(self)
    }

    fn serialize_unit(self) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Null)
    }

    fn serialize_unit_struct(self, _name: &'static str) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Null)
    }

    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
    ) -> Result<Self::Ok, Self::Error> {
        Ok(WireValue::Object(vec![(
            "status".to_string(),
            WireValue::String(variant.to_string()),
        )]))
    }

    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error> {
        value.serialize(self)
    }

    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _name: &'static str,
        _variant_index: u32,
        _variant: &'static str,
        _value: &T,
    ) -> Result<Self::Ok, Self::Error> {
        Err(WireError("newtype variant unsupported".to_string()))
    }

    fn serialize_seq(self, _len: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
        Err(WireError("sequence unsupported".to_string()))
    }

    fn serialize_tuple(self, _len: usize) -> Result<Self::SerializeTuple, Self::Error> {
        Err(WireError("tuple unsupported".to_string()))
    }

    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleStruct, Self::Error> {
        Err(WireError("tuple struct unsupported".to_string()))
    }

    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        _variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleVariant, Self::Error> {
        Err(WireError("tuple variant unsupported".to_string()))
    }

    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
        Err(WireError("map unsupported".to_string()))
    }

    fn serialize_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStruct, Self::Error> {
        Ok(WireStruct { fields: Vec::new() })
    }

    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        _variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStructVariant, Self::Error> {
        Err(WireError("struct variant unsupported".to_string()))
    }
}

#[test]
fn directory_size_serializes_exact_status_wire_shapes() {
    assert_eq!(
        DirectorySize::Measured { size_bytes: 42 }
            .serialize(WireSerializer)
            .unwrap(),
        WireValue::Object(vec![
            (
                "status".to_string(),
                WireValue::String("measured".to_string())
            ),
            ("sizeBytes".to_string(), WireValue::Number(42)),
        ])
    );
    assert_eq!(
        DirectorySize::Missing.serialize(WireSerializer).unwrap(),
        WireValue::Object(vec![(
            "status".to_string(),
            WireValue::String("missing".to_string()),
        )])
    );
    assert_eq!(
        DirectorySize::Failed {
            detail: Some("metadata failed".to_string()),
        }
        .serialize(WireSerializer)
        .unwrap(),
        WireValue::Object(vec![
            (
                "status".to_string(),
                WireValue::String("failed".to_string())
            ),
            (
                "detail".to_string(),
                WireValue::String("metadata failed".to_string()),
            ),
        ])
    );
    assert_eq!(
        DirectorySize::Failed { detail: None }
            .serialize(WireSerializer)
            .unwrap(),
        WireValue::Object(vec![(
            "status".to_string(),
            WireValue::String("failed".to_string()),
        )])
    );
}

// B1-Beleg: cover-bytes als serde-json-zahlen-array sind ein Wire-Engpass.
// 100 KB cover → ~330 KB json (3,3×) plus parse-kosten im webview; deshalb
// liefert environment_read_binary eine binäre ipc-response.
#[test]
fn binary_wire_form_als_json_array_ist_mehr_als_doppelt_so_gross() {
    let bytes: Vec<u8> = (0..100_000u32).map(|index| (index % 256) as u8).collect();
    let mut json_len = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        json_len += byte.to_string().len() + 1; // zahl + trenner
        if index + 1 == bytes.len() {
            json_len -= 1; // kein trenner nach dem letzten element
        }
    }
    assert!(
        json_len as u64 >= bytes.len() as u64 * 2,
        "json-array-wire ({json_len}) muss deutlich über den rohbytes (100000) liegen"
    );
}

#[test]
fn dir_size_skipped_symlinks() {
    let mut root = std::env::temp_dir();
    root.push(format!("protium-dirsymlink-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let real = root.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("big.bin"), vec![0u8; 5_000_000]).unwrap();

    let via = root.join("via-link");
    std::fs::create_dir_all(&via).unwrap();
    unixfs::symlink(&real, via.join("link-to-real")).unwrap();

    let res =
        measure_directory_with_hook(&via, &mut |_| Ok(()), &mut || {}, &mut |_| Ok(())).unwrap();
    assert!(
        matches!(res, DirectorySize::Measured { size_bytes } if size_bytes < 1000),
        "symlink wurde gefolgt, dir_size={res:?} (sollte < 1000 sein)"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dir_size_returns_failed_without_partial_sum_on_traversal_error() {
    let root = std::env::temp_dir().join(format!(
        "protium-dir-size-traversal-error-{}",
        std::process::id()
    ));
    let child = root.join("child");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(root.join("known.bin"), vec![0u8; 8192]).unwrap();

    let mut hook = |path: &Path| {
        if path == Path::new("child") {
            let _ = std::fs::remove_dir_all(&child);
        }
        Ok(())
    };
    let result = measure_directory_with_hook(&root, &mut |_| Ok(()), &mut || {}, &mut hook);

    assert!(
        matches!(result, Ok(DirectorySize::Failed { .. })),
        "result: {result:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dir_size_returns_failed_without_partial_sum_on_entry_error() {
    let root = std::env::temp_dir().join(format!(
        "protium-dir-size-entry-error-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("known.bin");
    std::fs::write(&file, vec![0u8; 8192]).unwrap();

    let mut hook = |path: &Path| {
        if path == Path::new("known.bin") {
            let _ = std::fs::remove_file(&file);
        }
        Ok(())
    };
    let result = measure_directory_with_hook(&root, &mut |_| Ok(()), &mut || {}, &mut hook);

    assert!(
        matches!(result, Ok(DirectorySize::Failed { .. })),
        "result: {result:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dir_size_returns_missing_when_root_disappears_before_measurement() {
    let root =
        std::env::temp_dir().join(format!("protium-dir-size-root-gone-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let mut hook = |_path: &Path| {
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    };
    let result = measure_directory_with_hook(&root, &mut hook, &mut || {}, &mut |_| Ok(()));

    assert_eq!(result.unwrap(), DirectorySize::Missing);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dir_size_erkennt_root_tausch_zwischen_stat_und_open() {
    let root = std::env::temp_dir().join(format!(
        "protium-dir-size-root-swap-bind-{}",
        std::process::id()
    ));
    let old = root.with_extension("old");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("alt.bin"), vec![0u8; 100]).unwrap();

    let mut bind_hook = || {
        std::fs::rename(&root, &old).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("neu.bin"), vec![0u8; 200]).unwrap();
    };
    let result =
        measure_directory_with_hook(&root, &mut |_| Ok(()), &mut bind_hook, &mut |_| Ok(()));

    assert!(
        result.is_err(),
        "tausch zwischen stat und open muss abbrechen: {result:?}"
    );
    assert!(
        result.unwrap_err().contains("changed while opening"),
        "meldung soll die bindung nennen"
    );
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
}

#[test]
fn dir_size_misst_nach_root_tausch_den_gebundenen_stand() {
    let root = std::env::temp_dir().join(format!(
        "protium-dir-size-root-swap-bound-{}",
        std::process::id()
    ));
    let old = root.with_extension("old");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("alt.bin"), vec![0u8; 100]).unwrap();

    // tausch NACH der bindung (erster read-hook, relativ ""):
    // der walk läuft über den gebundenen deskriptor und misst die alten
    // inhalte, nicht den ersatzbaum.
    let mut read_hook = |path: &Path| {
        if path == Path::new("") {
            std::fs::rename(&root, &old).unwrap();
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("neu.bin"), vec![0u8; 200]).unwrap();
        }
        Ok(())
    };
    let result = measure_directory_with_hook(&root, &mut |_| Ok(()), &mut || {}, &mut read_hook);

    assert_eq!(result.unwrap(), DirectorySize::Measured { size_bytes: 100 });
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
}

#[test]
fn dir_size_begrenzt_die_walk_tiefe_fail_closed() {
    // künstlich tiefer baum: über dem cap bricht der walk kontrolliert
    // ab (Failed) statt den blocking-thread-stack zu überlaufen.
    let root = std::env::temp_dir().join(format!("protium-dir-depth-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let mut deep = root.clone();
    for _ in 0..(super::MAX_DIRECTORY_WALK_DEPTH + 50) {
        deep.push("d");
    }
    std::fs::create_dir_all(&deep).unwrap();

    let result = measure_directory_with_hook(&root, &mut |_| Ok(()), &mut || {}, &mut |_| Ok(()));
    assert!(
        matches!(result, Ok(DirectorySize::Failed { .. })),
        "zu tiefer baum muss fail-closed failed liefern: {result:?}"
    );
    let detail = match result.as_ref().unwrap() {
        DirectorySize::Failed { detail } => detail.as_deref().unwrap_or(""),
        _ => "",
    };
    assert!(
        detail.contains("too deep"),
        "meldung soll die tiefe nennen: {result:?}"
    );

    // flacher baum bleibt messbar (auf frischem root)
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut flat = root.join("flat");
    for _ in 0..10 {
        flat.push("d");
    }
    std::fs::create_dir_all(&flat).unwrap();
    std::fs::write(flat.join("payload"), vec![0u8; 7]).unwrap();
    let flat_result =
        measure_directory_with_hook(&root, &mut |_| Ok(()), &mut || {}, &mut |_| Ok(()));
    assert_eq!(
        flat_result.unwrap(),
        DirectorySize::Measured { size_bytes: 7 }
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dir_size_rejects_u64_overflow_and_javascript_unsafe_sum() {
    assert!(super::checked_size_add(u64::MAX, 1).is_err());
    assert!(super::checked_size_add(MAX_SAFE_JS_INTEGER, 1).is_err());
    assert_eq!(
        super::checked_size_add(MAX_SAFE_JS_INTEGER - 1, 1).unwrap(),
        MAX_SAFE_JS_INTEGER
    );
}

#[test]
fn environment_exists_not_found_is_false_only_inside_snapshot() {
    let root = std::env::temp_dir().join(format!("protium-env-exists-{}", std::process::id()));
    let library = root.join("library");
    std::fs::create_dir_all(&library).unwrap();
    let snapshot = EnvironmentSnapshot::for_test(
        root.join("steam"),
        vec![library.clone()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    );
    let state = EnvironmentState::for_test(snapshot);
    assert!(!state
        .exists_for_test(&library.join("steamapps/missing.jpg"))
        .unwrap());
    assert!(state
        .exists_for_test(&root.join("Documents/missing.jpg"))
        .is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn environment_binary_read_requires_current_snapshot_root() {
    let root = std::env::temp_dir().join(format!("protium-env-read-{}", std::process::id()));
    let library = root.join("library");
    std::fs::create_dir_all(&library).unwrap();
    let cover = library.join("library_header.jpg");
    std::fs::write(&cover, [1u8, 2, 3]).unwrap();
    let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
        root.join("steam"),
        vec![library.clone()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    ));

    assert_eq!(
        read_environment_file(&state, cover.to_str().unwrap(), "test").unwrap(),
        [1, 2, 3]
    );
    assert!(read_environment_file(&state, "/tmp/protium-not-authorized.jpg", "test").is_err());

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn environment_read_file_erkennt_parent_tausch_vor_open() {
    let root = std::env::temp_dir().join(format!("protium-env-file-swap-{}", std::process::id()));
    let library = root.join("library");
    let old = library.with_extension("old");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
    std::fs::create_dir_all(&library).unwrap();
    let cover = library.join("cover.jpg");
    std::fs::write(&cover, [1u8, 2, 3]).unwrap();
    let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
        root.join("steam"),
        vec![library.clone()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    ));

    // parent wird zwischen stat und open ersetzt: die bindung bricht ab,
    // die datei wird nie über den fremden baum gelesen.
    let mut hook = || {
        std::fs::rename(&library, &old).unwrap();
        std::fs::create_dir_all(&library).unwrap();
        std::fs::write(library.join("cover.jpg"), [9u8, 9]).unwrap();
    };
    let result = read_environment_file_with_hook(
        &state,
        cover.to_str().unwrap(),
        "test",
        &mut hook,
        &mut |_| {},
    );
    assert!(result.is_err(), "parent-tausch muss abbrechen: {result:?}");
    assert!(result.unwrap_err().contains("changed while opening"));
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
}

#[test]
fn environment_read_file_begrenzt_wachstum_des_geoeffneten_deskriptors() {
    let root = std::env::temp_dir().join(format!("protium-env-file-growth-{}", std::process::id()));
    let library = root.join("library");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&library).unwrap();
    let cover = library.join("cover.jpg");
    std::fs::write(&cover, [1u8, 2, 3]).unwrap();
    let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
        root.join("steam"),
        vec![library.clone()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    ));

    // datei wächst NACH dem open über das limit (über ein separates
    // write-handle auf demselben inode, das read-only-fd kann nicht
    // wachsen): das limit gilt für den geöffneten deskriptor, der
    // cap+1-read bricht ab.
    let write_handle = std::fs::OpenOptions::new()
        .write(true)
        .open(&cover)
        .unwrap();
    let mut hook = move |_file: &mut std::fs::File| {
        write_handle
            .set_len(super::MAX_ENVIRONMENT_READ_BYTES + 2)
            .unwrap();
    };
    let result = read_environment_file_with_hook(
        &state,
        cover.to_str().unwrap(),
        "test",
        &mut || {},
        &mut hook,
    );
    assert!(result.unwrap_err().contains("exceeds read limit"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn environment_read_dir_listet_typ_und_symlink_ueber_gebundenen_deskriptor() {
    let root = std::env::temp_dir().join(format!("protium-env-dir-list-{}", std::process::id()));
    let library = root.join("library");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&library).unwrap();
    std::fs::write(library.join("a.bin"), [1u8]).unwrap();
    std::fs::create_dir_all(library.join("sub")).unwrap();
    unixfs::symlink(library.join("a.bin"), library.join("link")).unwrap();
    let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
        root.join("steam"),
        vec![library.clone()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    ));

    let entries =
        read_environment_dir_with_hook(&state, library.to_str().unwrap(), "test", &mut || {})
            .unwrap();
    let mut names: Vec<_> = entries.iter().map(|entry| entry.name.clone()).collect();
    names.sort();
    assert_eq!(names, ["a.bin", "link", "sub"]);
    let file = entries.iter().find(|entry| entry.name == "a.bin").unwrap();
    assert!(!file.is_directory && !file.is_symlink);
    let dir = entries.iter().find(|entry| entry.name == "sub").unwrap();
    assert!(dir.is_directory);
    let link = entries.iter().find(|entry| entry.name == "link").unwrap();
    assert!(link.is_symlink);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn environment_read_dir_begrenzt_eintraege_auf_descriptor() {
    let root = std::env::temp_dir().join(format!("protium-env-dir-limit-{}", std::process::id()));
    let library = root.join("library");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&library).unwrap();
    for index in 0..=super::MAX_ENVIRONMENT_DIR_ENTRIES {
        std::fs::write(library.join(format!("f{index}")), []).unwrap();
    }
    let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
        root.join("steam"),
        vec![library.clone()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    ));

    let result =
        read_environment_dir_with_hook(&state, library.to_str().unwrap(), "test", &mut || {});
    assert!(result.unwrap_err().contains("entry limit exceeded"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn environment_read_dir_erkennt_verzeichnis_tausch_vor_open() {
    let root = std::env::temp_dir().join(format!("protium-env-dir-swap-{}", std::process::id()));
    let library = root.join("library");
    let old = library.with_extension("old");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
    std::fs::create_dir_all(&library).unwrap();
    std::fs::write(library.join("a.bin"), [1u8]).unwrap();
    let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
        root.join("steam"),
        vec![library.clone()],
        Vec::new(),
        root.join("cache"),
        root.join("config"),
    ));

    let mut hook = || {
        std::fs::rename(&library, &old).unwrap();
        std::fs::create_dir_all(&library).unwrap();
        std::fs::write(library.join("b.bin"), [2u8]).unwrap();
    };
    let result =
        read_environment_dir_with_hook(&state, library.to_str().unwrap(), "test", &mut hook);
    assert!(
        result.is_err(),
        "verzeichnis-tausch muss abbrechen: {result:?}"
    );
    assert!(result.unwrap_err().contains("changed while opening"));
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
}
