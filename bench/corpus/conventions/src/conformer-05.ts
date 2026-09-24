// Conforming module: default lodash import (import-form), PascalCase named
// export (naming + export-shape), try/catch (error-handling), and the
// handleError+logError pair (usage-pair). The lodash import is deliberately
// unused in the body — a shared lodash call would co-occur with the error
// helpers 20× and mint a spurious usage-pair consequent.
import lodash from 'lodash';

export function Conformer05(input: string): string {
  try {
    return `processed: ${input}`;
  } catch (err) {
    handleError(err);
    logError(err);
  }
}
