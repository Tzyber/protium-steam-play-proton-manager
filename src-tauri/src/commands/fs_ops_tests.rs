use super::*;
use crate::commands::scope::{EnvironmentSnapshot, EnvironmentState};
#[cfg(target_os = "linux")]
use crate::commands::test_util::production_source;
#[cfg(target_os = "linux")]
use crate::commands::vdf_patch::tests::BEIDE_LAYOUTS;
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
            detail: "metadata failed".to_string(),
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
        DirectorySize::Failed {
            detail: String::new(),
        }
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
        DirectorySize::Failed { detail } => detail.as_str(),
        _ => "",
    };
    assert!(
        detail.contains("walk depth"),
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
    std::fs::create_dir_all(library.join("steamapps")).unwrap();
    let cover = library.join("steamapps/appmanifest_1.acf");
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

// S-03: inhalte nur aus den dateien, die das frontend liest; config.vdf ohne
// login-tokens.
#[test]
fn environment_read_liefert_nur_freigegebene_inhalte() {
    let root = std::env::temp_dir().join(format!("protium-env-content-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let steam = root.join("steam");
    for dir in [
        "config/htmlcache",
        "logs",
        "userdata/7/config",
        "steamapps/common/g",
    ] {
        std::fs::create_dir_all(steam.join(dir)).unwrap();
    }
    std::fs::write(
        steam.join("config/config.vdf"),
        "\"InstallConfigStore\"\n{\n\"Software\"\n{\n\"Valve\"\n{\n\"Steam\"\n{\n\"ConnectCache\"\n{\n\"k\"\t\"geheim\"\n}\n\"CompatToolMapping\"\n{\n\"620\"\n{\n\"name\"\t\"GE-Proton9-1\"\n}\n}\n}\n}\n}\n}\n",
    )
    .unwrap();
    for file in [
        "config/loginusers.vdf",
        "userdata/7/config/localconfig.vdf",
        "config/htmlcache/Cookies",
        "config/local.vdf",
        "ssfn123",
        "logs/connection_log.txt",
        "userdata/7/config/other.vdf",
        "steamapps/common/g/game.cfg",
    ] {
        std::fs::write(steam.join(file), "x").unwrap();
    }
    let state = EnvironmentState::for_test(EnvironmentSnapshot::for_test(
        steam.clone(),
        vec![steam.clone()],
        Vec::new(),
        root.join("cache"),
        root.join("app-config"),
    ));
    let read = |rel: &str| read_environment_file(&state, steam.join(rel).to_str().unwrap(), "test");

    let config = String::from_utf8(read("config/config.vdf").unwrap()).unwrap();
    assert!(!config.contains("geheim"), "{config}");
    assert!(config.contains("GE-Proton9-1"), "{config}");
    assert_eq!(read("config/loginusers.vdf").unwrap(), b"x");
    assert_eq!(read("userdata/7/config/localconfig.vdf").unwrap(), b"x");
    for rel in [
        "config/htmlcache/Cookies",
        "config/local.vdf",
        "ssfn123",
        "logs/connection_log.txt",
        "userdata/7/config/other.vdf",
        "steamapps/common/g/game.cfg",
    ] {
        let error = read(rel).unwrap_err();
        assert!(error.contains("blocked-location"), "{rel}: {error}");
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn environment_read_file_erkennt_parent_tausch_vor_open() {
    let root = std::env::temp_dir().join(format!("protium-env-file-swap-{}", std::process::id()));
    let library = root.join("library");
    let old = library.with_extension("old");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&old);
    std::fs::create_dir_all(library.join("steamapps")).unwrap();
    let cover = library.join("steamapps/appmanifest_1.acf");
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
        std::fs::create_dir_all(library.join("steamapps")).unwrap();
        std::fs::write(library.join("steamapps/appmanifest_1.acf"), [9u8, 9]).unwrap();
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
    std::fs::create_dir_all(library.join("steamapps")).unwrap();
    let cover = library.join("steamapps/appmanifest_1.acf");
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
    assert!(result.unwrap_err().contains("size-limit-exceeded"));
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
    assert!(result.unwrap_err().contains("size-limit-exceeded"));
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

// P8 (Audit 5.5): der Steam-Check ist fail-closed. `probe_proc` belegt, dass
// die prozessliste des kernels lesbar und plausibel ist; die fixtures ahmen
// die /proc-struktur nach (PID 2 = kthreadd). Jeder unerwartete zustand muss
// `steam-check-unavailable` liefern, nie still `false`.

#[cfg(target_os = "linux")]
fn proc_fixture(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("protium-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("2")).unwrap();
    root
}

// plausibler /proc-standard: kthreadd mit ppid 0, kein exe-link.
#[cfg(target_os = "linux")]
fn gueltiger_proc_fixture(name: &str) -> std::path::PathBuf {
    let root = proc_fixture(name);
    std::fs::write(root.join("2/comm"), "kthreadd\n").unwrap();
    std::fs::write(root.join("2/stat"), "2 (kthreadd) S 0 2 2 0 -1 0").unwrap();
    root
}

#[cfg(target_os = "linux")]
fn assert_steam_check_unavailable(result: Result<(), String>) {
    let error = result.expect_err("probe muss sperren");
    let code = errcode::STEAM_CHECK_UNAVAILABLE;
    // der code steht im leitfeld; ein `starts_with` auf dem rohen präfix würde
    // auch "steam-check-unavailable-extra" als treffer lesen.
    assert!(errcode::has_code(&error, code), "code fehlt: {error}");
    // das detail bleibt diagnose: es nennt pfad bzw. zustand hinter dem code.
    assert!(
        error.starts_with(&format!("{code}: ")),
        "detail fehlt (pfad/zustand): {error}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_lehnt_fehlendes_und_leeres_proc_verzeichnis_ab() {
    let fehlend = std::env::temp_dir().join(format!("protium-proc-missing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&fehlend);
    assert_steam_check_unavailable(probe_proc(&fehlend));

    // leeres verzeichnis: read_dir gelingt, PID 2 fehlt.
    let leer = std::env::temp_dir().join(format!("protium-proc-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&leer);
    std::fs::create_dir_all(&leer).unwrap();
    assert_steam_check_unavailable(probe_proc(&leer));
    let _ = std::fs::remove_dir_all(&leer);
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_akzeptiert_kthreadd_comm_mit_und_ohne_newline() {
    for (name, comm) in [
        ("proc-comm-newline", "kthreadd\n"),
        ("proc-comm-ohne-newline", "kthreadd"),
    ] {
        let root = gueltiger_proc_fixture(name);
        std::fs::write(root.join("2/comm"), comm).unwrap();
        let result = probe_proc(&root);
        assert!(result.is_ok(), "comm {comm:?}: {result:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_lehnt_fremden_comm_ab() {
    let root = gueltiger_proc_fixture("proc-comm-bash");
    std::fs::write(root.join("2/comm"), "bash\n").unwrap();
    assert_steam_check_unavailable(probe_proc(&root));
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_lehnt_comm_als_verzeichnis_ab() {
    let root = gueltiger_proc_fixture("proc-comm-dir");
    std::fs::remove_file(root.join("2/comm")).unwrap();
    std::fs::create_dir(root.join("2/comm")).unwrap();
    assert_steam_check_unavailable(probe_proc(&root));
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_lehnt_fehlende_stat_ab() {
    // comm ist belegt, der ppid-beleg fehlt: die liste ist nicht plausibel,
    // also sperren statt "kein Steam".
    let root = gueltiger_proc_fixture("proc-stat-fehlt");
    std::fs::remove_file(root.join("2/stat")).unwrap();
    assert_steam_check_unavailable(probe_proc(&root));
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_akzeptiert_ppid_null_und_lehnt_ppid_eins_ab() {
    let root = gueltiger_proc_fixture("proc-ppid");
    std::fs::write(root.join("2/stat"), "2 (kthreadd) S 0 2 2 0 -1 0").unwrap();
    let result = probe_proc(&root);
    assert!(result.is_ok(), "ppid 0 muss belegbar sein: {result:?}");

    std::fs::write(root.join("2/stat"), "2 (kthreadd) S 1 2 2 0 -1 0").unwrap();
    assert_steam_check_unavailable(probe_proc(&root));
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn stat_ppid_parst_feld_vier_erst_nach_dem_letzten_klammer_zu() {
    // comm (feld 2) ist geklammert, kann selbst klammern und leerzeichen
    // enthalten: der ppid beginnt erst nach dem LETZTEN `)`.
    assert_eq!(stat_ppid("2 (a) b) S 0 2 2 0 -1 0"), Some(0));
    assert_eq!(stat_ppid("2 (a b c) S 42 2 3"), Some(42));
    assert_eq!(stat_ppid("7 (kthreadd) R 1 2 3"), Some(1));
    // fehlendes oder unlesbares feld bleibt None statt still 0.
    assert_eq!(stat_ppid("2 (kthreadd) S"), None);
    assert_eq!(stat_ppid("2 (kthreadd) S x 2"), None);
    assert_eq!(stat_ppid("kein stat"), None);
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_parst_ppid_hinter_klammern_im_comm() {
    let root = gueltiger_proc_fixture("proc-comm-parens");
    std::fs::write(root.join("2/stat"), "2 (a) b) S 0 2 2 0 -1 0").unwrap();
    let result = probe_proc(&root);
    assert!(result.is_ok(), "ppid hinter dem letzten `)`: {result:?}");
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_akzeptiert_fehlendes_exe_und_lehnt_aufloesbares_ab() {
    let root = gueltiger_proc_fixture("proc-exe");
    // kernel-threads haben keinen exe-link: fehlend ist der erwartete zustand.
    let result = probe_proc(&root);
    assert!(result.is_ok(), "fehlendes exe: {result:?}");

    unixfs::symlink("/usr/bin/steam", root.join("2/exe")).unwrap();
    assert_steam_check_unavailable(probe_proc(&root));
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_lehnt_regulaere_exe_datei_ab() {
    // EINVAL: read_link auf einer regulären datei ist kein belegter
    // kernel-thread, sondern ein unerwarteter zustand -> sperren.
    let root = gueltiger_proc_fixture("proc-exe-datei");
    std::fs::write(root.join("2/exe"), []).unwrap();
    assert_steam_check_unavailable(probe_proc(&root));
    let _ = std::fs::remove_dir_all(&root);
}

/// Der reine klassifikator des `exe`-links: nur belegte abwesenheit ist
/// erwartet. `EINVAL` (reguläre datei) und jeder andere fehler widersprechen
/// dem bild eines kernel-threads.
#[cfg(target_os = "linux")]
#[test]
fn exe_error_is_expected_nur_bei_notfound_und_permissiondenied() {
    for (kind, erwartet) in [
        (std::io::ErrorKind::NotFound, true),
        (std::io::ErrorKind::PermissionDenied, true),
        (std::io::ErrorKind::InvalidInput, false),
        (std::io::ErrorKind::Other, false),
    ] {
        assert_eq!(exe_error_is_expected(kind), erwartet, "{kind:?}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn probe_exe_akzeptiert_eacces() {
    // Der volle probe-pfad kann EACCES nicht konstruieren (comm/stat brauchen
    // denselben durchsuchbaren parent); die entscheidung selbst ist deshalb
    // separat tabellarisch geprüft (exe_error_is_expected_...). Hier bleibt der
    // feldtest: als root greift kein chmod-schutz, der fall wird dann sichtbar
    // übersprungen, nicht still grün.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("übersprungen: als root ist EACCES auf exe nicht konstruierbar");
        return;
    }
    use std::os::unix::fs::PermissionsExt;

    let root = std::env::temp_dir().join(format!("protium-proc-exe-eacces-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let gesperrt = root.join("gesperrt");
    std::fs::create_dir_all(&gesperrt).unwrap();
    std::fs::set_permissions(&gesperrt, std::fs::Permissions::from_mode(0o000)).unwrap();

    let result = probe_exe_not_resolvable(&gesperrt.join("exe"));

    std::fs::set_permissions(&gesperrt, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        result.is_ok(),
        "EACCES ist belegte abwesenheit, kein widerspruch: {result:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(target_os = "linux")]
#[test]
fn is_steam_process_name_erkennt_steam_und_helpers() {
    assert!(is_steam_process_name("steam"));
    assert!(is_steam_process_name("Steam"));
    assert!(is_steam_process_name("steamwebhelper"));
    // der check bleibt beim namens-substring; fremde prozesse sperren nicht.
    assert!(!is_steam_process_name("proton"));
    assert!(!is_steam_process_name(""));
}

/// Der befund des scannens als reine entscheidung: ohne die eigene PID ist die
/// liste nicht belegbar, und der namens-substring entscheidet wie in der
/// produktion.
#[cfg(target_os = "linux")]
#[test]
fn steam_running_from_verlangt_sichtbare_eigene_pid_und_steam_namen() {
    let error = steam_running_from(false, Vec::new()).unwrap_err();
    assert!(
        errcode::has_code(&error, errcode::STEAM_CHECK_UNAVAILABLE),
        "unerwarteter fehler: {error}"
    );
    assert!(
        error.starts_with("steam-check-unavailable: "),
        "detail fehlt: {error}"
    );

    for (namen, erwartet) in [
        (Vec::<String>::new(), false),
        (vec!["proton".to_string()], false),
        (vec!["steamwebhelper".to_string()], true),
    ] {
        assert_eq!(
            steam_running_from(true, namen.clone()).unwrap(),
            erwartet,
            "{namen:?}"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn is_steam_running_sync_ist_ok_genau_wenn_probe_und_eigene_pid_belegbar_sind() {
    // belegt die verdrahtung (probe + Selbst-PID) ohne host-annahme: die
    // eigene prozessliste wird hier unabhängig von der produktion gebaut.
    let sys = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_processes(sysinfo::ProcessRefreshKind::nothing()),
    );
    let eigene_pid = sysinfo::Pid::from_u32(std::process::id());
    let erwartet =
        probe_proc(Path::new("/proc")).is_ok() && sys.processes().contains_key(&eigene_pid);

    assert_eq!(is_steam_running_sync().is_ok(), erwartet);
}

#[cfg(target_os = "linux")]
#[test]
fn probe_bleibt_im_scan_verdrahtet_und_meldet_read_dir_fehler() {
    // Auf einem echten /proc ist ein entferntes `?` nicht beobachtbar; der pin
    // hält die verdrahtung fest: der scan zieht die probe selbst, und die probe
    // bildet den `read_dir`-fehler ab. Ohne das wäre ein unlesbares /proc still
    // "kein Steam" (Audit 5.5).
    let production = production_source(include_str!("fs_ops.rs"));

    let scan = production
        .split("fn is_steam_running_sync()")
        .nth(1)
        .expect("is_steam_running_sync muss vorhanden sein")
        .split("\n}\n")
        .next()
        .expect("is_steam_running_sync braucht einen rumpf");
    assert!(
        scan.contains("probe_proc(Path::new(\"/proc\"))?"),
        "der scan muss die probe auf /proc ziehen und ihren fehler weiterreichen"
    );
    assert!(
        scan.contains("steam_running_from(") && scan.contains("contains_key(&own_pid)"),
        "der scan muss die sichtbare eigene PID prüfen und an steam_running_from reichen"
    );

    let probe = production
        .split("fn probe_proc(root: &Path)")
        .nth(1)
        .expect("probe_proc muss vorhanden sein")
        .split("\n}\n")
        .next()
        .expect("probe_proc braucht einen rumpf");
    let statement = probe
        .split("fs::read_dir(root)")
        .nth(1)
        .expect("probe_proc muss /proc öffnen");
    let statement = &statement[..statement
        .find(';')
        .expect("der read_dir-aufruf braucht ein statement-ende")];
    assert!(
        statement.contains("map_err") && statement.contains('?'),
        "read_dir muss den fehler abbilden und weiterreichen: {statement}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn probe_proc_realer_proc_host_smoke_teilt_comm_exe_und_parst_ppid_unabhaengig() {
    // host-smoke: comm- und exe-prädikat kommen aus der produktion selbst
    // (`comm_is_kthreadd`, `probe_exe_not_resolvable`), der ppid wird hier
    // unabhängig geparst (eigene zerlegung, kein `stat_ppid`). Der test erkennt
    // ÜBER-strenge: lehnt `probe_proc` ein plausibles /proc ab, weicht die
    // produktion von ihren eigenen prädikaten ab. Entfernte schritte deckt er
    // NICHT auf — fehlt etwa die comm-prüfung, bleibt die gleichung auf einem
    // intakten /proc wahr; das leisten die fixtures.
    let comm_ok = std::fs::read_to_string("/proc/2/comm").is_ok_and(|comm| comm_is_kthreadd(&comm));
    let exe_ok = probe_exe_not_resolvable(Path::new("/proc/2/exe")).is_ok();
    let independent_ppid_zero = std::fs::read_to_string("/proc/2/stat")
        .map(|stat| {
            let rest = &stat[stat.rfind(')').unwrap_or(0) + 1..];
            let fields: Vec<&str> = rest
                .split(|zeichen: char| zeichen.is_ascii_whitespace())
                .filter(|feld| !feld.is_empty())
                .collect();
            fields.get(1).copied() == Some("0")
        })
        .unwrap_or(false);

    let shared_comm_exe = comm_ok && exe_ok;
    assert_eq!(
        probe_proc(Path::new("/proc")).is_ok(),
        shared_comm_exe && independent_ppid_zero
    );
}

// F5.4: der reduzierte config.vdf-inhalt trägt beide Mapping-layouts und
// nichts sonst. Der vertragstest für den TS-parser liegt in
// tests/core/compatTools.test.ts. Den eingabetext (`BEIDE_LAYOUTS`) teilt
// dieses modul mit `vdf_patch::tests`; er stand vorher wortgleich in beiden
// testdateien (Befund 12).

#[cfg(target_os = "linux")]
#[test]
fn reduce_compat_config_enthaelt_beide_layouts_und_keine_fremden_bloecke() {
    let reduced = reduce_compat_config(BEIDE_LAYOUTS).unwrap();

    // kein fremder teilbaum (login-tokens u. ä.) im reduzierten inhalt
    assert!(!reduced.contains("ConnectCache"), "{reduced}");
    assert!(!reduced.contains("geheim"), "{reduced}");

    // beide layouts sind enthalten, in fester reihenfolge
    assert_eq!(
        reduced.matches("\"CompatToolMapping\"").count(),
        2,
        "{reduced}"
    );
    let klassisch = reduced.find("\"InstallConfigStore\"").expect("layout 1");
    let flach = reduced.find("\"Software\"\n{").expect("layout 2");
    assert!(klassisch < flach, "reihenfolge: {reduced}");

    // der reduzierte inhalt ist über beide root-knoten lesbar
    assert_eq!(
        crate::commands::vdf_patch::get_vdf_value(
            &reduced,
            &[
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                "620",
                "name",
            ],
        )
        .unwrap(),
        Some("GE-Proton9-1".to_string())
    );
    assert_eq!(
        crate::commands::vdf_patch::get_vdf_value(
            &reduced,
            &[
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                "730",
                "name"
            ],
        )
        .unwrap(),
        Some("proton_experimental".to_string())
    );
}

// Cross-parser-vertrag für beide layouts: die fixture ist der byte-genaue
// output von `reduce_compat_config`, nicht handgeformt. Dieselbe datei liest
// tests/core/compatTools.test.ts über `parseCompatToolMapping` zurück.
#[cfg(target_os = "linux")]
#[test]
fn reduce_compat_config_beide_layouts_ist_byte_gleich_der_fixture() {
    let expected = include_str!("../../../tests/fixtures/cross-parser-mapping-both-layouts.vdf");
    assert_eq!(reduce_compat_config(BEIDE_LAYOUTS).unwrap(), expected);
}

// Gegenprobe: liegt nur das klassische layout vor, bleibt das flache als
// leeres gerüst der vorfahren-kette `Software`/`Valve`/`Steam` als zweiter
// root-knoten stehen. Der klassische teil ist byte-gleich der S-03-fixture
// (cross-parser-config-input.vdf trägt nur das klassische layout), sodass die
// erwartung nicht frei erfunden ist.
#[cfg(target_os = "linux")]
#[test]
fn reduce_compat_config_klassisch_ohne_flach_haelt_leeres_geruest() {
    let klassisch_only = include_str!("../../../tests/fixtures/cross-parser-config-input.vdf");
    let expected = format!(
        "{}\n\"Software\"\n{{\n\"Valve\"\n{{\n\"Steam\"\n{{\n\n}}\n}}\n}}",
        include_str!("../../../tests/fixtures/cross-parser-mapping-expected.vdf")
    );
    let reduced = reduce_compat_config(klassisch_only).unwrap();
    assert_eq!(reduced, expected);

    // das flache mapping fehlt, das gerüst ist trotzdem adressierbar
    assert_eq!(
        reduced.matches("\"CompatToolMapping\"").count(),
        1,
        "{reduced}"
    );
    assert_eq!(
        crate::commands::vdf_patch::get_vdf_value(
            &reduced,
            &["Software", "Valve", "Steam", "CompatToolMapping"],
        )
        .unwrap(),
        None
    );
}
