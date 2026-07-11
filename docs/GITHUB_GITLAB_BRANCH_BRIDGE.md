# GitHub ↔ GitLab Branch Bridge (R156)

## Overview

The Codebase Memory V2 project is **mirrored** between GitLab (canonical home)
and GitHub (where CI runs). R156 introduces a **bidirectional branch bridge**
so that:

1. **MR-driven CI** runs on GitHub Actions for every GitLab MR (instead of
   the echo-only `mr-preflight` job that previously existed).
2. **graph-ui feature branches** follow the GitHub PR flow (with full CI)
   and are automatically synced to GitLab MRs after CI passes.

This document describes the architecture, security model, and operational
procedures for both bridges.

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
can push to GitLab using `GITLAB_MIRROR_TOKEN`.

The trade-off: `workflow_run` only fires AFTER the upstream workflow
completes, so it doesn't run on every push — only on completed CI runs.
This is exactly what we want: only sync branches whose CI passed.

### Required secrets

| Secret                  | Where          | Scope                                          |
|-------------------------|----------------|------------------------------------------------|
| `GITLAB_MIRROR_TOKEN`   | GitHub Actions | GitLab PAT with `api` scope (push + MR create) |

The token is used for:
- `git push` to GitLab branches.
- `curl` to the GitLab API (MR create/update).

## Security model

### Token minimization

- The GitHub PAT (`GITHUB_MIRROR_TOKEN`) is used by GitLab CI only. It
  needs `repo` scope to push branches and trigger `repository_dispatch`.
- The GitLab PAT (`GITLAB_MIRROR_TOKEN`) is used by GitHub Actions only.
  It needs `api` scope to push branches and create MRs.
- Neither token is ever written to logs, URLs, or commit messages. Both
  bridges use `http.extraHeader` for git auth and `Authorization` headers
  for API calls.

### Branch allowlist

The graph-ui sync workflow ONLY syncs branches matching `graph-ui/**`.
This prevents a malicious PR from a non-`graph-ui` branch from triggering
a sync to GitLab. The check is performed twice (in the `workflow_run`
trigger filter AND in the `Validate source branch` step) for defense in
depth.

### `workflow_run` trust boundary

`workflow_run` events use the **default branch**'s workflow file, not the
PR's. This means a PR cannot modify the sync workflow to bypass the
branch allowlist or steal the token. The workflow file is always read
from `main`.

## Operational procedures

### Initial deployment (R156)

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
4. Add the `GITLAB_MIRROR_TOKEN` secret to the GitHub repo (Settings →
   Secrets and variables → Actions → New repository secret).
5. (Follow-up commit) Remove `allow_failure: true` from the
   `github-ci-gate` job in `.gitlab-ci.yml`.

### Opening a graph-ui PR (after deployment)

1. Create a branch named `graph-ui/<feature>` on GitHub.
2. Push it and open a PR against `main`.
3. The `CI` workflow runs (typecheck, build, test).
4. When CI succeeds, the `Sync graph-ui to GitLab` workflow runs
   automatically.
5. The workflow pushes the branch to GitLab and creates/updates a GitLab
   MR.
6. Review and merge the GitLab MR.

### Debugging a failed CI gate

If the `github-ci-gate` GitLab CI job fails:

1. Check the job logs for the GitHub Actions URL.
2. Open the URL to see which job (backend/frontend) failed.
3. Re-run the failed job on GitHub (or push a fix to the MR branch — the
   gate will re-run on the next pipeline).

If the gate times out (15 minutes), check whether the GitHub workflow is
stuck in `queued` (GitHub Actions overload). Re-run the GitLab pipeline
to re-trigger the gate.

## Limitations (R156)

- The `github-ci-gate` job uses `allow_failure: true` until the follow-up
  commit removes it. During this window, MRs can merge even if the gate
  would have failed.
- The graph-ui sync workflow only triggers after CI succeeds. If CI is
  skipped (e.g., path filters), no sync happens.
- The GitLab MR created by the sync workflow uses `--force` to push the
  branch. If a developer manually pushes to the same GitLab branch, the
  sync will overwrite their changes. The branch name `graph-ui/<feature>`
  should be considered owned by the sync workflow.
- The sync workflow doesn't transfer PR review state or comments from
  GitHub to GitLab. The GitLab MR description links to the GitHub PR for
  reference.
