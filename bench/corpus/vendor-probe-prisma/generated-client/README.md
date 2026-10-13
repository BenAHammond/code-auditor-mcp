# Generated Prisma client fixture (vendor-probe liveness)

`index.d.ts` is the **verbatim** generated client produced by
`prisma generate` for `prisma@6.19.3` (schema: models `User` and `Post`),
copied from the real output at `node_modules/.prisma/client/index.d.ts`.

It is committed — not installed — because generating it requires the Prisma
CLI and its query engines, which a network-free test run must not fetch. The
liveness test (`src/__tests__/vendor-probe-liveness.spec.ts`) materializes these
two files into a temp tree's `node_modules/.prisma/client/` and asserts that
`resolveVendorSurfaces` reads the generated `*Delegate` declarations back out:
resolved path + `6.19.3` + the 18 member-name union (17 verbs + the `fields`
property), including `createManyAndReturn` and `updateManyAndReturn` — the two
verbs the old hand-kept `PRISMA_VERBS` list was missing.

`package.json` carries only what `resolvePackageRoot` / `packageVersion` read:
the `.prisma/client` package name and its version. Nothing here is hand-authored
or re-derived — the delegate interfaces are Prisma's own generated output.
