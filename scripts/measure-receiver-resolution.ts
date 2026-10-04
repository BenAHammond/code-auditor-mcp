/**
 * Measure the cross-file receiver resolution's overlap with the name list — the
 * Spec 69 §10 deletion-cost instrument (S2).
 *
 * The name list `DB_RECEIVER_NAMES = ['db','database','sql','stmt']` is
 * load-bearing in two consumers, both of which act on a *receiver*: a bare
 * identifier `name` that is the object of a member expression — `db.prepare()`
 * (raw SQL), `db.user.findMany()` (ORM/builder). The list marks that identifier
 * DB-provenanced; that then drives both the schema file gate
 * (`schema/discovery.ts:335`) and the data-access analyzer's call detection.
 *
 * A "name-list receiver" here is therefore a `(file, name)` pair where `name`
 * is a **bare identifier** (the direct object of a `member_expression`) whose
 * text is in the list. `this.db.query()` is deliberately *not* a receiver: its
 * object is the member expression `this.db`, not a bare `db`, and it fires via
 * the name-independent `this.<method>` path rather than the name list.
 *
 * For each receiver, classify what the structural cross-file resolution says,
 * independent of the name list:
 *
 *   1. recovered         — resolution marks it DB-provenanced (package import /
 *                          handle-type / propagation / wrapper / cross-file).
 *   2. not-a-DB-handle   — its declaration is a non-DB literal value
 *                          (string/template/number/object/array literal).
 *   3. nothing           — resolution cannot resolve it (runtime binding like
 *                          `env.DB`, a `./db` whose target is absent, an
 *                          unannotated parameter). These are the `cannot-fire`
 *                          cases — the silent-regression surface §10 forbids.
 *
 * These three numbers, per corpus, decide the deletion cost: if `recovered`
 * covers most receivers, the list can go without a receiver going unseen; if
 * `nothing` is large, deleting the list flips that many receivers to
 * `cannot-fire`, and the coverage-parity guard must show the cannot-fire count
 * rising by exactly that amount.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   npx tsx scripts/measure-receiver-resolution.ts /path/to/corpus [/path/to/another …]
 *
 * Read-only: writes nothing into the target; parses into memory only.
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { findFiles } from '../src/utils/fileDiscovery.js';
import { resolveReceiverProvenance } from '../src/analyzers/receiverResolution.js';
import type { SourceFile } from '../src/analyzers/receiverResolution.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import type { ASTNode, LanguageAdapter, AST } from '../src/languages/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// Must match DB_RECEIVER_NAMES in src/analyzers/universal/schema/config.ts.
const NAME_LIST = ['db', 'database', 'sql', 'stmt'];

/** Literal node types that make a declaration provably NOT a DB handle. */
const NON_DB_VALUE_TYPES = new Set([
  'string',
  'string_fragment',
  'template_string',
  'number',
  'object',
  'array',
  'true',
  'false',
  'null',
  'undefined',
]);

/**
 * Name-list receivers in one file, split by shape.
 *
 * The name list's actual load-bearing effect was a regex `\breceiver\.method\(`
 * over the source — which matched BOTH a bare identifier object (`db.query`)
 * AND a `this.<field>` member-expression object (`this.db.query`, where the
 * `\bdb\.` half matched inside `this.db`). The S2 instrument counted only the
 * bare shape, so `this.db` receivers were invisible to the deletion-cost
 * arithmetic (the F1 blind spot). This widened instrument returns both:
 *
 *   - `bare`      — a bare identifier `name ∈ NAME_LIST` that is the object of
 *                   a `member_expression` (`db.prepare`).
 *   - `thisField` — a `this.<field>` / `super.<field>` member expression whose
 *                   field text is in NAME_LIST (`this.db.query`). The receiver
 *                   name is the field (`db`), matching how the resolution and
 *                   the provenance map key on the identifier text.
 */
function receiverNames(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): { bare: Set<string>; thisField: Set<string> } {
  const bare = new Set<string>();
  const thisField = new Set<string>();
  const members = adapter.findNodes(ast, {
    custom: (n: ASTNode) => n.type === 'member_expression',
  });
  for (const me of members) {
    const children = adapter.getChildren(me);
    const object = children[0];
    if (!object) continue;
    if (object.type === 'identifier') {
      const name = adapter.getNodeText(object, sourceCode);
      if (NAME_LIST.includes(name)) bare.add(name);
    } else if (object.type === 'this' || object.type === 'super') {
      // `this.<field>` — the field is the property of this member expression.
      // `getChildren` returns [object, '.', property], so find the property by
      // type rather than assuming a fixed index.
      const property = children.find(
        (c) => c.type === 'property_identifier' || c.type === 'field_identifier',
      );
      if (!property) continue;
      const field = adapter.getNodeText(property, sourceCode);
      if (NAME_LIST.includes(field)) thisField.add(field);
    }
  }
  return { bare, thisField };
}

/**
 * True when `name` is declared in this file as a clearly non-DB value (a
 * literal/object/array). Used only for the `not-a-DB-handle` bucket; a name
 * with no such declaration falls through to `nothing`.
 */
function isProvablyNonDbDeclaration(name: string, ast: AST, adapter: LanguageAdapter): boolean {
  const declarators = adapter.findNodes(ast, {
    custom: (n: ASTNode) => n.type === 'variable_declarator',
  });
  for (const decl of declarators) {
    if (adapter.getNodeName(decl) !== name) continue;
    const children = adapter.getChildren(decl);
    const value = children.find(
      (c) =>
        c.type !== 'identifier' &&
        c.type !== 'object_pattern' &&
        c.type !== 'array_pattern' &&
        c.type !== '=',
    );
    if (!value) continue;
    return NON_DB_VALUE_TYPES.has(value.type);
  }
  return false;
}

async function measureCorpus(projectRoot: string): Promise<void> {
  const files = await findFiles(projectRoot);
  const inputs: SourceFile[] = [];
  for (const f of files) {
    if (f.includes('node_modules') || f.includes('/dist/') || f.includes('/build/')) continue;
    let content: string;
    try {
      content = await fs.readFile(f, 'utf-8');
    } catch {
      continue;
    }
    inputs.push({ path: f, content });
  }

  const report = await resolveReceiverProvenance(inputs, projectRoot);
  const registry = LanguageRegistry.getInstance();

  // Bare-receiver totals (the S2 denominator) and this.<field> totals (the F1
  // blind spot), reported separately so the corrected denominator is explicit.
  let bare = 0;
  let bareRecovered = 0;
  let bareNotHandle = 0;
  let bareNothing = 0;
  let thisField = 0;
  let thisFieldRecovered = 0;
  let thisFieldNotHandle = 0;
  let thisFieldNothing = 0;
  const byName = new Map<string, { total: number; recovered: number; notHandle: number; nothing: number }>();
  const thisByName = new Map<string, { total: number; recovered: number; notHandle: number; nothing: number }>();
  const notHandleSamples: Array<{ file: string; name: string }> = [];
  const unresolvedSamples: Array<{ file: string; name: string; shape: string }> = [];

  for (const f of inputs) {
    const adapter = registry.getAdapterForFile(f.path);
    if (!adapter) continue;
    const provenance = report.fileProvenance.get(path.resolve(f.path));
    let ast: AST | null = null;
    try {
      ast = await adapter.parse(f.path, f.content);
    } catch {
      ast = null;
    }
    if (!ast) continue;
    const { bare: bareSet, thisField: thisFieldSet } = receiverNames(ast, adapter, f.content);
    const rel = path.relative(projectRoot, f.path);
    for (const name of bareSet) {
      bare++;
      const isRecovered = provenance?.has(name) ?? false;
      const isNotHandle = !isRecovered && isProvablyNonDbDeclaration(name, ast, adapter);
      if (isRecovered) bareRecovered++;
      else if (isNotHandle) {
        bareNotHandle++;
        if (notHandleSamples.length < 40) notHandleSamples.push({ file: rel, name });
      } else {
        bareNothing++;
        if (unresolvedSamples.length < 40) unresolvedSamples.push({ file: rel, name, shape: 'bare' });
      }
      const b = byName.get(name) ?? { total: 0, recovered: 0, notHandle: 0, nothing: 0 };
      b.total++;
      if (isRecovered) b.recovered++;
      else if (isNotHandle) b.notHandle++;
      else b.nothing++;
      byName.set(name, b);
    }
    for (const name of thisFieldSet) {
      thisField++;
      const isRecovered = provenance?.has(name) ?? false;
      const isNotHandle = !isRecovered && isProvablyNonDbDeclaration(name, ast, adapter);
      if (isRecovered) thisFieldRecovered++;
      else if (isNotHandle) thisFieldNotHandle++;
      else {
        thisFieldNothing++;
        if (unresolvedSamples.length < 40) unresolvedSamples.push({ file: rel, name, shape: 'this.<field>' });
      }
      const b = thisByName.get(name) ?? { total: 0, recovered: 0, notHandle: 0, nothing: 0 };
      b.total++;
      if (isRecovered) b.recovered++;
      else if (isNotHandle) b.notHandle++;
      else b.nothing++;
      thisByName.set(name, b);
    }
    ast.dispose?.();
  }

  const total = bare + thisField;
  const recovered = bareRecovered + thisFieldRecovered;
  const notHandle = bareNotHandle + thisFieldNotHandle;
  const nothing = bareNothing + thisFieldNothing;

  console.log(`\n=== ${path.basename(projectRoot)} (${projectRoot}) ===`);
  console.log(`  bare receivers:           ${bare} (recovered ${bareRecovered} / not-handle ${bareNotHandle} / cannot-fire ${bareNothing})`);
  console.log(`  this.<field> receivers:   ${thisField} (recovered ${thisFieldRecovered} / not-handle ${thisFieldNotHandle} / cannot-fire ${thisFieldNothing})`);
  console.log(`  TOTAL receivers:          ${total}`);
  console.log(`  recovered (resolution):   ${recovered}`);
  console.log(`  not-a-DB-handle:          ${notHandle}`);
  console.log(`  nothing (cannot-fire):    ${nothing}`);
  console.log(`  unresolved imports:       ${report.unresolvedImports.length}`);
  for (const [name, b] of [...byName.entries()].sort()) {
    console.log(`    [bare] ${name}: ${b.total} (${b.recovered} recovered / ${b.notHandle} not-handle / ${b.nothing} nothing)`);
  }
  for (const [name, b] of [...thisByName.entries()].sort()) {
    console.log(`    [this] ${name}: ${b.total} (${b.recovered} recovered / ${b.notHandle} not-handle / ${b.nothing} nothing)`);
  }
  for (const s of notHandleSamples) {
    console.log(`    [not-handle] ${s.file} :: ${s.name}`);
  }
  for (const s of unresolvedSamples) {
    console.log(`    [nothing:${s.shape}] ${s.file} :: ${s.name}`);
  }
}

async function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error('usage: measure-receiver-resolution.ts <projectRoot> [<projectRoot> …]');
    process.exit(2);
  }
  initializeLanguages();
  await initParsers();
  for (const root of roots) {
    await measureCorpus(path.resolve(root));
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
