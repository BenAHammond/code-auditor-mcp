/**
 * Spec 44 — the Go-routing decision must match discovery's view of "are there
 * source `.go` files". A `.go` file buried in a dependency's `node_modules`
 * must NOT route a pure-TS project through the Go subprocess (which drops every
 * non-Go analyzer). Regression guard for the discovery-backed dispatch: the
 * language grouping reads `discoverFiles`, whose excluded-dir set skips
 * `node_modules`/`dist`/`.git`, so a dependency's `.go` file never reaches the
 * router's `go` group.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'node:os';
import path from 'node:path';
import { discoverAndGroupFiles } from '../auditRouter.js';

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-router-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

describe('discoverAndGroupFiles', () => {
  it('groups a .go file at the target root under go', async () => {
    await reset();
    await fs.writeFile(path.join(dir, 'main.go'), 'package main\n');
    const groups = await discoverAndGroupFiles(dir);
    expect(groups['go']).toContain(path.join(dir, 'main.go'));
  });

  it('does not group a .go file under node_modules', async () => {
    await reset();
    await fs.mkdir(path.join(dir, 'node_modules', 'flatted', 'golang'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'flatted', 'golang', 'flatted.go'), 'package flatted\n');
    await fs.writeFile(path.join(dir, 'index.ts'), 'export const x = 1;\n');
    const groups = await discoverAndGroupFiles(dir);
    expect(groups['go'] ?? []).toEqual([]);
    expect(groups['typescript']).toContain(path.join(dir, 'index.ts'));
  });

  it('has no go group when there are no .go files at all', async () => {
    await reset();
    await fs.writeFile(path.join(dir, 'index.ts'), 'export const x = 1;\n');
    const groups = await discoverAndGroupFiles(dir);
    expect(groups['go']).toBeUndefined();
    expect(groups['typescript']).toContain(path.join(dir, 'index.ts'));
  });

  it('groups mixed TypeScript and Go files by language', async () => {
    await reset();
    await fs.writeFile(path.join(dir, 'index.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(dir, 'main.go'), 'package main\n');
    const groups = await discoverAndGroupFiles(dir);
    expect(groups['typescript']).toContain(path.join(dir, 'index.ts'));
    expect(groups['go']).toContain(path.join(dir, 'main.go'));
  });
});
