// Chirurgischer VDF-String-Patch in Rust: ändert nur den Ziel-Wert, der Rest der Datei bleibt byte-für-byte erhalten.
// Verhindert Korruption durch Voll-Serialisierung (Umsortieren, Escaping-Verlust).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenKind {
    String(String),
    Open,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub start: usize,
    pub end: usize,
}

fn unescape_raw(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if next == '"' || next == '\\' {
                    out.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

fn escape_value(v: &str) -> String {
    v.replace('\\', "\\\\").replace('"', "\\\"")
}

fn quote(v: &str) -> String {
    format!("\"{}\"", escape_value(v))
}

pub fn tokenize(text: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        let b = bytes[i];
        if b == b' ' || b == b'\t' || b == b'\r' || b == b'\n' {
            i += 1;
            continue;
        }
        if b == b'/' && i + 1 < len && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            if let Some(pos) = text[i + 2..].find("*/") {
                i += 2 + pos + 2;
                continue;
            } else {
                return Err("unterminierter block-kommentar".into());
            }
        }
        if b == b'{' || b == b'}' {
            let kind = if b == b'{' {
                TokenKind::Open
            } else {
                TokenKind::Close
            };
            tokens.push(Token {
                kind,
                start: i,
                end: i + 1,
            });
            i += 1;
            continue;
        }
        if b == b'"' {
            let start = i;
            i += 1;
            let mut raw = String::new();
            while i < len && bytes[i] != b'"' {
                if bytes[i] == b'\\' && i + 1 < len {
                    let escaped_char_len = text[i + 1..]
                        .chars()
                        .next()
                        .map(|c| c.len_utf8())
                        .unwrap_or(1);
                    let take = 1 + escaped_char_len;
                    raw.push_str(&text[i..i + take]);
                    i += take;
                } else {
                    let char_len = text[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
                    raw.push_str(&text[i..i + char_len]);
                    i += char_len;
                }
            }
            if i >= len {
                return Err("unterminierter string".into());
            }
            i += 1; // closing quote
            tokens.push(Token {
                kind: TokenKind::String(unescape_raw(&raw)),
                start,
                end: i,
            });
            continue;
        }

        // bare token: unquoted key/value oder [conditional]-marker
        let start = i;
        while i < len && !b" \t\r\n\"{}".contains(&bytes[i]) {
            i += 1;
        }
        let bare_str = std::str::from_utf8(&bytes[start..i])
            .map_err(|e| format!("ungültiges UTF-8 in bare token: {e}"))?;
        tokens.push(Token {
            kind: TokenKind::String(bare_str.to_string()),
            start,
            end: i,
        });
    }

    Ok(tokens)
}

pub(crate) struct Entry<'a> {
    pub(crate) key: &'a Token,
    pub(crate) value: &'a Token,
    pub(crate) block: Option<(usize, usize)>, // token index range (from, to)
}

pub(crate) fn scan_entries<'a>(
    tokens: &'a [Token],
    from: usize,
    to: usize,
) -> Result<Vec<Entry<'a>>, String> {
    let mut entries = Vec::new();
    let mut i = from;
    while i < to {
        let t = &tokens[i];
        if let TokenKind::String(val) = &t.kind {
            if val.starts_with('[') {
                i += 1;
                continue;
            }
        }
        if !matches!(t.kind, TokenKind::String(_)) {
            return Err(format!("unerwartetes token bei offset {}", t.start));
        }
        if i + 1 >= to {
            if let TokenKind::String(k) = &t.kind {
                return Err(format!("key \"{}\" ohne wert", k));
            }
        }
        let next = &tokens[i + 1];
        match next.kind {
            TokenKind::Open => {
                let mut depth = 1;
                let mut j = i + 2;
                while j < to && depth > 0 {
                    match tokens[j].kind {
                        TokenKind::Open => depth += 1,
                        TokenKind::Close => depth -= 1,
                        _ => {}
                    }
                    j += 1;
                }
                if depth != 0 {
                    if let TokenKind::String(k) = &t.kind {
                        return Err(format!("unbalancierte klammern bei \"{}\"", k));
                    }
                }
                entries.push(Entry {
                    key: t,
                    value: next,
                    block: Some((i + 2, j - 1)),
                });
                i = j;
            }
            TokenKind::Close => {
                if let TokenKind::String(k) = &t.kind {
                    return Err(format!("key \"{}\" ohne wert", k));
                }
            }
            TokenKind::String(_) => {
                entries.push(Entry {
                    key: t,
                    value: next,
                    block: None,
                });
                i += 2;
            }
        }
    }
    Ok(entries)
}

pub(crate) fn find_entry<'a>(
    tokens: &'a [Token],
    from: usize,
    to: usize,
    key: &str,
) -> Result<Option<Entry<'a>>, String> {
    let entries = scan_entries(tokens, from, to)?;
    for e in entries {
        if let TokenKind::String(k) = &e.key.kind {
            if k.eq_ignore_ascii_case(key) {
                return Ok(Some(e));
            }
        }
    }
    Ok(None)
}

fn splice(text: &str, start: usize, end: usize, insert: &str) -> String {
    let mut out = String::with_capacity(text.len() - (end - start) + insert.len());
    out.push_str(&text[..start]);
    out.push_str(insert);
    out.push_str(&text[end..]);
    out
}

fn render_entries(keys: &[&str], value: &str, indent: &str) -> Result<String, String> {
    if keys.is_empty() {
        return Err("interner fehler: leerer restpfad".into());
    }
    let key = keys[0];
    let head = format!("{}{}", indent, quote(key));
    if keys.len() == 1 {
        return Ok(format!("{}\t\t{}\n", head, quote(value)));
    }
    let nested_indent = format!("{}\t", indent);
    let inner = render_entries(&keys[1..], value, &nested_indent)?;
    Ok(format!("{}\n{}{{\n{}{}}}\n", head, indent, inner, indent))
}

struct InsertionPoint {
    pos: usize,
    prefix: String,
    indent: String,
}

fn insertion_point(
    text: &str,
    tokens: &[Token],
    close_idx: usize,
) -> Result<InsertionPoint, String> {
    if close_idx >= tokens.len() {
        let prefix = if text.is_empty() || text.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        return Ok(InsertionPoint {
            pos: text.len(),
            prefix: prefix.to_string(),
            indent: String::new(),
        });
    }
    let close = &tokens[close_idx];
    let line_start = match text[..close.start].rfind('\n') {
        Some(pos) => pos + 1,
        None => 0,
    };
    let closing_indent = &text[line_start..close.start];
    if !closing_indent.chars().all(|c| c == ' ' || c == '\t') {
        return Err("schließende klammer nicht auf eigener zeile, abbruch".into());
    }
    Ok(InsertionPoint {
        pos: line_start,
        prefix: String::new(),
        indent: format!("{}\t", closing_indent),
    })
}

fn set_in_scope(
    text: &str,
    tokens: &[Token],
    from: usize,
    to: usize,
    keys: &[&str],
    value: &str,
) -> Result<String, String> {
    if keys.is_empty() {
        return Err("interner fehler: leerer restpfad".into());
    }
    let key = keys[0];
    if let Some(entry) = find_entry(tokens, from, to, key)? {
        if keys.len() == 1 {
            if entry.block.is_some() {
                return Err(format!("\"{}\" ist ein block, kein wert", key));
            }
            if let TokenKind::String(existing_val) = &entry.value.kind {
                if existing_val == value {
                    return Ok(text.to_string());
                }
            }
            return Ok(splice(
                text,
                entry.value.start,
                entry.value.end,
                &quote(value),
            ));
        }
        let (sub_from, sub_to) = match entry.block {
            Some(range) => range,
            None => return Err(format!("\"{}\" ist ein wert, kein block", key)),
        };
        return set_in_scope(text, tokens, sub_from, sub_to, &keys[1..], value);
    }
    let ins = insertion_point(text, tokens, to)?;
    let rendered = render_entries(keys, value, &ins.indent)?;
    Ok(splice(
        text,
        ins.pos,
        ins.pos,
        &format!("{}{}", ins.prefix, rendered),
    ))
}

fn remove_in_scope(
    text: &str,
    tokens: &[Token],
    from: usize,
    to: usize,
    keys: &[&str],
) -> Result<String, String> {
    if keys.is_empty() {
        return Ok(text.to_string());
    }
    let key = keys[0];
    let entry = match find_entry(tokens, from, to, key)? {
        Some(e) => e,
        None => return Ok(text.to_string()),
    };

    if keys.len() > 1 {
        let (sub_from, sub_to) = match entry.block {
            Some(range) => range,
            None => return Err(format!("\"{}\" ist ein wert, kein block", key)),
        };
        return remove_in_scope(text, tokens, sub_from, sub_to, &keys[1..]);
    }

    let end = if let Some((_, block_to)) = entry.block {
        tokens[block_to].end
    } else {
        entry.value.end
    };

    let raw_line_start = match text[..entry.key.start].rfind('\n') {
        Some(pos) => pos + 1,
        None => 0,
    };
    let between = &text[raw_line_start..entry.key.start];
    if between.chars().any(|c| c != ' ' && c != '\t') {
        return Err(format!(
            "\"{}\" beginnt nicht auf eigener zeile, strukturbruch",
            key
        ));
    }
    let line_start = raw_line_start;
    let bytes = text.as_bytes();
    let mut trail_end = end;
    while trail_end < text.len()
        && (bytes[trail_end] == b' ' || bytes[trail_end] == b'\t' || bytes[trail_end] == b'\r')
    {
        trail_end += 1;
    }
    if trail_end < text.len() && bytes[trail_end] == b'\n' {
        trail_end += 1;
    }

    Ok(splice(text, line_start, trail_end, ""))
}

pub fn get_vdf_value(text: &str, path: &[&str]) -> Result<Option<String>, String> {
    let tokens = tokenize(text)?;
    let mut from = 0;
    let mut to = tokens.len();
    for (depth, &key) in path.iter().enumerate() {
        let entry = match find_entry(&tokens, from, to, key)? {
            Some(e) => e,
            None => return Ok(None),
        };
        if depth == path.len() - 1 {
            if entry.block.is_some() {
                return Ok(None);
            }
            if let TokenKind::String(val) = &entry.value.kind {
                return Ok(Some(val.clone()));
            }
            return Ok(None);
        }
        match entry.block {
            Some((sub_from, sub_to)) => {
                from = sub_from;
                to = sub_to;
            }
            None => return Ok(None),
        }
    }
    Ok(None)
}

pub fn set_vdf_value(text: &str, path: &[&str], value: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("leerer pfad".into());
    }
    if value.contains('\r') || value.contains('\n') {
        return Err("wert darf keine zeilenumbrüche enthalten".into());
    }
    // Spiegel zur identity-prüfung in parse_compat_tool_vdf (steam.rs): vales
    // keyvalues-parser liest C-strings, ein NUL oder anderes steuerzeichen im
    // wert würde die datei für steam unlesbar machen. die webview ist keine
    // vertrauensgrenze, deshalb lehnt das backend hier ab (INV-1).
    if value.chars().any(char::is_control) {
        return Err("wert darf keine steuerzeichen enthalten".into());
    }
    let tokens = tokenize(text)?;
    set_in_scope(text, &tokens, 0, tokens.len(), path, value)
}

pub fn remove_vdf_entry(text: &str, path: &[&str]) -> Result<String, String> {
    if path.is_empty() {
        return Err("leerer pfad".into());
    }
    let tokens = tokenize(text)?;
    remove_in_scope(text, &tokens, 0, tokens.len(), path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCALCONFIG: &str = r#""UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				// zuletzt gespielt
				"LastPlayed"		"620"
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"gamemoderun %command%"
					}
					"228980"
					{
					}
				}
			}
		}
	}
}
"#;

    const COMPAT: &str = r#""InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"0"
					{
						"name"		"proton-cachyos-slr"
					}
					"620"
					{
						"name"		"GE-Proton9-27"
					}
					"730"
					{
						"name"		"proton-cachyos-slr"
					}
				}
			}
		}
	}
}
"#;

    const LAUNCH_620: &[&str] = &[
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Apps",
        "620",
    ];
    const LAUNCH_228980: &[&str] = &[
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Apps",
        "228980",
    ];

    #[test]
    fn get_vdf_value_liest_bestehenden_wert() {
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        assert_eq!(
            get_vdf_value(LOCALCONFIG, &p).unwrap(),
            Some("gamemoderun %command%".to_string())
        );
    }

    #[test]
    fn get_vdf_value_unbekannter_pfad() {
        let mut p = LAUNCH_620.to_vec();
        p.push("NichtDa");
        assert_eq!(get_vdf_value(LOCALCONFIG, &p).unwrap(), None);
        assert_eq!(
            get_vdf_value(LOCALCONFIG, &["UserLocalConfigStore", "NichtDa", "x"]).unwrap(),
            None
        );
    }

    #[test]
    fn get_vdf_value_block_liefert_none() {
        assert_eq!(get_vdf_value(LOCALCONFIG, LAUNCH_620).unwrap(), None);
    }

    #[test]
    fn set_vdf_value_ersetzt_bytegenau() {
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        let patched = set_vdf_value(LOCALCONFIG, &p, "MANGOHUD=1 %command%").unwrap();
        let expected = LOCALCONFIG.replace("\"gamemoderun %command%\"", "\"MANGOHUD=1 %command%\"");
        assert_eq!(patched, expected);
        assert_eq!(
            get_vdf_value(&patched, &p).unwrap(),
            Some("MANGOHUD=1 %command%".to_string())
        );
    }

    #[test]
    fn set_vdf_value_no_op_bleibt_identisch() {
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        let patched = set_vdf_value(LOCALCONFIG, &p, "gamemoderun %command%").unwrap();
        assert_eq!(patched, LOCALCONFIG);
    }

    #[test]
    fn set_vdf_value_escaped_quotes_und_backslashes() {
        let evil = r#"MANGOHUD_CONFIG="fps,cpu" PROTON_LOG_DIR=C:\logs %command%"#;
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        let patched = set_vdf_value(LOCALCONFIG, &p, evil).unwrap();
        let expected = LOCALCONFIG.replace(
            "\"gamemoderun %command%\"",
            r#""MANGOHUD_CONFIG=\"fps,cpu\" PROTON_LOG_DIR=C:\\logs %command%""#,
        );
        assert_eq!(patched, expected);
        assert_eq!(get_vdf_value(&patched, &p).unwrap(), Some(evil.to_string()));
    }

    #[test]
    fn set_vdf_value_legt_key_in_leerem_block_an() {
        let mut p = LAUNCH_228980.to_vec();
        p.push("LaunchOptions");
        let patched = set_vdf_value(LOCALCONFIG, &p, "-novid").unwrap();
        let expected = LOCALCONFIG.replace(
            "\t\t\t\t\t\"228980\"\n\t\t\t\t\t{\n\t\t\t\t\t}",
            "\t\t\t\t\t\"228980\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"LaunchOptions\"\t\t\"-novid\"\n\t\t\t\t\t}",
        );
        assert_eq!(patched, expected);
        assert_eq!(
            get_vdf_value(&patched, &p).unwrap(),
            Some("-novid".to_string())
        );
    }

    #[test]
    fn set_vdf_value_legt_teilbaum_an() {
        let minimal = "\"UserLocalConfigStore\"\n{\n}\n";
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        let patched = set_vdf_value(minimal, &p, "%command% -windowed").unwrap();
        let expected = r#""UserLocalConfigStore"
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
						"LaunchOptions"		"%command% -windowed"
					}
				}
			}
		}
	}
}
"#;
        assert_eq!(patched, expected);
    }

    #[test]
    fn set_vdf_value_unbalancierte_klammern_wirft() {
        assert!(set_vdf_value("\"A\"\n{\n\t\"B\" \"1\"\n", &["A", "B"], "2").is_err());
    }

    #[test]
    fn set_vdf_value_zeilenumbruch_im_wert_wirft() {
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        assert!(set_vdf_value(LOCALCONFIG, &p, "a\nb").is_err());
    }

    #[test]
    fn set_vdf_value_nul_im_wert_wirft_ohne_patch() {
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        assert!(set_vdf_value(LOCALCONFIG, &p, "gamemoderun %command%\0evil").is_err());
        // auch ein führendes NUL darf nicht durchrutschen
        assert!(set_vdf_value(LOCALCONFIG, &p, "\0").is_err());
        assert!(set_vdf_value(LOCALCONFIG, &p, "a\0b").is_err());
    }

    #[test]
    fn set_vdf_value_steuerzeichen_im_wert_wirft_ohne_patch() {
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        for evil in ["\u{7}", "\u{1}", "\u{9}"] {
            assert!(
                set_vdf_value(LOCALCONFIG, &p, evil).is_err(),
                "steuerzeichen {evil:?} muss abgelehnt werden"
            );
        }
        // auch DEL (0x7F) und C1 (0x80-0x9F) sind control characters
        assert!(set_vdf_value(LOCALCONFIG, &p, "a\u{7f}b").is_err());
        assert!(set_vdf_value(LOCALCONFIG, &p, "a\u{85}b").is_err());
    }

    #[test]
    fn set_vdf_value_escaped_zeichen_bleiben_erlaubt() {
        // \" und \\ sind keine steuerzeichen und müssen weiterhin funktionieren
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        let evil = r#"MANGOHUD_CONFIG="fps,cpu" PROTON_LOG_DIR=C:\logs %command%"#;
        let patched = set_vdf_value(LOCALCONFIG, &p, evil).unwrap();
        assert_eq!(get_vdf_value(&patched, &p).unwrap(), Some(evil.to_string()));
    }

    #[test]
    fn set_vdf_value_unterminierter_string_wirft() {
        let truncated = "\"InstallConfigStore\"\n{\n\t\"Software\"\n\t{\n\t\t\"name\"\t\t\"wert ohne schlussquote";
        let err =
            set_vdf_value(truncated, &["InstallConfigStore", "Software", "name"], "x").unwrap_err();
        assert_eq!(err, "unterminierter string");
    }

    #[test]
    fn remove_vdf_entry_entfernt_block() {
        let result = remove_vdf_entry(
            COMPAT,
            &[
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                "620",
            ],
        )
        .unwrap();
        assert!(!result.contains("\"620\""));
        assert!(result.contains("\"0\""));
        assert!(result.contains("\"730\""));
    }

    #[test]
    fn remove_vdf_entry_entfernt_scalar() {
        let mut p = LAUNCH_620.to_vec();
        p.push("LaunchOptions");
        let result = remove_vdf_entry(LOCALCONFIG, &p).unwrap();
        assert_eq!(get_vdf_value(&result, &p).unwrap(), None);
        assert!(!result.contains("\"LaunchOptions\""));
        assert!(result.contains("\"228980\""));
    }

    #[test]
    fn remove_vdf_entry_no_op_bei_nichtexistent() {
        let result = remove_vdf_entry(
            COMPAT,
            &[
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                "999",
            ],
        )
        .unwrap();
        assert_eq!(result, COMPAT);
    }

    #[test]
    fn remove_vdf_entry_minifizierte_datei_wirft() {
        let minified = r#""InstallConfigStore"{"Software"{"Valve"{"Steam"{"CompatToolMapping"{"620"{"name" "x"}}}}}}"#;
        let res = remove_vdf_entry(
            minified,
            &[
                "InstallConfigStore",
                "Software",
                "Valve",
                "Steam",
                "CompatToolMapping",
                "620",
            ],
        );
        assert!(res.is_err());
    }

    #[test]
    fn remove_vdf_entry_key_bei_offset_0() {
        let single = "\"620\"\n{\n\t\"name\"\t\t\"x\"\n}\n";
        let result = remove_vdf_entry(single, &["620"]).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn tokenize_multibyte_nach_backslash_ohne_panic() {
        let vdf =
            "\"Apps\"\n{\n\t\"620\"\n\t{\n\t\t\"LaunchOptions\"\t\t\"\\über %command%\"\n\t}\n}\n";
        let res = get_vdf_value(vdf, &["Apps", "620", "LaunchOptions"]).unwrap();
        assert_eq!(res, Some("\\über %command%".to_string()));
    }

    #[test]
    fn case_insensitive_navigation() {
        let lower = LOCALCONFIG.replace("\"Software\"", "\"software\"");
        let mut path = LAUNCH_620.to_vec();
        path.push("LaunchOptions");
        let patched = set_vdf_value(&lower, &path, "new").unwrap();
        assert_eq!(
            get_vdf_value(&patched, &path).unwrap(),
            Some("new".to_string())
        );
    }

    #[test]
    fn crlf_zeilenenden_bleiben_beim_patch_erhalten() {
        let crlf = "\"Root\"\r\n{\r\n\t\"Key\"\t\t\"old\"\r\n}\r\n";
        assert_eq!(
            get_vdf_value(crlf, &["Root", "Key"]).unwrap(),
            Some("old".to_string())
        );
        let patched = set_vdf_value(crlf, &["Root", "Key"], "new").unwrap();
        assert_eq!(patched, crlf.replace("\"old\"", "\"new\""));
    }

    #[test]
    fn block_kommentar_wird_uebersprungen() {
        let with_block_comment =
            "\"Root\"\n{\n\t/* dieser kommentar wird ignoriert */\n\t\"Key\"\t\t\"val\"\n}\n";
        assert_eq!(
            get_vdf_value(with_block_comment, &["Root", "Key"]).unwrap(),
            Some("val".to_string())
        );
        let patched = set_vdf_value(with_block_comment, &["Root", "Key"], "new").unwrap();
        assert_eq!(
            get_vdf_value(&patched, &["Root", "Key"]).unwrap(),
            Some("new".to_string())
        );
        assert_eq!(patched, with_block_comment.replace("\"val\"", "\"new\""));
    }

    #[test]
    fn conditional_marker_wird_uebersprungen() {
        let with_conditional =
            "\"AppState\"\n{\n\t\"Key\"\t\t\"val\"\t[linux]\n\t\"Other\"\t\t\"other\"\n}\n";
        assert_eq!(
            get_vdf_value(with_conditional, &["AppState", "Key"]).unwrap(),
            Some("val".to_string())
        );
        assert_eq!(
            get_vdf_value(with_conditional, &["AppState", "Other"]).unwrap(),
            Some("other".to_string())
        );
        let patched = set_vdf_value(with_conditional, &["AppState", "Key"], "new").unwrap();
        assert_eq!(
            get_vdf_value(&patched, &["AppState", "Key"]).unwrap(),
            Some("new".to_string())
        );
    }

    #[test]
    fn leere_datei_legt_wert_an() {
        let patched = set_vdf_value("", &["Key"], "val").unwrap();
        assert_eq!(
            get_vdf_value(&patched, &["Key"]).unwrap(),
            Some("val".to_string())
        );
    }

    #[test]
    fn bare_tokens_werden_wie_strings_behandelt() {
        // unquoted keys (bare tokens) kommen in steam-vdfs vor; navigation und
        // patch müssen sie wie quoted keys behandeln.
        let bare = "\"Root\"\n{\n\tKey\t\t\"val\"\n}\n";
        assert_eq!(
            get_vdf_value(bare, &["Root", "Key"]).unwrap(),
            Some("val".to_string())
        );
        let patched = set_vdf_value(bare, &["Root", "Key"], "neu").unwrap();
        assert_eq!(
            get_vdf_value(&patched, &["Root", "Key"]).unwrap(),
            Some("neu".to_string())
        );
    }

    #[test]
    fn escaping_roundtrip_quotes_und_backslashes() {
        // valve escapet nur \" und \\; der roundtrip muss den originalwert
        // liefern, nicht den escaped-text.
        let input = "\"Root\"\n{\n\t\"Key\"\t\t\"alt\"\n}\n";
        let patched =
            set_vdf_value(input, &["Root", "Key"], "mit \"quotes\" und \\backslash").unwrap();
        assert_eq!(
            get_vdf_value(&patched, &["Root", "Key"]).unwrap(),
            Some("mit \"quotes\" und \\backslash".to_string())
        );
        let again =
            set_vdf_value(&patched, &["Root", "Key"], "mit \"quotes\" und \\backslash").unwrap();
        assert_eq!(
            again, patched,
            "no-op auf bereits escapedem wert bleibt byte-identisch"
        );
    }

    #[test]
    fn text_vdf_golden_fixture_bindet_gleiche_erwartungen_wie_typescript() {
        // gemeinsame datei tests/fixtures/text-vdf-golden.vdf; get-erwartungen
        // wie tests/core/vdfpatch.test.ts (spiegel zu shortcuts-golden.vdf);
        // schreiben und entfernen bleiben ausschließlich Rust-Funktionalität.
        let golden = include_str!("../../../tests/fixtures/text-vdf-golden.vdf");
        let launch_570: Vec<&str> = vec![
            "UserLocalConfigStore",
            "Software",
            "Valve",
            "Steam",
            "Apps",
            "570",
        ];
        let mut launch_620 = LAUNCH_620.to_vec();
        launch_620.push("LaunchOptions");

        // get: escaped launch-options, kommentare, [conditional]-marker, bare tokens
        assert_eq!(
            get_vdf_value(golden, &launch_620).unwrap(),
            Some(r#"MANGOHUD_CONFIG="fps,cpu" PROTON_LOG_DIR=C:\logs %command%"#.to_string())
        );
        let mut p570_lo = launch_570.clone();
        p570_lo.push("LaunchOptions");
        assert_eq!(
            get_vdf_value(golden, &p570_lo).unwrap(),
            Some("-windowed".to_string())
        );
        let mut p570_lp = launch_570.clone();
        p570_lp.push("LastPlayed");
        assert_eq!(
            get_vdf_value(golden, &p570_lp).unwrap(),
            Some("570".to_string())
        );
        assert_eq!(
            get_vdf_value(golden, &["UserLocalConfigStore", "BareKey"]).unwrap(),
            Some("bare-value".to_string())
        );
        assert_eq!(
            get_vdf_value(golden, &["UserLocalConfigStore", "BareTokenKey"]).unwrap(),
            Some("token-value".to_string())
        );

        // set: byte-identische value-span-ersetzung wie im TS-pfad
        let patched = set_vdf_value(golden, &launch_620, "neu").unwrap();
        let expected = golden.replace(
            r#""MANGOHUD_CONFIG=\"fps,cpu\" PROTON_LOG_DIR=C:\\logs %command%""#,
            "\"neu\"",
        );
        assert_eq!(patched, expected);
        assert_eq!(
            get_vdf_value(&patched, &launch_620).unwrap(),
            Some("neu".to_string())
        );

        // set: no-op bleibt byte-identisch
        let noop = set_vdf_value(
            golden,
            &launch_620,
            r#"MANGOHUD_CONFIG="fps,cpu" PROTON_LOG_DIR=C:\logs %command%"#,
        )
        .unwrap();
        assert_eq!(noop, golden);

        // remove: 570-block wird exakt entfernt (inkl. [conditional]-zeile)
        let removed = remove_vdf_entry(golden, &launch_570).unwrap();
        let block570 = "\t\t\t\t\t\"570\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"LaunchOptions\"\t\t\"-windowed\"\n\t\t\t\t\t\t\"LastPlayed\"\t\t\"570\"\t[linux]\n\t\t\t\t\t}\n";
        assert_eq!(removed, golden.replace(block570, ""));
        assert!(removed.contains("\"620\""));
        assert!(!removed.contains("\"570\""));
    }

    const COMPAT_GESCHWISTER: &str = r#""InstallConfigStore"
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
						"config"		"noesync"
					}
					"730"
					{
						"name"		"proton_experimental"
						"config"		""
					}
				}
			}
		}
	}
}
"#;

    #[test]
    fn set_vdf_value_legt_neuen_appid_block_neben_geschwistern_an() {
        // häufigster realer schreibfall: erstes compat-tool für ein spiel, das
        // noch keinen eigenen block hat, während nachbarblöcke schon existieren.
        let path = &[
            "InstallConfigStore",
            "Software",
            "Valve",
            "Steam",
            "CompatToolMapping",
            "1091500",
            "name",
        ];
        let patched = set_vdf_value(COMPAT_GESCHWISTER, path, "proton-cachyos-slr").unwrap();

        // der neue block landet als letztes geschwister vor der schließenden
        // klammer von CompatToolMapping, der rest bleibt byte-identisch.
        let expected = COMPAT_GESCHWISTER.replace(
            "\t\t\t\t\t\t\"config\"\t\t\"\"\n\t\t\t\t\t}\n\t\t\t\t}\n",
            "\t\t\t\t\t\t\"config\"\t\t\"\"\n\t\t\t\t\t}\n\t\t\t\t\t\"1091500\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"name\"\t\t\"proton-cachyos-slr\"\n\t\t\t\t\t}\n\t\t\t\t}\n",
        );
        assert_ne!(expected, COMPAT_GESCHWISTER, "replace-anker muss greifen");
        assert_eq!(patched, expected);

        let block_620 = "\t\t\t\t\t\"620\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"name\"\t\t\"GE-Proton9-27\"\n\t\t\t\t\t\t\"config\"\t\t\"noesync\"\n\t\t\t\t\t}\n";
        let block_730 = "\t\t\t\t\t\"730\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"name\"\t\t\"proton_experimental\"\n\t\t\t\t\t\t\"config\"\t\t\"\"\n\t\t\t\t\t}\n";
        let block_neu = "\t\t\t\t\t\"1091500\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"name\"\t\t\"proton-cachyos-slr\"\n\t\t\t\t\t}\n";
        let pos_620 = patched.find(block_620).expect("620-block unverändert");
        let pos_730 = patched.find(block_730).expect("730-block unverändert");
        let pos_neu = patched.find(block_neu).expect("neuer block im nachbarstil");
        assert!(pos_620 < pos_730 && pos_730 < pos_neu, "reihenfolge stabil");
        assert_eq!(patched.matches(block_620).count(), 1);
        assert_eq!(patched.matches(block_730).count(), 1);

        // einrückung und quoting des neuen blocks entsprechen den geschwistern
        assert_eq!(
            patched[pos_neu..].lines().next().unwrap(),
            patched[pos_730..]
                .lines()
                .next()
                .unwrap()
                .replace("730", "1091500"),
        );

        let mut p_620 = path.to_vec();
        p_620[5] = "620";
        assert_eq!(
            get_vdf_value(&patched, &p_620).unwrap(),
            Some("GE-Proton9-27".to_string())
        );
        assert_eq!(
            get_vdf_value(&patched, path).unwrap(),
            Some("proton-cachyos-slr".to_string())
        );
    }

    const CROSS_APPS: &[&str] = &["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps"];
    const CROSS_620_LAUNCH: &str =
        r#"PROTON_LOG=1 MANGOHUD_CONFIG="fps,gpu,ram" %command% --skip-launcher"#;
    const CROSS_NEU_LAUNCH: &str =
        r#"WINEDLLOVERRIDES="dinput8=n,b" PROTON_LOG_DIR=Z:\home\logs gamemoderun %command%"#;

    fn cross_parser_pfad<'a>(app_id: &'a str, key: &'a str) -> Vec<&'a str> {
        let mut p: Vec<&'a str> = CROSS_APPS.to_vec();
        p.push(app_id);
        p.push(key);
        p
    }

    fn cross_parser_output(input: &str) -> String {
        let out = set_vdf_value(
            input,
            &cross_parser_pfad("620", "LaunchOptions"),
            CROSS_620_LAUNCH,
        )
        .unwrap();
        let out = remove_vdf_entry(&out, &cross_parser_pfad("620", "LastPlayed")).unwrap();
        set_vdf_value(
            &out,
            &cross_parser_pfad("1091500", "LaunchOptions"),
            CROSS_NEU_LAUNCH,
        )
        .unwrap()
    }

    #[test]
    fn cross_parser_erwartungsdatei_ist_echter_rust_output() {
        // vertragstest Rust -> @node-steam/vdf: die erwartungsdatei ist der
        // byte-genaue Rust-output; tests/core/vdf.test.ts liest genau diese
        // datei mit dem parser zurück, mit dem die app real liest.
        let input = include_str!("../../../tests/fixtures/cross-parser-input.vdf");
        let expected = include_str!("../../../tests/fixtures/cross-parser-expected.vdf");
        let produced = cross_parser_output(input);
        assert_eq!(produced, expected);

        assert_eq!(
            get_vdf_value(expected, &cross_parser_pfad("620", "LaunchOptions")).unwrap(),
            Some(CROSS_620_LAUNCH.to_string())
        );
        assert_eq!(
            get_vdf_value(expected, &cross_parser_pfad("620", "LastPlayed")).unwrap(),
            None
        );
        assert_eq!(
            get_vdf_value(expected, &cross_parser_pfad("730", "LaunchOptions")).unwrap(),
            Some("-novid -high".to_string())
        );
        assert_eq!(
            get_vdf_value(expected, &cross_parser_pfad("1091500", "LaunchOptions")).unwrap(),
            Some(CROSS_NEU_LAUNCH.to_string())
        );
    }
}
