import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReleaseVersion } from "../../scripts/check-release-version.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts/check-release-version.mjs");
const tempDirs: string[] = [];

interface FixtureOverrides {
  packageJson?: string;
  packageLock?: string;
  tauriConfig?: string;
  cargoToml?: string;
  cargoLock?: string;
  metainfo?: string;
  readme?: string;
  readmeEn?: string;
  releaseNotes?: string | null;
  releaseTag?: string;
}

function createFixture(version = "1.2.3", overrides: FixtureOverrides = {}): string {
  const root = mkdtempSync(join(tmpdir(), "protium-release-check-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src-tauri/packaging"), { recursive: true });
  mkdirSync(join(root, "docs/releases"), { recursive: true });

  const files: Record<string, string> = {
    "package.json": overrides.packageJson ?? JSON.stringify({ name: "protium", version }),
    "package-lock.json":
      overrides.packageLock ??
      JSON.stringify({
        name: "protium",
        version,
        packages: { "": { name: "protium", version } },
      }),
    "src-tauri/tauri.conf.json": overrides.tauriConfig ?? JSON.stringify({ version }),
    "src-tauri/Cargo.toml":
      overrides.cargoToml ??
      `[package]\nname = "protium"\nversion = "${version}"\n\n[dependencies]\nserde = { version = "9.9.9" }\n`,
    "src-tauri/Cargo.lock":
      overrides.cargoLock ??
      `version = 3\n\n[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "protium"\nversion = "${version}"\n`,
    "src-tauri/packaging/com.protium.desktop.metainfo.xml":
      overrides.metainfo ??
      `<component><releases><release version="${version}" date="2026-11-20"/><release version="0.0.1" date="2026-01-01"/></releases></component>\n`,
    "README.md":
      overrides.readme ??
      `aktuelle version: \`v${version}\`.\nprotium_${version}_amd64.AppImage\nprotium_${version}_amd64.deb\nprotium_<version>_amd64.AppImage\n`,
    "README.en.md":
      overrides.readmeEn ??
      `current version: \`v${version}\`.\nprotium_${version}_amd64.AppImage\nprotium_${version}_amd64.deb\nprotium_<version>_amd64.deb\n`,
  };

  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(root, rel), content, "utf8");
  }
  const tag = overrides.releaseTag ?? `v${version}`;
  if (overrides.releaseNotes !== null) {
    writeFileSync(
      join(root, `docs/releases/${tag}.md`),
      overrides.releaseNotes ?? `# ${tag}\n\nRelease text.\n`,
      "utf8",
    );
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkReleaseVersion", () => {
  it("akzeptiert konsistente Dateien im --files-only-Modus ohne Release-Notes und Env", () => {
    const root = createFixture("1.2.3", { releaseNotes: null });
    expect(checkReleaseVersion(root, { filesOnly: true, env: {} })).toBe("1.2.3");
  });

  it("akzeptiert konsistente Dateien inkl. Prerelease im Release-Modus", () => {
    const root = createFixture("1.2.3-rc.1");
    expect(
      checkReleaseVersion(root, {
        filesOnly: false,
        env: {
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_NAME: "v1.2.3-rc.1",
          GITHUB_REF: "refs/tags/v1.2.3-rc.1",
        },
      }),
    ).toBe("1.2.3-rc.1");
  });

  it("leitet das Tag im Release-Modus aus GITHUB_REF ab, wenn GITHUB_REF_NAME fehlt", () => {
    const root = createFixture("1.2.3");
    expect(
      checkReleaseVersion(root, {
        filesOnly: false,
        env: { GITHUB_REF_TYPE: "tag", GITHUB_REF: "refs/tags/v1.2.3" },
      }),
    ).toBe("1.2.3");
  });

  it.each<[string, FixtureOverrides, string | RegExp]>([
    [
      "package.json ohne version",
      { packageJson: JSON.stringify({ name: "protium" }) },
      "package.json",
    ],
    [
      "package-lock.json top-level version",
      {
        packageLock: JSON.stringify({
          name: "protium",
          version: "9.9.9",
          packages: { "": { name: "protium", version: "1.2.3" } },
        }),
      },
      "package-lock.json",
    ],
    [
      'package-lock.json packages[""] version',
      {
        packageLock: JSON.stringify({
          name: "protium",
          version: "1.2.3",
          packages: { "": { name: "protium", version: "9.9.9" } },
        }),
      },
      'packages[""]',
    ],
    [
      "package-lock.json falscher Paketname",
      {
        packageLock: JSON.stringify({
          name: "other",
          version: "1.2.3",
          packages: { "": { name: "protium", version: "1.2.3" } },
        }),
      },
      "package-lock.json",
    ],
    [
      'package-lock.json falscher packages[""] Paketname',
      {
        packageLock: JSON.stringify({
          name: "protium",
          version: "1.2.3",
          packages: { "": { name: "other", version: "1.2.3" } },
        }),
      },
      "package-lock.json",
    ],
    ["tauri.conf.json", { tauriConfig: JSON.stringify({ version: "9.9.9" }) }, "tauri.conf.json"],
    [
      "Cargo.toml [package]-Version",
      {
        cargoToml: `[package]\nname = "protium"\nversion = "9.9.9"\n\n[dependencies]\nserde = { version = "1.2.3" }\n`,
      },
      "Cargo.toml",
    ],
    [
      "Cargo.lock protium-Block",
      {
        cargoLock: `[[package]]\nname = "other"\nversion = "1.2.3"\n\n[[package]]\nname = "protium"\nversion = "9.9.9"\n`,
      },
      "Cargo.lock",
    ],
    [
      "Cargo.lock doppelter protium-Block",
      {
        cargoLock: `[[package]]\nname = "protium"\nversion = "1.2.3"\n\n[[package]]\nname = "protium"\nversion = "1.2.3"\n`,
      },
      "Cargo.lock",
    ],
    [
      "metainfo.xml erster <release>-Eintrag",
      {
        metainfo: `<component><releases><release version="9.9.9" date="2026-11-20"/><release version="1.2.3" date="2026-01-01"/></releases></component>\n`,
      },
      "metainfo.xml",
    ],
    [
      "README.md aktuelle version",
      {
        readme: `aktuelle version: \`v9.9.9\`.\nprotium_1.2.3_amd64.AppImage\n`,
      },
      "README.md",
    ],
    [
      "README.en.md current version",
      {
        readmeEn: `current version: \`v9.9.9\`.\nprotium_1.2.3_amd64.AppImage\n`,
      },
      "README.en.md",
    ],
    [
      "README.md abweichender zweiter Dateiname",
      {
        readme: `aktuelle version: \`v1.2.3\`.\nprotium_1.2.3_amd64.AppImage\nprotium_9.9.9_amd64.deb\n`,
      },
      "README.md",
    ],
    [
      "README.en.md abweichender zweiter Dateiname",
      {
        readmeEn: `current version: \`v1.2.3\`.\nprotium_1.2.3_amd64.AppImage\nprotium_9.9.9_amd64.deb\n`,
      },
      "README.en.md",
    ],
  ])("lehnt Abweichung in %s ab", (_label, overrides, expectedSource) => {
    const root = createFixture("1.2.3", overrides);
    expect(() => checkReleaseVersion(root, { filesOnly: true, env: {} })).toThrow(expectedSource);
  });

  it("lehnt fehlenden oder ungültigen Release-Tag-Kontext ab", () => {
    const root = createFixture("1.2.3");
    expect(() => checkReleaseVersion(root, { filesOnly: false, env: {} })).toThrow(/ref_type|tag/i);
    expect(() =>
      checkReleaseVersion(root, {
        filesOnly: false,
        env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2" },
      }),
    ).toThrow(/tag/i);
    expect(() =>
      checkReleaseVersion(root, {
        filesOnly: false,
        env: {
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_NAME: "v1.2.3",
          GITHUB_REF: "refs/tags/v9.9.9",
        },
      }),
    ).toThrow(/GITHUB_REF|ref/i);
  });

  it("lehnt fehlende, überschriftslose oder teil-matchende Release-Notes ab", () => {
    const validEnv = { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" };
    const missing = createFixture("1.2.3", { releaseNotes: null });
    expect(() => checkReleaseVersion(missing, { filesOnly: false, env: validEnv })).toThrow(
      "docs/releases/v1.2.3.md",
    );

    const noHeading = createFixture("1.2.3", { releaseNotes: "Nur Text ohne Heading\n" });
    expect(() => checkReleaseVersion(noHeading, { filesOnly: false, env: validEnv })).toThrow(
      "heading",
    );

    const prefixTrick = createFixture("1.2.3", { releaseNotes: "# v1.2.30\n" });
    expect(() => checkReleaseVersion(prefixTrick, { filesOnly: false, env: validEnv })).toThrow(
      "v1.2.3",
    );
  });
});

describe("check-release-version CLI", () => {
  it("läuft mit --files-only gegen das Repository mit Exit 0", () => {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, "--files-only"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
  });

  it("lehnt unbekannte Flags und fehlenden Release-Kontext mit Exit 1 ab", () => {
    const badFlag = spawnSync(process.execPath, [SCRIPT_PATH, "--self-test"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(badFlag.status).toBe(1);

    const noContext = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(noContext.status).toBe(1);
  });
});
