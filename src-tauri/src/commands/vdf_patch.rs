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
#[path = "vdf_patch_tests.rs"]
mod tests;
