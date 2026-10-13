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
 * @property {string} metainfo
 * @property {string} readme
 * @property {string} readmeEn
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

/**
 * @param {unknown} value
 * @param {string} source
 * @param {string} label
 * @returns {string}
 */
function requireField(value, source, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${source}: ${label} extraction is empty or ambiguous`);
  }
  return value;
}

/** @param {unknown} value @param {string} source @returns {string} */
function requireVersion(value, source) {
  return requireField(value, source, "version");
}

/** @param {unknown} value @param {string} source @returns {string} */
function requireName(value, source) {
  return requireField(value, source, "name");
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
function extractPackageJsonVersion(content) {
  return extractJsonVersion(content, "package.json");
}

/**
 * @param {string} content
 * @returns {{topLevelVersion: string, rootPackageVersion: string}}
 */
function extractPackageLockVersions(content) {
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
function extractTauriVersion(content) {
  return extractJsonVersion(content, "src-tauri/tauri.conf.json");
}

/** @param {string} content @returns {string} */
function extractCargoTomlVersion(content) {
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
function extractCargoLockRootVersion(content) {
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

/** @param {string} content @returns {string} */
function extractMetainfoVersion(content) {
  const source = "src-tauri/packaging/com.protium.desktop.metainfo.xml";
  // die releases stehen neueste zuerst; nur der erste eintrag muss passen.
  const match = requireText(content, source).match(/<release\s+version="([^"]*)"/u);
  if (match === null) {
    throw new Error(`${source}: no <release> entry found`);
  }
  return requireVersion(match[1], source);
}

/**
 * @param {string} content
 * @param {string} label
 * @param {string} source
 * @returns {string}
 */
function extractReadmeVersion(content, label, source) {
  const pattern = new RegExp(`^${label}: \`v([^\`]*)\``, "gmu");
  const matches = [...requireText(content, source).matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${source}: expected exactly one "${label}" line`);
  }
  return requireVersion(matches[0]?.[1], source);
}

/** @param {string} content @param {string} source @returns {string} */
function extractReadmeDownloadVersions(content, source) {
  // platzhalter wie protium_<version>_amd64 beginnen nicht mit einer ziffer.
  const matches = [...requireText(content, source).matchAll(/protium_([0-9][^_\s]*)_amd64/gu)];
  if (matches.length === 0) {
    throw new Error(`${source}: no protium_<version>_amd64 file name found`);
  }
  // abweichende dateinamen im selben readme bleiben als liste sichtbar und
  // passen so zu keiner anderen quelle.
  return [...new Set(matches.map((match) => requireVersion(match[1], source)))].join("|");
}

/**
 * @param {Record<string, string | undefined>} environment
 * @returns {{refType: string, ref: string | undefined, tag: string}}
 */
function extractReleaseContext(environment) {
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
function normalizeReleaseTag(refType, tag, ref = undefined) {
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
function validateReleaseNotes(content, releaseTag, source = releaseNotesPath(releaseTag)) {
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
function compareReleaseVersions(inputs) {
  const { refType, tag, ref, releaseNotes } = inputs;
  const tagVersion = normalizeReleaseTag(refType, tag, ref);
  const releaseTag = `v${tagVersion}`;
  validateReleaseNotes(releaseNotes, releaseTag);
  const versions = collectFileVersions(inputs);
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== tagVersion)
    .map(([source, version]) => `${source}=${version}`);

  if (mismatches.length > 0) {
    throw new Error(`release version mismatch: tag=${tagVersion}; ${mismatches.join(", ")}`);
  }

  return { tagVersion, versions };
}

/**
 * Versionen aller acht Versionsdateien (elf Quellen) ueber die
 * vorhandenen Extraktoren, ohne tag und release-notes.
 * @param {Omit<ReleaseInputs, "refType" | "tag" | "ref" | "releaseNotes">} inputs
 * @returns {Record<string, string>}
 */
function collectFileVersions(inputs) {
  const packageLockVersions = extractPackageLockVersions(inputs.packageLock);
  return {
    "package.json": extractPackageJsonVersion(inputs.packageJson),
    "package-lock.json": packageLockVersions.topLevelVersion,
    'package-lock.json packages[""]': packageLockVersions.rootPackageVersion,
    "src-tauri/tauri.conf.json": extractTauriVersion(inputs.tauriConfig),
    "src-tauri/Cargo.toml": extractCargoTomlVersion(inputs.cargoToml),
    "src-tauri/Cargo.lock": extractCargoLockRootVersion(inputs.cargoLock),
    "src-tauri/packaging/com.protium.desktop.metainfo.xml <release>": extractMetainfoVersion(
      inputs.metainfo,
    ),
    "README.md aktuelle version": extractReadmeVersion(
      inputs.readme,
      "aktuelle version",
      "README.md",
    ),
    "README.en.md current version": extractReadmeVersion(
      inputs.readmeEn,
      "current version",
      "README.en.md",
    ),
    "README.md protium_*_amd64": extractReadmeDownloadVersions(inputs.readme, "README.md"),
    "README.en.md protium_*_amd64": extractReadmeDownloadVersions(inputs.readmeEn, "README.en.md"),
  };
}

/**
 * @param {Record<string, string>} versions
 * @returns {string}
 */
function assertFileVersionsConsistent(versions) {
  const values = new Set(Object.values(versions));
  if (values.size !== 1) {
    const details = Object.entries(versions)
      .map(([source, version]) => `${source}=${version}`)
      .join(", ");
    throw new Error(`release version mismatch across files: ${details}`);
  }
  return /** @type {string} */ (values.values().next().value);
}

export {
  assertFileVersionsConsistent,
  collectFileVersions,
  compareReleaseVersions,
  extractReleaseContext,
  normalizeReleaseTag,
  releaseNotesPath,
};
