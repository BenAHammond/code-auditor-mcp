# Directive D1 — Interim Findings Archive (effective immediately)

**Applies to:** every audit invocation the implementor performs from receipt of this directive onward — verification runs, dogfood runs, gate re-runs, fixture runs, all of them, full or scoped — through the completion of Spec 11, which productizes this and consumes the archive as seed data.

## Instruction

1. Every audit run's complete findings are archived: run the audit with JSON output (`-f json` or `--json` as the surface provides) and write one file per run to `bench/ledger-interim/` in the repo, named `<ISO-8601-timestamp>-<short-sha>.json`.
2. Each file contains a metadata header object followed by the findings: timestamp, git SHA of the working tree (plus a `dirty: true/false` flag), tool version from package.json, the exact command line invoked, scope, target path, exit code, and wall-clock duration. Findings are archived verbatim as emitted — no filtering, no dedupe, no cleanup. Zero-finding runs are archived too; a clean run is data.
3. The archive directory is committed. These files are evaluation ground-truth-in-waiting for Spec 11 (analyzer quality evaluation); their value is that they are contemporaneous and unfiltered.
4. This is a process instruction, not a product change. Do not modify `auditRunner`, add flags, or build tooling for it — pipe output to a file. Spec 11 replaces this with a real findings ledger; until then, this directive stands.
5. If a run cannot produce JSON output (crash, stub, missing surface), archive a file anyway containing the metadata header, the error output, and `findings: null`. Failed runs are evidence too — arguably the best kind.
