/**
 * Spec 68 §3.2 vertical slice — the SOLID rules, migrated to `analyze(ctx)`.
 *
 * These were the per-file AST checks inside `UniversalSOLIDAnalyzer`; now they
 * read the `file-symbols` fact (a flat array of function / class / interface
 * symbols with metrics pre-computed at process time) and do pure threshold
 * comparison. No AST, no adapter, no source code reaches a rule — the tree died
 * with the file.
 *
 * Eight TypeScript rules migrate here. The Go size rules are re-declared against
 * the Go facts in §9: `struct-size` and `interface-size`'s Go arm read the
 * `type-declarations` fact (§9); `switch-size`, `function-size` and the Go
 * `liskov-substitution` read the §9 Go facts added in their own slices. The
 * thresholds are the Go binary's hardcoded values (struct 15, interface 10),
 * not the TS config keys (`maxInterfaceMembers` is the TS arm only).
 *
 * `message` / `docs` / `thresholds` / `samples` are the same text the rule
 * registry already carries (ruleRegistry.ts) — pulled by reference so the two
 * cannot drift before §15 folds the registry into these definitions. `severity`
 * and `analyze` are new here; the registry never carried `severity`.
 */

import type {
  RuleDefinition,
  Finding,
  FileSymbols,
  FileFunctionSymbol,
  FileClassSymbol,
  FileInterfaceSymbol,
  FileMethodSymbol,
  ThresholdValues,
  GoFunctionFact,
  GoSwitchFact,
  AnalysisContext,
  ResolutionClass,
} from '../types.js';
import type { Severity, Resolution } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

/** The shared declaration for every TS SOLID rule in this slice. */
function qualifiedMethod(clsName: string, methodName: string): string {
  return `${clsName}.${methodName}`;
}

type SolidNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['file-symbols'];
};

/** The Go-only SOLID size rules read the `type-declarations` fact (§9). */
type GoNeeds = {
  readonly formats: readonly ['go'];
  readonly facts: readonly ['type-declarations'];
};

/** `interface-size` reads both arms: TS symbols + Go type declarations. */
type InterfaceSizeNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript', 'go'];
  readonly facts: readonly ['file-symbols', 'type-declarations'];
};

/** `open-closed` reads the resolution fact's class declarations to resolve an
 *  `instanceof` target's `extends` chain (criterion 7c) alongside the
 *  `file-symbols` fact it fires from. */
type OpenClosedNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['file-symbols', 'resolution'];
};

/** The Go-only function-metric rules (`function-size`, `liskov-substitution`)
 *  read the `go-functions` fact (§9). */
type GoFunctionNeeds = {
  readonly formats: readonly ['go'];
  readonly facts: readonly ['go-functions'];
};

/** The Go-only `switch-size` rule reads the `go-switches` fact (§9). */
type GoSwitchNeeds = {
  readonly formats: readonly ['go'];
  readonly facts: readonly ['go-switches'];
};

/** Read a numeric threshold with a documented fallback (the same value as
 *  `DEFAULT_SOLID_CONFIG`; config resolution proper lands in §10). */
function num(t: ThresholdValues, key: string, fallback: number): number {
  const v = t[key];
  return typeof v === 'number' ? v : fallback;
}

/** The SOLID analyzer's test-file detector — mirrors `UniversalSOLIDAnalyzer`
 *  `isTestFile` exactly. This is deliberately NOT `reachability.isTestFile`:
 *  the SOLID analyzer matched `/test\//` and `/tests\//` as *substrings*, so
 *  `integration-tests/` is a test file here (it contains `tests/`) even though
 *  `reachability.isTestFile` (leading-slash `includes('/tests/')`) does not. */
function isTestFile(filePath: string): boolean {
  const testPatterns = [
    /\.test\.[jt]sx?$/,
    /\.spec\.[jt]sx?$/,
    /__tests__\//,
    /test\//,
    /tests\//,
  ];
  return testPatterns.some((pattern) => pattern.test(filePath));
}

/** Honor the legacy `skipTestFiles` gate (default true): the whole file is
 *  skipped, so drop every symbol in a test/spec file before any TS SOLID rule
 *  iterates. Mirrors `UniversalSOLIDAnalyzer.analyzeAST`'s top-of-file return. */
function visibleSymbols(symbols: readonly FileSymbols[], thresholds: ThresholdValues): FileSymbols[] {
  if (!thresholds['skipTestFiles']) return symbols as FileSymbols[];
  return symbols.filter((s) => !isTestFile(s.file));
}

/** The baseline symbol identity the old analyzer used for a function/method. */
function symbolOf(name: string, line: number, column?: number): string {
  if (name && name !== '<anonymous>') return name;
  return `anonymous@${line}:${column ?? 0}`;
}

/** Every function-like item the size rules iterate: standalone functions and
 *  class methods (whose size findings used the bare method name in the old
 *  analyzer — see UniversalSOLIDAnalyzer.analyzeFunction). */
type FunctionLike = {
  name: string;
  file: string;
  line: number;
  column?: number;
  parameterCount: number;
  parameterNames: string[];
  lineCount: number;
  complexity: number;
  concernGroups: string[];
};

function collectFunctionLikes(symbols: FileSymbols[]): FunctionLike[] {
  const out: FunctionLike[] = [];
  for (const s of symbols) {
    if (s.kind === 'function') {
      out.push(s);
    } else if (s.kind === 'class') {
      for (const m of s.methods) {
        out.push({ name: m.name, file: s.file, line: m.line, column: m.column, parameterCount: m.parameterCount, parameterNames: m.parameterNames, lineCount: m.lineCount, complexity: m.complexity, concernGroups: m.concernGroups });
      }
    }
  }
  return out;
}

/** The function-likes exceeding a numeric threshold, with the resolved max.
 *  `function-length` and `parameter-count` both iterate the same symbol set and
 *  compare one metric (`lineCount` / `parameterCount`) against a threshold key;
 *  only the metric, key, and message/resolution prose differ. */
function collectOversizedFunctionLikes(
  ctx: AnalysisContext<SolidNeeds>,
  thresholdKey: string,
  fallback: number,
  measure: (fn: FunctionLike) => number,
): Array<{ fn: FunctionLike; max: number }> {
  const max = num(ctx.thresholds, thresholdKey, fallback);
  const out: Array<{ fn: FunctionLike; max: number }> = [];
  for (const fn of collectFunctionLikes(visibleSymbols(ctx.facts['file-symbols'], ctx.thresholds))) {
    if (measure(fn) <= max) continue;
    out.push({ fn, max });
  }
  return out;
}

/** A finding with the fields every SOLID rule shares. */
function finding(opts: {
  ruleId: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  column: number | undefined;
  symbol: string | undefined;
  resolution?: Resolution;
}): Finding {
  const { ruleId, severity, message, file, line, column, symbol, resolution } = opts;
  return { ruleId, severity, message, file, line, column, symbol, resolution };
}

/** Build the two size rules (`function-length`, `parameter-count`), which differ
 *  only in the metric, threshold key, message, and resolution. The shared
 *  `RuleDefinition` scaffolding and the `analyze` body (collect oversized
 *  function-likes → `finding`) are identical, so they live here once; each rule
 *  is a `makeSizeRule({ ... })` call carrying only the varying prose. */
function makeSizeRule(spec: {
  id: string;
  thresholdKey: string;
  fallback: number;
  measure: (fn: FunctionLike) => number;
  messageFor: (fn: FunctionLike, max: number) => string;
  resolutionFor: (fn: FunctionLike) => Resolution;
  /** Symbol-level exemptions, keyed by the function/method name, with the reason
   *  each is exempt (recorded so an exemption is a reviewed decision, not a
   *  silent skip). A name is unambiguous enough here: the size rules iterate the
   *  whole corpus, so a collision would be caught in review. */
  exemptions?: Readonly<Record<string, string>>;
}): RuleDefinition<SolidNeeds> {
  const exemptions = spec.exemptions ?? {};
  return {
    id: spec.id,
    analyzer: 'solid',
    needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
    severity: 'high',
    message: META[spec.id].message,
    docs: META[spec.id].docs,
    thresholds: META[spec.id].thresholds,
    thresholdRationale: META[spec.id].thresholdRationale,
    samples: META[spec.id].samples,
    analyze(ctx): Finding[] {
      return collectOversizedFunctionLikes(ctx, spec.thresholdKey, spec.fallback, spec.measure)
        .filter(({ fn }) => !(fn.name in exemptions))
        .map(({ fn, max }) => finding({
          ruleId: spec.id, severity: 'high', message: spec.messageFor(fn, max),
          file: fn.file, line: fn.line, column: fn.column, symbol: symbolOf(fn.name, fn.line, fn.column),
          resolution: spec.resolutionFor(fn),
        }));
    },
  };
}

const META = RULE_REGISTRY;

// ── solid/class-size ────────────────────────────────────────────────────────

const classSize: RuleDefinition<SolidNeeds> = {
  id: 'solid/class-size',
  analyzer: 'solid',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['solid/class-size'].message,
  docs: META['solid/class-size'].docs,
  thresholds: META['solid/class-size'].thresholds,
  thresholdRationale: META['solid/class-size'].thresholdRationale,
  samples: META['solid/class-size'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const methodsThreshold = num(ctx.thresholds, 'classMethodsThreshold', num(ctx.thresholds, 'maxMethodsPerClass', 20));
    const maxAggregate = num(ctx.thresholds, 'classAggregateComplexity', 150);

    for (const s of visibleSymbols(ctx.facts['file-symbols'], ctx.thresholds)) {
      if (s.kind !== 'class') continue;
      const cls = s as FileClassSymbol;
      const line = cls.line;
      const column = cls.column;

      if (cls.methodCount > methodsThreshold) {
        out.push(finding({
          ruleId: 'solid/class-size', severity: 'high',
          message: `Class "${cls.name}" has ${cls.methodCount} methods, exceeding the maximum of ${methodsThreshold}. Consider splitting into smaller classes.`,
          file: cls.file, line, column, symbol: cls.name,
          resolution: {
            action: 'split-class',
            summary: `Split class "${cls.name}" (${cls.methodCount} methods) into smaller classes by extracting a cohesive subset of its methods.`,
            symbols: cls.methods.map((m) => qualifiedMethod(cls.name, m.name)),
            files: [cls.file],
            lines: cls.methods.map((m) => m.line),
          },
        }));
      }

      if (cls.aggregateComplexity > maxAggregate) {
        out.push(finding({
          ruleId: 'solid/class-size', severity: 'high',
          message: `Class "${cls.name}" has aggregate cyclomatic complexity ${cls.aggregateComplexity}, exceeding the maximum of ${maxAggregate}. Consider splitting the class.`,
          file: cls.file, line, column, symbol: cls.name,
          resolution: {
            action: 'split-class',
            summary: `Split class "${cls.name}" (aggregate complexity ${cls.aggregateComplexity}) to move its most-complex methods into a separate class.`,
            symbols: cls.methods.map((m) => qualifiedMethod(cls.name, m.name)),
            files: [cls.file],
            lines: cls.methods.map((m) => m.line),
          },
        }));
      }
    }
    return out;
  },
};

// ── solid/method-complexity ─────────────────────────────────────────────────

const methodComplexity: RuleDefinition<SolidNeeds> = {
  id: 'solid/method-complexity',
  analyzer: 'solid',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['solid/method-complexity'].message,
  docs: META['solid/method-complexity'].docs,
  thresholds: META['solid/method-complexity'].thresholds,
  thresholdRationale: META['solid/method-complexity'].thresholdRationale,
  samples: META['solid/method-complexity'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const max = num(ctx.thresholds, 'maxMethodComplexity', 50);

    for (const s of visibleSymbols(ctx.facts['file-symbols'], ctx.thresholds)) {
      if (s.kind === 'function') {
        const f = s as FileFunctionSymbol;
        if (f.complexity > max) {
          out.push(finding({
            ruleId: 'solid/method-complexity', severity: 'high',
            message: `Function "${f.name}" has cyclomatic complexity ${f.complexity}, exceeding the maximum of ${max}. Consider breaking it into smaller functions.`,
            file: f.file, line: f.line, column: f.column, symbol: symbolOf(f.name, f.line, f.column),
          }));
        }
      } else if (s.kind === 'class') {
        const cls = s as FileClassSymbol;
        for (const m of cls.methods) {
          if (m.complexity > max) {
            out.push(finding({
              ruleId: 'solid/method-complexity', severity: 'high',
              message: `Method "${cls.name}.${m.name}" has cyclomatic complexity ${m.complexity}, exceeding the maximum of ${max}. Consider breaking it into smaller methods.`,
              file: cls.file, line: m.line, column: m.column, symbol: qualifiedMethod(cls.name, m.name),
            }));
          }
        }
      }
    }
    return out;
  },
};

// ── solid/open-closed ───────────────────────────────────────────────────────

/** The built-in error types an `extends` chain can terminate at. A class whose
 *  `extends` resolves (transitively, against repo declarations) to one of these
 *  is an error type, and an `instanceof` against it is a catch-dispatch guard,
 *  not an extensibility (OCP) violation. */
const BUILTIN_ERRORS = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
]);

/** True when `name` is an Error subclass, resolved transitively against the
 *  corpus-wide class declarations in the resolution fact. Resolution is
 *  unique-global (case-insensitive): a name that matches zero or many classes
 *  does not resolve, so a missing or ambiguous declaration is "not an error" and
 *  the `instanceof` still fires — the conservative direction (a missing edge is
 *  safer than a fabricated one). This is NOT a `/Error$/` name test: it walks
 *  the `extends` chain, so a domain class whose name merely ends in "Error" does
 *  not pass, and an error whose name does not (e.g. a custom `extends Error`)
 *  does. */
function isErrorSubclass(name: string, classes: ReadonlyArray<ResolutionClass>): boolean {
  const seen = new Set<string>();
  let current = name;
  while (current) {
    if (BUILTIN_ERRORS.has(current)) return true;
    const key = current.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    const matches = classes.filter((c) => c.name.toLowerCase() === key);
    if (matches.length !== 1) return false;
    current = matches[0].extends ?? '';
  }
  return false;
}

const openClosed: RuleDefinition<OpenClosedNeeds> = {
  id: 'solid/open-closed',
  analyzer: 'solid',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols', 'resolution'] },
  severity: 'high',
  message: META['solid/open-closed'].message,
  docs: META['solid/open-closed'].docs,
  thresholds: META['solid/open-closed'].thresholds,
  samples: META['solid/open-closed'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const symbols = visibleSymbols(ctx.facts['file-symbols'], ctx.thresholds);
    const classes = symbols.filter((s): s is FileClassSymbol => s.kind === 'class');
    const resolutionClasses = ctx.facts['resolution'].classes;

    for (const cls of classes) {
      if (cls.instanceofTargets.length === 0) continue;
      // An `instanceof` against an Error subclass is a catch-dispatch guard
      // (resolve the target up its extends chain), not an OCP violation. Only a
      // remaining domain type fires.
      const domainTargets = cls.instanceofTargets.filter((t) => !isErrorSubclass(t, resolutionClasses));
      if (domainTargets.length === 0) continue;
      out.push(finding({
        ruleId: 'solid/open-closed', severity: 'high',
        message: `Class "${cls.name}" uses instanceof against a user-defined type. Consider composition or inheritance for extension.`,
        file: cls.file, line: cls.line, column: cls.column, symbol: cls.name,
      }));
    }
    return out;
  },
};

// ── solid/single-responsibility ─────────────────────────────────────────────

const singleResponsibility: RuleDefinition<SolidNeeds> = {
  id: 'solid/single-responsibility',
  analyzer: 'solid',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['solid/single-responsibility'].message,
  docs: META['solid/single-responsibility'].docs,
  thresholds: META['solid/single-responsibility'].thresholds,
  samples: META['solid/single-responsibility'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const fn of collectFunctionLikes(visibleSymbols(ctx.facts['file-symbols'], ctx.thresholds))) {
      const groups = fn.concernGroups;
      if (groups.length < 2) continue;
      const labels = groups.join(', ');
      out.push(finding({
        ruleId: 'solid/single-responsibility', severity: 'high',
        message: `Function "${fn.name}" mixes ${groups.length} unrelated concerns (${labels}). Split it into one function per concern.`,
        file: fn.file, line: fn.line, column: fn.column, symbol: symbolOf(fn.name, fn.line, fn.column),
        resolution: {
          action: 'split-function',
          summary: `Split "${fn.name}" into one function per concern (${labels}) and compose them at the call site.`,
          symbols: [fn.name],
          files: [fn.file],
          lines: [fn.line],
        },
      }));
    }
    return out;
  },
};

// ── function-length ─────────────────────────────────────────────────────────

const functionLength = makeSizeRule({
  id: 'function-length',
  thresholdKey: 'maxLinesPerMethod',
  fallback: 200,
  measure: (fn) => fn.lineCount,
  messageFor: (fn, max) => `Function "${fn.name}" has ${fn.lineCount} lines, exceeding the maximum of ${max}. Consider breaking it down.`,
  resolutionFor: (fn) => ({
    action: 'break-down-function',
    summary: `Break "${fn.name}" (${fn.lineCount} lines) into smaller functions, extracting named helper blocks.`,
    symbols: [fn.name],
    files: [fn.file],
    lines: [fn.line],
  }),
});

// ── parameter-count ─────────────────────────────────────────────────────────

const parameterCount = makeSizeRule({
  id: 'parameter-count',
  thresholdKey: 'maxParametersPerMethod',
  fallback: 6,
  measure: (fn) => fn.parameterCount,
  messageFor: (fn, max) => `Function "${fn.name}" has ${fn.parameterCount} parameters, exceeding the maximum of ${max}. Consider using an options object.`,
  resolutionFor: (fn) => ({
    action: 'bundle-params',
    summary: `Bundle the ${fn.parameterCount} parameters of "${fn.name}" into an options object.`,
    symbols: fn.parameterNames,
    files: [fn.file],
    lines: [fn.line],
  }),
});

// ── interface-size ──────────────────────────────────────────────────────────

const interfaceSize: RuleDefinition<InterfaceSizeNeeds> = {
  id: 'interface-size',
  analyzer: 'solid',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['file-symbols', 'type-declarations'] },
  severity: 'high',
  message: META['interface-size'].message,
  docs: META['interface-size'].docs,
  thresholds: META['interface-size'].thresholds,
  thresholdRationale: META['interface-size'].thresholdRationale,
  samples: META['interface-size'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    // TypeScript arm: `maxInterfaceMembers` (25) over `file-symbols`.
    const max = num(ctx.thresholds, 'maxInterfaceMembers', 25);
    for (const s of visibleSymbols(ctx.facts['file-symbols'], ctx.thresholds)) {
      if (s.kind !== 'interface') continue;
      const iface = s as FileInterfaceSymbol;
      if (!iface.hasMethodMembers || iface.memberCount <= max) continue;
      out.push(finding({
        ruleId: 'interface-size', severity: 'high',
        message: `Interface "${iface.name}" has ${iface.memberCount} members, exceeding the maximum of ${max}. Consider splitting this large interface into smaller interfaces.`,
        file: iface.file, line: iface.line, column: iface.column, symbol: iface.name,
      }));
    }
    // Go arm: the Go binary's hardcoded threshold (10 methods), read from
    // `type-declarations`. Column is 0 — the Go binary never sets it.
    for (const decl of ctx.facts['type-declarations']) {
      if (decl.kind !== 'interface') continue;
      if (decl.methodCount <= 10) continue;
      out.push(finding({
        ruleId: 'interface-size', severity: 'high',
        message: `Interface "${decl.name}" has ${decl.methodCount} methods, exceeding the maximum of 10. Consider splitting this large interface into smaller, more focused interfaces.`,
        file: decl.file, line: decl.line, column: 0, symbol: decl.name,
      }));
    }
    return out;
  },
};

// ── struct-size ─────────────────────────────────────────────────────────────

const structSize: RuleDefinition<GoNeeds> = {
  id: 'struct-size',
  analyzer: 'solid',
  needs: { formats: ['go'], facts: ['type-declarations'] },
  severity: 'high',
  message: META['struct-size'].message,
  docs: META['struct-size'].docs,
  thresholds: META['struct-size'].thresholds,
  thresholdRationale: META['struct-size'].thresholdRationale,
  samples: META['struct-size'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const decl of ctx.facts['type-declarations']) {
      if (decl.kind !== 'struct') continue;
      // The Go binary's hardcoded threshold (15 fields). Column 0 matches the
      // Go binary, which never sets it.
      if (decl.fieldCount <= 15) continue;
      out.push(finding({
        ruleId: 'struct-size', severity: 'high',
        message: `Struct "${decl.name}" has ${decl.fieldCount} fields, exceeding the maximum of 15. Consider splitting this struct into smaller, more focused structs.`,
        file: decl.file, line: decl.line, column: 0, symbol: decl.name,
      }));
    }
    return out;
  },
};

// ── function-size (Go) ──────────────────────────────────────────────────────

const functionSize: RuleDefinition<GoFunctionNeeds> = {
  id: 'function-size',
  analyzer: 'solid',
  needs: { formats: ['go'], facts: ['go-functions'] },
  severity: 'high',
  message: META['function-size'].message,
  docs: META['function-size'].docs,
  thresholds: META['function-size'].thresholds,
  thresholdRationale: META['function-size'].thresholdRationale,
  samples: META['function-size'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const fn of ctx.facts['go-functions']) {
      // The Go binary's AND-combined size signal (solid.go `analyzeFunctionSize`):
      // complexity > 20 && returns > 2 && params > 6. Column 0 matches the Go
      // binary, which never sets it.
      if (!(fn.complexity > 20 && fn.returnCount > 2 && fn.parameterCount > 6)) continue;
      out.push(finding({
        ruleId: 'function-size', severity: 'high',
        message: `Function "${fn.name}" has many parameters, multiple returns, and high complexity. Consider breaking it into smaller, more focused functions.`,
        file: fn.file, line: fn.line, column: 0, symbol: fn.name,
      }));
    }
    return out;
  },
};

// ── switch-size (Go) ────────────────────────────────────────────────────────

const switchSize: RuleDefinition<GoSwitchNeeds> = {
  id: 'switch-size',
  analyzer: 'solid',
  needs: { formats: ['go'], facts: ['go-switches'] },
  severity: 'high',
  message: META['switch-size'].message,
  docs: META['switch-size'].docs,
  thresholds: META['switch-size'].thresholds,
  thresholdRationale: META['switch-size'].thresholdRationale,
  samples: META['switch-size'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const sw of ctx.facts['go-switches']) {
      // The Go binary's hardcoded threshold (8 cases, `default` included).
      if (sw.caseCount <= 8) continue;
      out.push(finding({
        ruleId: 'switch-size', severity: 'high',
        message: sw.kind === 'type-switch'
          ? 'Type switch has many case clauses. Consider consolidating related cases; a type switch over a sealed set is maintainable, but an open set grows unwieldy.'
          : 'Switch statement has many case clauses. Consider consolidating related cases or a table-driven lookup.',
        file: sw.file, line: sw.line, column: 0, symbol: undefined,
      }));
    }
    return out;
  },
};

// ── liskov-substitution (Go) ────────────────────────────────────────────────

const goLiskovSubstitution: RuleDefinition<GoFunctionNeeds> = {
  id: 'liskov-substitution',
  analyzer: 'solid',
  needs: { formats: ['go'], facts: ['go-functions'] },
  severity: 'severe',
  message: META['liskov-substitution'].message,
  docs: META['liskov-substitution'].docs,
  thresholds: META['liskov-substitution'].thresholds,
  thresholdRationale: META['liskov-substitution'].thresholdRationale,
  samples: META['liskov-substitution'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const fn of ctx.facts['go-functions']) {
      // LSP governs methods only — a free function has no supertype to violate.
      // Test functions are already excluded by the producer.
      if (!fn.isMethod || !fn.callsPanic) continue;
      out.push(finding({
        ruleId: 'liskov-substitution', severity: 'severe',
        message: `Method "${fn.name}" calls panic(). Consider returning an error instead so the method stays substitutable.`,
        file: fn.file, line: fn.line, column: 0, symbol: fn.name,
      }));
    }
    return out;
  },
};

// ── solid/liskov-substitution ───────────────────────────────────────────────

const liskovSubstitution: RuleDefinition<SolidNeeds> = {
  id: 'solid/liskov-substitution',
  analyzer: 'solid',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'severe',
  message: META['solid/liskov-substitution'].message,
  docs: META['solid/liskov-substitution'].docs,
  thresholds: META['solid/liskov-substitution'].thresholds,
  samples: META['solid/liskov-substitution'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const symbols = visibleSymbols(ctx.facts['file-symbols'], ctx.thresholds);
    const classes = symbols.filter((s): s is FileClassSymbol => s.kind === 'class');

    for (const cls of classes) {
      if (!cls.extends) continue;
      // Parent resolution is within-file, matching the old analyzer
      // (`adapter.extractClasses(ast)` over one file's AST).
      const parent = classes.find((c) => c.file === cls.file && c.name === cls.extends);
      if (!parent) continue;
      const parentMethods = new Map(parent.methods.map((m) => [m.name, m]));

      for (const m of cls.methods) {
        if (m.name === 'constructor') continue;
        const parentMethod = parentMethods.get(m.name);
        if (!parentMethod) continue;
        if (m.throws && !parentMethod.throws) {
          out.push(finding({
            ruleId: 'solid/liskov-substitution', severity: 'severe',
            message: `Method "${cls.name}.${m.name}" overrides "${parent.name}.${m.name}" and throws where the parent does not. Callers of the parent contract cannot handle it.`,
            file: cls.file, line: m.line, column: m.column, symbol: qualifiedMethod(cls.name, m.name),
          }));
        }
      }
    }
    return out;
  },
};

/** The eight TypeScript SOLID rules plus the §9 Go re-declarations, in registry
 *  order. The element type is the *union* of each rule's `RuleDefinition<N>`
 *  (not `any`) so the consumed-set check can recover the Go facts each declares;
 *  a slice runner that feeds one broad context casts at the call site. */
export const solidRules = [
  classSize,
  methodComplexity,
  openClosed,
  singleResponsibility,
  functionLength,
  parameterCount,
  interfaceSize,
  liskovSubstitution,
  structSize,
  functionSize,
  switchSize,
  goLiskovSubstitution,
];
