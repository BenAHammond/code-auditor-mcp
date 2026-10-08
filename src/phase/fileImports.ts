/**
 * Spec 68 §8 — the `file-imports` producer.
 *
 * Re-homes `clCollectFileInfo` / `clDynamicImport` (pipelineAdapters.ts) — the
 * per-file import/export half of the cross-language visitor that the legacy
 * dependency-graph reducer folded into `unreferenced-module`. The entity half
 * stayed with the `cross-language-entities` producer; this fact carries the
 * file-level reachability inputs a dead-module check needs:
 *
 *   - `imports` — resolved static import specifiers (TS `import_statement` +
 *     `export ... from` re-exports, Go `import_declaration`, static-string
 *     dynamic `import()`/`require()`) — the forward edges;
 *   - `hasExports` — TS/JS `export_statement`, or Go capitalized top-level
 *     names (the legacy visitor derived this from the extracted entities);
 *   - `unresolvedDynamicImports` — computed-specifier dynamic imports that
 *     cannot become an edge (a coverage diagnostic, not a finding).
 *
 * Re-homed (not imported) so §15 can delete the legacy visitor without the
 * phase model reaching back into it. `walkAST`/`getNodeText`/`getFieldNode`
 * are shared adapterBridge utilities — they survive §15; the walk bodies here
 * are the private helpers that don't.
 */

import { walkAST, getNodeText, getFieldNode } from '../languages/adapterBridge.js';
import type { AST, ASTNode } from '../languages/types.js';
import { extractCrossLanguageEntities } from '../pipelineAdapters.js';
import type { FileImportsFact } from './types.js';

/**
 * Detect a dynamic `import('…')`/`require('…')` call expression (re-homed from
 * `clDynamicImport`). Returns `{ specifier }` for a static-string argument,
 * `{ computed, expression }` for a computed specifier, or `null` otherwise.
 */
function dynamicImport(node: ASTNode, sourceCode: string): { specifier: string } | { computed: boolean; expression: string } | null {
  if (node.type !== 'call_expression') return null;
  const fn = node.children?.[0];
  const isImport = fn?.type === 'import';
  const isRequire = fn?.type === 'identifier' && getNodeText(fn, sourceCode) === 'require';
  if (!isImport && !isRequire) return null;

  const args = node.children?.find((c) => c.type === 'arguments');
  const stringNode = args?.children?.find((c) => c.type === 'string');
  if (stringNode) {
    const text = getNodeText(stringNode, sourceCode);
    if (text.length >= 2) {
      return { specifier: text.slice(1, -1) };
    }
  }

  // A template literal with no `${…}` substitution is a compile-time constant,
  // not a computed specifier — `import(\`@babel/plugin-syntax-jsx\`)` resolves
  // to an edge just like `import('@babel/plugin-syntax-jsx')`. Only an
  // interpolated template (`` import(`./${name}.js`) ``) is genuinely computed.
  const templateNode = args?.children?.find(
    (c) => c.type === 'template_string',
  );
  if (templateNode) {
    const hasSubstitution = (templateNode.children ?? []).some(
      (c) => c.type === 'template_substitution',
    );
    if (!hasSubstitution) {
      const t = getNodeText(templateNode, sourceCode);
      if (t.length >= 2 && t.startsWith('`') && t.endsWith('`')) {
        return { specifier: t.slice(1, -1) };
      }
    }
  }

  // Computed specifier — the target module cannot be resolved statically.
  const named = args?.children?.[0];
  const expression = named
    ? getNodeText(named, sourceCode)
    : getNodeText(args!, sourceCode).replace(/^\(|\)$/g, '').trim();
  return { computed: true, expression };
}

/** The re-homed `ClFileInfo` walk: imports, export presence, unresolved dynamics. */
function collectFileInfo(
  root: ASTNode,
  lang: string,
  sourceCode: string,
): { imports: string[]; hasExports: boolean; unresolvedDynamicImports: Array<{ line: number; expression: string }> } {
  const imports = new Set<string>();
  const unresolvedDynamicImports: Array<{ line: number; expression: string }> = [];
  let hasExports = false;
  walkAST(root, (node) => {
    if (node.type === 'import_statement') {
      const source = getFieldNode(node, 'source');
      if (source) {
        const text = getNodeText(source, sourceCode);
        imports.add(text.replace(/^['"]|['"]$/g, ''));
      }
    } else if (node.type === 'import_declaration') {
      for (const spec of node.children ?? []) {
        if (spec.type === 'import_spec') {
          const p = getFieldNode(spec, 'path');
          if (p) {
            const text = getNodeText(p, sourceCode);
            imports.add(text.replace(/^['"]|['"]$/g, ''));
          }
        }
      }
    } else if (node.type === 'export_statement') {
      hasExports = true;
      // Re-exports (`export { x } from './y'`, `export * from './y'`) are import
      // edges for reachability: a barrel re-exporting a module marks it live.
      const source = getFieldNode(node, 'source');
      if (source) {
        const text = getNodeText(source, sourceCode);
        imports.add(text.replace(/^['"]|['"]$/g, ''));
      }
    } else if (node.type === 'call_expression') {
      const dyn = dynamicImport(node, sourceCode);
      if (dyn && 'specifier' in dyn) {
        imports.add(dyn.specifier);
      } else if (dyn) {
        unresolvedDynamicImports.push({ line: node.location.start.line, expression: dyn.expression });
      }
    }
  });
  return { imports: [...imports], hasExports, unresolvedDynamicImports };
}

/**
 * Extract one file's `file-imports` fact. `hasExports` for Go is the
 * capitalized-top-level-name check the legacy visitor derived from the
 * extracted entities (Go has no `export` keyword); the entity extraction is
 * re-used verbatim so the definition of "public" cannot drift from the
 * `cross-language-entities` producer. §6 collapses this to a single parse.
 *
 * @param ast - The parsed file's AST to walk for imports and export presence.
 * @param filePath - The file's path (used for the Go entity extraction and the fact).
 * @param sourceCode - The file's source text (for node text and Go entities).
 * @param lang - The file's language key (`'go'` vs TS/JS).
 * @returns The file's imports, export presence, and unresolved dynamic imports.
 */
export function extractFileImports(
  ast: AST,
  filePath: string,
  sourceCode: string,
  lang: string,
): FileImportsFact {
  const info = collectFileInfo(ast.root, lang, sourceCode);
  const hasExports = lang === 'go'
    ? extractCrossLanguageEntities(ast, filePath, sourceCode, lang).some((e) => e.visibility === 'public')
    : info.hasExports;
  return {
    file: filePath,
    imports: info.imports,
    hasExports,
    unresolvedDynamicImports: info.unresolvedDynamicImports,
  };
}
