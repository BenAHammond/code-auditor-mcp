/**
 * Spec 55 R4 — `no-error-boundary` is an app-level signal, not a per-component one.
 *
 * The report (code-audit-false-positives.md §1.1) flagged 11 severe findings
 * against an app whose `src/client/App.tsx` already defines a root
 * `<ErrorBoundary>` class component using `static getDerivedStateFromError`.
 * The old rule fired "complex component should be wrapped" on every complex /
 * `useEffect` component even though the whole tree was already protected.
 *
 * Fix: recognize `getDerivedStateFromError` (already covered by
 * `hasErrorBoundaryMethods` in the scanner) and decide "is there any boundary?"
 * once, at the app level, in `checkErrorBoundaryUsage`. The per-component check
 * was removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { scanFile } from '../componentScanner.js';
import type { ComponentMetadata, ComponentScanResult } from '../types.js';
import { analyzeComponent, checkErrorBoundaryUsage, DEFAULT_REACT_CONFIG } from './reactAnalyzer.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-eb-'));
}, 30_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Minimal complex functional component that would previously fire the
 *  per-component `no-error-boundary` check (has useEffect). */
function complexComponent(name: string, filePath: string): ComponentMetadata {
  return {
    name,
    filePath,
    lineNumber: 1,
    dependencies: [],
    purpose: '',
    context: '',
    entityType: 'component',
    componentType: 'functional',
    hooks: [{ name: 'useEffect', line: 2, customHook: false }],
    complexity: 12,
    isExported: true,
  };
}

/** A class component that IS an error boundary (`getDerivedStateFromError`). */
function boundaryComponent(name: string, filePath: string): ComponentMetadata {
  return {
    name,
    filePath,
    lineNumber: 1,
    dependencies: [],
    purpose: '',
    context: '',
    entityType: 'component',
    componentType: 'class',
    hasErrorBoundary: true,
    isExported: true,
  };
}

function resultOf(filePath: string, components: ComponentMetadata[]): ComponentScanResult {
  return { filePath, components, imports: [] };
}

describe('checkErrorBoundaryUsage — app-level authority', () => {
  it('does NOT flag when a boundary class (getDerivedStateFromError) exists, even among many complex components', () => {
    const components = [
      boundaryComponent('ErrorBoundary', 'src/client/App.tsx'),
      ...Array.from({ length: 11 }, (_, i) => complexComponent(`Screen${i}`, `src/Screen${i}.tsx`)),
    ];
    const findings = checkErrorBoundaryUsage([resultOf('src/client/App.tsx', components)]);
    expect(findings.filter((v) => v.rule === 'no-error-boundary')).toHaveLength(0);
  });

  it('does NOT flag when a Next.js convention error.tsx boundary exists', () => {
    // function component (hasErrorBoundary false), but the filename is the convention signal
    const boundary = complexComponent('Error', 'src/app/error.tsx');
    boundary.hasErrorBoundary = false;
    const components = [
      boundary,
      ...Array.from({ length: 11 }, (_, i) => complexComponent(`Screen${i}`, `src/Screen${i}.tsx`)),
    ];
    const findings = checkErrorBoundaryUsage([
      resultOf('src/app/error.tsx', [boundary]),
      ...components.slice(1).map((c) => resultOf(c.filePath, [c])),
    ]);
    expect(findings.filter((v) => v.rule === 'no-error-boundary')).toHaveLength(0);
  });

  it('flags a boundary-less app of meaningful size once, at the app level', () => {
    const components = Array.from({ length: 11 }, (_, i) =>
      complexComponent(`Screen${i}`, `src/Screen${i}.tsx`)
    );
    const results = components.map((c) => resultOf(c.filePath, [c]));
    const findings = checkErrorBoundaryUsage(results);
    const eb = findings.filter((v) => v.rule === 'no-error-boundary');
    expect(eb).toHaveLength(1);
    expect(eb[0].message).toContain('No error boundaries');
  });

  it('does NOT flag a small boundary-less app (threshold)', () => {
    const components = Array.from({ length: 5 }, (_, i) =>
      complexComponent(`Screen${i}`, `src/Screen${i}.tsx`)
    );
    const results = components.map((c) => resultOf(c.filePath, [c]));
    expect(checkErrorBoundaryUsage(results).filter((v) => v.rule === 'no-error-boundary')).toHaveLength(0);
  });
});

describe('analyzeComponent — no per-component no-error-boundary', () => {
  it('a complex useEffect component is NOT flagged as needing a boundary (per-component check removed)', () => {
    const component = complexComponent('Play', 'src/client/screens/Play.tsx');
    const result = resultOf(component.filePath, [component]);
    const violations = analyzeComponent(component, DEFAULT_REACT_CONFIG, result);
    expect(violations.filter((v) => v.rule === 'no-error-boundary')).toHaveLength(0);
  });
});

describe('scanner — getDerivedStateFromError is a boundary signal', () => {
  it('sets hasErrorBoundary on a class with static getDerivedStateFromError', async () => {
    const filePath = join(tmpDir, 'ErrorBoundary.tsx');
    const source = [
      "import React from 'react';",
      'export class ErrorBoundary extends React.Component {',
      '  state = { hasError: false };',
      '  static getDerivedStateFromError() { return { hasError: true }; }',
      '  componentDidCatch() {}',
      '  render() { return <div>fallback</div>; }',
      '}',
    ].join('\n');
    await writeFile(filePath, source, 'utf-8');
    const result = await scanFile(filePath);
    const boundary = result.components.find((c) => c.name === 'ErrorBoundary');
    expect(boundary, 'expected ErrorBoundary component to be detected').toBeTruthy();
    expect(boundary!.hasErrorBoundary).toBe(true);
  });

  it('does NOT set hasErrorBoundary on an ordinary class component', async () => {
    const filePath = join(tmpDir, 'Plain.tsx');
    const source = [
      "import React from 'react';",
      'export class Plain extends React.Component {',
      '  render() { return <div>plain</div>; }',
      '}',
    ].join('\n');
    await writeFile(filePath, source, 'utf-8');
    const result = await scanFile(filePath);
    const plain = result.components.find((c) => c.name === 'Plain');
    expect(plain, 'expected Plain component to be detected').toBeTruthy();
    expect(plain!.hasErrorBoundary).toBe(false);
  });
});
