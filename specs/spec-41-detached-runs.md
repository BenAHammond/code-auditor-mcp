# Spec 41 — Detached Runs and a Queryable Findings Store

## The problem

An audit is a blocking call that produces a 10 MB JSON file, and every question about the result means `jq` over the whole thing.

That has two costs, and both are being paid right now.

**The agent is blocked and then buried.** A full-corpus run takes minutes; the caller waits. Then the artifact is too large to read, so the caller greps it — and reading it whole is what has repeatedly exhausted context and forced compaction mid-task.

**There is no way to ask the tool a question.** Spec 39's R1 matrix — every rule × every corpus × input presence × reported state — is being assembled by running seven audits and collating JSON by hand. That is a query, and there is nothing to query.

The same is true for a user. 5,912 findings in a JSON blob is not something you interrogate; it is something you grep.

## What already exists

`mcpAuditJobs.ts` runs background jobs with paged retrieval via `audit.results`. The MCP surface has this. The CLI never got it.

`.code-index` is SQLite and already holds facts, functions, style declarations, schema usage. Findings are the one product of a run that does not land there.

So this is largely wiring what exists, plus one new table.

## Why it matters beyond convenience

Spec 36 R8 requires that outstanding work be re-derived from the tool on every invocation, with nothing durable in the agent's head. That requirement currently has no implementation — the tool cannot answer "what is outstanding" because findings do not persist anywhere queryable.

A findings store is the mechanism that makes R8 real. Without it, R8 is a statement of intent.

---

## R1 — Detached runs

```
code-audit audit --path <dir> --detach        → prints a job id, exits 0 immediately
code-audit status <job-id>                    → queued | running | complete | failed, with progress
code-audit result <job-id> [query flags]      → findings, per R2
code-audit jobs                               → recent jobs, their state and target
```

Requirements:

- `--detach` returns before analysis begins. The caller is never blocked.
- Job state survives process exit — it lives in the store, not in memory.
- A failed job records why. A job that died mid-run is `failed`, never `complete` with partial results. That distinction is the same law as `notRun` versus zero findings.
- `status` on an unknown id is an error, not empty output.
- Existing synchronous `audit` behaviour is unchanged. `--detach` is additive.

Reuse `mcpAuditJobs.ts` rather than writing a second job model. Two job systems is the two-registry condition again.

## R2 — Findings are queryable

Findings persist to the store as rows, not as a blob. The report file remains as an export, but it stops being the only way to read a result.

```
code-audit result <job-id> --rule <id>
code-audit result <job-id> --analyzer <name>
code-audit result <job-id> --file <glob>
code-audit result <job-id> --severity <level>
code-audit result <job-id> --state <fired|clean|notApplicable|unassessed>
code-audit result <job-id> --count            → counts only, grouped by the active filter
```

Requirements:

- Filters compose.
- `--count` returns counts, not findings. This is the one place an aggregate is legitimate, because the caller asked for it explicitly — Spec 36 R3 forbids the tool volunteering a total, not answering a direct question.
- Output defaults to a bounded page with a continuation token. An unbounded default is how the artifact became unreadable.
- Coverage is queryable on the same footing: every rule's state and reason for a given job.

**This is the thing that makes Spec 39's matrix a query.** Seven detached runs, then one query per corpus for rules reporting `fired`, joined against declared inputs. Minutes instead of a manual collation.

## R3 — Provenance, or the store becomes a baseline

A findings store that outlives the code it describes is a baseline file with better ergonomics. That is the failure this project has spent months avoiding.

Requirements:

- Every job records the commit hash if the target is a git repo, and a content hash of the analyzed file set regardless.
- A query against a job whose target has since changed returns the findings **and** a staleness marker naming what changed — how many files differ, and the recorded versus current hash.
- Stale results are never returned silently. A caller that ignores the marker is making a choice; a caller that never sees it is being misled.
- `code-audit jobs` shows staleness per job.

The rule: the store answers what *was* found, with provenance. It never implies what *is* true now.

## R4 — Retention

Findings for seven corpora at thousands of rows each accumulate. Unbounded growth in `.code-index` is a defect in waiting.

Requirements:

- A retention policy: keep the most recent N jobs per target, or jobs newer than a duration. State which and why.
- `code-audit jobs --prune` removes jobs outside the policy.
- Pruning is explicit. Nothing silently deletes a job a caller might still reference.
- Report the store's size before and after on a seven-corpus set.

## R5 — Concurrency

Multiple detached jobs may exist. Whether they may *run* concurrently is a decision to make and record.

Given that a full Twenty run peaks around 2.4 GB, concurrent large runs are how the machine gets pushed over — which has already happened once in this project.

Requirements:

- A concurrency limit, defaulting to one running job at a time. Additional jobs queue.
- The limit is configurable, with the memory rationale documented.
- `status` distinguishes `queued` from `running`.

---

## Acceptance

1. `--detach` returns in under a second on a corpus that takes minutes synchronously. Post both timings.
2. `status` through the full lifecycle: queued, running, complete. Post the transcript.
3. A killed job reports `failed` with a reason, never `complete` — forced-failure transcript.
4. Every R2 filter, individually and composed. Post the commands and row counts.
5. `--count` on recall returns per-analyzer counts matching the current baseline exactly: total 5,912, solid 1,028, data-access 1,688, documentation 2,477, react 339, styles 114, conventions 116, cross-domain 39, schema 10, schema-code 95, dry 6.
6. Coverage queryable — every rule's state and reason for a job, matching the 73 entries at 36 clean / 35 fired / 2 notApplicable.
7. Staleness: run a job, modify a file in the target, query again. The result carries a staleness marker naming the changed count — transcript.
8. Retention policy stated and `--prune` demonstrated, with store size before and after across seven corpora.
9. Concurrency limit demonstrated: submit two jobs, confirm one queues.
10. Spec 39's R1 matrix rebuilt using only these commands. Post the commands. If it cannot be built from queries, R2's filter set is incomplete — say which filter is missing.
11. Synchronous `audit` unchanged: same output, same exit codes, same report file.
12. `npx tsc --noEmit` exit 0. Suite and integration suite green. All corpus baselines exact.

## Reporting

Standing reporting contract. Every requirement met, failed, or not run.

Acceptance 10 is the load-bearing one. If the matrix cannot be produced by query, this spec has not delivered its purpose regardless of what else passes.
