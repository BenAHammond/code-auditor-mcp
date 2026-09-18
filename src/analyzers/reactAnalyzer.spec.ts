/**
 * Honesty guards for the react analyzer's accessibility + performance rules.
 *
 * Each case proves the rule fires on the true positive and does NOT fire on the
 * near-miss negative. The near-misses are the specific proxies the old checks
 * matched on: `context.includes('alt=')` hiding a second unlabeled <img>, and a
 * `=>` + `onClick={` substring matching identifier handlers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { scanFile } from '../componentScanner.js';
import type { ComponentMetadata, ComponentScanResult } from '../types.js';
import { analyzeComponent, DEFAULT_REACT_CONFIG } from './reactAnalyzer.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-react-'));
}, 30_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function analyze(source: string): Promise<ReturnType<typeof analyzeComponent>> {
  const filePath = join(tmpDir, `cmp-${Math.random().toString(36).slice(2)}.tsx`);
  await writeFile(filePath, source, 'utf-8');
  const result: ComponentScanResult = await scanFile(filePath);
  const component = result.components.find((c: ComponentMetadata) => c.name !== 'AnonymousComponent')!;
  expect(component, 'expected a detected component').toBeTruthy();
  return analyzeComponent(component, DEFAULT_REACT_CONFIG, result);
}

function byRule(violations: ReturnType<typeof analyzeComponent>, rule: string) {
  return violations.filter((v) => v.rule === rule);
}

describe('react accessibility — <img> alt', () => {
  it('flags an <img> without alt (true positive)', async () => {
    const violations = await analyze(
      `export function Photo() {\n  return <img src="x.png" />;\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    expect(a11y.length).toBeGreaterThanOrEqual(1);
    expect(a11y.some((v) => v.message?.includes('alt'))).toBe(true);
  });

  it('does NOT flag an <img> with alt (near-miss)', async () => {
    const violations = await analyze(
      `export function Photo() {\n  return <img src="x.png" alt="a description" />;\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    expect(a11y.filter((v) => v.message?.includes('alt')).length).toBe(0);
  });

  it('flags when one of two <img>s lacks alt (old proxy suppressed this)', async () => {
    const violations = await analyze(
      `export function Gallery() {\n  return <div><img src="a.png" alt="a" /><img src="b.png" /></div>;\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    expect(a11y.some((v) => v.message?.includes('alt'))).toBe(true);
  });
});

describe('react accessibility — onClick on non-interactive element', () => {
  it('flags onClick on a <div> (true positive)', async () => {
    const violations = await analyze(
      `export function Card() {\n  return <div onClick={() => go()} />;\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    expect(a11y.some((v) => v.message?.includes('<div>'))).toBe(true);
  });

  it('does NOT flag onClick when it sits on a <button> (near-miss)', async () => {
    const violations = await analyze(
      `export function Card() {\n  return <div>text <button onClick={() => go()}>go</button></div>;\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    expect(a11y.filter((v) => v.message?.includes('non-interactive')).length).toBe(0);
  });
});

describe('react performance — inline function props', () => {
  it('flags an inline arrow prop (true positive)', async () => {
    const violations = await analyze(
      `export function Card() {\n  return <Button onClick={() => go()} />;\n}\n`,
    );
    const perf = byRule(violations, 'performance');
    expect(perf.some((v) => v.message?.includes('inline function'))).toBe(true);
  });

  it('does NOT flag an identifier handler (near-miss)', async () => {
    const violations = await analyze(
      `export function Card() {\n  return <Button onClick={handleClick} />;\n}\n`,
    );
    const perf = byRule(violations, 'performance');
    expect(perf.filter((v) => v.message?.includes('inline function')).length).toBe(0);
  });
});

describe('react — comment-as-markup (JSX in comments never fires)', () => {
  it('does NOT flag a line-commented <img> without alt', async () => {
    const violations = await analyze(
      `export function Photo() {\n  // <img src="x.png" />\n  return <span>ok</span>;\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    expect(a11y.filter((v) => v.message?.includes('alt')).length).toBe(0);
  });

  it('does NOT flag a block-commented <div onClick={...}>', async () => {
    const violations = await analyze(
      `export function Card() {\n  /* <div onClick={() => go()}>x</div> */\n  return <span>ok</span>;\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    expect(a11y.filter((v) => v.message?.includes('non-interactive')).length).toBe(0);
  });

  it('does NOT flag an <img> inside a JSX comment {/* ... */}', async () => {
    const violations = await analyze(
      `export function Photo() {\n  return <div>{/* <img src="x.png" /> */}<span>ok</span></div>;\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    expect(a11y.filter((v) => v.message?.includes('alt')).length).toBe(0);
  });

  it('does NOT flag a commented-out inline onClick handler', async () => {
    const violations = await analyze(
      `export function Card() {\n  // <Button onClick={() => go()} />\n  return <span>ok</span>;\n}\n`,
    );
    const perf = byRule(violations, 'performance');
    expect(perf.filter((v) => v.message?.includes('inline function')).length).toBe(0);
  });
});

describe('react — per-element line anchoring', () => {
  it('anchors the <img> alt finding to the element line, not the declaration', async () => {
    const violations = await analyze(
      `export function Gallery() {\n  return (\n    <div>\n      <img src="x.png" />\n    </div>\n  );\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    const imgFinding = a11y.find((v) => v.message?.includes('alt'));
    expect(imgFinding).toBeTruthy();
    expect(imgFinding!.line).toBe(4);
  });

  it('anchors the onClick-on-div finding to the element line', async () => {
    const violations = await analyze(
      `export function Card() {\n  return (\n    <div onClick={() => go()}>x</div>\n  );\n}\n`,
    );
    const a11y = byRule(violations, 'accessibility');
    const divFinding = a11y.find((v) => v.message?.includes('non-interactive'));
    expect(divFinding).toBeTruthy();
    expect(divFinding!.line).toBe(3);
  });

  it('anchors the inline-function-prop finding to the onClick attribute line', async () => {
    const violations = await analyze(
      `export function Card() {\n  return (\n    <Button\n      onClick={() => go()}\n    />\n  );\n}\n`,
    );
    const perf = byRule(violations, 'performance');
    const inlineFinding = perf.find((v) => v.message?.includes('inline function'));
    expect(inlineFinding).toBeTruthy();
    expect(inlineFinding!.line).toBe(4);
  });
});
