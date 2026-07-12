#!/usr/bin/env bash
#
# scripts/ci/mirror-main-to-gitlab.sh
#
# R168 — Mirror state machine extracted from the workflow YAML for testability.
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
#   GIT_SSH_COMMAND     — override SSH command (for fake SSH wrappers in tests)
#
# ─────────────────────────────────────────────────────────────────────────────
# Outputs (written to $OUTPUT_FILE or stdout if not set)
# ─────────────────────────────────────────────────────────────────────────────
#
#   final_result          — mirrored | already-mirrored | newer-valid-mirror-present | failed
#   observed_sha          — GitLab main SHA after operation
#   github_main_sha       — GitHub main SHA (re-read at end)
#   error_category        — HOST_KEY_MISMATCH | SSH_PUBLICKEY_REJECTED | ...
#   error_phase           — ls-remote | fetch | dry-run | push | post-read | fingerprint | host-key | none
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
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

OUTPUT_FILE="${OUTPUT_FILE:-}"

write_output() {
  local key="$1"
  local value="$2"
  if [ -n "$OUTPUT_FILE" ]; then
    # Append to file in key=value format
    printf '%s=%s\n' "$key" "$value" >> "$OUTPUT_FILE"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

init_outputs() {
  if [ -n "$OUTPUT_FILE" ]; then
    : > "$OUTPUT_FILE"
  fi
  write_output "final_result" "failed"
  write_output "observed_sha" ""
  write_output "github_main_sha" ""
  write_output "error_category" "none"
  write_output "error_phase" "none"
  write_output "client_fp_verified" "not-run"
  write_output "client_fp_actual" ""
  write_output "host_fp_verified" "not-run"
  write_output "host_fp_actual" ""
  write_output "push_attempted" "false"
  write_output "push_completed" "false"
  write_output "post_verify_result" "not-run"
}

# Classify a Git error based on its output text.
# Arguments: $1 = phase, $2 = combined stdout+stderr of the failed command
# Sets error_category and error_phase, then exits 1.
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

  write_output "error_category" "$category"
  write_output "error_phase" "$phase"
  write_output "final_result" "failed"
  echo "::error::[$category] during $phase" >&2
  echo "$output" >&2
  exit 1
}

# Run a Git command against the GitLab remote, classifying any error.
# Arguments: $1 = phase, $2... = git args
# On success, stdout is the command's stdout.
# On failure, calls classify_and_fail.
run_gitlab_git() {
  local phase="$1"
  shift
  local output
  if ! output="$(git "$@" 2>&1)"; then
    classify_and_fail "$phase" "$output"
  fi
  printf '%s' "$output"
}

# ─────────────────────────────────────────────────────────────────────────────
# Configuration validation
# ─────────────────────────────────────────────────────────────────────────────

init_outputs

if [ -z "${TARGET_SHA:-}" ]; then
  echo "::error::TARGET_SHA is not set" >&2
  write_output "error_category" "CONFIG_ERROR"
  write_output "error_phase" "validation"
  exit 2
fi

if ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::TARGET_SHA is not a valid 40-char hex SHA: $TARGET_SHA" >&2
  write_output "error_category" "CONFIG_ERROR"
  write_output "error_phase" "validation"
  exit 2
fi

if [ -z "${GITLAB_URL:-}" ]; then
  echo "::error::GITLAB_URL is not set" >&2
  write_output "error_category" "CONFIG_ERROR"
  write_output "error_phase" "validation"
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
    write_output "error_category" "CONFIG_ERROR"
    write_output "error_phase" "ssh-config"
    exit 2
  fi
  if [ -z "${KNOWN_HOSTS_FILE:-}" ]; then
    echo "::error::KNOWN_HOSTS_FILE is not set" >&2
    write_output "error_category" "CONFIG_ERROR"
    write_output "error_phase" "ssh-config"
    exit 2
  fi

  # Configure SSH with timeouts and batch mode (OPS-R168-01)
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

  # Verify the private key has no passphrase (OPS-R168-01)
  if ! ssh-keygen -y -P '' -f "$SSH_KEY_FILE" >/dev/null 2>&1; then
    echo "::error::SSH private key is passphrase-protected or invalid. Deploy keys for CI must be unencrypted." >&2
    write_output "error_category" "SSH_KEY_PASSPHRASE"
    write_output "error_phase" "ssh-config"
    exit 2
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Fingerprint verification (SEC-R168-01, SEC-R168-02, OBS-R168-02)
# ─────────────────────────────────────────────────────────────────────────────

if [ "$SKIP_FP_CHECKS" != "yes" ]; then
  # ── Client key fingerprint (SEC-R168-02: use ssh-keygen, not manual base64) ──
  echo ""
  echo "=== Verify client key fingerprint ==="

  CLIENT_FP_ACTUAL="$(ssh-keygen -y -f "$SSH_KEY_FILE" | ssh-keygen -lf - -E sha256 | awk '{print $2}')"
  write_output "client_fp_actual" "$CLIENT_FP_ACTUAL"

  echo "Expected: $EXPECTED_KEY_FP"
  echo "Actual:   $CLIENT_FP_ACTUAL"

  if [ "$CLIENT_FP_ACTUAL" != "$EXPECTED_KEY_FP" ]; then
    echo "::error::Client deploy key fingerprint mismatch." >&2
    write_output "client_fp_verified" "false"
    write_output "error_category" "CLIENT_KEY_FP_MISMATCH"
    write_output "error_phase" "fingerprint"
    write_output "final_result" "failed"
    exit 3
  fi

  write_output "client_fp_verified" "true"
  echo "✓ Client key fingerprint matches."

  # ── Host key fingerprint (SEC-R168-01: bound to gitlab.com) ──
  echo ""
  echo "=== Verify GitLab.com host key fingerprint ==="

  # Use ssh-keygen -F to extract the key for gitlab.com specifically.
  # This ensures we verify the key for the correct host, not just any
  # ed25519 entry in the file.
  HOST_KEY_OUTPUT="$(ssh-keygen -F gitlab.com -f "$KNOWN_HOSTS_FILE" 2>&1 || true)"

  if [ -z "$HOST_KEY_OUTPUT" ]; then
    echo "::error::No gitlab.com entry found in known_hosts." >&2
    write_output "host_fp_verified" "false"
    write_output "error_category" "HOST_KEY_NOT_FOUND"
    write_output "error_phase" "host-key"
    write_output "final_result" "failed"
    exit 3
  fi

  # Count ed25519 entries for gitlab.com — there must be exactly one
  ED25519_COUNT="$(echo "$HOST_KEY_OUTPUT" | grep -c 'ssh-ed25519' || true)"
  if [ "$ED25519_COUNT" -eq 0 ]; then
    echo "::error::No ssh-ed25519 entry for gitlab.com in known_hosts." >&2
    write_output "host_fp_verified" "false"
    write_output "error_category" "HOST_KEY_NO_ED25519"
    write_output "error_phase" "host-key"
    write_output "final_result" "failed"
    exit 3
  fi
  if [ "$ED25519_COUNT" -gt 1 ]; then
    echo "::error::Multiple ssh-ed25519 entries for gitlab.com in known_hosts. Expected exactly one." >&2
    write_output "host_fp_verified" "false"
    write_output "error_category" "HOST_KEY_DUPLICATE"
    write_output "error_phase" "host-key"
    write_output "final_result" "failed"
    exit 3
  fi

  # Extract the ed25519 key and compute its fingerprint using ssh-keygen
  # (SEC-R168-02: don't use URL-safe base64 — use ssh-keygen -lf)
  ED25519_KEY_B64="$(echo "$HOST_KEY_OUTPUT" | grep 'ssh-ed25519' | awk '{print $3}' | head -1)"

  # Write to a temp file in the ssh-keygen -lf format
  TMP_HOST_PUB="$(mktemp)"
  printf 'gitlab.com ssh-ed25519 %s\n' "$ED25519_KEY_B64" > "$TMP_HOST_PUB"

  HOST_FP_ACTUAL="$(ssh-keygen -lf "$TMP_HOST_PUB" -E sha256 | awk '{print $2}')"
  rm -f "$TMP_HOST_PUB"

  write_output "host_fp_actual" "$HOST_FP_ACTUAL"

  echo "Expected: $EXPECTED_HOST_FP"
  echo "Actual:   $HOST_FP_ACTUAL"

  if [ "$HOST_FP_ACTUAL" != "$EXPECTED_HOST_FP" ]; then
    echo "::error::GitLab.com host key fingerprint mismatch." >&2
    write_output "host_fp_verified" "false"
    write_output "error_category" "HOST_KEY_FP_MISMATCH"
    write_output "error_phase" "host-key"
    write_output "final_result" "failed"
    exit 3
  fi

  write_output "host_fp_verified" "true"
  echo "✓ Host key fingerprint matches."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Verify local checkout is at TARGET_SHA
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Verify checkout ==="

LOCAL_SHA="$(git rev-parse HEAD)"
if [ "$LOCAL_SHA" != "$TARGET_SHA" ]; then
  echo "::error::Checkout mismatch. Expected: $TARGET_SHA, Got: $LOCAL_SHA" >&2
  write_output "error_category" "CHECKOUT_MISMATCH"
  write_output "error_phase" "checkout"
  write_output "final_result" "failed"
  exit 1
fi

git cat-file -e "${TARGET_SHA}^{commit}"
git cat-file -e "${TARGET_SHA}^{tree}"
echo "✓ Checkout at TARGET_SHA, objects verified."

# ─────────────────────────────────────────────────────────────────────────────
# Read GitHub main (re-read at end for truthfulness — MIRROR-R168-01)
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Read GitHub main ==="

git fetch --no-tags "$GITHUB_REMOTE" main:refs/remotes/github/main 2>/dev/null || \
  git fetch --no-tags origin main:refs/remotes/github/main 2>/dev/null || true

CURRENT_GITHUB_MAIN="$(git rev-parse refs/remotes/github/main 2>/dev/null || echo "")"
if [ -z "$CURRENT_GITHUB_MAIN" ]; then
  # Try origin/main fallback
  CURRENT_GITHUB_MAIN="$(git rev-parse refs/remotes/origin/main 2>/dev/null || echo "")"
fi

if [ -z "$CURRENT_GITHUB_MAIN" ]; then
  echo "::error::Could not determine GitHub main SHA." >&2
  write_output "error_category" "GITHUB_MAIN_UNREADABLE"
  write_output "error_phase" "github-read"
  write_output "final_result" "failed"
  exit 1
fi

echo "GitHub main: $CURRENT_GITHUB_MAIN"

# Verify TARGET_SHA is still in GitHub main history (no rollback)
if ! git merge-base --is-ancestor "$TARGET_SHA" "$CURRENT_GITHUB_MAIN" 2>/dev/null; then
  echo "::error::Validated SHA is no longer in GitHub main history." >&2
  write_output "error_category" "TARGET_SHA_NOT_ANCESTOR"
  write_output "error_phase" "github-read"
  write_output "final_result" "failed"
  exit 1
fi
echo "✓ TARGET_SHA is ancestor of GitHub main."

# ─────────────────────────────────────────────────────────────────────────────
# Add GitLab remote + read GitLab main (DIAG-R168-01: classify all ops)
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Read GitLab main ==="

# Remove existing gitlab remote if present (idempotent)
git remote remove gitlab 2>/dev/null || true
git remote add gitlab "$GITLAB_URL"

# Read GitLab main — classify errors (DIAG-R168-01)
REMOTE_SHA_OUTPUT="$(run_gitlab_git "ls-remote" ls-remote gitlab refs/heads/main)"
REMOTE_SHA="$(echo "$REMOTE_SHA_OUTPUT" | awk '{print $1}')"
REMOTE_SHA="${REMOTE_SHA:-}"

echo "GitLab main: ${REMOTE_SHA:-<empty>}"

# If GitLab has content, fetch it and check divergence
if [ -n "$REMOTE_SHA" ]; then
  run_gitlab_git "fetch" fetch --no-tags gitlab main:refs/remotes/gitlab/main

  # DIVERGENCE CHECK: GitLab main must be ancestor of GitHub main
  if ! git merge-base --is-ancestor "$REMOTE_SHA" "$CURRENT_GITHUB_MAIN" 2>/dev/null; then
    echo "::error::DIVERGENCE: GitLab main contains history absent from GitHub main." >&2
    echo "GitLab main: $REMOTE_SHA" >&2
    echo "GitHub main: $CURRENT_GITHUB_MAIN" >&2
    write_output "error_category" "DIVERGENCE"
    write_output "error_phase" "divergence-check"
    write_output "final_result" "failed"
    write_output "observed_sha" "$REMOTE_SHA"
    exit 1
  fi
  echo "✓ No divergence."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Classify mirror state and execute
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Classify mirror state ==="

# Case 1: GitLab already at TARGET_SHA
if [ "$REMOTE_SHA" = "$TARGET_SHA" ]; then
  echo "GitLab already at TARGET_SHA."
  # MIRROR-R168-01: DO NOT skip re-verification. Fall through to post-verify.
  write_output "push_attempted" "false"
  # Set provisional result — will be confirmed by post-verify
  PROVISIONAL_RESULT="already-mirrored"
elif [ -n "$REMOTE_SHA" ] && git merge-base --is-ancestor "$TARGET_SHA" "$REMOTE_SHA" 2>/dev/null; then
  # Case 2: GitLab already ahead (newer valid mirror)
  echo "GitLab already ahead of TARGET_SHA (newer valid mirror)."
  write_output "push_attempted" "false"
  PROVISIONAL_RESULT="newer-valid-mirror-present"
elif [ -z "$REMOTE_SHA" ] || git merge-base --is-ancestor "$REMOTE_SHA" "$TARGET_SHA" 2>/dev/null; then
  # Case 3: Fast-forward eligible (empty GitLab, or GitLab is ancestor)
  echo "Fast-forward eligible. Attempting push."

  # Dry-run (does NOT exercise pre-receive hook — documented limitation)
  run_gitlab_git "dry-run" push --dry-run -o ci.no_pipeline gitlab "$TARGET_SHA:refs/heads/main"
  echo "✓ Dry-run accepted."

  # Real push (DIAG-R168-01: classified)
  write_output "push_attempted" "true"
  run_gitlab_git "push" push -o ci.no_pipeline gitlab "$TARGET_SHA:refs/heads/main"
  write_output "push_completed" "true"
  echo "✓ Push completed."
  PROVISIONAL_RESULT="mirrored"
else
  # Case 4: non-linear (should be caught by divergence check, but defend in depth)
  echo "::error::Non-linear mirror state." >&2
  write_output "error_category" "NON_LINEAR"
  write_output "error_phase" "classify"
  write_output "final_result" "failed"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Post-push verification — ALWAYS runs, even for no-op paths (MIRROR-R168-01)
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Post-push verification (always runs) ==="

# Re-read GitLab main (always, even for no-op)
POST_REMOTE_OUTPUT="$(run_gitlab_git "post-read" ls-remote gitlab refs/heads/main)"
OBSERVED_SHA="$(echo "$POST_REMOTE_OUTPUT" | awk '{print $1}')"
OBSERVED_SHA="${OBSERVED_SHA:-}"

write_output "observed_sha" "$OBSERVED_SHA"
echo "Observed GitLab main: $OBSERVED_SHA"

# Re-read GitHub main (MIRROR-R168-01: don't use stale SHA)
POST_GITHUB_OUTPUT="$(git ls-remote "$GITHUB_REMOTE" refs/heads/main 2>/dev/null || git ls-remote origin refs/heads/main 2>/dev/null || echo "")"
POST_GITHUB_MAIN="$(echo "$POST_GITHUB_OUTPUT" | awk '{print $1}')"
write_output "github_main_sha" "$POST_GITHUB_MAIN"
echo "Re-read GitHub main: $POST_GITHUB_MAIN"

# Determine final result (OBS-R168-01: truthful outcome based on ALL evidence)
if [ -z "$OBSERVED_SHA" ]; then
  echo "::error::Post-verification: GitLab main is empty after operation." >&2
  write_output "post_verify_result" "failure"
  write_output "final_result" "failed"
  write_output "error_category" "POST_VERIFY_EMPTY"
  write_output "error_phase" "post-read"
  exit 1
fi

# Case A: GitLab is exactly at TARGET_SHA
if [ "$OBSERVED_SHA" = "$TARGET_SHA" ]; then
  echo "✓ GitLab main matches TARGET_SHA."
  write_output "post_verify_result" "success"
  write_output "final_result" "$PROVISIONAL_RESULT"
  exit 0
fi

# Case B: GitLab is a descendant of TARGET_SHA (race: newer mirror won)
if git merge-base --is-ancestor "$TARGET_SHA" "$OBSERVED_SHA" 2>/dev/null; then
  # Verify the observed SHA is still in GitHub main history
  if [ -n "$POST_GITHUB_MAIN" ] && git merge-base --is-ancestor "$OBSERVED_SHA" "$POST_GITHUB_MAIN" 2>/dev/null; then
    echo "✓ A newer validated mirror won the race. GitLab is ahead of TARGET_SHA but still in GitHub main history."
    write_output "post_verify_result" "success"
    write_output "final_result" "newer-valid-mirror-present"
    exit 0
  else
    echo "::error::GitLab is ahead of TARGET_SHA but the observed SHA is NOT in GitHub main history." >&2
    write_output "post_verify_result" "failure"
    write_output "final_result" "failed"
    write_output "error_category" "POST_VERIFY_DESCENDANT_NOT_IN_GITHUB"
    write_output "error_phase" "post-read"
    exit 1
  fi
fi

# Case C: GitLab is NOT at TARGET_SHA and NOT a descendant — failure
echo "::error::Post-push verification failed." >&2
echo "Expected TARGET_SHA or validated descendant: $TARGET_SHA" >&2
echo "Observed GitLab main:                       $OBSERVED_SHA" >&2
write_output "post_verify_result" "failure"
write_output "final_result" "failed"
write_output "error_category" "POST_VERIFY_MISMATCH"
write_output "error_phase" "post-read"
exit 1
