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
 * per the CSS grammar) never appear. This module is the shared helper every
 * catalog writer uses: CSS and markup use the parser harvest (markup via
 * `harvestMarkupStyleClasses`, which parses each embedded `<style>` block body
 * with the CSS parser); only TS/JS source (CSS-in-JS, which has no CSS AST)
 * scans the selector `context` for class names. The `@keyframes` at-rule
 * discriminant (`isKeyframeVariant`) is live only on the migration-backfill
 * path, not the TS/JS source path — see that function's doc.
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
 * Live path: reached only from `harvestDefinedClasses`' source branch, and the
 * only caller that can supply a non-null `variantContext` is the v11→v12
 * backfill migration (`codeIndex/migrations.ts:1164`), which replays
 * `style_declarations` rows whose `variant_context` came from the CSS AST
 * extractor's at-rule context (`cssAstExtractor.ts:584` writes `@keyframes
 * <name>`; `getVariantContext` at `cssAstExtractor.ts:64` writes the enclosing
 * `@media`/`@supports`/`@layer` stack). The live TS/JS writers never supply
 * one: CSS-in-JS hardcodes `variantContext: null` (`styleExtractor.ts:726`),
 * and Tailwind and inline-style declarations carry `context: null` so they are
 * skipped before this check. On that source path the keyframe exclusion is the
 * `{` filter in `extractDeclarationsFromBlock` (`styleExtractor.ts:440`), not
 * this function.
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
 * definitions). Markup definitions are harvested separately by
 * `harvestMarkupStyleClasses` (the CSS parser over each `<style>` block) and are
 * not passed here. Only TS/JS source has no CSS AST, so its definitions are the
 * class names in the declarations' selector `context`. The `isKeyframeVariant`
 * skip below is live only for the migration-backfill path, not the TS/JS source
 * path (which excludes keyframes via the `{` filter in
 * `extractDeclarationsFromBlock`).
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
