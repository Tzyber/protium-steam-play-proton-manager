#!/usr/bin/env node
// read-only dedup scan: exakte codeblock-duplikate + dateipaar-ähnlichkeit.
// keine dependency, nur node builtins. ausgabe als plain text.

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

// exakte block-duplikate über alle dateien (auch innerdatei).
function findBlocks(files) {
  const map = new Map(); // hash -> [{file, start, lines}]
  const filesLines = files.map((f) => [f, lines(f)]);
  for (const [file, ls] of filesLines) {
    for (let i = 0; i + MIN_BLOCK <= ls.length; i++) {
      const block = ls.slice(i, i + MIN_BLOCK);
      const norm = block.map((l) => l.trim()).join("\n");
      if (!norm.trim()) continue;
      let key = 0;
      for (let c = 0; c < norm.length; c++) key = (key * 31 + norm.charCodeAt(c)) >>> 0;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ file, start: i + 1, text: block.join("\n") });
    }
  }
  const groups = [];
  for (const hits of map.values()) {
    // nur gruppen mit mehr als einem fund und mindestens zwei verschiedenen stellen
    const seen = new Set(hits.map((h) => `${h.file}:${h.start}`));
    if (seen.size < 2) continue;
    // zusammenlegen: benachbarte starts in derselben datei sind teil desselben blocks
    const byFile = new Map();
    for (const h of hits) {
      if (!byFile.has(h.file)) byFile.set(h.file, []);
      byFile.get(h.file).push(h);
    }
    let total = 0;
    const repr = [];
    for (const [f, hs] of byFile) {
      hs.sort((a, b) => a.start - b.start);
      let merged = [{ start: hs[0].start, len: 1 }];
      for (let k = 1; k < hs.length; k++) {
        const last = merged[merged.length - 1];
        if (hs[k].start === last.start + last.len) last.len++;
        else merged.push({ start: hs[k].start, len: 1 });
      }
      for (const m of merged) {
        if (m.len < MIN_BLOCK) continue;
        total += m.len;
        repr.push(`${f}:${m.start} (${m.len} z.)`);
      }
    }
    if (total >= MIN_BLOCK && repr.length >= 2) {
      groups.push({ repr, sample: hits[0].text });
    }
  }
  // dedup gleicher gruppen (gleiche repr-menge)
  const out = [];
  const seenKeys = new Set();
  for (const g of groups) {
    const key = [...g.repr].sort().join("|");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(g);
  }
  return out;
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
