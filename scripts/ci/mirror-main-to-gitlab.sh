#!/usr/bin/env bash
#
# scripts/ci/mirror-main-to-gitlab.sh
#
# R168 — Mirror state machine extracted from the workflow YAML for testability.
# R168.1 — Operational Closure:
#   - MIRROR-R168.1-01: GitHub reads fail-closed (no || true), fresh POST_GITHUB_MAIN required
#   - OBS-R168.1-01: outputs emitted exactly once via trap (in-memory state, no last-write-wins)
#   - DIAG-R168.1-01: GitHub reads + local object errors classified
#   - TEST-R168.1-01: test-only hooks for real race condition tests
#
# Called by .github/workflows/mirror-main-to-gitlab.yml (production).
# Tested by v2/tests/ci/r168-mirror-runtime.test.ts (bare repo tests).
#
# ─────────────────────────────────────────────────────────────────────────────
# Parameters (environment variables)
# ─────────────────────────────────────────────────────────────────────────────
#
# Required for production:
#   TARGET_SHA          — the CI-validated GitHub SHA to mirror (40 hex chars)
#   GITLAB_URL          — git@gitlab.com:... SSH URL
#   GITHUB_REMOTE       — origin (or the URL of the GitHub remote)
#   EXPECTED_KEY_FP     — SHA256:... client deploy key fingerprint
#   EXPECTED_HOST_FP    — SHA256:... GitLab.com host key fingerprint
#   SSH_KEY_FILE        — path to materialized private key
#   KNOWN_HOSTS_FILE    — path to materialized known_hosts file
#
# Required for tests (bare repos):
#   TARGET_SHA          — the SHA to mirror
#   GITLAB_URL          — file:///tmp/test-gitlab.git
#   GITHUB_REMOTE       — file:///tmp/test-github.git
#
# Optional (for tests):
#   SKIP_SSH_CONFIG     — "yes" to skip SSH config (bare repo tests)
#   SKIP_FP_CHECKS      — "yes" to skip fingerprint verification (bare repo tests)
#   CBM_MIRROR_TEST_MODE — "1" to enable test-only hooks (race injection)
#                          Only active when GITLAB_URL starts with file:// and
#                          GITHUB_ACTIONS is not "true"
#
# ─────────────────────────────────────────────────────────────────────────────
# Outputs (written to $OUTPUT_FILE — each key exactly once, OBS-R168.1-01)
# ─────────────────────────────────────────────────────────────────────────────
#
#   final_result          — mirrored | already-mirrored | newer-valid-mirror-present | failed
#   observed_sha          — GitLab main SHA after operation
#   github_main_sha       — GitHub main SHA (re-read at end, must be non-empty)
#   error_category        — HOST_KEY_MISMATCH | SSH_PUBLICKEY_REJECTED | ... | none
#   error_phase           — ls-remote | fetch | dry-run | push | post-read | fingerprint | host-key | github-read | github-post-read | none
#   client_fp_verified    — true | false | not-run
#   client_fp_actual      — actual fingerprint (or empty)
#   host_fp_verified      — true | false | not-run
#   host_fp_actual        — actual fingerprint (or empty)
#   push_attempted        — true | false
#   push_completed        — true | false
#   post_verify_result    — success | failure | not-run
#
# Exit codes:
#   0 — mirror succeeded (result = mirrored | already-mirrored | newer-valid-mirror-present)
#   1 — mirror failed (error_category and error_phase are set)
#   2 — configuration error (missing required env vars)
#   3 — fingerprint mismatch
#

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# In-memory state (OBS-R168.1-01: no more last-write-wins on OUTPUT_FILE)
# ─────────────────────────────────────────────────────────────────────────────

STATE_FINAL_RESULT="failed"
STATE_OBSERVED_SHA=""
STATE_GITHUB_MAIN_SHA=""
STATE_ERROR_CATEGORY="none"
STATE_ERROR_PHASE="none"
STATE_CLIENT_FP_VERIFIED="not-run"
STATE_CLIENT_FP_ACTUAL=""
STATE_HOST_FP_VERIFIED="not-run"
STATE_HOST_FP_ACTUAL=""
STATE_PUSH_ATTEMPTED="false"
STATE_PUSH_COMPLETED="false"
STATE_POST_VERIFY_RESULT="not-run"

OUTPUT_FILE="${OUTPUT_FILE:-}"

# ─────────────────────────────────────────────────────────────────────────────
# Trap: emit outputs exactly once on exit (OBS-R168.1-01)
# ─────────────────────────────────────────────────────────────────────────────

emit_final_outputs() {
  local exit_code=$?
  if [ -n "$OUTPUT_FILE" ]; then
    : > "$OUTPUT_FILE"
    printf '%s=%s\n' "final_result"        "$STATE_FINAL_RESULT"        >> "$OUTPUT_FILE"
    printf '%s=%s\n' "observed_sha"        "$STATE_OBSERVED_SHA"        >> "$OUTPUT_FILE"
    printf '%s=%s\n' "github_main_sha"     "$STATE_GITHUB_MAIN_SHA"     >> "$OUTPUT_FILE"
    printf '%s=%s\n' "error_category"      "$STATE_ERROR_CATEGORY"      >> "$OUTPUT_FILE"
    printf '%s=%s\n' "error_phase"         "$STATE_ERROR_PHASE"         >> "$OUTPUT_FILE"
    printf '%s=%s\n' "client_fp_verified"  "$STATE_CLIENT_FP_VERIFIED"  >> "$OUTPUT_FILE"
    printf '%s=%s\n' "client_fp_actual"    "$STATE_CLIENT_FP_ACTUAL"    >> "$OUTPUT_FILE"
    printf '%s=%s\n' "host_fp_verified"    "$STATE_HOST_FP_VERIFIED"    >> "$OUTPUT_FILE"
    printf '%s=%s\n' "host_fp_actual"      "$STATE_HOST_FP_ACTUAL"      >> "$OUTPUT_FILE"
    printf '%s=%s\n' "push_attempted"      "$STATE_PUSH_ATTEMPTED"      >> "$OUTPUT_FILE"
    printf '%s=%s\n' "push_completed"      "$STATE_PUSH_COMPLETED"      >> "$OUTPUT_FILE"
    printf '%s=%s\n' "post_verify_result"  "$STATE_POST_VERIFY_RESULT"  >> "$OUTPUT_FILE"
  fi
  exit "$exit_code"
}

trap emit_final_outputs EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

# Classify a Git error based on its output text.
# Arguments: $1 = phase, $2 = combined stdout+stderr of the failed command
# Sets STATE_ERROR_CATEGORY and STATE_ERROR_PHASE, then exits 1.
classify_and_fail() {
  local phase="$1"
  local output="$2"
  local category="UNKNOWN_GIT_ERROR"

  case "$output" in
    *"Host key verification failed"*|*"REMOTE HOST IDENTIFICATION HAS CHANGED"*)
      category="HOST_KEY_MISMATCH" ;;
    *"Permission denied (publickey)"*|*"Permission denied"*)
      category="SSH_PUBLICKEY_REJECTED" ;;
    *"not allowed to push code to protected branches"*|*"not allowed to push"*|*"protected branch"*)
      category="PROTECTED_BRANCH_REJECTED" ;;
    *"non-fast-forward"*|*"! [rejected]"*|*"fetch first"*)
      category="NON_FAST_FORWARD" ;;
    *"Could not resolve hostname"*|*"Name or service not known"*)
      category="REMOTE_DNS_FAILURE" ;;
    *"Connection timed out"*|*"timed out"*)
      category="REMOTE_TIMEOUT" ;;
    *"Connection refused"*)
      category="REMOTE_CONNECTION_REFUSED" ;;
    *"Could not read from remote repository"*|*"Connection reset"*|*"No route to host"*)
      category="REMOTE_UNREACHABLE" ;;
    *"Repository not found"*|*"not found"*)
      category="REPOSITORY_NOT_FOUND" ;;
    *"pre-receive hook declined"*|*"remote rejected"*)
      category="PRE_RECEIVE_REJECTED" ;;
    *)
      category="UNKNOWN_GIT_ERROR" ;;
  esac

  STATE_ERROR_CATEGORY="$category"
  STATE_ERROR_PHASE="$phase"
  STATE_FINAL_RESULT="failed"
  echo "::error::[$category] during $phase" >&2
  echo "$output" >&2
  exit 1
}

# Run a Git command against the GitLab remote, classifying any error.
# Arguments: $1 = phase, $2... = git args
run_gitlab_git() {
  local phase="$1"
  shift
  local output
  if ! output="$(git "$@" 2>&1)"; then
    classify_and_fail "$phase" "$output"
  fi
  printf '%s' "$output"
}

# Run a Git command against the GitHub remote, classifying any error.
# MIRROR-R168.1-01: NO || true fallback — fail closed if GitHub is unreachable.
# Arguments: $1 = phase, $2... = git args
run_github_git() {
  local phase="$1"
  shift
  local output
  if ! output="$(git "$@" 2>&1)"; then
    # Classify GitHub-specific errors
    local category="GITHUB_REMOTE_UNREACHABLE"
    case "$output" in
      *"Could not resolve hostname"*|*"Name or service not known"*)
        category="GITHUB_DNS_FAILURE" ;;
      *"Permission denied"*|*"Authentication failed"*)
        category="GITHUB_AUTH_FAILURE" ;;
      *"Connection timed out"*|*"timed out"*)
        category="GITHUB_REMOTE_UNREACHABLE" ;;
      *"Could not read from remote"*|*"Connection refused"*|*"Connection reset"*)
        category="GITHUB_REMOTE_UNREACHABLE" ;;
      *"Remote branch"*"not found"*|*"refs/heads/main"*"not found"*)
        category="GITHUB_REF_MISSING" ;;
    esac
    STATE_ERROR_CATEGORY="$category"
    STATE_ERROR_PHASE="$phase"
    STATE_FINAL_RESULT="failed"
    echo "::error::[$category] during $phase" >&2
    echo "$output" >&2
    exit 1
  fi
  printf '%s' "$output"
}

# Run a local Git command, classifying object/ref errors.
# Arguments: $1 = phase, $2... = git args
run_local_git() {
  local phase="$1"
  shift
  local output
  if ! output="$(git "$@" 2>&1)"; then
    local category="LOCAL_GIT_ERROR"
    case "$output" in
      *"Not a valid object name"*|*"bad object"*)
        category="LOCAL_OBJECT_MISSING" ;;
      *"unknown revision"*|*"not a valid ref"*)
        category="LOCAL_REF_MISSING" ;;
      *"fatal: not a git repository"*)
        category="LOCAL_NOT_A_REPO" ;;
    esac
    STATE_ERROR_CATEGORY="$category"
    STATE_ERROR_PHASE="$phase"
    STATE_FINAL_RESULT="failed"
    echo "::error::[$category] during $phase" >&2
    echo "$output" >&2
    exit 1
  fi
  printf '%s' "$output"
}

# ─────────────────────────────────────────────────────────────────────────────
# Test-only hooks (TEST-R168.1-01)
# These allow race condition tests to mutate state at specific points.
# They are ONLY active when:
#   CBM_MIRROR_TEST_MODE=1
#   GITHUB_ACTIONS != "true"
#   GITLAB_URL starts with file://
# ─────────────────────────────────────────────────────────────────────────────

test_hook() {
  local hook_name="$1"
  if [ "${CBM_MIRROR_TEST_MODE:-}" = "1" ] \
     && [ "${GITHUB_ACTIONS:-}" != "true" ] \
     && [[ "${GITLAB_URL:-}" == file://* ]]; then
    # Call the hook if it exists as an env var (command string)
    local hook_cmd
    eval "hook_cmd=\${${hook_name}:-}"
    if [ -n "$hook_cmd" ]; then
      echo "[test-hook] $hook_name: $hook_cmd" >&2
      eval "$hook_cmd" || true
    fi
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Configuration validation
# ─────────────────────────────────────────────────────────────────────────────

if [ -z "${TARGET_SHA:-}" ]; then
  echo "::error::TARGET_SHA is not set" >&2
  STATE_ERROR_CATEGORY="CONFIG_ERROR"
  STATE_ERROR_PHASE="validation"
  exit 2
fi

if ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::TARGET_SHA is not a valid 40-char hex SHA: $TARGET_SHA" >&2
  STATE_ERROR_CATEGORY="CONFIG_ERROR"
  STATE_ERROR_PHASE="validation"
  exit 2
fi

if [ -z "${GITLAB_URL:-}" ]; then
  echo "::error::GITLAB_URL is not set" >&2
  STATE_ERROR_CATEGORY="CONFIG_ERROR"
  STATE_ERROR_PHASE="validation"
  exit 2
fi

if [ -z "${GITHUB_REMOTE:-}" ]; then
  GITHUB_REMOTE="origin"
fi

SKIP_SSH_CONFIG="${SKIP_SSH_CONFIG:-no}"
SKIP_FP_CHECKS="${SKIP_FP_CHECKS:-no}"

echo "Target SHA:       $TARGET_SHA"
echo "GitLab URL:       $GITLAB_URL"
echo "GitHub remote:    $GITHUB_REMOTE"
echo "Skip SSH config:  $SKIP_SSH_CONFIG"
echo "Skip FP checks:   $SKIP_FP_CHECKS"

# ─────────────────────────────────────────────────────────────────────────────
# SSH configuration (production only)
# ─────────────────────────────────────────────────────────────────────────────

if [ "$SKIP_SSH_CONFIG" != "yes" ]; then
  if [ -z "${SSH_KEY_FILE:-}" ]; then
    echo "::error::SSH_KEY_FILE is not set" >&2
    STATE_ERROR_CATEGORY="CONFIG_ERROR"
    STATE_ERROR_PHASE="ssh-config"
    exit 2
  fi
  if [ -z "${KNOWN_HOSTS_FILE:-}" ]; then
    echo "::error::KNOWN_HOSTS_FILE is not set" >&2
    STATE_ERROR_CATEGORY="CONFIG_ERROR"
    STATE_ERROR_PHASE="ssh-config"
    exit 2
  fi

  export GIT_SSH_COMMAND="/usr/bin/ssh \
    -i $SSH_KEY_FILE \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=$KNOWN_HOSTS_FILE \
    -o BatchMode=yes \
    -o ConnectTimeout=15 \
    -o ConnectionAttempts=2 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=2"
  export GIT_SSH_VARIANT=ssh

  if ! ssh-keygen -y -P '' -f "$SSH_KEY_FILE" >/dev/null 2>&1; then
    echo "::error::SSH private key is passphrase-protected or invalid." >&2
    STATE_ERROR_CATEGORY="SSH_KEY_PASSPHRASE"
    STATE_ERROR_PHASE="ssh-config"
    exit 2
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Fingerprint verification (SEC-R168-01, SEC-R168-02, OBS-R168-02)
# ─────────────────────────────────────────────────────────────────────────────

if [ "$SKIP_FP_CHECKS" != "yes" ]; then
  echo ""
  echo "=== Verify client key fingerprint ==="

  STATE_CLIENT_FP_ACTUAL="$(ssh-keygen -y -f "$SSH_KEY_FILE" | ssh-keygen -lf - -E sha256 | awk '{print $2}')"

  echo "Expected: $EXPECTED_KEY_FP"
  echo "Actual:   $STATE_CLIENT_FP_ACTUAL"

  if [ "$STATE_CLIENT_FP_ACTUAL" != "$EXPECTED_KEY_FP" ]; then
    echo "::error::Client deploy key fingerprint mismatch." >&2
    STATE_CLIENT_FP_VERIFIED="false"
    STATE_ERROR_CATEGORY="CLIENT_KEY_FP_MISMATCH"
    STATE_ERROR_PHASE="fingerprint"
    exit 3
  fi

  STATE_CLIENT_FP_VERIFIED="true"
  echo "✓ Client key fingerprint matches."

  echo ""
  echo "=== Verify GitLab.com host key fingerprint ==="

  HOST_KEY_OUTPUT="$(ssh-keygen -F gitlab.com -f "$KNOWN_HOSTS_FILE" 2>&1 || true)"

  if [ -z "$HOST_KEY_OUTPUT" ]; then
    echo "::error::No gitlab.com entry found in known_hosts." >&2
    STATE_HOST_FP_VERIFIED="false"
    STATE_ERROR_CATEGORY="HOST_KEY_NOT_FOUND"
    STATE_ERROR_PHASE="host-key"
    exit 3
  fi

  ED25519_COUNT="$(echo "$HOST_KEY_OUTPUT" | grep -c 'ssh-ed25519' || true)"
  if [ "$ED25519_COUNT" -eq 0 ]; then
    echo "::error::No ssh-ed25519 entry for gitlab.com." >&2
    STATE_HOST_FP_VERIFIED="false"
    STATE_ERROR_CATEGORY="HOST_KEY_NO_ED25519"
    STATE_ERROR_PHASE="host-key"
    exit 3
  fi
  if [ "$ED25519_COUNT" -gt 1 ]; then
    echo "::error::Multiple ssh-ed25519 entries for gitlab.com." >&2
    STATE_HOST_FP_VERIFIED="false"
    STATE_ERROR_CATEGORY="HOST_KEY_DUPLICATE"
    STATE_ERROR_PHASE="host-key"
    exit 3
  fi

  ED25519_KEY_B64="$(echo "$HOST_KEY_OUTPUT" | grep 'ssh-ed25519' | awk '{print $3}' | head -1)"
  TMP_HOST_PUB="$(mktemp)"
  printf 'gitlab.com ssh-ed25519 %s\n' "$ED25519_KEY_B64" > "$TMP_HOST_PUB"
  STATE_HOST_FP_ACTUAL="$(ssh-keygen -lf "$TMP_HOST_PUB" -E sha256 | awk '{print $2}')"
  rm -f "$TMP_HOST_PUB"

  echo "Expected: $EXPECTED_HOST_FP"
  echo "Actual:   $STATE_HOST_FP_ACTUAL"

  if [ "$STATE_HOST_FP_ACTUAL" != "$EXPECTED_HOST_FP" ]; then
    echo "::error::GitLab.com host key fingerprint mismatch." >&2
    STATE_HOST_FP_VERIFIED="false"
    STATE_ERROR_CATEGORY="HOST_KEY_FP_MISMATCH"
    STATE_ERROR_PHASE="host-key"
    exit 3
  fi

  STATE_HOST_FP_VERIFIED="true"
  echo "✓ Host key fingerprint matches."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Verify local checkout is at TARGET_SHA (DIAG-R168.1-01: classify local errors)
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Verify checkout ==="

LOCAL_SHA="$(run_local_git "checkout" rev-parse HEAD)"
if [ "$LOCAL_SHA" != "$TARGET_SHA" ]; then
  echo "::error::Checkout mismatch. Expected: $TARGET_SHA, Got: $LOCAL_SHA" >&2
  STATE_ERROR_CATEGORY="CHECKOUT_MISMATCH"
  STATE_ERROR_PHASE="checkout"
  exit 1
fi

run_local_git "checkout" cat-file -e "${TARGET_SHA}^{commit}"
run_local_git "checkout" cat-file -e "${TARGET_SHA}^{tree}"
echo "✓ Checkout at TARGET_SHA, objects verified."

# ─────────────────────────────────────────────────────────────────────────────
# Read GitHub main (MIRROR-R168.1-01: fail-closed, no || true)
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Read GitHub main (fail-closed) ==="

run_github_git "github-read" fetch --no-tags "$GITHUB_REMOTE" main:refs/remotes/github/main

CURRENT_GITHUB_MAIN="$(run_local_git "github-read" rev-parse refs/remotes/github/main)"
echo "GitHub main: $CURRENT_GITHUB_MAIN"

if ! run_local_git "github-read" merge-base --is-ancestor "$TARGET_SHA" "$CURRENT_GITHUB_MAIN" 2>/dev/null; then
  echo "::error::TARGET_SHA is not an ancestor of GitHub main." >&2
  STATE_ERROR_CATEGORY="TARGET_SHA_NOT_ANCESTOR"
  STATE_ERROR_PHASE="github-read"
  exit 1
fi
echo "✓ TARGET_SHA is ancestor of GitHub main."

# ─────────────────────────────────────────────────────────────────────────────
# Add GitLab remote + read GitLab main
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Read GitLab main ==="

git remote remove gitlab 2>/dev/null || true
git remote add gitlab "$GITLAB_URL"

REMOTE_SHA_OUTPUT="$(run_gitlab_git "ls-remote" ls-remote gitlab refs/heads/main)"
REMOTE_SHA="$(echo "$REMOTE_SHA_OUTPUT" | awk '{print $1}')"
REMOTE_SHA="${REMOTE_SHA:-}"

echo "GitLab main: ${REMOTE_SHA:-<empty>}"

if [ -n "$REMOTE_SHA" ]; then
  run_gitlab_git "fetch" fetch --no-tags gitlab main:refs/remotes/gitlab/main

  # DIVERGENCE CHECK: GitLab main must be ancestor of GitHub main.
  # merge-base --is-ancestor returns exit 1 when NOT an ancestor — this is
  # a normal result, not an error. Only treat it as divergence when it
  # explicitly returns non-ancestor (exit 1).
  if ! git merge-base --is-ancestor "$REMOTE_SHA" "$CURRENT_GITHUB_MAIN" 2>/dev/null; then
    echo "::error::DIVERGENCE: GitLab main has history absent from GitHub main." >&2
    echo "GitLab main: $REMOTE_SHA" >&2
    echo "GitHub main: $CURRENT_GITHUB_MAIN" >&2
    STATE_ERROR_CATEGORY="DIVERGENCE"
    STATE_ERROR_PHASE="divergence-check"
    STATE_OBSERVED_SHA="$REMOTE_SHA"
    exit 1
  fi
  echo "✓ No divergence."
fi

# Test hook: race after initial read (TEST-R168.1-01)
test_hook "MIRROR_TEST_AFTER_INITIAL_READ"

# ─────────────────────────────────────────────────────────────────────────────
# Classify mirror state and execute
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Classify mirror state ==="

PROVISIONAL_RESULT=""

if [ "$REMOTE_SHA" = "$TARGET_SHA" ]; then
  echo "GitLab already at TARGET_SHA."
  STATE_PUSH_ATTEMPTED="false"
  PROVISIONAL_RESULT="already-mirrored"
elif [ -n "$REMOTE_SHA" ] && git merge-base --is-ancestor "$TARGET_SHA" "$REMOTE_SHA" 2>/dev/null; then
  echo "GitLab already ahead (newer valid mirror)."
  STATE_PUSH_ATTEMPTED="false"
  PROVISIONAL_RESULT="newer-valid-mirror-present"
elif [ -z "$REMOTE_SHA" ] || git merge-base --is-ancestor "$REMOTE_SHA" "$TARGET_SHA" 2>/dev/null; then
  echo "Fast-forward eligible."

  run_gitlab_git "dry-run" push --dry-run -o ci.no_pipeline gitlab "$TARGET_SHA:refs/heads/main"
  echo "✓ Dry-run accepted."

  STATE_PUSH_ATTEMPTED="true"
  run_gitlab_git "push" push -o ci.no_pipeline gitlab "$TARGET_SHA:refs/heads/main"
  STATE_PUSH_COMPLETED="true"
  echo "✓ Push completed."
  PROVISIONAL_RESULT="mirrored"

  # Test hook: race after push (TEST-R168.1-01)
  test_hook "MIRROR_TEST_AFTER_PUSH"
else
  echo "::error::Non-linear mirror state." >&2
  STATE_ERROR_CATEGORY="NON_LINEAR"
  STATE_ERROR_PHASE="classify"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Post-push verification — ALWAYS runs (MIRROR-R168-01)
# MIRROR-R168.1-01: re-read BOTH GitLab AND GitHub, require non-empty + ancestry
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Post-push verification (always runs, both remotes re-read) ==="

# Test hook: race before final read (TEST-R168.1-01)
test_hook "MIRROR_TEST_BEFORE_FINAL_READ"

# Re-read GitLab main
POST_REMOTE_OUTPUT="$(run_gitlab_git "post-read" ls-remote gitlab refs/heads/main)"
STATE_OBSERVED_SHA="$(echo "$POST_REMOTE_OUTPUT" | awk '{print $1}')"
echo "Observed GitLab main: $STATE_OBSERVED_SHA"

# Re-read GitHub main — MUST be non-empty (MIRROR-R168.1-01)
POST_GITHUB_OUTPUT="$(run_github_git "github-post-read" ls-remote "$GITHUB_REMOTE" refs/heads/main)"
STATE_GITHUB_MAIN_SHA="$(echo "$POST_GITHUB_OUTPUT" | awk '{print $1}')"

if [ -z "$STATE_GITHUB_MAIN_SHA" ]; then
  echo "::error::Post-verification: GitHub main SHA is empty. Cannot verify ancestry." >&2
  STATE_POST_VERIFY_RESULT="failure"
  STATE_ERROR_CATEGORY="GITHUB_MAIN_EMPTY_POST_READ"
  STATE_ERROR_PHASE="github-post-read"
  exit 1
fi
echo "Re-read GitHub main: $STATE_GITHUB_MAIN_SHA"

# Verify GitLab observed SHA
if [ -z "$STATE_OBSERVED_SHA" ]; then
  echo "::error::Post-verification: GitLab main is empty." >&2
  STATE_POST_VERIFY_RESULT="failure"
  STATE_ERROR_CATEGORY="POST_VERIFY_EMPTY"
  STATE_ERROR_PHASE="post-read"
  exit 1
fi

# Case A: GitLab is exactly at TARGET_SHA
if [ "$STATE_OBSERVED_SHA" = "$TARGET_SHA" ]; then
  # MIRROR-R168.1-01: even in this case, verify TARGET_SHA is ancestor of fresh GitHub main
  if ! run_local_git "post-read" merge-base --is-ancestor "$TARGET_SHA" "$STATE_GITHUB_MAIN_SHA" 2>/dev/null; then
    echo "::error::TARGET_SHA is no longer an ancestor of fresh GitHub main." >&2
    STATE_POST_VERIFY_RESULT="failure"
    STATE_ERROR_CATEGORY="TARGET_SHA_NOT_IN_FRESH_GITHUB"
    STATE_ERROR_PHASE="post-read"
    exit 1
  fi
  echo "✓ GitLab main matches TARGET_SHA, and TARGET_SHA is in fresh GitHub main."
  STATE_POST_VERIFY_RESULT="success"
  STATE_FINAL_RESULT="$PROVISIONAL_RESULT"
  exit 0
fi

# Case B: GitLab is a descendant of TARGET_SHA (race: newer mirror won)
if run_local_git "post-read" merge-base --is-ancestor "$TARGET_SHA" "$STATE_OBSERVED_SHA" 2>/dev/null; then
  if run_local_git "post-read" merge-base --is-ancestor "$STATE_OBSERVED_SHA" "$STATE_GITHUB_MAIN_SHA" 2>/dev/null; then
    echo "✓ Newer validated mirror won the race."
    STATE_POST_VERIFY_RESULT="success"
    STATE_FINAL_RESULT="newer-valid-mirror-present"
    exit 0
  else
    echo "::error::GitLab is ahead of TARGET_SHA but not in fresh GitHub main." >&2
    STATE_POST_VERIFY_RESULT="failure"
    STATE_ERROR_CATEGORY="POST_VERIFY_DESCENDANT_NOT_IN_GITHUB"
    STATE_ERROR_PHASE="post-read"
    exit 1
  fi
fi

# Case C: failure
echo "::error::Post-push verification failed." >&2
STATE_POST_VERIFY_RESULT="failure"
STATE_ERROR_CATEGORY="POST_VERIFY_MISMATCH"
STATE_ERROR_PHASE="post-read"
exit 1
