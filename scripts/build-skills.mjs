#!/usr/bin/env node
/**
 * Build the distributed skills directory from the plugin source, stamping the
 * package version into every place that advertises it.
 *
 * The version lives in exactly one place — package.json. Everything else that
 * prints a version (SKILL.md's "Version X.Y.Z" banner, the .code-auditor-version
 * marker) is derived here, so a release bump never has to be hand-copied into
 * multiple files (the "fourth place a version lives" defect).
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// package.json is the single source of truth for the version.
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const version = String(pkg.version || '0.0.0');

const skillSource = path.join(__dirname, '..', 'plugin', 'skills', 'code-auditor');
// `build:skills` reproduces the skills dir one level up (repo-root `skills/`),
// matching the previous `cp -r plugin/skills/* ../skills/` contract.
const skillOutput = path.join(__dirname, '..', '..', 'skills', 'code-auditor');

const VERSION_BANNER = /(Version\s+)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** Replace the "Version X.Y.Z" banner in SKILL.md body with the live version. */
function stamp(markdown) {
  return markdown.replace(VERSION_BANNER, `$1${version}`);
}

const sourceSkill = readFileSync(path.join(skillSource, 'SKILL.md'), 'utf-8');
const stamped = stamp(sourceSkill);

// 1. Stamp the plugin source in place so the npm `files` entry (`plugin/**/*`)
//    ships a SKILL.md that advertises the published version, not a stale one.
writeFileSync(path.join(skillSource, 'SKILL.md'), stamped);

// 2. Reproduce the skills directory, stamped, with companions copied verbatim
//    and a fresh version marker.
mkdirSync(skillOutput, { recursive: true });
writeFileSync(path.join(skillOutput, 'SKILL.md'), stamped);
for (const file of ['SKILL-SEARCH.md', 'SKILL-RULE-KINDS.md']) {
  copyFileSync(path.join(skillSource, file), path.join(skillOutput, file));
}
writeFileSync(path.join(skillOutput, '.code-auditor-version'), `${version}\n`);

process.stdout.write(`build:skills → stamped version ${version}\n`);
