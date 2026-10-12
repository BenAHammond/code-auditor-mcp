/**
 * The single source of truth for the defined-class catalog (Spec 45) — the set
 * of `.foo` class selectors a stylesheet *defines*, which `styles/undefined-class`
 * resolves candidate class usages against.
 *
 * Every writer of the catalog used to scrape class names out of a declaration's
 * selector `context` with the regex `/\.([a-zA-Z0-9_-]+)/g`. That form is wrong
 * twice: it admits a keyframe percentage like `15.8%` (the `.` before `8` is a
 * decimal point, not a class selector), and it cannot tell a style-rule selector
 * from a keyframe selector. The CSS path already harvests class selectors
 * structurally — `extractClassUsageFromCSSAst` walks `class_name` nodes under
 * `class_selector`, so keyframes (whose selectors are `from`/`to`/percentages,
 * per the CSS grammar) never appear. Every live catalog writer now uses the
 * parser harvest: CSS/SCSS read the parser walk (`classUsage`); markup parses
 * each embedded `<style>` block body with the CSS parser
 * (`harvestMarkupStyleClasses`); TS/JS source parses each CSS-in-JS template
 * body with the same parser (`harvestCssInJsStyleClasses`). No live path scans
 * the selector `context` anymore. The `@keyframes` at-rule discriminant
 * (`isKeyframeVariant`) survives only on the migration-backfill path, which
 * replays legacy `style_declarations` rows whose `variant_context` carried the
 * at-rule — see that function's doc.
 */

export interface DefinedClassRef {
  className: string;
  filePath: string;
}

/** The minimal declaration shape the harvest reads. The phase `StylesDeclaration`,
 *  the legacy `NormalizedDeclaration`, and the inline object literals the pipeline
 *  adapters pass all satisfy it structurally. */
interface ClassDeclContext {
  context: string | null;
  variantContext: string | null;
  filePath: string;
}

/** The minimal class-usage shape the CSS branch reads (parser harvest). */
interface ClassUsageContext {
  className: string;
  filePath: string;
  unresolvable: boolean;
}

function isIdentifierStart(c: string | undefined): boolean {
  if (!c) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    c === '_' ||
    c === '-'
  );
}

function isIdentifierPart(c: string): boolean {
  const code = c.charCodeAt(0);
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    c === '_' ||
    c === '-'
  );
}

/**
 * Scan a selector string for class names (`.foo`). A class selector's name must
 * begin with an identifier-start character (a letter, `_`, or `-`) — a decimal
 * point in a keyframe percentage like `15.8%` is followed by a digit and so
 * contributes nothing even before the caller's keyframe check. This is the
 * markup/source fallback; the CSS path uses the parser instead of this scanner.
 *
 * @param selector - The CSS selector string to scan (a declaration's `context`).
 * @returns The `.`-prefixed class names in `selector`, in source order.
 */
export function scanClassNamesFromSelector(selector: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] !== '.') continue;
    if (!isIdentifierStart(selector[i + 1])) continue;
    let j = i + 2;
    while (j < selector.length && isIdentifierPart(selector[j])) j++;
    names.push(selector.slice(i + 1, j));
    i = j - 1;
  }
  return names;
}

/**
 * True when a declaration's variant context names the `@keyframes` at-rule — the
 * one at-rule whose inner selectors are keyframe selectors rather than style-rule
 * class selectors. The name may carry a leading `@` and may be the first or a
 * later at-rule in the stack.
 *
 * Live path: none. Every live catalog writer excludes keyframes structurally —
 * CSS/SCSS via the parser's `class_name`-under-`class_selector` walk, markup via
 * `harvestMarkupStyleClasses`, and TS/JS source via `harvestCssInJsStyleClasses`
 * (both of which route a template body through `parseFile` +
 * `extractClassUsageFromCSSAst`). The only caller that can supply a non-null
 * `variantContext` — and therefore reach this function — is the v11→v12
 * backfill migration (`codeIndex/migrations.ts:1164`), which replays legacy
 * `style_declarations` rows whose `variant_context` came from the CSS AST
 * extractor's at-rule context (`cssAstExtractor.ts:584` writes `@keyframes
 * <name>`; `getVariantContext` at `cssAstExtractor.ts:64` writes the enclosing
 * `@media`/`@supports`/`@layer` stack).
 */
export function isKeyframeVariant(variantContext: string | null): boolean {
  if (!variantContext) return false;
  return /(^|,)\s*@?keyframes\b/i.test(variantContext);
}

/**
 * The canonical defined-class harvest for one styles file.
 *
 * `isCss` selects the source. CSS/SCSS files carry a parser-harvested
 * `classUsage` (each entry a `.foo` selector; keyframes excluded structurally;
 * SCSS `&`-patterns marked `unresolvable`, which are references rather than
 * definitions). Markup and TS/JS source definitions are harvested separately by
 * `harvestMarkupStyleClasses` and `harvestCssInJsStyleClasses` respectively (the
 * CSS parser over each `<style>` block / CSS-in-JS template body) and are not
 * passed here. The `isCss === false` branch below — the selector-`context` scan
 * — is therefore reached only by the migration-backfill path
 * (`codeIndex/migrations.ts:1164`), which replays legacy rows whose `context`
 * carried a selector string and whose `variant_context` carried the at-rule
 * stack; that is the one remaining consumer of the `isKeyframeVariant` skip.
 *
 * @param declarations - The file's declaration contexts (selector plus the
 *   enclosing at-rule stack), the legacy selector-scan source.
 * @param classUsage - The parser-harvested class selectors (the CSS/SCSS source).
 * @param isCss - True when the source is a CSS/SCSS file, so the harvest reads
 *   `classUsage`; false selects the legacy selector scan over `declarations`.
 * @returns The file's defined-class references (`className` + `filePath`).
 */
export function harvestDefinedClasses(
  declarations: readonly ClassDeclContext[],
  classUsage: readonly ClassUsageContext[],
  isCss: boolean,
): DefinedClassRef[] {
  if (isCss) {
    return classUsage
      .filter((u) => !u.unresolvable)
      .map((u) => ({ className: u.className, filePath: u.filePath }));
  }
  const out: DefinedClassRef[] = [];
  for (const d of declarations) {
    const ctx = d.context;
    if (!ctx) continue;
    if (isKeyframeVariant(d.variantContext)) continue;
    for (const className of scanClassNamesFromSelector(ctx)) {
      out.push({ className, filePath: d.filePath });
    }
  }
  return out;
}
