/**
 * Spec 68 §3.2 — the per-file `security-candidates` producer.
 *
 * Projects the three single-file security constructs (Spec 61 R6) onto the
 * serializable `SecurityCandidate` fact. It re-homes the *structural* half of
 * `UniversalSecurityAnalyzer` — the AST walk that decides whether a shell call's
 * command is interpolated/concatenated, whether a require/import specifier is
 * computed, and whether a template substitution reaches an HTML sink unescaped —
 * while leaving the *pure-text* classification (`isConfigPath`, the
 * test/fixture skip) and the finding construction (message/resolution/severity)
 * to the rule.
 *
 * The producer never decides "is this a finding": it projects the positional
 * context and the resolved name/prop, exactly as `secretCandidates.ts` does for
 * `secret-candidates`. For `unescaped-html` the producer re-homes the full
 * three-phase sink-flow analysis (`collectLocalFlow` → `collectSinkRoots` →
 * `propagateSinkFlow`) and the per-substitution resolution of the interpolated
 * member access; the rule's only job is to skip test/fixture files and assemble
 * the message/resolution.
 */

import type { AstFile, SecurityCandidate } from './types.js';
import { walkAST, getNodeText, getFieldNode } from '../languages/adapterBridge.js';
import type { AST, ASTNode } from '../languages/types.js';

/** Child-process entry points whose first argument is the command string. */
const SHELL_PROCESS_FUNCTIONS = new Set([
  'execSync', 'exec', 'execFile', 'execFileSync',
  'spawn', 'spawnSync', 'fork', 'execAsync',
]);

/** Escaping-call names that neutralize an HTML interpolation. */
const ESCAPE_FNS = new Set([
  'escapeHtml', 'htmlEscape', 'escape', 'escapeHTML',
  'sanitize', 'sanitizeHtml', 'h', 'e',
]);

/** Method names whose result still carries the receiver's value (taint flows). */
const RECEIVER_PASSTHROUGH_METHODS = new Set([
  'join', 'concat', 'toString', 'valueOf', 'slice', 'substring', 'substr',
  'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll',
  'toLowerCase', 'toUpperCase', 'padStart', 'padEnd', 'at', 'charAt',
  'filter', 'sort', 'flat', 'reverse',
]);

/** Array methods whose result is built from the callback's returned value. */
const MAP_VALUE_METHODS = new Set(['map', 'flatMap']);

/** Object names treated as an HTTP response whose `.send`/`.write` emits HTML. */
const HTTP_RESPONSE_OBJECTS = new Set(['res', 'response', 'resp', 'reply']);

/** A string-valued constant: a `string` node or a substitution-free template. */
function isStringConstant(node: ASTNode | undefined): boolean {
  if (!node) return false;
  if (node.type === 'string') return true;
  if (node.type === 'template_string') {
    const hasSub = (node.children ?? []).some((c) => c.type === 'template_substitution');
    return !hasSub;
  }
  return false;
}

/** A substitution's expression is a compile-time literal, not a computed value. */
function isLiteralNode(node: ASTNode | undefined): boolean {
  if (!node) return false;
  if (['string', 'number', 'true', 'false', 'null', 'undefined'].includes(node.type)) return true;
  if (node.type === 'template_string') {
    const hasSub = (node.children ?? []).some((c) => c.type === 'template_substitution');
    if (!hasSub) return true;
  }
  return false;
}

/** The first argument (child of the `arguments` node) of a call, if any. */
function firstArgument(node: ASTNode): ASTNode | undefined {
  const args = node.children?.find((c) => c.type === 'arguments');
  return args?.children?.[0];
}

/** `node` is a bare `require(x)` call — callee is the identifier `require`. */
function isBareRequire(node: ASTNode, sourceCode: string): boolean {
  const fn = node.children?.[0];
  return fn?.type === 'identifier' && getNodeText(fn, sourceCode) === 'require';
}

/** `node` is a `createRequire(...)(x)` call — callee is itself a createRequire call. */
function isCreateRequireInvocation(node: ASTNode, sourceCode: string): boolean {
  const fn = node.children?.[0];
  if (fn?.type !== 'call_expression') return false;
  const innerFn = fn.children?.[0];
  return innerFn?.type === 'identifier' && getNodeText(innerFn, sourceCode) === 'createRequire';
}

/** The operator text of a `binary_expression`, if it is the given token. */
function binaryOperatorIs(node: ASTNode, token: string, sourceCode: string): boolean {
  const op = getFieldNode(node, 'operator');
  if (op) return getNodeText(op, sourceCode).trim() === token;
  return (node.children ?? []).some((c) => getNodeText(c, sourceCode) === token);
}

/** The property name of a `member_expression` (`sessionData.path` → `path`). */
function memberPropertyName(node: ASTNode, sourceCode: string): string | null {
  const prop = node.children?.find((c) => c.type === 'property_identifier');
  return prop ? getNodeText(prop, sourceCode) : null;
}

/** Collect the expressions a function body can return (for taint-through-return). */
function collectReturnExpressions(bodyNode: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  walkAST(bodyNode, (n) => {
    if (n.type === 'return_statement') {
      const expr = (n.children ?? []).find((c) => c.type !== ';');
      if (expr) out.push(expr);
    }
  });
  return out;
}

/**
 * The sink arguments of an HTML-emitting call (`res.send`/`document.write`/
 * `insertAdjacentHTML`/`setHTMLUnsafe`/`.html(x)`), or [] for any other call.
 */
function htmlSinkArguments(callNode: ASTNode, sourceCode: string): ASTNode[] {
  const fn = callNode.children?.[0];
  if (fn?.type !== 'member_expression') return [];
  const prop = memberPropertyName(fn, sourceCode);
  const obj = fn.children?.find((c) => c.type === 'identifier');
  const objName = obj ? getNodeText(obj, sourceCode) : null;

  if (prop === 'insertAdjacentHTML') {
    const args = callNode.children?.find((c) => c.type === 'arguments');
    const values = (args?.children ?? []).filter((c) => c.type !== ',');
    const html = values[1];
    return html ? [html] : [];
  }
  if (prop === 'send' || prop === 'write') {
    if (!objName || (!HTTP_RESPONSE_OBJECTS.has(objName) && objName !== 'document')) return [];
    const first = firstArgument(callNode);
    return first ? [first] : [];
  }
  if (prop === 'setHTMLUnsafe') {
    const first = firstArgument(callNode);
    return first ? [first] : [];
  }
  if (prop === 'html') {
    const args = callNode.children?.find((c) => c.type === 'arguments');
    const first = args?.children?.[0];
    return first ? [first] : [];
  }
  return [];
}

/** The expressions a function body can return, used for taint-through-return. */
function returnsOf(fnNode: ASTNode): ASTNode[] {
  if (fnNode.type === 'arrow_function') {
    const block = fnNode.children?.find((c) => c.type === 'statement_block');
    if (!block) {
      for (let i = (fnNode.children ?? []).length - 1; i >= 0; i--) {
        const c = fnNode.children![i];
        if (c.type === 'formal_parameters' || c.type === '=>') continue;
        return [c];
      }
      return [];
    }
    return collectReturnExpressions(block);
  }
  const block = fnNode.children?.find((c) => c.type === 'statement_block');
  return block ? collectReturnExpressions(block) : [];
}

/** Phase 1 — local value flow: bindings + per-function-name return expressions. */
function collectLocalFlow(
  ast: AST,
  sourceCode: string,
): { bindings: Map<string, ASTNode[]>; returnsByName: Map<string, ASTNode[]> } {
  const bindings = new Map<string, ASTNode[]>();
  const returnsByName = new Map<string, ASTNode[]>();

  walkAST(ast.root, (node) => {
    if (node.type === 'variable_declarator') {
      const name = getFieldNode(node, 'name');
      const value = getFieldNode(node, 'value');
      if (name && value) {
        const n = getNodeText(name, sourceCode);
        const arr = bindings.get(n) ?? [];
        arr.push(value);
        bindings.set(n, arr);
        if (value.type === 'arrow_function' || value.type === 'function_expression') {
          const rets = returnsOf(value);
          if (rets.length) returnsByName.set(n, rets);
        }
      }
    } else if (node.type === 'function_declaration') {
      const name = getFieldNode(node, 'name');
      if (name) {
        const rets = returnsOf(node);
        if (rets.length) returnsByName.set(getNodeText(name, sourceCode), rets);
      }
    }
  });

  return { bindings, returnsByName };
}

/** Phase 2 — sink roots: every expression injected into an HTML sink. */
function collectSinkRoots(ast: AST, sourceCode: string): ASTNode[] {
  const sinkRoots: ASTNode[] = [];

  walkAST(ast.root, (node) => {
    if (node.type === 'call_expression') {
      for (const a of htmlSinkArguments(node, sourceCode)) sinkRoots.push(a);
    } else if (node.type === 'assignment_expression') {
      const left = getFieldNode(node, 'left');
      const right = getFieldNode(node, 'right');
      if (left?.type === 'member_expression' && right) {
        const prop = memberPropertyName(left, sourceCode);
        if (prop === 'innerHTML' || prop === 'outerHTML') sinkRoots.push(right);
      }
    } else if (node.type === 'pair') {
      const key = getFieldNode(node, 'key');
      const value = getFieldNode(node, 'value');
      if (key && value) {
        const keyText = getNodeText(key, sourceCode);
        const isHtmlKey = key.type === 'property_identifier'
          ? keyText === '__html'
          : keyText === '"__html"' || keyText === "'__html'";
        if (isHtmlKey) sinkRoots.push(value);
      }
    } else if (node.type === 'jsx_attribute') {
      const nameNode = node.children?.find(
        (c) => c.type === 'property_identifier' || c.type === 'identifier',
      );
      if (nameNode && getNodeText(nameNode, sourceCode) === 'dangerouslySetInnerHTML') {
        const valueNode = node.children?.find(
          (c) => c.type === 'jsx_expression' || c.type === 'string',
        );
        if (valueNode) {
          if (valueNode.type === 'jsx_expression') {
            const inner = valueNode.children?.find((c) => c.type !== '{' && c.type !== '}');
            if (inner) sinkRoots.push(inner);
          } else {
            sinkRoots.push(valueNode);
          }
        }
      }
    } else if (node.type === 'template_string') {
      const isVHtml = (node.children ?? []).some(
        (c) => c.type === 'string_fragment' && /v-html\s*=/i.test(getNodeText(c, sourceCode)),
      );
      if (isVHtml) sinkRoots.push(node);
    }
  });

  return sinkRoots;
}

/** Phase 3 — backward propagation from sink roots to the templates that reach them. */
function propagateSinkFlow(
  sinkRoots: ASTNode[],
  bindings: Map<string, ASTNode[]>,
  returnsByName: Map<string, ASTNode[]>,
  sourceCode: string,
): Set<ASTNode> {
  const producers = (e: ASTNode): ASTNode[] => {
    switch (e.type) {
      case 'identifier':
        return bindings.get(getNodeText(e, sourceCode)) ?? [];
      case 'template_string':
        return (e.children ?? [])
          .filter((c) => c.type === 'template_substitution')
          .map((s) => s.children?.[0])
          .filter((x): x is ASTNode => !!x);
      case 'parenthesized_expression': {
        const inner = e.children?.[0];
        return inner ? [inner] : [];
      }
      case 'binary_expression': {
        const left = getFieldNode(e, 'left');
        const right = getFieldNode(e, 'right');
        return [left, right].filter((x): x is ASTNode => !!x);
      }
      case 'ternary_expression': {
        const cons = getFieldNode(e, 'consequence');
        const alt = getFieldNode(e, 'alternative');
        return [cons, alt].filter((x): x is ASTNode => !!x);
      }
      case 'call_expression': {
        const fn = e.children?.[0];
        if (fn?.type === 'identifier') {
          return returnsByName.get(getNodeText(fn, sourceCode)) ?? [];
        }
        if (fn?.type === 'member_expression') {
          const prop = memberPropertyName(fn, sourceCode);
          if (prop && MAP_VALUE_METHODS.has(prop)) {
            const cb = firstArgument(e);
            if (cb && (cb.type === 'arrow_function' || cb.type === 'function_expression')) {
              return returnsOf(cb);
            }
            return [];
          }
          if (prop && RECEIVER_PASSTHROUGH_METHODS.has(prop)) {
            const obj = fn.children?.find(
              (c) => c.type !== 'property_identifier' && c.type !== '.' && c.type !== '?.',
            );
            return obj ? [obj] : [];
          }
        }
        return [];
      }
      default:
        return [];
    }
  };

  const sinkTemplates = new Set<ASTNode>();
  const seen = new Set<ASTNode>();
  const queue: ASTNode[] = [...sinkRoots];
  while (queue.length) {
    const e = queue.shift()!;
    if (seen.has(e)) continue;
    seen.add(e);
    if (e.type === 'template_string') sinkTemplates.add(e);
    for (const p of producers(e)) {
      if (!seen.has(p)) queue.push(p);
    }
  }
  return sinkTemplates;
}

/** The templates whose value reaches an HTML sink, per file. */
function computeHtmlSinkTemplates(ast: AST, sourceCode: string): Set<ASTNode> {
  const { bindings, returnsByName } = collectLocalFlow(ast, sourceCode);
  const sinkRoots = collectSinkRoots(ast, sourceCode);
  return propagateSinkFlow(sinkRoots, bindings, returnsByName, sourceCode);
}

/** The `command-injection` candidate for a shell call whose command is unsafe. */
function commandInjectionCandidate(node: ASTNode, sourceCode: string, filePath: string): SecurityCandidate | null {
  const fn = node.children?.[0];
  if (fn?.type !== 'identifier') return null;
  const fnName = getNodeText(fn, sourceCode);
  if (!SHELL_PROCESS_FUNCTIONS.has(fnName)) return null;

  const cmd = firstArgument(node);
  if (!cmd) return null;

  let unsafe = false;
  if (cmd.type === 'template_string') {
    unsafe = (cmd.children ?? []).some((c) => c.type === 'template_substitution');
  } else if (cmd.type === 'binary_expression') {
    if (binaryOperatorIs(cmd, '+', sourceCode)) {
      const left = getFieldNode(cmd, 'left');
      const right = getFieldNode(cmd, 'right');
      unsafe = !isLiteralNode(left) || !isLiteralNode(right);
    }
  }

  if (!unsafe) return null;

  return {
    kind: 'command-injection',
    fnName,
    file: filePath,
    line: node.location.start.line,
    column: node.location.start.column,
  };
}

/** The `dynamic-require` candidate for a computed require/import specifier. */
function dynamicRequireCandidate(node: ASTNode, sourceCode: string, filePath: string): SecurityCandidate | null {
  const fn = node.children?.[0];
  let isForm = false;
  if (isBareRequire(node, sourceCode) || fn?.type === 'import') {
    isForm = true;
  } else if (isCreateRequireInvocation(node, sourceCode)) {
    isForm = true;
  }
  if (!isForm) return null;

  const arg = firstArgument(node);
  if (!arg) return null;
  if (isLiteralNode(arg)) return null;

  return {
    kind: 'dynamic-require',
    argText: getNodeText(arg, sourceCode),
    calleeText: getNodeText(fn!, sourceCode),
    file: filePath,
    line: node.location.start.line,
    column: node.location.start.column,
  };
}

/** Resolve one template substitution to a `prop`-carrying candidate, or null. */
function interpolationCandidate(sub: ASTNode, sourceCode: string, filePath: string): SecurityCandidate | null {
  const expr = sub.children?.[0];
  if (!expr) return null;
  if (expr.type === 'call_expression') {
    const fn = expr.children?.[0];
    if (fn?.type === 'identifier' && ESCAPE_FNS.has(getNodeText(fn, sourceCode))) return null;
  }
  let value: ASTNode = expr;
  while (value.type === 'binary_expression') {
    const opNode = getFieldNode(value, 'operator');
    const op = opNode ? getNodeText(opNode, sourceCode).trim() : null;
    if (op !== '||' && op !== '??') return null;
    const left = getFieldNode(value, 'left');
    const right = getFieldNode(value, 'right');
    if (!left || !right) return null;
    if (!isStringConstant(right)) return null;
    value = left;
  }
  if (value.type !== 'member_expression') return null;
  const prop = memberPropertyName(value, sourceCode);
  if (!prop) return null;
  return {
    kind: 'unescaped-html',
    prop,
    file: filePath,
    line: sub.location.start.line,
    column: sub.location.start.column,
  };
}

/** The `unescaped-html` candidates for one sink-reaching template, honoring the
 *  script/style context so a substitution inside `<script>`/`<style>` is not
 *  misread as an HTML interpolation. */
function unescapedHtmlCandidates(template: ASTNode, sourceCode: string, filePath: string): SecurityCandidate[] {
  const out: SecurityCandidate[] = [];
  let scriptDepth = 0;
  let styleDepth = 0;
  for (const child of template.children ?? []) {
    if (child.type === 'string_fragment') {
      const text = getNodeText(child, sourceCode);
      const openScript = (text.match(/<script\b/gi) ?? []).length;
      const closeScript = (text.match(/<\/script\s*>/gi) ?? []).length;
      const openStyle = (text.match(/<style\b/gi) ?? []).length;
      const closeStyle = (text.match(/<\/style\s*>/gi) ?? []).length;
      scriptDepth = Math.max(0, scriptDepth + openScript - closeScript);
      styleDepth = Math.max(0, styleDepth + openStyle - closeStyle);
    } else if (child.type === 'template_substitution') {
      if (scriptDepth > 0 || styleDepth > 0) continue;
      const c = interpolationCandidate(child, sourceCode, filePath);
      if (c) out.push(c);
    }
  }
  return out;
}

/** One file's security constructs as `SecurityCandidate[]`. */
export function extractSecurityCandidates(file: AstFile): SecurityCandidate[] {
  const out: SecurityCandidate[] = [];
  const sourceCode = file.source;
  const filePath = file.file;

  walkAST(file.ast.root, (node) => {
    if (node.type !== 'call_expression') return;
    const inj = commandInjectionCandidate(node, sourceCode, filePath);
    if (inj) out.push(inj);
    const req = dynamicRequireCandidate(node, sourceCode, filePath);
    if (req) out.push(req);
  });

  const sinkTemplates = computeHtmlSinkTemplates(file.ast, sourceCode);
  walkAST(file.ast.root, (node) => {
    if (node.type === 'template_string' && sinkTemplates.has(node)) {
      out.push(...unescapedHtmlCandidates(node, sourceCode, filePath));
    }
  });

  return out;
}
