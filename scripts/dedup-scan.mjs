#!/usr/bin/env node
// read-only dedup scan: codeblock-duplikate + dateipaar-ähnlichkeit.
// keine dependency, nur node builtins. ausgabe als plain text. lauf: npm run dedup
// (manuell, kein CI-gate: die trefferzahl schwankt mit dem umbau und wäre als
// gate nur rauschen). aus dem repo-root starten, die wurzeln sind relativ.
//
// Der block-vergleich normalisiert bewusst (whitespace, strukturklammern,
// kommentare): exakte byte-gleiche blöcke gibt es in diesem repo praktisch
// nicht, die echten wiederholungen sind Fixture-literale und
// boilerplate-muster, die sich in einrückung und umgebung unterscheiden.
// Der lauf ersetzt kein Token-Werkzeug (jscpd), findet aber die Fälle, die
// beim Umbau wirklich stören.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOTS = ["src", "tests", "src-tauri/src"];
const EXTS = new Set([".ts", ".tsx", ".vue", ".rs", ".js", ".mjs"]);
const MIN_BLOCK = Number(process.env.MIN_BLOCK ?? 6); // zeilen pro exaktem duplikat-block
const MIN_SIM = Number(process.env.MIN_SIM ?? 0.55); // jaccard-schwelle für dateipaare
const MIN_FILE_LINES = 12;

/**
 * @typedef {object} Block
 * @property {string} file
 * @property {number} start
 * @property {number} end
 * @property {string} text
 */

/**
 * @typedef {object} Group
 * @property {string[]} repr
 * @property {string} sample
 */

/**
 * @typedef {object} SimilarPair
 * @property {string} a
 * @property {string} b
 * @property {number} sim
 * @property {number} inter
 * @property {number} union
 */

/** @returns {string[]} */
function collect() {
  /** @type {string[]} */
  const files = [];
  for (const root of ROOTS) {
    /** @param {string} dir */
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (name === "target" || name === "node_modules" || name.startsWith(".")) continue;
          walk(p);
        } else if (EXTS.has(extname(name))) {
          files.push(p);
        }
      }
    };
    walk(root);
  }
  return files;
}

/** @param {string} file @returns {string[]} */
function lines(file) {
  return readFileSync(file, "utf8").split(/\r?\n/);
}

/** zeile für den vergleich normalisieren; `null` = strukturkram, zählt nicht.
 *  ohne diesen filter bestehen die treffer nur aus schließenden klammern.
 *  @param {string} raw @returns {string | null} */
function normalizeLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return null;
  // nur klammern/kommas/doppelpunkte: reine struktur, kein inhalt
  if (/^[\][)(}{;,]+$/.test(line)) return null;
  return line.replace(/\s+/g, " ");
}

// Block-duplikate über alle Dateien (auch innerdatei). Verglichen wird auf
// normalisierten Zeilen: eine Zeile gilt als "geteilt", wenn dieselbe
// normalisierte Fassung in mindestens zwei Dateien an einer beliebigen Stelle
// vorkommt. Gemeldet werden maximale Folgen geteilter Zeilen ab MIN_BLOCK:
// ohne Gleitfenster, damit derselbe Fund nicht dutzendfach mit verschobenem
// Start erscheint.
/** @param {string[]} files @returns {Group[]} */
function findBlocks(files) {
  /** @type {Map<string, Set<string>>} */
  const byNormalized = new Map(); // normalisierte zeile -> menge der dateien
  /** @type {Map<string, Array<[string, string]>>} */
  const normalizedByFile = new Map();
  for (const file of files) {
    /** @type {Array<[string, string]>} */
    const entries = [];
    for (const raw of lines(file)) {
      const norm = normalizeLine(raw);
      if (norm === null) continue;
      entries.push([norm, raw]);
      let group = byNormalized.get(norm);
      if (group === undefined) {
        group = new Set();
        byNormalized.set(norm, group);
      }
      group.add(file);
    }
    normalizedByFile.set(file, entries);
  }

  /** @type {Block[]} */
  const out = [];
  for (const [file, entries] of normalizedByFile) {
    /** @type {{start: number, end: number} | null} */
    let run = null;
    const flush = () => {
      if (run && run.end - run.start + 1 >= MIN_BLOCK) {
        const text = entries
          .slice(run.start, run.end + 1)
          .map((entry) => entry[1])
          .join("\n");
        out.push({ file, start: run.start + 1, end: run.end + 1, text });
      }
      run = null;
    };
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined) continue;
      const shared = (byNormalized.get(entry[0])?.size ?? 0) > 1;
      if (shared) {
        if (run) run.end = i;
        else run = { start: i, end: i };
      } else {
        flush();
      }
    }
    flush();
  }

  // gleiche Textstelle aus mehreren Dateien zu einem Fund bündeln
  /** @type {Map<string, Block[]>} */
  const grouped = new Map();
  for (const block of out) {
    const key = block.text;
    let group = grouped.get(key);
    if (group === undefined) {
      group = [];
      grouped.set(key, group);
    }
    group.push(block);
  }
  /** @type {Group[]} */
  const groups = [];
  for (const [text, blocks] of grouped) {
    const blockFiles = new Set(blocks.map((b) => b.file));
    if (blockFiles.size < 2) continue;
    const repr = blocks
      .sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start)
      .map((b) => `${b.file}:${b.start}-${b.end} (${b.end - b.start + 1} z.)`);
    groups.push({ repr, sample: text });
  }
  return groups.sort((a, b) => b.repr.length - a.repr.length);
}

// dateipaar-ähnlichkeit via jaccard über 5er-zeilen-shingles (normiert).
/** @param {string[]} ls @param {number} [k] @returns {Set<string>} */
function shingles(ls, k = 5) {
  /** @type {Set<string>} */
  const set = new Set();
  for (let i = 0; i + k <= ls.length; i++) {
    set.add(
      ls
        .slice(i, i + k)
        .map((l) => l.trim())
        .join("\n"),
    );
  }
  return set;
}

/** @param {string[]} files @returns {SimilarPair[]} */
function findSimilar(files) {
  /** @type {Array<[string, Set<string>]>} */
  const data = [];
  for (const file of files) {
    const fileLines = lines(file);
    if (fileLines.length >= MIN_FILE_LINES) data.push([file, shingles(fileLines)]);
  }
  /** @type {SimilarPair[]} */
  const out = [];
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      const left = data[i];
      const right = data[j];
      if (left === undefined || right === undefined) continue;
      const [fa, sa] = left;
      const [fb, sb] = right;
      let inter = 0;
      for (const s of sa) if (sb.has(s)) inter++;
      const union = sa.size + sb.size - inter;
      if (union === 0) continue;
      const sim = inter / union;
      if (sim >= MIN_SIM)
        out.push({ a: fa, b: fb, sim: Math.round(sim * 100) / 100, inter, union });
    }
  }
  return out.sort((x, y) => y.sim - x.sim);
}

const files = collect().sort();
console.log(`scanned ${files.length} dateien`);

const blocks = findBlocks(files);
console.log(`\n=== exakte block-duplikate (>= ${MIN_BLOCK} zeilen) ===`);
if (blocks.length === 0) console.log("keine gefunden");
for (const g of blocks) {
  console.log(`\n- ${g.repr.join("\n  ")}`);
  console.log(
    `  sample:\n${g.sample
      .split("\n")
      .slice(0, MIN_BLOCK)
      .map((l) => `    ${l}`)
      .join("\n")}`,
  );
}

const similar = findSimilar(files);
console.log(`\n=== dateipaar-ähnlichkeit (jaccard >= ${MIN_SIM}) ===`);
if (similar.length === 0) console.log("keine gefunden");
for (const s of similar) {
  console.log(`${s.sim}  ${s.a}  <->  ${s.b}  (inter ${s.inter}/${s.union})`);
}
