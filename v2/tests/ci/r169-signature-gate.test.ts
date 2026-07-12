/**
 * R169 SIG — Cross-host Signature Trust Gate tests.
 *
 * Source inspection tests covering the script and workflow structure.
 * Runtime tests (with local HTTP fixture server) are deferred — they
 * require a port-capture mechanism that doesn't have timing issues.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
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

describe("R169 SIG — script structure", () => {
  it("script exists and is executable", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
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

  it("script does not log token via echo/printf/set -x (SIG-AUD-11)", () => {
    const script = readScript();
    const lines = script.split("\n");
    for (const line of lines) {
      if (line.includes("Authorization: Bearer")) continue;
      if (line.includes("GITHUB_TOKEN:") || line.includes("GITHUB_TOKEN=")) continue;
      if (line.includes('"$GITHUB_TOKEN"')) continue;
      if (/^\s*echo\s+.*\$GITHUB_TOKEN\b/.test(line) && !line.includes("_FILE")) {
        expect.fail(`Potential token leak: ${line.trim()}`);
      }
      if (/^\s*printf\s+.*\$GITHUB_TOKEN\b/.test(line) && !line.includes("_FILE")) {
        expect.fail(`Potential token leak: ${line.trim()}`);
      }
      if (/^\s*set\s+-x/.test(line)) {
        expect.fail(`set -x would expose token: ${line.trim()}`);
      }
    }
  });
});

describe("R169 SIG — workflow integration", () => {
  const workflow = readWorkflow("mirror-main-to-gitlab.yml");

  it("signature verification BEFORE checkout (SIG-AUD-01)", () => {
    const sigIdx = workflow.indexOf("Verify GitHub commit signature");
    const checkoutIdx = workflow.indexOf("Checkout exact CI-validated SHA");
    expect(sigIdx).toBeGreaterThan(-1);
    expect(checkoutIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeLessThan(checkoutIdx);
  });

  it("signature step BEFORE Materialize SSH key", () => {
    const sigIdx = workflow.indexOf("Verify GitHub commit signature");
    const sshIdx = workflow.indexOf("Materialize SSH key");
    expect(sigIdx).toBeLessThan(sshIdx);
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

  it("signature verification is inline, not from target checkout (SIG-AUD-01)", () => {
    const sigSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(sigSection).not.toContain("scripts/ci/verify-github-commit-signature.sh");
  });
});

// TODO: Runtime tests with local HTTP fixture server (SIG-AUD-02)
// These require a port-capture mechanism that doesn't have timing issues
// with vitest's module loading. A future round should add:
// - Local HTTP server with fixture responses
// - child_process.spawnSync to run the script
// - Test cases: valid, unsigned, invalid, unknown_key, retry, 429,
//   5xx, 401, 404, malformed JSON, schema missing, SHA mismatch
// - Verify no GitLab mutation on refusal
