/**
 * Spec 68 §9 — the `type-declarations` producer.
 *
 * Re-homes the Go binary's struct/interface extraction (the `Struct`/`Interface`
 * `analyze` payloads in `analyzer-src/parser.go`) as a plain-data fact. It walks
 * the tree-sitter Go AST for `type_spec` nodes (the named declarations under a
 * `type (…)` block or a single `type X …`), and for each projects the two
 * metrics the size rules threshold on:
 *
 *   - a struct's `fieldCount` — the *expanded* field-name count, matching the
 *     Go binary's `len(structType.Fields.List)` expansion: `A, B, C int` is
 *     three `field_identifier`s (three fields), an embedded `Embedded` is one;
 *   - an interface's `methodCount` — its direct `method_elem` children only,
 *     matching the Go binary's `len(method.Names) > 0 && FuncType` filter:
 *     an embedded `type_elem` (`io.Reader`) is not a method.
 *
 * Only named `type_spec` declarations are projected. An anonymous
 * `var x struct { … }` literal is a `struct_type` with no `type_spec` parent and
 * is absent here — the Go binary likewise iterates `*ast.TypeSpec` alone. The
 * tree dies with the file; `struct-size` and `interface-size` read only this
 * data (they never reach the AST, and never spawn the Go subprocess).
 *
 * `walkAST`/`getNodeText` are shared adapterBridge utilities that survive §15.
 */

import type { AstFile, TypeDeclarationsFact } from './types.js';
import type { ASTNode } from '../languages/types.js';
import { walkAST, getNodeText } from '../languages/adapterBridge.js';

/** The expanded field count of a `struct_type` node (see the module header). */
function structFieldCount(structType: ASTNode): number {
  const list = (structType.children ?? []).find((c) => c.type === 'field_declaration_list');
  if (!list) return 0;
  let count = 0;
  for (const decl of list.children ?? []) {
    if (decl.type !== 'field_declaration') continue;
    const names = (decl.children ?? []).filter((c) => c.type === 'field_identifier');
    count += names.length > 0 ? names.length : 1;
  }
  return count;
}

/** The method count of an `interface_type` node: direct `method_elem`s only. */
function interfaceMethodCount(interfaceType: ASTNode): number {
  return (interfaceType.children ?? []).filter((c) => c.type === 'method_elem').length;
}

/** Extract every named struct/interface declaration from one parsed Go file. */
export function extractTypeDeclarations(file: AstFile): TypeDeclarationsFact[] {
  const out: TypeDeclarationsFact[] = [];
  walkAST(file.ast.root, (node) => {
    if (node.type !== 'type_spec') return;
    const name = (node.children ?? []).find((c) => c.type === 'type_identifier');
    const type = (node.children ?? []).find(
      (c) => c.type === 'struct_type' || c.type === 'interface_type',
    );
    if (!name || !type) return;
    // The `type_spec` name sits at the declaration's start line, matching the
    // Go binary's `typeSpec.Pos().Line` (= `Name.Pos().Line`). `location` is
    // already 1-based (adapterBridge), no further compensation.
    const line = name.location.start.line;
    const text = getNodeText(name, file.source);
    if (type.type === 'struct_type') {
      out.push({ kind: 'struct', file: file.file, name: text, line, fieldCount: structFieldCount(type) });
    } else {
      out.push({ kind: 'interface', file: file.file, name: text, line, methodCount: interfaceMethodCount(type) });
    }
  });
  return out;
}
