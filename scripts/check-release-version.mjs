import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFileVersionsConsistent,
  collectFileVersions,
  compareReleaseVersions,
  extractReleaseContext,
  normalizeReleaseTag,
  releaseNotesPath,
} from "./release-version-lib.mjs";
import { runSelfTest } from "./release-version-selftest.mjs";

/**
 * @param {string} rootDirectory
 * @returns {{
 *   packageJson: string,
 *   packageLock: string,
 *   tauriConfig: string,
 *   cargoToml: string,
 *   cargoLock: string,
 *   metainfo: string,
 *   readme: string,
 *   readmeEn: string,
 * }}
 */
function readRepositoryInputs(rootDirectory) {
  /** @type {(relativePath: string) => string} */
  const read = (relativePath) => fs.readFileSync(path.join(rootDirectory, relativePath), "utf8");
  return {
    packageJson: read("package.json"),
    packageLock: read("package-lock.json"),
    tauriConfig: read("src-tauri/tauri.conf.json"),
    cargoToml: read("src-tauri/Cargo.toml"),
    cargoLock: read("src-tauri/Cargo.lock"),
    metainfo: read("src-tauri/packaging/com.protium.desktop.metainfo.xml"),
    readme: read("README.md"),
    readmeEn: read("README.en.md"),
  };
}

/**
 * Prueft nur die konsistenz der versionsdateien im arbeitsbaum; ohne tag
 * und ohne release-notes, damit der check auch ausserhalb eines
 * release-kontexts laufen kann.
 * @param {string} rootDirectory
 * @returns {void}
 */
function runFilesOnlyCheck(rootDirectory) {
  const versions = collectFileVersions(readRepositoryInputs(rootDirectory));
  console.log(`release version files: ${assertFileVersionsConsistent(versions)}`);
}

/** @param {string} rootDirectory @param {string} releaseTag @returns {string} */
function readReleaseNotes(rootDirectory, releaseTag) {
  const relativePath = releaseNotesPath(releaseTag);
  try {
    return fs.readFileSync(path.join(rootDirectory, relativePath), "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`${relativePath}: release notes file is missing`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${relativePath}: unable to read release notes (${message})`);
  }
}

/** @param {string[]} argumentsList */
function runCli(argumentsList) {
  if (argumentsList.length === 1 && argumentsList[0] === "--self-test") {
    runSelfTest();
    console.log("release version self-test: ok");
    return;
  }
  if (argumentsList.length === 1 && argumentsList[0] === "--files-only") {
    const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    runFilesOnlyCheck(rootDirectory);
    return;
  }
  if (argumentsList.length !== 0) {
    throw new Error("usage: node scripts/check-release-version.mjs [--self-test | --files-only]");
  }

  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const releaseContext = extractReleaseContext(process.env);
  const tagVersion = normalizeReleaseTag(
    releaseContext.refType,
    releaseContext.tag,
    releaseContext.ref,
  );
  const releaseTag = `v${tagVersion}`;
  const result = compareReleaseVersions({
    ...releaseContext,
    ...readRepositoryInputs(rootDirectory),
    releaseNotes: readReleaseNotes(rootDirectory, releaseTag),
  });
  console.log(`release version check: ${result.tagVersion}`);
}

const entryPath = process.argv[1];
if (entryPath && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release version check failed: ${message}`);
    process.exitCode = 1;
  }
}
