/**
 * Spec 26 Phase 2 — CSS AST Extractor regression tests.
 *
 * Validates that AST-based CSS extraction fixes the 5 parser bugs from the
 * retired regex-based parser in styleExtractor.ts.
 *
 * Bug 1: Whitespace before @-rules
 * Bug 2: @apply directives in rule sets
 * Bug 3: Nested @-rule closing brace
 * Bug 4: findSelectorStart walking past boundaries
 * Bug 5: CSS comments as class names
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import {
  extractDeclarationsFromCSSAst,
  extractClassUsageFromCSSAst,
  resetUnresolvedNestingCount,
  unresolvedNestingCount,
} from './cssAstExtractor.js';
import type { NormalizedDeclaration, StyleClassUsage } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let registry: LanguageRegistry;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  registry = LanguageRegistry.getInstance();
}, 30_000);

async function extractDeclarations(css: string, fileName = 'test.css'): Promise<NormalizedDeclaration[]> {
  const adapter = registry.getAdapterForFile(fileName);
  const ast = await adapter.parse(fileName, css);
  return extractDeclarationsFromCSSAst(ast, adapter, fileName, css);
}

async function extractClasses(css: string, fileName = 'test.css'): Promise<StyleClassUsage[]> {
  const adapter = registry.getAdapterForFile(fileName);
  const ast = await adapter.parse(fileName, css);
  return extractClassUsageFromCSSAst(ast, adapter, fileName);
}

/** Find a declaration by property name. */
function findDecl(decls: NormalizedDeclaration[], property: string): NormalizedDeclaration | undefined {
  return decls.find(d => d.property === property);
}

// ---------------------------------------------------------------------------
// Bug 1: Whitespace before @-rules
// ---------------------------------------------------------------------------
// The regex parser used character-by-character iteration that could miss
// @-rules when preceded by whitespace. tree-sitter correctly parses @-rules
// as at_rule nodes regardless of surrounding whitespace.

describe('Bug 1 — Whitespace before @-rules', () => {
  it('extracts declarations inside @media blocks regardless of whitespace', async () => {
    const css = '.foo { color: red; }\n\n\n@media (min-width: 768px) {\n  .bar { color: blue; }\n}';
    const decls = await extractDeclarations(css);
    // Both .foo { color: red } and .bar { color: blue } should be found
    const red = findDecl(decls, 'color');
    const blue = decls.filter(d => d.rawValue === 'blue' && d.property === 'color');
    expect(red).toBeDefined();
    expect(blue.length).toBe(1);
    expect(blue[0].variantContext).toBe('@media (min-width: 768px)');
  });

  it('extracts declarations following @import statements', async () => {
    const css = '@import url("base.css");\n.foo { color: green; }';
    const decls = await extractDeclarations(css);
    const color = findDecl(decls, 'color');
    expect(color).toBeDefined();
    expect(color!.rawValue).toBe('green');
  });

  it('extracts @keyframes blocks', async () => {
    const css = '@keyframes fade {\n  from { opacity: 0; }\n  to { opacity: 1; }\n}';
    const decls = await extractDeclarations(css);
    const opacities = decls.filter(d => d.property === 'opacity');
    expect(opacities.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bug 2: @apply directives in rule sets
// ---------------------------------------------------------------------------
// @apply is a Tailwind extension. The regex parser detected it via a
// buffer-starts-with check on each line. The AST handles @apply as either
// ERROR nodes (unrecognised by grammar) or postcss_statement nodes
// (recognised by modern tree-sitter-css).

describe('Bug 2 — @apply directives in rule sets', () => {
  it('extracts @apply as an "apply" property declaration', async () => {
    const css = '.card { @apply rounded-lg shadow-md; }';
    const decls = await extractDeclarations(css);
    const apply = findDecl(decls, 'apply');
    expect(apply).toBeDefined();
    expect(apply!.rawValue).toBe('rounded-lg shadow-md');
    expect(apply!.context).toBe('.card');
  });

  it('extracts @apply alongside regular declarations', async () => {
    const css = '.btn {\n  @apply px-4 py-2;\n  color: white;\n}';
    const decls = await extractDeclarations(css);
    const apply = findDecl(decls, 'apply');
    const color = findDecl(decls, 'color');
    expect(apply).toBeDefined();
    expect(apply!.rawValue).toBe('px-4 py-2');
    expect(color).toBeDefined();
    expect(color!.rawValue).toBe('white');
  });

  it('extracts @apply inside @layer blocks', async () => {
    const css = '@layer components {\n  .card {\n    @apply rounded;\n  }\n}';
    const decls = await extractDeclarations(css);
    const apply = findDecl(decls, 'apply');
    expect(apply).toBeDefined();
    expect(apply!.rawValue).toBe('rounded');
    // @layer context should be captured
    expect(apply!.variantContext).toContain('components');
  });
});

// ---------------------------------------------------------------------------
// Bug 3: Nested @-rule closing brace
// ---------------------------------------------------------------------------
// The regex parser used depth tracking for brace matching, which could
// miscount in edge cases with nested blocks. tree-sitter handles brace
// matching correctly via its incremental parser.

describe('Bug 3 — Nested @-rule closing brace', () => {
  it('correctly extracts declarations from nested @media blocks', async () => {
    const css = '@media screen {\n  @media (min-width: 768px) {\n    .responsive { font-size: 16px; }\n  }\n}';
    const decls = await extractDeclarations(css);
    const fontSize = findDecl(decls, 'font-size');
    expect(fontSize).toBeDefined();
    // variantContext should include both @media wrappers
    expect(fontSize!.variantContext).toContain('screen');
    expect(fontSize!.variantContext).toContain('min-width');
  });

  it('handles @supports with nested blocks', async () => {
    const css = '@supports (display: grid) {\n  .grid { display: grid; }\n}';
    const decls = await extractDeclarations(css);
    const display = findDecl(decls, 'display');
    expect(display).toBeDefined();
    expect(display!.variantContext).toContain('supports');
  });

  it('does not leak declarations across sibling rule blocks', async () => {
    const css = '.a { color: red; }\n.b { color: blue; }';
    const decls = await extractDeclarations(css);
    const reds = decls.filter(d => d.property === 'color' && d.rawValue === 'red');
    const blues = decls.filter(d => d.property === 'color' && d.rawValue === 'blue');
    expect(reds.length).toBe(1);
    expect(blues.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bug 4: findSelectorStart walking past boundaries
// ---------------------------------------------------------------------------
// The regex parser walked backwards from `{` to find the selector start,
// which could pass through comments, whitespace, and previous closing braces.
// AST walking discovers selectors from tree structure — no backward scanning.

describe('Bug 4 — findSelectorStart boundary', () => {
  it('handles selectors immediately after a closing brace', async () => {
    const css = '.a { color: red; }.b { color: blue; }';
    const decls = await extractDeclarations(css);
    const red = decls.filter(d => d.property === 'color' && d.rawValue === 'red');
    const blue = decls.filter(d => d.property === 'color' && d.rawValue === 'blue');
    expect(red.length).toBe(1);
    expect(red[0].context).toBe('.a');
    expect(blue.length).toBe(1);
    expect(blue[0].context).toBe('.b');
  });

  it('handles comma-separated selectors', async () => {
    const css = '.a, .b {\n  color: green;\n}';
    const decls = await extractDeclarations(css);
    const color = findDecl(decls, 'color');
    expect(color).toBeDefined();
    expect(color!.context).toContain('.a');
    expect(color!.context).toContain('.b');
  });

  it('handles deeply nested selectors with pseudo-classes', async () => {
    const css = '.nav .item:hover .label {\n  font-weight: bold;\n}';
    const decls = await extractDeclarations(css);
    const fontWeight = findDecl(decls, 'font-weight');
    expect(fontWeight).toBeDefined();
    expect(fontWeight!.context).toContain('.nav');
    expect(fontWeight!.context).toContain('.item');
    expect(fontWeight!.context).toContain('.label');
  });
});

// ---------------------------------------------------------------------------
// Bug 5: CSS comments as class names
// ---------------------------------------------------------------------------
// The regex `class_usage` extractor used `\.([a-zA-Z0-9_-]+)` which matched
// class names inside comments. tree-sitter's CSS grammar types comment nodes
// separately from class_name nodes, so AST extraction naturally excludes them.

describe('Bug 5 — CSS comments as class names', () => {
  it('does not extract class names from block comments', async () => {
    const css = '/* .comment-class { color: red; } */\n.actual-class { color: blue; }';
    const classes = await extractClasses(css);
    const names = classes.map(c => c.className);
    expect(names).toContain('actual-class');
    expect(names).not.toContain('comment-class');
  });

  it('does not extract class names from inline comments inside selectors', async () => {
    const css = '.real /* .fake */ { color: red; }';
    const classes = await extractClasses(css);
    const names = classes.map(c => c.className);
    expect(names).toContain('real');
    expect(names).not.toContain('fake');
  });

  it('extracts multiple real classes while ignoring comment noise', async () => {
    const css = '/* .commented-out { ... } */\n.a { color: red; }\n.b { color: blue; }\n/* .draft { ... } */';
    const classes = await extractClasses(css);
    const names = classes.map(c => c.className);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).not.toContain('commented-out');
    expect(names).not.toContain('draft');
  });

  it('does not extract pseudo-classes as CSS class definitions', async () => {
    const css = '.btn:hover { opacity: 0.8; }\n.btn:focus { outline: none; }';
    const classes = await extractClasses(css);
    const names = classes.map(c => c.className);
    // .btn appears twice (once per selector), :hover and :focus excluded
    expect(names).toContain('btn');
    expect(names.length).toBe(2); // two .btn selectors
    expect(names).not.toContain('hover');
    expect(names).not.toContain('focus');
  });
});

// ---------------------------------------------------------------------------
// Bug 6 — SCSS comment phantom class usage (Task #166 Bug 1)
// ---------------------------------------------------------------------------
// The regex-based extractClassUsage() in styleIndexer.ts ran against raw
// SCSS source without comment stripping, producing phantom class usages
// from class="..." strings inside comments. The SCSS AST pipeline naturally
// filters comment nodes — class_name nodes don't appear inside comments.

describe('Bug 6 — SCSS comment phantom class usage', () => {
  it('does not extract class names from SCSS line comments', async () => {
    const scss = `
      // This is a comment with class="phantom-class"
      .real-class {
        color: red;
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    const names = classes.map(c => c.className);
    expect(names).toContain('real-class');
    expect(names).not.toContain('phantom-class');
  });

  it('does not extract class names from SCSS block comments', async () => {
    const scss = `
      /* Another comment with class="also-phantom" */
      .real-button {
        background: blue;
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    const names = classes.map(c => c.className);
    expect(names).toContain('real-button');
    expect(names).not.toContain('also-phantom');
  });

  it('extracts real classes while ignoring comment noise in SCSS', async () => {
    const scss = `
      // classic comment style with .commented-out
      .btn-primary {
        @apply px-4 py-2;
        /* .draft-style */
        color: white;
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    const names = classes.map(c => c.className);
    expect(names).toContain('btn-primary');
    expect(names).not.toContain('commented-out');
    expect(names).not.toContain('draft-style');
  });
});

// ---------------------------------------------------------------------------
// Bug 7 — SCSS &-suffix nesting resolution (Task #166 Bug 2)
// ---------------------------------------------------------------------------
// The regex parser registered raw &-suffix as a class name instead of
// resolving it to the parent selector + suffix. The SCSS AST pipeline
// resolves &-suffix, &__element, and &--modifier by walking up to the
// nearest ancestor rule_set and concatenating the parent class name.

describe('Bug 7 — SCSS &-suffix nesting resolution', () => {
  beforeEach(() => {
    resetUnresolvedNestingCount();
  });

  it('resolves &-suffix to parent-suffix (BEM block-element concatenation)', async () => {
    const scss = `
      .form-group {
        color: black;
        &-header {
          font-weight: bold;
        }
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    const names = classes.map(c => c.className);
    expect(names).toContain('form-group');
    expect(names).toContain('form-group-header');
    expect(names).not.toContain('&-header');
  });

  it('resolves &__element BEM pattern', async () => {
    const scss = `
      .block {
        &__element {
          color: red;
        }
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    const names = classes.map(c => c.className);
    expect(names).toContain('block');
    expect(names).toContain('block__element');
  });

  it('resolves &--modifier BEM pattern', async () => {
    const scss = `
      .btn {
        &--large {
          font-size: 20px;
        }
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    const names = classes.map(c => c.className);
    expect(names).toContain('btn');
    expect(names).toContain('btn--large');
  });

  it('resolves multi-level &-suffix nesting', async () => {
    const scss = `
      .block {
        &__element {
          &--modifier {
            color: red;
          }
        }
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    const names = classes.map(c => c.className);
    expect(names).toContain('block');
    expect(names).toContain('block__element');
    expect(names).toContain('block__element--modifier');
  });

  it('drops &-suffix without parent rule_set (unresolvable)', async () => {
    const scss = `
      &-orphan {
        color: red;
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    const names = classes.map(c => c.className);
    // &-orphan without a parent should be registered as unresolvable
    const orphan = classes.find(c => c.className === '-orphan');
    expect(orphan).toBeDefined();
    expect(orphan!.unresolvable).toBe(true);
    expect(unresolvedNestingCount).toBeGreaterThan(0);
  });

  it('drops &.modifier as unresolvable garbage', async () => {
    const scss = `
      .btn {
        &.primary {
          background: blue;
        }
        &.disabled {
          opacity: 0.5;
        }
      }
    `;
    const classes = await extractClasses(scss, 'test.scss');
    // .btn should be extracted normally
    expect(classes.some(c => c.className === 'btn' && !c.unresolvable)).toBe(true);
    // &.primary and &.disabled should be unresolvable (not registered as literal "primary")
    const primary = classes.filter(c => c.className === 'primary');
    for (const p of primary) {
      expect(p.unresolvable).toBe(true);
    }
    expect(unresolvedNestingCount).toBeGreaterThan(0);
  });

  it('resolves selector context in declarations for SCSS nesting', async () => {
    const scss = `
      .card {
        background: white;
        &-header {
          font-weight: bold;
          color: red;
        }
      }
    `;
    // Use extractDeclarations instead of extractClasses — the helper
    // dispatches to extractDeclarationsFromCSSAst for .scss
    const adapter = registry.getAdapterForFile('test.scss');
    const ast = await adapter.parse('test.scss', scss);
    const decls = extractDeclarationsFromCSSAst(ast, adapter, 'test.scss', scss);
    const headerColor = decls.find(d => d.property === 'color');
    expect(headerColor).toBeDefined();
    // Selector context should resolve to card-header, not raw &-header
    expect(headerColor!.context).toContain('card-header');
  });

  it('resolves a bare & pseudo-class selector to the parent class (Spec 33 Item 7)', async () => {
    const scss = `
      .btn {
        &:not(:focus-visible) {
          outline: 2px solid;
        }
        &:hover {
          color: red;
        }
      }
    `;
    const adapter = registry.getAdapterForFile('test.scss');
    const ast = await adapter.parse('test.scss', scss);
    const decls = extractDeclarationsFromCSSAst(ast, adapter, 'test.scss', scss);

    const outline = findDecl(decls, 'outline');
    const color = findDecl(decls, 'color');
    expect(outline).toBeDefined();
    expect(color).toBeDefined();
    // Both bare `&` variants resolve to their parent class instead of
    // collapsing into the literal `&:…` context.
    expect(outline!.context).toContain('btn:not(:focus-visible)');
    expect(color!.context).toContain('btn:hover');
  });

  it('resolves a bare & through a nested & chain', async () => {
    const scss = `
      .btn {
        &:focus {
          &:not(:focus-visible) {
            outline: 2px solid;
          }
        }
      }
    `;
    const adapter = registry.getAdapterForFile('test.scss');
    const ast = await adapter.parse('test.scss', scss);
    const decls = extractDeclarationsFromCSSAst(ast, adapter, 'test.scss', scss);

    const outline = findDecl(decls, 'outline');
    expect(outline).toBeDefined();
    // Two levels of `&` unwinding resolves to `.btn`, not `.btn:focus`.
    expect(outline!.context).toContain('btn:not(:focus-visible)');
  });
});
