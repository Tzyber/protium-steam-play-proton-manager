use crate::commands::scope::{EnvironmentState, MAX_ENVIRONMENT_READ_BYTES};
use crate::commands::spawn_blocking_io;
#[cfg(target_os = "linux")]
use crate::commands::steam::{ensure_regular_fd, open_bound_root_fd, open_dir_at, open_file_at};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::unix::io::AsRawFd;
use std::path::Path;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::State;

// Verzeichnisgrößen und Pfadidentität über `(dev, ino)`.

const MAX_BATCH_DIR_SIZE_PATHS: usize = 4096;
/// Maximale Walk-Tiefe für die Größenmessung: echte Steam-Bäume sind flach,
/// ohne Cap liesse ein künstlich tiefer Baum den rekursiven Walker den
/// Blocking-Thread-Stack überlaufen lassen (abort).
const MAX_DIRECTORY_WALK_DEPTH: usize = 256;
const MAX_ENVIRONMENT_DIR_ENTRIES: usize = 8192;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum DirectorySize {
    Measured {
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
    Missing,
    Failed {
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentDirEntry {
    pub name: String,
    pub is_directory: bool,
    pub is_symlink: bool,
}

fn read_environment_file(
    state: &EnvironmentState,
    path: &str,
    label: &str,
) -> Result<Vec<u8>, String> {
    read_environment_file_with_hook(state, path, label, &mut || {}, &mut |_| {})
}

/// Liest eine autorisierte Datei unter Linux über eine gebundene no-follow-
/// Deskriptorkette: Der Parent wird als Root gebunden (dev/ino-Check gegen
/// Tausch zwischen stat und open), die Datei per `openat(O_NOFOLLOW)` aus dem
/// gebundenen Parent geöffnet. Größenlimit und Read beziehen sich auf den
/// geöffneten Deskriptor (`cap + 1`-Read), nicht auf einen zuvor geprüften
/// Pfad. Nicht-Linux verweigert fail-closed, weil dieselbe Grenze dort nicht
/// belegbar ist.
#[cfg(target_os = "linux")]
fn read_environment_file_with_hook(
    state: &EnvironmentState,
    path: &str,
    label: &str,
    before_open: &mut dyn FnMut(),
    after_open: &mut dyn FnMut(&mut std::fs::File),
) -> Result<Vec<u8>, String> {
    state.with_authorized_existing(path, label, |real| {
        let parent = real
            .parent()
            .ok_or_else(|| format!("{label}: no parent directory"))?;
        let file_name = real
            .file_name()
            .ok_or_else(|| format!("{label}: no file name"))?;
        let parent_fd =
            open_bound_root_fd(parent, before_open).map_err(|error| format!("{label}: {error}"))?;
        let mut file = open_file_at(parent_fd.as_raw_fd(), file_name)
            .map_err(|error| format!("{label}: {error}"))?;
        after_open(&mut file);
        let length = ensure_regular_fd(&file, label)?;
        if length > MAX_ENVIRONMENT_READ_BYTES {
            return Err(format!("{label}: file exceeds read limit"));
        }
        let read_limit = MAX_ENVIRONMENT_READ_BYTES
            .checked_add(1)
            .ok_or_else(|| format!("{label}: read limit overflows"))?;
        let mut bytes = Vec::new();
        file.take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("{label}: {error}"))?;
        if bytes.len() as u64 > MAX_ENVIRONMENT_READ_BYTES {
            return Err(format!("{label}: file exceeds read limit"));
        }
        Ok(bytes)
    })
}

#[cfg(not(target_os = "linux"))]
fn read_environment_file_with_hook(
    _state: &EnvironmentState,
    _path: &str,
    label: &str,
    _before_open: &mut dyn FnMut(),
    _after_open: &mut dyn FnMut(&mut std::fs::File),
) -> Result<Vec<u8>, String> {
    Err(format!("{label}: only supported on linux"))
}

#[tauri::command]
pub async fn environment_exists(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<bool, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || state.environment_exists(&path)).await
}

#[tauri::command]
pub async fn environment_read_text(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        let bytes = read_environment_file(&state, &path, "environment read text")?;
        String::from_utf8(bytes).map_err(|error| format!("environment read text: {error}"))
    })
    .await
}

#[tauri::command]
pub async fn environment_read_binary(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let state = state.inner().clone();
    let bytes =
        spawn_blocking_io(move || read_environment_file(&state, &path, "environment read binary"))
            .await?;
    // binäre ipc-response statt serde-json-zahlen-array: cover-bytes (~100 KB)
    // wären als json-array 3-5× so groß und müssten im webview geparst werden.
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn environment_read_dir(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<Vec<EnvironmentDirEntry>, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        read_environment_dir_with_hook(&state, &path, "environment read dir", &mut || {})
    })
    .await
}

/// Liest eine autorisierte Verzeichnisliste unter Linux über einen gebundenen
/// no-follow-Deskriptor (Tausch zwischen stat und open bricht ab). Das
/// Entry-Limit gilt für die Liste des geöffneten Deskriptors. Nicht-Linux
/// verweigert fail-closed.
#[cfg(target_os = "linux")]
fn read_environment_dir_with_hook(
    state: &EnvironmentState,
    path: &str,
    label: &str,
    before_open: &mut dyn FnMut(),
) -> Result<Vec<EnvironmentDirEntry>, String> {
    state.with_authorized_existing(path, label, |real| {
        let dir_fd =
            open_bound_root_fd(&real, before_open).map_err(|error| format!("{label}: {error}"))?;
        let proc_path = Path::new("/proc/self/fd").join(dir_fd.as_raw_fd().to_string());
        let mut entries = Vec::new();
        for (index, entry) in fs::read_dir(&proc_path)
            .map_err(|error| format!("{label}: {error}"))?
            .enumerate()
        {
            if index >= MAX_ENVIRONMENT_DIR_ENTRIES {
                return Err(format!("{label}: entry limit exceeded"));
            }
            let entry = entry.map_err(|error| format!("{label}: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("{label}: {error}"))?;
            entries.push(EnvironmentDirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_directory: file_type.is_dir(),
                is_symlink: file_type.is_symlink(),
            });
        }
        Ok(entries)
    })
}

#[cfg(not(target_os = "linux"))]
fn read_environment_dir_with_hook(
    _state: &EnvironmentState,
    _path: &str,
    label: &str,
    _before_open: &mut dyn FnMut(),
) -> Result<Vec<EnvironmentDirEntry>, String> {
    Err(format!("{label}: only supported on linux"))
}

fn checked_size_add(total: u64, next: u64) -> Result<u64, String> {
    let total = total
        .checked_add(next)
        .ok_or_else(|| "directory size sum overflow".to_string())?;
    if total > MAX_SAFE_JS_INTEGER {
        return Err("directory size exceeds JavaScript safe integer".into());
    }
    Ok(total)
}

/// fd-gebundener Verzeichnis-Walk: Der Root wurde bereits als Deskriptor
/// gebunden; jeder Unterbaum wird per `openat(O_NOFOLLOW)` aus dem
/// Parent-Deskriptor geöffnet. Ein Tausch des Roots oder eines Kindes nach
/// der Bindung misst den gebundenen alten Stand, nie einen fremden Baum.
/// Symlinks zählen weder als Verzeichnis noch als Datei und werden
/// übersprungen. `relative` ist der Pfad vom Root (für Fehlermeldungen und
/// Test-Hooks). Die Tiefe ist gedeckelt, damit eine künstlich tiefe
/// Verschachtelung den Blocking-Thread-Stack nicht überlaufen lässt
/// (fail-closed wie beim binären VDF-Parser).
#[cfg(target_os = "linux")]
fn walk_directory_fd(
    dir_fd: &std::os::unix::io::OwnedFd,
    relative: &Path,
    depth: usize,
    before_read: &mut dyn FnMut(&Path) -> Result<(), String>,
    total: &mut u64,
) -> Result<(), String> {
    if depth > MAX_DIRECTORY_WALK_DEPTH {
        return Err("directory walk too deep".into());
    }
    let proc_path = Path::new("/proc/self/fd").join(dir_fd.as_raw_fd().to_string());
    let rd = fs::read_dir(&proc_path).map_err(|error| format!("read_dir {relative:?}: {error}"))?;
    for entry in rd {
        let entry = entry.map_err(|error| format!("read_dir entry {relative:?}: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("file_type {relative:?}: {error}"))?;
        let name = entry.file_name();
        let child = relative.join(&name);
        if file_type.is_dir() {
            before_read(&child)?;
            let child_fd = open_dir_at(dir_fd.as_raw_fd(), name.as_os_str())
                .map_err(|error| format!("open_dir {child:?}: {error}"))?;
            walk_directory_fd(&child_fd, &child, depth + 1, before_read, total)?;
        } else if file_type.is_file() {
            before_read(&child)?;
            let file = open_file_at(dir_fd.as_raw_fd(), name.as_os_str())
                .map_err(|error| format!("open_file {child:?}: {error}"))?;
            let length = ensure_regular_fd(&file, &child.to_string_lossy())?;
            *total = checked_size_add(*total, length)?;
        }
    }
    Ok(())
}

/// Misst ein Verzeichnis fd-gebunden. `before_metadata` läuft vor dem ersten
/// Stat des Roots (fehlender Root bleibt `missing`), `before_bind` zwischen
/// Stat und Open der Root-Bindung (Root-Tausch wird erkannt), `before_read`
/// vor jedem Open mit dem Pfad relativ zum Root ("" = Root selbst).
#[cfg(target_os = "linux")]
fn measure_directory_with_hook(
    path: &Path,
    before_metadata: &mut dyn FnMut(&Path) -> Result<(), String>,
    before_bind: &mut dyn FnMut(),
    before_read: &mut dyn FnMut(&Path) -> Result<(), String>,
) -> Result<DirectorySize, String> {
    before_metadata(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DirectorySize::Missing);
        }
        Err(error) => {
            return Ok(DirectorySize::Failed {
                detail: Some(format!("directory size: {error}")),
            });
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("directory size: not a regular directory".into());
    }
    let root_fd = open_bound_root_fd(path, before_bind)
        .map_err(|error| format!("directory size: {error}"))?;
    let mut total = 0u64;
    before_read(Path::new(""))?;
    match walk_directory_fd(&root_fd, Path::new(""), 0, before_read, &mut total) {
        Ok(()) => Ok(DirectorySize::Measured { size_bytes: total }),
        Err(detail) => Ok(DirectorySize::Failed {
            detail: Some(detail),
        }),
    }
}

#[cfg(target_os = "linux")]
fn measure_directory(path: &Path) -> Result<DirectorySize, String> {
    measure_directory_with_hook(path, &mut |_| Ok(()), &mut || {}, &mut |_| Ok(()))
}

#[cfg(not(target_os = "linux"))]
fn measure_directory(path: &Path) -> Result<DirectorySize, String> {
    let _ = path;
    Err("directory size: only supported on linux".into())
}

/// Kanonischer Pfad und `(dev, ino)` zur Library-Deduplizierung.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub(crate) struct PathIdentity {
    pub realpath: String,
    pub dev: String,
    pub ino: String,
}

/// Prüft ausschließlich den Prozessnamen `steam`.
/// bewusst kein generisches process-enumeration-werkzeug für die webview.
/// async + spawn_blocking: sync commands laufen bei tauri v2 auf dem main-thread,
/// und dieser check steht vor JEDEM write-gate.
pub(super) fn is_process_running_sync(name: &str) -> Result<bool, String> {
    if name.to_lowercase() != "steam" {
        return Err("process check only allowed for steam".into());
    }
    // Substring-Match schließt absichtlich Steam-Helper wie steamwebhelper ein;
    // false-positive Blockade ist sicherer als false-negative während Writes.
    // nur die prozessliste refreshen, new_all() baute eine komplette
    // system-inventur (CPU/RAM/disks/netzwerk) für einen namens-check.
    // name() kommt aus /proc/<pid>/stat und ist auch mit
    // ProcessRefreshKind::nothing() befüllt.
    let sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    let target = name.to_lowercase();
    Ok(sys
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().to_lowercase().contains(&target)))
}

#[tauri::command]
pub async fn is_process_running(name: String) -> Result<bool, String> {
    spawn_blocking_io(move || is_process_running_sync(&name)).await
}

/// Berechnet die Größe eines Verzeichnisses.
/// async + spawn_blocking: der rekursive walk darf nicht auf dem main-thread laufen.
#[tauri::command]
pub async fn dir_size(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<DirectorySize, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        state.with_authorized_optional(&path, "dir_size", |real| {
            let Some(real) = real else {
                return Ok(DirectorySize::Missing);
            };
            measure_directory(&real)
        })
    })
    .await
}

/// Berechnet Verzeichnisgrößen sequenziell; der Vorgang ist I/O-gebunden.
/// async + spawn_blocking: walkt GB-große bäume, gehört nicht auf den main-thread.
#[tauri::command]
pub async fn batch_dir_sizes(
    state: State<'_, EnvironmentState>,
    paths: Vec<String>,
) -> Result<HashMap<String, DirectorySize>, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        if paths.len() > MAX_BATCH_DIR_SIZE_PATHS {
            return Err("too many paths for batch_dir_sizes".into());
        }
        state.with_authorized_batch(&paths, |authorized| {
            let mut result = HashMap::with_capacity(authorized.len());
            for authorized_path in authorized {
                let path = authorized_path.requested;
                let Some(real) = authorized_path.real else {
                    result.insert(path, DirectorySize::Missing);
                    continue;
                };
                result.insert(path, measure_directory(&real)?);
            }
            Ok(result)
        })
    })
    .await
}

/// symlink-auflösung (steam-root-discovery). `..` im input abgelehnt,
/// auflösungen in blockierte dateisysteme verweigert (info-disclosure).
/// Nutzt `canonicalize_safe()` (Sanitize + Realpath + Systempfad-Blocklist).
/// async + spawn_blocking: canonicalize ist Dateisystem-I/O und darf keinen
/// Command-Thread blockieren.
#[tauri::command]
pub async fn canonicalize_path(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        state.with_authorized_existing(&path, "canonicalize", |real| {
            Ok(real.to_string_lossy().into_owned())
        })
    })
    .await
}

/// Liefert kanonischen Pfad und `(dev, ino)` zur Library-Deduplizierung.
/// Nutzt `canonicalize_safe()` (Sanitize + Realpath + Systempfad-Blocklist).
/// async + spawn_blocking: metadata ist Dateisystem-I/O und darf keinen
/// Command-Thread blockieren.
#[tauri::command]
pub async fn path_identity(
    state: State<'_, EnvironmentState>,
    path: String,
) -> Result<PathIdentity, String> {
    let state = state.inner().clone();
    spawn_blocking_io(move || {
        state.with_authorized_existing(&path, "path_identity", |real| {
            let md = fs::metadata(&real).map_err(|error| format!("path_identity: {error}"))?;
            #[cfg(unix)]
            use std::os::unix::fs::MetadataExt;
            #[cfg(unix)]
            let identity = (md.dev().to_string(), md.ino().to_string());
            #[cfg(not(unix))]
            let identity = (String::from("0"), md.len().to_string());
            Ok(PathIdentity {
                realpath: real.to_string_lossy().into_owned(),
                dev: identity.0,
                ino: identity.1,
            })
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        measure_directory_with_hook, read_environment_dir_with_hook, read_environment_file,
        read_environment_file_with_hook, DirectorySize, MAX_SAFE_JS_INTEGER,
    };
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

        let res = measure_directory_with_hook(&via, &mut |_| Ok(()), &mut || {}, &mut |_| Ok(()))
            .unwrap();
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
        let result =
            measure_directory_with_hook(&root, &mut |_| Ok(()), &mut || {}, &mut read_hook);

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

        let result =
            measure_directory_with_hook(&root, &mut |_| Ok(()), &mut || {}, &mut |_| Ok(()));
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
        let root =
            std::env::temp_dir().join(format!("protium-env-file-swap-{}", std::process::id()));
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
        let root =
            std::env::temp_dir().join(format!("protium-env-file-growth-{}", std::process::id()));
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
        let root =
            std::env::temp_dir().join(format!("protium-env-dir-list-{}", std::process::id()));
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
        let root =
            std::env::temp_dir().join(format!("protium-env-dir-limit-{}", std::process::id()));
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
        let root =
            std::env::temp_dir().join(format!("protium-env-dir-swap-{}", std::process::id()));
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
}
