/**
 * #128 — `solid/single-responsibility` mixed-concern detection.
 *
 * The rule historically fired only on size (parameter count, line count). This
 * spec pins the new semantic signal: a function that spans three or more
 * unrelated concern categories (data access, messaging, logging, rendering) is
 * a god-function even when it is short, while a cohesive pipeline (fetch →
 * shape) is one concern. Each case runs through the real analyzer.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../../languages/index.js';
import { parseFile } from '../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../languages/types.js';
import { UniversalSOLIDAnalyzer, DEFAULT_SOLID_CONFIG } from './UniversalSOLIDAnalyzer.js';

let adapter: LanguageAdapter;
let analyzer: UniversalSOLIDAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalSOLIDAnalyzer();
}, 30_000);

async function srpViolations(code: string, name: string) {
  const ast = parseFile(`${name}.ts`, code)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const violations = await (analyzer as any).analyzeAST(ast, adapter, DEFAULT_SOLID_CONFIG, code);
  return violations.filter((v: any) => v.rule === 'solid/single-responsibility');
}

describe('single-responsibility — mixed-concern detection (#128)', () => {
  it('flags the registry invalid handler (db + email + log + render + audit + notify)', async () => {
    const code = `function handler(req) {
  const user = db.find(req.id);
  sendEmail(user);
  logEvent(req);
  render(user);
  audit(user);
  notify(user);
}`;
    const violations = await srpViolations(code, 'handler');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].severity).toBe('warning');
    expect(violations[0].resolution.action).toBe('split-function');
    expect(violations[0].message).toContain('messaging');
    expect(violations[0].message).toContain('logging');
  });

  it('does not flag the near-miss parse (trim + split only)', async () => {
    const code = `function parse(input) {
  return input.trim().split(",");
}`;
    const violations = await srpViolations(code, 'parse');
    expect(violations).toHaveLength(0);
  });

  it('does not flag a repository method (query + map = load-and-shape)', async () => {
    const code = `async function findByGuild(guild: string) {
  const rows = await query('SELECT * FROM heroes WHERE guild = $1');
  return rows.map((row) => ({ id: row.id }));
}`;
    const violations = await srpViolations(code, 'find-by-guild');
    expect(violations).toHaveLength(0);
  });

  it('does not flag two unrelated concerns (fetch + logEvent)', async () => {
    const code = `async function load() {
  const data = await fetch('/api/items');
  logEvent('loaded');
  return data;
}`;
    const violations = await srpViolations(code, 'load');
    expect(violations).toHaveLength(0);
  });

  it('flags three unrelated concerns (db.save + sendEmail + logEvent)', async () => {
    const code = `function notifyUser(user) {
  db.save(user);
  sendEmail(user.email);
  logEvent('notified');
}`;
    const violations = await srpViolations(code, 'notify-user');
    expect(violations.length).toBeGreaterThan(0);
  });

  it('does not treat a nested callback\'s calls as the outer function\'s concerns', async () => {
    // The outer function only queries + maps (load-and-shape). The `.map`
    // callback *sends* each row — that belongs to the callback, not to the
    // outer function, so it must not push the outer function over the threshold.
    const code = `async function deliverAll() {
  const rows = await query('SELECT email FROM users');
  return rows.map((row) => sendEmail(row.email));
}`;
    const violations = await srpViolations(code, 'deliver-all');
    expect(violations).toHaveLength(0);
  });
});
