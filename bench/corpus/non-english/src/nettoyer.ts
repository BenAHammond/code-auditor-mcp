/**
 * French sanitizer — P1 known-miss for security analyzer.
 *
 * "nettoyer" (French = clean/sanitize) is semantically a sanitization function
 * but matches none of the English sanitized patterns:
 *   ['sanitize', 'escape', 'clean']
 *
 * Spec 21 R6.2 — non-English bench corpus fixture.
 * Known-miss: security analyzer missing-sanitization.
 * Fix: three-tier detection (config-primary → library-call inference
 * → English fallback), deferred to Spec 15's validator-provenance neighborhood.
 */

// Sanitizes user input — should be recognized as sanitization
export function nettoyer(entree: string): string {
  return entree.replace(/<script>|<\/script>/gi, '');
}

// Uses unsanitized input in a dangerous context
export function afficherMessage(entreeUtilisateur: string): string {
  // Should trigger missing-sanitization — nettoyer() exists but isn't called
  return `<div>${entreeUtilisateur}</div>`;
}
