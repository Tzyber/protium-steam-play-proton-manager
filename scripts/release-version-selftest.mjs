// Ohne Abhängigkeiten außer der Bibliothek: der Release-Job ruft den
// Self-Test vor `npm ci` auf.
import {
  assertFileVersionsConsistent,
  collectFileVersions,
  compareReleaseVersions,
} from "./release-version-lib.mjs";

/** @typedef {import("./release-version-lib.mjs").ReleaseInputs} ReleaseInputs */

/** @returns {ReleaseInputs & {releaseNotes: string}} */
function validFixture() {
  return {
    refType: "tag",
    ref: "refs/tags/v0.3.1",
    tag: "v0.3.1",
    packageJson: '{"name":"protium","version":"0.3.1"}',
    packageLock: `{
  "name": "protium",
  "version": "0.3.1",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "protium",
      "version": "0.3.1"
    }
  }
}
`,
    tauriConfig: '{"productName":"protium","version":"0.3.1"}',
    cargoToml: '[package]\nname = "protium"\nversion = "0.3.1"\nedition = "2021"\n',
    cargoLock:
      'version = 3\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "protium"\nversion = "0.3.1"\ndependencies = []\n',
    metainfo:
      '<releases>\n  <release version="0.3.1" date="2026-01-02"/>\n  <release version="0.3.0" date="2026-01-01"/>\n</releases>\n',
    readme:
      "aktuelle version: `v0.3.1`.\n\nchmod +x protium_0.3.1_amd64.AppImage\nsudo apt install ./protium_0.3.1_amd64.deb\ngh attestation verify protium_<version>_amd64.deb\n",
    readmeEn:
      "current version: `v0.3.1`.\n\nchmod +x protium_0.3.1_amd64.AppImage\nsudo apt install ./protium_0.3.1_amd64.deb\n",
    releaseNotes: "# v0.3.1\n\n## 0.3.1, besser bedienbar\n\nRelease-Text.\n",
  };
}

/** @param {string} name @param {ReleaseInputs} input */
function expectFailure(name, input) {
  try {
    compareReleaseVersions(input);
  } catch {
    return;
  }
  throw new Error(`self-test expected failure: ${name}`);
}

function runSelfTest() {
  const valid = validFixture();
  const result = compareReleaseVersions(valid);
  if (
    result.tagVersion !== "0.3.1" ||
    Object.values(result.versions).some((version) => version !== "0.3.1")
  ) {
    throw new Error("self-test happy case returned an unexpected version");
  }

  expectFailure("package.json version", {
    ...valid,
    packageJson: valid.packageJson.replace("0.3.1", "0.3.2"),
  });
  expectFailure("package-lock top-level version", {
    ...valid,
    packageLock: valid.packageLock.replace(
      '"version": "0.3.1",\n  "lockfileVersion"',
      '"version": "0.3.2",\n  "lockfileVersion"',
    ),
  });
  expectFailure("package-lock root package version", {
    ...valid,
    packageLock: valid.packageLock.replace(
      '"name": "protium",\n      "version": "0.3.1"',
      '"name": "protium",\n      "version": "0.3.2"',
    ),
  });
  expectFailure("tauri version", {
    ...valid,
    tauriConfig: valid.tauriConfig.replace("0.3.1", "0.3.2"),
  });
  expectFailure("Cargo.toml version", {
    ...valid,
    cargoToml: valid.cargoToml.replace("0.3.1", "0.3.2"),
  });
  expectFailure("Cargo.lock version", {
    ...valid,
    cargoLock: valid.cargoLock.replace("0.3.1", "0.3.2"),
  });
  expectFailure("metainfo newest release", {
    ...valid,
    metainfo: valid.metainfo.replace('"0.3.1"', '"0.3.2"'),
  });
  expectFailure("README.md current version", {
    ...valid,
    readme: valid.readme.replace("`v0.3.1`", "`v0.3.2`"),
  });
  expectFailure("README.en.md download name", {
    ...valid,
    readmeEn: valid.readmeEn.replace("protium_0.3.1_amd64.deb", "protium_0.3.2_amd64.deb"),
  });
  expectFailure("branch ref", {
    ...valid,
    refType: "branch",
    ref: "refs/heads/main",
  });
  expectFailure("invalid tag", {
    ...valid,
    tag: "v0.3",
    ref: "refs/tags/v0.3",
  });
  expectFailure("missing root Cargo.lock block", {
    ...valid,
    cargoLock: valid.cargoLock.replace(
      '[[package]]\nname = "protium"\nversion = "0.3.1"\ndependencies = []\n',
      "",
    ),
  });
  expectFailure("multiple root Cargo.lock blocks", {
    ...valid,
    cargoLock: `${valid.cargoLock}\n[[package]]\nname = "protium"\nversion = "0.3.1"\n`,
  });
  expectFailure("missing release file", {
    ...valid,
    releaseNotes: undefined,
  });
  expectFailure("missing first release heading", {
    ...valid,
    releaseNotes: "Release-Text ohne Markdown-Überschrift.\n",
  });
  expectFailure("wrong release heading", {
    ...valid,
    releaseNotes: valid.releaseNotes.replace("v0.3.1", "v0.3.2"),
  });
  expectFailure("wrong release tag prefix", {
    ...valid,
    releaseNotes: "# v0.3.10\n",
  });

  // --files-only: die quellen muessen auch ohne tag und release-notes
  // zusammenpassen; ein drift zwischen zwei dateien faellt hier auf.
  assertFileVersionsConsistent(collectFileVersions(valid));
  expectFilesOnlyFailure("files-only: tauri version", {
    ...valid,
    tauriConfig: valid.tauriConfig.replace("0.3.1", "0.3.2"),
  });
  expectFilesOnlyFailure("files-only: Cargo.lock version", {
    ...valid,
    cargoLock: valid.cargoLock.replace("0.3.1", "0.3.2"),
  });
  expectFilesOnlyFailure("files-only: metainfo newest release", {
    ...valid,
    metainfo: valid.metainfo.replace('"0.3.1"', '"0.3.2"'),
  });
  expectFilesOnlyFailure("files-only: README.md current version", {
    ...valid,
    readme: valid.readme.replace("`v0.3.1`", "`v0.3.2`"),
  });
  expectFilesOnlyFailure("files-only: README.en.md current version", {
    ...valid,
    readmeEn: valid.readmeEn.replace("`v0.3.1`", "`v0.3.2`"),
  });
  expectFilesOnlyFailure("files-only: README.md download name", {
    ...valid,
    readme: valid.readme.replace("protium_0.3.1_amd64.deb", "protium_0.3.2_amd64.deb"),
  });
  expectFilesOnlyFailure("files-only: README.en.md download name", {
    ...valid,
    readmeEn: valid.readmeEn.replace(
      "protium_0.3.1_amd64.AppImage",
      "protium_0.3.2_amd64.AppImage",
    ),
  });
}

/** @param {string} name @param {ReleaseInputs} input */
function expectFilesOnlyFailure(name, input) {
  try {
    assertFileVersionsConsistent(collectFileVersions(input));
  } catch (error) {
    // nur der drift-fehler zaehlt als erwarteter fehlschlag; ein extraktor-
    // oder fixture-fehler waere ein kaputter self-test und muss auffallen.
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("release version mismatch across files:")) return;
    throw error;
  }
  throw new Error(`self-test expected files-only failure: ${name}`);
}

export { runSelfTest };
