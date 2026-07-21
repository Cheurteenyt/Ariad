# Implementation Handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R177
status: ACTIVE
repository: Cheurteenyt/codebase-mirror
branch: v2/r177-multihop-callers
base_sha: 29101436e64113815b5a8223ab0a4b1e7bab3ebb
last_completed_code_sha: 29101436e64113815b5a8223ab0a4b1e7bab3ebb
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-21T04:24:00Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: preserve the existing seven read-only MCP tools
  plus `prepare_edit_context`; do not add a tool.
- Data-format contract: preserve existing MCP request and response contracts
  unless the reproduced root cause proves that no narrower internal change or
  optional parameter can fix multi-hop caller traversal.
- Benchmark contract: use the pinned r176 small and large targets, the
  pre-registered TypeScript-oracle answers, both usage modes, and the existing
  `scripts/benchmark/v1-v2-truth-audit/` pipeline.
- Scope contract: change only reverse multi-hop caller resolution and protect
  direct exhaustive/negative callers and shared-type impact from regressions.

### Explicit non-goals

- Graph UI work.
- Atomic publication work.
- Re-running or changing the unrelated T02-T04 task categories.
- Completing any imaginary T05-T08 tasks: the pre-registration contains eight
  target-scoped task objects named `small/T01-T04` and `large/T01-T04`.

## Audit decisions

| Finding | Audit source | Decision | Evidence or reason | Resolution code commit | Regression test | CI-validated head | Validation state |
|---------|--------------|----------|--------------------|------------------------|-----------------|-------------------|------------------|
| R177-B01-F001 | `docs/performance/benchmarks/structural-correctness-baseline-2026-07-21/per-task.md` | ACCEPTED | r176 records V2 PARTIAL for both `small/T01` modes and FAIL for both `large/T01` modes; exact local mechanism still pending reproduction | pending | pending | pending | NOT_STARTED |

## Root-cause diagnosis recorded before product changes

The r176 failure is reproduced against both pinned V2 databases with the
published `lookup_source_text` MCP operation. The responsible call path is:

```text
LookupSourceTextTool.handle
  -> LookupSourceTextTool.handleDirectCallers
  -> CodeGraphReader.listDirectCallers
```

`prepare_edit_context` is not the transitive implementation: it obtains one
bounded `CALLS` neighbor set with `getBulkNeighbors(..., "both", 50,
"CALLS")`. `get_module_context` likewise performs one
`getNeighbors(..., "both", maxNodes + 1)` query. Neither tool appeared in the
small T01 traces, and neither exposes a reverse multi-hop traversal.
`lookup_source_text.call_chain` does traverse, but in the opposite direction:
it finds one shortest route/CLI-entry-to-terminal chain and cannot enumerate
all reverse callers of a known symbol.

The exact mechanism is the combination of an absent transitive caller
operation and three lossy properties of repeated `direct_callers` calls:

1. `listDirectCallers` reads only `call_sites WHERE last_segment = ?`.
   Intra-file calls are resolved directly to `CALLS` edges by the indexer and
   are not persisted in `call_sites`. The tool can consequently return
   `complete: true` with zero callers even when an exact incoming intra-file
   edge exists.
2. The SQL predicate is a bare symbol-name match. Once a traversal reaches an
   overloaded name such as `clearCache` or `runTests`, call sites for unrelated
   declarations are pooled. The response reports `target_ambiguous`, but gives
   the agent no target identity with which to continue the correct branch.
3. Anonymous callback ownership is normalized only by removing trailing
   `anonymous#N` segments. A variable-assigned arrow such as
   `finalizeMembership` is indexed as file-level `anonymous#19`, so the direct
   response collapses it to the file instead of returning the named callable.

Concrete pinned-source evidence:

- Small: `direct_callers(buildDependencyAtlas)` and
  `direct_callers(getExactScopeMembership)` both reproduce
  `callers: [], complete: true`. SQLite nevertheless contains exact intra-file
  edges `routeLayout::anonymous#41 -> buildDependencyAtlas` and
  `getExactScopePage -> getExactScopeMembership`. The persisted call at
  `sqlite-ro.ts:1043` is owned by file-level `anonymous#19`, which hides the
  independently verified `finalizeMembership` declaration.
- Large: `direct_callers(_innerRunTests)` reproduces
  `callers: [], complete: true`, while SQLite contains the intra-file edge from
  the callback inside `TestRunner.runTests`. `direct_callers(clearCache)`
  returns ten target candidates and mixes `createClearCacheTask`, `opts`,
  `setStorageState`, and a test caller rather than following the specific
  `TestRunner.clearCache` declaration reached at depth one.

This is not an agent early-stop or configured depth-cap failure. Both small
cells issued seven `direct_callers` calls; the large cells issued 30 and 16 MCP
calls respectively and continued with literal source recovery. The false
zero/ambiguous per-hop results are the limiting evidence. The narrow fix must
therefore provide one identity-aware reverse traversal behind the existing
tool, while retaining the depth-one default so T02-T04 and existing direct
caller behavior are not changed.

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `29101436e64113815b5a8223ab0a4b1e7bab3ebb` | pending | R177-B01-F001 | Initialize a bounded R177 diagnosis and resolve the apparent T05-T08 corpus gap | corpus and artifact inventory verified locally | pending |

## Exact validation evidence

```text
command: inspect pre-registration 0f943970..., selected-runs.csv, and r176 .meta.json inventory
working_directory: D:/Mycodex/codebase-mirror
environment: Windows PowerShell, Node.js repository checkout
exit_code: 0
result_summary: eight pre-registered target/task objects and 32/32 expected B/C one-shot/continuous artifacts; no T05-T08 identifiers ever existed
not_run: product tests and benchmark replay are pending root-cause diagnosis
```

```text
command: invoke lookup_source_text.direct_callers through cbm-v2 MCP with the pinned r176 XDG cache; compare call_sites and CALLS rows read-only in SQLite
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows PowerShell, XDG_CACHE_HOME=D:/Mycodex/benchmark-state/v2-r173-final
exit_code: 0
result_summary: reproduced false-complete empty intra-file hops on both targets, bare-name ambiguity on Playwright, and anonymous-owner loss for finalizeMembership
not_run: no product code or regression test has been written yet
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/codebase-mirror.git
WORK_BRANCH=v2/r177-multihop-callers

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" codebase-mirror
cd codebase-mirror
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git status --short --branch
git merge-base --is-ancestor 29101436e64113815b5a8223ab0a4b1e7bab3ebb HEAD

cd v2
npm ci
```

### First smoke command after reset

```bash
node scripts/benchmark/v1-v2-truth-audit/verify-spec.mjs
```

## Current working state

- **Last completed finding:** Part 1 corpus-gap resolution and pre-fix root-cause diagnosis.
- **Current finding:** R177-B01-F001 multi-hop caller completeness.
- **Dirty files expected:** `docs/ai/CURRENT_HANDOFF.md` until this diagnosis checkpoint is pushed.
- **Unpushed commits expected:** `0` before the diagnosis handoff commit.
- **Known blocker:** none.
- **Single next action:** add a focused failing regression for an optional
  identity-aware multi-hop mode without changing the depth-one direct-caller
  default.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No new SSH host key was accepted in this round.

## Pre-final-audit checklist

- [ ] Every finding has a decision and evidence.
- [ ] Every accepted finding has a pushed resolution commit.
- [ ] Regression tests fail if their corrections are reverted.
- [ ] The full affordable local suite is recorded above.
- [ ] GitHub Actions is green on the candidate SHA.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
