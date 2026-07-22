# R179 structural token-cost diagnosis handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R179
status: ACTIVE
repository: Cheurteenyt/Ariad
branch: v2/r179-structural-token-costs
base_sha: 148e4b65849efc3fcfbc4fb716abf0898424293d
last_completed_code_sha: 4cd8e695bcdb67b4f317a69a0aaba4ba9ff5fdc5
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-22T18:50:48.3660556Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: diagnose T02, T03, and T04 from the exact R176
  selected artifacts before changing product code; only implement a narrow,
  low-risk correction directly supported by that diagnosis.
- Data-format contract: preserve the registered task questions, independent
  TypeScript-oracle answers, grading, attribution, and immutable historical
  R176/R177/R178 evidence.
- Security or durability contract: fresh measured artifacts are append-once in
  a new external root and every measured process follows a pushed
  pre-registration with an environment disclosure captured beforehand.
- Compatibility contract: do not change T01 or `direct_callers`; preserve
  existing MCP contracts unless the written diagnosis specifically justifies a
  backward-compatible bounded option.

### Explicit non-goals

- No T01 rerun or reinterpretation, no new task, no Graph UI work, no new MCP
  tool unless every existing tool is proven unsuitable, and no forced product
  fix for a structural or high-risk cost gap.
- No claim that lower raw tokens imply lower uncached tokens, latency, or
  correctness; each metric remains separately reported.

## Diagnostic findings

The three diagnoses must be completed and pushed before any product edit.

| Finding | Task | Decision | Evidence | Product change | Validation state |
|---------|------|----------|----------|----------------|------------------|
| R179-DIAG-T02 | T02 | IMPLEMENTED | 21/15 small and 8/7 large B calls manually chase names, aliases, re-exports, and modules; aggregate payload and round trips dominate | bounded `transitive_type_impact` on existing lookup tool | 2/2 pinned oracle smokes exact and complete |
| R179-DIAG-T03 | T03 | IMPLEMENTED WITH BOUNDARY | small one-shot is already one exact 516-byte call; large target is ambiguous by short name and exact positions require broad follow-ups | bounded declaration-qualified `symbol_call_sites`; efficient empty path and `direct_callers` unchanged | 2/2 pinned oracle smokes exact and complete |
| R179-DIAG-T04 | T04 | IMPLEMENTED WITH BOUNDARY | small direct aggregation lacks 27 individual positions; large empty result is followed by redundant literal confirmation; fixed MCP overhead remains | share `symbol_call_sites` with T03 and preserve duplicate positions | 2/2 pinned oracle smokes exact and complete |

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `e8f4b99aca85cb3eea2cdb86059d5fe89a43d8fc` | `e8f4b99aca85cb3eea2cdb86059d5fe89a43d8fc` | R179-INIT | Initialize bounded T02-T04 diagnosis from the post-R178 canonical main | docs check PASS; clean exact base; protocol and artifact inventory read | [CI 29946043041](https://github.com/Cheurteenyt/Ariad/actions/runs/29946043041) PASS |
| `4cd8e695bcdb67b4f317a69a0aaba4ba9ff5fdc5` | pending | R179-IMPL | Add declaration-qualified semantic call sites and transitive type impact without changing `direct_callers` | MCP 46/46; typecheck, build, package, docs PASS; six pinned smokes exact | [CI 29948244532](https://github.com/Cheurteenyt/Ariad/actions/runs/29948244532) running |

## Exact validation evidence

```text
command: git status --short --branch; git rev-parse HEAD; git rev-parse origin/main
working_directory: repository root
environment: Windows 11, PowerShell, read-only Git inspection
exit_code: 0
result_summary: clean main and origin/main both resolve to 148e4b65849efc3fcfbc4fb716abf0898424293d before branch creation
not_run: no product test and no measured benchmark process before diagnosis
```

```text
command: inspect R176 per-task.md, selected-runs.csv, raw-artifact-manifest.json, active tasks.json, and the external r176 raw root
working_directory: repository root and D:/Mycodex/benchmark-results/r176-structural-correctness-final
environment: read-only artifact inspection
exit_code: 0
result_summary: all 24 selected T02-T04 B/C cells and their complete JSONL/MCP traces are locally available; initial table shows call-heavy T02 and low-call but context-heavy T03/T04 patterns
not_run: no conclusion is accepted until every selected cell is mechanically re-derived
```

```text
command: node scripts/benchmark/v1-v2-truth-audit/summarize.mjs --results-root D:/Mycodex/benchmark-results/r176-structural-correctness-final --phase baseline --output-dir D:/Mycodex/benchmark-results/r179-t02-t04-diagnosis-derived; compare filtered generated T02-T04 B/C rows with canonical selected-runs.csv
working_directory: repository root
environment: Windows 11, Node v24.15.0, npm 11.12.1, Codex CLI 0.144.4; derived output only, no measured process
exit_code: 0
result_summary: 32 selected, 0 invalid; all 24 T02-T04 B/C rows exactly match the canonical CSV
not_run: no fresh benchmark cell and no product code before the diagnosis checkpoint
```

```text
command: inspect every selected R176 T02-T04 JSONL and MCP trace; attribute completed tools, response bytes, prior context, raw input, cached input, and output
working_directory: repository root and immutable external R176 raw root
environment: read-only artifact inspection
exit_code: 0
result_summary: T02 is repeated name/alias/module discovery; large T03 is ambiguous short-name resolution plus missing exact locations; T04 is missing individual positions plus redundant empty-set confirmation; fixed MCP/schema/cache cost explains the remaining efficient small-T03 boundary
not_run: accepted product mechanisms remain unimplemented until this checkpoint is committed and pushed
```

```text
command: npm run typecheck; npx vitest run tests/mcp; npm run build:package; npm run docs:check
working_directory: v2
environment: Windows 11, Node v24.15.0, npm 11.12.1
exit_code: 0
result_summary: backend and graph-lab typechecks PASS; all 46 MCP tests PASS; complete embedded-UI package PASS; 66-file documentation validation and structural spec verification PASS
```

```text
command: invoke transitive_type_impact for T02 and symbol_call_sites for T03/T04 directly through the built lookup tool against both pinned R176 projects; compare copy-ready arrays with tasks.json oracle answers
working_directory: repository root
environment: XDG-compatible pinned DB state D:/Mycodex/benchmark-state/v2-r173-final; small SHA 5915e06; large SHA ef3a583
exit_code: 0
result_summary: 6/6 exact, complete=true, zero incomplete reasons; response bytes small T02/T03/T04 563/385/2911 and large 672/1032/436
```

```text
command: npm test
working_directory: v2
environment: Windows 11 local host
exit_code: 1
result_summary: broader local suite is platform-environment blocked: 539 unrelated filesystem/security tests fail together because Windows temporary directories are reported with POSIX mode 0666; targeted MCP suites, typecheck, build, docs, package, and pinned semantic smokes pass
scope_decision: no permissive workaround or unrelated filesystem change; rely on the supported Linux GitHub backend job for the broad suite and retain this local disclosure
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/Ariad.git
WORK_BRANCH=v2/r179-structural-token-costs

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" Ariad
cd Ariad
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git merge-base --is-ancestor 148e4b65849efc3fcfbc4fb716abf0898424293d HEAD
git status --short --branch

cd v2
npm ci
```

### First smoke command after reset

```powershell
node scripts/benchmark/v1-v2-truth-audit/run.mjs verify `
  --results-root D:/Mycodex/benchmark-results/r176-structural-correctness-final `
  --v2-home D:/Mycodex/benchmark-state/v2-r173-final
```

## Current working state

- **Last completed finding:** R179-IMPL is pushed at `4cd8e69`; all six pinned
  semantic answers are exact and complete.
- **Current finding:** establish exact CI head, then publish a pushed immutable
  environment disclosure and B/C pre-registration before any measured process.
- **Dirty files expected:** this handoff and benchmark pre-registration only.
- **Unpushed commits expected:** one immutable pre-registration checkpoint.
- **Known blocker:** none.
- **Single next action:** push the immutable pre-registration, record its exact
  SHA/time and green CI, then verify build/runner/oracles before creating the
  raw result root.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No new SSH host trust was established in this round.

## Pre-final-audit checklist

- [x] Every diagnosis is written and pushed before product code changes.
- [x] Every accepted fix has a focused regression that fails when reverted.
- [ ] Fresh B/C cells disclose the full environment before measurement.
- [ ] The full affordable local suite and GitHub Actions are recorded.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
