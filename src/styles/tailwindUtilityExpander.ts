/**
 * Tailwind Utility Class Expander — Spec 22 R1.2 (compile-probe)
 *
 * Validates Tailwind class names against the project's own installed
 * `tailwindcss` package as the oracle. Zero hand-curated dictionaries —
 * the project's compiler IS the authority on what classes exist.
 *
 * **Primary (v4):** Uses `compile()` with `@apply` probe stylesheets.
 * **Fallback (v3):** Uses `resolveConfig()` + theme generation.
 * **Structural parsing:** Arbitrary values, variant prefixes, opacity
 *   modifiers, and negative utilities are parsed via structural regex
 *   patterns — never enumerated.
 *
 * **Fail-open rule:** If the probe can't initialize (no tailwindcss found,
 *   compile fails), `configFailed` is true. The caller MUST emit a visible
 *   warning and disable the undefined-class detector.
 */

import { readFileSync } from 'node:fs';
import { TailwindProbe, type ProbeInitResult } from './tailwindProbe.js';
import { findThemeCssFiles, type TailwindConfigResult } from './tailwindConfigLoader.js';

// ---------------------------------------------------------------------------
// Static bare utilities
// ---------------------------------------------------------------------------

/**
 * Bare Tailwind utility classes that exist regardless of theme or compiler
 * version. These are variant markers and structural utilities — they don't
 * derive from theme values and may not be @apply-able in v4, so the
 * compile-probe won't validate them.
 *
 * Bare prefix-less utilities are a class, not a one-off.
 */
const BASE_UTILITIES = new Set([
  'group',       // parent marker for group-hover: etc.
  'peer',        // sibling marker for peer-focus: etc.
  'dark',        // dark mode marker (parent class)
  'container',   // responsive container
  'sr-only',     // screen-reader-only
]);

// ---------------------------------------------------------------------------
// Structural patterns (regex — NOT enumeration)
// ---------------------------------------------------------------------------

/**
 * Regex matching Tailwind variant prefix syntax.
 * Covers: responsive (sm/md/lg/xl/2xl), state (hover/focus/active/...),
 * group/peer modifiers, dark/light, motion, aria, has, supports, etc.
 *
 * Pattern: `word` or `word-word` or `[...]` followed by `:`.
 * This is a structural check — it does not enumerate valid variant names.
 */
const VARIANT_PREFIX_RE = /^(?:[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*|\[.+?\]):/;

/**
 * Regex matching arbitrary-value syntax: `prefix-[...]`.
 * Any word followed by `-[...]` is structurally a valid Tailwind
 * arbitrary value. The brackets DO need to be balanced.
 */
const ARBITRARY_VALUE_RE = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\[.+\]$/;

/**
 * Regex matching opacity-modifier syntax: `utility/opacity`.
 * e.g., `bg-red-500/50`, `text-blue-100/75`.
 * The part before the last `/` should be a valid utility,
 * and the suffix should be a numeric opacity (0-100).
 */
const OPACITY_MODIFIER_RE = /^(.+)\/(\d{1,3})$/;

/**
 * Regex matching negative-utility syntax: `-utility`.
 * Any utility prefixed with a leading `-` is structurally a negative
 * Tailwind utility. We strip the `-` and check the positive utility.
 */
const NEGATIVE_UTILITY_RE = /^-(.+)$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of resolving a Tailwind utility class against the validation pipeline.
 */
export interface UtilityClassResolution {
  /** Is this a known/valid utility class? */
  valid: boolean;
  /**
   * Which tier resolved it:
   *   'probe' — validated by compile-probe (v4) or config generation (v3)
   *   'arbitrary-value' — matches `prefix-[...]` grammar
   *   'none' — no match found
   */
  tier: 'probe' | 'arbitrary-value' | 'none';
}

/**
 * Configuration for the Tailwind utility class expander.
 */
export interface TailwindExpanderConfig {
  /** Project root for loading Tailwind config / locating node_modules. */
  projectRoot?: string;
  /** If true, attempt to load and use project Tailwind config. */
  useProjectConfig?: boolean;
  /** User-supplied class names (use when useProjectConfig would fail —
   *  the caller pre-resolves and passes them in). */
  customClasses?: Set<string>;
  /** Explicit project CSS containing @theme blocks (Shadcn, custom themes).
   *  When omitted, the expander auto-discovers CSS files with @theme in
   *  the project root. Pass this when the caller already has the CSS
   *  content available (e.g., from indexed style declarations). */
  projectCss?: string;
}

// ---------------------------------------------------------------------------
// TailwindUtilityExpander
// ---------------------------------------------------------------------------

/**
 * Tailwind utility class expander backed by compile-probe.
 *
 * Validation pipeline:
 * 1. Probe cache (compile-probe or config-generation validated classes)
 * 2. User-supplied custom classes
 * 3. Opacity-modifier syntax (`utility/opacity`)
 * 4. Arbitrary-value grammar (`prefix-[...]`)
 * 5. Negative-utility syntax (`-utility`)
 * 6. Variant prefix stripping + retry against all of the above
 *
 * Fail-open: if the probe fails to initialize, configFailed is true.
 * The caller is responsible for emitting a visible warning and
 * potentially disabling the undefined-class detector.
 */
export class TailwindUtilityExpander {
  private probe: TailwindProbe | null = null;
  private customClasses: Set<string> | null = null;
  private _configFailed = false;
  private _configFailureReason: string | null = null;
  private _hasTailwindConfig = false;

  /**
   * Initialize the expander with optional project config.
   * Call once per audit. Async because it may compile-probe Tailwind.
   */
  async init(config: TailwindExpanderConfig = {}): Promise<void> {
    this.customClasses = config.customClasses ?? null;

    if (config.useProjectConfig && config.projectRoot) {
      this.probe = new TailwindProbe();

      // Load project CSS with @theme blocks so Shadcn semantic theme
      // classes (bg-primary, text-foreground, etc.) validate correctly.
      // Must happen BEFORE probe.init() because the init self-test
      // doesn't use project CSS — but validateBatch() does via
      // _projectCss injection into the probe stylesheet.
      const projectCss = config.projectCss ?? this.discoverProjectCss(config.projectRoot);
      if (projectCss) {
        this.probe.setProjectCss(projectCss);

        // Tailwind v4 declares itself CSS-first — `@import "tailwindcss"` and/or
        // `@theme` blocks in the project's own CSS — with no tailwind.config.js
        // and not necessarily with tailwindcss in node_modules (e.g. a corpus
        // checked out without installing dependencies). Treat that marker as
        // "Tailwind is present" so the fail-open guard in the caller disables
        // undefined-class detection when the compile-probe can't validate.
        // Without this, a v4 project with no installed tailwindcss silently
        // falls through to CSS-only detection and flags every utility class
        // as undefined.
        if (/@import\s+["']tailwindcss["']/.test(projectCss) || projectCss.includes('@theme')) {
          this._hasTailwindConfig = true;
        }
      }

      const result = await this.probe.init(config.projectRoot);

      this._hasTailwindConfig = this._hasTailwindConfig || result.tailwindFound;

      if (!result.ok) {
        this._configFailed = true;
        this._configFailureReason = result.error ?? 'Unknown probe init failure';
        this.probe = null;
      }
    }
  }

  /**
   * Auto-discover project CSS files containing @theme blocks.
   * Uses findThemeCssFiles() which walks the project tree for .css files
   * containing @theme — works for any framework (Next.js, Vite, Astro,
   * Remix, plain Tailwind v4). Concatenates all matching files so that
   * split-token designs (e.g. Shadcn ui-components.css + global.css) just work.
   */
  private discoverProjectCss(projectRoot: string): string | null {
    const themeFiles = findThemeCssFiles(projectRoot);
    if (themeFiles.length === 0) return null;

    const parts: string[] = [];
    for (const cssPath of themeFiles) {
      try {
        const content = readFileSync(cssPath, 'utf-8');
        parts.push(content);
      } catch {
        // Silently skip unreadable files
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /** Did the probe initialization fail? */
  get configFailed(): boolean {
    return this._configFailed;
  }

  /** Why did probe initialization fail? */
  get configFailureReason(): string | null {
    return this._configFailureReason;
  }

  /** Whether tailwindcss was found on disk (even if the probe failed to load it). */
  get hasTailwindConfig(): boolean {
    return this._hasTailwindConfig;
  }

  /** Whether the probe is ready (initialized successfully). */
  get probeReady(): boolean {
    return this.probe?.ready ?? false;
  }

  /** Human-readable source of validation data. */
  get probeSource(): string | null {
    return this.probe?.source ?? null;
  }

  /**
   * Validate a batch of unknown class names against the compile-probe.
   * Call this BEFORE resolve() to pre-populate the validation cache.
   *
   * Classes that pass validation are cached internally; resolve() will
   * find them on subsequent calls.
   *
   * Returns the full set of all validated classes (including previously
   * cached ones).
   */
  async validateBatch(candidates: string[]): Promise<Set<string>> {
    if (!this.probe?.ready) {
      // No probe — use custom classes only
      return this.customClasses ?? new Set();
    }
    return this.probe.validateBatch(candidates);
  }

  /**
   * Resolve a single class name against the validation pipeline.
   * Synchronous — only checks cached data + structural patterns.
   * Call validateBatch() first to populate the cache for unknown classes.
   */
  resolve(className: string): UtilityClassResolution {
    // 1. Check probe cache
    if (this.probe?.isCached(className)) {
      return { valid: true, tier: 'probe' };
    }

    // 2. Check custom (user-supplied) classes
    if (this.customClasses?.has(className)) {
      return { valid: true, tier: 'probe' };
    }

    // 2.5. Check static bare utilities (group, peer, dark, container, sr-only)
    // These exist regardless of theme/compiler and may not be @apply-able in v4.
    // Variant prefixes (group-hover:, peer-focus:) are already handled by
    // stripVariantPrefix() in step 6 — group-hover:text-red strips to text-red.
    if (BASE_UTILITIES.has(className)) {
      return { valid: true, tier: 'probe' };
    }

    // 3. Check opacity-modifier syntax: {utility}/{opacity}
    if (className.includes('/')) {
      const result = this.checkOpacityModifier(className);
      if (result) return result;
    }

    // 4. Check arbitrary-value grammar: prefix-[...]
    if (this.matchesArbitraryValue(className)) {
      return { valid: true, tier: 'arbitrary-value' };
    }

    // 5. Check negative-utility syntax: -{utility}
    const negResult = this.checkNegativeUtility(className);
    if (negResult) return negResult;

    // 6. Strip variant prefix and retry
    const stripped = this.stripVariantPrefix(className);
    if (stripped !== className) {
      return this.resolve(stripped);
    }

    return { valid: false, tier: 'none' };
  }

  /**
   * Check whether a class matches the arbitrary-value grammar:
   * `{prefix}-[...]` — any word prefix followed by `-[...]`.
   *
   * Structural check only — does not enumerate valid prefixes.
   * The Tailwind compiler is the authority on whether a prefix
   * actually accepts arbitrary values; our job is to not false-positive
   * on obviously-arbitrary syntax.
   */
  private matchesArbitraryValue(className: string): boolean {
    return ARBITRARY_VALUE_RE.test(className);
  }

  /**
   * Check opacity-modifier syntax: `{utility}/{opacity}`.
   *
   * Split on the LAST `/` to avoid confusing fractional widths
   * (e.g. `w-1/2`). The prefix must be a known utility, suffix
   * must be a numeric opacity (0-100).
   */
  private checkOpacityModifier(className: string): UtilityClassResolution | null {
    const m = OPACITY_MODIFIER_RE.exec(className);
    if (!m) return null;

    const prefix = m[1];
    const suffix = m[2];
    const opacity = parseInt(suffix, 10);
    if (opacity < 0 || opacity > 100) return null;

    // Prefix must be a known utility — check against probe cache
    // and custom classes (structural check isn't enough here because
    // "foo-bar/50" should not match unless "foo-bar" is valid).
    if (this.probe?.isCached(prefix) || this.customClasses?.has(prefix)) {
      return { valid: true, tier: 'probe' };
    }

    // Also check if the prefix itself resolves (handles variant-prefixed
    // utilities with opacity: hover:bg-red-500/50)
    const prefixResolution = this.resolve(prefix);
    if (prefixResolution.valid) {
      return { valid: true, tier: prefixResolution.tier };
    }

    return null;
  }

  /**
   * Check negative-utility syntax: `-{utility}`.
   *
   * Structural check — strips the leading `-` and verifies the positive
   * utility itself is valid. No hand-curated allowed-prefixes list.
   */
  private checkNegativeUtility(className: string): UtilityClassResolution | null {
    const m = NEGATIVE_UTILITY_RE.exec(className);
    if (!m) return null;

    const positive = m[1];

    // Recurse: is the positive utility itself valid?
    const result = this.resolve(positive);
    if (result.valid) {
      return { valid: true, tier: result.tier };
    }

    return null;
  }

  /**
   * Strip a Tailwind variant prefix from a class name.
   * Uses structural regex — matches any `word:` or `word-word:` prefix.
   *
   * E.g., "hover:bg-blue-500" → "bg-blue-500"
   *       "md:w-full" → "w-full"
   *       "group-hover:text-red" → "text-red"
   *       "[&_>_a]:text-blue" → "text-blue" (arbitrary variant)
   *
   * Returns the original if no variant prefix is matched.
   */
  stripVariantPrefix(className: string): string {
    const m = VARIANT_PREFIX_RE.exec(className);
    if (m) {
      return className.slice(m[0].length);
    }
    return className;
  }

  /**
   * Check if a class has a variant prefix at all.
   */
  hasVariantPrefix(className: string): boolean {
    return VARIANT_PREFIX_RE.test(className);
  }

  /** Reset state (useful for testing). */
  reset(): void {
    this.probe = null;
    this.customClasses = null;
    this._configFailed = false;
    this._configFailureReason = null;
    this._hasTailwindConfig = false;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: TailwindUtilityExpander | null = null;

export function getTailwindExpander(): TailwindUtilityExpander {
  if (!_instance) {
    _instance = new TailwindUtilityExpander();
  }
  return _instance;
}

export function resetTailwindExpander(): void {
  _instance = null;
}
