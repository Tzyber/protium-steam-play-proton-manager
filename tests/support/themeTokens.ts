import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const cache = new Map<string, string>();

export function readRepoFile(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf-8");
}

export function tokenValues(): Map<string, string> {
  if (cache.size === 0) {
    for (const match of readRepoFile("src/ui/tokens.css").matchAll(
      /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g,
    )) {
      if (match[1] && match[2]) cache.set(match[1], match[2]);
    }
  }
  return cache;
}

export function tokenValue(name: string): string | undefined {
  return tokenValues().get(name);
}
