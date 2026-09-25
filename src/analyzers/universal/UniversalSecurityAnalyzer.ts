/**
 * Universal Security Analyzer
 *
 * Spec 61 R6 — the three single-file syntactic rules the tool should have had
 * but did not, so twelve hand-found security defects passed a self-audit
 * silently:
 *
 *   - `command-injection-risk`        — a shell/process invocation whose command
 *     is built by interpolation or string concatenation.
 *   - `dynamic-require-of-project-path` — `require()` / `createRequire(...)()` /
 *     `import()` of a path discovered from the project tree (a config candidate,
 *     a directory walk, a project-root join), which *executes* the file.
 *   - `unescaped-html-interpolation`  — a data value interpolated into an HTML
 *     template without an escaping call (stored XSS).
 *
 * The three share the same shape as the other universal security analyzers: a
 * single `analyzeAST` that walks the tree and emits violations, test/fixture
 * files excluded up front (a fixture's `execSync(\`cp …\`)` is scaffolding, not
 * a finding).
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { withRuleTiming } from '../ruleTiming.js';
import { walkAST, getNodeText, getFieldNode } from '../../languages/adapterBridge.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';

/** Configuration for the Security analyzer. */
export interface SecurityAnalyzerConfig {
  checkCommandInjection?: boolean;
  checkDynamicRequire?: boolean;
  checkUnescapedHtml?: boolean;
}

export const DEFAULT_SECURITY_CONFIG: SecurityAnalyzerConfig = {
  checkCommandInjection: true,
  checkDynamicRequire: true,
  checkUnescapedHtml: true,
};

/**
 * Child-process entry points whose *first argument* is the command string. When
 * that string is interpolated or concatenated, a value the operator did not
 * intend can become a shell command. `execAsync` is `util.promisify(exec)` — the
 * same sink under a different name (RuntimeManager's pre-fix `execAsync(\`cd
 * "${goDir}" && …\`)` is the proof site).
 */
const SHELL_PROCESS_FUNCTIONS = new Set([
  'execSync', 'exec', 'execFile', 'execFileSync',
  'spawn', 'spawnSync', 'fork', 'execAsync',
]);

/** Escaping-call names that neutralize an HTML interpolation. */
const ESCAPE_FNS = new Set([
  'escapeHtml', 'htmlEscape', 'escape', 'escapeHTML',
  'sanitize', 'sanitizeHtml', 'h', 'e',
]);

/**
 * Method names on a string/array whose result still carries the receiver's
 * value (taint flows receiver → result). Covers string derivations (`join`,
 * `slice`, `trim`, …) and array passthroughs (`filter`, `sort`, …) alike.
 */
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
    if (!hasSub) return true; // substitution-free template is a constant
  }
  return false;
}

/** Is this path a test/fixture file? Excluded up front (see header). */
function isTestOrFixtureFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('.test.') || lower.includes('.spec.') ||
    lower.includes('__tests__') ||
    lower.includes('/test/') || lower.includes('/tests/') ||
    lower.includes('/fixtures/') || lower.includes('.fixture.') ||
    lower.endsWith('_test.go')
  );
}

/**
 * The first argument (child of the `arguments` node) of a call, if any.
 */
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

/**
 * The property name of a `member_expression` (`sessionData.path` → `path`),
 * or null when there is no property identifier.
 */
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
 * The sink arguments of an HTML-emitting call: `res.send(x)` / `res.write(x)` /
 * `document.write(x)` (first argument), `el.insertAdjacentHTML(pos, x)` (second
 * argument), `el.setHTMLUnsafe(x)` (first argument), and the jQuery/Hono
 * `.html(x)` setter (first argument — the getter `.html()` has no argument and
 * is a read, not a sink). Returns [] for any other call.
 */
function htmlSinkArguments(callNode: ASTNode, sourceCode: string): ASTNode[] {
  const fn = callNode.children?.[0];
  if (fn?.type !== 'member_expression') return [];
  const prop = memberPropertyName(fn, sourceCode);
  const obj = fn.children?.find((c) => c.type === 'identifier');
  const objName = obj ? getNodeText(obj, sourceCode) : null;

  if (prop === 'insertAdjacentHTML') {
    // `el.insertAdjacentHTML(pos, html)` — the HTML is the *second* argument.
    // The `arguments` children include the inter-argument `,` as a significant
    // anonymous node, so filter it out rather than assuming `children[1]`.
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
    // `Element.setHTMLUnsafe(x)` parses `x` as HTML on any receiver, so there is
    // no object-name gate (unlike `res.send`/`document.write`).
    const first = firstArgument(callNode);
    return first ? [first] : [];
  }
  if (prop === 'html') {
    // jQuery `.html(content)` setter and Hono `c.html(content)` response both
    // treat the argument as HTML. The getter `.html()` (no argument) is a read.
    const args = callNode.children?.find((c) => c.type === 'arguments');
    const first = args?.children?.[0];
    return first ? [first] : [];
  }
  return [];
}

/**
 * Security analyzer: three Spec-61 rules that should have caught the twelve
 * hand-found defects.
 */
export class UniversalSecurityAnalyzer extends UniversalAnalyzer {
  readonly name = 'security';
  readonly description = 'Detects command injection, dynamic require of project paths, and unescaped HTML interpolation';
  readonly category = 'security';

  /**
   * Per-file presence of each rule's *trigger construct*, reset on every
   * `analyzeAST` call. Coverage uses this to distinguish `clean` ("the construct
   * the rule inspects is present, and nothing was wrong") from `notApplicable`
   * ("no such construct anywhere in the corpus — nothing to check"). Without it,
   * a repo with no shell invocation reads `clean` on `command-injection-risk`,
   * the tool's strongest claim, when the truth is the input was never there.
   */
  private lastSawInput = { shellProcess: false, dynamicRequire: false, htmlSink: false };

  /** Which trigger constructs the most recent `analyzeAST` call encountered. */
  get inputPresence(): { shellProcess: boolean; dynamicRequire: boolean; htmlSink: boolean } {
    return { ...this.lastSawInput };
  }

  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: SecurityAnalyzerConfig,
    sourceCode: string,
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_SECURITY_CONFIG, ...config };
    if (isTestOrFixtureFile(ast.filePath)) return violations;
    this.lastSawInput = { shellProcess: false, dynamicRequire: false, htmlSink: false };

    if (finalConfig.checkCommandInjection !== false) {
      withRuleTiming('command-injection-risk', () => {
        walkAST(ast.root, (node) => {
          if (node.type === 'call_expression') {
            violations.push(...this.checkCommandInjection(node, adapter, sourceCode, ast.filePath));
          }
        });
      });
    }

    if (finalConfig.checkDynamicRequire !== false) {
      withRuleTiming('dynamic-require-of-project-path', () => {
        walkAST(ast.root, (node) => {
          if (node.type === 'call_expression') {
            violations.push(...this.checkDynamicRequire(node, adapter, sourceCode, ast.filePath));
          }
        });
      });
    }

    if (finalConfig.checkUnescapedHtml !== false) {
      withRuleTiming('unescaped-html-interpolation', () => {
        const sinkTemplates = this.computeHtmlSinkTemplates(ast, sourceCode);
        walkAST(ast.root, (node) => {
          if (node.type === 'template_string' && sinkTemplates.has(node)) {
            violations.push(...this.checkUnescapedHtml(node, adapter, sourceCode, ast.filePath));
          }
        });
      });
    }

    return violations;
  }

  // ── command-injection-risk ────────────────────────────────────────────────

  private checkCommandInjection(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
    filePath: string,
  ): Violation[] {
    const fn = node.children?.[0];
    // Only a bare identifier (`execSync(...)`), never a member access
    // (`this.db.exec(...)` is SQLite, not a shell).
    if (fn?.type !== 'identifier') return [];
    const fnName = getNodeText(fn, sourceCode);
    if (!SHELL_PROCESS_FUNCTIONS.has(fnName)) return [];

    // The rule's input is present — a shell/process invocation exists in the
    // corpus, whether or not this particular one is interpolated. Record it so
    // coverage can report `clean` rather than `notApplicable`.
    this.lastSawInput.shellProcess = true;

    const cmd = firstArgument(node);
    if (!cmd) return [];

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

    if (!unsafe) return [];

    return [this.createViolation(
      filePath,
      node.location.start,
      `Unsafe process invocation: ${fnName}() is passed a command built by interpolation/concatenation, so a value can become a shell command. Pass the command as a string literal and arguments as an argv array (execFileSync/spawn), never a shell string.`,
      {
        severity: 'critical',
        rule: 'command-injection-risk',
        symbol: fnName,
        resolution: {
          action: 'use-argv-array',
          summary: `Replace ${fnName} with an argv-array form (execFileSync/spawn) whose command is a string literal and whose arguments are separate array elements, so no shell interprets them.`,
          symbols: [fnName],
          files: [filePath],
          lines: [node.location.start.line],
        },
      },
    )];
  }

  // ── dynamic-require-of-project-path ────────────────────────────────────────

  private checkDynamicRequire(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
    filePath: string,
  ): Violation[] {
    const fn = node.children?.[0];
    let isForm = false;
    if (isBareRequire(node, sourceCode) || fn?.type === 'import') {
      isForm = true; // require(x) or import(x)
    } else if (isCreateRequireInvocation(node, sourceCode)) {
      isForm = true; // createRequire(...)(x)
    }
    if (!isForm) return [];

    // A require()/import()/createRequire(...)() invocation exists — the rule's
    // input is present regardless of whether the specifier is computed.
    this.lastSawInput.dynamicRequire = true;

    const arg = firstArgument(node);
    if (!arg) return [];

    // Computed: not a string literal, and not a substitution-free template.
    if (isLiteralNode(arg)) return [];

    const text = getNodeText(arg, sourceCode).toLowerCase();
    // Project-config-path-derived: a config-named path (the config candidate /
    // project-root join / directory-walk result this rule exists to catch).
    const isConfigPath = /config/.test(text) && /path|file|dir|join\(|resolve\(|pathtofileurl|href/.test(text);
    if (!isConfigPath) return [];

    return [this.createViolation(
      filePath,
      node.location.start,
      `Dynamic require/import of a project config path: ${getNodeText(arg, sourceCode)}. A path discovered from the project tree is executed when it is require()'d or import()'d. Read config files without executing them (static extraction).`,
      {
        severity: 'critical',
        rule: 'dynamic-require-of-project-path',
        resolution: {
          action: 'static-config-extraction',
          summary: 'Replace the dynamic require/import with static extraction (read the source and extract the literal export) so a project-supplied config is never executed.',
          symbols: [getNodeText(fn!, sourceCode)],
          files: [filePath],
          lines: [node.location.start.line],
        },
      },
    )];
  }

  // ── unescaped-html-interpolation ───────────────────────────────────────────

  /**
   * Backward-reachability: which template literals in this file have a value
   * that reaches an HTML sink? A template whose value flows into such a sink is
   * the only place an unescaped interpolation becomes stored XSS — the trigger
   * is *where the string goes*, not what its text looks like.
   *
   * Split into three single-purpose phases — collect local value flow, collect
   * sink roots, then propagate backward — rather than one fused visitor. The
   * fused form is what pushed this method over the `method-complexity`
   * threshold: a single walk that simultaneously dispatched per node type to
   * build bindings/returns *and* sink roots, plus the backward-propagation
   * switch. Each phase is now a small walk with one job; none individually
   * crosses the threshold, and no exemption is needed.
   */
  private computeHtmlSinkTemplates(ast: AST, sourceCode: string): Set<ASTNode> {
    const { bindings, returnsByName } = this.collectLocalFlow(ast, sourceCode);
    const sinkRoots = this.collectSinkRoots(ast, sourceCode);
    return this.propagateSinkFlow(sinkRoots, bindings, returnsByName, sourceCode);
  }

  /** The expressions a function body can return, used for taint-through-return. */
  private returnsOf(fnNode: ASTNode): ASTNode[] {
    if (fnNode.type === 'arrow_function') {
      const block = fnNode.children?.find((c) => c.type === 'statement_block');
      if (!block) {
        // Expression body: the expression itself is the return value.
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

  /**
   * Phase 1 — local value flow: bind every declared name to its initializer and
   * record, per function name, the expressions its body can return. The
   * taint-through-return producer (`call_expression` → a named function's return)
   * reads this map.
   */
  private collectLocalFlow(
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
            const rets = this.returnsOf(value);
            if (rets.length) returnsByName.set(n, rets);
          }
        }
      } else if (node.type === 'function_declaration') {
        const name = getFieldNode(node, 'name');
        if (name) {
          const rets = this.returnsOf(node);
          if (rets.length) returnsByName.set(getNodeText(name, sourceCode), rets);
        }
      }
    });

    return { bindings, returnsByName };
  }

  /**
   * Phase 2 — sink roots: every expression that is injected into an HTML sink.
   * Sink roots are collected from three places: (1) HTML-emitting calls —
   * `insertAdjacentHTML`, `res.send`/`res.write`, `document.write`,
   * `setHTMLUnsafe`, jQuery/Hono `.html(x)` (`htmlSinkArguments`); (2) property
   * writes/attributes — `innerHTML`/`outerHTML` assignment, React's
   * `dangerouslySetInnerHTML` in both its forms (the JSX attribute and the
   * `__html` object key); and (3) Vue's `v-html` directive, where the template
   * string is itself the sink.
   */
  private collectSinkRoots(ast: AST, sourceCode: string): ASTNode[] {
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
        // React's `dangerouslySetInnerHTML={{ __html: x }}` — and its extracted
        // `const markup = { __html: x }` form — put the raw-HTML value under the
        // `__html` key. Any expression bound to `__html` is injected as HTML.
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
        // React's `dangerouslySetInnerHTML` as the JSX *attribute* (the other
        // form alongside the `__html` key above). The attribute is itself a sink
        // marker: whatever expression is bound to it is injected as raw HTML.
        // Its value is normally `{{ __html: x }}` (whose `__html` pair is already
        // a sink root via the branch above); this branch also covers a bare
        // `dangerouslySetInnerHTML={expr}` whose expression is not an `__html`
        // object, so the attribute name alone is enough to mark the value a sink.
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
        // Vue's `v-html` directive: the template *is* the sink (the bound value
        // is injected as raw HTML), so a template carrying `v-html=` is its own
        // sink root even without an enclosing call/assignment.
        const isVHtml = (node.children ?? []).some(
          (c) => c.type === 'string_fragment' && /v-html\s*=/i.test(getNodeText(c, sourceCode)),
        );
        if (isVHtml) sinkRoots.push(node);
      }
    });

    // An HTML sink exists in the corpus — the rule's input is present whether or
    // not any interpolation reaches it unescaped.
    if (sinkRoots.length > 0) this.lastSawInput.htmlSink = true;

    return sinkRoots;
  }

  /**
   * Phase 3 — backward propagation: a worklist from each sink root through
   * value flow (`producers`) to find which template literals actually reach a
   * sink. Only those templates are candidates for `checkUnescapedHtml`.
   */
  private propagateSinkFlow(
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
                return this.returnsOf(cb);
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

  private checkUnescapedHtml(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
    filePath: string,
  ): Violation[] {
    // Reached only for templates whose value flows to an HTML sink (see
    // computeHtmlSinkTemplates), so no markup check is needed here. Walk the
    // template's children in order, tracking script/style context so a
    // substitution inside `<script>`/`<style>` (JSON serialization, CSS vars) is
    // not misread as an HTML interpolation.
    const violations: Violation[] = [];
    let scriptDepth = 0;
    let styleDepth = 0;
    for (const child of node.children ?? []) {
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
        const v = this.checkInterpolation(child, adapter, sourceCode, filePath);
        if (v) violations.push(v);
      }
    }
    return violations;
  }

  private checkInterpolation(
    sub: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
    filePath: string,
  ): Violation | null {
    const expr = sub.children?.[0];
    if (!expr) return null;
    // Escape-wrapped (`${escapeHtml(x)}`) is the fix, not the finding.
    if (expr.type === 'call_expression') {
      const fn = expr.children?.[0];
      if (fn?.type === 'identifier' && ESCAPE_FNS.has(getNodeText(fn, sourceCode))) return null;
    }
    // Resolve the interpolated value. `x || 'default'` / `x ?? d` interpolate the
    // *value* operand `x` — the default is a fallback, not a second sink, so the
    // rule looks at `x` (the left operand) and ignores the default.
    let value: ASTNode = expr;
    while (value.type === 'binary_expression') {
      const opNode = getFieldNode(value, 'operator');
      const op = opNode ? getNodeText(opNode, sourceCode).trim() : null;
      if (op !== '||' && op !== '??') return null; // arithmetic/`+` is not a plain value sink
      const left = getFieldNode(value, 'left');
      const right = getFieldNode(value, 'right');
      if (!left || !right) return null;
      // A string fallback (`x || '…'`) marks a string-valued interpolation — the
      // dangerous case. A numeric fallback (`x || 0`) marks a count and is safe,
      // so `${totalSections || 0}` stays silent.
      if (!isStringConstant(right)) return null;
      value = left;
    }
    // Only a data member access (`violation.file`, `codeMap.quickPreview`) is a
    // string sink; bare identifiers (loop vars, pre-built HTML fragments), calls
    // (`.map()`, `JSON.stringify`, `new Date().toX()`), ternaries, and literals
    // are not. See the authenticity ledger for the gap this leaves.
    if (value.type !== 'member_expression') return null;
    const prop = memberPropertyName(value, sourceCode);
    if (!prop) return null;

    return this.createViolation(
      filePath,
      sub.location.start,
      `Unescaped HTML interpolation: ${prop} is inserted into an HTML template without an escaping call. Analysis-controlled strings (file paths, messages, previews) can carry markup — wrap the interpolation in escapeHtml() to prevent stored XSS.`,
      {
        severity: 'severe',
        rule: 'unescaped-html-interpolation',
        symbol: prop,
        resolution: {
          action: 'escape-html-interpolation',
          summary: `Wrap the ${prop} interpolation in an escaping call (e.g. \${escapeHtml(${prop})}) before it reaches the HTML template.`,
          symbols: [prop],
          files: [filePath],
          lines: [sub.location.start.line],
        },
      },
    );
  }
}
