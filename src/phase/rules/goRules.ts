/**
 * Spec 68 §9 — the five Go non-SOLID rules, migrated to `analyze(ctx)`.
 *
 * These were the `imports` / `errors` / `goroutines` / `channels` arms of the Go
 * subprocess (analyzer-src/analyzer.go). Each re-homes the subprocess's *verdict*
 * — the pure predicate over its extracted inputs — onto a plain-data fact the
 * corresponding §9 producer built where the AST still lived:
 *
 *   - `import-organization` reads `imports` (the `alias`-carrying Go arm) and
 *     re-runs `firstImportGroupViolation` (stdlib 0 / third-party 1 / local 2,
 *     one finding per file at the first out-of-group import);
 *   - `import-style` reads `imports` and re-runs the dot-import filter
 *     (`alias === '.'`, one finding per dot import);
 *   - `error-handling` reads `error-bindings` and re-runs `functionDropsError`
 *     (an `err` binding whose next use is a reassignment, not a check);
 *   - `concurrency` reads `concurrency-primitives` and re-runs
 *     `analyzeConcurrency` (`hasGo && !hasSync`);
 *   - `channel-deadlock` reads `channel-operations` and re-runs
 *     `deadlockChannel` (no `go` and an unbuffered channel with >= 2 ops).
 *
 * No AST, no adapter, no subprocess reaches a rule. Severities and messages are
 * hardcoded here: the Go binary never consulted a TS config key, and the registry
 * entry carries no `severity` (the subprocess chose it) — so these definitions,
 * not `META`, own them. The emitted messages are the Go binary's verbatim text;
 * the `message`/`docs`/`thresholds`/`samples` metadata is pulled from the
 * registry by reference so the two cannot drift before §15 folds it in.
 */

import type {
  RuleDefinition,
  Finding,
  ImportFact,
  ErrorBindingsFact,
  ConcurrencyPrimitivesFact,
  ChannelOperationsFact,
} from '../types.js';
import type { Severity } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

const META = RULE_REGISTRY;

/** The `imports`-reading rules share one needs declaration (Go only — the TS
 *  `imports` fact serves `duplicate-import`, not these). */
type ImportNeeds = {
  readonly formats: readonly ['go'];
  readonly facts: readonly ['imports'];
};

type ErrorBindingsNeeds = {
  readonly formats: readonly ['go'];
  readonly facts: readonly ['error-bindings'];
};

type ConcurrencyNeeds = {
  readonly formats: readonly ['go'];
  readonly facts: readonly ['concurrency-primitives'];
};

type ChannelNeeds = {
  readonly formats: readonly ['go'];
  readonly facts: readonly ['channel-operations'];
};

/** A finding at column 0 — the Go binary never sets a column, so findings pin
 *  `(file, line, column=0, rule, severity)`. */
function finding(
  ruleId: string,
  severity: Severity,
  message: string,
  file: string,
  line: number,
  symbol: string | undefined,
): Finding {
  return { ruleId, severity, message, file, line, column: 0, symbol };
}

/** The Go binary's `importGroup`: 0 stdlib, 1 third-party, 2 local. */
function importGroup(path: string): number {
  if (path.startsWith('.')) return 2;
  const first = path.includes('/') ? path.slice(0, path.indexOf('/')) : path;
  return first.includes('.') ? 1 : 0;
}

// ── import-organization ─────────────────────────────────────────────────────

const importOrganization: RuleDefinition<ImportNeeds> = {
  id: 'import-organization',
  needs: { formats: ['go'], facts: ['imports'] },
  severity: 'high',
  message: META['import-organization'].message,
  docs: META['import-organization'].docs,
  thresholds: META['import-organization'].thresholds,
  thresholdRationale: META['import-organization'].thresholdRationale,
  samples: META['import-organization'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    // `firstImportGroupViolation` runs per file: reset the max-group scan for
    // each file and flag the first import that breaks the non-decreasing order.
    //
    // The `imports` fact is shared with the TS `duplicate-import` rule (a mixed
    // corpus concatenates both producers' output). This rule is Go-only: a Go
    // import always carries `alias` (null for an unnamed import, `.`/a name/`_`
    // otherwise), while the TS producer leaves it absent — so `alias !==
    // undefined` is the Go discriminator and TS imports are skipped here.
    const byFile = new Map<string, ImportFact[]>();
    for (const imp of ctx.facts['imports']) {
      if (imp.alias === undefined) continue; // TS import — not this rule's format
      const list = byFile.get(imp.file) ?? [];
      list.push(imp);
      byFile.set(imp.file, list);
    }
    for (const [, imports] of byFile) {
      let maxGroup = -1;
      let firstViolation: ImportFact | undefined;
      for (const imp of imports) {
        const g = importGroup(imp.source);
        if (g > maxGroup) {
          maxGroup = g;
        } else if (g < maxGroup) {
          if (!firstViolation) firstViolation = imp;
        }
      }
      if (firstViolation) {
        out.push(finding(
          'import-organization', 'high',
          'Import block mixes standard library and third-party imports without grouping',
          firstViolation.file, firstViolation.line, undefined,
        ));
      }
    }
    return out;
  },
};

// ── import-style ────────────────────────────────────────────────────────────

const importStyle: RuleDefinition<ImportNeeds> = {
  id: 'import-style',
  needs: { formats: ['go'], facts: ['imports'] },
  severity: 'high',
  message: META['import-style'].message,
  docs: META['import-style'].docs,
  thresholds: META['import-style'].thresholds,
  thresholdRationale: META['import-style'].thresholdRationale,
  samples: META['import-style'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const imp of ctx.facts['imports']) {
      // `alias === '.'` is the dot-import signal; a TS import carries no
      // `alias` (`undefined`), so it is skipped along with every non-dot Go name.
      if (imp.alias !== '.') continue;
      out.push(finding(
        'import-style', 'high',
        'Dot import detected - can lead to namespace pollution',
        imp.file, imp.line, undefined,
      ));
    }
    return out;
  },
};

// ── error-handling ──────────────────────────────────────────────────────────

const errorHandling: RuleDefinition<ErrorBindingsNeeds> = {
  id: 'error-handling',
  needs: { formats: ['go'], facts: ['error-bindings'] },
  severity: 'severe',
  message: META['error-handling'].message,
  docs: META['error-handling'].docs,
  thresholds: META['error-handling'].thresholds,
  thresholdRationale: META['error-handling'].thresholdRationale,
  samples: META['error-handling'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const fn of ctx.facts['error-bindings']) {
      const assigns = [...fn.assignPositions].sort((a, b) => a - b);
      const checks = [...fn.checkPositions].sort((a, b) => a - b);
      let drops = false;
      for (let i = 0; i < assigns.length; i++) {
        const assign = assigns[i];
        const upper = i + 1 < assigns.length ? assigns[i + 1] : Infinity;
        let handled = false;
        for (const check of checks) {
          if (check > assign && check < upper) {
            handled = true;
            break;
          }
        }
        if (!handled) {
          drops = true;
          break;
        }
      }
      if (drops) {
        out.push(finding(
          'error-handling', 'severe',
          'Function assigns an error that is never checked, returned, or propagated',
          fn.file, fn.line, fn.name,
        ));
      }
    }
    return out;
  },
};

// ── concurrency ─────────────────────────────────────────────────────────────

const concurrency: RuleDefinition<ConcurrencyNeeds> = {
  id: 'concurrency',
  needs: { formats: ['go'], facts: ['concurrency-primitives'] },
  severity: 'severe',
  message: META['concurrency'].message,
  docs: META['concurrency'].docs,
  thresholds: META['concurrency'].thresholds,
  thresholdRationale: META['concurrency'].thresholdRationale,
  samples: META['concurrency'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const fn of ctx.facts['concurrency-primitives']) {
      if (!fn.hasGo || fn.hasSync) continue;
      out.push(finding(
        'concurrency', 'severe',
        'Function launches a goroutine without synchronization',
        fn.file, fn.line, fn.name,
      ));
    }
    return out;
  },
};

// ── channel-deadlock ────────────────────────────────────────────────────────

const channelDeadlock: RuleDefinition<ChannelNeeds> = {
  id: 'channel-deadlock',
  needs: { formats: ['go'], facts: ['channel-operations'] },
  severity: 'critical',
  message: META['channel-deadlock'].message,
  docs: META['channel-deadlock'].docs,
  thresholds: META['channel-deadlock'].thresholds,
  thresholdRationale: META['channel-deadlock'].thresholdRationale,
  samples: META['channel-deadlock'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const fn of ctx.facts['channel-operations']) {
      // A `go` statement makes the deadlock unprovable (the counterpart could
      // live in the spawned goroutine), so the function is cleared.
      if (fn.hasGo) continue;
      for (const name of fn.unbuffered) {
        if ((fn.ops[name] ?? 0) >= 2) {
          out.push(finding(
            'channel-deadlock', 'critical',
            'Guaranteed deadlock: unbuffered channel is both sent to and received from in the same goroutine',
            fn.file, fn.line, fn.name,
          ));
          break;
        }
      }
    }
    return out;
  },
};

export const goRules: readonly RuleDefinition<any>[] = [
  importOrganization,
  importStyle,
  errorHandling,
  concurrency,
  channelDeadlock,
];
