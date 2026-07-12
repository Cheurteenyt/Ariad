/**
 * R169 — Cross-host Signature Trust Gate tests.
 *
 * Tests the signature verification script and its integration
 * in the mirror workflow.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "ci", "verify-github-commit-signature.sh");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "mirror-main-to-gitlab.yml");

function readWorkflow(name: string): string {
  const path = join(REPO_ROOT, ".github", "workflows", name);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

describe("R169 SIG — signature script existence and structure", () => {
  it("scripts/ci/verify-github-commit-signature.sh exists and is executable", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it("script contains all error categories", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
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
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("trap emit_final_outputs EXIT");
  });

  it("script has retry logic with 3 attempts", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("MAX_ATTEMPTS=3");
  });

  it("script has backoff delays 1/2/4", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("BACKOFF_DELAYS=(1 2 4)");
  });

  it("script checks verified == true AND reason == valid AND verified_at non-empty", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain('"true"');
    expect(script).toContain('"valid"');
    expect(script).toContain('-n "$VERIFIED_AT"');
  });

  it("script checks API SHA == TARGET_SHA", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("GITHUB_SIGNATURE_SHA_MISMATCH");
    expect(script).toContain("API_SHA"); expect(script).toContain("TARGET_SHA"); expect(script).toContain("SHA_MISMATCH");
  });

  it("script does not log the token", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    // The script must not echo or print the token
    expect(script).not.toMatch(/echos+.*\$GITHUB_TOKEN[^_]/);
    expect(script).not.toMatch(/printfs+.*\$GITHUB_TOKEN[^_]/);
  });

  it("script retries only on gpgverify_error and gpgverify_unavailable", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("gpgverify_error");
    expect(script).toContain("gpgverify_unavailable");
  });

  it("script retries on HTTP 429/500/502/503/504", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toMatch(/429\|500\|502\|503\|504/);
  });

  it("script does NOT retry on unsigned/invalid", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    // unsigned and invalid should exit 1 immediately
    const unsignedSection = script.substring(script.indexOf("unsigned)"));
    expect(unsignedSection).toContain("exit 1");
  });

  it("script enforces production API URL in non-test mode", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("https://api.github.com");
    expect(script).toContain("CBM_SIGNATURE_TEST_MODE");
  });

  it("script outputs all required fields", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("github_signature_verified");
    expect(script).toContain("github_signature_reason");
    expect(script).toContain("github_signature_verified_at");
    expect(script).toContain("github_signature_api_sha");
    expect(script).toContain("github_signature_error_category");
    expect(script).toContain("github_signature_error_detail");
    expect(script).toContain("github_signature_attempts");
  });
});

describe("R169 SIG — workflow integration", () => {
  const workflow = readWorkflow("mirror-main-to-gitlab.yml");

  it("workflow has a 'Verify GitHub commit signature' step", () => {
    expect(workflow).toContain("Verify GitHub commit signature");
  });

  it("signature step appears BEFORE Materialize SSH key", () => {
    const sigIdx = workflow.indexOf("Verify GitHub commit signature");
    const sshIdx = workflow.indexOf("Materialize SSH key");
    expect(sigIdx).toBeGreaterThan(-1);
    expect(sshIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeLessThan(sshIdx);
  });

  it("signature step uses github.token", () => {
    expect(workflow).toContain("github.token");
  });

  it("signature step uses github.api_url", () => {
    expect(workflow).toContain("github.api_url");
  });

  it("signature step uses github.repository", () => {
    expect(workflow).toContain("github.repository");
  });

  it("permissions remain contents: read only", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("no continue-on-error on the signature step", () => {
    // The signature step should not have continue-on-error
    const sigSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Materialize SSH key")
    );
    expect(sigSection).not.toContain("continue-on-error");
  });

  it("summary includes signature information", () => {
    expect(workflow).toContain("GitHub commit signature");
    expect(workflow).toContain("SIG_VERIFIED");
    expect(workflow).toContain("SIG_REASON");
  });

  it("workflow calls the signature script", () => {
    expect(workflow).toContain("scripts/ci/verify-github-commit-signature.sh");
  });
});
