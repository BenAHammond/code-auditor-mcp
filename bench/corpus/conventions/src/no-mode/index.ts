// no-mode/index.ts — mixed shapes below modeShare threshold.
// No single error-handling shape, export style, or naming convention reaches the
// 80% modeShare default, so no conventions are established and the analyzer emits
// zero findings for this directory.

// Mixed exports: one default, one named
export default function NoModeDefault() {
  return 'default';
}

export function noModeCamelFunction() {
  return 'named';
}

// Mixed error handling: try-catch, promise-catch, if-err — no clear dominant
function noModeTryCatch() {
  try {
    doWork();
  } catch (e) {
    console.error(e);
  }
}

function noModeCatch() {
  somePromise()
    .then(r => r)
    .catch(err => {});
}

function noModeIfErr() {
  if (err) return;
}
