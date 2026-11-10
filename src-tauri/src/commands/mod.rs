// rust-commands für operationen außerhalb des webviews.
//
// die anwendung ist linux-only; gebaut und geprüft wird ausschließlich
// `target_os = "linux"`. die `#[cfg(not(target_os = "linux"))]`-zweige sind
// fail-closed fehlerstummel statt degradation; ob sie auf einem fremdziel
// vollständig kompilieren, ist nicht belegt (r-12).

pub(crate) mod cleanup;
pub(crate) mod compat_auth;
pub(crate) mod delete_inspect;
pub(crate) mod delete_ops;
pub(crate) mod delete_usage;
pub(crate) mod diagnostics;
pub(crate) mod download;
pub(crate) mod errcode;
pub(crate) mod external;
pub(crate) mod extract;
pub(crate) mod fd;
pub(crate) mod fs_ops;
pub(crate) mod ge_install;
pub(crate) mod http_get;
pub(crate) mod libraryfolders;
pub(crate) mod path;
pub(crate) mod prefix;
pub(crate) mod scope;
pub(crate) mod shortcuts_bin;
pub(crate) mod steam;
pub(crate) mod steam_layout;
pub(crate) mod vdf_patch;
pub(crate) mod write_gate;

/// spawn_blocking + join-handle-fehler → String. die sync-commands laufen
/// bei tauri v2 auf dem main-thread, blockierende IO gehört in den
/// blocking-pool (batch C1).
///
/// 3.5: ein JoinError ist ein ausgefallener pool (panic/abbruch), kein
/// fachlicher Fehler des commands; er trägt deshalb `unavailable` mit dem
/// JoinError als detail statt eines rohtextes.
pub(crate) async fn spawn_blocking_io<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|error| errcode::with_detail(errcode::UNAVAILABLE, error))?
}

#[cfg(test)]
mod tests {
    use super::spawn_blocking_io;
    use crate::commands::errcode;

    /// 3.5: ein JoinError ist ein ausgefallener blocking-pool, kein fachlicher
    /// fehler des commands. Ohne die abbildung landet sein display-text als
    /// rohfehler in der oberfläche.
    #[tokio::test(flavor = "current_thread")]
    async fn join_error_traegt_unavailable() {
        let error = spawn_blocking_io(|| -> Result<(), String> { panic!("pool kaputt") })
            .await
            .unwrap_err();

        assert!(errcode::has_code(&error, errcode::UNAVAILABLE), "{error}");
    }

    // ---- B1-Pins: nur im Quelltext prüfbare Zweige und Platzierungen ----

    const CFG_NOT_LINUX: &str = "#[cfg(not(target_os = \"linux\"))]";

    /// Je `cfg(not(target_os = "linux"))` der Stub-Block bis zum nächsten
    /// `#[cfg(`. Die Zweige kompilieren auf Linux nicht, deshalb ist der
    /// Quelltext ihr einziger Beleg.
    fn cfg_not_linux_blocks(source: &str) -> Vec<&str> {
        let mut blocks = Vec::new();
        let mut rest = source;
        while let Some(start) = rest.find(CFG_NOT_LINUX) {
            let line_start = rest[..start].rfind('\n').map_or(0, |index| index + 1);
            let indent = start - line_start;
            let after = &rest[start + CFG_NOT_LINUX.len()..];
            let mut end = after.len();
            let mut offset = 0;
            for line in after.split_inclusive('\n') {
                let trimmed = line.trim_start();
                let line_indent = line.len() - trimmed.len();
                if line_indent <= indent
                    && !trimmed.is_empty()
                    && (trimmed.starts_with('#') || trimmed.starts_with('}'))
                {
                    end = offset;
                    break;
                }
                offset += line.len();
            }
            blocks.push(&after[..end]);
            rest = &after[end..];
        }
        blocks
    }

    fn pinned_block<'a>(source: &'a str, needle: &str) -> &'a str {
        let mut matches = cfg_not_linux_blocks(source)
            .into_iter()
            .filter(|block| block.contains(needle));
        let block = matches
            .next()
            .unwrap_or_else(|| panic!("stub fehlt: {needle}"));
        assert!(matches.next().is_none(), "stub mehrdeutig: {needle}");
        block
    }

    /// FR-3: die fünf nicht-linux-stummel tragen den plattformcode mit detail
    /// statt eines rohtextes (der als "unbekannt" in der oberfläche landet).
    #[test]
    fn nicht_linux_stummel_tragen_unsupported_platform() {
        let sites: [(&str, &str); 5] = [
            (
                include_str!("libraryfolders.rs"),
                "fn libraryfolders_contents_with_hook<F>(",
            ),
            (
                include_str!("delete_inspect.rs"),
                "fn delete_inspection_unsupported",
            ),
            (include_str!("write_gate.rs"), "fn read_config_text_bounded"),
            (
                include_str!("compat_auth.rs"),
                "fn compat_root_contains_name_linux_with_hook<F>(",
            ),
            (
                include_str!("compat_auth.rs"),
                "Valve compat tool authority",
            ),
        ];
        for (source, needle) in sites {
            let block = pinned_block(source, needle);
            assert!(
                block.contains("errcode::UNSUPPORTED_PLATFORM"),
                "{needle} muss with_detail(UNSUPPORTED_PLATFORM, ...) liefern: {block}"
            );
        }
    }

    /// FR-7: `prepare_app_dir` ist blockierende io und gehört in den
    /// blocking-pool. Der Pin schlägt an, wenn der Aufruf vor
    /// `spawn_blocking_io(` oder nach dem `.await` steht.
    #[test]
    fn prepare_app_dir_laeuft_im_blocking_pool() {
        for (source, command) in [
            (
                include_str!("diagnostics.rs"),
                "pub async fn read_log_tail(",
            ),
            (
                include_str!("diagnostics.rs"),
                "pub async fn log_diagnostic(",
            ),
            (
                include_str!("diagnostics.rs"),
                "pub async fn open_logs_folder(",
            ),
            (
                include_str!("steam.rs"),
                "pub async fn open_backups_folder(",
            ),
        ] {
            let start = source
                .find(command)
                .unwrap_or_else(|| panic!("command fehlt: {command}"));
            let rest = &source[start..];
            let end = rest
                .find("\n}")
                .unwrap_or_else(|| panic!("ende fehlt: {command}"));
            let body = &rest[..end];
            let spawn = body
                .find("spawn_blocking_io(")
                .unwrap_or_else(|| panic!("kein spawn_blocking_io: {command}"));
            let prepare = body
                .find("prepare_app_dir(")
                .unwrap_or_else(|| panic!("kein prepare_app_dir: {command}"));
            let awaited = spawn
                + body[spawn..]
                    .find(".await")
                    .unwrap_or_else(|| panic!("kein .await: {command}"));
            assert!(
                spawn < prepare && prepare < awaited,
                "prepare_app_dir liegt nicht im blocking-pool: {command}"
            );
            assert_eq!(
                body.matches("prepare_app_dir(").count(),
                1,
                "prepare_app_dir mehrfach in {command}"
            );
        }
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use serde::ser::{self, Impossible, Serialize, SerializeStruct, Serializer};

    // gemeinsame fixture-helper der command-tests: tempdir-fixtures für
    // state-, trash- und write-gate-tests.
    pub(super) fn fixture_dir(prefix: &str, tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("protium-{prefix}-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    pub(super) fn wsg_fixture(tag: &str) -> std::path::PathBuf {
        fixture_dir("wsg", tag)
    }

    pub(super) fn wsg_env(
        tag: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        wsg_env_at(tag, ".local/share/Steam")
    }

    pub(super) fn wsg_env_at(
        tag: &str,
        steam_relative: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = wsg_fixture(tag);
        let home = root.join("fakehome");
        let steam = home.join(steam_relative);
        std::fs::create_dir_all(steam.join("config")).unwrap();
        std::fs::create_dir_all(steam.join("userdata/123/config")).unwrap();
        let config_vdf = r#""InstallConfigStore"
    {
    	"Software"
    	{
    		"Valve"
    		{
    			"Steam"
    			{
    				"CompatToolMapping"
    				{
    					"620"
    					{
    						"name"		"GE-Proton9-27"
    					}
    				}
    			}
    		}
    	}
    }
    "#;
        let local_vdf = r#""UserLocalConfigStore"
    {
    	"Software"
    	{
    		"Valve"
    		{
    			"Steam"
    			{
    				"Apps"
    				{
    					"620"
    					{
    						"LaunchOptions"		"gamemoderun %command%"
    					}
    				}
    			}
    		}
    	}
    }
    "#;
        std::fs::write(steam.join("config/config.vdf"), config_vdf).unwrap();
        std::fs::write(steam.join("userdata/123/config/localconfig.vdf"), local_vdf).unwrap();
        for tool_name in ["GE-Proton9-27", "GE-Proton9-28"] {
            let tool_dir = steam.join("compatibilitytools.d").join(tool_name);
            std::fs::create_dir_all(&tool_dir).unwrap();
            let tool_vdf = format!(
                "\"compatibilitytools\" {{ \"compat_tools\" {{ \"{tool_name}\" {{ }} }} }}"
            );
            std::fs::write(tool_dir.join("compatibilitytool.vdf"), tool_vdf).unwrap();
        }
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        (home, cache, steam)
    }

    /// Legt ein minimales App-Manifest an; compat_auth- und Write-Gate-Tests
    /// brauchen denselben Nachweis einer installierten Steam-App.
    pub(super) fn write_appmanifest(steamapps: &std::path::Path, app_id: u32) {
        std::fs::create_dir_all(steamapps).unwrap();
        std::fs::write(
            steamapps.join(format!("appmanifest_{app_id}.acf")),
            format!("\"AppState\" {{ \"appid\" \"{app_id}\" }}"),
        )
        .unwrap();
    }

    /// Schneidet den Produktionsteil einer Quelldatei ab, die sich per
    /// `include_str!` selbst einliest.
    ///
    /// Grenze ist ausschließlich die Moduldeklaration `#[cfg(test)]` direkt vor
    /// `mod tests {`. Ein nacktes `split("#[cfg(test)]")` wäre still falsch:
    /// `download.rs` trägt einen `#[cfg(test)]`-Import und einen
    /// `#[cfg(test)]`-Testseam VOR dem Produktionscode, `write_gate.rs` mehrere
    /// `#[cfg(test)]`-Blöcke. Ein zu früher Schnitt macht den geprüften Text
    /// kürzer und den Test damit grün, ohne dass er noch etwas prüft. Deshalb
    /// gilt: kein Treffer = Panik.
    pub(super) fn production_source(source: &str) -> &str {
        // Seit die Testmodule ausgelagert sind, endet der Produktionsteil an
        // `#[cfg(test)]` vor `mod tests;` (Verweis auf die Testdatei) ODER vor
        // einem eingebetteten `mod tests {`. Beide Formen sind gültig; ein
        // fehlender Marker bleibt ein harter Fehler, damit ein still zu kurz
        // geschnittener Text nicht als grüner Test durchgeht.
        //
        // `prefix.rs` hängt sein Testmodul an `cfg(all(test, target_os =
        // "linux"))`. Der Marker verlangt `#[path =` direkt danach: ein
        // cfg-gated Import weiter oben im Text ist keine Modulgrenze und würde
        // den Schnitt sonst zu früh setzen.
        let module = source.find("\n#[cfg(test)]\n#[path =");
        let inline = source.find("\n#[cfg(test)]\nmod tests {");
        let platform_module = source.find("\n#[cfg(all(test, target_os = \"linux\"))]\n#[path =");
        let end = [module, inline, platform_module]
            .into_iter()
            .flatten()
            // kein Testmodul im Text: der ganze text ist produktionscode. Die
            // aufrufer prüfen ausschließlich verbote, ein zu kurzer text wäre
            // still grün, deshalb bleibt der leere fall ein harter fehler.
            .min()
            .unwrap_or_else(|| panic!("source has no `#[cfg(test)]` test module"));
        &source[..end]
    }

    // ---- Wire-Vertrag ohne serde_json ----
    //
    // Der Serializer bildet `bool` als `Number(1/0)` ab. Gepinnt werden
    // Präsenz und Wert der Felder, nicht der JSON-Typ; ein eigenes Crate für
    // den Test wäre unverhältnismäßig. Er stand vorher in `fs_ops_tests.rs`
    // und wird seit FR-8 von den delete-inspect-Tests mitgenutzt.
    #[derive(Debug, PartialEq)]
    pub(super) enum WireValue {
        Object(Vec<(String, WireValue)>),
        String(String),
        Number(u64),
        Null,
    }

    #[derive(Debug)]
    pub(super) struct WireError(String);

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

    pub(super) struct WireSerializer;

    pub(super) struct WireStruct {
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

    /// Der serializer bildet Unit-Varianten als `{"status": "<name>"}` ab (so
    /// pinnt er `DirectorySize`); der serde-generierte Variantenname steht im
    /// Wert. Für Enums ohne `status`-Tag ist das nur die form des tests —
    /// gepinnt wird der name aus dem serde-Rename, nicht der JSON-typ.
    pub(super) fn wire_unit_variant(value: WireValue) -> Option<String> {
        match value {
            WireValue::Object(fields) => {
                match fields.into_iter().find(|(key, _)| key == "status") {
                    Some((_, WireValue::String(name))) => Some(name),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}
