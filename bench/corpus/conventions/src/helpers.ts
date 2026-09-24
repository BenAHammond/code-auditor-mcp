// helpers.ts — project-defined error helpers used as the usage-pair
// antecedent/consequent. Deliberately NOT exported: naming and export-shape
// conventions only consider exported functions, so these camelCase helpers stay
// out of the naming/export-shape population while remaining resolvable in the
// function index (Spec 22 R5.2 requires the antecedent to be project-defined).
function handleError(err: unknown): void {
  console.error(err);
}

function logError(err: unknown): void {
  console.error('[error]', err);
}
