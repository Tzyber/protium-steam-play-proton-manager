#!/usr/bin/env node
// read-only dedup scan: codeblock-duplikate + dateipaar-ähnlichkeit.
// keine dependency, nur node builtins. ausgabe als plain text.
//
// Der block-vergleich normalisiert bewusst (whitespace, strukturklammern,
// kommentare): exakte byte-gleiche blöcke gibt es in diesem repo praktisch
// nicht, die echten wiederholungen sind Fixture-literale und
// boilerplate-muster, die sich in einrückung und umgebung unterscheiden.
// Der lauf ersetzt kein Token-Werkzeug (jscpd), findet aber die Fälle, die
// beim Umbau wirklich stören.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["src", "tests", "src-tauri/src"];
const EXTS = new Set([".ts", ".tsx", ".vue", ".rs", ".js", ".mjs"]);
const MIN_BLOCK = Number(process.env.MIN_BLOCK ?? 6); // zeilen pro exaktem duplikat-block
const MIN_SIM = Number(process.env.MIN_SIM ?? 0.55); // jaccard-schwelle für dateipaare
const MIN_FILE_LINES = 12;

function collect() {
  const files = [];
  for (const root of ROOTS) {
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

function lines(file) {
  return readFileSync(file, "utf8").split(/\r?\n/);
}

/** zeile für den vergleich normalisieren; `null` = strukturkram, zählt nicht.
 *  ohne diesen filter bestehen die treffer nur aus schließenden klammern. */
function normalizeLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return null;
  // nur klammern/kommas/doppelpunkte: reine struktur, kein inhalt
  if (/^[\]\[)(}{;,]+$/.test(line)) return null;
  return line.replace(/\s+/g, " ");
}

// Block-duplikate über alle Dateien (auch innerdatei). Verglichen wird auf
// normalisierten Zeilen: eine Zeile gilt als "geteilt", wenn dieselbe
// normalisierte Fassung in mindestens zwei Dateien an einer beliebigen Stelle
// vorkommt. Gemeldet werden maximale Folgen geteilter Zeilen ab MIN_BLOCK —
// ohne Gleitfenster, damit derselbe Fund nicht dutzendfach mit verschobenem
// Start erscheint.
function findBlocks(files) {
  const byNormalized = new Map(); // normalisierte zeile -> menge der dateien
  const normalizedByFile = new Map();
  for (const file of files) {
    const entries = [];
    for (const raw of lines(file)) {
      const norm = normalizeLine(raw);
      if (norm === null) continue;
      entries.push([norm, raw]);
      if (!byNormalized.has(norm)) byNormalized.set(norm, new Set());
      byNormalized.get(norm).add(file);
    }
    normalizedByFile.set(file, entries);
  }

  const out = [];
  for (const [file, entries] of normalizedByFile) {
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
      const shared = byNormalized.get(entries[i][0]).size > 1;
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
  const grouped = new Map();
  for (const block of out) {
    const key = block.text;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(block);
  }
  const groups = [];
  for (const [text, blocks] of grouped) {
    const files = new Set(blocks.map((b) => b.file));
    if (files.size < 2) continue;
    const repr = blocks
      .sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start)
      .map((b) => `${b.file}:${b.start}-${b.end} (${b.end - b.start + 1} z.)`);
    groups.push({ repr, sample: text });
  }
  return groups.sort((a, b) => b.repr.length - a.repr.length);
}

// dateipaar-ähnlichkeit via jaccard über 5er-zeilen-shingles (normiert).
function shingles(ls, k = 5) {
  const set = new Set();
  for (let i = 0; i + k <= ls.length; i++) {
    set.add(ls.slice(i, i + k).map((l) => l.trim()).join("\n"));
  }
  return set;
}

function findSimilar(files) {
  const data = files
    .map((f) => [f, lines(f)])
    .filter(([, ls]) => ls.length >= MIN_FILE_LINES)
    .map(([f, ls]) => [f, shingles(ls)]);
  const out = [];
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      const [fa, sa] = data[i];
      const [fb, sb] = data[j];
      if (fa === fb) continue;
      let inter = 0;
      for (const s of sa) if (sb.has(s)) inter++;
      const union = sa.size + sb.size - inter;
      if (union === 0) continue;
      const sim = inter / union;
      if (sim >= MIN_SIM) out.push({ a: fa, b: fb, sim: Math.round(sim * 100) / 100, inter, union });
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
  console.log(`  sample:\n${g.sample.split("\n").slice(0, MIN_BLOCK).map((l) => "    " + l).join("\n")}`);
}

const similar = findSimilar(files);
console.log(`\n=== dateipaar-ähnlichkeit (jaccard >= ${MIN_SIM}) ===`);
if (similar.length === 0) console.log("keine gefunden");
for (const s of similar) {
  console.log(`${s.sim}  ${s.a}  <->  ${s.b}  (inter ${s.inter}/${s.union})`);
}
