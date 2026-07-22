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
last_completed_code_sha: 148e4b65849efc3fcfbc4fb716abf0898424293d
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-22T18:16:15.2299329Z
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
| R179-DIAG-T02 | T02 | IN_PROGRESS | Recompute selected B/C cells and inspect complete MCP traces | forbidden until diagnosis checkpoint | NOT_STARTED |
| R179-DIAG-T03 | T03 | IN_PROGRESS | Recompute selected B/C cells and inspect complete MCP traces | forbidden until diagnosis checkpoint | NOT_STARTED |
| R179-DIAG-T04 | T04 | IN_PROGRESS | Recompute selected B/C cells and inspect complete MCP traces | forbidden until diagnosis checkpoint | NOT_STARTED |

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `148e4b65849efc3fcfbc4fb716abf0898424293d` | pending | R179-INIT | Initialize bounded T02-T04 diagnosis from the post-R178 canonical main | clean exact base; protocol and artifact inventory read | pending |

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
result_summary: all sixteen selected T02-T04 B/C cells and their complete JSONL/MCP traces are locally available; initial table shows call-heavy T02 and low-call but context-heavy T03/T04 patterns
not_run: no conclusion is accepted until every selected cell is mechanically re-derived
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

- **Last completed finding:** R178 is merged and mirrored at `148e4b6`.
- **Current finding:** R179-DIAG-T02/T03/T04, exact artifact-level diagnosis.
- **Dirty files expected:** active handoff and its documentation pointer until
  the initialization checkpoint is committed.
- **Unpushed commits expected:** 1 initialization checkpoint.
- **Known blocker:** none.
- **Single next action:** mechanically re-derive T02-T04 costs and tool-call
  payload attribution from the immutable R176 raw artifacts.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No new SSH host trust was established in this round.

## Pre-final-audit checklist

- [ ] Every diagnosis is written and pushed before product code changes.
- [ ] Every accepted fix has a focused regression that fails when reverted.
- [ ] Fresh B/C cells disclose the full environment before measurement.
- [ ] The full affordable local suite and GitHub Actions are recorded.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
