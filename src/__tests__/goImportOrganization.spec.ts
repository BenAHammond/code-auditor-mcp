/**
 * Spec-49 — Go `import-organization` (order #7 remainder, ledger row 16).
 *
 * The old predicate was `if len(file.Imports) > 10` — a raw import *count*
 * standing in for "import organization". The authenticity ledger's `gap` column
 * says the real signal is "stdlib vs third-party vs project grouping and
 * unnecessary deps". Count is not that signal: a file with 12 imports is not
 * unorganized, and a file with 2 imports can be unorganized.
 *
 * "Unnecessary deps" is out of scope — the Go compiler already rejects unused
 * imports at build time, so a static analyzer adds no signal there. The
 * bridgeable, honest reading is **grouping**: Go convention (goimports/gofmt)
 * requires standard-library imports first, then third-party, then local, each
 * block sorted. A stdlib import appearing *after* a third-party import is the
 * unambiguous "mixed-up imports" case a reviewer actually flags.
 *
 * The replacement predicate: classify each import path by its first segment —
 * stdlib (no `.`), third-party (has `.`), local (starts `.`/`..`) — and fire when
 * the group sequence is not non-decreasing (a later-group import precedes an
 * earlier-group one). The count threshold is removed outright.
 *
 * These tests spawn the real Go binary.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

const goDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'languages', 'go');
const binaryPath = join(goDir, 'analyzer');

interface GoViolation {
  rule?: string;
  message?: string;
}

/** Rebuild the analyzer binary from source so the test exercises current code. */
async function ensureBinaryFresh(): Promise<void> {
  try {
    await execFileAsync('go', ['build', '-o', 'analyzer', 'main.go'], { cwd: goDir });
  } catch {
    // No Go toolchain — fall through to the committed binary below.
  }
}

function analyzeContent(content: string, analyzers: string[] = ['imports']): Promise<GoViolation[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd: goDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(new Error(`Failed to spawn Go analyzer: ${err}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Go analyzer exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        const response = JSON.parse(lines[lines.length - 1]);
        if (response.error) throw new Error(`Go analyzer error: ${response.error.message}`);
        resolve((response.result.violations ?? []) as GoViolation[]);
      } catch (err) {
        reject(new Error(`Failed to parse Go analyzer response: ${err}`));
      }
    });
    child.stdin.write(
      JSON.stringify({
        method: 'analyzeContent',
        params: { file: 'snippet.go', content, options: { analyzers } },
        id: 1,
      }) + '\n',
    );
    child.stdin.end();
  });
}

beforeAll(async () => {
  await ensureBinaryFresh();
}, 60_000);

/** Third-party import precedes stdlib imports — the grouped-order violation. */
const UNORGANIZED = `package main

import (
	"github.com/gin-gonic/gin"
	"fmt"
	"strings"
)
`;

/** 12 imports, but stdlib first (sorted) then third-party — organized, over the
 *  old >10 count threshold. */
const ORGANIZED_MANY = `package main

import (
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"gopkg.in/yaml.v2"
)
`;

/** Only 2 imports, but stdlib after third-party — unorganized despite the count
 *  being tiny. */
const FEW_UNORGANIZED = `package main

import (
	"github.com/gin-gonic/gin"
	"fmt"
)
`;

/** A dot import — the honest `import-style` check must survive unchanged. */
const DOT_IMPORT = `package main

import (
	. "fmt"
)
`;

describe('Go import-organization — grouping, not count', () => {
  it('flags mis-grouped imports (third-party before stdlib) under import-organization (positive)', async () => {
    const vs = await analyzeContent(UNORGANIZED);
    const org = vs.filter((v) => v.rule === 'import-organization');
    expect(org.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag 12 well-grouped imports — count is not the signal (near-miss)', async () => {
    const vs = await analyzeContent(ORGANIZED_MANY);
    const org = vs.filter((v) => v.rule === 'import-organization');
    expect(org).toHaveLength(0);
  });

  it('flags a 2-import file with stdlib-after-third-party — grouping is the signal (inverse near-miss)', async () => {
    const vs = await analyzeContent(FEW_UNORGANIZED);
    const org = vs.filter((v) => v.rule === 'import-organization');
    expect(org.length).toBeGreaterThanOrEqual(1);
  });

  it('still flags dot imports under import-style — honest check untouched (sanity)', async () => {
    const vs = await analyzeContent(DOT_IMPORT);
    const style = vs.filter((v) => v.rule === 'import-style');
    expect(style.length).toBeGreaterThanOrEqual(1);
  });

  it('does not resurrect a retired count category (rename guard)', async () => {
    for (const code of [ORGANIZED_MANY, UNORGANIZED]) {
      const vs = await analyzeContent(code);
      const retired = vs.filter(
        (v) => v.rule === 'import-count' || v.rule === 'many-imports',
      );
      expect(retired).toHaveLength(0);
    }
  });
});
