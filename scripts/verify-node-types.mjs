#!/usr/bin/env node
/**
 * verify-node-types.mjs — the node-type string-literal gate.
 *
 * Every string literal in `src/` that is *compared against a tree-sitter node
 * type* must exist in the shipped grammars' `node-types.json`. A literal that
 * is compared but is not a real grammar type is a dead branch: the guarded
 * `if`/`case` never fires and the analyzer silently misses the construct it was
 * written to see (the exact class of defect in docs/node-type-audit.md Tier A).
 *
 * There is no hand-maintained allowlist. The authoritative vocabulary is read
 * live from the five shipped grammars:
 *
 *   tree-sitter-typescript/{typescript,tsx}, tree-sitter-go, tree-sitter-css,
 *   tree-sitter-scss
 *
 * (`.js`/`.jsx` parse with the `typescript` grammar; there is no separate
 * `javascript` grammar — see parser.ts.)
 *
 * Detection is syntactic — the *positions* a node type is compared in — not a
 * curated name list:
 *
 *   1. `X.type === 'literal'` / `'literal' === X.type`            (`.type` accessor)
 *   2. `getNodeType(X) === 'literal'` / reverse                   (explicit type read)
 *   3. `case 'literal':` inside `switch (<node-type expr>) { … }`  (switch over
 *      `.type`, `getNodeType(…)`, or a parameter literally named `type` — not
 *      `switch (action)`/`switch (caseName)` enum switches)
 *   4. `findChildOfType(…, 'literal')` & the other node-type helpers
 *   5. a `*Type`/`type`/`kind` local compared to `'literal'`       (a variable
 *      holding `node.type`, e.g. `nodeType === 'template_literal'`)
 *   6. elements of a `new Set([…])` of snake_case literals         — only Sets
 *      that are node-type collections: named `*TYPE*`/`*NODE*`, or used as
 *      `NAME.has(x.type)` / `NAME.has(getNodeType(…))`
 *
 * A candidate is a snake_case identifier `[a-z][a-z0-9_]*`. Anything else
 * (paths, messages, prose, `'type'`/`'value'` enum strings in a *member*
 * comparison like `usage.type === 'value'`) is out of scope by construction.
 *
 * The `src/languages/sql/` and `src/languages/json/` trees are skipped: their
 * "node types" come from `node-sql-parser` and a hand-rolled JSON walker, not
 * from the shipped tree-sitter grammars, so they are not in the vocabulary this
 * gate checks against (JsonAdapter.ts documents the absence of a JSON grammar).
 *
 * Exit 0 iff no compared literal is absent from the grammar union; exit 1 with
 * a `file:line — 'name'` line per offender otherwise.
 *
 * Usage (from app/):  node scripts/verify-node-types.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const GRAMMAR_PKGS = [
  'tree-sitter-typescript/typescript/package.json',
  'tree-sitter-typescript/tsx/package.json',
  'tree-sitter-go/package.json',
  'tree-sitter-css/package.json',
  'tree-sitter-scss/package.json',
];

/** The live union of every named node type in the shipped grammars. */
function loadValidTypes() {
  const valid = new Set();
  for (const spec of GRAMMAR_PKGS) {
    const pkgPath = require.resolve(spec);
    const ntPath = join(dirname(pkgPath), 'src', 'node-types.json');
    const entries = JSON.parse(readFileSync(ntPath, 'utf8'));
    for (const e of entries) valid.add(e.type);
  }
  return valid;
}

/** Recursively collect `*.ts` / `*.tsx` files under `src/`. */
function collectFiles(dir, srcRoot) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    if (ent.isDirectory()) {
      // Non-tree-sitter vocabularies — skip (see header).
      const rel = relative(srcRoot, full);
      if (rel === join('languages', 'sql') || rel === join('languages', 'json')) continue;
      out.push(...collectFiles(full, srcRoot));
    } else if (/\.(ts|tsx)$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

const IDENT = '[a-z][a-z0-9]*_[a-z0-9_]*';
// A local name that holds a node type: `nodeType`, `childType`, `myKind`,
// or a bare parameter literally named `type` / `kind`.
const TYPEVAR = '(?:[A-Za-z_$][\\w$]*(?:[Tt]ype|kind)|type|kind)';

/**
 * Regexes that capture a snake_case string literal in a node-type position.
 * Each has one capture group (or `group` overrides which): the literal's text.
 */
const PATTERNS = [
  // 1. `.type === 'x'` / `.type !== 'x'` / `.type == 'x'` / `.type != 'x'`
  { re: new RegExp(`\\.type\\s*[!=]==?\\s*['"](${IDENT})['"]`, 'g'), name: '.type' },
  // 1b. `'x' === foo.type`
  { re: new RegExp(`['"](${IDENT})['"]\\s*[!=]==?\\s*[A-Za-z_$][\\w$]*\\.type\\b`, 'g'), name: 'rev.type' },
  // 2. `getNodeType(...) === 'x'` / reverse
  { re: new RegExp(`getNodeType\\([^)]*\\)\\s*[!=]==?\\s*['"](${IDENT})['"]`, 'g'), name: 'getNodeType' },
  { re: new RegExp(`['"](${IDENT})['"]\\s*[!=]==?\\s*getNodeType\\(`, 'g'), name: 'rev.getNodeType' },
  // 4. node-type helper second argument
  {
    re: new RegExp(
      `\\b(?:findChildOfType|findNodes|findChild|childOfType|findChildOf|findFirstChild|findDescendant|hasChildOfType|findLastChild|findSibling|nodeOfType)\\s*\\([^,)]*,\\s*['"](${IDENT})['"]`,
      'g',
    ),
    name: 'helper',
  },
  // 5. `*Type`/`type`/`kind` local === 'x'
  {
    re: new RegExp(`\\b(${TYPEVAR})\\s*[!=]==?\\s*['"](${IDENT})['"]`, 'g'),
    name: 'typevar',
    group: 2,
  },
  {
    re: new RegExp(`['"](${IDENT})['"]\\s*[!=]==?\\s*(${TYPEVAR})\\b`, 'g'),
    name: 'rev.typevar',
    group: 1,
  },
];

// 3. `switch (<node-type expr>) { case 'x': … }` — the discriminant must be a
//    node-type read (`.type`, `getNodeType(…)`, or a bare `type` parameter),
//    which is what separates `switch (node.type)` from `switch (action)`.
const SWITCH_RE = /\bswitch\s*\(([^()]*)\)\s*\{/g;
const CASE_RE = new RegExp(`\\bcase\\s+['"](${IDENT})['"]\\s*:`, 'g');

// 6. `NAME = new Set([…])` — validate only node-type collections (see header).
const SET_DECL_RE =
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\)/g;
const SET_ELEM_RE = new RegExp(`['"](${IDENT})['"]`, 'g');

/** Line number (1-based) of `index` in `text`. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function isNodeTypeDiscriminant(d) {
  const t = d.trim();
  if (t === 'type') return true;
  if (/\.type\b/.test(t)) return true;
  if (/getNodeType/.test(t)) return true;
  return false;
}

/** Index of the `}` matching the `{` at `openIndex`. */
function matchingBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** True when a `new Set` named `name` is a node-type collection. */
function isNodeTypeSet(name, text) {
  if (/TYPE|NODE/i.test(name)) return true;
  return new RegExp(
    `\\b${name}\\.has\\(\\s*[^)]*\\.type\\b|\\b${name}\\.has\\(\\s*getNodeType\\b`,
  ).test(text);
}

function scanFile(file, valid, offenders, cwd) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(cwd, file);

  for (const { re, group = 1 } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const literal = m[group];
      if (!valid.has(literal)) {
        offenders.push({ file: rel, line: lineOf(text, m.index), literal });
      }
    }
  }

  // switch-scoped `case` detection
  SWITCH_RE.lastIndex = 0;
  let sm;
  while ((sm = SWITCH_RE.exec(text)) !== null) {
    if (!isNodeTypeDiscriminant(sm[1])) continue;
    const openBrace = sm.index + sm[0].length - 1;
    const closeBrace = matchingBrace(text, openBrace);
    const body = text.slice(openBrace + 1, closeBrace);
    CASE_RE.lastIndex = 0;
    let cm;
    while ((cm = CASE_RE.exec(body)) !== null) {
      const literal = cm[1];
      if (!valid.has(literal)) {
        offenders.push({
          file: rel,
          line: lineOf(text, openBrace + 1 + cm.index),
          literal,
        });
      }
    }
  }

  // node-type `new Set([…])` detection
  SET_DECL_RE.lastIndex = 0;
  let dm;
  while ((dm = SET_DECL_RE.exec(text)) !== null) {
    const name = dm[1];
    const body = dm[2];
    if (!isNodeTypeSet(name, text)) continue;
    const bodyStart = dm.index + dm[0].indexOf(body);
    SET_ELEM_RE.lastIndex = 0;
    let em;
    while ((em = SET_ELEM_RE.exec(body)) !== null) {
      const literal = em[1];
      if (!valid.has(literal)) {
        offenders.push({
          file: rel,
          line: lineOf(text, bodyStart + em.index),
          literal,
        });
      }
    }
  }
}

function main() {
  const valid = loadValidTypes();
  const cwd = process.cwd();
  const srcRoot = join(cwd, 'src');
  if (!existsSync(srcRoot)) {
    console.error('src/ not found — run from app/');
    process.exit(2);
  }
  const files = collectFiles(srcRoot, srcRoot);
  const offenders = [];
  for (const file of files) scanFile(file, valid, offenders, cwd);

  // De-duplicate: the same literal+line+file can be captured by two patterns.
  const seen = new Set();
  const unique = offenders.filter((o) => {
    const k = `${o.file}:${o.line}:${o.literal}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (unique.length === 0) {
    console.log(`verify-node-types: ${files.length} files scanned, 0 dead node-type literals.`);
    process.exit(0);
  }

  console.error(`verify-node-types: ${unique.length} dead node-type literal(s):`);
  for (const o of unique) {
    console.error(`  ${o.file}:${o.line} — '${o.literal}'`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
