// Chirurgischer VDF-String-Patch in Rust: ändert nur den Ziel-Wert, der Rest der Datei bleibt byte-für-byte erhalten.
// Verhindert Korruption durch Voll-Serialisierung (Umsortieren, Escaping-Verlust).
use crate::commands::errcode;

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

/// P12a: tiefen-cap des Block-Scans. Steam-Dateien liegen bei wenigen Ebenen.
const MAX_DEPTH: usize = 256;

/// Haengt einen Token an und meldet `SIZE_LIMIT`, sobald der Strom den Cap
/// ueberschreitet. Der Cap selbst gehoert in den Aufrufer, weil er von der
/// Textlaenge abhaengt.
fn push_capped(tokens: &mut Vec<Token>, token: Token, max_tokens: usize) -> Result<(), String> {
    tokens.push(token);
    if tokens.len() > max_tokens {
        return Err(errcode::with_detail(errcode::SIZE_LIMIT, "vdf token limit"));
    }
    Ok(())
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
    // P12a: ein token braucht mindestens ein byte, deshalb liegt der cap bei
    // der halben textlaenge plus kopfraum. er deckelt die speicherlast eines
    // token-dichten stroms ("{}"), ohne legitime dateien zu treffen.
    let max_tokens = text.len() / 2 + 16;
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
                return Err(errcode::with_detail(
                    errcode::UNREADABLE,
                    "unterminated block comment",
                ));
            }
        }
        if b == b'{' || b == b'}' {
            let kind = if b == b'{' {
                TokenKind::Open
            } else {
                TokenKind::Close
            };
            push_capped(
                &mut tokens,
                Token {
                    kind,
                    start: i,
                    end: i + 1,
                },
                max_tokens,
            )?;
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
                return Err(errcode::with_detail(
                    errcode::UNREADABLE,
                    "unterminated string",
                ));
            }
            i += 1; // closing quote
            push_capped(
                &mut tokens,
                Token {
                    kind: TokenKind::String(unescape_raw(&raw)),
                    start,
                    end: i,
                },
                max_tokens,
            )?;
            continue;
        }

        // bare token: unquoted key/value oder [conditional]-marker
        let start = i;
        while i < len && !b" \t\r\n\"{}".contains(&bytes[i]) {
            i += 1;
        }
        let bare_str = std::str::from_utf8(&bytes[start..i]).map_err(|e| {
            errcode::with_detail(
                errcode::UNREADABLE,
                format!("invalid UTF-8 in bare token: {e}"),
            )
        })?;
        push_capped(
            &mut tokens,
            Token {
                kind: TokenKind::String(bare_str.to_string()),
                start,
                end: i,
            },
            max_tokens,
        )?;
    }

    Ok(tokens)
}

#[derive(Debug)]
pub(crate) struct Entry<'a> {
    pub(crate) key: &'a Token,
    pub(crate) value: &'a Token,
    pub(crate) block: Option<(usize, usize)>, // token index range (from, to)
}

/// Ein gemeinsamer Entry-Walker (P12a): liest ab `*index` den naechsten
/// Eintrag und schiebt `*index` hinter ihn; `None` am Ende des Range. Alle
/// Strukturbruch-Meldungen (unerwarteter Token, Key ohne Wert, unbalancierte
/// Klammern, Tiefe) entstehen genau hier, damit `scan_entries` und
/// `find_entry` bei kaputten Eingaben gleich abbrechen.
fn next_entry<'a>(
    tokens: &'a [Token],
    index: &mut usize,
    to: usize,
) -> Result<Option<Entry<'a>>, String> {
    while *index < to {
        let i = *index;
        let t = &tokens[i];
        // r-17: das let-else belegt den String hart. im nicht-fall waere der
        // aufruf in tokens[i + 1] gelaufen (index-panik).
        let TokenKind::String(key) = &t.kind else {
            return Err(errcode::with_detail(
                errcode::UNREADABLE,
                format!("unexpected token at offset {}", t.start),
            ));
        };
        if key.starts_with('[') {
            *index = i + 1;
            continue;
        }
        if i + 1 >= to {
            // kein folge-token: der key hat keinen wert.
            return Err(errcode::with_detail(
                errcode::UNREADABLE,
                format!("key \"{key}\" has no value"),
            ));
        }
        let next = &tokens[i + 1];
        match next.kind {
            TokenKind::Open => {
                let mut depth = 1usize;
                let mut j = i + 2;
                while j < to && depth > 0 {
                    match tokens[j].kind {
                        TokenKind::Open => {
                            depth += 1;
                            if depth > MAX_DEPTH {
                                return Err(errcode::with_detail(
                                    errcode::SIZE_LIMIT,
                                    "vdf depth limit",
                                ));
                            }
                        }
                        TokenKind::Close => depth -= 1,
                        _ => {}
                    }
                    j += 1;
                }
                if depth != 0 {
                    return Err(errcode::with_detail(
                        errcode::UNREADABLE,
                        format!("unbalanced braces in \"{key}\""),
                    ));
                }
                *index = j;
                return Ok(Some(Entry {
                    key: t,
                    value: next,
                    block: Some((i + 2, j - 1)),
                }));
            }
            TokenKind::Close => {
                // r-17: hartes return statt durchfallen; ohne return liefe die
                // schleife mit unveraendertem i endlos.
                return Err(errcode::with_detail(
                    errcode::UNREADABLE,
                    format!("key \"{key}\" has no value"),
                ));
            }
            TokenKind::String(_) => {
                *index = i + 2;
                return Ok(Some(Entry {
                    key: t,
                    value: next,
                    block: None,
                }));
            }
        }
    }
    Ok(None)
}

pub(crate) fn scan_entries<'a>(
    tokens: &'a [Token],
    from: usize,
    to: usize,
) -> Result<Vec<Entry<'a>>, String> {
    let mut entries = Vec::new();
    let mut index = from;
    while let Some(entry) = next_entry(tokens, &mut index, to)? {
        entries.push(entry);
    }
    Ok(entries)
}

pub(crate) fn find_entry<'a>(
    tokens: &'a [Token],
    from: usize,
    to: usize,
    key: &str,
) -> Result<Option<Entry<'a>>, String> {
    let mut index = from;
    while let Some(entry) = next_entry(tokens, &mut index, to)? {
        if let TokenKind::String(k) = &entry.key.kind {
            if k.eq_ignore_ascii_case(key) {
                return Ok(Some(entry));
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
        return Err(errcode::with_detail(
            errcode::INVALID_ID,
            "empty path remainder",
        ));
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
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            "closing brace is not on its own line",
        ));
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
        return Err(errcode::with_detail(
            errcode::INVALID_ID,
            "empty path remainder",
        ));
    }
    let key = keys[0];
    if let Some(entry) = find_entry(tokens, from, to, key)? {
        if keys.len() == 1 {
            if entry.block.is_some() {
                return Err(errcode::with_detail(
                    errcode::UNREADABLE,
                    format!("key \"{key}\" is a block, not a value"),
                ));
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
            None => {
                return Err(errcode::with_detail(
                    errcode::UNREADABLE,
                    format!("key \"{key}\" is a value, not a block"),
                ));
            }
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
            None => {
                return Err(errcode::with_detail(
                    errcode::UNREADABLE,
                    format!("key \"{key}\" is a value, not a block"),
                ));
            }
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
        return Err(errcode::with_detail(
            errcode::UNREADABLE,
            format!("key \"{key}\" does not start on its own line"),
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

/// Liefert für jeden Pfad in `paths` den Block unter diesem Pfad, eingebettet
/// in die Vorfahren-Keys, und verbindet die Ergebnisse mit `\n`. Alles andere
/// fällt weg (S-03: `config.vdf` trägt neben dem Mapping auch Login-Tokens).
/// Fehlt ein Block, bleibt für ihn nur das leere Gerüst.
///
/// Der Text wird genau **einmal** tokenisiert: seit F5.4 liest der Aufrufer
/// mehrere Mapping-Layouts aus derselben `config.vdf`. Die Blöcke folgen in der
/// Reihenfolge von `paths`; jeder ist ein eigenständiger Root-Knoten, das
/// verbundene Dokument hat also mehrere Wurzeln (der TS-Parser liest sie
/// entsprechend).
///
/// Eine leere Pfadliste ist ein Aufruferfehler und wird mit `INVALID_ID`
/// abgelehnt: ein vergessener Layout-Pfad soll nicht still als leerer Erfolg
/// (`""`) durchgehen und damit als „kein Mapping vorhanden" gelesen werden.
pub fn extract_vdf_blocks(text: &str, paths: &[&[&str]]) -> Result<String, String> {
    /// Bisherige Verschachtelungslogik für genau einen Pfad; `tokens` ist der
    /// gemeinsame Tokenstrom des ganzen Textes.
    fn one(text: &str, tokens: &[Token], path: &[&str]) -> Result<String, String> {
        let Some((_, ancestors)) = path.split_last() else {
            return Err(errcode::with_detail(errcode::INVALID_ID, "empty path"));
        };
        let (mut from, mut to) = (0, tokens.len());
        let mut block = String::new();
        for (depth, &key) in path.iter().enumerate() {
            let Some(Entry {
                key: key_token,
                block: Some((sub_from, sub_to)),
                ..
            }) = find_entry(tokens, from, to, key)?
            else {
                break;
            };
            if depth == ancestors.len() {
                block = text[key_token.start..tokens[sub_to].end].to_string();
            }
            (from, to) = (sub_from, sub_to);
        }
        Ok(ancestors.iter().rev().fold(block, |inner, key| {
            format!("{}\n{{\n{inner}\n}}", quote(key))
        }))
    }

    if paths.is_empty() {
        return Err(errcode::with_detail(errcode::INVALID_ID, "empty path list"));
    }

    let tokens = tokenize(text)?;
    let mut blocks = Vec::with_capacity(paths.len());
    for path in paths {
        blocks.push(one(text, &tokens, path)?);
    }
    Ok(blocks.join("\n"))
}

/// Liefert nur den Block unter `path`, eingebettet in die Vorfahren-Keys.
/// Alles andere fällt weg (S-03: `config.vdf` trägt neben dem Mapping auch
/// Login-Tokens). Fehlt der Block, bleibt nur das leere Gerüst.
///
/// Wrapper um [`extract_vdf_blocks`] für genau einen Pfad; seit F5.4 liest der
/// produktive Pfad (`fs_ops::reduce_compat_config`) mehrere Layouts, deshalb
/// lebt der Einzelpfad-Einstieg nur noch für die Vertragstests
/// (`extract_vdf_block_*`, `cross_parser_mapping_ist_echter_rust_output`).
/// Bewusst ohne `pub`: außerhalb der Testmodule (`mod tests` und
/// `fs_ops::tests`) gibt es keinen Aufrufer, und ein exportierter Einzelpfad-
/// Einstieg würde den Mehr-Layout-Vertrag wieder aufweichen.
#[cfg(test)]
fn extract_vdf_block(text: &str, path: &[&str]) -> Result<String, String> {
    extract_vdf_blocks(text, &[path])
}

/// Reduziert `loginusers.vdf` auf den `"users"`-Block mit numerischen
/// Account-IDs und jeweils maximal dem skalaren Feld `"MostRecent"` (S-14.1).
/// Login- und Anzeigenamen (`AccountName`, `PersonaName`) verlassen das Backend
/// nicht.
pub fn extract_loginusers_most_recent(text: &str) -> Result<String, String> {
    let tokens = tokenize(text)?;
    let Some(Entry {
        block: Some((from, to)),
        ..
    }) = find_entry(&tokens, 0, tokens.len(), "users")?
    else {
        return Ok("\"users\"\n{\n}".to_string());
    };
    let mut user_blocks = Vec::new();
    for entry in scan_entries(&tokens, from, to)? {
        let TokenKind::String(user_id) = &entry.key.kind else {
            continue;
        };
        if !crate::commands::scope::is_ascii_digits(user_id) {
            continue;
        }
        let Some((u_from, u_to)) = entry.block else {
            continue;
        };
        let most_recent = match find_entry(&tokens, u_from, u_to, "MostRecent")? {
            Some(Entry {
                block: None, value, ..
            }) => match &value.kind {
                TokenKind::String(val) => Some(val.as_str()),
                _ => None,
            },
            _ => None,
        };
        let rendered = match most_recent {
            Some(val) => format!(
                "\t{}\n\t{{\n\t\t\"MostRecent\"\t\t{}\n\t}}",
                quote(user_id),
                quote(val)
            ),
            None => format!("\t{}\n\t{{\n\t}}", quote(user_id)),
        };
        user_blocks.push(rendered);
    }
    if user_blocks.is_empty() {
        Ok("\"users\"\n{\n}".to_string())
    } else {
        Ok(format!("\"users\"\n{{\n{}\n}}", user_blocks.join("\n")))
    }
}

pub fn set_vdf_value(text: &str, path: &[&str], value: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err(errcode::with_detail(errcode::INVALID_ID, "empty path"));
    }
    if value.contains('\r') || value.contains('\n') {
        return Err(errcode::with_detail(
            errcode::INVALID_VALUE,
            "value must not contain line breaks",
        ));
    }
    // Spiegel zur identity-prüfung in parse_compat_tool_vdf (compat_auth.rs): vales
    // keyvalues-parser liest C-strings, ein NUL oder anderes steuerzeichen im
    // wert würde die datei für steam unlesbar machen. die webview ist keine
    // vertrauensgrenze, deshalb lehnt das backend hier ab (INV-1).
    if value.chars().any(char::is_control) {
        return Err(errcode::with_detail(
            errcode::INVALID_VALUE,
            "value must not contain control characters",
        ));
    }
    let tokens = tokenize(text)?;
    set_in_scope(text, &tokens, 0, tokens.len(), path, value)
}

pub fn remove_vdf_entry(text: &str, path: &[&str]) -> Result<String, String> {
    if path.is_empty() {
        return Err(errcode::with_detail(errcode::INVALID_ID, "empty path"));
    }
    let tokens = tokenize(text)?;
    remove_in_scope(text, &tokens, 0, tokens.len(), path)
}

// `pub(crate)`, damit `fs_ops::tests` den geteilten Layout-Testtext
// (`tests::BEIDE_LAYOUTS`) mitbenutzt, statt ihn zu duplizieren (Befund 12).
#[cfg(test)]
#[path = "vdf_patch_tests.rs"]
pub(crate) mod tests;
