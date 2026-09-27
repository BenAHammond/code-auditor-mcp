/**
 * Spec 68 §9 — the `error-bindings`, `concurrency-primitives` and
 * `channel-operations` producers.
 *
 * Re-homes the Go binary's non-SOLID function walks (`runErrorAnalysis`,
 * `runGoroutineAnalysis`, `runChannelAnalysis` in `analyzer-src/analyzer.go`) as
 * plain-data facts. Each walks the tree-sitter Go AST for `function_declaration`
 * / `method_declaration` nodes and projects the inputs the rule's verdict reads:
 *
 *   - `error-bindings` — the byte offsets of every `err` binding-from-a-call and
 *     every "checking" use, plus the named-`err`-result signal (`functionDropsError`);
 *   - `concurrency-primitives` — whether the body has a `go` statement and whether
 *     it carries a synchronization signal (`analyzeConcurrency`);
 *   - `channel-operations` — the unbuffered-channel names (`make(chan T)`) and the
 *     send/receive counts per bare-identifier channel, plus the `go`-statement
 *     signal (`deadlockChannel`).
 *
 * Positions are byte offsets (`ASTNode.range[0]`) — the same total order the Go
 * binary's `token.Pos` byte offsets carried, so the `error-handling` rule's
 * "check strictly between this assign and the next" verdict is identical. Test
 * functions (`Test`/`Benchmark`/`Example`/`Fuzz`) are skipped; methods are
 * included (the Go binary's `*ast.FuncDecl` covers both free functions and
 * methods). The tree dies with the file; the rules read only this data.
 */

import type { ASTNode } from '../languages/types.js';
import { walkAST, getNodeText, getFieldNode } from '../languages/adapterBridge.js';
import { isTestFile } from '../languages/testConventions.js';
import type {
  AstFile,
  ErrorBindingsFact,
  ConcurrencyPrimitivesFact,
  ChannelOperationsFact,
} from './types.js';

/** The Go binary's `isTestFunction` prefix set (`testconventions.go`). */
function isTestFunction(name: string): boolean {
  return (
    name.startsWith('Test') ||
    name.startsWith('Benchmark') ||
    name.startsWith('Example') ||
    name.startsWith('Fuzz')
  );
}

/** Non-comma children of an `expression_list` / `argument_list` node. */
function listElements(list: ASTNode | undefined): ASTNode[] {
  return (list?.children ?? []).filter((c) => c.type !== ',');
}

/** True for the blank identifier `_` (identifier in expression position, or the
 *  `blank_identifier` node tree-sitter-go emits in import position). */
function isBlank(node: ASTNode, source: string): boolean {
  return node.type === 'blank_identifier' || (node.type === 'identifier' && getNodeText(node, source) === '_');
}

/** The parenthesised result `parameter_list` of a function/method, or undefined. */
function resultParamList(node: ASTNode, isMethod: boolean): ASTNode | undefined {
  const children = node.children ?? [];
  const blockIdx = children.findIndex((c) => c.type === 'block');
  if (blockIdx < 0) return undefined;
  const before = children[blockIdx - 1];
  if (!before || before.type !== 'parameter_list') return undefined;
  const paramLists = children.slice(0, blockIdx).filter((c) => c.type === 'parameter_list').length;
  const nonResultLists = isMethod ? 2 : 1;
  if (paramLists <= nonResultLists) return undefined;
  return before;
}

/** The Go binary's `funcDeclHasNamedErr`: the result list names an `err` result. */
function hasNamedErrResult(node: ASTNode, isMethod: boolean, source: string): boolean {
  const results = resultParamList(node, isMethod);
  if (!results) return false;
  for (const decl of results.children ?? []) {
    if (decl.type !== 'parameter_declaration') continue;
    for (const id of decl.children ?? []) {
      if (id.type === 'identifier' && getNodeText(id, source) === 'err') return true;
    }
  }
  return false;
}

/** The function name node (`identifier` for a function, `field_identifier` for a
 *  method), or undefined. */
function nameNodeOf(node: ASTNode): ASTNode | undefined {
  return (node.children ?? []).find((c) => c.type === 'identifier' || c.type === 'field_identifier');
}

/** Visit every non-test function/method with a body, in source order. */
function forEachGoFunction(
  file: AstFile,
  visit: (node: ASTNode, name: string, block: ASTNode, isMethod: boolean) => void,
): void {
  walkAST(file.ast.root, (node) => {
    if (node.type !== 'function_declaration' && node.type !== 'method_declaration') return;
    const isMethod = node.type === 'method_declaration';
    const nameNode = nameNodeOf(node);
    if (!nameNode) return;
    const name = getNodeText(nameNode, file.source);
    if (isTestFunction(name)) return;
    const block = (node.children ?? []).find((c) => c.type === 'block');
    if (!block) return;
    visit(node, name, block, isMethod);
  });
}

// ── error-bindings ──────────────────────────────────────────────────────────

/** Extract every non-test function's error-binding positions from one Go file. */
export function extractErrorBindings(file: AstFile): ErrorBindingsFact[] {
  if (isTestFile('go', file.file)) return [];
  const out: ErrorBindingsFact[] = [];
  forEachGoFunction(file, (node, name, block, isMethod) => {
    const namedErr = hasNamedErrResult(node, isMethod, file.source);
    const assignPositions: number[] = [];
    const checkPositions: number[] = [];

    walkAST(block, (n) => {
      if (n.type === 'short_var_declaration' || n.type === 'assignment_statement') {
        const lhs = listElements(getFieldNode(n, 'left'));
        const rhs = listElements(getFieldNode(n, 'right'));
        // An `err` binding from a call result (`assignHasCallRHS`).
        if (rhs.some((e) => e.type === 'call_expression')) {
          for (const l of lhs) {
            if (l.type === 'identifier' && getNodeText(l, file.source) === 'err') {
              assignPositions.push(l.range[0]);
            }
          }
        }
        // Explicit ignore `_ = err`.
        if (lhs.length === 1 && rhs.length === 1 && isBlank(lhs[0], file.source)) {
          if (rhs[0].type === 'identifier' && getNodeText(rhs[0], file.source) === 'err') {
            checkPositions.push(rhs[0].range[0]);
          }
        }
      } else if (n.type === 'binary_expression') {
        // `err != nil` / `err == nil`.
        if ((n.children ?? []).some((c) => c.type === '!=' || c.type === '==')) {
          for (const side of [getFieldNode(n, 'left'), getFieldNode(n, 'right')]) {
            if (side && side.type === 'identifier' && getNodeText(side, file.source) === 'err') {
              checkPositions.push(side.range[0]);
            }
          }
        }
      } else if (n.type === 'return_statement') {
        const results = listElements((n.children ?? []).find((c) => c.type === 'expression_list'));
        // A bare `return` propagates a named `err` result.
        if (results.length === 0 && namedErr) {
          checkPositions.push(n.range[0]);
        }
        for (const r of results) {
          if (r.type === 'identifier' && getNodeText(r, file.source) === 'err') {
            checkPositions.push(r.range[0]);
          }
        }
      } else if (n.type === 'call_expression') {
        const args = (n.children ?? []).find((c) => c.type === 'argument_list');
        for (const arg of listElements(args)) {
          if (arg.type === 'identifier' && getNodeText(arg, file.source) === 'err') {
            checkPositions.push(arg.range[0]);
          }
        }
      }
    });

    out.push({
      file: file.file,
      name,
      line: node.location.start.line,
      hasNamedErr: namedErr,
      assignPositions,
      checkPositions,
    });
  });
  return out;
}

// ── concurrency-primitives ──────────────────────────────────────────────────

/** The sync-method selector names that signal synchronization (`syncMethodNames`). */
const SYNC_METHOD_NAMES = new Set([
  'Add',
  'Done',
  'Wait',
  'Lock',
  'Unlock',
  'RLock',
  'RUnlock',
]);

/** Extract every non-test function's goroutine-synchronization signal. */
export function extractConcurrencyPrimitives(file: AstFile): ConcurrencyPrimitivesFact[] {
  if (isTestFile('go', file.file)) return [];
  const out: ConcurrencyPrimitivesFact[] = [];
  forEachGoFunction(file, (node, name, block) => {
    let hasGo = false;
    let hasSync = false;
    walkAST(block, (n) => {
      if (hasGo && hasSync) return;
      if (n.type === 'go_statement') {
        hasGo = true;
      } else if (n.type === 'send_statement') {
        hasSync = true;
      } else if (n.type === 'unary_expression') {
        if (getNodeText(n, file.source).trimStart().startsWith('<-')) hasSync = true;
      } else if (n.type === 'selector_expression') {
        const field = (n.children ?? []).find((c) => c.type === 'field_identifier');
        if (field && SYNC_METHOD_NAMES.has(getNodeText(field, file.source))) hasSync = true;
      }
    });
    out.push({ file: file.file, name, line: node.location.start.line, hasGo, hasSync });
  });
  return out;
}

// ── channel-operations ──────────────────────────────────────────────────────

/** The Go binary's `isUnbufferedMakeChan`: `make(chan T)` with one argument. */
function isUnbufferedMakeChan(rhs: ASTNode, source: string): boolean {
  if (rhs.type !== 'call_expression') return false;
  const fn = (rhs.children ?? []).find((c) => c.type === 'identifier');
  if (!fn || getNodeText(fn, source) !== 'make') return false;
  const args = (rhs.children ?? []).find((c) => c.type === 'argument_list');
  const elements = listElements(args);
  if (elements.length !== 1) return false;
  return elements[0].type === 'channel_type';
}

/** Extract every non-test function's unbuffered-channel + operation counts. */
export function extractChannelOperations(file: AstFile): ChannelOperationsFact[] {
  if (isTestFile('go', file.file)) return [];
  const out: ChannelOperationsFact[] = [];
  forEachGoFunction(file, (node, name, block) => {
    const unbuffered = new Set<string>();
    const ops: Record<string, number> = {};
    let hasGo = false;

    walkAST(block, (n) => {
      if (n.type === 'go_statement') {
        hasGo = true;
        return;
      }
      if (n.type === 'short_var_declaration' || n.type === 'assignment_statement') {
        const lhs = listElements(getFieldNode(n, 'left'));
        const rhs = listElements(getFieldNode(n, 'right'));
        for (let i = 0; i < rhs.length; i++) {
          if (isUnbufferedMakeChan(rhs[i], file.source) && i < lhs.length) {
            const l = lhs[i];
            if (l.type === 'identifier') unbuffered.add(getNodeText(l, file.source));
          }
        }
      } else if (n.type === 'send_statement') {
        const ch = getFieldNode(n, 'channel');
        if (ch && ch.type === 'identifier') {
          const chName = getNodeText(ch, file.source);
          ops[chName] = (ops[chName] ?? 0) + 1;
        }
      } else if (n.type === 'unary_expression') {
        if (getNodeText(n, file.source).trimStart().startsWith('<-')) {
          const operand = getFieldNode(n, 'operand');
          if (operand && operand.type === 'identifier') {
            const chName = getNodeText(operand, file.source);
            ops[chName] = (ops[chName] ?? 0) + 1;
          }
        }
      }
    });

    out.push({
      file: file.file,
      name,
      line: node.location.start.line,
      hasGo,
      unbuffered: [...unbuffered],
      ops,
    });
  });
  return out;
}
