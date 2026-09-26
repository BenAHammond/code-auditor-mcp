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
 * `undefined-class` (severity 'severe') is *not* here: it reads `classUsage` and
 * a defined-class catalog plus a Tailwind compile-probe, none of which is a pure
 * function of the fact. It is DEFERRED and stays on the legacy path until its
 * own inputs land.
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
  ThresholdValues,
} from '../types.js';
import type { Severity, Resolution } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
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

const COLOR_KEYWORDS = new Set([
  'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none',
]);

function rgbToLab([r, g, b]: [number, number, number]): [number, number, number] {
  const linear = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);

  const x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
  const z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;

  const XN = 0.95047;
  const YN = 1.0;
  const ZN = 1.08883;
  const EPSILON = 0.008856;
  const KAPPA = 903.3;
  const f = (t: number): number =>
    t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
  const fx = f(x / XN);
  const fy = f(y / YN);
  const fz = f(z / ZN);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function parseColorToRGB(raw: string): [number, number, number] | null {
  try {
    let v = raw.toLowerCase().trim();

    if (COLOR_KEYWORDS.has(v)) return null;

    if (v.startsWith('#')) {
      if (v.length === 4) {
        v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      }
      if (v.length === 7) {
        return [
          parseInt(v.slice(1, 3), 16),
          parseInt(v.slice(3, 5), 16),
          parseInt(v.slice(5, 7), 16),
        ];
      }
      if (v.length === 9) {
        return [
          parseInt(v.slice(1, 3), 16),
          parseInt(v.slice(3, 5), 16),
          parseInt(v.slice(5, 7), 16),
        ];
      }
    }

    const rgbMatch = v.match(/rgb\(\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)\s*\)/);
    if (rgbMatch) {
      return [
        parseInt(rgbMatch[1]),
        parseInt(rgbMatch[2]),
        parseInt(rgbMatch[3]),
      ];
    }

    const named: Record<string, [number, number, number]> = {
      'white': [255, 255, 255], 'black': [0, 0, 0],
      'red': [255, 0, 0], 'blue': [0, 0, 255], 'green': [0, 128, 0],
    };
    if (named[v]) return named[v];

    return null;
  } catch {
    return null;
  }
}

function deltaE(a: [number, number, number], b: [number, number, number]): number {
  const [la, aa, ba] = rgbToLab(a);
  const [lb, ab, bb] = rgbToLab(b);
  const dl = la - lb;
  const da = aa - ab;
  const db = ba - bb;
  return Math.sqrt(dl * dl + da * da + db * db);
}

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
  decl: StyleDeclRow;
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
      if (distance(values[i].rgb, values[j].rgb) < threshold) {
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
      const d = distance(member.rgb, canonical.rgb);
      out.push(report(
        member.decl.file_path,
        member.decl.line,
        `Color drift in "${property}": "${member.value}" is near-identical to "${canonical.value}" ` +
        `(used ${canonical.count} time${canonical.count === 1 ? '' : 's'}, ΔE = ${d.toFixed(2)}). ` +
        `Consider using "${canonical.value}".`,
        { severity: 'high', rule: 'styles/value-drift', symbol: declValueKey(member.decl) },
      ));
    }
  }
  return out;
}

function detectColorDrift(
  property: string,
  decls: StyleDeclRow[],
  cfg: StylesConfig,
  report: StylesViolationReporter,
): Finding[] {
  const byRgb = new Map<string, ColorValue>();
  for (const d of decls) {
    const rgb = parseColorToRGB(d.raw_value);
    if (!rgb) continue;
    const key = rgb.join(',');
    const existing = byRgb.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byRgb.set(key, { value: d.raw_value, rgb, decl: d, count: 1 });
    }
  }
  const values = [...byRgb.values()];
  const clusters = clusterDistinctColors(values, cfg.colorDeltaE, deltaE);
  const drift = clusters.filter((c) => c.length >= 2);
  if (drift.length === 0) return [];
  return flagColorDriftMembers(drift, property, report, deltaE);
}

function detectValueDrift(
  byProperty: Map<string, StyleDeclRow[]>,
  cfg: StylesConfig,
  report: StylesViolationReporter,
): Finding[] {
  const out: Finding[] = [];
  const exclusions = new Set(cfg.categoricalPropertyExclusions ?? []);
  for (const [property, decls] of byProperty) {
    if (exclusions.has(property)) continue;
    if (isCategoricalByValues(decls)) continue;
    if (isColorProperty(property)) {
      out.push(...detectColorDrift(property, decls, cfg, report));
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

const valueDrift: RuleDefinition<StylesNeeds> = {
  id: 'styles/value-drift',
  needs: { formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'], facts: ['style-declarations'] },
  severity: 'high',
  message: META['styles/value-drift'].message,
  docs: META['styles/value-drift'].docs,
  thresholds: META['styles/value-drift'].thresholds,
  samples: META['styles/value-drift'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveStylesConfig(ctx.thresholds);
    const declarations = flattenDeclarations(ctx.facts['style-declarations']);
    return detectValueDrift(groupDeclarationsByProperty(declarations), cfg, makeFinding);
  },
};

const offScale: RuleDefinition<StylesNeeds> = {
  id: 'styles/off-scale',
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

/** The eight styles rules this slice migrates, in registry order. */
export const stylesRules: readonly RuleDefinition<StylesNeeds>[] = [
  valueDrift,
  offScale,
  tokenBypass,
  mechanismFragmentation,
  mechanismMixing,
  declarationSetSimilarity,
  zIndexSprawl,
  zIndexSingleton,
];
