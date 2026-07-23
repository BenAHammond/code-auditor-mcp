/**
 * Spec-21 R6: Validator provenance — Portuguese identifier
 * "validarEntrada" recognized via import provenance, not name heuristic.
 *
 * "validarEntrada" starts with "validar" — it does NOT match the
 * `validate*`/`assert*` English heuristic. Detection must come from
 * import provenance tracing to the 'zod' package.
 */

import { z } from 'zod';

// MUST be recognized as validator-provenanced via 'zod' import.
const validarEntrada = z.object({
  nome: z.string(),
  idade: z.number(),
});

// Use the schema — the identifier propagates provenance.
type Entrada = z.infer<typeof validarEntrada>;

function processar(dados: Entrada) {
  const resultado = validarEntrada.safeParse(dados);
  return resultado;
}
