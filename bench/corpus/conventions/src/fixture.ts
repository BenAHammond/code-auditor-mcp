// fixture.ts — contains all 5 convention violations for the Spec 12 bench corpus.
//
//   conventions/usage-pair     — errorHandler() calls handleError() but not logError()
//   conventions/import-form    — named lodash import where default is the convention
//   conventions/error-handling — handlePromiseError() uses .catch() where try-catch dominates
//   conventions/export-shape   — default export where named is the convention
//   conventions/naming         — snake_case export where PascalCase is the convention

import { debounce } from 'lodash';

// usage-pair violation: calls handleError without logError
function errorHandler() {
  handleError();
}

// error-handling violation: uses .catch() when convention is try-catch
function handlePromiseError() {
  fetch('/api/data')
    .then(res => res.json())
    .catch(err => console.error(err));
}

// export-shape violation: default export when convention is named
export default function DefaultExporter() {
  return 'hello';
}

// naming violation: snake_case when convention is PascalCase
export function my_snake_function() {
  return 42;
}
