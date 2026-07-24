// approved.ts — near-miss file that follows all conventions: zero violations expected.
//
//   usage-pair     — calls both handleError() and logError()
//   import-form    — default lodash import matches convention
//   error-handling — try/catch matches convention
//   export-shape   — named export matches convention
//   naming         — PascalCase export matches convention

import lodash from 'lodash';

// Follows usage-pair convention: calls both handleError and logError
function approvedHandler() {
  handleError();
  logError();
}

// Follows error-handling convention: uses try/catch
function approvedWithCatch() {
  try {
    doSomething();
  } catch (e) {
    logError(e);
  }
}

// Follows export-shape and naming conventions: named export, PascalCase
export function ApprovedExport() {
  return 'approved';
}
