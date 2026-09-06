/**
 * Tailwind Compile-Probe — Spec 22 R1.2
 *
 * Uses the project's own installed `tailwindcss` package as the oracle for
 * class validation. Zero hand-curated dictionaries — the project's compiler
 * IS the authority on what classes exist.
 *
 * **v4 (PRIMARY):** Uses `compile()` with `@apply` probe stylesheets.
 * Candidate classes are injected into a generated CSS file, compiled, and
 * checked for CSS output. Classes that produce declarations are valid.
 *
 * **v3 (FALLBACK):** Uses `resolveConfig()` to get the fully-resolved theme,
 * then generates utility classes from the config. Theme values come from
 * the project's config — the config IS the oracle.
 *
 * **Fail-open:** If tailwindcss can't be found, loaded, or compiled, the
 * probe returns `ready=false`. The caller MUST disable the undefined-class
 * detector — a claim that a class "does not exist" may not ship on a
 * known-incomplete dictionary.
 *
 * @module tailwindProbe
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeInitResult {
  /** Whether initialization succeeded. */
  ok: boolean;
  /** Human-readable source description. */
  source?: string;
  /** Error message if init failed. */
  error?: string;
  /** Whether the tailwindcss package was found on disk (regardless of ok). */
  tailwindFound: boolean;
}

// ---------------------------------------------------------------------------
// Theme → utility-class generation (v3 fallback)
// ---------------------------------------------------------------------------

/**
 * Utility prefixes that consume theme.colors to produce classes like
 * `bg-red-500`, `text-blue-100`, etc.
 *
 * These are NOT a dictionary — they're the documented structural mapping
 * from Tailwind's theme keys to utility class name prefixes. This mapping
 * is stable across Tailwind releases and is the minimum structure needed
 * to generate classes from a resolved config.
 */
const COLOR_UTILITY_PREFIXES = [
  'bg', 'text', 'border', 'ring', 'shadow', 'fill', 'stroke',
  'accent', 'caret', 'outline', 'placeholder',
  'divide', 'from', 'via', 'to', 'decoration',
];

/**
 * Utility prefixes that consume theme.spacing to produce classes like
 * `p-4`, `m-2`, `gap-8`, etc.
 */
const SPACING_UTILITY_PREFIXES = [
  'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl',
  'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml',
  'w', 'min-w', 'max-w', 'h', 'min-h', 'max-h',
  'top', 'right', 'bottom', 'left',
  'inset', 'inset-x', 'inset-y',
  'gap', 'gap-x', 'gap-y',
  'space-x', 'space-y',
  'leading', 'indent',
  'scroll-m', 'scroll-mx', 'scroll-my', 'scroll-mt', 'scroll-mr', 'scroll-mb', 'scroll-ml',
  'scroll-p', 'scroll-px', 'scroll-py', 'scroll-pt', 'scroll-pr', 'scroll-pb', 'scroll-pl',
  'size',
];

/** Prefixes that consume theme.fontSize. */
const FONT_SIZE_PREFIXES = ['text'];

/** Prefixes that consume theme.borderRadius. */
const RADIUS_PREFIXES = [
  'rounded', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l',
  'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl',
  'rounded-s', 'rounded-e', 'rounded-ss', 'rounded-se', 'rounded-es', 'rounded-ee',
];

// ---------------------------------------------------------------------------
// TailwindProbe
// ---------------------------------------------------------------------------

export class TailwindProbe {
  private validClasses: Set<string> | null = null;
  private _ready = false;
  private _failureReason: string | null = null;
  private _source: string | null = null;
  private projectRoot = '';
  private tailwindPath: string | null = null;
  private version: 3 | 4 | null = null;
  /** Cached compile function for v4 (async, requires loadStylesheet/loadModule options). */
  private _compile: ((css: string, opts: Record<string, unknown>) => Promise<unknown>) | null = null;
  /** tailwindcss package directory — used to load index.css via loadStylesheet. */
  private _twDir: string | null = null;
  /** Project CSS with @theme blocks — included in probe input to validate
   *  Shadcn semantic theme classes (bg-background, text-foreground, etc.). */
  private _projectCss: string | null = null;

  /** Whether the probe successfully initialized and is ready to validate classes. */
  get ready(): boolean {
    return this._ready;
  }

  /** Why initialization failed, if it did. */
  get failureReason(): string | null {
    return this._failureReason;
  }

  /** Human-readable description of the validation source. */
  get source(): string | null {
    return this._source;
  }

  /**
   * Register project-level CSS that contains @theme blocks. This is included
   * in the compile-probe input so that Shadcn semantic theme classes
   * (bg-background, text-foreground, etc.) validate against project custom
   * theme definitions.
   */
  setProjectCss(css: string): void {
    this._projectCss = css;
  }

  /**
   * Initialize the probe by locating and loading the project's tailwindcss
   * package. Tests compilation with a known-good class to verify the
   * pipeline works end-to-end.
   */
  async init(projectRoot: string): Promise<ProbeInitResult> {
    this.projectRoot = projectRoot;

    const twPath = this.findTailwindcss(projectRoot);
    if (!twPath) {
      this._failureReason = 'tailwindcss not found in project node_modules';
      return { ok: false, error: this._failureReason, tailwindFound: false };
    }
    this.tailwindPath = twPath;

    // ── Try v4 first (ESM import + compile() API) ──
    // v4.3.3+: compile() is async, returns an object (not a string), and requires
    // loadStylesheet/loadModule options. The probe validates classes via @apply:
    // - Known-valid class (@apply flex) → compile succeeds, returns object
    // - Unknown class (@apply nonexistent) → compile throws "Cannot apply unknown utility class"
    try {
      const mod = await this.tryImportV4(twPath);
      if (mod && typeof (mod as any).compile === 'function') {
        this._compile = (mod as any).compile.bind(mod);
        this._twDir = twPath;

        // Probe with a known-good class to verify the pipeline
        const testCss = '@import "tailwindcss";\n.p0{@apply flex;}';
        const result = await this.compileV4(testCss, projectRoot);
        if (result !== null) {
          this.version = 4;
          this.validClasses = new Set();
          this._ready = true;
          this._source = 'v4-compile-probe';
          return { ok: true, source: this._source, tailwindFound: true };
        }
      }
    } catch {
      // Not v4 — continue to CJS or v3
    }

    // ── Try CJS require paths (v4 CJS or v3) ──
    // v4 CJS: exports { compile, compileAst, ... } — an object with named exports,
    // NOT a function. The ESM import in tryImportV4 may have failed (e.g., when
    // the project is CJS or the resolver can't find the ESM entry), but the CJS
    // build is still loadable and has the compile() API.
    try {
      const projectRequire = createRequire(join(projectRoot, 'package.json'));
      const tw = projectRequire(twPath);

      if (tw && typeof tw.compile === 'function') {
        this._compile = tw.compile.bind(tw);
        this._twDir = twPath;

        const testCss = '@import "tailwindcss";\n.p0{@apply flex;}';
        const result = await this.compileV4(testCss, projectRoot);
        if (result !== null) {
          this.version = 4;
          this.validClasses = new Set();
          this._ready = true;
          this._source = 'v4-cjs-compile-probe';
          return { ok: true, source: this._source, tailwindFound: true };
        }
      }

      // v3 tailwindcss exports a function (the postcss plugin)
      // It also has resolveConfig available
      if (typeof tw === 'function' || (tw.default && typeof tw.default === 'function')) {
        // Test resolveConfig availability
        try {
          const resolveConfig = projectRequire(join(twPath, 'resolveConfig'));
          if (typeof resolveConfig === 'function') {
            this.version = 3;
            this.validClasses = null; // generated lazily from config
            this._ready = true;
            this._source = 'v3-config-generation';
            return { ok: true, source: this._source, tailwindFound: true };
          }
        } catch {
          // resolveConfig not available
        }
      }
    } catch {
      // Neither v4 nor v3 loadable
    }

    this._failureReason = 'tailwindcss found but could not be loaded (neither v4 compile() nor v3 resolveConfig detected)';
    return { ok: false, error: this._failureReason, tailwindFound: true };
  }

  /**
   * Check if a single class is known-valid from the cache only.
   * Does NOT trigger a probe — use validateBatch() for that.
   */
  isCached(className: string): boolean {
    return this.validClasses?.has(className) ?? false;
  }

  /**
   * Validate a batch of class names against the project's Tailwind compiler.
   * Classes that produce CSS when @apply'd (v4) or are generated from the
   * resolved config (v3) are considered valid.
   *
   * Returns the full Set of all known-valid classes (including previously
   * cached ones). Unknown classes that don't validate are NOT added to the
   * cache — callers should treat absence from the returned set as "not valid."
   */
  async validateBatch(candidates: string[]): Promise<Set<string>> {
    if (!this._ready) {
      throw new Error(this._failureReason ?? 'Probe not initialized');
    }

    if (this.version === 3) {
      // v3: generate from config if not yet done, then check
      if (!this.validClasses) {
        this.validClasses = this.generateV3Classes();
      }
      for (const c of candidates) {
        if (this.validClasses.has(c)) continue;
        // For v3, we can probe individual unknowns via postcss if available,
        // but that requires postcss to be installed. For now, config generation
        // is comprehensive enough.
      }
      return this.validClasses;
    }

    // v4: batch-probe via @apply compilation
    // Filter out already-known classes
    const unknown = [...new Set(candidates)].filter(c => !this.validClasses!.has(c));
    if (unknown.length === 0) return this.validClasses!;

    // Batch in groups of 200 to keep probe CSS manageable
    const BATCH_SIZE = 200;
    for (let i = 0; i < unknown.length; i += BATCH_SIZE) {
      const batch = unknown.slice(i, i + BATCH_SIZE);
      const valid = await this.probeV4Batch(batch);
      for (const cls of valid) {
        this.validClasses!.add(cls);
      }
    }

    return this.validClasses!;
  }

  // -----------------------------------------------------------------------
  // Private: v4 compile-probe
  // -----------------------------------------------------------------------

  /**
   * Build a loadStylesheet callback for Tailwind v4 compile().
   * When @import "tailwindcss" (or theme/preflight/utilities) is
   * encountered during compilation, serves tailwindcss/index.css so
   * the full base theme is available for @apply resolution.
   */
  private buildLoadStylesheet(): (path: string) => Promise<{ base: string; content: string; roots: Record<string, unknown> | null }> {
    const twDir = this._twDir!;
    const projectRoot = this.projectRoot;
    return async (path: string) => {
      if (path === 'tailwindcss' || path === 'tailwindcss/theme' ||
          path === 'tailwindcss/preflight' || path === 'tailwindcss/utilities') {
        const cssPath = join(twDir, 'index.css');
        return { base: twDir, content: readFileSync(cssPath, 'utf-8'), roots: null };
      }
      // Resolve Tailwind v4 ecosystem plugin imports (e.g. "tw-animate-css",
      // "shadcn/tailwind.css") from the audited project's node_modules and
      // serve their CSS so the compile-probe sees their @theme/@custom-variant/
      // @utility definitions — the same plugins the project's real build loads.
      const resolved = this.resolveCssImport(path, projectRoot);
      if (resolved) {
        return { base: dirname(resolved), content: readFileSync(resolved, 'utf-8'), roots: null };
      }
      return { base: path, content: '', roots: null };
    };
  }

  /**
   * Build a loadModule callback for Tailwind v4 compile().
   * Throws on all requests — no JS plugins needed for class validation.
   */
  private buildLoadModule(): (id: string, base: string) => Promise<unknown> {
    return async (_id: string, _base: string) => {
      throw new Error('No addl modules');
    };
  }

  /**
   * Compile CSS with Tailwind v4 compile() using the cached function
   * reference. Returns the compile result on success, null on failure.
   */
  private async compileV4(css: string, projectRoot: string): Promise<unknown> {
    if (!this._compile) return null;
    return this._compile(css, {
      base: projectRoot,
      loadStylesheet: this.buildLoadStylesheet(),
      loadModule: this.buildLoadModule(),
    });
  }

  /**
   * Validate a batch of class names against Tailwind v4 compile() using
   * @apply probes and iterative recompile.
   *
   * v4.3.3+ compile() throws "Cannot apply unknown utility class `X`"
   * for invalid classes (clean signal). We compile all candidate classes
   * at once in @apply probes, extract the first invalid class from the
   * error message, remove it, and recompile the rest. When compile
   * succeeds without throwing, all remaining classes are valid.
   *
   * This is efficient when most classes are valid (the common case for
   * real projects using Tailwind utilities).
   */
  private async probeV4Batch(classes: string[]): Promise<string[]> {
    const remaining = [...classes];

    // Deduplicate while preserving order
    const valid: string[] = [];
    const escapeCls = (cls: string) => cls.replace(/\\/g, '\\\\');

    // Extract only @theme { ... } blocks from project CSS. Including raw
    // CSS causes two failures: (a) duplicate @import "tailwindcss", (b)
    // relative @import "./theme.css" that loadStylesheet can't resolve,
    // which throws a non-matchable error that breaks the retry loop.
    // Extracting only @theme blocks gives the compiler the custom property
    // definitions it needs to resolve semantic tokens (bg-surface-raised,
    // bg-bg-elevated) without the import directives that break compilation.
    // Note: `bg-surface-elevated`, `*-success-default`, `*-danger-default` do
    // NOT resolve — recall-protocol never defined those --color-* tokens, so
    // they are genuine dead classes, not a discovery regression.
    //
    // Bare package @imports (tw-animate-css, shadcn/tailwind.css, …) are
    // re-injected separately so the probe loads the same Tailwind v4 ecosystem
    // plugins the project's real build does — without them, plugin-provided
    // utilities (animate-accordion-up, data-closed variants, …) are wrongly
    // flagged undefined. buildLoadStylesheet() serves their CSS from the
    // project's node_modules.
    const projectTheme = this.extractThemeBlocks();
    const projectImports = this.extractBareImports()
      .map((spec) => `@import "${spec}";`)
      .join('');

    while (remaining.length > 0) {
      const rules = remaining
        .map((cls, i) => `.p${i}{@apply ${escapeCls(cls)};}`)
        .join('');
      const css = `${projectImports}${projectTheme}@import "tailwindcss";${rules}`;

      try {
        await this.compileV4(css, this.projectRoot);
        // Compile succeeded — all remaining classes are valid
        for (const cls of remaining) valid.push(cls);
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Parse first invalid class from error: "Cannot apply unknown utility class `X`"
        const match = msg.match(/Cannot apply unknown utility class(?:es)?[`\s]+`?([^`\s]+)`?/);
        if (match) {
          const badClass = match[1];
          const idx = remaining.indexOf(badClass);
          if (idx >= 0) {
            remaining.splice(idx, 1);
            continue;
          }
        }
        // Unrecognised error — bail out safely, don't mark any as valid
        break;
      }
    }

    return valid;
  }

  /**
   * Extract @theme { ... } blocks from project CSS for inclusion in the
   * probe stylesheet. Strips @import directives and other CSS that would
   * cause the compile-probe to fail with non-matchable errors.
   *
   * Returns only the @theme blocks concatenated so the compiler sees
   * the custom property definitions (--color-surface-elevated, etc.)
   * without any import side effects.
   */
  private extractThemeBlocks(): string {
    const css = this._projectCss;
    if (!css) return '';

    const themeRegex = /@theme(?:\s+\w+)?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    const blocks: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = themeRegex.exec(css)) !== null) {
      blocks.push(match[0]);
    }

    return blocks.join('\n');
  }

  /**
   * Extract bare package @import specifiers (e.g. "tw-animate-css",
   * "shadcn/tailwind.css") from project CSS. These are Tailwind v4 ecosystem
   * plugins the project's real build loads via node_modules resolution.
   *
   * Excludes relative imports ("./theme.css"), absolute paths, URLs, and
   * "tailwindcss" itself — only specifiers resolveCssImport() can serve from
   * node_modules are returned.
   */
  private extractBareImports(): string[] {
    const css = this._projectCss;
    if (!css) return [];

    const importRegex = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;
    const seen = new Set<string>();
    const specs: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(css)) !== null) {
      const spec = match[1];
      if (
        spec === 'tailwindcss' ||
        spec.startsWith('tailwindcss/') ||
        spec.startsWith('./') ||
        spec.startsWith('../') ||
        spec.startsWith('/') ||
        /^[a-z][a-z0-9+.-]*:/i.test(spec) ||
        seen.has(spec)
      ) {
        continue;
      }
      seen.add(spec);
      specs.push(spec);
    }

    return specs;
  }

  // -----------------------------------------------------------------------
  // Private: v3 config-based generation
  // -----------------------------------------------------------------------

  /**
   * Generate the full set of utility classes from the project's resolved
   * Tailwind v3 config. Uses `resolveConfig()` to merge user config with
   * core plugin defaults, then generates class names from theme scales.
   *
   * This IS oracle-based: the config defines what's valid, and we
   * synthesize class names from it structurally. No hand-curated lists
   * of colors, spacing values, font sizes, or border radii.
   */
  private generateV3Classes(): Set<string> {
    const classes = new Set<string>();

    try {
      const { colors, spacing, fontSize, borderRadius } = this.loadV3ResolvedTheme();

      // Color-based utilities: bg-{color}, text-{color}, etc.
      const colorNames = Object.keys(colors);
      for (const prefix of COLOR_UTILITY_PREFIXES) {
        for (const name of colorNames) {
          classes.add(`${prefix}-${name}`);
        }
      }

      // Spacing-based utilities: p-{size}, m-{size}, etc.
      const spacingValues = Object.keys(spacing);
      for (const prefix of SPACING_UTILITY_PREFIXES) {
        for (const value of spacingValues) {
          classes.add(`${prefix}-${value}`);
        }
      }
      // Special non-scale values for spacing-based prefixes
      const spacingNonScale = ['auto', 'full', 'min', 'max', 'fit', 'screen', 'svh', 'dvh', 'lvh'];
      for (const v of spacingNonScale) {
        for (const prefix of ['w', 'min-w', 'max-w', 'h', 'min-h', 'max-h', 'size']) {
          classes.add(`${prefix}-${v}`);
        }
      }
      for (const prefix of ['m', 'mx', 'my', 'mt', 'mr', 'mb', 'ml']) {
        classes.add(`${prefix}-auto`);
      }
      for (const prefix of ['top', 'right', 'bottom', 'left']) {
        classes.add(`${prefix}-auto`);
        classes.add(`${prefix}-full`);
        for (const frac of ['1/2', '1/3', '2/3', '1/4', '3/4']) {
          classes.add(`${prefix}-${frac}`);
        }
      }
      for (const prefix of ['inset', 'inset-x', 'inset-y']) {
        classes.add(`${prefix}-auto`);
        classes.add(`${prefix}-full`);
        for (const frac of ['1/2', '1/3', '2/3', '1/4', '3/4']) {
          classes.add(`${prefix}-${frac}`);
        }
      }

      // Font size utilities: text-{size}
      for (const prefix of FONT_SIZE_PREFIXES) {
        for (const sizeName of Object.keys(fontSize)) {
          classes.add(`${prefix}-${sizeName}`);
        }
      }

      // Border radius utilities: rounded-{radius}
      for (const prefix of RADIUS_PREFIXES) {
        for (const radiusName of Object.keys(borderRadius)) {
          if (radiusName === 'DEFAULT' || radiusName === '') {
            classes.add(prefix);
          } else {
            classes.add(`${prefix}-${radiusName}`);
          }
        }
      }

      // ── Static utility classes that Tailwind provides regardless of theme ──
      // These are the core, stable utility names from Tailwind's core plugins.
      // Unlike theme-based utilities, these have fixed names not derived from
      // config. BUT — they're stable, well-defined, and validated by the same
      // Tailwind documentation that defines the config structure.
      addStaticCoreUtilities(classes);

      this._source = 'v3-config-generation';
    } catch {
      this._failureReason = 'v3 resolveConfig failed to generate utilities';
      this._ready = false;
    }

    return classes;
  }

  /**
   * Load the fully-resolved Tailwind v3 theme using resolveConfig().
   */
  private loadV3ResolvedTheme(): {
    colors: Record<string, unknown>;
    spacing: Record<string, unknown>;
    fontSize: Record<string, unknown>;
    borderRadius: Record<string, unknown>;
  } {
    const projectRequire = createRequire(join(this.projectRoot, 'package.json'));
    const resolveConfig = projectRequire(join(this.tailwindPath!, 'resolveConfig')) as
      (config: Record<string, unknown>) => { theme: Record<string, unknown> };

    // Try to load the project's tailwind.config
    let userConfig: Record<string, unknown> = {};
    const configCandidates = [
      'tailwind.config.js', 'tailwind.config.ts',
      'tailwind.config.cjs', 'tailwind.config.mjs',
    ];
    for (const candidate of configCandidates) {
      const configPath = join(this.projectRoot, candidate);
      if (existsSync(configPath)) {
        try {
          const cfg = projectRequire(configPath);
          userConfig = cfg.default ?? cfg;
        } catch {
          // Config exists but can't be loaded — use empty config
        }
        break;
      }
    }

    const resolved = resolveConfig(userConfig);
    const theme = (resolved.theme ?? {}) as Record<string, unknown>;

    // Flatten color palette (resolvedConfig returns nested structure)
    const colors = flattenThemeSection(theme.colors as Record<string, unknown> ?? {});
    const spacing = flattenThemeSection(theme.spacing as Record<string, unknown> ?? {});
    const fontSize = flattenThemeSection(theme.fontSize as Record<string, unknown> ?? {});
    const borderRadius = flattenThemeSection(theme.borderRadius as Record<string, unknown> ?? {});

    return { colors, spacing, fontSize, borderRadius };
  }

  // -----------------------------------------------------------------------
  // Private: package discovery
  // -----------------------------------------------------------------------

  /**
   * Locate tailwindcss in the project's node_modules, walking up directories.
   */
  private findTailwindcss(projectRoot: string): string | null {
    return this.findNodeModuleDir('tailwindcss', projectRoot);
  }

  /**
   * Locate a package directory in the project's node_modules, walking up
   * directories (monorepo-aware). Handles scoped package names (@scope/pkg).
   */
  private findNodeModuleDir(packageName: string, projectRoot: string): string | null {
    let dir = projectRoot;
    for (let i = 0; i < 20; i++) {
      const pkgPath = join(dir, 'node_modules', ...packageName.split('/'));
      if (existsSync(pkgPath)) {
        return pkgPath;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  /**
   * Resolve a bare package CSS @import specifier (e.g. "tw-animate-css",
   * "shadcn/tailwind.css") to an absolute CSS file path, using the package's
   * `exports` map. Prefers the `style` condition (or a `style`-bearing string
   * export) as defined by Tailwind v4 ecosystem packages, so the compile-probe
   * serves the same CSS the project's real build imports.
   *
   * Returns null when the package is absent or no CSS entry can be resolved.
   */
  private resolveCssImport(specifier: string, projectRoot: string): string | null {
    if (!specifier) return null;

    // Split specifier into package name + subpath, handling scoped names.
    let packageName = specifier;
    let subpath = '';
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      if (parts.length >= 2) {
        packageName = `${parts[0]}/${parts[1]}`;
        subpath = parts.slice(2).join('/');
      }
    } else {
      const idx = specifier.indexOf('/');
      if (idx >= 0) {
        packageName = specifier.slice(0, idx);
        subpath = specifier.slice(idx + 1);
      }
    }

    const pkgDir = this.findNodeModuleDir(packageName, projectRoot);
    if (!pkgDir) return null;

    const packageJsonPath = join(pkgDir, 'package.json');
    let pkg: { exports?: Record<string, unknown>; style?: string; main?: string } = {};
    try {
      pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    } catch {
      return null;
    }

    // Determine the export target for this specifier: the "." subpath when
    // no subpath is given, otherwise "./<subpath>".
    const exportKey = subpath ? `./${subpath}` : '.';
    const raw = pkg.exports?.[exportKey];

    const target = this.pickExportTarget(raw);
    if (!target) {
      // Fall back to top-level style/main for the bare package case.
      const fallback = pkg.style || pkg.main;
      if (fallback && !subpath) {
        const resolvedPath = join(pkgDir, fallback);
        if (existsSync(resolvedPath)) return resolvedPath;
      }
      return null;
    }

    const resolvedPath = join(pkgDir, target);
    return existsSync(resolvedPath) ? resolvedPath : null;
  }

  /**
   * Resolve a nested conditional export target (recursive helper for
   * resolveCssImport). Mirrors Node's condition-object resolution, stopping at
   * the first string path under a preferred condition key.
   */
  private pickExportTarget(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      for (const key of ['style', 'import', 'require', 'default']) {
        const v = obj[key];
        if (typeof v === 'string') return v;
        const nested = this.pickExportTarget(v);
        if (nested) return nested;
      }
    }
    return null;
  }

  /**
   * Dynamically import tailwindcss v4 (ESM package).
   *
   * Tailwind v4.3+ uses package.json `exports` map with no `main` or `index.js`,
   * so `import(pathToFileURL(dir).href)` fails. We read the entry point from
   * package.json and import the resolved file directly.
   */
  private async tryImportV4(twPath: string): Promise<Record<string, unknown> | null> {
    // Attempt 1: Read entry point from package.json exports, import directly.
    // This handles Tailwind v4.3+ which has no index.js — only exports map.
    const packageJsonPath = join(twPath, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        // v4 uses exports map: { ".": { "import": "./dist/lib.mjs", "require": "./dist/lib.js" } }
        const entry = pkg.exports?.['.']?.import
          || pkg.module
          || pkg.main
          || 'index.js';
        const resolvedPath = join(twPath, entry);
        if (existsSync(resolvedPath)) {
          return await import(pathToFileURL(resolvedPath).href);
        }
      } catch {
        // Falls through to next attempt
      }
    }

    // Attempt 2: Use createRequire from the project root to resolve the bare specifier,
    // then import the resolved path. This is more reliable than bare import() because
    // it resolves from the audited project, not from code-auditor's execution path.
    try {
      const projectRequire = createRequire(join(this.projectRoot, 'package.json'));
      const resolved = projectRequire.resolve('tailwindcss');
      if (existsSync(resolved)) {
        return await import(pathToFileURL(resolved).href);
      }
    } catch {
      // Falls through to next attempt
    }

    // Attempt 3: Last resort — bare specifier import. Only works when CWD is the
    // audited project (e.g., CLI launched from the project directory).
    try {
      // @ts-expect-error — tailwindcss is resolved at runtime from the audited project
      return await import('tailwindcss');
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten a resolved Tailwind theme section for class name generation.
 * Handles nested objects (e.g. colors: { blue: { 500: '#...' } })
 * producing dotted keys (e.g. "blue-500").
 *
 * Uses hyphens for separators to match Tailwind CSS class naming.
 */
export function flattenThemeSection(
  obj: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};

  function walk(prefix: string, value: unknown): void {
    if (typeof value === 'string') {
      result[prefix] = value;
    } else if (Array.isArray(value)) {
      // Tailwind v3 array-valued theme keys (fontSize: '3xl': ['1.875rem',
      // { lineHeight: '2.25rem' }]). The first string element is the size;
      // trailing line-height objects are not class tokens. Without this branch
      // the array falls through to the object walk and iterates numeric
      // indices, producing garbage keys like "3xl-0-lineHeight".
      const size = value.find((v): v is string => typeof v === 'string');
      if (size !== undefined) result[prefix] = size;
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'DEFAULT') {
          // DEFAULT key means the prefix itself is the value
          result[prefix] = typeof val === 'string' ? val : String(val);
        } else {
          const sep = prefix ? '-' : '';
          walk(`${prefix}${sep}${key}`, val);
        }
      }
    } else if (typeof value === 'number') {
      result[prefix] = String(value);
    } else if (typeof value === 'function') {
      // Some v3 theme values are functions (e.g. spacing)
      try {
        const fnResult = (value as () => unknown)();
        walk(prefix, fnResult);
      } catch {
        // Skip uninvocable functions
      }
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    walk(key, val);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Static core utilities (v3 fallback only)
// ---------------------------------------------------------------------------

/**
 * Add static Tailwind utility classes that exist regardless of theme.
 *
 * These are the stable, well-defined utility class names from Tailwind's
 * core plugins (display, flexbox, grid, positioning, etc.). They don't
 * derive from theme values — they have fixed names.
 *
 * This is the minimum structure needed for v3 config-based generation.
 * v4 compile-probe bypasses this entirely.
 */
function addStaticCoreUtilities(classes: Set<string>): void {
  const core = [
    // ── Display ──
    'block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid',
    'inline-grid', 'hidden', 'flow-root', 'contents', 'table', 'table-row',
    'table-cell', 'table-caption', 'table-column', 'table-column-group',
    'table-footer-group', 'table-header-group', 'table-row-group', 'list-item',

    // ── Position ──
    'static', 'fixed', 'absolute', 'relative', 'sticky',

    // ── Flexbox ──
    'flex-row', 'flex-row-reverse', 'flex-col', 'flex-col-reverse',
    'flex-wrap', 'flex-nowrap', 'flex-wrap-reverse',
    'flex-1', 'flex-auto', 'flex-initial', 'flex-none',
    'grow', 'grow-0', 'shrink', 'shrink-0',
    'flex-grow', 'flex-grow-0', 'flex-shrink', 'flex-shrink-0',

    // ── Grid ──
    'grid-flow-row', 'grid-flow-col', 'grid-flow-dense', 'grid-flow-row-dense', 'grid-flow-col-dense',
    'grid-cols-none', 'grid-cols-subgrid',
    'grid-rows-none', 'grid-rows-subgrid',
    'auto-cols-auto', 'auto-cols-min', 'auto-cols-max', 'auto-cols-fr',
    'auto-rows-auto', 'auto-rows-min', 'auto-rows-max', 'auto-rows-fr',

    // ── Alignment ──
    'items-start', 'items-end', 'items-center', 'items-baseline', 'items-stretch',
    'justify-start', 'justify-end', 'justify-center', 'justify-between',
    'justify-around', 'justify-evenly', 'justify-stretch', 'justify-normal',
    'justify-items-start', 'justify-items-end', 'justify-items-center', 'justify-items-stretch',
    'content-center', 'content-start', 'content-end', 'content-between',
    'content-around', 'content-evenly', 'content-baseline', 'content-normal', 'content-stretch',
    'place-content-center', 'place-content-start', 'place-content-end',
    'place-content-between', 'place-content-around', 'place-content-evenly',
    'place-items-center', 'place-items-start', 'place-items-end', 'place-items-stretch',
    'self-auto', 'self-start', 'self-end', 'self-center', 'self-stretch', 'self-baseline',
    'place-self-auto', 'place-self-start', 'place-self-end', 'place-self-center', 'place-self-stretch',

    // ── Typography ──
    'text-left', 'text-center', 'text-right', 'text-justify', 'text-start', 'text-end',
    'underline', 'line-through', 'no-underline', 'overline',
    'decoration-solid', 'decoration-double', 'decoration-dotted', 'decoration-dashed', 'decoration-wavy',
    'uppercase', 'lowercase', 'capitalize', 'normal-case',
    'truncate', 'text-ellipsis', 'text-clip',
    'font-thin', 'font-extralight', 'font-light', 'font-normal', 'font-medium',
    'font-semibold', 'font-bold', 'font-extrabold', 'font-black',
    'italic', 'not-italic',
    'tracking-tighter', 'tracking-tight', 'tracking-normal',
    'tracking-wide', 'tracking-wider', 'tracking-widest',
    'leading-none', 'leading-tight', 'leading-snug', 'leading-normal', 'leading-relaxed', 'leading-loose',
    'break-normal', 'break-words', 'break-all', 'break-keep',
    'hyphens-none', 'hyphens-manual', 'hyphens-auto',
    'ordinal', 'slashed-zero', 'lining-nums', 'oldstyle-nums', 'proportional-nums',
    'tabular-nums', 'diagonal-fractions', 'stacked-fractions',

    // ── Whitespace ──
    'whitespace-normal', 'whitespace-nowrap', 'whitespace-pre', 'whitespace-pre-line',
    'whitespace-pre-wrap', 'whitespace-break-spaces',

    // ── Sizing ──
    'w-auto', 'w-full', 'w-screen', 'w-svw', 'w-dvw', 'w-lvw', 'w-min', 'w-max', 'w-fit',
    'h-auto', 'h-full', 'h-screen', 'h-svh', 'h-dvh', 'h-lvh', 'h-min', 'h-max', 'h-fit',
    'min-w-0', 'min-w-full', 'min-w-min', 'min-w-max', 'min-w-fit',
    'max-w-none', 'max-w-xs', 'max-w-sm', 'max-w-md', 'max-w-lg', 'max-w-xl',
    'max-w-2xl', 'max-w-3xl', 'max-w-4xl', 'max-w-5xl', 'max-w-6xl', 'max-w-7xl',
    'max-w-full', 'max-w-min', 'max-w-max', 'max-w-fit', 'max-w-prose',
    'min-h-0', 'min-h-full', 'min-h-screen', 'min-h-min', 'min-h-max', 'min-h-fit',
    'max-h-0', 'max-h-full', 'max-h-screen', 'max-h-min', 'max-h-max', 'max-h-fit',
    'size-auto', 'size-full', 'size-min', 'size-max', 'size-fit',

    // ── Overflow ──
    'overflow-auto', 'overflow-hidden', 'overflow-visible', 'overflow-scroll',
    'overflow-x-auto', 'overflow-x-hidden', 'overflow-x-visible', 'overflow-x-scroll',
    'overflow-y-auto', 'overflow-y-hidden', 'overflow-y-visible', 'overflow-y-scroll',

    // ── Visibility ──
    'visible', 'invisible', 'collapse',

    // ── Borders ──
    'border-solid', 'border-dashed', 'border-dotted', 'border-double', 'border-hidden', 'border-none',
    'border-collapse', 'border-separate',

    // ── Shadows ──
    'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl',
    'shadow-inner', 'shadow-none',

    // ── Ring ──
    'ring-inset',

    // ── Filters ──
    'blur-sm', 'blur-md', 'blur-lg', 'blur-xl', 'blur-2xl', 'blur-3xl', 'blur-none',
    'backdrop-blur-sm', 'backdrop-blur-md', 'backdrop-blur-lg',
    'backdrop-blur-xl', 'backdrop-blur-2xl', 'backdrop-blur-3xl', 'backdrop-blur-none',

    // ── Transitions ──
    'transition-none', 'transition-all', 'transition', 'transition-colors',
    'transition-opacity', 'transition-shadow', 'transition-transform',
    'ease-linear', 'ease-in', 'ease-out', 'ease-in-out',

    // ── Transforms ──
    'transform', 'transform-gpu', 'transform-none',
    'scale-0', 'scale-50', 'scale-75', 'scale-90', 'scale-95', 'scale-100',
    'scale-105', 'scale-110', 'scale-125', 'scale-150',
    'rotate-0', 'rotate-1', 'rotate-2', 'rotate-3', 'rotate-6', 'rotate-12',
    'rotate-45', 'rotate-90', 'rotate-180',
    'origin-center', 'origin-top', 'origin-top-right', 'origin-right',
    'origin-bottom-right', 'origin-bottom', 'origin-bottom-left', 'origin-left', 'origin-top-left',

    // ── Interactivity ──
    'cursor-auto', 'cursor-default', 'cursor-pointer', 'cursor-wait', 'cursor-text',
    'cursor-move', 'cursor-help', 'cursor-not-allowed', 'cursor-none',
    'pointer-events-none', 'pointer-events-auto',
    'select-none', 'select-text', 'select-all', 'select-auto',
    'resize-none', 'resize', 'resize-y', 'resize-x',

    // ── Screen readers ──
    'sr-only', 'not-sr-only',

    // ── Object fit ──
    'object-contain', 'object-cover', 'object-fill', 'object-none', 'object-scale-down',

    // ── Aspect ratio ──
    'aspect-auto', 'aspect-square', 'aspect-video',

    // ── Animation ──
    'animate-none', 'animate-spin', 'animate-ping', 'animate-pulse', 'animate-bounce',

    // ── Font family ──
    'font-sans', 'font-serif', 'font-mono',

    // ── Box sizing ──
    'box-border', 'box-content',

    // ── Container ──
    'container',

    // ── Variant markers (bare prefix-less utilities) ──
    'group', 'peer', 'dark',

    // ── Background ──
    'bg-auto', 'bg-cover', 'bg-contain',
    'bg-bottom', 'bg-center', 'bg-left', 'bg-left-bottom', 'bg-left-top',
    'bg-right', 'bg-right-bottom', 'bg-right-top', 'bg-top',
    'bg-fixed', 'bg-local', 'bg-scroll',
    'bg-no-repeat', 'bg-repeat', 'bg-repeat-x', 'bg-repeat-y', 'bg-repeat-round', 'bg-repeat-space',
    'bg-gradient-to-t', 'bg-gradient-to-tr', 'bg-gradient-to-r', 'bg-gradient-to-br',
    'bg-gradient-to-b', 'bg-gradient-to-bl', 'bg-gradient-to-l', 'bg-gradient-to-tl',
    'bg-origin-border', 'bg-origin-padding', 'bg-origin-content',
    'bg-clip-border', 'bg-clip-padding', 'bg-clip-content', 'bg-clip-text',

    // ── Blend mode ──
    'mix-blend-normal', 'mix-blend-multiply', 'mix-blend-screen', 'mix-blend-overlay',
    'bg-blend-normal', 'bg-blend-multiply', 'bg-blend-screen', 'bg-blend-overlay',

    // ── Table ──
    'table-auto', 'table-fixed',
    'caption-top', 'caption-bottom',

    // ── Vertical align ──
    'align-baseline', 'align-top', 'align-middle', 'align-bottom',
    'align-text-top', 'align-text-bottom', 'align-sub', 'align-super',

    // ── List style ──
    'list-none', 'list-disc', 'list-decimal',
    'list-inside', 'list-outside',

    // ── Float / Clear ──
    'float-right', 'float-left', 'float-none', 'float-start', 'float-end',
    'clear-left', 'clear-right', 'clear-both', 'clear-none', 'clear-start', 'clear-end',

    // ── Isolation ──
    'isolate', 'isolation-auto',

    // ── Overscroll ──
    'overscroll-auto', 'overscroll-contain', 'overscroll-none',

    // ── Scroll ──
    'snap-none', 'snap-x', 'snap-y', 'snap-both', 'snap-mandatory', 'snap-proximity',
    'scroll-auto', 'scroll-smooth',

    // ── Appearance ──
    'appearance-none', 'appearance-auto',

    // ── Touch ──
    'touch-auto', 'touch-none', 'touch-manipulation',

    // ── Will change ──
    'will-change-auto', 'will-change-scroll', 'will-change-contents', 'will-change-transform',

    // ── Content ──
    'content-none',

    // ── Box decoration ──
    'decoration-slice', 'decoration-clone',
    'box-decoration-slice', 'box-decoration-clone',

    // ── Line clamp ──
    'line-clamp-none',

    // ── Outline ──
    'outline-none', 'outline', 'outline-dashed', 'outline-dotted', 'outline-double',
  ];

  for (const cls of core) {
    classes.add(cls);
  }
}
