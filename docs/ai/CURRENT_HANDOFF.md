# R181 Structural Cost Root-Cause Handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R181
status: ACTIVE
repository: Cheurteenyt/Ariad
branch: v2/r181-structural-cost-root-cause
base_sha: 93e0d5c99fa5dd09a5276a9c5c7e922b16f64315
last_completed_code_sha: 93e0d5c99fa5dd09a5276a9c5c7e922b16f64315
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-22T23:25:54Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: preserve every public MCP, CLI, UI, and package contract unless the evidence proves a contract defect.
- Data-format contract: keep the R176 structural task specification, independent oracle, prompts, native accounting, and grading semantics unchanged.
- Security or durability contract: benchmark roots are append-once; invalid artifacts remain disclosed; no credential or private host path enters tracked evidence.
- Compatibility contract: Windows remains supported and benchmark helpers use Node process/path APIs with argument arrays.

### Explicit non-goals

- No change to T01, `direct_callers`, or the R177/R179 multi-hop implementation.
- No new MCP tool and no speculative product optimization unsupported by repeated traces.
- No Graph UI or unrelated documentation redesign in this round.

## Audit decisions

No external audit is active. R181 is an evidence-first root-cause round initiated from the mixed R176 T02-T04 result.

| Finding | Audit source | Decision | Evidence or reason | Resolution code commit | Regression test | CI-validated head | Validation state |
|---------|--------------|----------|--------------------|------------------------|-----------------|-------------------|------------------|
| R181-LOCAL-F001 | R176 T02-T04 single-sample evidence | ACCEPTED | Repeat N=3 and attribute token cost before deciding whether a repository defect exists. | pending | pending | pending | NOT_STARTED |

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `93e0d5c99fa5dd09a5276a9c5c7e922b16f64315` | pending | R181-LOCAL-F001 | Post-PR #76 clean-main anchor. | `git status`; exact local/origin SHA | pending |

## Exact validation evidence

```text
command: git status --short --branch; git rev-parse HEAD; git remote -v
working_directory: D:/Mycodex/codebase-mirror
environment: Windows benchmark host
exit_code: 0
result_summary: clean main and origin/main both at 93e0d5c99fa5dd09a5276a9c5c7e922b16f64315; origin is Cheurteenyt/Ariad
not_run: build, oracle verification, and repeated measurements wait for the pushed pre-registration
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/Ariad.git
WORK_BRANCH=v2/r181-structural-cost-root-cause

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" Ariad
cd Ariad
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git status --short --branch
git merge-base --is-ancestor 93e0d5c99fa5dd09a5276a9c5c7e922b16f64315 HEAD

cd v2
npm ci
```

### First smoke command after reset

```bash
node scripts/benchmark/v1-v2-truth-audit/run.mjs verify --results-root D:/Mycodex/benchmark-results/r181-t02-t04-cost-rep-1
```

## Current working state

- **Last completed finding:** post-PR #76 main anchored; no product finding yet.
- **Current finding:** R181-LOCAL-F001, repeated T02-T04 cost attribution.
- **Dirty files expected:** protocol pre-registration, environment helper, and this handoff until the first checkpoint.
- **Unpushed commits expected:** 0 before the pre-registration commit is created.
- **Known blocker:** none.
- **Single next action:** validate, commit, and push the immutable R181 pre-registration before creating a raw result root.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No replaced ephemeral GitHub key needs revocation.
- [x] No new SSH host trust was established.

## Pre-final-audit checklist

- [ ] Every finding has a decision and evidence.
- [ ] Every accepted finding has a pushed resolution commit or an evidence-backed no-fix conclusion.
- [ ] Regression tests fail if an implemented correction is reverted.
- [ ] The full affordable local suite is recorded above.
- [ ] GitHub Actions is green on the candidate SHA.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
