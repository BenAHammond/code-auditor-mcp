/**
 * Version-stamping guard — the build stamps package.json's version into
 * src/version.generated.ts, which the CLI (`--version`) and MCP server read as a
 * compile-time literal. This test fails if the generated file drifts from
 * package.json (a version bump without a rebuild), which is the defect a stale
 * binary once masked by announcing the source tree's newer version while running
 * older analyzer code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.generated.js';
import { PACKAGE_VERSION } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

describe('version stamping (Spec: stale binary reports its true version)', () => {
  it('stamped VERSION equals package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('PACKAGE_VERSION derives from the stamped VERSION (not a runtime read)', () => {
    expect(PACKAGE_VERSION).toBe(VERSION);
  });

  it('stamped VERSION is a semver literal', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
