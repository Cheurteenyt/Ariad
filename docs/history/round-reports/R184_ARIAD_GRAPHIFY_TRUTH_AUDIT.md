# Implementation Handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R184
status: LOCAL_VALIDATION_PENDING
repository: Cheurteenyt/Ariad
branch: codex/r184-graphify-truth-audit
base_sha: 0789b3019d1847605ebe60a3be6abd16363249fe
postfix_product_sha: a699e27626673d29f91344b4b2d6a059ac63d728
benchmark_preregistration_sha: 1ed1d4c8a1697ed7ea8f5ac66f79dbf4a42105cf
updated_at_utc: 2026-07-24T00:00:00Z
implementer_role: codex
```

## Contracts

- Preserve the legacy active database, MCP, human-memory, package, and
  single-renderer Graph UI boundaries.
- Keep Graphify, external repositories, generated graphs, Obsidian vaults,
  caches, environments, and raw evidence outside the Ariad source tree.
- Do not copy Graphify implementation or visual design.
- Keep baseline and post-fix evidence immutable and publish losses as well as
  wins.
- Treat extractor semantics 9 as a full-reindex boundary.
- Keep exact scope deterministic, revision-bound, paginated, and bounded.
- Preserve Windows and Linux support and existing frontend bundle budgets.

## Implemented findings

| Finding | Resolution | Regression |
|---|---|---|
| NodeNext `.js` requests did not resolve TypeScript source modules portably on Windows | portable extension substitution and path normalization | `r184-windows-nodenext-call-graph.test.ts` |
| File-level imports were not available as exact directed dependency evidence | deduplicated File-to-File `IMPORTS` edges with evidence metadata; semantics 9 | resolver and migration regressions |
| Exact directory scopes omitted complete boundary totals | cached SQLite boundary aggregation with incoming/outgoing groups and truncation | bridge exact-scope regressions |
| `get_module_context` treated directory paths as ambiguous file names | exact bounded directory context before normal symbol resolution | `get-module-context.test.ts` |
| UI search did not promote an exact directory task | exact directory action and compact strongest-reference HUD | Sidebar, hook, and reconciliation tests |
| UI additions exceeded the existing manifest budget | reduced duplicated copy and reused the existing scope summary | production bundle gate |
| Invalid query reruns could be cherry-picked or incompletely sealed | strict first-attempt audit, full warm-prefix reruns, reconciliation, and external rerun inclusion | benchmark harness tests |

## Evidence summary

- Baseline seal: 76,904 files, 841,016,669 bytes, payload
  `efd815f15ecb8d5c7f8fc6ba277c999dadabc8e8d066d73656e3d1318aaf8bf2`.
- Post-fix seal: 76,611 files, 833,533,115 bytes, payload
  `8cefc9cee75d788161d5eb5ec33d942b0f4f62e80c27c90d44289b9844bff56a`.
- Index/update: 66/66 successful cells.
- Queries: 256 primary cells; 21 invalid first attempts, 14 accepted strict
  replacements, seven unresolved invalid cells.
- Visual: 80/80 completed cells; neither product passed T09/T10.
- Product verdict: Ariad wins index/update speed and exact failure-visible
  workflow, loses current T04/T06 selection quality and Graphify first render,
  and has no demonstrated T05 human-memory win.

See the current
[competitive report](../../performance/reports/R184_ARIAD_VS_GRAPHIFY_TRUTH_AUDIT_2026-07-24.md)
and its
[machine-readable summary](../../performance/benchmarks/r184-ariad-vs-graphify-2026-07-23/competitive-summary.json).

## Validation and publication

This section is completed only after local validation, GitHub checks, exact
merge, mirror verification, branch deletion, final-main reindex, and packaged
Graph UI startup.

```text
local_validation: pending
github_pr: pending
github_ci: pending
codeql: pending
mirror: pending
merge_commit: pending
final_main_reindex: pending
packaged_graph_ui: pending
```
