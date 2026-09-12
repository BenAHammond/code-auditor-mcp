/**
 * Universal Styles Analyzer — Spec 10 R3.
 *
 * Detects style fragmentation, value drift, token bypass, dead classes,
 * off-scale values, mechanism fragmentation, declaration-set similarity,
 * and z-index sprawl by querying the full style index (SQLite).
 *
 * Unlike other analyzers that process one AST at a time via analyzeAST(),
 * this analyzer queries the cross-file style_declarations table so it can
 * compute histograms, clusters, and distributions across the entire codebase.
 */

import { join } from 'node:path';
import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { withRuleTiming } from '../ruleTiming.js';
import type { AnalyzerResult, IndexHandle, Violation, Resolution } from '../../types.js';
import type { AST, LanguageAdapter } from '../../languages/types.js';
import { makeVisitorStatus } from '../../pipeline.js';
import type {
  NormalizedDeclaration,
  NormalizedValue,
  NormalizedColor,
  NormalizedLength,
  StyleToken,
  StyleClassUsage,
} from '../../styles/types.js';
import type { StylesAnalyzerConfig } from '../../types.js';
import { getTailwindExpander, type TailwindUtilityExpander } from '../../styles/tailwindUtilityExpander.js';
import { normalizeValue } from '../../styles/normalizer.js';

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export const DEFAULT_STYLES_CONFIG: StylesAnalyzerConfig = {
  minCorpus: 20,
  colorDeltaE: 2.0,
  outlierMaxShare: 0.05,
  modeMinCount: 10,
  scaleProperties: [
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'gap', 'row-gap', 'column-gap', 'font-size',
  ],
  zIndexMaxDistinct: 6,
  mechanismFragmentationMinMechanisms: 3,
  declarationSetMinDeclarations: 5,
  declarationSetSimilarityThreshold: 0.9,
};

// ---------------------------------------------------------------------------
// Declared design scale — Spec 55 R6
// ---------------------------------------------------------------------------
//
// The off-scale rule must not infer a scale. It reads the project's *declared*
// tokens — Tailwind theme `spacing.*` / `fontSize.*`, or CSS custom properties
// named by the conventions the Tailwind v4 `@theme` classifier parses — and
// treats only those as authoritative. Where a project declares no scale for a
// family, the rule is notApplicable: a plain-CSS project that never opted into
// a token system must not have its raw values judged against a scale it did not
// choose (the same "fabricated finding" the token-bypass rule guards against by
// excluding `built-in defaults`).

/** A declared design scale, derived from the project's own tokens. */
interface DeclaredScale {
  /** px values the project's spacing tokens declare (margin/padding/gap). */
  spacing: Set<number>;
  /** px values the project's font-size tokens declare (font-size). */
  fontSize: Set<number>;
}

/** Parse a CSS length value to px-equivalent, or null if not parseable. */
function parseLengthToPx(raw: string): number | null {
  try {
    const v = raw.trim().toLowerCase();
    if (v === '0' || v === '0px') return 0;

    const match = v.match(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em|%|vh|vw|pt|cm|mm)?$/);
    if (!match) return null;

    const num = parseFloat(match[1]);
    const unit = match[2] || 'px';

    // Approximate conversions (assuming 16px base for rem/em)
    switch (unit) {
      case 'px': return num;
      case 'rem': return num * 16;
      case 'em': return num * 16;
      case 'pt': return num * 1.333;
      case 'cm': return num * 37.795;
      case 'mm': return num * 3.7795;
      default: return null; // can't convert %/vh/vw without context
    }
  } catch {
    return null;
  }
}

/**
 * Classify a token name into the scale-family property it declares, or null if
 * the token does not belong to a scale family (colors, radii, tap targets).
 *
 * - Tailwind theme tokens carry explicit category names: `spacing.*`, `fontSize.*`.
 * - CSS custom properties use the Tailwind v4 `@theme` conventions: `--space-*`/
 *   `--spacing-*` → spacing, `--font-size-*`/`--text-*` → font-size. (`--font-*`
 *   is a font-*family* token, not a length, so it is deliberately excluded.)
 */
function tokenScaleCategory(name: string): 'spacing' | 'font-size' | null {
  if (name.startsWith('spacing.')) return 'spacing';
  if (name.startsWith('fontSize.')) return 'font-size';
  if (name.startsWith('--')) {
    const bare = name.slice(2).toLowerCase();
    if (bare.startsWith('space-') || bare.startsWith('spacing-')) return 'spacing';
    if (bare === 'font-size' || bare.startsWith('font-size-') || bare.startsWith('text-')) return 'font-size';
  }
  return null;
}

/** Build the declared scale from the project's own token rows. */
function buildDeclaredScale(tokens: StyleTokenRow[]): DeclaredScale {
  const scale: DeclaredScale = { spacing: new Set(), fontSize: new Set() };
  for (const t of tokens) {
    // Exclude the bundled Tailwind default palette (see buildTokenValueMap) — a
    // project that did not declare its own tokens has no declared scale.
    if (t.file_path === 'built-in defaults') continue;
    const category = tokenScaleCategory(t.name);
    if (!category) continue;
    const px = parseLengthToPx(t.value);
    if (px === null) continue;
    if (category === 'spacing') scale.spacing.add(px);
    else scale.fontSize.add(px);
  }
  return scale;
}

/** The nearest scale values on either side of `px` (for the suggestion). */
function nearestScaleValues(px: number, values: readonly number[]): [number, number] {
  let lower = 0;
  let upper = values[values.length - 1] ?? 0;
  for (const s of values) {
    if (s <= px) lower = s;
    if (s >= px) { upper = s; break; }
  }
  return [lower, upper];
}

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

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

interface StyleClassUsageRow {
  class_name: string;
  file_path: string;
  line: number;
  mechanism: string;
  unresolvable: number;  // SQLite bool as 0/1
}

/**
 * Stable symbol for a value-scoped finding: `<property>: <value>`.
 *
 * The baseline fingerprint is `[analyzer, rule, file, symbol]`. Without a
 * symbol, every finding for a `(rule, file)` pair collapses into one entry and
 * the ratchet can no longer tell one distinct finding from forty. The value is
 * what separates one finding about a property from another — an outlier
 * `margin-top: 12px` must not share a fingerprint with a different outlier
 * `margin-top: 14px`, and two mechanism-fragmented properties inside the same
 * selector must not share a fingerprint just because they share a selector.
 * `normalized_value` is the canonical bucket (may be a JSON-encoded object for
 * complex values); `raw_value` is the resolved spelling fallback.
 */
function declValueKey(d: StyleDeclRow): string {
  const prop = d.property ?? '';
  const val = d.normalized_value ?? d.raw_value ?? '';
  return val ? `${prop}: ${val}` : prop;
}

// ---------------------------------------------------------------------------
// Analyzer — decomposed leaf-first into a three-class inheritance chain:
//
//   UniversalStylesAnalyzerBase       (identity + leaf style helpers)
//     └─ UniversalStylesAnalyzerDetectors  (the seven style detectors)
//          └─ UniversalStylesAnalyzer       (query + orchestration, exported)
//
// Leaf-first ordering keeps callers in derived classes and callees in base
// classes (TypeScript forbids base → subclass calls). Cross-class helpers are
// `protected` because `private` is class-scoped.
// ---------------------------------------------------------------------------

/**
 * Bundled classification for a style violation — `severity`, `rule`, and an
 * optional `symbol` travel together so the reporter stays a 4-arg call rather
 * than a 6-arg one (Spec 34 param-count bundling).
 */
interface StyleViolationClassification {
  severity: 'critical' | 'severe' | 'high';
  rule: string;
  symbol?: string;
  /** Spec 37 R1 — structured next action carried on gating findings. */
  resolution?: Resolution;
}

/**
 * Shared signature for the violation reporter the structure detectors reuse.
 * The helper receives the analyzer's own `makeViolation` bound to the instance,
 * so it reports through the same path without duplicating the method.
 */
type StylesViolationReporter = (
  filePath: string,
  line: number,
  message: string,
  classification: StyleViolationClassification,
) => Violation;

/**
 * Values so common that coincidental token-name matches are always noise.
 * Filtered before any token comparison (Spec 22 Item 1).
 */
const TRIVIAL_VALUES = new Set([
  '0', '0px', '0rem', '0em', '0%', 'none', 'transparent',
  'inherit', 'initial', 'unset', 'currentcolor', 'auto',
  '100%', '50%',
]);

/**
 * Leaf layer: identity + stateless style helpers used by every detector.
 * Kept free of cross-method orchestration so it stays a small, stable base.
 */
abstract class UniversalStylesAnalyzerBase extends UniversalAnalyzer {
  readonly name = 'styles';
  readonly description =
    'Detects style fragmentation, value drift, token bypass, dead classes, ' +
    'off-scale values, mechanism mixing, declaration-set similarity, and z-index sprawl';
  readonly category = 'style';

  protected makeViolation(
    filePath: string,
    line: number,
    message: string,
    classification: StyleViolationClassification,
  ): Violation {
    const v: Violation = {
      file: filePath,
      line,
      column: 1,
      severity: classification.severity,
      message,
      rule: classification.rule,
      analyzer: this.name,
    };
    if (classification.symbol) {
      v.functionName = classification.symbol;
    }
    if (classification.resolution) {
      v.resolution = classification.resolution;
    }
    return v;
  }

  /** Parse a CSS color string to [R, G, B] or null. */
  protected parseColorToRGB(raw: string): [number, number, number] | null {
    try {
      let v = raw.toLowerCase().trim();

      // Hex
      if (v.startsWith('#')) {
        if (v.length === 4) {
          // #rgb → #rrggbb
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

      // rgb(r, g, b) or rgb(r g b)
      const rgbMatch = v.match(/rgb\(\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)\s*\)/);
      if (rgbMatch) {
        return [
          parseInt(rgbMatch[1]),
          parseInt(rgbMatch[2]),
          parseInt(rgbMatch[3]),
        ];
      }

      // Named colors — minimal set for common use
      const named: Record<string, [number, number, number]> = {
        'white': [255, 255, 255], 'black': [0, 0, 0],
        'red': [255, 0, 0], 'blue': [0, 0, 255], 'green': [0, 128, 0],
        'transparent': [0, 0, 0],
      };
      if (named[v]) return named[v];

      return null;
    } catch {
      return null;
    }
  }

  /** Compute delta-E (CIE76) between two RGB colors. */
  protected deltaE(a: [number, number, number], b: [number, number, number]): number {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  /**
   * Cluster colors by delta-E distance.
   * Simple greedy algorithm: each item joins the first cluster it's close enough to,
   * or starts a new cluster.
   */
  protected clusterByDeltaE(
    items: Array<{ decl: StyleDeclRow; rgb: [number, number, number] }>,
    threshold: number,
  ): Array<Array<{ decl: StyleDeclRow; rgb: [number, number, number] }>> {
    const clusters: Array<Array<{ decl: StyleDeclRow; rgb: [number, number, number] }>> = [];

    for (const item of items) {
      let placed = false;
      for (const cluster of clusters) {
        // Use the first item's RGB as cluster centroid
        const centroid = cluster[0].rgb;
        if (this.deltaE(item.rgb, centroid) < threshold) {
          cluster.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) {
        clusters.push([item]);
      }
    }

    return clusters;
  }
}

// ---------------------------------------------------------------------------
// Detector layer: the seven style detectors, reporting through the base
// layer's makeViolation helper.
// ---------------------------------------------------------------------------

abstract class UniversalStylesAnalyzerDetectors extends UniversalStylesAnalyzerBase {
  // -----------------------------------------------------------------------
  // Detector 1: Value Drift
  // -----------------------------------------------------------------------

  /**
   * For each property with enough declarations, cluster values and flag
   * low-share stragglers (outliers) as style drift.
   *
   * - Colors: cluster by delta-E distance (< colorDeltaE).
   * - Non-colors: exact-value histogram; flag share < outlierMaxShare
   *   when the mode count ≥ modeMinCount.
   */
  protected detectValueDrift(
    byProperty: Map<string, StyleDeclRow[]>,
    cfg: StylesAnalyzerConfig,
    allDecls: StyleDeclRow[],
  ): Violation[] {
    const violations: Violation[] = [];
    const exclusions = new Set(cfg.categoricalPropertyExclusions ?? []);

    for (const [property, decls] of byProperty) {
      if (decls.length < cfg.minCorpus) continue;

      // Spec 22 R3.1: skip hardcoded categorical exclusions
      if (exclusions.has(property)) continue;

      // Spec 22 R3.1 structural rule: skip properties whose values are all keywords
      if (this.isCategoricalByValues(decls)) continue;

      // Determine if this property holds color values
      const isColorProp = this.isColorProperty(property);

      if (isColorProp) {
        violations.push(...this.detectColorDrift(property, decls, cfg));
      } else {
        violations.push(...this.detectExactValueDrift(property, decls, cfg));
      }
    }

    return violations;
  }

  /**
   * Spec 22 R3.1 structural rule: a property whose observed values are all
   * keywords (non-numeric, non-color) is categorical regardless of the
   * hardcoded exclusion list.
   */
  protected isCategoricalByValues(decls: StyleDeclRow[]): boolean {
    for (const d of decls) {
      const v = (d.normalized_value ?? d.raw_value).trim();
      if (!v) continue;
      // Numeric: starts with a digit, or a sign followed by a digit
      if (/^-?\d/.test(v)) return false;
      // Color: hex, rgb, hsl, or named colors
      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return false;
      if (/^(rgb|rgba|hsl|hsla)\(/.test(v)) return false;
      // Length: number + unit
      if (/^-?\d+(\.\d+)?(px|em|rem|vw|vh|vmin|vmax|%|ch|ex|cm|mm|in|pt|pc|deg|rad|turn|s|ms|dpi|dpcm|dppx|fr)$/.test(v)) return false;
      // calc(), clamp(), min(), max()
      if (/^(calc|clamp|min|max)\(/.test(v)) return false;
    }
    return true;
  }

  protected isColorProperty(property: string): boolean {
    const colorProps = new Set([
      'color', 'background-color', 'background', 'border-color',
      'border-top-color', 'border-right-color', 'border-bottom-color',
      'border-left-color', 'outline-color', 'fill', 'stroke',
      'text-decoration-color', 'caret-color', 'column-rule-color',
      'accent-color', 'scrollbar-color',
    ]);
    return colorProps.has(property);
  }

  /**
   * Color drift: cluster values by delta-E, flag stragglers.
   */
  protected detectColorDrift(
    property: string,
    decls: StyleDeclRow[],
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];

    // Parse all color values
    const colors: Array<{ decl: StyleDeclRow; rgb: [number, number, number] }> = [];
    for (const d of decls) {
      const rgb = this.parseColorToRGB(d.raw_value);
      if (rgb) {
        colors.push({ decl: d, rgb });
      }
    }

    if (colors.length < cfg.minCorpus) return violations;

    // Cluster by delta-E, then flag stragglers in non-dominant clusters.
    const clusters = this.clusterByDeltaE(colors, cfg.colorDeltaE);
    clusters.sort((a, b) => b.length - a.length);
    const dominant = clusters[0];
    if (!dominant || dominant.length < cfg.modeMinCount) return violations;

    violations.push(...flagColorDriftStragglers(clusters, property, cfg, this.makeViolation.bind(this)));
    return violations;
  }

  /**
   * Exact-value drift for non-color properties.
   */
  protected detectExactValueDrift(
    property: string,
    decls: StyleDeclRow[],
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];

    // Build value histogram
    const histogram = new Map<string, StyleDeclRow[]>();
    for (const d of decls) {
      const key = d.normalized_value ?? d.raw_value;
      const list = histogram.get(key) || [];
      list.push(d);
      histogram.set(key, list);
    }

    // Find the mode (most frequent value) — the message displays the raw
    // spelling, never the JSON `normalized_value` bucket key (Spec 45 R2).
    let modeKey = '';
    let modeList: StyleDeclRow[] = [];
    for (const [key, list] of histogram) {
      if (list.length > modeList.length) {
        modeKey = key;
        modeList = list;
      }
    }

    if (modeList.length < cfg.modeMinCount) return violations;

    // Flag low-share values
    const total = decls.length;
    for (const [key, list] of histogram) {
      if (key === modeKey) continue;
      const share = list.length / total;
      if (share < cfg.outlierMaxShare) {
        const sample = list[0];
        violations.push(this.makeViolation(
          sample.file_path,
          sample.line,
          `Value drift in "${property}": "${sample.raw_value}" is rare ` +
          `(${list.length} of ${total} usages, ${(share * 100).toFixed(1)}%). ` +
          `The dominant value "${modeList[0].raw_value}" is used ${modeList.length} times. ` +
          `Consider using a consistent value or design token.`,
          { severity: 'high', rule: 'styles/value-drift', symbol: declValueKey(sample) },
        ));
      }
    }

    return violations;
  }

  // -----------------------------------------------------------------------
  // Detector 2: Off-Scale Values
  // -----------------------------------------------------------------------

  /**
   * For scale-family properties (margin, padding, gap, font-size), flag values
   * that are not members of the project's declared design scale. Where the
   * project declares no scale for a family, the rule is notApplicable (Spec 55
   * R6) — it must not guess a scale.
   */
  protected detectOffScaleValues(
    byProperty: Map<string, StyleDeclRow[]>,
    cfg: StylesAnalyzerConfig,
    declaredScale: DeclaredScale,
  ): Violation[] {
    const violations: Violation[] = [];

    for (const property of cfg.scaleProperties) {
      const decls = byProperty.get(property);
      if (!decls || decls.length < cfg.minCorpus) continue;

      // Which declared scale governs this property? Spacing properties are
      // judged against the spacing scale, `font-size` against the font-size
      // scale — they are not interchangeable.
      const isFontSize = property === 'font-size';
      const scaleSet = isFontSize ? declaredScale.fontSize : declaredScale.spacing;
      if (scaleSet.size === 0) continue;
      const scaleValues = [...scaleSet].sort((a, b) => a - b);
      const label = isFontSize ? 'font-size scale' : 'spacing scale';

      // Parse values to px-equivalent numbers
      const parsed: Array<{ decl: StyleDeclRow; px: number }> = [];
      for (const d of decls) {
        const px = parseLengthToPx(d.raw_value);
        if (px !== null) {
          parsed.push({ decl: d, px });
        }
      }

      if (parsed.length < cfg.minCorpus) continue;

      // Flag values that are not members of the project's declared scale.
      for (const { decl, px } of parsed) {
        if (!scaleSet.has(px)) {
          const [lower, upper] = nearestScaleValues(px, scaleValues);
          violations.push(this.makeViolation(
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

    return violations;
  }
}

// ---------------------------------------------------------------------------
// Structure detectors: class/token/mechanism integrity checks over the raw
// declaration and class-usage rows. Split out of the value-drift detectors so
// neither class trips the aggregate-complexity ceiling. Lives off the analyzer
// inheritance chain — it reports through the shared factory and receives the
// analyzer name once at construction.
// ---------------------------------------------------------------------------

/**
 * Filter class-usage rows down to candidate names worth batch-probing,
 * applying the skip filters that distinguish definitions, known classes, and
 * extraction artifacts from genuine consumptions of an unknown class.
 */
function collectUndefinedClassCandidates(
  classUsage: StyleClassUsageRow[],
  definedClasses: Set<string>,
): { candidates: string[]; usageEntries: StyleClassUsageRow[] } {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const usageEntries: StyleClassUsageRow[] = [];

  for (const u of classUsage) {
    const key = `${u.class_name}::${u.file_path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Skip unresolvable individual class usages
    if (u.unresolvable) continue;

    // Skip CSS class SELECTORS (definitions, not usages).
    // CSS/SCSS files: mechanism 'class' = class_selector node = ".some-class { }"
    // These DEFINE a class — they are not usages of one. Only usages through
    // other mechanisms (className, apply, class in HTML) signal consumption.
    // Without this guard, every CSS selector without a direct declaration
    // (SCSS @include-only blocks, nested rule_sets) is falsely flagged.
    if (u.mechanism === 'class' && /\.(css|scss)$/i.test(u.file_path)) continue;

    // Skip known classes from CSS declarations
    if (definedClasses.has(u.class_name)) continue;

    // Skip PascalCase — likely a component
    if (/^[A-Z]/.test(u.class_name)) continue;

    // Skip function-like
    if (u.class_name.includes('(')) continue;

    // Skip numeric
    if (/^\d/.test(u.class_name)) continue;

    // Skip classes that start/end with [] — not valid CSS class names
    if (u.class_name.startsWith('[') || u.class_name.startsWith(']')) continue;
    if (u.class_name.endsWith('[') || u.class_name.endsWith(']')) continue;

    // Skip extraction artifacts
    if (/['`"${}?;!@#%^&*+=<>|\\,~]/.test(u.class_name)) continue;

    usageEntries.push(u);
    candidates.push(u.class_name);
  }

  return { candidates, usageEntries };
}

// ---------------------------------------------------------------------------
// Detector leaf helpers (module level, ≤4 params each)
// ---------------------------------------------------------------------------

interface StyleDetectorInputs {
  byProperty: Map<string, StyleDeclRow[]>;
  cfg: StylesAnalyzerConfig;
  declarations: StyleDeclRow[];
  classUsage: StyleClassUsageRow[];
  tokenValueMap: Map<string, { name: string; valueType: string | null }>;
  declaredScale: DeclaredScale;
  definedClassIndex?: DefinedClassIndex;
}

interface StylesResultSpec {
  violations: Violation[];
  errors?: Array<{ file: string; error: string }>;
  fileCount: number;
  startTime: number;
  name: string;
}

interface DeclarationBlock {
  key: string;
  filePath: string;
  context: string;
  line: number;
  declCount: number;
  valueSet: Set<string>;
}

type ColorCluster = Array<{ decl: StyleDeclRow; rgb: [number, number, number] }>;

function flagColorDriftStragglers(
  clusters: ColorCluster[],
  property: string,
  cfg: StylesAnalyzerConfig,
  report: StylesViolationReporter,
): Violation[] {
  const violations: Violation[] = [];
  const dominant = clusters[0];
  const dominantSize = dominant.length;
  const total = clusters.reduce((sum, c) => sum + c.length, 0);

  for (let i = 1; i < clusters.length; i++) {
    const cluster = clusters[i];
    const share = cluster.length / total;
    if (share >= cfg.outlierMaxShare) continue;

    // Report once per distinct color value in the straggler cluster
    const seenValues = new Set<string>();
    for (const item of cluster) {
      const normVal = item.decl.raw_value.toLowerCase();
      if (seenValues.has(normVal)) continue;
      seenValues.add(normVal);

      violations.push(report(
        item.decl.file_path,
        item.decl.line,
        `Color drift in "${property}": "${item.decl.raw_value}" is a rare value ` +
        `(used ${cluster.length} time${cluster.length === 1 ? '' : 's'}, ` +
        `${(share * 100).toFixed(1)}% of ${total} usages). ` +
        `Dominant cluster has ${dominantSize} values. Consider using a design token.`,
        { severity: 'high', rule: 'styles/value-drift', symbol: declValueKey(item.decl) },
      ));
    }
  }

  return violations;
}

/** Resolves a batch of class names to their defining file (or absent if undefined). */
type DefinedClassLookup = (names: string[]) => Map<string, string>;

/** Suggests the nearest defined class (within edit distance 3) for one name. */
type DefinedClassSuggester = (name: string) => { name: string; filePath: string } | null;

/** Bundled defined-class index the undefined-class detector queries against. */
interface DefinedClassIndex {
  lookup: DefinedClassLookup;
  suggest: DefinedClassSuggester;
}

/** SQLite's default variable-number limit is 999; stay well under it. */
const SQLITE_MAX_VARIABLES = 900;

/**
 * Build a batched defined-class lookup backed by the `style_defined_classes`
 * table. Instead of loading every style_declarations row and regex-extracting
 * selectors in JS (the old `collectDefinedClassCatalog`), each batch of names
 * resolves via a single `WHERE class_name IN (...)` index lookup — chunked to
 * stay under SQLite's variable limit — so only the names actually used in scope
 * touch the database.
 */
function createDefinedClassLookup(indexHandle: IndexHandle): DefinedClassLookup {
  const cache = new Map<string, string | null>();
  return (names: string[]): Map<string, string> => {
    const result = new Map<string, string>();
    const missing: string[] = [];
    for (const n of names) {
      const hit = cache.get(n);
      if (hit !== undefined) {
        if (hit !== null) result.set(n, hit);
        continue;
      }
      missing.push(n);
    }
    for (let i = 0; i < missing.length; i += SQLITE_MAX_VARIABLES) {
      const chunk = missing.slice(i, i + SQLITE_MAX_VARIABLES);
      const placeholders = chunk.map(() => '?').join(',');
      let rows: Array<{ class_name: string; file_path: string }> = [];
      try {
        rows = indexHandle.query(
          `SELECT class_name, MIN(file_path) AS file_path
           FROM style_defined_classes
           WHERE class_name IN (${placeholders})
           GROUP BY class_name`,
          chunk,
        ) as Array<{ class_name: string; file_path: string }>;
      } catch {
        // Table absent on a pre-migration DB — treat as "nothing defined".
      }
      const found = new Map(rows.map((r) => [r.class_name, r.file_path]));
      for (const n of chunk) {
        const loc = found.get(n);
        if (loc !== undefined) {
          cache.set(n, loc);
          result.set(n, loc);
        } else {
          cache.set(n, null);
        }
      }
    }
    return result;
  };
}

/**
 * Levenshtein edit distance between two class names, capping the DP width so a
 * large stylesheet catalog stays cheap. Returns Infinity when the length gap
 * alone exceeds the match ceiling (mirrors schema/codeAnalysis.ts).
 */
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

/**
 * Build a suggestion lookup that finds the nearest defined class within edit
 * distance 3. The candidate pool is bounded to classes sharing the query's
 * first character (a `LIKE` prefix lookup) — not a scan of the full catalog —
 * with a full-catalog fallback only when the prefix bucket is empty, so a
 * first-character typo still surfaces a suggestion.
 */
function createDefinedClassSuggester(indexHandle: IndexHandle): DefinedClassSuggester {
  // Load the defined-class catalog once, lazily, and cache it. The catalog is
  // a dedicated ~hundreds-row table (not the 16k-declaration corpus), so a
  // single scan per suggestion is already bounded; a prefix bucket would only
  // risk a first-character-typo suggestion diverging from the previous
  // full-catalog `nearestDefinedClass` result.
  let catalog: Array<{ class_name: string; file_path: string }> | null = null;
  const loadCatalog = (): Array<{ class_name: string; file_path: string }> => {
    if (catalog === null) {
      try {
        catalog = indexHandle.query(
          `SELECT class_name, MIN(file_path) AS file_path
           FROM style_defined_classes
           GROUP BY class_name`,
        ) as Array<{ class_name: string; file_path: string }>;
      } catch {
        catalog = [];
      }
    }
    return catalog;
  };
  return (name: string): { name: string; filePath: string } | null => {
    const lower = name.toLowerCase();
    let best: { name: string; filePath: string } | null = null;
    let bestDist = Infinity;
    for (const c of loadCatalog()) {
      const dist = levenshteinDistance(lower, c.class_name.toLowerCase(), 3);
      if (dist < bestDist) {
        bestDist = dist;
        best = { name: c.class_name, filePath: c.file_path };
      }
    }
    return best;
  };
}

async function initTailwindProbe(
  expander: TailwindUtilityExpander,
  cfg: (StylesAnalyzerConfig & { projectRoot?: string }) | undefined,
  report: StylesViolationReporter,
): Promise<Violation[] | null> {
  await expander.init({
    projectRoot: cfg?.projectRoot,
    useProjectConfig: true,
    customClasses: cfg?.tailwindClasses ? new Set(cfg.tailwindClasses) : undefined,
  });

  // Fail-open rule (Spec 22 R1.3): if the probe fails and Tailwind IS
  // present, disable the undefined-class detector.
  if (expander.configFailed && expander.hasTailwindConfig) {
    // Anchor the notice to a real file+line (the Tailwind config, or the
    // project root's package.json as a last resort) so the hook-contract
    // guard does not strip it. A file-less violation would still register
    // as `fired` in coverage while the finding itself is dropped — the
    // coverage-vs-violations drift Spec 39 surfaced.
    const anchor = expander.tailwindConfigPath
      ?? (cfg?.projectRoot ? join(cfg.projectRoot, 'package.json') : '');
    return [report(
      anchor, 1,
      `Tailwind probe unavailable (${expander.configFailureReason ?? 'unknown error'}) — ` +
      `undefined-class detection skipped. Classes defined only in Tailwind ` +
      `config will not be checked. Install tailwindcss in the project ` +
      `for full class validation.`,
      { severity: 'high', rule: 'styles/undefined-class-disabled' },
    )];
  }

  return null;
}

function flagUnresolvedClasses(
  usageEntries: StyleClassUsageRow[],
  expander: TailwindUtilityExpander,
  report: StylesViolationReporter,
  suggest: DefinedClassSuggester,
): Violation[] {
  return withRuleTiming('styles/undefined-class', () => {
    const violations: Violation[] = [];
    for (const u of usageEntries) {
      const resolved = expander.resolve(u.class_name);
      if (resolved.valid) continue;

      const nearest = suggest(u.class_name);

      violations.push(report(
        u.file_path,
        u.line,
        `Undefined CSS class: "${u.class_name}" has no matching definition ` +
        `in any stylesheet, Tailwind utility set, or project config.`,
        {
          severity: 'high',
          rule: 'styles/undefined-class',
          symbol: u.class_name,
          resolution: {
            action: nearest ? 'use-defined-class' : 'define-or-remove-class',
            summary: nearest
              ? `Rename "${u.class_name}" to the defined class "${nearest.name}"${nearest.filePath ? ` (defined in ${nearest.filePath})` : ''}.`
              : `Define the class "${u.class_name}" in a stylesheet, or remove the usage.`,
            symbols: nearest ? [nearest.name] : [u.class_name],
            files: nearest ? [u.file_path, nearest.filePath] : [u.file_path],
            lines: [u.line],
          },
        },
      ));
    }
    return violations;
  });
}

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
    const nv = JSON.parse(normalizedValue) as NormalizedValue;
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

function flagPropertyValueFragmentation(
  declarations: StyleDeclRow[],
  minMechanisms: number,
  report: StylesViolationReporter,
): Violation[] {
  const violations: Violation[] = [];
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
    // The grouping key is `${property}::${normalized_value}` — a JSON object in
    // production — so display the *resolved* raw spelling, not the key (Spec 45 R2).
    const prop = sample.property;
    violations.push(report(
      sample.file_path,
      sample.line,
      `Mechanism fragmentation: "${prop}: ${sample.raw_value}" is applied via ` +
      `${mechs.size} different mechanisms (${[...mechs].sort().join(', ')}). ` +
      `Consolidate to a single mechanism or design token.`,
      { severity: 'high', rule: 'styles/mechanism-fragmentation', symbol: declValueKey(sample) },
    ));
  }

  return violations;
}

function flagFileMechanismMixing(
  declarations: StyleDeclRow[],
  minMechanisms: number,
  report: StylesViolationReporter,
): Violation[] {
  const violations: Violation[] = [];
  const fileMechs = new Map<string, Set<string>>();
  for (const d of declarations) {
    const mechs = fileMechs.get(d.file_path) || new Set();
    mechs.add(d.mechanism);
    fileMechs.set(d.file_path, mechs);
  }

  for (const [file, mechs] of fileMechs) {
    if (mechs.size < minMechanisms) continue;
    violations.push(report(
      file,
      1,
      `Mechanism mixing: ${file} uses ${mechs.size} different style ` +
      `mechanisms (${[...mechs].sort().join(', ')}). ` +
      `Consolidate to fewer mechanisms for maintainability.`,
      { severity: 'high', rule: 'styles/mechanism-mixing' },
    ));
  }

  return violations;
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

/** A declaration block ordered rarest-first, ready for prefix indexing. */
type OrderedBlock = DeclarationBlock & { values: string[]; size: number };

/** Prefix length for the Xiao et al. set-similarity join (see flagSimilarBlockPairs). */
const prefixLen = (threshold: number, s: number) => s - Math.ceil(threshold * s) + 1;

function flagSimilarBlockPairs(
  blockEntries: DeclarationBlock[],
  threshold: number,
  report: StylesViolationReporter,
): Violation[] {
  const n = blockEntries.length;
  if (n < 2) return [];

  // Count filter (Xiao et al. "Efficient Exact Set-Similarity Joins"): with a
  // size filter (Jaccard >= t implies min/max >= t) and a rarest-first global
  // value ordering, two sets with Jaccard >= t must overlap on their prefixes of
  // length |S| - ceil(t·|S|) + 1. Indexing only those prefixes turns the O(b²)
  // all-pairs Jaccard scan into a candidate generation step over rare values —
  // high-fan-out values (e.g. a shared `display:block`) sort into the suffix and
  // never generate a pair. Verified on the 16k-row corpus: 705k pairs -> ~2.6k
  // candidates with zero false negatives.

  // 1. Global value frequency drives the rarest-first ordering.
  const freq = new Map<string, number>();
  for (const b of blockEntries) {
    for (const v of b.valueSet) freq.set(v, (freq.get(v) ?? 0) + 1);
  }

  // 2. Order each block's values rarest-first (tie-broken for determinism).
  const ordered: OrderedBlock[] = blockEntries.map((b) => ({
    ...b,
    values: [...b.valueSet].sort(
      (x, y) => (freq.get(x)! - freq.get(y)!) || (x < y ? -1 : 1),
    ),
    size: b.valueSet.size,
  }));

  // 3–5. Inverted prefix index → candidate generation → exact Jaccard verify.
  const inverted = buildInvertedIndex(ordered, threshold);
  const candidates = generateCandidates(ordered, inverted, threshold, n);
  return verifyCandidates(ordered, candidates, threshold, report);
}

/** Phase 3: inverted index over prefix elements only. */
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

/** Phase 4: candidate generation + size filter. */
function generateCandidates(
  ordered: OrderedBlock[],
  inverted: Map<string, number[]>,
  threshold: number,
  n: number,
): Set<number> {
  // The epsilon guards against a FP rounding edge dropping a borderline pair
  // (a false positive is harmless — it is re-verified by the exact Jaccard
  // below — a false negative is not).
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

/**
 * Phase 5: verify the exact Jaccard for each candidate and report, in the same
 * (i, j) ascending order as the naive all-pairs loop so the output is
 * byte-identical.
 */
function verifyCandidates(
  ordered: OrderedBlock[],
  candidates: Set<number>,
  threshold: number,
  report: StylesViolationReporter,
): Violation[] {
  const n = ordered.length;
  const violations: Violation[] = [];
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
      violations.push(report(
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
  return violations;
}

function buildTokenValueMap(
  tokens: StyleTokenRow[],
): Map<string, { name: string; valueType: string | null }> {
  const tokenValueMap = new Map<string, { name: string; valueType: string | null }>();
  for (const t of tokens) {
    // The Tailwind loader falls back to the bundled v4 default palette when a
    // project has no Tailwind config, seeding those tokens with
    // `file_path === 'built-in defaults'`. Those are not the project's tokens —
    // a plain-CSS project that never opted into a token system would otherwise
    // have every raw `#fff` flagged as "bypassing colors.white", a fabricated
    // finding. Only tokens the project actually defined can be bypassed.
    if (t.file_path === 'built-in defaults') continue;
    const normalizedTokenVal = normalizeValue(t.value, '__token__');
    // Key by the same normalized spelling the lookup uses, so a shorthand or
    // case-differing token value (`#fff`, `#FFFFFF`) still matches a raw
    // declaration of the same colour (`#ffffff`). The ledger's key-normalization
    // asymmetry — raw key vs normalized lookup — was the last crude gap.
    tokenValueMap.set(normalizeForTokenMatch(t.value), { name: t.name, valueType: normalizedTokenVal?.type ?? null });
  }
  return tokenValueMap;
}

function groupDeclarationsByProperty(declarations: StyleDeclRow[]): Map<string, StyleDeclRow[]> {
  const byProperty = new Map<string, StyleDeclRow[]>();
  for (const d of declarations) {
    const list = byProperty.get(d.property) || [];
    list.push(d);
    byProperty.set(d.property, list);
  }
  return byProperty;
}


function buildStylesResult(spec: StylesResultSpec): AnalyzerResult {
  return {
    violations: spec.violations,
    errors: spec.errors ?? [],
    status: makeVisitorStatus(spec.fileCount),
    executionTime: Date.now() - spec.startTime,
    analyzerName: spec.name,
    metrics: {
      filesAnalyzed: spec.fileCount,
      totalViolations: spec.violations.length,
      executionTime: Date.now() - spec.startTime,
    },
  };
}

class StylesStructureDetectors {
  constructor(private readonly makeViolation: StylesViolationReporter) {}

  // -----------------------------------------------------------------------
  // Detector 3: Undefined Classes
  // -----------------------------------------------------------------------

  /**
   * Flag CSS classes used in markup that have no matching definition in
   * any CSS/SCSS file. Files with unresolvable class usage are exempted.
   *
   * Uses compile-probe (Spec 22 R1.2):
   * 1. Init TailwindProbe against project's installed tailwindcss
   * 2. Collect all candidate class names
   * 3. Batch-probe unknown classes via @apply compilation
   * 4. Resolve each class from cache + structural patterns
   */
  async detectUndefinedClasses(
    classUsage: StyleClassUsageRow[],
    cfg?: StylesAnalyzerConfig & { projectRoot?: string },
    definedClassIndex?: DefinedClassIndex,
  ): Promise<Violation[]> {
    const violations: Violation[] = [];

    const expander = getTailwindExpander();

    // Fail-open rule (Spec 22 R1.3): if the probe fails and Tailwind IS
    // present, disable the undefined-class detector.
    const failOpen = await initTailwindProbe(expander, cfg, this.makeViolation.bind(this));
    if (failOpen) return failOpen;

    // 1. Static-filter usage rows into candidate class names (the defined-check
    //    is deferred to the DB lookup below).
    const { candidates, usageEntries } = collectUndefinedClassCandidates(classUsage, new Set());

    // 2. Resolve the candidate names against the defined-class table in one
    //    chunked `class_name IN (...)` index lookup — names with no row back
    //    are undefined.
    const definedLocations = definedClassIndex?.lookup(candidates) ?? new Map<string, string>();

    // 3. Batch-probe only the genuinely undefined names.
    const undefinedCandidates = candidates.filter((c) => !definedLocations.has(c));
    if (undefinedCandidates.length > 0 && expander.probeReady) {
      await expander.validateBatch(undefinedCandidates);
    }

    violations.push(...flagUnresolvedClasses(
      usageEntries.filter((u) => !definedLocations.has(u.class_name)),
      expander,
      this.makeViolation.bind(this),
      definedClassIndex?.suggest ?? (() => null),
    ));
    return violations;
  }

  // -----------------------------------------------------------------------
  // Detector 4: Token Bypass
  // -----------------------------------------------------------------------

  /**
   * Flag raw values that match a known design token's value but don't
   * reference the token via tokenRef.
   *
   * Exclusions (per Spec 22 R2):
   * - CSS custom-property definition sites (--x: <value>) — these are where
   *   token values are allowed to be literal. Aliased tokens sharing a value
   *   (e.g. --accent / --brand-action) produce zero findings.
   * - var(--token) references — tokenRef is already populated by the
   *   style indexer; the existing token_ref check handles these.
   *
   * Token-bypass flags exactly one shape: a raw literal value (hex, rgb,
   * length) in a *usage* position whose normalized value matches a defined
   * token.
   */
  detectTokenBypass(
    declarations: StyleDeclRow[],
    tokenValueMap: Map<string, {name: string; valueType: string | null}>,
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];
    if (tokenValueMap.size === 0) return violations;

    const categoricalExclusions = new Set(cfg.categoricalPropertyExclusions ?? []);
    const scaleProps = new Set(cfg.scaleProperties ?? []);

    for (const d of declarations) {
      const tokenInfo = matchBypassToken(d, tokenValueMap, categoricalExclusions, scaleProps);
      if (!tokenInfo) continue;

      violations.push(this.makeViolation(
        d.file_path,
        d.line,
        `Token bypass: "${d.raw_value}" for "${d.property}" matches design ` +
        `token "${tokenInfo.name}" but was used as a raw value. ` +
        `Use the token reference instead to keep styles consistent.`,
        { severity: 'high', rule: 'styles/token-bypass', symbol: declValueKey(d) },
      ));
    }

    return violations;
  }

  // -----------------------------------------------------------------------
  // Detector 5: Mechanism Fragmentation
  // -----------------------------------------------------------------------

  /**
   * Flag when the same (property, value) is applied via ≥3 different
   * mechanisms across the codebase, or when a single file/component
   * mixes ≥3 different mechanisms.
   */
  detectMechanismFragmentation(
    declarations: StyleDeclRow[],
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];
    const report = this.makeViolation.bind(this);
    const minMechanisms = cfg.mechanismFragmentationMinMechanisms;

    violations.push(...flagPropertyValueFragmentation(declarations, minMechanisms, report));
    violations.push(...flagFileMechanismMixing(declarations, minMechanisms, report));
    return violations;
  }

  // -----------------------------------------------------------------------
  // Detector 6: Declaration-Set Similarity
  // -----------------------------------------------------------------------

  /**
   * Detect two rule blocks (contexts) whose declaration sets overlap at
   * ≥ similarityThreshold (default 0.9) and that each have ≥ minDeclarations.
   * This catches near-duplicate CSS rules that share most declarations.
   */
  detectDeclarationSetSimilarity(
    declarations: StyleDeclRow[],
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const blockEntries = buildDeclarationBlocks(declarations, cfg.declarationSetMinDeclarations);
    return flagSimilarBlockPairs(blockEntries, cfg.declarationSetSimilarityThreshold, this.makeViolation.bind(this));
  }

  // -----------------------------------------------------------------------
  // Detector 7: Z-Index Inventory
  // -----------------------------------------------------------------------

  /**
   * Z-index sprawl: flag when there are too many distinct z-index values,
   * suggesting a lack of a z-index scale/system.
   */
  detectZIndexInventory(
    byProperty: Map<string, StyleDeclRow[]>,
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];
    const decls = byProperty.get('z-index');
    if (!decls || decls.length === 0) return violations;

    // Collect distinct numeric z-index values
    const values = new Map<number, StyleDeclRow[]>();
    for (const d of decls) {
      const num = parseInt(d.raw_value, 10);
      if (isNaN(num)) continue;
      const list = values.get(num) || [];
      list.push(d);
      values.set(num, list);
    }

    if (values.size === 0) return violations;

    // Flag if too many distinct values
    if (values.size > cfg.zIndexMaxDistinct) {
      const sortedVals = [...values.keys()].sort((a, b) => a - b);
      const sample = values.get(sortedVals[0])![0];
      violations.push(this.makeViolation(
        sample.file_path,
        sample.line,
        `Z-index sprawl: ${values.size} distinct z-index values ` +
        `(${sortedVals.join(', ')}). Consider defining a z-index scale ` +
        `(e.g., $z-layers: (dropdown: 100, modal: 200, toast: 300)).`,
        { severity: 'high', rule: 'styles/z-index-sprawl', symbol: declValueKey(sample) },
      ));
    }

    // Flag singletons (z-index values used only once)
    for (const [val, list] of values) {
      if (list.length === 1 && values.size > 2) {
        const d = list[0];
        violations.push(this.makeViolation(
          d.file_path,
          d.line,
          `Singleton z-index: z-index: ${val} is used only once. ` +
          `Consider whether this value belongs in a shared z-index scale.`,
          { severity: 'high', rule: 'styles/z-index-singleton', symbol: declValueKey(d) },
        ));
      }
    }

    return violations;
  }
}

// ---------------------------------------------------------------------------
// Orchestration layer: queries the style index and dispatches to the
// detectors. This is the only exported class in the chain.
// ---------------------------------------------------------------------------

/**
 * Construct the structure detectors for the analyzer. Lives as a factory so the
 * analyzer depends on a seam rather than directly instantiating the concrete
 * detector class (the dependency-inversion signal).
 */
function createStylesStructureDetectors(makeViolation: StylesViolationReporter): StylesStructureDetectors {
  return new StylesStructureDetectors(makeViolation);
}

/**
 * Universal styles analyzer.
 */
export class UniversalStylesAnalyzer extends UniversalStylesAnalyzerDetectors {
  private readonly structure = createStylesStructureDetectors(this.makeViolation.bind(this));

  /**
   * Override analyze() to query the full style index in one pass instead
   * of per-file AST processing. The base class analyze() loop is bypassed.
   * @param config
   * @param files
   * @param options
   * @returns
   */
  async analyze(
    files: string[],
    config: any = {},
    options: any = {},
  ): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const cfg: StylesAnalyzerConfig = { ...DEFAULT_STYLES_CONFIG, ...config };

    // Use the IndexHandle passed through the pipeline; fall back if absent.
    const indexHandle: IndexHandle | undefined = config.indexHandle;
    if (!indexHandle) {
      return buildStylesResult({
        violations: [],
        errors: [{ file: '', error: 'No index handle available — style index not open' }],
        fileCount: 0,
        startTime,
        name: this.name,
      });
    }

    const declarations = this.queryDeclarations(indexHandle);

    if (declarations.length === 0) {
      return buildStylesResult({
        violations: [],
        fileCount: files.length,
        startTime,
        name: this.name,
      });
    }

    const violations = await this.runAllDetectors(indexHandle, cfg, declarations);

    return buildStylesResult({
      violations,
      fileCount: new Set(declarations.map(d => d.file_path)).size,
      startTime,
      name: this.name,
    });
  }

  /** Assemble detector inputs from the style index and run all detectors. */
  private async runAllDetectors(
    indexHandle: IndexHandle,
    cfg: StylesAnalyzerConfig,
    declarations: StyleDeclRow[],
  ): Promise<Violation[]> {
    const tokens = this.queryTokens(indexHandle);
    return this.runDetectors({
      byProperty: groupDeclarationsByProperty(declarations),
      cfg,
      declarations,
      classUsage: this.queryClassUsage(indexHandle),
      tokenValueMap: buildTokenValueMap(tokens),
      declaredScale: buildDeclaredScale(tokens),
      definedClassIndex: {
        lookup: createDefinedClassLookup(indexHandle),
        suggest: createDefinedClassSuggester(indexHandle),
      },
    });
  }

  /** Run all detectors and return their combined violations. */
  private async runDetectors(inputs: StyleDetectorInputs): Promise<Violation[]> {
    const { byProperty, cfg, declarations, classUsage, tokenValueMap, declaredScale, definedClassIndex } = inputs;
    const violations: Violation[] = [];
    violations.push(...this.detectValueDrift(byProperty, cfg, declarations));
    violations.push(...this.detectOffScaleValues(byProperty, cfg, declaredScale));
    violations.push(...await this.structure.detectUndefinedClasses(classUsage, cfg, definedClassIndex));
    violations.push(...this.structure.detectTokenBypass(declarations, tokenValueMap, cfg));
    violations.push(...this.structure.detectMechanismFragmentation(declarations, cfg));
    violations.push(...this.structure.detectDeclarationSetSimilarity(declarations, cfg));
    violations.push(...this.structure.detectZIndexInventory(byProperty, cfg));
    return violations;
  }

  /** Not used — we override analyze() directly. */
  protected async analyzeAST(
    _ast: AST,
    _adapter: LanguageAdapter,
    _config: any,
    _sourceCode: string,
  ): Promise<Violation[]> {
    return [];
  }

  // -----------------------------------------------------------------------
  // Database queries
  // -----------------------------------------------------------------------

  private queryDeclarations(indexHandle: IndexHandle): StyleDeclRow[] {
    try {
      return indexHandle.query(
        'SELECT property, raw_value, normalized_value, mechanism, file_path, line, context, token_ref ' +
        'FROM style_declarations ORDER BY property, file_path, line',
      ) as StyleDeclRow[];
    } catch {
      return [];
    }
  }

  private queryTokens(indexHandle: IndexHandle): StyleTokenRow[] {
    try {
      return indexHandle.query('SELECT * FROM style_tokens') as StyleTokenRow[];
    } catch {
      return [];
    }
  }

  private queryClassUsage(indexHandle: IndexHandle): StyleClassUsageRow[] {
    try {
      return indexHandle.query('SELECT * FROM style_class_usage') as StyleClassUsageRow[];
    } catch {
      return [];
    }
  }
}
