# GitHub ↔ GitLab Branch Bridge (R156 + R157 + R158)

## Overview

The Codebase Memory V2 project is **mirrored** between GitLab (canonical home)
and GitHub (where CI runs). R156 introduced a **bidirectional branch bridge**
so that:

1. **MR-driven CI** runs on GitHub Actions for every GitLab MR (instead of
   the echo-only `mr-preflight` job that previously existed).
2. **graph-ui feature branches** follow the GitHub PR flow (with full CI)
   and are automatically synced to GitLab MRs after CI passes.

This document describes the architecture, security model, and operational
procedures for both bridges. R157 hardened the graph-ui sync workflow with
fork/path guards and `--force-with-lease`. R158 closed the remaining gaps:
shallow-fetch merge-base failure, missing `remove_source_branch` on PUT,
and silent take-first on duplicate MRs.

## Repositories

| Git host  | URL                                                              | Role                          |
|-----------|------------------------------------------------------------------|-------------------------------|
| GitLab    | `https://gitlab.com/cheurteen1/codebase-memory-V2`              | Canonical home, MR target     |
| GitHub    | `https://github.com/Cheurteenyt/codebase-mirror`                | CI runner, mirror target      |

The `mirror-to-github` GitLab CI job (on every push to `main`) keeps
GitHub `main` in sync with GitLab `main`. After R156, MR pipelines ALSO
trigger GitHub CI (see below).

## Bridge 1: GitLab MR → GitHub CI gate

### Problem (R156 / CI-FLOW-R156-01)

Before R156, the `mr-preflight` job in `.gitlab-ci.yml` was a 2-second
`echo` that did nothing. Real CI (typecheck, build, test) only ran on
GitHub Actions **after** the MR was merged to `main`. This meant a broken
MR could be merged, breaking `main` and the GitHub mirror, before anyone
noticed the CI failure.

### Solution

The new `github-ci-gate` job in `.gitlab-ci.yml`:

1. **Checks** whether `.github/workflows/gitlab-mr-ci.yml` exists on
   GitHub `main`. If not (transitional R156 MR), the gate exits
   successfully with `allow_failure: true` so the MR can merge.
2. **Pushes** the MR's HEAD SHA to a temporary branch
   `gitlab-ci/mr-<iid>` on GitHub.
3. **Triggers** the `gitlab-mr-ci` workflow via `repository_dispatch`,
   passing the SHA, MR IID, and source branch name as `client_payload`.
4. **Polls** the GitHub Actions API for the run conclusion
   (up to 15 minutes).
5. **Cleans up** the temporary branch.
6. **Fails** the GitLab CI job if the GitHub CI failed or timed out.

### The `gitlab-mr-ci` workflow

`.github/workflows/gitlab-mr-ci.yml` is triggered by
`repository_dispatch` with event type `gitlab-mr-ci`. It:

1. **Validates** the payload (SHA is 40 hex chars, MR IID is a number).
2. Runs the **backend** job (`v2/`): `npm install`, `tsc --noEmit`,
   `npm run build`, `npx vitest run`.
3. Runs the **frontend** job (`graph-ui/`): same four steps.

The workflow uses `concurrency` to cancel previous runs for the same MR.

### Required secrets

| Secret                  | Where        | Scope                                          |
|-------------------------|--------------|------------------------------------------------|
| `GITHUB_MIRROR_TOKEN`   | GitLab CI/CD | GitHub PAT with `repo` scope (push + dispatch) |

The token is used for:
- `git push` to the temporary `gitlab-ci/mr-<iid>` branch on GitHub.
- `curl` to the GitHub API (workflow existence check, repository_dispatch,
  polling for run conclusion).

### Transitional state

Because `gitlab-mr-ci.yml` is introduced IN this MR, it doesn't exist on
GitHub `main` until the MR merges and the next `mirror-to-github` job
runs. During the transitional window, the gate exits successfully with
`allow_failure: true`. After the merge:

1. The mirror job copies `gitlab-mr-ci.yml` to GitHub `main`.
2. A follow-up commit should remove `allow_failure: true` so the gate
   becomes blocking.

## Bridge 2: graph-ui/* branches → GitLab MRs

### Motivation

The graph-ui frontend lives in `graph-ui/` inside the monorepo. Frontend
contributors should be able to:

- Open a PR on GitHub (familiar workflow, free CI minutes).
- Get full CI (typecheck, build, test) on the PR.
- Have the PR automatically mirrored to a GitLab MR for final review and
  merge into `main`.

### Solution

The new `.github/workflows/sync-graph-ui-to-gitlab.yml` workflow:

1. Is triggered by `workflow_run` on the `CI` workflow, but ONLY when
   the head branch matches `graph-ui/**`.
2. Validates the source branch name (defensive — only `graph-ui/**`
   branches are synced).
3. Checks out the head SHA.
4. Pushes the SHA to a GitLab branch with the same name (`graph-ui/...`).
5. Creates or updates a GitLab MR from `graph-ui/...` → `main`.

### Why `workflow_run`?

`pull_request` workflows don't have access to repository secrets unless
they're explicitly exposed via `pull_request_target` (which is dangerous
because it runs with the base branch's permissions). `workflow_run` runs
in the context of the default branch and has access to all secrets, so it
can push to GitLab using a dedicated SSH deploy key or API token.

The trade-off: `workflow_run` only fires AFTER the upstream workflow
completes, so it doesn't run on every push — only on completed CI runs.
This is exactly what we want: only sync branches whose CI passed.

### Required secrets (R157+R158)

| Secret                                | Where          | Scope                                                                  |
|---------------------------------------|----------------|------------------------------------------------------------------------|
| `GITLAB_GRAPH_UI_SSH_PRIVATE_KEY`     | GitHub Actions | Ed25519 SSH private key for `git push` to GitLab (deploy key)          |
| `GITLAB_GRAPH_UI_API_TOKEN`           | GitHub Actions | GitLab PAT with `api` scope (MR create/update + `remove_source_branch`)|
| `GITLAB_KNOWN_HOSTS` (variable)       | GitHub Actions | `gitlab.com` SSH known_hosts entry (TOFU prevention)                   |
| `GITLAB_REPOSITORY_SSH_URL` (variable)| GitHub Actions | `git@gitlab.com:cheurteen1/codebase-memory-V2.git`                     |
| `GITLAB_PROJECT_ID` (variable)        | GitHub Actions | URL-encoded project path (`cheurteen1%2Fcodebase-memory-V2`)            |

The SSH key is used for `git push` (writes). The API token is used for
the MR create/update API calls. R157 split these into two credentials so
that compromise of the API token doesn't grant push access (and vice
versa). The SSH key is removed from the runner in an `if: always()` step.

## Security model (R157+R158)

### Fork guard (R157 — SEC-R157-01)

The workflow's `if:` condition checks
`github.event.workflow_run.head_repository.full_name == github.repository`.
A fork PR with a `graph-ui/*` head branch would have a different
`head_repository.full_name`, so the workflow refuses to run. This
prevents a forked contributor from triggering a sync to the canonical
GitLab repo.

### Path guard (R157 — SEC-R157-02, R158 — SYNC-R158-01)

After checkout, the workflow runs:

```bash
git fetch origin main
git diff --name-only origin/main...HEAD |
  grep -E '^(\.github/workflows/|\.gitlab-ci\.yml$)' && exit 1
```

If the branch modifies any privileged CI file (`.github/workflows/*` or
`.gitlab-ci.yml`), the workflow exits with an error and refuses to sync.
This prevents a `graph-ui/*` branch from smuggling in a malicious CI
change that would be auto-merged into `main`.

R158 fixed a bug in this guard: R157 used `git fetch origin main
--depth=1`, which can fail with "no merge base" if `main` has advanced
since the branch was created. R158 uses a full fetch (`git fetch origin
main`).

### `--force-with-lease` (R157 — SYNC-R157-01)

The push to GitLab uses `--force-with-lease="refs/heads/$BRANCH:$REMOTE_SHA"`
instead of `--force`. The `REMOTE_SHA` is fetched via `git ls-remote`
immediately before the push. If someone else (or another workflow run)
pushed to the same GitLab branch between the `ls-remote` and the `push`,
the `--force-with-lease` check fails — preventing silent overwrite of
unrelated work.

### `remove_source_branch=true` on POST and PUT (R157 + R158 — SYNC-R158-02)

Both the POST (create MR) and PUT (update MR) calls include
`--data-urlencode "remove_source_branch=true"`. This tells GitLab to
delete the source branch when the MR is merged. R157 only set it on
POST, so MRs created before R157 (or MRs that were updated before
merge) didn't have the flag — the source branch lingered after merge.
R158 added it to PUT.

### `MR_COUNT > 1` failure (R158 — SYNC-R158-03)

If the GitLab API returns more than one open MR for the same source
branch, the workflow fails loudly with a diagnostic message and the
JSON list of duplicates. R157 silently took `MRs[0]`, masking the
duplication. Duplicate MRs usually indicate a manual mistake or a stale
duplicate that should be closed manually before re-running the sync.

### SSH key cleanup (R157)

The `Remove private key` step runs with `if: always()` so the key is
removed from the runner even if a previous step failed. This is a
defense-in-depth measure — GitHub Actions runners are ephemeral, but
removing the key reduces the window during which a compromised
subsequent step could read it.

### `workflow_run` trust boundary (R156)

`workflow_run` events use the **default branch**'s workflow file, not the
PR's. This means a PR cannot modify the sync workflow to bypass the
branch allowlist or steal the token. The workflow file is always read
from `main`.

## Operational procedures

### Initial deployment (R156 + R157 + R158)

1. Merge the R156 MR to GitLab `main`.
2. The `mirror-to-github` GitLab CI job mirrors `main` (including
   `.github/workflows/gitlab-mr-ci.yml` and
   `.github/workflows/sync-graph-ui-to-gitlab.yml`) to GitHub `main`.
3. Verify the workflow files exist on GitHub `main`:
   ```bash
   curl -fsSL \
     -H "Authorization: Bearer $GITHUB_MIRROR_TOKEN" \
     "https://api.github.com/repos/Cheurteenyt/codebase-mirror/contents/.github/workflows/gitlab-mr-ci.yml?ref=main"
   ```
4. Add the R157+R158 secrets and variables to the GitHub repo (Settings →
   Secrets and variables → Actions):
   - **Secrets**: `GITLAB_GRAPH_UI_SSH_PRIVATE_KEY` (Ed25519 private key),
     `GITLAB_GRAPH_UI_API_TOKEN` (GitLab PAT with `api` scope).
   - **Variables**: `GITLAB_KNOWN_HOSTS` (`gitlab.com` SSH known_hosts),
     `GITLAB_REPOSITORY_SSH_URL` (`git@gitlab.com:...`),
     `GITLAB_PROJECT_ID` (URL-encoded project path).
5. Create the `gitlab-graph-ui-sync` environment (Settings →
   Environments → New environment) and attach the secrets/variables to
   it. The workflow's `environment: gitlab-graph-ui-sync` declaration
   restricts secret exposure to that environment only.
6. (Follow-up commit) Remove `allow_failure: true` from the
   `github-ci-gate` job in `.gitlab-ci.yml`.

### Opening a graph-ui PR (after deployment)

1. Create a branch named `graph-ui/<feature>` on GitHub.
2. Push it and open a PR against `main`.
3. The `CI` workflow runs (typecheck, build, test).
4. When CI succeeds, the `Sync graph-ui to GitLab` workflow runs
   automatically.
5. The workflow pushes the branch to GitLab and creates/updates a GitLab
   MR. If the MR already exists, it's updated with the new SHA, title,
   description, and `remove_source_branch=true`.
6. Review and merge the GitLab MR. The source branch is auto-deleted on
   merge (R157+R158).

### Debugging a failed sync

If the `Sync graph-ui to GitLab` workflow fails:

1. **`Refusing unexpected branch`** — the head branch doesn't match
   `graph-ui/**`. Rename the branch or fix the trigger.
2. **`Graph UI branch modifies privileged CI files`** — the branch
   touches `.github/workflows/` or `.gitlab-ci.yml`. Split those
   changes into a separate infrastructure MR.
3. **`no merge base`** — R158 should have fixed this. If it still
   happens, ensure the workflow file on `main` is the R158 version
   (full fetch).
4. **`Found N open MRs for source branch` (N > 1)** — duplicate MRs
   exist on GitLab. Close all but one manually, then re-run the
   workflow.

### Debugging a failed CI gate

If the `github-ci-gate` GitLab CI job fails:

1. Check the job logs for the GitHub Actions URL.
2. Open the URL to see which job (backend/frontend) failed.
3. Re-run the failed job on GitHub (or push a fix to the MR branch — the
   gate will re-run on the next pipeline).

If the gate times out (15 minutes), check whether the GitHub workflow is
stuck in `queued` (GitHub Actions overload). Re-run the GitLab pipeline
to re-trigger the gate.

## Limitations (R156 + R157 + R158)

- The `github-ci-gate` job uses `allow_failure: true` until the follow-up
  commit removes it. During this window, MRs can merge even if the gate
  would have failed.
- The graph-ui sync workflow only triggers after CI succeeds. If CI is
  skipped (e.g., path filters), no sync happens.
- The GitLab MR created by the sync workflow uses `--force-with-lease`
  (R157) to push the branch. If a developer manually pushes to the same
  GitLab branch, the next sync will fail (lease check) until the
  developer's SHA is fetched. The branch name `graph-ui/<feature>`
  should be considered owned by the sync workflow.
- The sync workflow doesn't transfer PR review state or comments from
  GitHub to GitLab. The GitLab MR description links to the GitHub PR for
  reference.
- The `MR_COUNT > 1` failure (R158) is a guard, not auto-recovery.
  Operators must manually close the duplicate MRs on GitLab before
  re-running the sync.
