# Implementation Handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R183
status: ACTIVE
repository: Cheurteenyt/Ariad
branch: v2/r183-graph-visual-intelligence
base_sha: b6a95f23ca34ba1a141c943f1be0b045be23b9dd
last_completed_code_sha: d54b6ac6472a42f4f445c74b3251a4df1978551e
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-23T11:45:45Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: improve the graph interior without changing the
  package version or claiming evidence that has not been measured.
- Data-format contract: preserve existing backend graph payloads unless a
  measured frontend limitation proves that a bounded, backward-compatible
  contract extension is necessary.
- Security or durability contract: preserve localhost origin, CSRF, WebSocket,
  project-isolation, path, and bounded-shutdown protections.
- Compatibility contract: keep Windows and Linux support, reduced-motion and
  keyboard behavior, deterministic rendering, packaging, and embedded Graph UI
  startup intact.
- Evidence contract: compare official V1 and current V2 on fixed targets,
  viewports, tasks, and fixtures; retain unfavorable results.
- Documentation contract: define Stellar, aggregation, semantic zoom, and the
  navigation path from architecture overview to exact code evidence.

### Explicit non-goals

- A cosmetic V1 skin or mode without task evidence.
- Decorative counters, panels, motion, or labels without a concrete
  code-navigation purpose.
- New token, accuracy, or performance claims derived from uncontrolled runs.
- Weakening budgets, timeouts, tests, or error handling to obtain green checks.

## Audit decisions

No external audit is active. R183 is an owner-directed, evidence-first product
round. Findings below are provisional until the matched baseline is committed.

| Finding | Source | Decision | Evidence or reason | Resolution code commit | Regression test | CI-validated head | Validation state |
|---------|--------|----------|--------------------|------------------------|-----------------|-------------------|------------------|
| R183-E01 | owner objective | ACCEPTED | Run matched V1/V2 visual and interaction evidence before design changes. The first attempted baseline was rejected because its rendered V1 project did not match the preflight project. | pending | evidence harness | pending | IN_PROGRESS |
| R183-E02 | owner objective | ACCEPTED | Isolate visual-noise and wasted-rendering mechanisms, then implement a coherent hierarchy. | pending | targeted UI regressions | pending | NOT_STARTED |
| R183-E03 | owner objective | ACCEPTED | Validate small, medium, empty, disconnected, dense, filtered, and oversized states without regressions. | pending | existing lab plus new bounded fixtures | pending | NOT_STARTED |
| R183-E04 | local reproduction | ACCEPTED | The comparison lab selected the first V1 card whose broad ancestor contained the target name, so the 38-node API preflight could be paired with a rendered 4,287-node project. Captures were also taken after the FPS pan/zoom. The lab now selects a card-local exact heading, verifies the rendered layout URL and complete topology, records that identity, and captures the settled pre-interaction frame. | `d54b6ac6472a42f4f445c74b3251a4df1978551e` | `v2/tests/benchmark/graph-ui-lab.test.ts` | pending | LOCAL_PASS |

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `b6a95f23ca34ba1a141c943f1be0b045be23b9dd` | pending | R183-E01–E03 | baseline and round contracts | repository identity and worktree inspected | pending |
| `d54b6ac6472a42f4f445c74b3251a4df1978551e` | pending | R183-E01, R183-E04 | fail-closed rendered graph identity and pre-interaction blind captures | targeted Vitest 9/9; backend/lab typecheck; 38-node strict browser smoke | pending |

## Exact validation evidence

```text
command: npx vitest run tests/benchmark/graph-ui-lab.test.ts
working_directory: v2
environment: Windows 11 / PowerShell / Node runtime from repository
exit_code: 0
result_summary: 1 file and 9 tests passed, including stale rendered-project and rendered-topology rejection.

command: npm run typecheck
working_directory: v2
environment: Windows 11 / PowerShell / Node runtime from repository
exit_code: 0
result_summary: Backend and Graph UI lab TypeScript configurations passed.

command: npm run bench:graph-ui:compare -- --project graph-ui-lab-controlled --runs 1 --max-nodes 1000 --v2-mode architecture --output ../.codex-runtime/graph-ui-lab/r183-fixed-smoke-v2
working_directory: v2
environment: Windows 11 / Edge / V1 345425a / V2 d54b6ac / 1440x960 DPR 1
exit_code: 0
result_summary: Strict rendered identity passed for both variants at 38 nodes / 84 edges; evidence grade exploratory because this was a one-run smoke.
not_run: Five-run corrected baseline, perception task sheet, frontend suites, backend build/package, and publication gates.
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/Ariad.git
WORK_BRANCH=v2/r183-graph-visual-intelligence

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" Ariad
cd Ariad
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git status --short --branch
git merge-base --is-ancestor b6a95f23ca34ba1a141c943f1be0b045be23b9dd HEAD

cd graph-ui
npm ci
```

### First smoke command after reset

```bash
cd graph-ui
npx tsc --noEmit
```

## Current working state

- **Last completed finding:** R183-E04 corrected the false matched-comparison
  evidence path and proved the rendered 38-node graph on both variants.
- **Current finding:** Establish the corrected five-run baseline, complete the
  anonymous task sheet, then isolate the highest-value visual hierarchy defect.
- **Dirty files expected:** two pre-existing CRLF status markers with
  byte-identical index/worktree blobs; never stage them.
- **Unpushed commits expected:** `0` at a pushed checkpoint.
- **Known blocker:** None.
- **Single next action:** Run corrected five-run Architecture and Stellar
  comparisons on `graph-ui-lab-controlled`, evaluate A/B tasks before opening
  the blind key, and record the root-cause decision.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No SSH host-trust change was performed in this round.

## Pre-final-audit checklist

- [ ] Every finding has a decision and evidence.
- [ ] Every accepted finding has a pushed resolution commit.
- [ ] Regression tests fail if their corrections are reverted.
- [ ] The full affordable local suite is recorded above.
- [ ] GitHub Actions is green on the candidate SHA.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
