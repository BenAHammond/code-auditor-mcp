/**
 * Spec 68 §3.2 vertical slice — the SOLID rules, migrated to `analyze(ctx)`.
 *
 * These were the per-file AST checks inside `UniversalSOLIDAnalyzer`; now they
 * read the `file-symbols` fact (a flat array of function / class / interface
 * symbols with metrics pre-computed at process time) and do pure threshold
 * comparison. No AST, no adapter, no source code reaches a rule — the tree died
 * with the file.
 *
 * Nine TypeScript rules migrate here. The four Go size rules (`switch-size`,
 * `function-size`, `struct-size`, the Go `liskov-substitution`) are re-declared
 * against the Go binary's facts in §9; `interface-size`'s Go arm is likewise a
 * §9 re-declaration, so its `needs.formats` here is the TypeScript arm only.
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
} from '../types.js';
import type { Severity, Resolution } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

/** The shared declaration for every TS SOLID rule in this slice. */
type SolidNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['file-symbols'];
};

/** Read a numeric threshold with a documented fallback (the same value as
 *  `DEFAULT_SOLID_CONFIG`; config resolution proper lands in §10). */
function num(t: ThresholdValues, key: string, fallback: number): number {
  const v = t[key];
  return typeof v === 'number' ? v : fallback;
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

/** A finding with the fields every SOLID rule shares. */
function finding(
  ruleId: string,
  severity: Severity,
  message: string,
  file: string,
  line: number,
  column: number | undefined,
  symbol: string,
  resolution?: Resolution,
): Finding {
  return { ruleId, severity, message, file, line, column, symbol, resolution };
}

const META = RULE_REGISTRY;

// ── solid/class-size ────────────────────────────────────────────────────────

const classSize: RuleDefinition<SolidNeeds> = {
  id: 'solid/class-size',
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

    for (const s of ctx.facts['file-symbols']) {
      if (s.kind !== 'class') continue;
      const cls = s as FileClassSymbol;
      const line = cls.line;
      const column = cls.column;

      if (cls.methodCount > methodsThreshold) {
        out.push(finding(
          'solid/class-size', 'high',
          `Class "${cls.name}" has ${cls.methodCount} methods, exceeding the maximum of ${methodsThreshold}. Consider splitting into smaller classes.`,
          cls.file, line, column, cls.name,
          {
            action: 'split-class',
            summary: `Split class "${cls.name}" (${cls.methodCount} methods) into smaller classes by extracting a cohesive subset of its methods.`,
            symbols: cls.methods.map((m) => `${cls.name}.${m.name}`),
            files: [cls.file],
            lines: cls.methods.map((m) => m.line),
          },
        ));
      }

      if (cls.aggregateComplexity > maxAggregate) {
        out.push(finding(
          'solid/class-size', 'high',
          `Class "${cls.name}" has aggregate cyclomatic complexity ${cls.aggregateComplexity}, exceeding the maximum of ${maxAggregate}. Consider splitting the class.`,
          cls.file, line, column, cls.name,
          {
            action: 'split-class',
            summary: `Split class "${cls.name}" (aggregate complexity ${cls.aggregateComplexity}) to move its most-complex methods into a separate class.`,
            symbols: cls.methods.map((m) => `${cls.name}.${m.name}`),
            files: [cls.file],
            lines: cls.methods.map((m) => m.line),
          },
        ));
      }
    }
    return out;
  },
};

// ── solid/method-complexity ─────────────────────────────────────────────────

const methodComplexity: RuleDefinition<SolidNeeds> = {
  id: 'solid/method-complexity',
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

    for (const s of ctx.facts['file-symbols']) {
      if (s.kind === 'function') {
        const f = s as FileFunctionSymbol;
        if (f.complexity > max) {
          out.push(finding(
            'solid/method-complexity', 'high',
            `Function "${f.name}" has cyclomatic complexity ${f.complexity}, exceeding the maximum of ${max}. Consider breaking it into smaller functions.`,
            f.file, f.line, f.column, symbolOf(f.name, f.line, f.column),
          ));
        }
      } else if (s.kind === 'class') {
        const cls = s as FileClassSymbol;
        for (const m of cls.methods) {
          if (m.complexity > max) {
            out.push(finding(
              'solid/method-complexity', 'high',
              `Method "${cls.name}.${m.name}" has cyclomatic complexity ${m.complexity}, exceeding the maximum of ${max}. Consider breaking it into smaller methods.`,
              cls.file, m.line, m.column, `${cls.name}.${m.name}`,
            ));
          }
        }
      }
    }
    return out;
  },
};

// ── solid/open-closed ───────────────────────────────────────────────────────

const openClosed: RuleDefinition<SolidNeeds> = {
  id: 'solid/open-closed',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['solid/open-closed'].message,
  docs: META['solid/open-closed'].docs,
  thresholds: META['solid/open-closed'].thresholds,
  samples: META['solid/open-closed'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const s of ctx.facts['file-symbols']) {
      if (s.kind !== 'class') continue;
      const cls = s as FileClassSymbol;
      if (!cls.hasInstanceofAgainstUserType) continue;
      out.push(finding(
        'solid/open-closed', 'high',
        `Class "${cls.name}" uses instanceof against a user-defined type. Consider composition or inheritance for extension.`,
        cls.file, cls.line, cls.column, cls.name,
      ));
    }
    return out;
  },
};

// ── solid/single-responsibility ─────────────────────────────────────────────

const singleResponsibility: RuleDefinition<SolidNeeds> = {
  id: 'solid/single-responsibility',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['solid/single-responsibility'].message,
  docs: META['solid/single-responsibility'].docs,
  thresholds: META['solid/single-responsibility'].thresholds,
  samples: META['solid/single-responsibility'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const fn of collectFunctionLikes(ctx.facts['file-symbols'])) {
      const groups = fn.concernGroups;
      if (groups.length < 2) continue;
      const labels = groups.join(', ');
      out.push(finding(
        'solid/single-responsibility', 'high',
        `Function "${fn.name}" mixes ${groups.length} unrelated concerns (${labels}). Split it into one function per concern.`,
        fn.file, fn.line, fn.column, symbolOf(fn.name, fn.line, fn.column),
        {
          action: 'split-function',
          summary: `Split "${fn.name}" into one function per concern (${labels}) and compose them at the call site.`,
          symbols: [fn.name],
          files: [fn.file],
          lines: [fn.line],
        },
      ));
    }
    return out;
  },
};

// ── function-length ─────────────────────────────────────────────────────────

const functionLength: RuleDefinition<SolidNeeds> = {
  id: 'function-length',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['function-length'].message,
  docs: META['function-length'].docs,
  thresholds: META['function-length'].thresholds,
  thresholdRationale: META['function-length'].thresholdRationale,
  samples: META['function-length'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const max = num(ctx.thresholds, 'maxLinesPerMethod', 200);
    for (const fn of collectFunctionLikes(ctx.facts['file-symbols'])) {
      if (fn.lineCount <= max) continue;
      out.push(finding(
        'function-length', 'high',
        `Function "${fn.name}" has ${fn.lineCount} lines, exceeding the maximum of ${max}. Consider breaking it down.`,
        fn.file, fn.line, fn.column, symbolOf(fn.name, fn.line, fn.column),
        {
          action: 'break-down-function',
          summary: `Break "${fn.name}" (${fn.lineCount} lines) into smaller functions, extracting named helper blocks.`,
          symbols: [fn.name],
          files: [fn.file],
          lines: [fn.line],
        },
      ));
    }
    return out;
  },
};

// ── parameter-count ─────────────────────────────────────────────────────────

const parameterCount: RuleDefinition<SolidNeeds> = {
  id: 'parameter-count',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['parameter-count'].message,
  docs: META['parameter-count'].docs,
  thresholds: META['parameter-count'].thresholds,
  thresholdRationale: META['parameter-count'].thresholdRationale,
  samples: META['parameter-count'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const max = num(ctx.thresholds, 'maxParametersPerMethod', 6);
    for (const fn of collectFunctionLikes(ctx.facts['file-symbols'])) {
      if (fn.parameterCount <= max) continue;
      out.push(finding(
        'parameter-count', 'high',
        `Function "${fn.name}" has ${fn.parameterCount} parameters, exceeding the maximum of ${max}. Consider using an options object.`,
        fn.file, fn.line, fn.column, symbolOf(fn.name, fn.line, fn.column),
        {
          action: 'bundle-params',
          summary: `Bundle the ${fn.parameterCount} parameters of "${fn.name}" into an options object.`,
          symbols: fn.parameterNames,
          files: [fn.file],
          lines: [fn.line],
        },
      ));
    }
    return out;
  },
};

// ── interface-size ──────────────────────────────────────────────────────────

const interfaceSize: RuleDefinition<SolidNeeds> = {
  id: 'interface-size',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['interface-size'].message,
  docs: META['interface-size'].docs,
  thresholds: META['interface-size'].thresholds,
  thresholdRationale: META['interface-size'].thresholdRationale,
  samples: META['interface-size'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const max = num(ctx.thresholds, 'maxInterfaceMembers', 25);
    for (const s of ctx.facts['file-symbols']) {
      if (s.kind !== 'interface') continue;
      const iface = s as FileInterfaceSymbol;
      if (!iface.hasMethodMembers || iface.memberCount <= max) continue;
      out.push(finding(
        'interface-size', 'high',
        `Interface "${iface.name}" has ${iface.memberCount} members, exceeding the maximum of ${max}. Consider splitting this large interface into smaller interfaces.`,
        iface.file, iface.line, iface.column, iface.name,
      ));
    }
    return out;
  },
};

// ── solid/liskov-substitution ───────────────────────────────────────────────

const liskovSubstitution: RuleDefinition<SolidNeeds> = {
  id: 'solid/liskov-substitution',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'severe',
  message: META['solid/liskov-substitution'].message,
  docs: META['solid/liskov-substitution'].docs,
  thresholds: META['solid/liskov-substitution'].thresholds,
  samples: META['solid/liskov-substitution'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    const symbols = ctx.facts['file-symbols'];
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
          out.push(finding(
            'solid/liskov-substitution', 'severe',
            `Method "${cls.name}.${m.name}" overrides "${parent.name}.${m.name}" and throws where the parent does not. Callers of the parent contract cannot handle it.`,
            cls.file, m.line, m.column, `${cls.name}.${m.name}`,
          ));
        }
      }
    }
    return out;
  },
};

// ── solid/dependency-inversion ──────────────────────────────────────────────

const dependencyInversion: RuleDefinition<SolidNeeds> = {
  id: 'solid/dependency-inversion',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['solid/dependency-inversion'].message,
  docs: META['solid/dependency-inversion'].docs,
  thresholds: META['solid/dependency-inversion'].thresholds,
  samples: META['solid/dependency-inversion'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    for (const s of ctx.facts['file-symbols']) {
      if (s.kind !== 'class') continue;
      const cls = s as FileClassSymbol;
      if (!cls.hasHeldDirectInstantiation) continue;
      out.push(finding(
        'solid/dependency-inversion', 'high',
        `Class "${cls.name}" directly instantiates a concrete dependency. Consider depending on abstractions.`,
        cls.file, cls.line, cls.column, cls.name,
      ));
    }
    return out;
  },
};

/** The nine TypeScript SOLID rules, in registry order. */
export const solidRules: readonly RuleDefinition<SolidNeeds>[] = [
  classSize,
  methodComplexity,
  openClosed,
  singleResponsibility,
  functionLength,
  parameterCount,
  interfaceSize,
  liskovSubstitution,
  dependencyInversion,
];
