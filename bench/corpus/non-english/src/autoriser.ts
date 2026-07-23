/**
 * French auth guard — P1 known-miss for security analyzer.
 *
 * "autoriser" (French = authorize/authenticate) is semantically an auth check
 * but matches none of the English authPatterns:
 *   ['withAuth', 'requireAuth', 'isAuthenticated']
 *
 * Spec 21 R6.2 — non-English bench corpus fixture.
 * Known-miss: security analyzer missing-auth.
 * Fix: three-tier detection (config-primary → middleware/decorator inference
 * → English fallback), deferred to Spec 15's validator-provenance neighborhood.
 */

// This function checks authentication — should trigger missing-auth
export function autoriser(utilisateur: { token?: string }): boolean {
  if (!utilisateur.token) {
    return false;
  }
  return utilisateur.token.length > 0;
}

// Unprotected route handler — autoriser() should guard this
export async function routeProtegee(requete: Request): Promise<Response> {
  // No call to autoriser() — this is the unprotected path the analyzer should flag
  const donnees = await fetch('https://api.example.com/donnees');
  return new Response(JSON.stringify(await donnees.json()));
}
