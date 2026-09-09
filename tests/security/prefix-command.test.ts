import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Prefix-Command-Grenze", () => {
  it("hält den IPC-Namen ausschließlich im Tauri-Adapter", () => {
    const files = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true });
    const callers = files
      .filter((file) => file.isFile() && /\.(ts|vue)$/.test(file.name))
      .map((file) => join(file.parentPath, file.name))
      .filter((file) => readFileSync(file, "utf8").includes("open_prefix_folder"))
      .map((file) => relative(root, file));
    expect(callers).toEqual(["src/core/adapters/tauri.ts"]);
    expect(readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8")).toContain(
      "commands::prefix::open_prefix_folder,",
    );
  });
});
