#!/usr/bin/env bash
#
# scripts/ci/verify-github-commit-signature.sh
#
# SIG-R169: Cross-host Signature Trust Gate
#
# Verifies that GitHub has cryptographically verified the commit at TARGET_SHA
# before the mirror workflow materializes the GitLab SSH key or attempts any
# push to GitLab.
#
# Uses the GitHub REST API with the workflow's GITHUB_TOKEN (no new secrets).
# Fails closed on any error — no fallback to unsigned acceptance.
#
# Trust boundary:
#   GitHub API: commit.verification.verified == true
#   GitHub API: commit.verification.reason == "valid"
#   GitHub API: commit.verification.verified_at non-empty
#   GitHub API: response.sha == TARGET_SHA
#   GitLab main SHA == TARGET_SHA (after mirror, checked by mirror script)
#
# ─────────────────────────────────────────────────────────────────────────────
# Parameters (environment variables)
# ─────────────────────────────────────────────────────────────────────────────
#
# Required:
#   TARGET_SHA          — 40-char hex SHA to verify
#   GITHUB_API_URL      — https://api.github.com (or local test server)
#   GITHUB_REPOSITORY   — owner/repo (e.g. Cheurteenyt/codebase-mirror)
#   GITHUB_TOKEN        — workflow token for authenticated API access
#   OUTPUT_FILE         — path to write structured outputs
#
# Optional (test mode):
#   CBM_SIGNATURE_TEST_MODE — "1" to enable local test server mode
#                             (only when GITHUB_ACTIONS != true)
#

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# In-memory state (emitted once via trap, OBS-R168.1-01 pattern)
# ─────────────────────────────────────────────────────────────────────────────

STATE_VERIFIED="not-run"
STATE_REASON=""
STATE_VERIFIED_AT=""
STATE_API_SHA=""
STATE_ERROR_CATEGORY="none"
STATE_ERROR_DETAIL=""
STATE_ATTEMPTS="0"

OUTPUT_FILE="${OUTPUT_FILE:-}"

emit_final_outputs() {
  local exit_code=$?
  if [ -n "$OUTPUT_FILE" ]; then
    : > "$OUTPUT_FILE"
    printf 'github_signature_verified=%s\n' "$STATE_VERIFIED" >> "$OUTPUT_FILE"
    printf 'github_signature_reason=%s\n' "$STATE_REASON" >> "$OUTPUT_FILE"
    printf 'github_signature_verified_at=%s\n' "$STATE_VERIFIED_AT" >> "$OUTPUT_FILE"
    printf 'github_signature_api_sha=%s\n' "$STATE_API_SHA" >> "$OUTPUT_FILE"
    printf 'github_signature_error_category=%s\n' "$STATE_ERROR_CATEGORY" >> "$OUTPUT_FILE"
    printf 'github_signature_error_detail=%s\n' "$STATE_ERROR_DETAIL" >> "$OUTPUT_FILE"
    printf 'github_signature_attempts=%s\n' "$STATE_ATTEMPTS" >> "$OUTPUT_FILE"
  fi
  exit "$exit_code"
}

trap emit_final_outputs EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Configuration validation
# ─────────────────────────────────────────────────────────────────────────────

if [ -z "${TARGET_SHA:-}" ]; then
  echo "::error::TARGET_SHA is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  STATE_ERROR_DETAIL="TARGET_SHA not set"
  exit 2
fi

if ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::TARGET_SHA is not a valid 40-char hex SHA: $TARGET_SHA" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  STATE_ERROR_DETAIL="invalid SHA format"
  exit 2
fi

if [ -z "${GITHUB_API_URL:-}" ]; then
  echo "::error::GITHUB_API_URL is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  STATE_ERROR_DETAIL="GITHUB_API_URL not set"
  exit 2
fi

if [ -z "${GITHUB_REPOSITORY:-}" ]; then
  echo "::error::GITHUB_REPOSITORY is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  STATE_ERROR_DETAIL="GITHUB_REPOSITORY not set"
  exit 2
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "::error::GITHUB_TOKEN is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  STATE_ERROR_DETAIL="GITHUB_TOKEN not set"
  exit 2
fi

# In production, API URL must be https://api.github.com
# In test mode, allow localhost
CBM_SIGNATURE_TEST_MODE="${CBM_SIGNATURE_TEST_MODE:-}"
if [ "$CBM_SIGNATURE_TEST_MODE" != "1" ]; then
  if [ "$GITHUB_API_URL" != "https://api.github.com" ]; then
    echo "::error::GITHUB_API_URL must be https://api.github.com in production. Got: $GITHUB_API_URL" >&2
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
    STATE_ERROR_DETAIL="non-production API URL"
    exit 2
  fi
fi

echo "=== GitHub Commit Signature Verification ==="
echo "Target SHA:     $TARGET_SHA"
echo "Repository:     $GITHUB_REPOSITORY"
echo "API URL:        $GITHUB_API_URL"
echo "Test mode:      ${CBM_SIGNATURE_TEST_MODE:-no}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Retry logic
# ─────────────────────────────────────────────────────────────────────────────

MAX_ATTEMPTS=3
BACKOFF_DELAYS=(1 2 4)

# Reasons that warrant retry (transient)
is_retryable_reason() {
  case "$1" in
    gpgverify_error|gpgverify_unavailable) return 0 ;;
    *) return 1 ;;
  esac
}

# HTTP status codes that warrant retry
is_retryable_http_status() {
  case "$1" in
    429|500|502|503|504) return 0 ;;
    *) return 1 ;;
  esac
}

for attempt in $(seq 1 $MAX_ATTEMPTS); do
  STATE_ATTEMPTS="$attempt"

  echo "--- Attempt $attempt/$MAX_ATTEMPTS ---"

  # Make the API call
  HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/commits/${TARGET_SHA}" 2>&1) || {
    # Network error
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_NETWORK_ERROR"
    STATE_ERROR_DETAIL="curl failed: $HTTP_RESPONSE"
    echo "::error::Network error during API call" >&2
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
      sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
      continue
    fi
    exit 1
  }

  # Split response body and HTTP status
  HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
  HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -1)

  echo "  HTTP status: $HTTP_STATUS"

  # Handle HTTP errors
  if [ "$HTTP_STATUS" != "200" ]; then
    if is_retryable_http_status "$HTTP_STATUS"; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      STATE_ERROR_DETAIL="HTTP $HTTP_STATUS (retryable)"
      echo "::error::HTTP $HTTP_STATUS — retryable" >&2
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
        sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
        continue
      fi
      exit 1
    elif [ "$HTTP_STATUS" = "429" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_RATE_LIMITED"
      STATE_ERROR_DETAIL="HTTP 429 — rate limited (retryable)"
      echo "::error::HTTP 429 — rate limited" >&2
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
        sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
        continue
      fi
      exit 1
    elif [ "$HTTP_STATUS" = "401" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      STATE_ERROR_DETAIL="HTTP 401 — authentication failed"
      echo "::error::HTTP 401 — token invalid or expired" >&2
      exit 1
    elif [ "$HTTP_STATUS" = "404" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      STATE_ERROR_DETAIL="HTTP 404 — commit not found"
      echo "::error::HTTP 404 — commit not found on GitHub" >&2
      exit 1
    else
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      STATE_ERROR_DETAIL="HTTP $HTTP_STATUS (non-retryable)"
      echo "::error::HTTP $HTTP_STATUS — non-retryable" >&2
      exit 1
    fi
  fi

  # Parse JSON response
  if ! API_SHA=$(echo "$HTTP_BODY" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('sha', ''))
except Exception:
    sys.exit(1)
" 2>/dev/null); then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_MALFORMED_JSON"
    STATE_ERROR_DETAIL="JSON parse failed"
    echo "::error::Malformed JSON response from GitHub API" >&2
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
      sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
      continue
    fi
    exit 1
  fi

  STATE_API_SHA="$API_SHA"

  # Verify SHA matches
  if [ "$API_SHA" != "$TARGET_SHA" ]; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_SHA_MISMATCH"
    STATE_ERROR_DETAIL="API returned SHA $API_SHA, expected $TARGET_SHA"
    echo "::error::SHA mismatch: API=$API_SHA, expected=$TARGET_SHA" >&2
    exit 1
  fi

  echo "  API SHA: $API_SHA (matches target ✓)"

  # Extract verification fields
  VERIFICATION_DATA=$(echo "$HTTP_BODY" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    v = d.get('commit', {}).get('verification', {})
    if not v:
        print('SCHEMA_ERROR')
        sys.exit(0)
    verified = str(v.get('verified', '')).lower()
    reason = v.get('reason', '')
    verified_at = v.get('verified_at', '') or ''
    print(f'{verified}|{reason}|{verified_at}')
except Exception:
    print('PARSE_ERROR')
" 2>/dev/null)

  if [ "$VERIFICATION_DATA" = "SCHEMA_ERROR" ]; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_SCHEMA_ERROR"
    STATE_ERROR_DETAIL="verification object missing from response"
    echo "::error::Schema error: verification object missing" >&2
    exit 1
  fi

  if [ "$VERIFICATION_DATA" = "PARSE_ERROR" ]; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_MALFORMED_JSON"
    STATE_ERROR_DETAIL="could not parse verification fields"
    echo "::error::Parse error in verification fields" >&2
    exit 1
  fi

  # Parse the pipe-delimited output
  VERIFIED=$(echo "$VERIFICATION_DATA" | cut -d'|' -f1)
  REASON=$(echo "$VERIFICATION_DATA" | cut -d'|' -f2)
  VERIFIED_AT=$(echo "$VERIFICATION_DATA" | cut -d'|' -f3)

  STATE_REASON="$REASON"
  STATE_VERIFIED_AT="$VERIFIED_AT"

  echo "  Verified: $VERIFIED"
  echo "  Reason:   $REASON"
  echo "  Verified at: ${VERIFIED_AT:-<empty>}"

  # Check acceptance criteria
  if [ "$VERIFIED" = "true" ] && [ "$REASON" = "valid" ] && [ -n "$VERIFIED_AT" ]; then
    STATE_VERIFIED="true"
    STATE_ERROR_CATEGORY="none"
    STATE_ERROR_DETAIL=""
    echo ""
    echo "✓ GitHub commit signature verified successfully"
    exit 0
  fi

  # Determine error category from reason
  case "$REASON" in
    unsigned)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_UNSIGNED"
      STATE_ERROR_DETAIL="commit is not signed"
      ;;
    invalid|malformed_signature)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_INVALID"
      STATE_ERROR_DETAIL="signature is invalid: $REASON"
      ;;
    gpgverify_error|gpgverify_unavailable)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_TRANSIENT_VERIFIER_ERROR"
      STATE_ERROR_DETAIL="GitHub verifier transient error: $REASON"
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "  Transient verifier error — retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
        sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
        continue
      fi
      ;;
    unknown_key|no_user|unverified_email|bad_email|expired_key|not_signing_key|unknown_signature_type)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_UNVERIFIED"
      STATE_ERROR_DETAIL="signature cannot be verified: $REASON"
      ;;
    *)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_UNVERIFIED"
      STATE_ERROR_DETAIL="unknown verification reason: $REASON"
      ;;
  esac

  # Non-retryable failure
  echo "::error::Signature verification failed: $STATE_ERROR_CATEGORY" >&2
  echo "::error::Reason: $REASON" >&2
  exit 1

done

# Exhausted retries
echo "::error::Exhausted $MAX_ATTEMPTS attempts" >&2
exit 1
