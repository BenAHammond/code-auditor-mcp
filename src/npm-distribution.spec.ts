/**
 * Distribution integrity tests — guard against ABI drift in native dependencies.
 *
 * These tests prevent a failure class where everything works in dev (pnpm
 * hoists platform packages to the workspace store) but breaks for users who
 * install via stock npm from the registry or tarball.
 *
 * npm cli#4828 is the long-lived bug where platform-specific optionalDependencies
 * silently fail to install. Our mitigation is pinning the platform packages as
 * top-level optionalDependencies in our package.json. But pins drift — if the
 * parent @ast-grep/napi updates and a platform pin stays behind, the ABI
 * mismatch only surfaces on user machines.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('native dependency ABI coherence', () => {
  const ourPkg = require('../package.json');
  const napiPkg = require('@ast-grep/napi/package.json');

  const parentVersion = napiPkg.version;
  const ourOptionalDeps = ourPkg.optionalDependencies || {};
  const parentOptionalDeps = napiPkg.optionalDependencies || {};

  // Every platform pin we declare must exist in the parent's optionalDeps
  it('every declared platform pin matches a parent optionalDep entry', () => {
    for (const [pkgName, pinVersion] of Object.entries(ourOptionalDeps)) {
      if (!pkgName.startsWith('@ast-grep/napi-')) continue;
      const parentVersion = parentOptionalDeps[pkgName];
      expect(parentVersion).toBeDefined();
      expect(pinVersion).toBe(parentVersion);
    }
  });

  // Every platform pin must be an exact-string match for the parent version.
  // A drifted pin is an ABI break — the native binary won't match the JS loader.
  it('every platform pin version matches parent @ast-grep/napi version exactly', () => {
    for (const [pkgName, pinVersion] of Object.entries(ourOptionalDeps)) {
      if (!pkgName.startsWith('@ast-grep/napi-')) continue;
      expect(pinVersion).toBe(parentVersion);
    }
  });

  // Catch the case where we accidentally omit a platform.
  // We don't need all 9 from the parent, but we must cover the seven
  // the user specified: darwin-arm64, darwin-x64, linux-x64-gnu,
  // linux-arm64-gnu, linux-x64-musl, linux-arm64-musl, win32-x64-msvc.
  it('covers all seven required platform pins', () => {
    const required = [
      '@ast-grep/napi-darwin-arm64',
      '@ast-grep/napi-darwin-x64',
      '@ast-grep/napi-linux-x64-gnu',
      '@ast-grep/napi-linux-arm64-gnu',
      '@ast-grep/napi-linux-x64-musl',
      '@ast-grep/napi-linux-arm64-musl',
      '@ast-grep/napi-win32-x64-msvc',
    ];
    for (const pkgName of required) {
      expect(ourOptionalDeps[pkgName]).toBeDefined();
    }
  });
});
