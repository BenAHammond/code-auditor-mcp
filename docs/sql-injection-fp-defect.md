# SQL Injection False Positives — SUPERSEDED

> **Superseded by [`recall-protocol-sql-injection-defects.md`](recall-protocol-sql-injection-defects.md).**

This doc previously catalogued 15 `sql-injection-risk` false positives against
`recall-protocol` and proposed a fix per mechanism. That analysis is now closed:

- **11 real false positives were removed** by Spec 33/34 cross-function taint
  tracking (see `spec-33/s33-item6-taint-tracking.test.ts`). Mechanisms 3–8 in
  this doc's former list are resolved.
- **4 findings remain, and all four are real defects**, not false positives.
  Three of them (this doc's former "mechanism #2" — manual
  `.replace(/'/g, "''")` escaping — and one entry from the former "mechanism
  #1") were re-adjudicated: manual quote-escaping is **not** sanitization. See
  the ticket doc for the full defect list and remediation.

The current detector has **0 remaining false positives** against the corpus; the
standing findings are genuine and are tracked as a ticket to the
`recall-protocol` owner.
