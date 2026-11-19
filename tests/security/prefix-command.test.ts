import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Auflösung über den dateistandort statt über das arbeitsverzeichnis (T-11).
const root = resolve(import.meta.dirname, "../..");

interface IpcPin {
  command: string;
  registration: string;
}

const ipcPins: IpcPin[] = [
  {
    command: "open_prefix_folder",
    registration: "commands::prefix::open_prefix_folder,",
  },
  {
    command: "load_app_settings",
    registration: "commands::settings::load_app_settings,",
  },
  {
    command: "save_app_settings",
    registration: "commands::settings::save_app_settings,",
  },
];

describe("Prefix- und Settings-Command-Grenze", () => {
  it.each(ipcPins)(
    "hält $command ausschließlich im Tauri-Adapter und in lib.rs registriert",
    ({ command, registration }) => {
      const files = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true });
      const callers = files
        .filter((file) => file.isFile() && /\.(ts|vue)$/.test(file.name))
        .map((file) => join(file.parentPath, file.name))
        .filter((file) => readFileSync(file, "utf8").includes(command))
        .map((file) => relative(root, file));
      expect(callers).toEqual(["src/core/adapters/tauri.ts"]);
      expect(readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8")).toContain(registration);
    },
  );
});
