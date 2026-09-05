/**
 * Spec 44 — the Go-routing decision must match discovery's view of "are there
 * source `.go` files". A `.go` file buried in a dependency's `node_modules`
 * must NOT route a pure-TS project through the Go subprocess (which drops every
 * non-Go analyzer). Regression guard for the `hasFilesWithExtension`
 * node_modules exclusion.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'node:os';
import path from 'node:path';
import { hasFilesWithExtension } from '../auditRouter.js';

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-router-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('hasFilesWithExtension', () => {
  it('returns true when a .go file sits at the target root', async () => {
    await fs.writeFile(path.join(dir, 'main.go'), 'package main\n');
    expect(await hasFilesWithExtension(dir, '.go')).toBe(true);
  });

  it('returns false when the only .go file is under node_modules', async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.join(dir, 'node_modules', 'flatted', 'golang'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'flatted', 'golang', 'flatted.go'), 'package flatted\n');
    await fs.writeFile(path.join(dir, 'index.ts'), 'export const x = 1;\n');
    expect(await hasFilesWithExtension(dir, '.go')).toBe(false);
  });

  it('returns false when there are no .go files at all', async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.ts'), 'export const x = 1;\n');
    expect(await hasFilesWithExtension(dir, '.go')).toBe(false);
  });
});
