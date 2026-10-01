// Seitenwirkungsfreie Quelle der Mock-Token-Lebensdauer (D-04): Tests, die nur
// den TTL-Wert brauchen, importieren hieraus, statt die cleanupStoreMocks zu
// laden (die Datei registriert beim Import vier vi.mock-Seiteneffekte).
// DELETE_TOKEN_TTL_SECS = 300 in src-tauri/src/commands/delete_ops.rs;
// mirrored-constants.test.ts hält beide Quellen (hier und cleanupStoreMocks)
// mit dem Rust-Wert zusammen.

export const MOCK_TOKEN_TTL_MS = 300_000;
