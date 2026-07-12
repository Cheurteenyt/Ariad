#!/usr/bin/env bash
#
# scripts/ci/verify-github-commit-signature.sh
#
# SIG-R169: Cross-host Signature Trust Gate
# SIG-AUD-01: This script is NOT executed from the target checkout in
#   production. The workflow performs the verification inline BEFORE
#   checkout. This script is kept for local testing only.
#
# Verifies that GitHub has cryptographically verified the commit at TARGET_SHA.
# Uses the GitHub REST API with the workflow's GITHUB_TOKEN (no new secrets).
# Fails closed on any error — no fallback to unsigned acceptance.
#

set -euo pipefail

# In-memory state (emitted once via trap as JSON — SIG-AUD-05)
STATE_VERIFIED="not-run"
STATE_REASON=""
STATE_VERIFIED_AT=""
STATE_API_SHA=""
STATE_ERROR_CATEGORY="none"
STATE_ATTEMPTS="0"
OUTPUT_FILE="${OUTPUT_FILE:-}"

emit_final_outputs() {
  local exit_code=$?
  if [ -n "$OUTPUT_FILE" ]; then
    python3 -c "
import json
data = {
    'github_signature_verified': '$STATE_VERIFIED',
    'github_signature_reason': '$STATE_REASON',
    'github_signature_verified_at': '$STATE_VERIFIED_AT',
    'github_signature_api_sha': '$STATE_API_SHA',
    'github_signature_error_category': '$STATE_ERROR_CATEGORY',
    'github_signature_attempts': '$STATE_ATTEMPTS',
}
with open('$OUTPUT_FILE', 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null || {
      : > "$OUTPUT_FILE"
      printf 'github_signature_verified=%s\n' "$STATE_VERIFIED" >> "$OUTPUT_FILE"
      printf 'github_signature_reason=%s\n' "$STATE_REASON" >> "$OUTPUT_FILE"
      printf 'github_signature_verified_at=%s\n' "$STATE_VERIFIED_AT" >> "$OUTPUT_FILE"
      printf 'github_signature_api_sha=%s\n' "$STATE_API_SHA" >> "$OUTPUT_FILE"
      printf 'github_signature_error_category=%s\n' "$STATE_ERROR_CATEGORY" >> "$OUTPUT_FILE"
      printf 'github_signature_attempts=%s\n' "$STATE_ATTEMPTS" >> "$OUTPUT_FILE"
    }
  fi
  exit "$exit_code"
}
trap emit_final_outputs EXIT

# Configuration validation
if [ -z "${TARGET_SHA:-}" ]; then
  echo "::error::TARGET_SHA is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi
if ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::TARGET_SHA is not a valid 40-char hex SHA" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi
if [ -z "${GITHUB_API_URL:-}" ]; then
  echo "::error::GITHUB_API_URL is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi
if [ -z "${GITHUB_REPOSITORY:-}" ]; then
  echo "::error::GITHUB_REPOSITORY is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "::error::GITHUB_TOKEN is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi

# SIG-AUD-03: Test mode isolation
CBM_SIGNATURE_TEST_MODE="${CBM_SIGNATURE_TEST_MODE:-}"
if [ "$CBM_SIGNATURE_TEST_MODE" = "1" ]; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error::CBM_SIGNATURE_TEST_MODE not allowed when GITHUB_ACTIONS=true" >&2
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
    exit 2
  fi
  case "$GITHUB_API_URL" in
    http://127.0.0.1:*|http://localhost:*|http://[::1]:*) ;;
    *)
      echo "::error::Test mode requires loopback URL" >&2
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
      exit 2
      ;;
  esac
else
  if [ "$GITHUB_API_URL" != "https://api.github.com" ]; then
    echo "::error::GITHUB_API_URL must be https://api.github.com in production" >&2
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
    exit 2
  fi
fi

echo "=== GitHub Commit Signature Verification ==="
echo "Target SHA: $TARGET_SHA"
echo "Repository: $GITHUB_REPOSITORY"
echo "API URL: $GITHUB_API_URL"
echo ""

# SIG-AUD-09: 3 attempts, 2 delays: 1s and 2s
MAX_ATTEMPTS=3
BACKOFF_DELAYS=(1 2)

for attempt in $(seq 1 $MAX_ATTEMPTS); do
  STATE_ATTEMPTS="$attempt"
  echo "--- Attempt $attempt/$MAX_ATTEMPTS ---"

  # SIG-AUD-08: curl with timeouts
  HTTP_RESPONSE=$(curl \
    --connect-timeout 10 \
    --max-time 30 \
    --show-error \
    --silent \
    -w "\n%{http_code}" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/commits/${TARGET_SHA}" 2>&1) || {
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_NETWORK_ERROR"
    echo "::error::Network error" >&2
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
      sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
      continue
    fi
    exit 1
  }

  HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
  HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -1)
  echo "  HTTP status: $HTTP_STATUS"

  if [ "$HTTP_STATUS" != "200" ]; then
    # SIG-AUD-04: Test 429 before generic 5xx
    if [ "$HTTP_STATUS" = "429" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_RATE_LIMITED"
      echo "::error::HTTP 429 — rate limited" >&2
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
        sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
        continue
      fi
      exit 1
    elif [ "$HTTP_STATUS" = "500" ] || [ "$HTTP_STATUS" = "502" ] || \
         [ "$HTTP_STATUS" = "503" ] || [ "$HTTP_STATUS" = "504" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      echo "::error::HTTP $HTTP_STATUS (retryable)" >&2
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
        sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
        continue
      fi
      exit 1
    elif [ "$HTTP_STATUS" = "401" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      echo "::error::HTTP 401 — auth failed" >&2
      exit 1
    elif [ "$HTTP_STATUS" = "404" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      echo "::error::HTTP 404 — not found" >&2
      exit 1
    else
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      echo "::error::HTTP $HTTP_STATUS" >&2
      exit 1
    fi
  fi

  # SIG-AUD-07: Single-pass strict JSON parsing with type validation
  PARSE_RESULT=$(echo "$HTTP_BODY" | python3 -c "
import json, sys, re
try:
    d = json.load(sys.stdin)
except Exception:
    print('MALFORMED_JSON')
    sys.exit(0)
sha = d.get('sha')
if not isinstance(sha, str) or not re.match(r'^[0-9a-f]{40}$', sha):
    print('SCHEMA_ERROR|sha')
    sys.exit(0)
v = d.get('commit', {}).get('verification')
if not isinstance(v, dict):
    print('SCHEMA_ERROR|verification')
    sys.exit(0)
verified = v.get('verified')
if not isinstance(verified, bool):
    print('SCHEMA_ERROR|verified_type')
    sys.exit(0)
reason = v.get('reason')
if not isinstance(reason, str) or not reason:
    print('SCHEMA_ERROR|reason')
    sys.exit(0)
verified_at = v.get('verified_at')
if not isinstance(verified_at, str) or not verified_at:
    print('SCHEMA_ERROR|verified_at')
    sys.exit(0)
print(f'{sha}|{str(verified).lower()}|{reason}|{verified_at}')
" 2>/dev/null)

  if [ "$PARSE_RESULT" = "MALFORMED_JSON" ]; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_MALFORMED_JSON"
    echo "::error::Malformed JSON" >&2
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
      sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
      continue
    fi
    exit 1
  fi

  if echo "$PARSE_RESULT" | grep -q "^SCHEMA_ERROR"; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_SCHEMA_ERROR"
    echo "::error::Schema error: $(echo "$PARSE_RESULT" | cut -d'|' -f2)" >&2
    exit 1
  fi

  API_SHA=$(echo "$PARSE_RESULT" | cut -d'|' -f1)
  VERIFIED=$(echo "$PARSE_RESULT" | cut -d'|' -f2)
  REASON=$(echo "$PARSE_RESULT" | cut -d'|' -f3)
  VERIFIED_AT=$(echo "$PARSE_RESULT" | cut -d'|' -f4)

  STATE_API_SHA="$API_SHA"
  STATE_REASON="$REASON"
  STATE_VERIFIED_AT="$VERIFIED_AT"
  # SIG-AUD-06: Set verified to actual value
  STATE_VERIFIED="$VERIFIED"

  echo "  API SHA: $API_SHA"
  echo "  Verified: $VERIFIED"
  echo "  Reason: $REASON"

  if [ "$API_SHA" != "$TARGET_SHA" ]; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_SHA_MISMATCH"
    echo "::error::SHA mismatch" >&2
    exit 1
  fi

  if [ "$VERIFIED" = "true" ] && [ "$REASON" = "valid" ] && [ -n "$VERIFIED_AT" ]; then
    STATE_ERROR_CATEGORY="none"
    echo "✓ Signature verified"
    exit 0
  fi

  # Map reason to error category
  case "$REASON" in
    unsigned)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_UNSIGNED" ;;
    invalid|malformed_signature)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_INVALID" ;;
    gpgverify_error|gpgverify_unavailable)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_TRANSIENT_VERIFIER_ERROR"
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
        sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
        continue
      fi
      ;;
    *)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_UNVERIFIED" ;;
  esac

  echo "::error::Verification failed: $STATE_ERROR_CATEGORY (reason=$REASON)" >&2
  exit 1

done

echo "::error::Exhausted $MAX_ATTEMPTS attempts" >&2
exit 1
