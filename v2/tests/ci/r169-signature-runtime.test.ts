/**
 * R169 SIG — Runtime tests for the canonical signature verifier.
 *
 * SIG-R169-RT-01: These tests execute the REAL script
 * (scripts/ci/verify-github-commit-signature.sh) against a local HTTP
 * fixture server. They are NOT source-inspection tests — they actually
 * run the script, make real curl requests, parse real JSON outputs, and
 * verify exit codes.
 *
 * SIG-R169-DIV-01: The script tested here is the SAME script called by
 * the mirror workflow. No duplication.
 *
 * Implementation note: We use async `spawn` (not `spawnSync`) because
 * the HTTP fixture server needs the Node.js event loop to handle curl
 * requests from the script. `spawnSync` blocks the event loop, which
 * would cause the server to never respond.
 *
 * Test matrix (14+ cases):
 *   1. valid                    — 200, verified=true, reason=valid       → exit 0
 *   2. unsigned                 — 200, verified=false, reason=unsigned    → exit 1, UNSIGNED
 *   3. invalid                  — 200, verified=false, reason=invalid     → exit 1, INVALID
 *   4. unknown_key              — 200, verified=false, reason=unknown_key → exit 1, UNVERIFIED
 *   5. 429-then-valid           — 429, then 200 valid                     → exit 0, attempts=2
 *   6. 500-permanent            — always 500                              → exit 1, HTTP_ERROR, attempts=3
 *   7. gpgverify-then-valid     — 200 gpgverify_unavailable, then valid   → exit 0, attempts=2
 *   8. 401                      — 401                                     → exit 1, HTTP_ERROR, attempts=1
 *   9. 404                      — 404                                     → exit 1, HTTP_ERROR, attempts=1
 *  10. malformed-json           — 200, invalid JSON                       → exit 1, MALFORMED_JSON, attempts=3
 *  11. schema-missing           — 200, missing verification object        → exit 1, SCHEMA_ERROR
 *  12. verified_at-absent       — 200, no verified_at                     → exit 1, SCHEMA_ERROR
 *  13. verified_at-invalid      — 200, verified_at="foo"                  → exit 1, SCHEMA_ERROR
 *  14. sha-mismatch             — 200, sha != TARGET_SHA                  → exit 1, SHA_MISMATCH
 *
 * Performance: SIGNATURE_RETRY_DELAY_SCALE=0 eliminates sleep delays.
 */

import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "ci", "verify-github-commit-signature.sh");

const TARGET_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const ISO_TS = "2026-07-13T10:00:00Z";

// ─── Fixture types ──────────────────────────────────────────────────────

interface Fixture {
  status: number;
  body: string;
}

// ─── Fixture server ─────────────────────────────────────────────────────

interface FixtureServer {
  port: number;
  close: () => void;
}

function startServer(responses: Fixture[]): Promise<FixtureServer> {
  return new Promise((resolve) => {
    let callCount = 0;
    const server: Server = createServer((req, res) => {
      const idx = Math.min(callCount, responses.length - 1);
      const fixture = responses[idx] || responses[responses.length - 1];
      callCount++;
      res.writeHead(fixture.status, { "Content-Type": "application/json" });
      res.end(fixture.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => {
          if (typeof (server as any).closeAllConnections === "function") {
            (server as any).closeAllConnections();
          }
          server.close();
        },
      });
    });
  });
}

// ─── Async script runner (uses spawn, not spawnSync) ────────────────────

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string> | null;
}

function runScriptAsync(port: number, targetSha: string = TARGET_SHA): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "r169-rt-"));
    const outputFile = join(tmpDir, "outputs.json");

    const child = spawn("bash", [SCRIPT_PATH], {
      env: {
        ...process.env,
        TARGET_SHA: targetSha,
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_REPOSITORY: "test/repo",
        GITHUB_TOKEN: "fake-token",
        OUTPUT_FILE: outputFile,
        SIGNATURE_RETRY_DELAY_SCALE: "0",
        CBM_SIGNATURE_TEST_MODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("close", (code) => {
      let outputs: Record<string, string> | null = null;
      try {
        outputs = JSON.parse(readFileSync(outputFile, "utf-8"));
      } catch {
        outputs = null;
      }
      rmSync(tmpDir, { recursive: true, force: true });
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        outputs,
      });
    });

    child.on("error", (err) => {
      rmSync(tmpDir, { recursive: true, force: true });
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + err.message,
        outputs: null,
      });
    });
  });
}

// Sync runner for config error tests (no server needed, spawnSync is fine)
function runScriptSync(envOverrides: Record<string, string>): ScriptResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "r169-cfg-"));
  const outputFile = join(tmpDir, "outputs.json");
  const result = spawnSync("bash", [SCRIPT_PATH], {
    env: {
      ...process.env,
      OUTPUT_FILE: outputFile,
      SIGNATURE_RETRY_DELAY_SCALE: "0",
      CBM_SIGNATURE_TEST_MODE: "1",
      ...envOverrides,
    },
    encoding: "utf-8",
    timeout: 5000,
  });
  let outputs: Record<string, string> | null = null;
  try { outputs = JSON.parse(readFileSync(outputFile, "utf-8")); } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
  return { exitCode: result.status ?? -1, stdout: result.stdout || "", stderr: result.stderr || "", outputs };
}

// ─── Body builders ──────────────────────────────────────────────────────

function validBody(sha: string, ts: string = ISO_TS): string {
  return JSON.stringify({ sha, commit: { verification: { verified: true, reason: "valid", verified_at: ts } } });
}

function refusalBody(sha: string, reason: string): string {
  return JSON.stringify({ sha, commit: { verification: { verified: false, reason, verified_at: ISO_TS } } });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("R169 SIG runtime — script file checks (SIG-R169-TEST-01)", () => {
  it("script file exists", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it("script has executable bit set (mode & 0o111 != 0)", () => {
    const mode = statSync(SCRIPT_PATH).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

describe("R169 SIG runtime — success cases", () => {
  it("valid signature → exit 0, all 6 fields populated", async () => {
    const srv = await startServer([{ status: 200, body: validBody(TARGET_SHA) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.verified).toBe("true");
      expect(r.outputs?.reason).toBe("valid");
      expect(r.outputs?.api_sha).toBe(TARGET_SHA);
      expect(r.outputs?.error_category).toBe("none");
      expect(r.outputs?.attempts).toBe("1");
      expect(r.outputs?.verified_at).toBe(ISO_TS);
    } finally {
      srv.close();
    }
  });

  it("429 then valid → exit 0, attempts=2", async () => {
    const srv = await startServer([
      { status: 429, body: JSON.stringify({ message: "rate limited" }) },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.verified).toBe("true");
      expect(r.outputs?.attempts).toBe("2");
      expect(r.outputs?.error_category).toBe("none");
    } finally {
      srv.close();
    }
  });

  it("gpgverify_unavailable then valid → exit 0, attempts=2", async () => {
    const srv = await startServer([
      { status: 200, body: refusalBody(TARGET_SHA, "gpgverify_unavailable") },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.verified).toBe("true");
      expect(r.outputs?.attempts).toBe("2");
    } finally {
      srv.close();
    }
  });
});

describe("R169 SIG runtime — refusal cases", () => {
  it("unsigned → exit 1, UNSIGNED, all fields populated (SIG-R169-DIAG-01)", async () => {
    const srv = await startServer([{ status: 200, body: refusalBody(TARGET_SHA, "unsigned") }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.verified).toBe("false");
      expect(r.outputs?.reason).toBe("unsigned");
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_UNSIGNED");
      expect(r.outputs?.attempts).toBe("1");
      expect(r.outputs?.api_sha).toBe(TARGET_SHA);
      expect(r.outputs?.verified_at).toBe(ISO_TS);
    } finally {
      srv.close();
    }
  });

  it("invalid → exit 1, INVALID", async () => {
    const srv = await startServer([{ status: 200, body: refusalBody(TARGET_SHA, "invalid") }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_INVALID");
    } finally { srv.close(); }
  });

  it("malformed_signature → exit 1, INVALID", async () => {
    const srv = await startServer([{ status: 200, body: refusalBody(TARGET_SHA, "malformed_signature") }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_INVALID");
    } finally { srv.close(); }
  });

  it("unknown_key → exit 1, UNVERIFIED", async () => {
    const srv = await startServer([{ status: 200, body: refusalBody(TARGET_SHA, "unknown_key") }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_UNVERIFIED");
    } finally { srv.close(); }
  });

  it("SHA mismatch → exit 1, SHA_MISMATCH, api_sha/reason/verified_at populated (SIG-R169-DIAG-01)", async () => {
    const srv = await startServer([{ status: 200, body: validBody(OTHER_SHA) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_SHA_MISMATCH");
      expect(r.outputs?.api_sha).toBe(OTHER_SHA);
      expect(r.outputs?.reason).toBe("valid");
      expect(r.outputs?.verified_at).toBe(ISO_TS);
    } finally { srv.close(); }
  });
});

describe("R169 SIG runtime — HTTP error cases", () => {
  it("500 permanent → exit 1, HTTP_ERROR, attempts=3", async () => {
    const body = JSON.stringify({ message: "server error" });
    const srv = await startServer([
      { status: 500, body },
      { status: 500, body },
      { status: 500, body },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_HTTP_ERROR");
      expect(r.outputs?.attempts).toBe("3");
    } finally { srv.close(); }
  });

  it("401 → exit 1, HTTP_ERROR, attempts=1 (no retry)", async () => {
    const srv = await startServer([{ status: 401, body: JSON.stringify({ message: "unauthorized" }) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_HTTP_ERROR");
      expect(r.outputs?.attempts).toBe("1");
    } finally { srv.close(); }
  });

  it("404 → exit 1, HTTP_ERROR, attempts=1 (no retry)", async () => {
    const srv = await startServer([{ status: 404, body: JSON.stringify({ message: "not found" }) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_HTTP_ERROR");
      expect(r.outputs?.attempts).toBe("1");
    } finally { srv.close(); }
  });
});

describe("R169 SIG runtime — JSON/schema error cases", () => {
  it("malformed JSON → exit 1, MALFORMED_JSON, attempts=3", async () => {
    const srv = await startServer([
      { status: 200, body: "{not valid json" },
      { status: 200, body: "{not valid json" },
      { status: 200, body: "{not valid json" },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_MALFORMED_JSON");
      expect(r.outputs?.attempts).toBe("3");
    } finally { srv.close(); }
  });

  it("schema missing verification → exit 1, SCHEMA_ERROR", async () => {
    const srv = await startServer([
      { status: 200, body: JSON.stringify({ sha: TARGET_SHA, commit: {} }) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { srv.close(); }
  });

  it("verified_at absent → exit 1, SCHEMA_ERROR", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "valid" } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { srv.close(); }
  });

  it("verified_at = 'foo' → exit 1, SCHEMA_ERROR (SIG-R169-SCHEMA-01)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "valid", verified_at: "foo" } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { srv.close(); }
  });

  it("verified_at = '2026' (year only) → exit 1, SCHEMA_ERROR", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "valid", verified_at: "2026" } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { srv.close(); }
  });
});

describe("R169 SIG runtime — config error cases", () => {
  it("missing TARGET_SHA → exit 2, CONFIG_ERROR", () => {
    const r = runScriptSync({
      GITHUB_API_URL: "http://127.0.0.1:1",
      GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "fake-token",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("missing GITHUB_TOKEN → exit 2, CONFIG_ERROR", () => {
    const r = runScriptSync({
      TARGET_SHA,
      GITHUB_API_URL: "http://127.0.0.1:1",
      GITHUB_REPOSITORY: "test/repo",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("test mode rejects non-loopback URL → exit 2, CONFIG_ERROR", () => {
    const r = runScriptSync({
      TARGET_SHA,
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "fake-token",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });
});
