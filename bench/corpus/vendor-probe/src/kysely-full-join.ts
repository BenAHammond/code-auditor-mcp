/**
 * Item B (reissued) liveness fixture.
 *
 * This file reaches FIVE tables through a Kysely builder chain: four via the
 * baseline grammar (`selectFrom` / `innerJoin` / `leftJoin`), and the fifth —
 * `vet` — only via `fullJoin`. `fullJoin` is not part of the analyzer's
 * irreducible baseline; it is supplied per-run by the Kysely probe
 * (`deriveVendorSets` adds every `SelectQueryBuilder` member ending in `Join` /
 * `JoinLateral`). So this query yields a `complex-query` finding (5 tables >
 * `joinedTableCount` = 4) only when the Kysely declaration resolves from the
 * tree's own `node_modules`, and no `complex-query` finding when it does not
 * (the chain then resolves to four tables — exactly the threshold, not over it).
 */
import { Kysely } from 'kysely';

interface DB {
  person: { id: number };
  pet: { id: number; person_id: number };
  toy: { id: number; pet_id: number };
  owner: { id: number; person_id: number };
  vet: { id: number; pet_id: number };
}

const db = new Kysely<DB>({} as never);

export function fullPetRoster() {
  return db
    .selectFrom('person')
    .innerJoin('pet', 'pet.person_id', 'person.id')
    .leftJoin('toy', 'toy.pet_id', 'pet.id')
    .innerJoin('owner', 'owner.person_id', 'person.id')
    .fullJoin('vet', 'vet.pet_id', 'pet.id')
    .selectAll();
}
