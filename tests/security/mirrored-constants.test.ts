import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_COMPAT_DIRS } from "../../src/core/paths.js";
import { MAX_BINARY_VDF_DEPTH } from "../../src/core/shortcuts.js";
import { MAX_APP_ID } from "../../src/core/types.js";
import { MAX_PENDING_DELETES } from "../../src/ui/stores/cleanupStore.js";

const repo = process.cwd();

describe("TypeScript-/Rust-Spiegelwerte", () => {
  it("bindet System-Compat-Pfade, AppID-Grenze und Shortcut-Tiefenlimit", () => {
    const scope = readFileSync(join(repo, "src-tauri/src/commands/scope.rs"), "utf8");
    const shortcuts = readFileSync(join(repo, "src-tauri/src/commands/shortcuts_bin.rs"), "utf8");

    expect(SYSTEM_COMPAT_DIRS).toEqual([
      "/usr/share/steam/compatibilitytools.d",
      "/usr/local/share/steam/compatibilitytools.d",
    ]);
    const systemCompatBlock = scope.match(
      /pub\(crate\) const SYSTEM_COMPAT_DIRS: \[&str; 2\] = \[([\s\S]*?)\];/,
    );
    expect(systemCompatBlock).not.toBeNull();
    const rustSystemCompatDirs = [...(systemCompatBlock?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(rustSystemCompatDirs).toEqual(SYSTEM_COMPAT_DIRS);

    expect(MAX_APP_ID).toBe(4_294_967_295);
    expect(scope).toContain("1..=u32::MAX as u64");

    expect(MAX_BINARY_VDF_DEPTH).toBe(64);
    expect(shortcuts).toContain("const MAX_BINARY_VDF_DEPTH: usize = 64;");
  });

  it("bindet das Delete-Batch-Limit an die Rust-Registry", () => {
    const deleteOps = readFileSync(join(repo, "src-tauri/src/commands/delete_ops.rs"), "utf8");

    expect(MAX_PENDING_DELETES).toBe(32);
    expect(deleteOps).toContain("pub const MAX_PENDING_DELETES: usize = 32;");
    expect(deleteOps).toContain("pub const DELETE_TOKEN_TTL_SECS: u64 = 300;");
  });
});
