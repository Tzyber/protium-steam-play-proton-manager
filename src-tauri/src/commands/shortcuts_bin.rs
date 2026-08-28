// Binärer shortcuts.vdf-Minimalparser (nur AppID-Extraktion), von steam.rs
// entlang der Verantwortlichkeit geteilt. Die Delete-Inspektion in steam.rs
// nutzt diesen Parser über `parse_binary_shortcut_ids`.

use std::collections::HashSet;

/// Tiefenlimit für binäre shortcuts.vdf-maps: echte dateien sind flach
/// (shortcut → werte). ohne cap liesse eine künstlich tief geschachtelte
/// datei den rekursiven walker den thread-stack überlaufen (abort).
const MAX_BINARY_VDF_DEPTH: usize = 64;

fn read_c_string(buf: &[u8], pos: usize) -> Result<(String, usize), String> {
    if pos >= buf.len() {
        return Err("truncated buffer while reading string".into());
    }
    let end = buf[pos..]
        .iter()
        .position(|&b| b == 0)
        .ok_or_else(|| "unterminated string in binary vdf".to_string())?;
    let s = std::str::from_utf8(&buf[pos..pos + end])
        .map_err(|e| format!("invalid utf-8 in binary vdf: {e}"))?;
    Ok((s.to_string(), pos + end + 1))
}

fn read_u32_le(buf: &[u8], pos: usize) -> Result<(u32, usize), String> {
    if pos + 4 > buf.len() {
        return Err("truncated buffer while reading u32".into());
    }
    let val = u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]);
    Ok((val, pos + 4))
}

fn skip_binary_value(buf: &[u8], pos: usize, val_type: u8, depth: usize) -> Result<usize, String> {
    match val_type {
        0x00 => walk_binary_map_body(buf, pos, &mut |_| {}, false, depth),
        0x01 => {
            let (_, next) = read_c_string(buf, pos)?;
            Ok(next)
        }
        0x02 | 0x03 | 0x04 | 0x06 => {
            if pos + 4 > buf.len() {
                return Err("truncated binary scalar".into());
            }
            Ok(pos + 4)
        }
        0x05 => {
            if pos + 2 > buf.len() {
                return Err("truncated wstring count".into());
            }
            let count = u16::from_le_bytes([buf[pos], buf[pos + 1]]) as usize;
            let end = pos + 2 + count * 2;
            if end > buf.len() {
                return Err("truncated wstring data".into());
            }
            Ok(end)
        }
        0x07 => {
            if pos + 8 > buf.len() {
                return Err("truncated uint64".into());
            }
            Ok(pos + 8)
        }
        _ => Err(format!("unknown binary vdf type byte: 0x{val_type:02x}")),
    }
}

fn walk_binary_map_body(
    buf: &[u8],
    mut pos: usize,
    on_app_id: &mut dyn FnMut(u32),
    is_root: bool,
    depth: usize,
) -> Result<usize, String> {
    if depth > MAX_BINARY_VDF_DEPTH {
        return Err("binary vdf nesting too deep".into());
    }
    while pos < buf.len() {
        let type_byte = buf[pos];
        if type_byte == 0x08 {
            return Ok(pos + 1);
        }
        pos += 1;
        let (key, next_pos) = read_c_string(buf, pos)?;
        pos = next_pos;

        if is_root {
            if type_byte == 0x00 && key.chars().all(|c| c.is_ascii_digit()) {
                pos = walk_binary_map_body(buf, pos, on_app_id, false, depth + 1)?;
            } else {
                pos = skip_binary_value(buf, pos, type_byte, depth + 1)?;
            }
        } else if type_byte == 0x02 && key.eq_ignore_ascii_case("appid") {
            let (val, next) = read_u32_le(buf, pos)?;
            if val > 0 {
                on_app_id(val);
            }
            pos = next;
        } else {
            pos = skip_binary_value(buf, pos, type_byte, depth + 1)?;
        }
    }
    Err("unterminated binary map body".into())
}

pub(super) fn parse_binary_shortcut_ids(buf: &[u8]) -> Result<HashSet<u32>, String> {
    if buf.is_empty() || buf[0] != 0x00 {
        return Err("missing magic byte 0x00 in shortcuts.vdf".into());
    }
    let (root_name, pos) = read_c_string(buf, 1)?;
    if !root_name.eq_ignore_ascii_case("shortcuts") {
        return Err(format!("unexpected binary root key: {root_name}"));
    }

    let mut ids = HashSet::new();
    walk_binary_map_body(
        buf,
        pos,
        &mut |app_id| {
            ids.insert(app_id);
        },
        true,
        0,
    )?;

    Ok(ids)
}

#[cfg(test)]
pub(super) fn make_test_bin_shortcuts(app_ids: &[u32]) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.push(0x00);
    buf.extend_from_slice(b"shortcuts\0");
    for (i, id) in app_ids.iter().enumerate() {
        buf.push(0x00); // map
        buf.extend_from_slice(format!("{i}\0").as_bytes());
        buf.push(0x02); // type u32
        buf.extend_from_slice(b"appid\0");
        buf.extend_from_slice(&id.to_le_bytes());
        buf.push(0x01); // type string
        buf.extend_from_slice(b"appname\0Test\0");
        buf.push(0x08); // map end
    }
    buf.push(0x08); // root map end
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_shortcuts_parser_erkennt_ids_und_schuetzt_vor_korruption() {
        let bytes = make_test_bin_shortcuts(&[3641016077, 123456]);
        let ids = parse_binary_shortcut_ids(&bytes).unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&3641016077));
        assert!(ids.contains(&123456));

        // Truncated buffer -> Err
        assert!(parse_binary_shortcut_ids(&bytes[..10]).is_err());
        // Bad magic byte -> Err
        let mut bad_magic = bytes.clone();
        bad_magic[0] = 0x01;
        assert!(parse_binary_shortcut_ids(&bad_magic).is_err());
    }

    #[test]
    fn binary_shortcuts_parser_lehnt_tiefe_verschachtelung_ab() {
        // 100_000 geschachtelte maps: ohne depth-cap stack overflow (abort),
        // mit cap sauberes Err statt Prozess-Absturz.
        let mut deep = vec![0x00];
        deep.extend_from_slice(b"shortcuts\0");
        for _ in 0..100_000 {
            deep.extend_from_slice(&[0x00]);
            deep.push(b'a');
            deep.push(0x00);
        }
        deep.push(0x08);
        let err = parse_binary_shortcut_ids(&deep).unwrap_err();
        assert!(err.contains("nesting"), "err: {err}");

        // flache struktur (10 ebenen) bleibt ok: jede map braucht ihren
        // eigenen 0x08-abschluss (10 nested + root)
        let mut flat = vec![0x00];
        flat.extend_from_slice(b"shortcuts\0");
        for _ in 0..10 {
            flat.extend_from_slice(&[0x00]);
            flat.push(b'a');
            flat.push(0x00);
        }
        flat.extend(std::iter::repeat_n(0x08, 11));
        assert!(parse_binary_shortcut_ids(&flat).is_ok());

        // exakte grenze wie typescript (MAX_BINARY_VDF_DEPTH=64): 64 bleiben
        // ok, 65 wirft fail-closed.
        let mut at_limit = vec![0x00];
        at_limit.extend_from_slice(b"shortcuts\0");
        for _ in 0..64 {
            at_limit.extend_from_slice(&[0x00, b'a', 0x00]);
        }
        at_limit.extend(std::iter::repeat_n(0x08, 65));
        assert!(parse_binary_shortcut_ids(&at_limit).is_ok());

        let mut over_limit = vec![0x00];
        over_limit.extend_from_slice(b"shortcuts\0");
        for _ in 0..65 {
            over_limit.extend_from_slice(&[0x00, b'a', 0x00]);
        }
        over_limit.extend(std::iter::repeat_n(0x08, 66));
        let err = parse_binary_shortcut_ids(&over_limit).unwrap_err();
        assert!(err.contains("nesting"), "err: {err}");
    }

    #[test]
    fn binary_shortcuts_parser_golden_fixture_bindet_gleiche_appids_wie_typescript() {
        // gemeinsame datei tests/fixtures/shortcuts-golden.vdf; dieselbe
        // erwartete menge wie tests/core/shortcuts.test.ts.
        let bytes = include_bytes!("../../../tests/fixtures/shortcuts-golden.vdf");
        let ids = parse_binary_shortcut_ids(bytes).unwrap();
        let mut expected = HashSet::new();
        expected.insert(3641016077u32);
        expected.insert(123456u32);
        expected.insert(42u32);
        assert_eq!(ids, expected);
        // LastPlayTime (0x02, kein "appid"-key) darf nicht landen
        assert!(!ids.contains(&99999));
    }
}
