/**
 * Spec 68 §3.2 — the styles rules, migrated to `analyze(ctx)`.
 *
 * These eight rules were the DB-backed detectors inside
 * `UniversalStylesAnalyzer`: value-drift, off-scale, token-bypass,
 * mechanism-fragmentation, mechanism-mixing, declaration-set-similarity,
 * z-index-sprawl, z-index-singleton. Now they read the `style-declarations`
 * fact and do pure comparison over plain data. The tree died with the file; the
 * per-file processors (`stylesCss.ts` / `stylesSource.ts`) pre-computed the
 * normalized declarations and design tokens, so `analyze` never touches a tree,
 * an adapter, or a source string.
 *
 * `undefined-class` (severity 'severe') is the ninth rule, exported separately
 * (`undefinedClassRule`): its `needs` adds the corpus-shaped `defined-classes`
 * fact (the `style_defined_classes` catalog) alongside `style-declarations`, so
 * it cannot share the eight rules' `StylesNeeds` tuple. It reads the fact's
 * `classUsage` against that catalog in memory (membership + Levenshtein ≤2
 * near-miss) and resolves candidates through the shared `getTailwindExpander()`
 * singleton. The compile-probe never initializes on the phase path — the rule's
 * `AnalysisContext` carries no `projectRoot`, exactly as the legacy reducer
 * passed none — so `resolve()` degrades to the user's `tailwindClasses`
 * custom-set + bare utilities + structural patterns, byte-identical to the
 * legacy `detectUndefinedClasses` run under the same (projectRoot-absent)
 * production config. The two off-ladder diagnostics (`undefined-class-not-found`
 * / `undefined-class-disabled`) have no `Finding` shape and stay on the legacy
 * path until §15 re-homes them.
 *
 * The detector logic is re-homed verbatim from `UniversalStylesAnalyzer.ts` —
 * copied, not imported, because that analyzer is deleted in §15 and the rules
 * must not couple the new pipeline to a class that is about to disappear. The
 * re-home operates on the legacy *snake_case* `StyleDeclRow` (`raw_value`,
 * `normalized_value`, `file_path`, `token_ref`) so the detector bodies are
 * byte-identical to the pre-migration code; a `toDeclRow` adapter maps the
 * camelCase fact back onto that shape (`normalized_value` is the DB's
 * `JSON.stringify(NormalizedValue)` encoding). The two pure modules it reads —
 * `normalizer.ts` (value normalization) and `styleScale.ts` (the declared design
 * scale) — survive §15.
 *
 * Config resolution mirrors the legacy analyzer's `{...DEFAULT_STYLES_CONFIG,
 * ...config}` merge; the defaults are re-declared here (the legacy class is
 * deleted in §15). The §10 bridge (`resolvePhaseThresholds`) already merges the
 * same default into `ctx.thresholds`, so the merge is idempotent in production
 * and load-bearing only for the parity test, which passes raw config to both
 * sides.
 */

import type {
  RuleDefinition,
  Finding,
  StyleDeclarationsFile,
  StylesDeclaration,
  StylesClassUsage,
  DefinedClassesFact,
  ColorValuesFact,
  ThresholdValues,
} from '../types.js';
import { labDistance } from '../colorMath.js';
import type { Severity, Resolution } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import { getTailwindExpander, type TailwindUtilityExpander } from '../../styles/tailwindUtilityExpander.js';
import { normalizeValue } from '../../styles/normalizer.js';
import {
  buildDeclaredScale,
  parseLengthToPx,
  type DeclaredScale,
} from '../../analyzers/universal/styleScale.js';

const META = RULE_REGISTRY;

/** The shared declaration for every styles rule in this slice. */
type StylesNeeds = {
  readonly formats: readonly ['css', 'scss', 'typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['style-declarations'];
};

/** `value-drift` additionally reads the corpus-derived `color-values` fact
 *  (Spec 69 R4) — the CIELAB conversion the producer computed — so it cannot
 *  share `StylesNeeds`. Mirrors `undefinedClassRule`'s split below. */
type ValueDriftNeeds = {
  readonly formats: readonly ['css', 'scss', 'typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['style-declarations', 'color-values'];
};

// ── Config surface (re-declared from DEFAULT_STYLES_CONFIG) ─────────────────

/** The config surface the migrated rules read (the finding-relevant subset). */
interface StylesConfig {
  colorDeltaE: number;
  scaleProperties: string[];
  zIndexMaxDistinct: number;
  mechanismFragmentationMinMechanisms: number;
  declarationSetMinDeclarations: number;
  declarationSetSimilarityThreshold: number;
  offScaleMinDeclarations: number;
  categoricalPropertyExclusions?: string[];
}

const STYLES_DEFAULTS: StylesConfig = {
  colorDeltaE: 2.5,
  scaleProperties: [
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'gap', 'row-gap', 'column-gap', 'font-size',
  ],
  zIndexMaxDistinct: 6,
  mechanismFragmentationMinMechanisms: 3,
  declarationSetMinDeclarations: 5,
  declarationSetSimilarityThreshold: 0.9,
  offScaleMinDeclarations: 20,
};

/** Merge the (default-merged) thresholds onto the styles defaults. */
function resolveStylesConfig(t: ThresholdValues): StylesConfig {
  return { ...STYLES_DEFAULTS, ...(t as Record<string, unknown>) } as StylesConfig;
}

// ── Legacy DB-row shapes (snake_case — the re-home's internal form) ─────────

interface StyleDeclRow {
  property: string;
  raw_value: string;
  normalized_value: string | null;
  mechanism: string;
  file_path: string;
  line: number;
  context: string | null;
  token_ref: string | null;
}

interface StyleTokenRow {
  name: string;
  value: string;
  file_path: string;
  mechanism: string;
}

/** The camelCase fact → the legacy analyzer's snake_case row. `normalized_value`
 *  is the DB's `JSON.stringify(NormalizedValue)` encoding (styleIndexer.ts). */
function toDeclRow(d: StylesDeclaration): StyleDeclRow {
  return {
    property: d.property,
    raw_value: d.rawValue,
    normalized_value: d.normalizedValue ? JSON.stringify(d.normalizedValue) : null,
    mechanism: d.mechanism,
    file_path: d.filePath,
    line: d.line,
    context: d.context,
    token_ref: d.tokenRef,
  };
}

function flattenDeclarations(files: readonly StyleDeclarationsFile[]): StyleDeclRow[] {
  const out: StyleDeclRow[] = [];
  for (const f of files) for (const d of f.declarations) out.push(toDeclRow(d));
  return out;
}

function flattenTokens(files: readonly StyleDeclarationsFile[]): StyleTokenRow[] {
  const out: StyleTokenRow[] = [];
  for (const f of files) for (const t of f.tokens) out.push({
    name: t.name,
    value: t.value,
    file_path: t.filePath,
    mechanism: t.mechanism,
  });
  return out;
}

function flattenClassUsage(files: readonly StyleDeclarationsFile[]): StylesClassUsage[] {
  const out: StylesClassUsage[] = [];
  for (const f of files) for (const u of f.classUsage) out.push(u);
  return out;
}

// ── Violation reporter (the legacy makeViolation, on the Finding shape) ─────

interface StyleViolationClassification {
  severity: 'critical' | 'severe' | 'high';
  rule: string;
  symbol?: string;
  resolution?: Resolution;
}

type StylesViolationReporter = (
  filePath: string,
  line: number,
  message: string,
  classification: StyleViolationClassification,
) => Finding;

/** The legacy `makeViolation` always pinned `column: 1`. */
const makeFinding: StylesViolationReporter = (filePath, line, message, classification) => {
  const f: Finding = {
    ruleId: classification.rule,
    severity: classification.severity as Severity,
    message,
    file: filePath,
    line,
    column: 1,
  };
  if (classification.symbol) f.symbol = classification.symbol;
  if (classification.resolution) f.resolution = classification.resolution;
  return f;
};

// ── Leaf helpers (re-homed verbatim from UniversalStylesAnalyzer) ───────────

function declValueKey(d: StyleDeclRow): string {
  const prop = d.property ?? '';
  const val = d.normalized_value ?? d.raw_value ?? '';
  return val ? `${prop}: ${val}` : prop;
}

const TRIVIAL_VALUES = new Set([
  '0', '0px', '0rem', '0em', '0%', 'none', 'transparent',
  'inherit', 'initial', 'unset', 'currentcolor', 'auto',
  '100%', '50%',
]);

function isCategoricalByValues(decls: StyleDeclRow[]): boolean {
  for (const d of decls) {
    const v = d.raw_value.trim();
    if (!v) continue;
    if (/^-?\d/.test(v)) return false;
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return false;
    if (/^(rgb|rgba|hsl|hsla)\(/.test(v)) return false;
    if (/^-?\d+(\.\d+)?(px|em|rem|vw|vh|vmin|vmax|%|ch|ex|cm|mm|in|pt|pc|deg|rad|turn|s|ms|dpi|dpcm|dppx|fr)$/.test(v)) return false;
    if (/^(calc|clamp|min|max)\(/.test(v)) return false;
  }
  return true;
}

function isColorProperty(property: string): boolean {
  const colorProps = new Set([
    'color', 'background-color', 'background', 'border-color',
    'border-top-color', 'border-right-color', 'border-bottom-color',
    'border-left-color', 'outline-color', 'fill', 'stroke',
    'text-decoration-color', 'caret-color', 'column-rule-color',
    'accent-color', 'scrollbar-color',
  ]);
  return colorProps.has(property);
}

function nearestScaleValues(px: number, values: readonly number[]): [number, number] {
  let lower = 0;
  let upper = values[values.length - 1] ?? 0;
  for (const s of values) {
    if (s <= px) lower = s;
    if (s >= px) { upper = s; break; }
  }
  return [lower, upper];
}

// ── Detector 1: Value Drift ─────────────────────────────────────────────────

interface ColorValue {
  value: string;
  rgb: [number, number, number];
  lab: [number, number, number];
  filePath: string;
  line: number;
  property: string;
  normalizedValue: string | null;
  count: number;
}

function clusterDistinctColors(
  values: ColorValue[],
  threshold: number,
  distance: (a: [number, number, number], b: [number, number, number]) => number,
): ColorValue[][] {
  const n = values.length;
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (distance(values[i].lab, values[j].lab) < threshold) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const clusters = new Map<number, ColorValue[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = clusters.get(root) ?? [];
    list.push(values[i]);
    clusters.set(root, list);
  }
  return [...clusters.values()];
}

function flagColorDriftMembers(
  driftClusters: ColorValue[][],
  property: string,
  report: StylesViolationReporter,
  distance: (a: [number, number, number], b: [number, number, number]) => number,
): Finding[] {
  const out: Finding[] = [];
  for (const cluster of driftClusters) {
    const canonical = [...cluster].sort(
      (a, b) => (b.count - a.count) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    )[0];
    for (const member of cluster) {
      if (member.value === canonical.value) continue;
      const d = distance(member.lab, canonical.lab);
      const symbolValue = member.normalizedValue ?? member.value;
      out.push(report(
        member.filePath,
        member.line,
        `Color drift in "${property}": "${member.value}" is near-identical to "${canonical.value}" ` +
        `(used ${canonical.count} time${canonical.count === 1 ? '' : 's'}, ΔE = ${d.toFixed(2)}). ` +
        `Consider using "${canonical.value}".`,
        { severity: 'high', rule: 'styles/value-drift', symbol: symbolValue ? `${member.property}: ${symbolValue}` : member.property },
      ));
    }
  }
  return out;
}

function detectColorDrift(
  property: string,
  colorDecls: ColorValuesFact[],
  cfg: StylesConfig,
  report: StylesViolationReporter,
): Finding[] {
  const byRgb = new Map<string, ColorValue>();
  for (const cv of colorDecls) {
    const key = cv.rgb.join(',');
    const existing = byRgb.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byRgb.set(key, {
        value: cv.rawValue,
        rgb: cv.rgb,
        lab: cv.lab,
        filePath: cv.filePath,
        line: cv.line,
        property: cv.property,
        normalizedValue: cv.normalizedValue,
        count: 1,
      });
    }
  }
  const values = [...byRgb.values()];
  const clusters = clusterDistinctColors(values, cfg.colorDeltaE, labDistance);
  const drift = clusters.filter((c) => c.length >= 2);
  if (drift.length === 0) return [];
  return flagColorDriftMembers(drift, property, report, labDistance);
}

function detectValueDrift(
  byProperty: Map<string, StyleDeclRow[]>,
  colorValues: ColorValuesFact[],
  cfg: StylesConfig,
  report: StylesViolationReporter,
): Finding[] {
  const out: Finding[] = [];
  const exclusions = new Set(cfg.categoricalPropertyExclusions ?? []);
  const byPropertyColors = new Map<string, ColorValuesFact[]>();
  for (const cv of colorValues) {
    const list = byPropertyColors.get(cv.property) ?? [];
    list.push(cv);
    byPropertyColors.set(cv.property, list);
  }
  for (const [property, decls] of byProperty) {
    if (exclusions.has(property)) continue;
    if (isCategoricalByValues(decls)) continue;
    if (isColorProperty(property)) {
      out.push(...detectColorDrift(property, byPropertyColors.get(property) ?? [], cfg, report));
    }
  }
  return out;
}

// ── Detector 2: Off-Scale Values ────────────────────────────────────────────

function detectOffScaleValues(
  byProperty: Map<string, StyleDeclRow[]>,
  cfg: StylesConfig,
  declaredScale: DeclaredScale,
  report: StylesViolationReporter,
): Finding[] {
  const out: Finding[] = [];

  for (const property of cfg.scaleProperties) {
    const decls = byProperty.get(property);
    if (!decls || decls.length < cfg.offScaleMinDeclarations) continue;

    const isFontSize = property === 'font-size';
    const scaleSet = isFontSize ? declaredScale.fontSize : declaredScale.spacing;
    if (scaleSet.size === 0) continue;
    const scaleValues = [...scaleSet].sort((a, b) => a - b);
    const label = isFontSize ? 'font-size scale' : 'spacing scale';

    const parsed: Array<{ decl: StyleDeclRow; px: number }> = [];
    for (const d of decls) {
      const px = parseLengthToPx(d.raw_value);
      if (px !== null) {
        parsed.push({ decl: d, px });
      }
    }

    if (parsed.length < cfg.offScaleMinDeclarations) continue;

    for (const { decl, px } of parsed) {
      if (px === 0) continue;
      if (!scaleSet.has(px)) {
        const [lower, upper] = nearestScaleValues(px, scaleValues);
        out.push(report(
          decl.file_path,
          decl.line,
          `Off-scale "${property}" value: "${decl.raw_value}" (${px}px) ` +
          `is not on the project's declared ${label}. ` +
          `Nearest scale values: ${lower}px or ${upper}px.`,
          { severity: 'high', rule: 'styles/off-scale', symbol: declValueKey(decl) },
        ));
      }
    }
  }

  return out;
}

// ── Detector 4: Token Bypass ────────────────────────────────────────────────

function normalizeForTokenMatch(raw: string): string {
  let v = raw.toLowerCase().trim();
  v = v.replace(/,\s+/g, ',');
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  }
  return v;
}

function parseNormalizedValueType(normalizedValue: string | null): string | null {
  if (!normalizedValue) return null;
  try {
    const nv = JSON.parse(normalizedValue) as { type: string };
    return nv.type;
  } catch {
    return null;
  }
}

function matchBypassToken(
  d: StyleDeclRow,
  tokenValueMap: Map<string, { name: string; valueType: string | null }>,
  categoricalExclusions: Set<string>,
  scaleProps: Set<string>,
): { name: string; valueType: string | null } | null {
  if (d.token_ref) return null;
  if (d.property.startsWith('--') || d.property.startsWith('$')) return null;
  if (categoricalExclusions.has(d.property)) return null;
  if (scaleProps.has(d.property)) return null;

  const normalized = normalizeForTokenMatch(d.raw_value);
  if (TRIVIAL_VALUES.has(normalized)) return null;

  const tokenInfo = tokenValueMap.get(normalized);
  if (!tokenInfo) return null;

  if (tokenInfo.valueType !== null) {
    const declType = parseNormalizedValueType(d.normalized_value);
    if (declType !== null && declType !== tokenInfo.valueType) return null;
  }

  return tokenInfo;
}

function buildTokenValueMap(
  tokens: StyleTokenRow[],
): Map<string, { name: string; valueType: string | null }> {
  const tokenValueMap = new Map<string, { name: string; valueType: string | null }>();
  for (const t of tokens) {
    if (t.file_path === 'built-in defaults') continue;
    const normalizedTokenVal = normalizeValue(t.value, '__token__');
    tokenValueMap.set(normalizeForTokenMatch(t.value), { name: t.name, valueType: normalizedTokenVal?.type ?? null });
  }
  return tokenValueMap;
}

function detectTokenBypass(
  declarations: StyleDeclRow[],
  tokenValueMap: Map<string, { name: string; valueType: string | null }>,
  cfg: StylesConfig,
  report: StylesViolationReporter,
): Finding[] {
  const out: Finding[] = [];
  if (tokenValueMap.size === 0) return out;

  const categoricalExclusions = new Set(cfg.categoricalPropertyExclusions ?? []);
  const scaleProps = new Set(cfg.scaleProperties ?? []);

  for (const d of declarations) {
    const tokenInfo = matchBypassToken(d, tokenValueMap, categoricalExclusions, scaleProps);
    if (!tokenInfo) continue;

    out.push(report(
      d.file_path,
      d.line,
      `Token bypass: "${d.raw_value}" for "${d.property}" matches design ` +
      `token "${tokenInfo.name}" but was used as a raw value. ` +
      `Use the token reference instead to keep styles consistent.`,
      { severity: 'high', rule: 'styles/token-bypass', symbol: declValueKey(d) },
    ));
  }

  return out;
}

// ── Detector 5: Mechanism Fragmentation / Mixing ────────────────────────────

function flagPropertyValueFragmentation(
  declarations: StyleDeclRow[],
  minMechanisms: number,
  report: StylesViolationReporter,
): Finding[] {
  const out: Finding[] = [];
  const pvMap = new Map<string, Set<string>>();
  const pvSample = new Map<string, StyleDeclRow>();

  for (const d of declarations) {
    const key = `${d.property}::${d.normalized_value ?? d.raw_value}`;
    const mechs = pvMap.get(key) || new Set();
    mechs.add(d.mechanism);
    pvMap.set(key, mechs);
    if (!pvSample.has(key)) {
      pvSample.set(key, d);
    }
  }

  for (const [key, mechs] of pvMap) {
    if (mechs.size < minMechanisms) continue;
    const sample = pvSample.get(key)!;
    const prop = sample.property;
    out.push(report(
      sample.file_path,
      sample.line,
      `Mechanism fragmentation: "${prop}: ${sample.raw_value}" is applied via ` +
      `${mechs.size} different mechanisms (${[...mechs].sort().join(', ')}). ` +
      `Consolidate to a single mechanism or design token.`,
      { severity: 'high', rule: 'styles/mechanism-fragmentation', symbol: declValueKey(sample) },
    ));
  }

  return out;
}

function flagFileMechanismMixing(
  declarations: StyleDeclRow[],
  minMechanisms: number,
  report: StylesViolationReporter,
): Finding[] {
  const out: Finding[] = [];
  const fileMechs = new Map<string, Set<string>>();
  for (const d of declarations) {
    const mechs = fileMechs.get(d.file_path) || new Set();
    mechs.add(d.mechanism);
    fileMechs.set(d.file_path, mechs);
  }

  for (const [file, mechs] of fileMechs) {
    if (mechs.size < minMechanisms) continue;
    out.push(report(
      file,
      1,
      `Mechanism mixing: ${file} uses ${mechs.size} different style ` +
      `mechanisms (${[...mechs].sort().join(', ')}). ` +
      `Consolidate to fewer mechanisms for maintainability.`,
      { severity: 'high', rule: 'styles/mechanism-mixing' },
    ));
  }

  return out;
}

// ── Detector 6: Declaration-Set Similarity ──────────────────────────────────

interface DeclarationBlock {
  key: string;
  filePath: string;
  context: string;
  line: number;
  declCount: number;
  valueSet: Set<string>;
}

function buildDeclarationBlocks(
  declarations: StyleDeclRow[],
  minDeclarations: number,
): DeclarationBlock[] {
  const blocks = new Map<string, StyleDeclRow[]>();
  for (const d of declarations) {
    if (!d.context) continue;
    const key = `${d.file_path}::${d.context}`;
    const list = blocks.get(key) || [];
    list.push(d);
    blocks.set(key, list);
  }

  return [...blocks.entries()]
    .map(([key, decls]) => {
      const valueSet = new Set(decls.map(d => `${d.property}:${d.normalized_value ?? d.raw_value}`));
      return {
        key,
        filePath: decls[0].file_path,
        context: decls[0].context!,
        line: decls[0].line,
        declCount: decls.length,
        valueSet,
      };
    })
    .filter(b => b.declCount >= minDeclarations);
}

type OrderedBlock = DeclarationBlock & { values: string[]; size: number };

const prefixLen = (threshold: number, s: number) => s - Math.ceil(threshold * s) + 1;

function flagSimilarBlockPairs(
  blockEntries: DeclarationBlock[],
  threshold: number,
  report: StylesViolationReporter,
): Finding[] {
  const n = blockEntries.length;
  if (n < 2) return [];

  const freq = new Map<string, number>();
  for (const b of blockEntries) {
    for (const v of b.valueSet) freq.set(v, (freq.get(v) ?? 0) + 1);
  }

  const ordered: OrderedBlock[] = blockEntries.map((b) => ({
    ...b,
    values: [...b.valueSet].sort(
      (x, y) => (freq.get(x)! - freq.get(y)!) || (x < y ? -1 : 1),
    ),
    size: b.valueSet.size,
  }));

  const inverted = buildInvertedIndex(ordered, threshold);
  const candidates = generateCandidates(ordered, inverted, threshold, n);
  return verifyCandidates(ordered, candidates, threshold, report);
}

function buildInvertedIndex(ordered: OrderedBlock[], threshold: number): Map<string, number[]> {
  const inverted = new Map<string, number[]>();
  ordered.forEach((b, i) => {
    const p = Math.max(1, Math.min(prefixLen(threshold, b.size), b.size));
    for (let k = 0; k < p; k++) {
      const v = b.values[k];
      const list = inverted.get(v);
      if (list) list.push(i);
      else inverted.set(v, [i]);
    }
  });
  return inverted;
}

function generateCandidates(
  ordered: OrderedBlock[],
  inverted: Map<string, number[]>,
  threshold: number,
  n: number,
): Set<number> {
  const E = 1e-6;
  const candidates = new Set<number>();
  for (const [, idxs] of inverted) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a];
        const j = idxs[b];
        const si = ordered[i].size;
        const sj = ordered[j].size;
        if (Math.min(si, sj) < threshold * Math.max(si, sj) - E) continue;
        candidates.add(i < j ? i * n + j : j * n + i);
      }
    }
  }
  return candidates;
}

function verifyCandidates(
  ordered: OrderedBlock[],
  candidates: Set<number>,
  threshold: number,
  report: StylesViolationReporter,
): Finding[] {
  const n = ordered.length;
  const out: Finding[] = [];
  const reported = new Set<string>();
  const sortedCandidates = [...candidates].sort((x, y) => x - y);
  for (const enc of sortedCandidates) {
    const i = Math.floor(enc / n);
    const j = enc % n;
    const a = ordered[i];
    const b = ordered[j];
    if (a.key === b.key) continue;

    const pairKey = [a.key, b.key].sort().join('::');
    if (reported.has(pairKey)) continue;
    reported.add(pairKey);

    const intersection = new Set([...a.valueSet].filter(x => b.valueSet.has(x)));
    const union = new Set([...a.valueSet, ...b.valueSet]);
    const similarity = intersection.size / union.size;

    if (similarity >= threshold) {
      out.push(report(
        a.filePath,
        a.line,
        `Declaration-set similarity: "${a.context}" and "${b.context}" ` +
        `in ${b.filePath} share ${intersection.size} of ${union.size} ` +
        `declarations (${(similarity * 100).toFixed(0)}%). ` +
        `Consider consolidating these rules or extracting a shared mixin.`,
        { severity: 'high', rule: 'styles/declaration-set-similarity', symbol: `${a.context} & ${b.context}` },
      ));
    }
  }
  return out;
}

function detectDeclarationSetSimilarity(
  declarations: StyleDeclRow[],
  cfg: StylesConfig,
  report: StylesViolationReporter,
): Finding[] {
  const blockEntries = buildDeclarationBlocks(declarations, cfg.declarationSetMinDeclarations);
  return flagSimilarBlockPairs(blockEntries, cfg.declarationSetSimilarityThreshold, report);
}

// ── Detector 7: Z-Index Inventory ───────────────────────────────────────────

function collectZIndexValues(decls: StyleDeclRow[]): Map<number, StyleDeclRow[]> {
  const values = new Map<number, StyleDeclRow[]>();
  for (const d of decls) {
    const num = parseInt(d.raw_value, 10);
    if (isNaN(num)) continue;
    const list = values.get(num) || [];
    list.push(d);
    values.set(num, list);
  }
  return values;
}

function detectZIndexSprawl(
  byProperty: Map<string, StyleDeclRow[]>,
  cfg: StylesConfig,
  report: StylesViolationReporter,
): Finding[] {
  const decls = byProperty.get('z-index');
  if (!decls || decls.length === 0) return [];
  const values = collectZIndexValues(decls);
  if (values.size === 0) return [];

  if (values.size > cfg.zIndexMaxDistinct) {
    const sortedVals = [...values.keys()].sort((a, b) => a - b);
    const sample = values.get(sortedVals[0])![0];
    return [report(
      sample.file_path,
      sample.line,
      `Z-index sprawl: ${values.size} distinct z-index values ` +
      `(${sortedVals.join(', ')}). Consider defining a z-index scale ` +
      `(e.g., $z-layers: (dropdown: 100, modal: 200, toast: 300)).`,
      { severity: 'high', rule: 'styles/z-index-sprawl', symbol: declValueKey(sample) },
    )];
  }

  return [];
}

function detectZIndexSingletons(
  byProperty: Map<string, StyleDeclRow[]>,
  report: StylesViolationReporter,
): Finding[] {
  const decls = byProperty.get('z-index');
  if (!decls || decls.length === 0) return [];
  const values = collectZIndexValues(decls);
  if (values.size === 0) return [];

  const out: Finding[] = [];
  for (const [val, list] of values) {
    if (list.length === 1 && values.size > 2) {
      const d = list[0];
      out.push(report(
        d.file_path,
        d.line,
        `Singleton z-index: z-index: ${val} is used only once. ` +
        `Consider whether this value belongs in a shared z-index scale.`,
        { severity: 'high', rule: 'styles/z-index-singleton', symbol: declValueKey(d) },
      ));
    }
  }
  return out;
}

// ── Shared iteration ─────────────────────────────────────────────────────────

function groupDeclarationsByProperty(declarations: StyleDeclRow[]): Map<string, StyleDeclRow[]> {
  const byProperty = new Map<string, StyleDeclRow[]>();
  for (const d of declarations) {
    const list = byProperty.get(d.property) || [];
    list.push(d);
    byProperty.set(d.property, list);
  }
  return byProperty;
}

// ── The eight rules ─────────────────────────────────────────────────────────

const valueDrift: RuleDefinition<ValueDriftNeeds> = {
  id: 'styles/value-drift',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations', 'color-values'] },
  severity: 'high',
  message: META['styles/value-drift'].message,
  docs: META['styles/value-drift'].docs,
  thresholds: META['styles/value-drift'].thresholds,
  samples: META['styles/value-drift'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveStylesConfig(ctx.thresholds);
    const declarations = flattenDeclarations(ctx.facts['style-declarations']);
    return detectValueDrift(groupDeclarationsByProperty(declarations), ctx.facts['color-values'], cfg, makeFinding);
  },
};

const offScale: RuleDefinition<StylesNeeds> = {
  id: 'styles/off-scale',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations'] },
  severity: 'high',
  message: META['styles/off-scale'].message,
  docs: META['styles/off-scale'].docs,
  thresholds: META['styles/off-scale'].thresholds,
  samples: META['styles/off-scale'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveStylesConfig(ctx.thresholds);
    const files = ctx.facts['style-declarations'];
    const declarations = flattenDeclarations(files);
    const tokens = flattenTokens(files);
    return detectOffScaleValues(
      groupDeclarationsByProperty(declarations),
      cfg,
      buildDeclaredScale(tokens.map((t) => ({ name: t.name, value: t.value, file_path: t.file_path }))),
      makeFinding,
    );
  },
};

const tokenBypass: RuleDefinition<StylesNeeds> = {
  id: 'styles/token-bypass',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations'] },
  severity: 'high',
  message: META['styles/token-bypass'].message,
  docs: META['styles/token-bypass'].docs,
  thresholds: META['styles/token-bypass'].thresholds,
  samples: META['styles/token-bypass'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveStylesConfig(ctx.thresholds);
    const files = ctx.facts['style-declarations'];
    const declarations = flattenDeclarations(files);
    const tokens = flattenTokens(files);
    return detectTokenBypass(declarations, buildTokenValueMap(tokens), cfg, makeFinding);
  },
};

const mechanismFragmentation: RuleDefinition<StylesNeeds> = {
  id: 'styles/mechanism-fragmentation',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations'] },
  severity: 'high',
  message: META['styles/mechanism-fragmentation'].message,
  docs: META['styles/mechanism-fragmentation'].docs,
  thresholds: META['styles/mechanism-fragmentation'].thresholds,
  samples: META['styles/mechanism-fragmentation'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveStylesConfig(ctx.thresholds);
    const declarations = flattenDeclarations(ctx.facts['style-declarations']);
    return flagPropertyValueFragmentation(declarations, cfg.mechanismFragmentationMinMechanisms, makeFinding);
  },
};

const mechanismMixing: RuleDefinition<StylesNeeds> = {
  id: 'styles/mechanism-mixing',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations'] },
  severity: 'high',
  message: META['styles/mechanism-mixing'].message,
  docs: META['styles/mechanism-mixing'].docs,
  thresholds: META['styles/mechanism-mixing'].thresholds,
  samples: META['styles/mechanism-mixing'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveStylesConfig(ctx.thresholds);
    const declarations = flattenDeclarations(ctx.facts['style-declarations']);
    return flagFileMechanismMixing(declarations, cfg.mechanismFragmentationMinMechanisms, makeFinding);
  },
};

const declarationSetSimilarity: RuleDefinition<StylesNeeds> = {
  id: 'styles/declaration-set-similarity',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations'] },
  severity: 'high',
  message: META['styles/declaration-set-similarity'].message,
  docs: META['styles/declaration-set-similarity'].docs,
  thresholds: META['styles/declaration-set-similarity'].thresholds,
  samples: META['styles/declaration-set-similarity'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveStylesConfig(ctx.thresholds);
    const declarations = flattenDeclarations(ctx.facts['style-declarations']);
    return detectDeclarationSetSimilarity(declarations, cfg, makeFinding);
  },
};

const zIndexSprawl: RuleDefinition<StylesNeeds> = {
  id: 'styles/z-index-sprawl',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations'] },
  severity: 'high',
  message: META['styles/z-index-sprawl'].message,
  docs: META['styles/z-index-sprawl'].docs,
  thresholds: META['styles/z-index-sprawl'].thresholds,
  samples: META['styles/z-index-sprawl'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveStylesConfig(ctx.thresholds);
    const declarations = flattenDeclarations(ctx.facts['style-declarations']);
    return detectZIndexSprawl(groupDeclarationsByProperty(declarations), cfg, makeFinding);
  },
};

const zIndexSingleton: RuleDefinition<StylesNeeds> = {
  id: 'styles/z-index-singleton',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations'] },
  severity: 'high',
  message: META['styles/z-index-singleton'].message,
  docs: META['styles/z-index-singleton'].docs,
  thresholds: META['styles/z-index-singleton'].thresholds,
  samples: META['styles/z-index-singleton'].samples,
  analyze(ctx): Finding[] {
    const declarations = flattenDeclarations(ctx.facts['style-declarations']);
    return detectZIndexSingletons(groupDeclarationsByProperty(declarations), makeFinding);
  },
};

// ── Detector 9: Undefined Class ─────────────────────────────────────────────
//
// Re-homed verbatim from `UniversalStylesAnalyzer.collectUndefinedClassCandidates`
// / `flagUnresolvedClasses` / `createDefinedClassSuggester`, but against the
// camelCase `StylesClassUsage` + `DefinedClassesFact` facts instead of the
// snake_case DB rows and the batched `IN (...)` index lookup. The `defined-classes`
// producer already loads the full catalog (one row per class name), so membership
// and near-miss are in-memory over that fact — the same full-catalog scan the
// legacy suggester ran (`createDefinedClassSuggester` loads the whole table once).
//
// The compile-probe is the one piece that does not cross: the rule's
// `AnalysisContext` has no `projectRoot`, so `expander.init` never builds the
// probe and `resolve()` degrades to `customClasses` + `BASE_UTILITIES` +
// structural patterns — identical to the legacy path under the production
// reducer (which also passed no `projectRoot`).

/** Suggests the nearest defined class (within edit distance 2) for one name. */
type DefinedClassSuggester = (name: string) => { name: string; filePath: string } | null;

/** Levenshtein edit distance, capped by the length gap (mirrors
 *  `UniversalStylesAnalyzer.levenshteinDistance` / schema `codeAnalysis.ts`). */
function levenshteinDistance(a: string, b: string, maxDist: number): number {
  if (Math.abs(a.length - b.length) > maxDist) return Infinity;
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/** Full-catalog near-miss lookup over the `defined-classes` fact, ceiling 2 edits. */
function suggestDefinedClass(definedClasses: readonly DefinedClassesFact[]): DefinedClassSuggester {
  return (name: string) => {
    const lower = name.toLowerCase();
    let best: { name: string; filePath: string } | null = null;
    let bestDist = Infinity;
    for (const c of definedClasses) {
      const dist = levenshteinDistance(lower, c.className.toLowerCase(), 2);
      if (dist < bestDist) {
        bestDist = dist;
        best = { name: c.className, filePath: c.filePath };
      }
    }
    return bestDist <= 2 ? best : null;
  };
}

/** Filter class-usage rows down to candidates worth resolving — the static skip
 *  filters distinguishing definitions, known classes, and extraction artifacts
 *  from genuine consumptions of an unknown class. The `definedClasses` argument is
 *  always empty at the call site (the defined check is the deferred `definedSet`
 *  membership in `undefinedClassRule.analyze`), matching the legacy path. */
function collectUndefinedClassCandidates(
  classUsage: readonly StylesClassUsage[],
  definedClasses: Set<string>,
): { candidates: string[]; usageEntries: StylesClassUsage[] } {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const usageEntries: StylesClassUsage[] = [];

  for (const u of classUsage) {
    const key = `${u.className}::${u.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (u.unresolvable) continue;
    if (u.mechanism === 'class' && /\.(css|scss)$/i.test(u.filePath)) continue;
    if (definedClasses.has(u.className)) continue;
    if (/^[A-Z]/.test(u.className)) continue;
    if (u.className.includes('(')) continue;
    if (/^\d/.test(u.className)) continue;
    if (u.className.startsWith('[') || u.className.startsWith(']')) continue;
    if (u.className.endsWith('[') || u.className.endsWith(']')) continue;
    if (/['`"${}?;!@#%^&*+=<>|\\,~]/.test(u.className)) continue;

    usageEntries.push(u);
    candidates.push(u.className);
  }

  return { candidates, usageEntries };
}

/** Flag unresolved class names: a near-miss of a defined class upgrades to a
 *  `severe` rename finding; a non-near-miss is a coverage gap that the legacy
 *  path reports off-ladder (`undefined-class-not-found`) — no `Finding` shape
 *  exists for it here, so the migrated rule drops it (the diagnostic stays on the
 *  legacy path until §15). */
function flagUnresolvedClasses(
  usageEntries: readonly StylesClassUsage[],
  expander: TailwindUtilityExpander,
  report: StylesViolationReporter,
  suggest: DefinedClassSuggester,
): Finding[] {
  const findings: Finding[] = [];
  for (const u of usageEntries) {
    const resolved = expander.resolve(u.className);
    if (resolved.valid) continue;

    const nearest = suggest(expander.stripVariantPrefix(u.className));
    if (nearest) {
      findings.push(report(
        u.filePath,
        u.line,
        `Class "${u.className}" was not found in any read stylesheet or ` +
        `utility set — did you mean "${nearest.name}"` +
        `${nearest.filePath ? ` (defined in ${nearest.filePath})` : ''}?`,
        {
          severity: 'severe',
          rule: 'styles/undefined-class',
          symbol: u.className,
          resolution: {
            action: 'use-defined-class',
            summary: `Rename "${u.className}" to the defined class "${nearest.name}"${nearest.filePath ? ` (defined in ${nearest.filePath})` : ''}.`,
            symbols: [nearest.name],
            files: [u.filePath, nearest.filePath],
            lines: [u.line],
          },
        },
      ));
    }
  }
  return findings;
}

/** The config surface `undefined-class` reads (the `tailwindClasses` custom set
 *  that seeds the expander's validation cache when no compile-probe is present). */
interface UndefinedClassConfig {
  tailwindClasses?: string[];
}

function resolveUndefinedClassConfig(t: ThresholdValues): UndefinedClassConfig {
  const tailwindClasses = (t as Record<string, unknown>).tailwindClasses;
  return { tailwindClasses: Array.isArray(tailwindClasses) ? (tailwindClasses as string[]) : undefined };
}

/** `styles/undefined-class` reads the class-usage half of `style-declarations`
 *  plus the corpus `defined-classes` catalog and the `unread-style-sources`
 *  list — a different fact set than the eight rules above, so it carries its
 *  own `Needs` tuple. The unread-source list is carried on each finding as
 *  `details.incompleteDefinitions` (Spec 45 R5). */
type UndefinedClassNeeds = {
  readonly formats: readonly ['css', 'scss', 'typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['style-declarations', 'defined-classes', 'unread-style-sources'];
};

export const undefinedClassRule: RuleDefinition<UndefinedClassNeeds> = {
  id: 'styles/undefined-class',
  analyzer: 'styles',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations', 'defined-classes', 'unread-style-sources'] },
  severity: 'severe',
  message: META['styles/undefined-class'].message,
  docs: META['styles/undefined-class'].docs,
  thresholds: META['styles/undefined-class'].thresholds,
  samples: META['styles/undefined-class'].samples,
  async analyze(ctx): Promise<Finding[]> {
    const classUsage = flattenClassUsage(ctx.facts['style-declarations']);
    const definedClasses = ctx.facts['defined-classes'];
    // The parity test drives the rule with a raw ctx that omits the corpus fact;
    // default it so the rule degrades to a plain undefined-class result there.
    const unread = ctx.facts['unread-style-sources'] ?? [];

    const { usageEntries } = collectUndefinedClassCandidates(classUsage, new Set());
    const definedSet = new Set(definedClasses.map((d) => d.className));
    const unresolved = usageEntries.filter((u) => !definedSet.has(u.className));

    const expander = getTailwindExpander();
    const cfg = resolveUndefinedClassConfig(ctx.thresholds);
    await expander.init({
      projectRoot: undefined,
      useProjectConfig: true,
      customClasses: cfg.tailwindClasses ? new Set(cfg.tailwindClasses) : undefined,
    });

    const findings = flagUnresolvedClasses(unresolved, expander, makeFinding, suggestDefinedClass(definedClasses));

    // Spec 45 R5 — "undefined" reads as "not defined in any *read* stylesheet":
    // attach the unread-source list so a near-miss typo names the dialect(s) the
    // indexer could not parse, rather than asserting the class truly absent.
    if (unread.length > 0) {
      const incompleteDefinitions = unread.map((s) =>
        s.reason ? `${s.filePath} (${s.reason})` : s.filePath,
      );
      for (const f of findings) {
        f.details = { incompleteDefinitions };
      }
    }
    return findings;
  },
};

/** The eight pure-data styles rules this slice migrates, in registry order.
 *  `undefined-class` is exported separately (`undefinedClassRule`) — its
 *  `needs` adds the corpus `defined-classes` fact, so it cannot share this
 *  `StylesNeeds` array's tuple type. `value-drift` (Spec 69 R4) likewise reads
 *  the derived `color-values` fact, so the array's element type is the union of
 *  the two `Needs` aliases rather than a single one. */
export const stylesRules: readonly RuleDefinition<StylesNeeds | ValueDriftNeeds>[] = [
  valueDrift,
  offScale,
  tokenBypass,
  mechanismFragmentation,
  mechanismMixing,
  declarationSetSimilarity,
  zIndexSprawl,
  zIndexSingleton,
];
