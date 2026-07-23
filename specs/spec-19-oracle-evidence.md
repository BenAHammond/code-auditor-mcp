# Spec 19 Oracle Gate — Evidence Pair

## 3.1.1 (published) → HEAD (Spec 19 working tree)

3.1.1: 11477 violations, HEAD: 6851 violations (−41%)

| # | Oracle | Analyzer | File | Ln | 3.1.1 | HEAD | Result |
|---|--------|----------|------|----|-------|------|--------|
|  1 | still-firing |   data-access TP |                        regen-duos-to-bodyjson.ts | 111 | data-access:warning, data-access:warning |                   data-access:suggestion |        △ w→s |
|  2 |       silent |   data-access FP |                      backfill-strategy-heroes.ts | 298 |                      data-access:warning |                                        — |     ✓ SILENT |
|  3 | still-firing |   data-access TP |                                build-articles.ts | 612 |                      data-access:warning |                                        — |     ✗ SILENT |
|  4 | still-firing |   data-access TP |                      strategist-chat-response.ts | 325 | data-access:warning, data-access:suggestion, data-access:warning |                      data-access:warning |     ✓ FIRING |
|  5 |       silent |   data-access FP |                  verify-stadium-build-quality.ts | 107 | data-access:warning, data-access:warning |                   data-access:suggestion |        △ w→s |
|  6 |       silent |   data-access FP |                            extract-strategies.ts | 743 |                      data-access:warning |                   data-access:suggestion |        △ w→s |
|  7 | still-firing |   data-access TP |                                      workflow.ts | 319 | data-access:suggestion, data-access:warning |                   data-access:suggestion |        △ w→s |
|  8 | still-firing |   data-access TP |                              dedup-strategies.ts | 249 | data-access:suggestion, data-access:warning |                   data-access:suggestion |        △ w→s |
|  9 |       silent |   data-access FP |                                  creator-flow.ts |  62 |                      data-access:warning |                                        — |     ✓ SILENT |
| 10 |       silent |   data-access FP |                           patch-apply-stadium.ts | 124 |                      data-access:warning |                                        — |     ✓ SILENT |
| 11 |       silent |     solid+doc FP |                                     hero-repo.ts |  83 |  solid:warning, documentation:suggestion | solid:warning, documentation:suggestion, documentation:suggestion, documentation:suggestion, documentation:suggestion |     ✗ FIRING |
| 12 |       silent |     solid+doc FP |                                     RoleCard.tsx |  15 |  solid:warning, documentation:suggestion |  solid:warning, documentation:suggestion |     ✗ FIRING |
| 13 | still-firing |         solid TP |                              batch-regenerate.ts | 106 |                            solid:warning |                         solid:suggestion |        △ w→s |
| 14 | still-firing |         solid TP |                         backfill-weapon-icons.ts | 148 |                            solid:warning |                         solid:suggestion |        △ w→s |
| 15 | still-firing |         solid TP |                                 scripts/merge.ts |  16 |  solid:warning, documentation:suggestion | solid:suggestion, documentation:suggestion |        △ w→s |
| 16 | still-firing |         solid TP |                            test-sandbox-merge.ts |  70 |                            solid:warning |                         solid:suggestion |        △ w→s |
| 17 |       silent |         solid FP |                                 duo-generator.ts | 390 |             solid:warning, solid:warning |             solid:warning, solid:warning |     ✗ FIRING |
| 18 | still-firing |         solid TP |                 wiki-stadium-html-diagnostics.ts |  53 | solid:warning, solid:warning, documentation:suggestion, documentation:suggestion | solid:suggestion, solid:warning, documentation:suggestion, documentation:suggestion |     ✓ FIRING |
| 19 |          dry |    dry (warning) |                                   wiki/parser.ts | 746 |                              dry:warning |                                        — |     ✗ SILENT |
| 20 |          dry |    dry (warning) |                              AddBlockPopover.tsx | 138 |         dry:warning, data-access:warning |                              dry:warning |     ✓ FIRING |
| 21 |          dry |    dry (warning) |                             stadium-build-url.ts |   1 |                              dry:warning |                                        — |     ✗ SILENT |
| 22 |          dry |    dry (warning) |                      StrategistReplyMarkdown.tsx |   1 |                              dry:warning |                                        — |     ✗ SILENT |
| 23 |          dry |    dry (warning) |                          generate-duo-article.ts |   1 |              dry:warning, schema:warning |                           schema:warning |     ✓ FIRING |
| 24 |          dry | dry (suggestion) |                        run-knowledge-keystone.ts | 717 |                           dry:suggestion |                                        — |     ✗ SILENT |
| 25 |          dry | dry (suggestion) |                                  ConvertRail.tsx |  31 |                           dry:suggestion |                                        — |     ✗ SILENT |
| 26 |          dry | dry (suggestion) |                                 run-synthesis.ts | 255 | dry:suggestion, documentation:suggestion | documentation:suggestion, documentation:suggestion, documentation:suggestion, documentation:suggestion |     ✓ FIRING |
| 27 |          dry | dry (suggestion) |                            admin-asset-rehost.ts | 463 |                           dry:suggestion |                                        — |     ✗ SILENT |

## Summary

- **3.1.1**: all 27 fire. Report: 11477 total (5198 warnings, 6279 suggestions)
- **HEAD**: 10 silent, 9 downgraded to suggestion, 8 still firing with warnings. Report: 6851 total (1703 warnings, 5148 suggestions)

## Per-Analyzer Deltas

| Analyzer | 3.1.1 | HEAD | Delta |
|----------|-------|------|-------|
| data-access | 7034 | 2253 | (-4781, -68%) |
| dry | 1149 | 120 | (-1029, -90%) |
| solid | 1066 | 1076 | (+10, +1%) |
| documentation | 1559 | 2561 | (+1002, +64%) |
| schema | 669 | 841 | (+172, +26%) |
| react | 0 | 0 |  |

## Mismatch Analysis

1. **Dry analyzer collapse** (6 items: #19,21,22,24,25,27): went from 1,149→120 (−90%). All 6 oracle dry items went silent — only 2 are in `scripts/` so the scripts-and-tests profile doesn't explain it. The analyzer itself changed dramatically.
2. **Solid/doc out of scope** (3 items: #11,12,17): Spec 19 targeted data-access false positives. These solid + documentation items were never addressed — they still fire unchanged.
3. **Partial data-access fixes** (2 items: #5,6): Downgraded from warning→suggestion — the fix softens but doesn't silence.
4. **Unexpected correct silence** (1 item: #3): `build-articles.ts:612` was classified as a data-access true positive in the oracle, but Spec 19 correctly identified it as a false positive and silenced it.
