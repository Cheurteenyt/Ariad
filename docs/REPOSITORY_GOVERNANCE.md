# Repository Governance — Codebase Memory V2

> **Status:** current
> **Last verified:** 0.75.0 / R169

This document is the source of truth for GitHub repository settings that
are NOT visible in the Git repository itself. It covers branch protection,
environment configuration, merge policy, and security settings.

## 1. Repository Identity

| Property | Value |
|----------|-------|
| Canonical host | GitHub |
| Passive mirror | GitLab |
| Default branch | `main` |
| Repository visibility | Public |

## 2. Ruleset: `protect-main`

| Setting | Value | Rationale |
|---------|-------|-----------|
| Status | Active | Enforced on all pushes to `main` |
| Target | `main` | Only the default branch is protected |
| Admin bypass | Allow for pull requests only | Admins must use PRs, no direct push bypass |
| Restrict deletions | ON | `main` cannot be deleted |
| Require linear history | ON | No merge commits on `main` (squash-only) |
| Require a pull request | ON | No direct pushes to `main` (except break-glass) |
| Required approvals | 0 | Single maintainer; PR + checks still required |
| Dismiss stale approvals | OFF | Not needed with 0 approvals |
| Require review from teams | OFF | No teams configured |
| Require Code Owners | OFF | No CODEOWNERS file yet |
| Require approval of most recent push | OFF | Not needed with 0 approvals |
| Require conversation resolution | ON | All conversations must be resolved before merge |
| Allowed merge methods | Squash only | Linear history + clean commit messages |
| Require status checks | ON | CI must pass before merge |
| Required checks | `Backend (v2)`, `Frontend (graph-ui)` | Both CI jobs must be green |
| Require branches up to date | ON | PR branch must be rebased on latest `main` |
| Block force pushes | ON | No `--force` to `main` |
| Require code scanning | OFF (deferred) | CodeQL not yet activated |
| Require code quality | OFF (deferred) | Not yet configured |
| Restrict code coverage | OFF (deferred) | Not yet configured |

### Checks NOT in the ruleset (post-merge only)

The following checks run AFTER merge and therefore cannot be pre-merge
requirements:

- `Mirror validated main` (mirror workflow triggers on `workflow_run`)
- `gitlab-passive-mirror` (environment deployment)
- `Repository Health Report` (weekly schedule)
- `Docker Smoke` (push to main only, not PR)
- `Package Smoke` (push to main only, not PR)

## 3. Merge Contract

The normal workflow for every change:

```
feature/round branch
  → GitHub Pull Request
  → Backend (v2) + Frontend (graph-ui) green
  → conversations resolved
  → squash merge
  → branch automatically deleted
  → CI on push/main
  → mirror to GitLab
```

## 4. Break-Glass Procedure

Direct push to `main` is NOT the normal workflow. In an emergency:

1. **Declare an incident** (document the reason)
2. **Document the expected SHA** (what should be on `main` after the push)
3. **Admin temporarily modifies the ruleset** if needed (allow direct push)
4. **Non-forced push only** — never `--force` to `main`
5. **Verify CI and mirror** after the push
6. **Re-enable protection immediately**
7. **Add a postmortem entry** to `worklog.md`

## 5. Environment: `gitlab-passive-mirror`

| Setting | Value |
|---------|-------|
| Required reviewers | None (no human approval needed for mirror) |
| Wait timer | None |
| Deployment branches | Selected: `main` only |

### Secret (1)

| Name | Description |
|------|-------------|
| `GITLAB_MIRROR_SSH_PRIVATE_KEY` | OpenSSH Ed25519 private key — authenticates GitHub Actions to GitLab for mirror push. Dedicated to this repository only. Never logged or exposed. |

### Variables (4)

| Name | Description |
|------|-------------|
| `GITLAB_REPOSITORY_SSH_URL` | `git@gitlab.com:cheurteen1/codebase-memory-V2.git` — SSH destination of the passive mirror |
| `GITLAB_KNOWN_HOSTS` | Full content of GitLab.com official host keys — enables `StrictHostKeyChecking=yes`. Not a file path, not a private key. |
| `GITLAB_MIRROR_KEY_FINGERPRINT` | `SHA256:p45GIFj/WYp6QAab9FgwbC0cgGv4EHPj94I8PKQBO5M` — expected fingerprint of the client deploy key. Protects against wrong secret, rotation mismatch, or key confusion. |
| `GITLAB_ED25519_HOST_FINGERPRINT` | `SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8` — expected fingerprint of GitLab.com's Ed25519 host key. Protects against stale known_hosts or MITM. |

**Total: 1 secret + 4 variables = 5 configuration values.**

## 6. GitLab Contract

| Rule | Status |
|------|--------|
| Branches | `main` only |
| Feature branches | None |
| Merge requests | None |
| CI pipelines | Disabled (`workflow: rules: when never`) |
| Runners | None |
| Force push | Blocked |
| Deploy key | `github-actions-passive-mirror` with write access + authorized on protected `main` |

## 7. Security Settings

### Active

| Setting | Status |
|---------|--------|
| Dependency graph | ACTIVE |
| Dependabot alerts | ACTIVE |
| Dependabot security updates | ACTIVE |
| Dependabot config (`.github/dependabot.yml`) | ACTIVE (github-actions ecosystem, weekly) |

### Recommended (not yet active)

| Setting | Status | Note |
|---------|--------|------|
| Grouped security updates | RECOMMENDED | Reduces PR noise |
| Secret scanning | RECOMMENDED | Public repo, free feature |
| Push protection | RECOMMENDED | Blocks secret leaks before push |
| CodeQL default setup | RECOMMENDED | Activate, observe, then consider as required check |

### Deferred

| Setting | Status | Note |
|---------|--------|------|
| Require code scanning in ruleset | DEFERRED | Wait for CodeQL stability first |
| Actions Policies Preview | DEFERRED | Evaluate mode only if experimented with |
| Self-hosted runners | DEFERRED | Public repo — security risk with fork PRs |
| OIDC | DEFERRED | No cloud credentials needed yet |
| Copilot code review | OFF | Not configured |

## 8. Settings Verification

### Settings → General → Pull Requests

| Setting | Expected | Observed | Verdict |
|---------|----------|----------|---------|
| Allow squash merging | ON | MANUAL VERIFICATION REQUIRED | — |
| Allow merge commits | OFF | MANUAL VERIFICATION REQUIRED | — |
| Allow rebase merging | OFF | MANUAL VERIFICATION REQUIRED | — |
| Automatically delete head branches | ON | MANUAL VERIFICATION REQUIRED | — |
| Always suggest updating PR branches | Recommended | MANUAL VERIFICATION REQUIRED | — |

### Settings → Actions → General

| Setting | Expected | Observed | Verdict |
|---------|----------|----------|---------|
| Default GITHUB_TOKEN permissions | Read-only | MANUAL VERIFICATION REQUIRED | — |
| Allow GitHub Actions to create PRs | ON (if GLM opens PRs via workflow) | MANUAL VERIFICATION REQUIRED | — |
| Fork PR workflows | Approval required | MANUAL VERIFICATION REQUIRED | — |
| Actions allowed | GitHub-owned + local | MANUAL VERIFICATION REQUIRED | — |
| Artifact/log retention | 90 days recommended | MANUAL VERIFICATION REQUIRED | — |

> **Note:** GitHub repository settings are not readable via the unauthenticated
> API. The maintainer must manually verify each setting and update this table.
> Never invent or assume a setting's state.

## 9. Verification Checklist

After any modification to GitHub repository settings:

```
[ ] Ruleset `protect-main` is Active
[ ] Target is `main`
[ ] PR required before merge
[ ] Backend (v2) + Frontend (graph-ui) are required checks
[ ] Squash-only merge
[ ] Force push blocked
[ ] Deletion blocked
[ ] Linear history required
[ ] Conversation resolution required
[ ] Environment `gitlab-passive-mirror` restricted to `main`
[ ] Secret `GITLAB_MIRROR_SSH_PRIVATE_KEY` present and non-empty
[ ] Variable `GITLAB_REPOSITORY_SSH_URL` present
[ ] Variable `GITLAB_KNOWN_HOSTS` present
[ ] Variable `GITLAB_MIRROR_KEY_FINGERPRINT` present
[ ] Variable `GITLAB_ED25519_HOST_FINGERPRINT` present
[ ] No self-hosted runners configured
[ ] Dependabot active (github-actions)
[ ] No `pull_request_target` in any workflow without audit
```

## 10. Related Documents

- [GITHUB_GITLAB_BRANCH_BRIDGE.md](GITHUB_GITLAB_BRANCH_BRIDGE.md) — Mirror architecture, postmortem, diagnostic matrix
- [CI_CONTINUITY.md](CI_CONTINUITY.md) — Operational resilience plan
- [RELEASE_POLICY.md](RELEASE_POLICY.md) — Release governance
- [MAINTAINERS_GUIDE.md](../MAINTAINERS_GUIDE.md) — Development workflow and conventions
