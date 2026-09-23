/**
 * Spec 61 R6 — `unescaped-html-interpolation` sink set.
 *
 * The rule fires only where an interpolated *member access* (a data field, not a
 * bare identifier or call) reaches an HTML sink. This spec pins the full sink
 * vocabulary — every place a raw-HTML value can be injected — so that closing
 * one form without the others cannot regress silently.
 *
 * Sink forms under test:
 *   - `el.insertAdjacentHTML(pos, html)`         (second argument)
 *   - `res.send(html)` / `res.write(html)`      (first argument)
 *   - `document.write(html)`                     (first argument)
 *   - `el.setHTMLUnsafe(html)`                   (first argument)
 *   - jQuery/Hono `.html(html)`                  (first argument)
 *   - `el.innerHTML = html` / `el.outerHTML`     (property assignment)
 *   - React `dangerouslySetInnerHTML={{ __html: html }}`  (the `__html` key)
 *   - React `dangerouslySetInnerHTML={html}`     (the JSX attribute itself)
 *   - Vue `v-html` directive                      (the template is the sink)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../languages/index.js';
import { parseFile } from '../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../languages/types.js';
import { UniversalSecurityAnalyzer, DEFAULT_SECURITY_CONFIG } from './UniversalSecurityAnalyzer.js';
import type { Violation } from '../../types.js';

let analyzer: UniversalSecurityAnalyzer;
let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
  analyzer = new UniversalSecurityAnalyzer();
}, 30_000);

async function run(sourceCode: string, filePath = 'security.ts'): Promise<Violation[]> {
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error('failed to parse fixture');
  return (await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_SECURITY_CONFIG, sourceCode)) as Violation[];
}

const html = (vs: Violation[]) => vs.filter((v) => v.rule === 'unescaped-html-interpolation');

describe('unescaped-html-interpolation — sink vocabulary', () => {
  it('flags insertAdjacentHTML (second argument)', async () => {
    const vs = html(await run("el.insertAdjacentHTML('beforeend', `<p>${user.name}</p>`);"));
    expect(vs).toHaveLength(1);
    expect(vs[0].resolution?.action).toBe('escape-html-interpolation');
  });

  it('flags res.send / res.write (first argument)', async () => {
    expect(html(await run("res.send(`<p>${user.name}</p>`);"))).toHaveLength(1);
    expect(html(await run("res.write(`<p>${user.name}</p>`);"))).toHaveLength(1);
  });

  it('flags document.write (first argument)', async () => {
    expect(html(await run("document.write(`<p>${user.name}</p>`);"))).toHaveLength(1);
  });

  it('flags setHTMLUnsafe (first argument)', async () => {
    expect(html(await run("el.setHTMLUnsafe(`<p>${user.name}</p>`);"))).toHaveLength(1);
  });

  it('flags the jQuery/Hono .html(x) setter (first argument)', async () => {
    expect(html(await run("$('#app').html(`<p>${user.name}</p>`);"))).toHaveLength(1);
    expect(html(await run("c.html(`<p>${user.name}</p>`);"))).toHaveLength(1);
  });

  it('flags innerHTML/outerHTML assignment', async () => {
    expect(html(await run("el.innerHTML = `<p>${user.name}</p>`;"))).toHaveLength(1);
    expect(html(await run("el.outerHTML = `<p>${user.name}</p>`;"))).toHaveLength(1);
  });

  it('flags the React __html key form', async () => {
    const vs = html(await run(
      "const markup = { __html: `<p>${user.name}</p>` };\nexport const x = markup;",
      'component.tsx',
    ));
    expect(vs).toHaveLength(1);
  });

  it('flags the React dangerouslySetInnerHTML JSX attribute form', async () => {
    // The template reaches the sink through the *attribute name* alone — the
    // bound value is a plain string, not an `{ __html: … }` object, so the
    // `pair` branch never sees it. Only the jsx_attribute branch fires.
    const vs = html(await run(
      "const markup = `<p>${user.name}</p>`;\nexport const el = <div dangerouslySetInnerHTML={markup} />;",
      'component.tsx',
    ));
    expect(vs).toHaveLength(1);
    expect(vs[0].severity).toBe('severe');
  });

  it('flags the Vue v-html directive', async () => {
    const vs = html(await run("const t = `<div v-html=\"${user.name}\"></div>`;"));
    expect(vs).toHaveLength(1);
  });

  // ── near-miss classes — must stay silent ──────────────────────────────

  it('stays silent on the escape-wrapped fix', async () => {
    expect(html(await run("el.innerHTML = `<p>${escapeHtml(user.name)}</p>`;"))).toHaveLength(0);
  });

  it('stays silent on a bare identifier interpolation', async () => {
    // A loop var / pre-built fragment is not a data member access.
    expect(html(await run("el.innerHTML = `<li>${item}</li>`;"))).toHaveLength(0);
  });

  it('stays silent on a substitution inside <script>/<style>', async () => {
    expect(html(await run(
      "el.innerHTML = `<script>const x = ${JSON.stringify(user.name)}</script>`;",
    ))).toHaveLength(0);
  });

  it('stays silent on the .html() getter (no argument)', async () => {
    expect(html(await run("const s = $('#app').html();"))).toHaveLength(0);
  });
});
