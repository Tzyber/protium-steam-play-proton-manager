import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/u;
const HEADING_RE = /^\s{0,3}#{1,6}[ \t]+(.+?)\s*$/u;

/** @param {unknown} v @param {string} src @returns {Record<string, unknown>} */
function asObj(v, src) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${src}: expected object`);
  }
  return /** @type {Record<string, unknown>} */ (v);
}

/** @param {unknown} v @param {string} src @param {string} field @returns {string} */
function reqStr(v, src, field = "version") {
  if (typeof v !== "string" || v.length === 0 || v.trim() !== v) {
    throw new Error(`${src}: invalid ${field}`);
  }
  return v;
}

/** @param {string} root @param {string} rel @returns {string} */
function readNonEmpty(root, rel) {
  const text = readFileSync(join(root, rel), "utf8");
  if (text.length === 0) throw new Error(`${rel}: empty file`);
  return text;
}

/** @param {string} text @param {string} field @param {string} src @returns {string} */
function tomlField(text, field, src) {
  const matches = [
    ...text.matchAll(new RegExp(`^\\s*${field}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, "gmu")),
  ];
  if (matches.length !== 1) throw new Error(`${src}: expected one ${field}`);
  return reqStr(matches[0]?.[1], src, field);
}

/** @param {string} root @returns {Record<string, string>} */
function collectVersions(root) {
  const pkgSrc = "package.json";
  const pkgText = readNonEmpty(root, pkgSrc);
  if ((pkgText.match(/"version"\s*:/gu) ?? []).length !== 1)
    throw new Error(`${pkgSrc}: expected one version`);
  const pkg = asObj(JSON.parse(pkgText), pkgSrc);

  const lockSrc = "package-lock.json";
  const lock = asObj(JSON.parse(readNonEmpty(root, lockSrc)), lockSrc);
  const pkgs = asObj(lock.packages, `${lockSrc} packages`);
  const rootPkg = asObj(pkgs[""], `${lockSrc} packages[""]`);
  if (
    reqStr(lock.name, lockSrc, "name") !== "protium" ||
    reqStr(rootPkg.name, `${lockSrc} packages[""]`, "name") !== "protium"
  ) {
    throw new Error(`${lockSrc}: expected protium package names`);
  }

  const tauriSrc = "src-tauri/tauri.conf.json";
  const tauriText = readNonEmpty(root, tauriSrc);
  if ((tauriText.match(/"version"\s*:/gu) ?? []).length !== 1)
    throw new Error(`${tauriSrc}: expected one version`);
  const tauri = asObj(JSON.parse(tauriText), tauriSrc);

  const cargoSrc = "src-tauri/Cargo.toml";
  const cargoLines = readNonEmpty(root, cargoSrc).split(/\r?\n/u);
  const stripHash = (/** @type {string} */ line) => {
    const idx = line.indexOf("#");
    return idx === -1 ? line : line.slice(0, idx);
  };
  const pkgStarts = cargoLines.flatMap((line, idx) =>
    stripHash(line).trim() === "[package]" ? [idx] : [],
  );
  if (pkgStarts.length !== 1 || pkgStarts[0] === undefined)
    throw new Error(`${cargoSrc}: expected one [package]`);
  const restStart = pkgStarts[0] + 1;
  const nextSec = cargoLines.findIndex(
    (line, idx) => idx >= restStart && stripHash(line).trimStart().startsWith("["),
  );
  const cargoPkgText = cargoLines
    .slice(restStart, nextSec === -1 ? cargoLines.length : nextSec)
    .join("\n");

  const lockRsSrc = "src-tauri/Cargo.lock";
  const rsLines = readNonEmpty(root, lockRsSrc).split(/\r?\n/u);
  const blockStarts = rsLines.flatMap((line, idx) =>
    stripHash(line).trim() === "[[package]]" ? [idx] : [],
  );
  const blocks = blockStarts.map((start, idx) =>
    rsLines.slice(start + 1, blockStarts[idx + 1] ?? rsLines.length).join("\n"),
  );
  const protiumBlocks = blocks.filter((block) => tomlField(block, "name", lockRsSrc) === "protium");
  if (protiumBlocks.length !== 1 || protiumBlocks[0] === undefined) {
    throw new Error(`${lockRsSrc}: expected one protium block`);
  }

  const metaSrc = "src-tauri/packaging/com.protium.desktop.metainfo.xml";
  const metaMatch = readNonEmpty(root, metaSrc).match(/<release\s+version="([^"]*)"/u);

  const readmeVersion = (/** @type {string} */ rel, /** @type {string} */ label) => {
    const text = readNonEmpty(root, rel);
    const lineMatches = [...text.matchAll(new RegExp(`^${label}: \`v([^\`]*)\``, "gmu"))];
    if (lineMatches.length !== 1) throw new Error(`${rel}: expected one "${label}" line`);
    const fileMatches = [...text.matchAll(/protium_([0-9][^_\s]*)_amd64/gu)];
    if (fileMatches.length === 0) throw new Error(`${rel}: no protium_<version>_amd64 file name`);
    const fileVersions = [...new Set(fileMatches.map((m) => reqStr(m[1], rel)))].join("|");
    return { line: reqStr(lineMatches[0]?.[1], rel), files: fileVersions };
  };

  const de = readmeVersion("README.md", "aktuelle version");
  const en = readmeVersion("README.en.md", "current version");
  return {
    [pkgSrc]: reqStr(pkg.version, pkgSrc),
    [lockSrc]: reqStr(lock.version, lockSrc),
    [`${lockSrc} packages[""]`]: reqStr(rootPkg.version, `${lockSrc} packages[""]`),
    [tauriSrc]: reqStr(tauri.version, tauriSrc),
    [cargoSrc]: tomlField(cargoPkgText, "version", cargoSrc),
    [lockRsSrc]: tomlField(protiumBlocks[0], "version", lockRsSrc),
    [`${metaSrc} <release>`]: reqStr(metaMatch?.[1], metaSrc),
    "README.md aktuelle version": de.line,
    "README.en.md current version": en.line,
    "README.md protium_*_amd64": de.files,
    "README.en.md protium_*_amd64": en.files,
  };
}

/**
 * Prüft alle Versionsdateien und optional den Release-Tag samt Release-Notes.
 * @param {string} root
 * @param {{ filesOnly?: boolean, env?: Record<string, string | undefined> }} [options]
 * @returns {string}
 */
export function checkReleaseVersion(root, options = {}) {
  const { filesOnly = false, env = process.env } = options;
  const versions = collectVersions(root);
  if (filesOnly) {
    if (new Set(Object.values(versions)).size !== 1) {
      const details = Object.entries(versions)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      throw new Error(`release version mismatch across files: ${details}`);
    }
    const first = Object.values(versions)[0];
    if (!first) throw new Error("no versions collected");
    return first;
  }

  const refType = env.GITHUB_REF_TYPE ?? "";
  if (refType !== "tag")
    throw new Error(`github.ref_type must be tag, got ${refType || "<missing>"}`);
  const ref = env.GITHUB_REF || undefined;
  const tag =
    env.GITHUB_REF_NAME || (ref?.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "");
  if (!TAG_RE.test(tag)) throw new Error(`invalid release tag: ${tag || "<missing>"}`);
  if (ref !== undefined && ref !== `refs/tags/${tag}`) {
    throw new Error(`GITHUB_REF does not match tag: ${ref}`);
  }

  const notesRel = `docs/releases/${tag}.md`;
  const notes = readNonEmpty(root, notesRel);
  const heading = notes
    .split(/\r?\n/u)
    .map((l) => HEADING_RE.exec(l)?.[1]?.trim())
    .find(Boolean);
  if (!heading) throw new Error(`${notesRel}: first Markdown heading is missing`);
  const tagRe = new RegExp(
    `(?:^|[^0-9A-Za-z])${tag.replaceAll(".", "\\.")}(?:$|[^0-9A-Za-z])`,
    "u",
  );
  if (!tagRe.test(heading)) throw new Error(`${notesRel}: first heading must contain ${tag}`);

  const expected = tag.slice(1);
  const bad = Object.entries(versions)
    .filter(([, v]) => v !== expected)
    .map(([k, v]) => `${k}=${v}`);
  if (bad.length > 0)
    throw new Error(`release version mismatch: tag=${expected}; ${bad.join(", ")}`);
  return expected;
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const filesOnly = args.length === 1 && args[0] === "--files-only";
    if (!filesOnly && args.length !== 0) {
      throw new Error("usage: node scripts/check-release-version.mjs [--files-only]");
    }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const version = checkReleaseVersion(root, { filesOnly });
    console.log(`release version ${filesOnly ? "files" : "check"}: ${version}`);
  } catch (err) {
    console.error(
      `release version check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}
