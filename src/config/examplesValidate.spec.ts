import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './configLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Spec 61 R1.5 — the shipped example configs must actually validate. Before
 * `validateConfig` ran in the load path (criterion 4), `examples/*.auditrc.json`
 * could carry pre-recalibration values (`minSeverity: 'suggestion'`, the
 * `component` analyzer name) and still "work" because nobody read the bad value.
 * Now a bad value throws, so this test loads every shipped example config
 * exactly as a user would and asserts it resolves. A stale value here is a hard
 * failure, not a documentation nit.
 */

function shippedConfigFiles(): Array<{ file: string; projectRoot: string }> {
  const examplesDir = path.resolve(__dirname, '..', '..', 'examples');
  const configsDir = path.resolve(__dirname, '..', '..', 'configs');

  const files: Array<{ file: string; projectRoot: string }> = [];
  for (const name of fs.readdirSync(examplesDir)) {
    // `.auditrc.json`, `.auditrc.example.json`, `nextjs.auditrc.json`, etc.
    // (`.auditrc.example.json` does not end in `.auditrc.json`, so match on the
    // `.auditrc` stem rather than the suffix).
    if (name.includes('.auditrc') && name.endsWith('.json')) {
      files.push({ file: path.join(examplesDir, name), projectRoot: examplesDir });
    }
  }
  // hhra-compat ships in `configs/` (same `files` glob as `examples/`); its
  // includePaths are relative to the config file's own directory.
  files.push({ file: path.join(configsDir, 'hhra-compat.json'), projectRoot: configsDir });

  return files.sort((a, b) => a.file.localeCompare(b.file));
}

describe('shipped example configs validate under loadConfig (Spec 61 R1.5)', () => {
  const configs = shippedConfigFiles();

  it('discovers the shipped example configs', () => {
    expect(configs.length).toBeGreaterThanOrEqual(6);
  });

  for (const { file, projectRoot } of configs) {
    it(`${path.basename(file)} loads and validates`, async () => {
      await expect(loadConfig({ configPath: file, projectRoot })).resolves.toBeTruthy();
    });
  }
});
