// Spec 53 R2 — the eight metamorphic source transformations, implemented with
// the project's own tree-sitter parser (dist build — never src/, which R1 mutates
// in place). Each transform is semantics-preserving; if a file has no applicable
// target, apply() returns null and the harness records it as "not applicable".
// @ts-nocheck
import { parseWithRecovery } from '../../dist/languages/tree-sitter/parser.js';

// A transform returns { source, detail } on success, null when inapplicable.
export const TRANSFORMS = [
  { name: 'rename-local-identifier', apply: renameLocalIdentifier },
  { name: 'reorder-statements', apply: reorderStatements },
  { name: 'add-comment', apply: addComment },
  { name: 'remove-comments', apply: removeComments },
  { name: 'reformat', apply: reformat },
  { name: 'wrap-iife', apply: wrapIife },
  { name: 'wrap-promise-all', apply: wrapPromiseAll },
  { name: 'function-to-arrow', apply: functionToArrow },
  { name: 'add-optional-chaining', apply: addOptionalChaining },
];

async function parse(src) {
  return parseWithRecovery('typescript', false, src);
}

function replace(src, node, replacement) {
  return src.slice(0, node.startIndex) + replacement + src.slice(node.endIndex);
}

// 1. Rename a top-level non-exported `const`/`let` binding and every identifier
//    reference to it in the file. Name-agnostic detection must be invariant.
async function renameLocalIdentifier(src) {
  const tree = await parse(src);
  const root = tree.rootNode;
  for (const decl of root.namedChildren.filter(n => n.type === 'lexical_declaration')) {
    const declarators = decl.namedChildren.filter(n => n.type === 'variable_declarator');
    for (const d of declarators) {
      const nameNode = d.childForFieldName('name');
      if (!nameNode || nameNode.type !== 'identifier') continue;
      const name = nameNode.text;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,14}$/.test(name)) continue;
      const newName = name + 'Morph';
      // Collect every identifier in the file whose text === name.
      const refs = [];
      (function walk(n) {
        if (n.type === 'identifier' && n.text === name) refs.push(n);
        for (const c of n.namedChildren) walk(c);
      })(root);
      if (refs.length < 2 || refs.length > 40) continue; // trivial or too widespread
      // Build replacements from last to first so offsets stay valid.
      const edits = [...refs].sort((a, b) => b.startIndex - a.startIndex);
      let out = src;
      for (const r of edits) out = replace(out, r, newName);
      return { source: out, detail: `renamed '${name}' -> '${newName}' (${refs.length} refs)` };
    }
  }
  return null;
}

// 2. Swap two adjacent statements inside a function/statement block. The two
//    chosen are the first adjacent pair of `expression_statement`/`lexical_declaration`
//    siblings whose text does not reference the other — a cheap independence guard.
async function reorderStatements(src) {
  const tree = await parse(src);
  const root = tree.rootNode;
  const blocks = [];
  (function walk(n) {
    if (n.type === 'statement_block' || n.type === 'program') blocks.push(n);
    for (const c of n.namedChildren) walk(c);
  })(root);
  for (const block of blocks) {
    const stmts = block.namedChildren.filter(
      n => n.type === 'expression_statement' || n.type === 'lexical_declaration',
    );
    for (let i = 0; i + 1 < stmts.length; i++) {
      const a = stmts[i], b = stmts[i + 1];
      // independence guard: neither statement's text mentions the other's leading identifier
      const aId = leadingIdentifier(a.text), bId = leadingIdentifier(b.text);
      if (aId && bId && (b.text.includes(aId) || a.text.includes(bId))) continue;
      const aText = a.text, bText = b.text;
      let out = src;
      out = replace(out, b, aText);
      out = replace(out, a, bText);
      return { source: out, detail: `swapped two adjacent statements (${a.type} / ${b.type})` };
    }
  }
  return null;
}
function leadingIdentifier(text) {
  const m = text.match(/^(?:const|let|var)?\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
  return m ? m[1] : null;
}

// 3. Prepend a line comment at the top of the file (after the shebang, if any).
async function addComment(src) {
  const comment = '// metamorphic: comment added by R2 harness\n';
  const out = src.startsWith('#!') ? src.slice(0, src.indexOf('\n') + 1) + comment + src.slice(src.indexOf('\n') + 1) : comment + src;
  return { source: out, detail: 'prepended a line comment' };
}

// 4. Strip every standalone line comment (//...) and block comment (/*...*/),
//    preserving string/template contents. A comment-free file must score identically.
async function removeComments(src) {
  // Tokenizer: skip string/'' / template `` / regex-ish, remove comments.
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c2 === '//') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      i = j; // keep the newline
    } else if (c2 === '/*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      i = j + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c; let j = i + 1;
      while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, Math.min(j + 1, n)); i = Math.min(j + 1, n);
    } else {
      out += c; i++;
    }
  }
  return { source: out, detail: 'stripped all comments' };
}

// 5. Whitespace-only reformat: normalize leading indentation to 4 spaces,
//    preserving string/template/comment contents byte-for-byte.
async function reformat(src) {
  const lines = src.split('\n');
  // Track whether we are inside a multi-line template/string or block comment,
  // so we never touch significant interior whitespace.
  let inTemplate = false, inBlock = false;
  const out = lines.map(line => {
    if (inBlock) { if (line.includes('*/')) inBlock = false; return line; }
    const stripped = line.trimStart();
    const lead = line.slice(0, line.length - stripped.length);
    // crude: if a line opens/closes a template literal or block comment, flip state after
    const depth = (lead.match(/\t/g) || []).length * 2 + lead.replace(/\t/g, '  ').length;
    const newLead = ' '.repeat(Math.max(0, Math.ceil(depth / 2)));
    return newLead + stripped;
  });
  return { source: out.join('\n'), detail: 're-indented to 4-space' };
}

// 6. Wrap a chosen statement (the first `expression_statement` in a function body)
//    in an IIFE:  stmt  ->  (() => { stmt })();
async function wrapIife(src) {
  const tree = await parse(src);
  const root = tree.rootNode;
  const stmts = [];
  (function walk(n) {
    if (n.type === 'statement_block') {
      for (const c of n.namedChildren) if (c.type === 'expression_statement') stmts.push(c);
    }
    for (const c of n.namedChildren) walk(c);
  })(root);
  for (const s of stmts) {
    if (s.text.length > 400) continue; // keep it small
    const wrapped = `(() => { ${s.text} })();`;
    return { source: replace(src, s, wrapped), detail: `wrapped expression in IIFE` };
  }
  return null;
}

// 7. Wrap the first standalone expression statement in Promise.all([...]).
async function wrapPromiseAll(src) {
  const tree = await parse(src);
  const root = tree.rootNode;
  const stmts = [];
  (function walk(n) {
    if (n.type === 'statement_block') {
      for (const c of n.namedChildren) if (c.type === 'expression_statement') stmts.push(c);
    }
    for (const c of n.namedChildren) walk(c);
  })(root);
  for (const s of stmts) {
    const t = s.text.trim();
    if (t.length > 300) continue;
    const inner = t.replace(/;$/, '');
    return { source: replace(src, s, `await Promise.all([${inner}]);`), detail: `wrapped statement in Promise.all([...])` };
  }
  return null;
}

// 8. `function name(...) { ... }` -> `const name = (...) => { ... }`.
async function functionToArrow(src) {
  const tree = await parse(src);
  const root = tree.rootNode;
  const fns = [];
  (function walk(n) {
    if (n.type === 'function_declaration') fns.push(n);
    for (const c of n.namedChildren) walk(c);
  })(root);
  for (const fn of fns) {
    const nameNode = fn.childForFieldName('name');
    const params = fn.childForFieldName('parameters');
    const body = fn.childForFieldName('body');
    if (!nameNode || !params || !body) continue;
    const name = nameNode.text;
    // Preserve the `const` keyword and return type — the previous form emitted
    // `name = (...) => {}` (an assignment to an undeclared identifier, which the
    // extractor correctly treats as NOT a function entity). A `const` arrow keeps
    // the declaration shape the analyzer must treat equivalently to `function`.
    const isAsync = fn.text.trimStart().startsWith('async');
    const asyncPrefix = isAsync ? 'async ' : '';
    const returnType = fn.childForFieldName('return_type');
    const ret = returnType ? returnType.text : ''; // `: number` — includes the colon
    const arrow = `const ${name} = ${asyncPrefix}${params.text}${ret} => ${body.text}`;
    return { source: replace(src, fn, arrow), detail: `function '${name}' -> const arrow` };
  }
  return null;
}

// 9. `a.b` -> `a?.b` on the first member_expression whose object is an identifier.
async function addOptionalChaining(src) {
  const tree = await parse(src);
  const root = tree.rootNode;
  const members = [];
  (function walk(n) {
    if (n.type === 'member_expression') members.push(n);
    for (const c of n.namedChildren) walk(c);
  })(root);
  for (const m of members) {
    const obj = m.childForFieldName('object');
    if (!obj || obj.type !== 'identifier') continue;
    const prop = m.childForFieldName('property');
    if (!prop) continue;
    const out = src.slice(0, obj.endIndex) + '?.' + src.slice(obj.endIndex, prop.startIndex) + src.slice(prop.startIndex);
    return { source: out, detail: `optional-chained '${obj.text}.${prop.text}'` };
  }
  return null;
}
