#!/usr/bin/env node
/**
 * Stamp the package version into the distributed SKILL.md before shipping.
 *
 * The version lives in exactly one place — package.json. The SKILL.md
 * "Version X.Y.Z" banner is derived here, so a release bump never has to be
 * hand-copied into the skill file (the "another place a version lives" defect).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// package.json is the single source of truth for the version.
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const version = String(pkg.version || '0.0.0');

const skillSource = path.join(__dirname, '..', 'plugin', 'skills', 'code-auditor');

const VERSION_BANNER = /(Version\s+)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** Replace the "Version X.Y.Z" banner in SKILL.md body with the live version. */
function stamp(markdown) {
  return markdown.replace(VERSION_BANNER, `$1${version}`);
}

const sourceSkill = readFileSync(path.join(skillSource, 'SKILL.md'), 'utf-8');
const stamped = stamp(sourceSkill);

// Stamp the plugin source in place so the npm `files` entry (`plugin/**/*`)
// ships a SKILL.md that advertises the published version, not a stale one.
writeFileSync(path.join(skillSource, 'SKILL.md'), stamped);

process.stdout.write(`build:skills → stamped version ${version}\n`);
