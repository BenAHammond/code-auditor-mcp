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

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import type { AnalyzerResult, Violation } from '../../types.js';
import type { AST, LanguageAdapter } from '../../languages/types.js';
import { CodeIndexDB } from '../../codeIndexDB.js';
import type {
  NormalizedDeclaration,
  NormalizedValue,
  NormalizedColor,
  NormalizedLength,
  StyleToken,
  StyleClassUsage,
} from '../../styles/types.js';
import type { StylesAnalyzerConfig } from '../../types.js';

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
// Tailwind v4 default spacing scale (px equivalents)
// ---------------------------------------------------------------------------

const TAILWIND_SPACING_PX: Record<string, number> = {
  '0': 0, 'px': 1, '0.5': 2,
  '1': 4, '2': 8, '3': 12, '4': 16,
  '5': 20, '6': 24, '7': 28, '8': 32,
  '9': 36, '10': 40, '11': 44, '12': 48,
  '14': 56, '16': 64, '20': 80, '24': 96,
  '28': 112, '32': 128, '36': 144, '40': 160,
  '44': 176, '48': 192, '52': 208, '56': 224,
  '60': 240, '64': 256, '72': 288, '80': 320,
  '96': 384,
};

const TAILWIND_SCALE_VALUES = Object.values(TAILWIND_SPACING_PX).sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface StyleDeclRow {
  id: number;
  property: string;
  raw_value: string;
  normalized_value: string | null;
  mechanism: string;
  file_path: string;
  line: number;
  context: string | null;
  variant_context: string | null;
  token_ref: string | null;
  content_hash: string;
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

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export class UniversalStylesAnalyzer extends UniversalAnalyzer {
  readonly name = 'styles';
  readonly description =
    'Detects style fragmentation, value drift, token bypass, dead classes, ' +
    'off-scale values, mechanism mixing, declaration-set similarity, and z-index sprawl';
  readonly category = 'style';

  /**
   * Override analyze() to query the full style index in one pass instead
   * of per-file AST processing. The base class analyze() loop is bypassed.
   */
  async analyze(
    files: string[],
    config: any = {},
    options: any = {},
  ): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const cfg: StylesAnalyzerConfig = { ...DEFAULT_STYLES_CONFIG, ...config };
    const violations: Violation[] = [];

    // Open DB from the project root
    let rawDb: any = null;
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      rawDb = (db as any).rawDb;
    } catch {
      return {
        violations: [],
        errors: [{ file: '', error: 'Failed to open style index database' }],
        filesProcessed: 0,
        executionTime: Date.now() - startTime,
        metrics: { filesAnalyzed: 0, totalViolations: 0, executionTime: Date.now() - startTime },
      };
    }

    if (!rawDb) {
      return {
        violations: [],
        errors: [],
        filesProcessed: 0,
        executionTime: Date.now() - startTime,
        metrics: { filesAnalyzed: 0, totalViolations: 0, executionTime: Date.now() - startTime },
      };
    }

    // Query all declarations, tokens, and class usage
    const declarations = this.queryDeclarations(rawDb);
    const tokens = this.queryTokens(rawDb);
    const classUsage = this.queryClassUsage(rawDb);

    if (declarations.length === 0) {
      return {
        violations: [],
        errors: [],
        filesProcessed: files.length,
        executionTime: Date.now() - startTime,
        metrics: { filesAnalyzed: files.length, totalViolations: 0, executionTime: Date.now() - startTime },
      };
    }

    // Build helpers
    const tokenValueMap = new Map<string, string>();  // normalized value → token name
    for (const t of tokens) {
      tokenValueMap.set(t.value, t.name);
    }

    // Declarations by property
    const byProperty = new Map<string, StyleDeclRow[]>();
    for (const d of declarations) {
      const list = byProperty.get(d.property) || [];
      list.push(d);
      byProperty.set(d.property, list);
    }

    // Run detectors
    violations.push(...this.detectValueDrift(byProperty, cfg, declarations));
    violations.push(...this.detectOffScaleValues(byProperty, cfg));
    violations.push(...this.detectUndefinedClasses(classUsage, declarations, byProperty));
    violations.push(...this.detectTokenBypass(declarations, tokenValueMap, cfg));
    violations.push(...this.detectMechanismFragmentation(declarations, cfg));
    violations.push(...this.detectDeclarationSetSimilarity(declarations, cfg));
    violations.push(...this.detectZIndexInventory(byProperty, cfg));

    // Apply severity overrides from config
    const severityOverrides: Record<string, string> = config.severityOverrides ?? {};
    if (Object.keys(severityOverrides).length > 0) {
      for (const v of violations) {
        const override = severityOverrides[v.rule];
        if (override) {
          v.severity = override as 'critical' | 'warning' | 'suggestion';
        }
      }
    }

    const filtered = violations.filter(v => v.severity !== 'off');

    return {
      violations: filtered,
      errors: [],
      filesProcessed: files.length,
      executionTime: Date.now() - startTime,
      metrics: {
        filesAnalyzed: files.length,
        totalViolations: filtered.length,
        executionTime: Date.now() - startTime,
      },
    };
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

  private queryDeclarations(rawDb: any): StyleDeclRow[] {
    try {
      return rawDb.prepare(
        'SELECT * FROM style_declarations ORDER BY property, file_path, line',
      ).all() as StyleDeclRow[];
    } catch {
      return [];
    }
  }

  private queryTokens(rawDb: any): StyleTokenRow[] {
    try {
      return rawDb.prepare('SELECT * FROM style_tokens').all() as StyleTokenRow[];
    } catch {
      return [];
    }
  }

  private queryClassUsage(rawDb: any): StyleClassUsageRow[] {
    try {
      return rawDb.prepare('SELECT * FROM style_class_usage').all() as StyleClassUsageRow[];
    } catch {
      return [];
    }
  }

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
  private detectValueDrift(
    byProperty: Map<string, StyleDeclRow[]>,
    cfg: StylesAnalyzerConfig,
    allDecls: StyleDeclRow[],
  ): Violation[] {
    const violations: Violation[] = [];

    for (const [property, decls] of byProperty) {
      if (decls.length < cfg.minCorpus) continue;

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

  private isColorProperty(property: string): boolean {
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
  private detectColorDrift(
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

    // Cluster by delta-E
    const clusters = this.clusterByDeltaE(colors, cfg.colorDeltaE);

    // Find the dominant cluster (largest)
    clusters.sort((a, b) => b.length - a.length);
    const dominant = clusters[0];
    if (!dominant || dominant.length < cfg.modeMinCount) return violations;

    const dominantSize = dominant.length;

    // Flag stragglers in non-dominant clusters
    for (let i = 1; i < clusters.length; i++) {
      const cluster = clusters[i];
      const share = cluster.length / colors.length;

      if (share < cfg.outlierMaxShare && dominantSize >= cfg.modeMinCount) {
        // Report once per distinct color value in the straggler cluster
        const seenValues = new Set<string>();
        for (const item of cluster) {
          const normVal = item.decl.raw_value.toLowerCase();
          if (seenValues.has(normVal)) continue;
          seenValues.add(normVal);

          violations.push(this.makeViolation(
            item.decl.file_path,
            item.decl.line,
            `Color drift in "${property}": "${item.decl.raw_value}" is a rare value ` +
            `(used ${cluster.length} time${cluster.length === 1 ? '' : 's'}, ` +
            `${(share * 100).toFixed(1)}% of ${colors.length} usages). ` +
            `Dominant cluster has ${dominantSize} values. Consider using a design token.`,
            'warning',
            'styles/value-drift',
            'color',
          ));
        }
      }
    }

    return violations;
  }

  /**
   * Exact-value drift for non-color properties.
   */
  private detectExactValueDrift(
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

    // Find the mode (most frequent value)
    let modeKey = '';
    let modeCount = 0;
    for (const [key, list] of histogram) {
      if (list.length > modeCount) {
        modeCount = list.length;
        modeKey = key;
      }
    }

    if (modeCount < cfg.modeMinCount) return violations;

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
          `The dominant value "${modeKey}" is used ${modeCount} times. ` +
          `Consider using a consistent value or design token.`,
          'warning',
          'styles/value-drift',
          'exact',
        ));
      }
    }

    return violations;
  }

  // -----------------------------------------------------------------------
  // Detector 2: Off-Scale Values
  // -----------------------------------------------------------------------

  /**
   * For scale-family properties (margin, padding, gap, font-size),
   * infer the project scale from modal values + Tailwind defaults,
   * and flag values that don't fit the scale.
   */
  private detectOffScaleValues(
    byProperty: Map<string, StyleDeclRow[]>,
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];

    for (const property of cfg.scaleProperties) {
      const decls = byProperty.get(property);
      if (!decls || decls.length < cfg.minCorpus) continue;

      // Parse values to px-equivalent numbers
      const parsed: Array<{ decl: StyleDeclRow; px: number }> = [];
      for (const d of decls) {
        const px = this.parseLengthToPx(d.raw_value);
        if (px !== null) {
          parsed.push({ decl: d, px });
        }
      }

      if (parsed.length < cfg.minCorpus) continue;

      // Infer the project scale step
      const step = this.inferScaleStep(parsed.map(p => p.px));
      if (step === null || step === 0) continue;

      // Flag off-scale values
      for (const { decl, px } of parsed) {
        const remainder = px % step;
        // Allow near-zero remainders (floating point tolerance: < 1px)
        if (Math.abs(remainder) > 1 && Math.abs(remainder - step) > 1) {
          violations.push(this.makeViolation(
            decl.file_path,
            decl.line,
            `Off-scale "${property}" value: "${decl.raw_value}" (${px}px) ` +
            `does not align with the inferred ${step}px scale step. ` +
            `Nearby scale values: ${Math.floor(px / step) * step}px or ` +
            `${Math.ceil(px / step) * step}px.`,
            'warning',
            'styles/off-scale',
          ));
        }
      }
    }

    return violations;
  }

  /**
   * Infer the dominant scale step from a set of px values.
   * Uses the Tailwind scale as candidate steps.
   */
  private inferScaleStep(values: number[]): number | null {
    if (values.length < 3) return null;

    // Count how many values align with each tailwind step
    const candidates = [2, 4, 8, 16];
    let bestStep = 4;
    let bestScore = 0;

    for (const step of candidates) {
      let score = 0;
      for (const v of values) {
        if (v % step === 0) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestStep = step;
      }
    }

    // Require at least 60% alignment
    if (bestScore / values.length < 0.6) return null;
    return bestStep;
  }

  // -----------------------------------------------------------------------
  // Detector 3: Undefined Classes
  // -----------------------------------------------------------------------

  /**
   * Flag CSS classes used in markup that have no matching definition in
   * any CSS/SCSS file. Files with unresolvable class usage are exempted.
   */
  private detectUndefinedClasses(
    classUsage: StyleClassUsageRow[],
    _declarations: StyleDeclRow[],
    byProperty: Map<string, StyleDeclRow[]>,
  ): Violation[] {
    const violations: Violation[] = [];

    // Collect all defined class names from CSS declarations
    // (context field contains selectors like ".btn-primary")
    const definedClasses = new Set<string>();
    for (const [, decls] of byProperty) {
      for (const d of decls) {
        const ctx = d.context;
        if (!ctx) continue;
        // Extract class selectors from context
        const matches = ctx.matchAll(/\.([a-zA-Z0-9_-]+)/g);
        for (const m of matches) {
          definedClasses.add(m[1]);
        }
      }
    }

    // Also add common Tailwind utilities
    const tailwindUtils = new Set([
      'flex', 'grid', 'block', 'inline', 'hidden', 'relative', 'absolute',
      'fixed', 'sticky', 'static', 'container', 'w-full', 'h-full',
      'text-sm', 'text-base', 'text-lg', 'text-xl', 'font-bold', 'font-normal',
      'bg-white', 'bg-black', 'rounded', 'rounded-lg', 'shadow', 'shadow-md',
      'p-4', 'm-4', 'gap-4', 'border', 'cursor-pointer', 'hover',
      'text-center', 'text-left', 'items-center', 'justify-between',
    ]);

    // Track files with unresolvable class usage (dynamic classes)
    const unresolvableFiles = new Set<string>();
    for (const u of classUsage) {
      if (u.unresolvable) {
        unresolvableFiles.add(u.file_path);
      }
    }

    // Check each class usage
    const seen = new Set<string>(); // deduplicate by (className, filePath)
    for (const u of classUsage) {
      const key = `${u.class_name}::${u.file_path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip unresolvable files
      if (unresolvableFiles.has(u.file_path)) continue;

      // Skip known classes
      if (definedClasses.has(u.class_name)) continue;
      if (tailwindUtils.has(u.class_name)) continue;

      // Skip pseudo-class/variant selectors (hover:, focus:, sm:, etc.)
      if (u.class_name.includes(':')) continue;

      // Skip common HTML attributes and dynamic-looking classes
      if (/^[A-Z]/.test(u.class_name)) continue; // PascalCase — likely a component
      if (u.class_name.includes('[') || u.class_name.includes(']')) continue; // arbitrary values
      if (u.class_name.includes('(')) continue; // function-like
      if (/^\d/.test(u.class_name)) continue; // numeric

      violations.push(this.makeViolation(
        u.file_path,
        u.line,
        `Undefined CSS class: "${u.class_name}" has no matching definition ` +
        `in any stylesheet or Tailwind utility set.`,
        'warning',
        'styles/undefined-class',
      ));
    }

    return violations;
  }

  // -----------------------------------------------------------------------
  // Detector 4: Token Bypass
  // -----------------------------------------------------------------------

  /**
   * Flag raw values that match a known design token's value but don't
   * reference the token via tokenRef.
   */
  private detectTokenBypass(
    declarations: StyleDeclRow[],
    tokenValueMap: Map<string, string>,
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];
    if (tokenValueMap.size === 0) return violations;

    for (const d of declarations) {
      // Skip if already referencing a token
      if (d.token_ref) continue;

      // Normalize the raw value for comparison
      const normalized = this.normalizeForTokenMatch(d.raw_value);
      const tokenName = tokenValueMap.get(normalized);
      if (!tokenName) continue;

      violations.push(this.makeViolation(
        d.file_path,
        d.line,
        `Token bypass: "${d.raw_value}" for "${d.property}" matches design ` +
        `token "${tokenName}" but was used as a raw value. ` +
        `Use the token reference instead to keep styles consistent.`,
        'warning',
        'styles/token-bypass',
      ));
    }

    return violations;
  }

  /** Normalize a raw value for token-value comparison. */
  private normalizeForTokenMatch(raw: string): string {
    let v = raw.toLowerCase().trim();
    // Remove spaces after commas in functional notation
    v = v.replace(/,\s+/g, ',');
    // Expand shorthand hex: #fff → #ffffff
    if (/^#[0-9a-f]{3}$/.test(v)) {
      v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    return v;
  }

  // -----------------------------------------------------------------------
  // Detector 5: Mechanism Fragmentation
  // -----------------------------------------------------------------------

  /**
   * Flag when the same (property, value) is applied via ≥3 different
   * mechanisms across the codebase, or when a single file/component
   * mixes ≥3 different mechanisms.
   */
  private detectMechanismFragmentation(
    declarations: StyleDeclRow[],
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];

    // (A) Cross-file: same (property, raw_value) via ≥3 mechanisms
    const pvMap = new Map<string, Set<string>>(); // "property::value" → set of mechanisms
    const pvSample = new Map<string, StyleDeclRow>(); // keep one sample for reporting

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
      if (mechs.size < cfg.mechanismFragmentationMinMechanisms) continue;
      const sample = pvSample.get(key)!;
      const [prop, value] = key.split('::');
      violations.push(this.makeViolation(
        sample.file_path,
        sample.line,
        `Mechanism fragmentation: "${prop}: ${value}" is applied via ` +
        `${mechs.size} different mechanisms (${[...mechs].sort().join(', ')}). ` +
        `Consolidate to a single mechanism or design token.`,
        'warning',
        'styles/mechanism-fragmentation',
      ));
    }

    // (B) Per-file: a single file mixing ≥3 mechanisms
    const fileMechs = new Map<string, Set<string>>();
    for (const d of declarations) {
      const mechs = fileMechs.get(d.file_path) || new Set();
      mechs.add(d.mechanism);
      fileMechs.set(d.file_path, mechs);
    }

    for (const [file, mechs] of fileMechs) {
      if (mechs.size < cfg.mechanismFragmentationMinMechanisms) continue;
      violations.push(this.makeViolation(
        file,
        1,
        `Mechanism mixing: ${file} uses ${mechs.size} different style ` +
        `mechanisms (${[...mechs].sort().join(', ')}). ` +
        `Consolidate to fewer mechanisms for maintainability.`,
        'suggestion',
        'styles/mechanism-mixing',
      ));
    }

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
  private detectDeclarationSetSimilarity(
    declarations: StyleDeclRow[],
    cfg: StylesAnalyzerConfig,
  ): Violation[] {
    const violations: Violation[] = [];

    // Group declarations by (file, context) to form rule blocks
    const blocks = new Map<string, StyleDeclRow[]>();
    for (const d of declarations) {
      if (!d.context) continue;
      const key = `${d.file_path}::${d.context}`;
      const list = blocks.get(key) || [];
      list.push(d);
      blocks.set(key, list);
    }

    // Convert blocks to declaration-value sets
    const blockEntries = [...blocks.entries()]
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
      .filter(b => b.declCount >= cfg.declarationSetMinDeclarations);

    if (blockEntries.length < 2) return violations;

    // Compare pairs
    const reported = new Set<string>(); // "keyA::keyB"
    for (let i = 0; i < blockEntries.length; i++) {
      for (let j = i + 1; j < blockEntries.length; j++) {
        const a = blockEntries[i];
        const b = blockEntries[j];

        // Skip same-file same-context (already the same block) or same key
        if (a.key === b.key) continue;

        const pairKey = [a.key, b.key].sort().join('::');
        if (reported.has(pairKey)) continue;
        reported.add(pairKey);

        // Compute Jaccard similarity
        const intersection = new Set([...a.valueSet].filter(x => b.valueSet.has(x)));
        const union = new Set([...a.valueSet, ...b.valueSet]);
        const similarity = intersection.size / union.size;

        if (similarity >= cfg.declarationSetSimilarityThreshold) {
          violations.push(this.makeViolation(
            a.filePath,
            a.line,
            `Declaration-set similarity: "${a.context}" and "${b.context}" ` +
            `in ${b.filePath} share ${intersection.size} of ${union.size} ` +
            `declarations (${(similarity * 100).toFixed(0)}%). ` +
            `Consider consolidating these rules or extracting a shared mixin.`,
            'suggestion',
            'styles/declaration-set-similarity',
          ));
        }
      }
    }

    return violations;
  }

  // -----------------------------------------------------------------------
  // Detector 7: Z-Index Inventory
  // -----------------------------------------------------------------------

  /**
   * Z-index sprawl: flag when there are too many distinct z-index values,
   * suggesting a lack of a z-index scale/system.
   */
  private detectZIndexInventory(
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
        'warning',
        'styles/z-index-sprawl',
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
          'suggestion',
          'styles/z-index-singleton',
        ));
      }
    }

    return violations;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private makeViolation(
    filePath: string,
    line: number,
    message: string,
    severity: 'critical' | 'warning' | 'suggestion',
    rule: string,
    symbol?: string,
  ): Violation {
    const v: Violation = {
      file: filePath,
      line,
      column: 1,
      severity,
      message,
      rule,
      analyzer: this.name,
    };
    if (symbol) {
      v.functionName = symbol;
    }
    return v;
  }

  /** Parse a CSS color string to [R, G, B] or null. */
  private parseColorToRGB(raw: string): [number, number, number] | null {
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
  private deltaE(a: [number, number, number], b: [number, number, number]): number {
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
  private clusterByDeltaE(
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

  /** Parse a CSS length value to px-equivalent, or null if not parseable. */
  private parseLengthToPx(raw: string): number | null {
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
}
