/**
 * R169 SIG — Source inspection tests for the signature gate.
 *
 * These tests verify the STRUCTURE of the canonical verifier script and the
 * workflow integration. Runtime behavioral tests are in
 * r169-signature-runtime.test.ts (SIG-R169-RT-01).
 *
 * SIG-R169-DIV-01: The workflow calls the canonical script directly — no
 * inline duplication. These tests verify that integration.
 *
 * SIG-R169-TOKEN-01: The anti-leak test uses negative fixtures to verify
 * that dangerous patterns are actually caught.
 *
 * SIG-R169-TEST-01: The executable-bit test checks the Unix mode, not just
 * file existence.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "ci", "verify-github-commit-signature.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf-8");
}

function readWorkflow(name: string): string {
  const path = join(REPO_ROOT, ".github", "workflows", name);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

// ─── Token leak detection (SIG-R169-TOKEN-01) ───────────────────────────
//
// Returns true if a line is DANGEROUS (would leak GITHUB_TOKEN).
// Used both to verify the detection logic (negative fixtures) and to
// scan the actual script + workflow.

function isDangerousLine(line: string): boolean {
  const trimmed = line.trim();

  // Skip comments, empty lines, and shebangs
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;

  // set -x enables tracing, which prints all commands including token values
  if (/^\s*set\s+-[a-zA-Z]*x/.test(line)) return true;

  // env / printenv dump all environment variables (including GITHUB_TOKEN)
  // Allow: env VAR=value (assignment), env -i, env VAR=value command
  // Catch: bare env, env | sort, printenv
  if (/^\s*env\s*$/.test(trimmed) || /^\s*env\s*\|/.test(trimmed)) return true;
  if (/^\s*printenv\b/.test(trimmed)) return true;

  // echo/printf with $GITHUB_TOKEN variable expansion (not in error messages)
  // Safe: echo "GITHUB_TOKEN is not set" (no $ prefix)
  // Dangerous: echo "$GITHUB_TOKEN", printf "%s" "$GITHUB_TOKEN"
  if (/^\s*(echo|printf)\b/.test(trimmed) && /\$GITHUB_TOKEN\b/.test(line)) {
    return true;
  }

  return false;
}

// ─── Script structure tests ─────────────────────────────────────────────

describe("R169 SIG — script structure", () => {
  it("script exists and is executable (SIG-R169-TEST-01)", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    const mode = statSync(SCRIPT_PATH).mode;
    // Check any execute bit (user, group, or other)
    expect(mode & 0o111).not.toBe(0);
  });

  it("script contains all 11 error categories", () => {
    const script = readScript();
    const categories = [
      "GITHUB_SIGNATURE_CONFIG_ERROR",
      "GITHUB_SIGNATURE_API_NETWORK_ERROR",
      "GITHUB_SIGNATURE_API_HTTP_ERROR",
      "GITHUB_SIGNATURE_API_RATE_LIMITED",
      "GITHUB_SIGNATURE_API_MALFORMED_JSON",
      "GITHUB_SIGNATURE_API_SCHEMA_ERROR",
      "GITHUB_SIGNATURE_SHA_MISMATCH",
      "GITHUB_SIGNATURE_UNSIGNED",
      "GITHUB_SIGNATURE_INVALID",
      "GITHUB_SIGNATURE_UNVERIFIED",
      "GITHUB_SIGNATURE_TRANSIENT_VERIFIER_ERROR",
    ];
    for (const cat of categories) {
      expect(script).toContain(cat);
    }
  });

  it("script uses trap for output emission", () => {
    expect(readScript()).toContain("trap emit_final_outputs EXIT");
  });

  it("script has 3 attempts with backoff 1 and 2 (SIG-AUD-09)", () => {
    const script = readScript();
    expect(script).toContain("MAX_ATTEMPTS=3");
    expect(script).toContain("BACKOFF_DELAYS=(1 2)");
  });

  it("script has curl connect-timeout and max-time (SIG-AUD-08)", () => {
    const script = readScript();
    expect(script).toContain("--connect-timeout 10");
    expect(script).toContain("--max-time 30");
  });

  it("script checks 429 before generic 5xx (SIG-AUD-04)", () => {
    const script = readScript();
    const idx429 = script.indexOf('"429"');
    const idx500 = script.indexOf('"500"');
    expect(idx429).toBeGreaterThan(-1);
    expect(idx500).toBeGreaterThan(-1);
    expect(idx429).toBeLessThan(idx500);
  });

  it("script does not have dead is_retryable_reason function (SIG-AUD-12)", () => {
    expect(readScript()).not.toContain("is_retryable_reason");
  });

  it("script enforces GITHUB_ACTIONS + loopback in test mode (SIG-AUD-03)", () => {
    const script = readScript();
    expect(script).toContain("GITHUB_ACTIONS");
    expect(script).toContain("127.0.0.1");
    expect(script).toContain("localhost");
  });

  it("script writes JSON output (SIG-AUD-05)", () => {
    expect(readScript()).toContain("json.dump");
  });

  it("script sets verified to actual value not not-run (SIG-AUD-06)", () => {
    const script = readScript();
    expect(script).toContain('STATE_VERIFIED="$VERIFIED"');
  });

  it("script does strict type validation (SIG-AUD-07)", () => {
    const script = readScript();
    expect(script).toContain("isinstance(verified, bool)");
    expect(script).toContain("isinstance(reason, str)");
    expect(script).toContain("isinstance(verified_at, str)");
  });

  it("script validates verified_at as ISO-8601 timestamp (SIG-R169-SCHEMA-01)", () => {
    const script = readScript();
    expect(script).toContain("datetime.fromisoformat");
    expect(script).toContain("verified_at_format");
  });

  it("script uses env vars for JSON generation, not interpolation (SIG-R169-JSON-01)", () => {
    const script = readScript();
    // The Python snippet should read from os.environ, not interpolate shell vars
    expect(script).toContain("os.environ.get");
    // Should NOT contain direct interpolation like '$STATE_REASON' in Python code
    expect(script).not.toContain("'github_signature_verified': '$STATE_VERIFIED'");
  });

  it("script has no key=value fallback (SIG-R169-JSON-02)", () => {
    const script = readScript();
    // The old fallback wrote key=value pairs via printf — that must be gone
    expect(script).not.toContain("printf 'github_signature_verified=");
    expect(script).not.toContain("printf 'github_signature_reason=");
    expect(script).not.toContain("printf 'github_signature_api_sha=");
    // The script should explicitly document that there is no fallback
    expect(script).toContain("no fallback (SIG-R169-JSON-02)");
  });

  it("script supports SIGNATURE_RETRY_DELAY_SCALE for tests (performance)", () => {
    const script = readScript();
    expect(script).toContain("SIGNATURE_RETRY_DELAY_SCALE");
    expect(script).toContain("maybe_sleep");
  });

  it("script populates all state fields after parse (SIG-R169-DIAG-01)", () => {
    const script = readScript();
    // After successful parse, all fields should be set
    expect(script).toContain('STATE_API_SHA="$API_SHA"');
    expect(script).toContain('STATE_REASON="$REASON"');
    expect(script).toContain('STATE_VERIFIED_AT="$VERIFIED_AT"');
    expect(script).toContain('STATE_VERIFIED="$VERIFIED"');
  });
});

// ─── Token leak detection (SIG-AUD-11, SIG-R169-TOKEN-01) ───────────────

describe("R169 SIG — token leak detection (SIG-R169-TOKEN-01)", () => {
  it("negative fixture: echo \"$GITHUB_TOKEN\" is detected as dangerous", () => {
    expect(isDangerousLine('echo "$GITHUB_TOKEN"')).toBe(true);
  });

  it("negative fixture: printf \"%s\" \"$GITHUB_TOKEN\" is detected", () => {
    expect(isDangerousLine('printf "%s" "$GITHUB_TOKEN"')).toBe(true);
  });

  it("negative fixture: set -x is detected", () => {
    expect(isDangerousLine("set -x")).toBe(true);
    expect(isDangerousLine("set -euox pipefail")).toBe(true);
  });

  it("negative fixture: env | sort is detected", () => {
    expect(isDangerousLine("env | sort")).toBe(true);
  });

  it("negative fixture: printenv is detected", () => {
    expect(isDangerousLine("printenv")).toBe(true);
    expect(isDangerousLine("printenv GITHUB_TOKEN")).toBe(true);
  });

  it("negative fixture: bare env is detected", () => {
    expect(isDangerousLine("env")).toBe(true);
  });

  it("safe line: echo \"GITHUB_TOKEN is not set\" is NOT dangerous", () => {
    // No $ before GITHUB_TOKEN — this is a string literal, not variable expansion
    expect(isDangerousLine('echo "::error::GITHUB_TOKEN is not set" >&2')).toBe(false);
  });

  it("safe line: Authorization: Bearer is NOT dangerous", () => {
    expect(isDangerousLine('-H "Authorization: Bearer $GITHUB_TOKEN"')).toBe(false);
  });

  it("safe line: presence check is NOT dangerous", () => {
    expect(isDangerousLine('if [ -z "${GITHUB_TOKEN:-}" ]; then')).toBe(false);
  });

  it("safe line: YAML env definition is NOT dangerous", () => {
    expect(isDangerousLine("          GITHUB_TOKEN: ${{ github.token }}")).toBe(false);
  });

  it("script has no dangerous lines", () => {
    const script = readScript();
    const lines = script.split("\n");
    const dangerous: string[] = [];
    for (const line of lines) {
      if (isDangerousLine(line)) {
        dangerous.push(line.trim());
      }
    }
    if (dangerous.length > 0) {
      expect.fail(`Dangerous lines found in script:\n${dangerous.join("\n")}`);
    }
  });

  it("workflow has no dangerous lines", () => {
    const workflow = readWorkflow("mirror-main-to-gitlab.yml");
    const lines = workflow.split("\n");
    const dangerous: string[] = [];
    for (const line of lines) {
      if (isDangerousLine(line)) {
        dangerous.push(line.trim());
      }
    }
    if (dangerous.length > 0) {
      expect.fail(`Dangerous lines found in workflow:\n${dangerous.join("\n")}`);
    }
  });
});

// ─── Workflow integration tests ─────────────────────────────────────────

describe("R169 SIG — workflow integration", () => {
  const workflow = readWorkflow("mirror-main-to-gitlab.yml");

  it("workflow calls the canonical script (SIG-R169-DIV-01)", () => {
    expect(workflow).toContain("bash scripts/ci/verify-github-commit-signature.sh");
  });

  it("workflow has separate checkout for verifier script BEFORE signature step (SIG-AUD-01)", () => {
    const verifierCheckoutIdx = workflow.indexOf("Checkout verifier script");
    const sigIdx = workflow.indexOf("Verify GitHub commit signature");
    const targetCheckoutIdx = workflow.indexOf("Checkout exact CI-validated SHA");
    expect(verifierCheckoutIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeGreaterThan(verifierCheckoutIdx);
    expect(targetCheckoutIdx).toBeGreaterThan(sigIdx);
  });

  it("verifier checkout uses sparse-checkout for scripts/ci only", () => {
    const verifierSection = workflow.substring(
      workflow.indexOf("Checkout verifier script"),
      workflow.indexOf("Verify GitHub commit signature")
    );
    expect(verifierSection).toContain("sparse-checkout");
    expect(verifierSection).toContain("scripts/ci");
  });

  it("signature step uses github.token", () => {
    expect(workflow).toContain("github.token");
  });

  it("permissions remain contents: read only", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("no continue-on-error on signature step", () => {
    const sigSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(sigSection).not.toContain("continue-on-error");
  });

  it("summary includes explicit parity verdicts (SIG-AUD-10)", () => {
    expect(workflow).toContain("SIG_SHA_MATCH");
    expect(workflow).toContain("GITLAB_PARITY");
    expect(workflow).toContain("Effective conclusion");
  });

  it("summary normalizes mirror success states (SIG-R169-SUM-01)", () => {
    expect(workflow).toContain("MIRROR_SUCCESS");
    expect(workflow).toContain("mirrored|already-mirrored|newer-valid-mirror-present");
  });

  it("no dead SIGNATURE_OUTPUT_FILE variable (SIG-R169-DEAD-01)", () => {
    // The old SIGNATURE_OUTPUT_FILE env var was never used by the inline logic.
    // It should be removed (replaced by OUTPUT_FILE).
    expect(workflow).not.toContain("SIGNATURE_OUTPUT_FILE");
    expect(workflow).toContain("OUTPUT_FILE");
  });

  it("workflow documents trust boundary honestly (SIG-R169-POLICY-01)", () => {
    // The workflow comments should not claim the gate is immutable
    expect(workflow).not.toContain("no code from the target commit is executed");
    // Should mention that the gate proves provenance, not safety
    expect(workflow).toContain("provenance");
  });
});
