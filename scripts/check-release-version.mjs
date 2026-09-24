import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/u;
const JSON_VERSION_KEY_PATTERN = /"version"\s*:/gu;
const MARKDOWN_HEADING_PATTERN = /^\s{0,3}#{1,6}[ \t]+(.+?)\s*$/u;

/**
 * @typedef {object} ReleaseInputs
 * @property {string} refType
 * @property {string} tag
 * @property {string} [ref]
 * @property {string} packageJson
 * @property {string} packageLock
 * @property {string} tauriConfig
 * @property {string} cargoToml
 * @property {string} cargoLock
 * @property {string | undefined} releaseNotes
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} source @returns {string} */
function requireText(value, source) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source}: empty input`);
  }
  return value;
}

/** @param {unknown} value @param {string} source @returns {string} */
function requireVersion(value, source) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${source}: version extraction is empty or ambiguous`);
  }
  return value;
}

/** @param {unknown} value @param {string} source @returns {string} */
function requireName(value, source) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${source}: name extraction is empty or ambiguous`);
  }
  return value;
}

/** @param {unknown} content @param {string} source @returns {Record<string, unknown>} */
function parseJsonObject(content, source) {
  const text = requireText(content, source);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: invalid JSON (${message})`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${source}: root object is missing`);
  }

  return parsed;
}

/** @param {string} content @param {string} source @returns {string} */
function extractJsonVersion(content, source) {
  const text = requireText(content, source);
  const parsed = parseJsonObject(text, source);
  const versionKeys = text.match(JSON_VERSION_KEY_PATTERN) ?? [];
  if (versionKeys.length !== 1) {
    throw new Error(`${source}: expected exactly one root version`);
  }

  return requireVersion(parsed.version, source);
}

/** @param {string} line @returns {string} */
function stripTomlComment(line) {
  const commentIndex = line.indexOf("#");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

/**
 * @param {string} content
 * @param {string} sectionName
 * @param {string} source
 * @returns {string}
 */
function findSingleTomlSection(content, sectionName, source) {
  const text = requireText(content, source);
  const lines = text.split(/\r?\n/u);
  /** @type {number[]} */
  const sectionStarts = [];

  lines.forEach((line, index) => {
    if (stripTomlComment(line).trim() === `[${sectionName}]`) {
      sectionStarts.push(index);
    }
  });

  const [sectionStart] = sectionStarts;
  if (sectionStarts.length !== 1 || sectionStart === undefined) {
    throw new Error(`${source}: expected exactly one [${sectionName}] section`);
  }

  const start = sectionStart + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (stripTomlComment(line).trimStart().startsWith("[")) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
}

/**
 * @param {string} content
 * @param {string} fieldName
 * @param {string} source
 * @returns {string}
 */
function extractTomlField(content, fieldName, source) {
  const text = requireText(content, source);
  const fieldPattern = new RegExp(`^\\s*${fieldName}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, "gmu");
  const matches = [...text.matchAll(fieldPattern)];
  if (matches.length !== 1) {
    throw new Error(`${source}: expected exactly one ${fieldName} field`);
  }
  return fieldName === "name"
    ? requireName(matches[0]?.[1], source)
    : requireVersion(matches[0]?.[1], source);
}

/** @param {string} content @returns {string} */
export function extractPackageJsonVersion(content) {
  return extractJsonVersion(content, "package.json");
}

/**
 * @param {string} content
 * @returns {{topLevelVersion: string, rootPackageVersion: string}}
 */
export function extractPackageLockVersions(content) {
  const source = "package-lock.json";
  const parsed = parseJsonObject(content, source);
  const topLevelName = requireName(parsed.name, `${source} top-level name`);
  const topLevelVersion = requireVersion(parsed.version, `${source} top-level version`);

  const packages = parsed.packages;
  if (!isRecord(packages)) {
    throw new Error(`${source}: packages object is missing`);
  }
  if (!Object.hasOwn(packages, "")) {
    throw new Error(`${source}: root package entry is missing`);
  }

  const rootPackage = packages[""];
  if (!isRecord(rootPackage)) {
    throw new Error(`${source}: root package object is missing`);
  }

  const rootPackageName = requireName(rootPackage.name, `${source} packages[""] name`);
  const rootPackageVersion = requireVersion(rootPackage.version, `${source} packages[""] version`);
  if (topLevelName !== "protium" || rootPackageName !== "protium") {
    throw new Error(`${source}: expected protium package names`);
  }

  return { topLevelVersion, rootPackageVersion };
}

/** @param {string} content @returns {string} */
export function extractTauriVersion(content) {
  return extractJsonVersion(content, "src-tauri/tauri.conf.json");
}

/** @param {string} content @returns {string} */
export function extractCargoTomlVersion(content) {
  const packageSection = findSingleTomlSection(content, "package", "src-tauri/Cargo.toml");
  return extractTomlField(packageSection, "version", "src-tauri/Cargo.toml");
}

/** @param {string} content @param {string} source @returns {string[]} */
function findCargoLockPackageBlocks(content, source) {
  const text = requireText(content, source);
  const lines = text.split(/\r?\n/u);
  /** @type {number[]} */
  const starts = [];

  lines.forEach((line, index) => {
    if (stripTomlComment(line).trim() === "[[package]]") {
      starts.push(index);
    }
  });

  if (starts.length === 0) {
    throw new Error(`${source}: no [[package]] blocks found`);
  }

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    return lines.slice(start + 1, end).join("\n");
  });
}

/** @param {string} content @returns {string} */
export function extractCargoLockRootVersion(content) {
  const source = "src-tauri/Cargo.lock";
  const packageBlocks = findCargoLockPackageBlocks(content, source);
  const rootBlocks = packageBlocks.filter((block) => {
    const name = extractTomlField(block, "name", source);
    return name === "protium";
  });

  const rootBlock = rootBlocks[0];
  if (rootBlocks.length !== 1 || rootBlock === undefined) {
    throw new Error(`${source}: expected exactly one root protium package block`);
  }

  return extractTomlField(rootBlock, "version", source);
}

/**
 * @param {Record<string, string | undefined>} environment
 * @returns {{refType: string, ref: string | undefined, tag: string}}
 */
export function extractReleaseContext(environment) {
  const refType = environment.GITHUB_REF_TYPE ?? "";
  const refValue = environment.GITHUB_REF ?? "";
  const ref = refValue || undefined;
  const refName = environment.GITHUB_REF_NAME ?? "";
  const tag =
    refName || (refValue.startsWith("refs/tags/") ? refValue.slice("refs/tags/".length) : "");
  return { refType, ref, tag };
}

/**
 * @param {string} refType
 * @param {string} tag
 * @param {string} [ref]
 * @returns {string}
 */
export function normalizeReleaseTag(refType, tag, ref = undefined) {
  if (refType !== "tag") {
    throw new Error(`github.ref_type must be tag, received ${refType || "<missing>"}`);
  }
  if (
    typeof tag !== "string" ||
    !RELEASE_TAG_PATTERN.test(tag) ||
    tag.match(RELEASE_TAG_PATTERN)?.[0] !== tag
  ) {
    throw new Error(
      `release tag must match ^v[0-9]+\\.[0-9]+\\.[0-9]+$, received ${tag || "<missing>"}`,
    );
  }
  if (ref !== undefined && ref !== `refs/tags/${tag}`) {
    throw new Error(`github.ref does not match the release tag: ${ref || "<missing>"}`);
  }
  return tag.slice(1);
}

/** @param {string} releaseTag @returns {string} */
function releaseNotesPath(releaseTag) {
  return `docs/releases/${releaseTag}.md`;
}

/** @param {string} content @param {string} source @returns {string} */
function firstMarkdownHeading(content, source) {
  const text = requireText(content, source);
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(MARKDOWN_HEADING_PATTERN);
    if (match !== null) {
      return requireText(match[1], source).trim();
    }
  }
  throw new Error(`${source}: first Markdown heading is missing`);
}

/**
 * @param {string | undefined | null} content
 * @param {string} releaseTag
 * @param {string} [source]
 * @returns {string}
 */
export function validateReleaseNotes(content, releaseTag, source = releaseNotesPath(releaseTag)) {
  if (typeof releaseTag !== "string" || !RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error(`release notes tag is invalid: ${releaseTag || "<missing>"}`);
  }
  if (content === undefined || content === null) {
    throw new Error(`${source}: release notes file is missing`);
  }

  const heading = firstMarkdownHeading(content, source);
  const escapedTag = releaseTag.replaceAll(".", "\\.");
  const tagPattern = new RegExp(`(?:^|[^0-9A-Za-z])${escapedTag}(?:$|[^0-9A-Za-z])`, "u");
  if (!tagPattern.test(heading)) {
    throw new Error(`${source}: first heading must contain ${releaseTag}`);
  }
  return requireText(content, source);
}

/** @param {ReleaseInputs} inputs @returns {{tagVersion: string, versions: Record<string, string>}} */
export function compareReleaseVersions(inputs) {
  const {
    refType,
    tag,
    ref,
    packageJson,
    packageLock,
    tauriConfig,
    cargoToml,
    cargoLock,
    releaseNotes,
  } = inputs;
  const tagVersion = normalizeReleaseTag(refType, tag, ref);
  const releaseTag = `v${tagVersion}`;
  validateReleaseNotes(releaseNotes, releaseTag);
  const packageLockVersions = extractPackageLockVersions(packageLock);
  const versions = {
    "package.json": extractPackageJsonVersion(packageJson),
    "package-lock.json": packageLockVersions.topLevelVersion,
    'package-lock.json packages[""]': packageLockVersions.rootPackageVersion,
    "src-tauri/tauri.conf.json": extractTauriVersion(tauriConfig),
    "src-tauri/Cargo.toml": extractCargoTomlVersion(cargoToml),
    "src-tauri/Cargo.lock": extractCargoLockRootVersion(cargoLock),
  };
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== tagVersion)
    .map(([source, version]) => `${source}=${version}`);

  if (mismatches.length > 0) {
    throw new Error(`release version mismatch: tag=${tagVersion}; ${mismatches.join(", ")}`);
  }

  return { tagVersion, versions };
}

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

export function runSelfTest() {
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
}

/**
 * @param {string} rootDirectory
 * @returns {{
 *   packageJson: string,
 *   packageLock: string,
 *   tauriConfig: string,
 *   cargoToml: string,
 *   cargoLock: string,
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
  };
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
  if (argumentsList.length !== 0) {
    throw new Error("usage: node scripts/check-release-version.mjs [--self-test]");
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
