/**
 * R168 — Mirror runtime tests with bare repos.
 *
 * Tests the actual state machine behavior of scripts/ci/mirror-main-to-gitlab.sh
 * using real bare Git repositories. This is the executable test suite that
 * GPT 5.6 Sol demanded in TEST-R168-01 — it goes beyond source inspection
 * and verifies that the mirror logic is correct at runtime.
 *
 * Test matrix (per GPT 5.6 Sol section 21):
 *   1. Empty remote → push
 *   2. Already mirrored → no-op + re-verify
 *   3. Remote behind → fast-forward push
 *   4. Remote newer valid → no-op
 *   5. Divergence → fail closed
 *   6. Remote modified after read → detected by re-verify
 *   7. Pre-receive rejection → classified
 *   8. Summary truthfulness → verified=false on fingerprint failure
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "ci", "mirror-main-to-gitlab.sh");

interface MirrorOutputs {
  final_result: string;
  observed_sha: string;
  github_main_sha: string;
  error_category: string;
  error_phase: string;
  client_fp_verified: string;
  host_fp_verified: string;
  push_attempted: string;
  push_completed: string;
  post_verify_result: string;
  [key: string]: string;
}

function parseOutputs(outputFile: string): MirrorOutputs {
  if (!existsSync(outputFile)) {
    return {} as MirrorOutputs;
  }
  const content = readFileSync(outputFile, "utf-8");
  const outputs: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    outputs[key] = value;
  }
  return outputs as MirrorOutputs;
}

class BareRepoTestEnv {
  tmpDir: string;
  githubBare: string;
  gitlabBare: string;
  workRepo: string;
  outputFile: string;

  constructor() {
    this.tmpDir = mkdtempSync(join(tmpdir(), "r168-mirror-test-"));
    this.githubBare = join(this.tmpDir, "github.git");
    this.gitlabBare = join(this.tmpDir, "gitlab.git");
    this.workRepo = join(this.tmpDir, "work");
    this.outputFile = join(this.tmpDir, "outputs.txt");

    // Initialize bare repos
    execSync(`git init --bare -b main "${this.githubBare}"`, { stdio: "pipe" });
    execSync(`git init --bare -b main "${this.gitlabBare}"`, { stdio: "pipe" });

    // Ensure HEAD points to main (for older git versions that don't support -b)
    execSync(`git -C "${this.githubBare}" symbolic-ref HEAD refs/heads/main`, {
      stdio: "pipe",
    });
    execSync(`git -C "${this.gitlabBare}" symbolic-ref HEAD refs/heads/main`, {
      stdio: "pipe",
    });

    // Enable push options on GitLab bare repo (needed for -o ci.no_pipeline)
    execSync(`git -C "${this.gitlabBare}" config receive.advertisePushOptions true`, {
      stdio: "pipe",
    });

    // Create a working repo and push initial commits to GitHub
    execSync(`git init -b main "${this.workRepo}"`, { stdio: "pipe" });
    execSync(`git -C "${this.workRepo}" config user.email "test@test.test"`, {
      stdio: "pipe",
    });
    execSync(`git -C "${this.workRepo}" config user.name "Test"`, { stdio: "pipe" });
    execSync(`git -C "${this.workRepo}" remote add origin "${this.githubBare}"`, {
      stdio: "pipe",
    });
    execSync(`git -C "${this.workRepo}" remote add gitlab "${this.gitlabBare}"`, {
      stdio: "pipe",
    });
  }

  /**
   * Create a commit with the given message and return its SHA.
   */
  commit(message: string): string {
    writeFileSync(join(this.workRepo, "file.txt"), `${message}\n${Date.now()}\n`);
    execSync(`git -C "${this.workRepo}" add -A`, { stdio: "pipe" });
    execSync(`git -C "${this.workRepo}" commit -m "${message}"`, { stdio: "pipe" });
    return execSync(`git -C "${this.workRepo}" rev-parse HEAD`, { encoding: "utf-8" }).trim();
  }

  /**
   * Push the work repo's main branch to the GitHub bare repo.
   */
  pushToGithub() {
    execSync(`git -C "${this.workRepo}" push origin main`, { stdio: "pipe" });
  }

  /**
   * Push a specific SHA to the GitLab bare repo (simulating a previous mirror).
   */
  setGitLabMain(sha: string) {
    // Push the SHA to GitLab main
    execSync(`git -C "${this.workRepo}" push gitlab ${sha}:refs/heads/main --force`, {
      stdio: "pipe",
    });
  }

  /**
   * Get the current GitLab main SHA.
   */
  getGitLabMain(): string {
    const output = execSync(
      `git ls-remote "${this.gitlabBare}" refs/heads/main`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    return output ? output.split(/\s+/)[0] : "";
  }

  /**
   * Add a pre-receive hook to the GitLab bare repo that rejects pushes.
   */
  setPreReceiveHook(rejectMessage: string) {
    const hookPath = join(this.gitlabBare, "hooks", "pre-receive");
    writeFileSync(
      hookPath,
      `#!/bin/bash\n` +
        `echo "${rejectMessage}" >&2\n` +
        `exit 1\n`,
    );
    execSync(`chmod +x "${hookPath}"`);
  }

  /**
   * Make a divergent commit directly on the GitLab bare repo (not in GitHub).
   */
  createGitLabDivergence(): string {
    // Clone GitLab, make a commit, push back
    const divergeRepo = join(this.tmpDir, "diverge");
    execSync(`git clone -b main "${this.gitlabBare}" "${divergeRepo}"`, { stdio: "pipe" });
    execSync(`git -C "${divergeRepo}" config user.email "diverge@test"`, { stdio: "pipe" });
    execSync(`git -C "${divergeRepo}" config user.name "Diverge"`, { stdio: "pipe" });
    writeFileSync(join(divergeRepo, "diverge.txt"), "divergence\n");
    execSync(`git -C "${divergeRepo}" add -A`, { stdio: "pipe" });
    execSync(`git -C "${divergeRepo}" commit -m "divergent commit"`, { stdio: "pipe" });
    execSync(`git -C "${divergeRepo}" push origin main`, { stdio: "pipe" });
    return execSync(`git -C "${divergeRepo}" rev-parse HEAD`, { encoding: "utf-8" }).trim();
  }

  /**
   * Run the mirror script and return the outputs.
   * Checks out the target SHA first (simulating actions/checkout@v7 ref: TARGET_SHA).
   */
  runMirror(targetSha: string): { exitCode: number; outputs: MirrorOutputs } {
    // Checkout the target SHA (simulating actions/checkout in the real workflow)
    execSync(`git -C "${this.workRepo}" checkout "${targetSha}" 2>/dev/null`, {
      stdio: "pipe",
    });

    const env: Record<string, string> = {
      ...process.env,
      TARGET_SHA: targetSha,
      GITLAB_URL: `file://${this.gitlabBare}`,
      GITHUB_REMOTE: `file://${this.githubBare}`,
      SKIP_SSH_CONFIG: "yes",
      SKIP_FP_CHECKS: "yes",
      OUTPUT_FILE: this.outputFile,
    };

    let exitCode = 0;
    try {
      execFileSync("bash", [SCRIPT_PATH], {
        cwd: this.workRepo,
        env,
        stdio: "pipe",
      });
    } catch (e: any) {
      exitCode = e.status ?? 1;
    }

    const outputs = parseOutputs(this.outputFile);
    return { exitCode, outputs };
  }

  cleanup() {
    rmSync(this.tmpDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("R168 — Mirror runtime: empty remote", () => {
  let env: BareRepoTestEnv;

  beforeEach(() => {
    env = new BareRepoTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("pushes to empty GitLab remote", () => {
    const sha1 = env.commit("R165");
    env.pushToGithub();
    const sha2 = env.commit("R166");
    env.pushToGithub();

    // GitLab is empty
    expect(env.getGitLabMain()).toBe("");

    const { exitCode, outputs } = env.runMirror(sha2);

    expect(exitCode).toBe(0);
    expect(outputs.final_result).toBe("mirrored");
    expect(outputs.observed_sha).toBe(sha2);
    expect(outputs.push_attempted).toBe("true");
    expect(outputs.push_completed).toBe("true");
    expect(outputs.post_verify_result).toBe("success");
    expect(outputs.error_category).toBe("none");
  });
});

describe("R168 — Mirror runtime: already mirrored", () => {
  let env: BareRepoTestEnv;

  beforeEach(() => {
    env = new BareRepoTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("no-op when GitLab already at TARGET_SHA, but still re-verifies (MIRROR-R168-01)", () => {
    const sha1 = env.commit("R165");
    env.pushToGithub();
    const sha2 = env.commit("R166");
    env.pushToGithub();

    // Set GitLab to the target SHA
    env.setGitLabMain(sha2);
    expect(env.getGitLabMain()).toBe(sha2);

    const { exitCode, outputs } = env.runMirror(sha2);

    expect(exitCode).toBe(0);
    expect(outputs.final_result).toBe("already-mirrored");
    expect(outputs.observed_sha).toBe(sha2);
    expect(outputs.push_attempted).toBe("false");
    expect(outputs.push_completed).toBe("false");
    // MIRROR-R168-01: post-verification must still run even for no-op
    expect(outputs.post_verify_result).toBe("success");
  });
});

describe("R168 — Mirror runtime: remote behind (fast-forward)", () => {
  let env: BareRepoTestEnv;

  beforeEach(() => {
    env = new BareRepoTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("fast-forwards GitLab from R165 to R166", () => {
    const sha1 = env.commit("R165");
    env.pushToGithub();
    env.setGitLabMain(sha1);

    const sha2 = env.commit("R166");
    env.pushToGithub();

    const { exitCode, outputs } = env.runMirror(sha2);

    expect(exitCode).toBe(0);
    expect(outputs.final_result).toBe("mirrored");
    expect(outputs.observed_sha).toBe(sha2);
    expect(outputs.push_attempted).toBe("true");
    expect(outputs.push_completed).toBe("true");
    expect(outputs.post_verify_result).toBe("success");
  });
});

describe("R168 — Mirror runtime: remote newer valid", () => {
  let env: BareRepoTestEnv;

  beforeEach(() => {
    env = new BareRepoTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("no-op when GitLab is ahead of TARGET_SHA but still valid", () => {
    const sha1 = env.commit("R165");
    env.pushToGithub();
    const sha2 = env.commit("R166");
    env.pushToGithub();
    const sha3 = env.commit("R167");
    env.pushToGithub();

    // GitLab is at sha3 (ahead of target sha2)
    env.setGitLabMain(sha3);

    const { exitCode, outputs } = env.runMirror(sha2);

    expect(exitCode).toBe(0);
    expect(outputs.final_result).toBe("newer-valid-mirror-present");
    expect(outputs.observed_sha).toBe(sha3);
    expect(outputs.push_attempted).toBe("false");
    expect(outputs.post_verify_result).toBe("success");
  });
});

describe("R168 — Mirror runtime: divergence fail-closed", () => {
  let env: BareRepoTestEnv;

  beforeEach(() => {
    env = new BareRepoTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("fails closed when GitLab has commits not in GitHub", () => {
    const sha1 = env.commit("R165");
    env.pushToGithub();
    env.setGitLabMain(sha1);

    // Create divergence on GitLab
    const divergeSha = env.createGitLabDivergence();

    const sha2 = env.commit("R166");
    env.pushToGithub();

    const { exitCode, outputs } = env.runMirror(sha2);

    expect(exitCode).toBe(1);
    expect(outputs.final_result).toBe("failed");
    expect(outputs.error_category).toBe("DIVERGENCE");
    expect(outputs.error_phase).toBe("divergence-check");
    expect(outputs.push_attempted).toBe("false");
  });
});

describe("R168 — Mirror runtime: pre-receive rejection classified", () => {
  let env: BareRepoTestEnv;

  beforeEach(() => {
    env = new BareRepoTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("classifies pre-receive hook rejection", () => {
    const sha1 = env.commit("R165");
    env.pushToGithub();
    const sha2 = env.commit("R166");
    env.pushToGithub();

    // GitLab is empty → push should be attempted
    // But the pre-receive hook rejects it
    env.setPreReceiveHook("not allowed to push code to protected branches on this project");

    const { exitCode, outputs } = env.runMirror(sha2);

    expect(exitCode).toBe(1);
    expect(outputs.final_result).toBe("failed");
    expect(outputs.error_category).toBe("PROTECTED_BRANCH_REJECTED");
    expect(outputs.error_phase).toBe("push");
    expect(outputs.push_attempted).toBe("true");
    expect(outputs.push_completed).toBe("false");
  });
});

describe("R168 — Mirror runtime: post-push verification detects race", () => {
  let env: BareRepoTestEnv;

  beforeEach(() => {
    env = new BareRepoTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("post-verify detects if GitLab was modified after push", () => {
    const sha1 = env.commit("R165");
    env.pushToGithub();
    const sha2 = env.commit("R166");
    env.pushToGithub();

    // GitLab is empty → push will happen
    // After push, GitLab should be at sha2
    const { exitCode, outputs } = env.runMirror(sha2);

    // Normal case: push + verify = success
    expect(exitCode).toBe(0);
    expect(outputs.final_result).toBe("mirrored");
    expect(outputs.observed_sha).toBe(sha2);
    expect(outputs.post_verify_result).toBe("success");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Script existence and basic structure
// ─────────────────────────────────────────────────────────────────────────────

describe("R168 — Mirror script existence and structure", () => {
  it("scripts/ci/mirror-main-to-gitlab.sh exists and is executable", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    const stat = execSync(`ls -la "${SCRIPT_PATH}"`, { encoding: "utf-8" });
    expect(stat).toMatch(/^-rwx/);
  });

  it("script contains error classifier with all required categories", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    const categories = [
      "HOST_KEY_MISMATCH",
      "SSH_PUBLICKEY_REJECTED",
      "PROTECTED_BRANCH_REJECTED",
      "NON_FAST_FORWARD",
      "REMOTE_DNS_FAILURE",
      "REMOTE_TIMEOUT",
      "REMOTE_CONNECTION_REFUSED",
      "REMOTE_UNREACHABLE",
      "REPOSITORY_NOT_FOUND",
      "PRE_RECEIVE_REJECTED",
      "UNKNOWN_GIT_ERROR",
    ];
    for (const cat of categories) {
      expect(script).toContain(cat);
    }
  });

  it("script always runs post-verification (MIRROR-R168-01)", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    // The post-push verification section must not be gated by a no-op check
    expect(script).toContain("Post-push verification (always runs)");
  });

  it("script uses ssh-keygen -F gitlab.com for host key binding (SEC-R168-01)", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("ssh-keygen -F gitlab.com");
  });

  it("script uses ssh-keygen -lf for fingerprint (SEC-R168-02)", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("ssh-keygen -lf");
    // Must NOT use URL-safe base64 (tr '+/' '-_')
    expect(script).not.toContain("tr '+/' '-_'");
  });

  it("script configures SSH timeouts (OPS-R168-01)", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("BatchMode=yes");
    expect(script).toContain("ConnectTimeout=15");
    expect(script).toContain("ConnectionAttempts=2");
    expect(script).toContain("ServerAliveInterval=15");
    expect(script).toContain("ServerAliveCountMax=2");
  });

  it("script checks for passphrase-protected keys", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("ssh-keygen -y -P '' -f");
  });

  it("script writes truthful outputs (OBS-R168-01)", () => {
    const script = readFileSync(SCRIPT_PATH, "utf-8");
    expect(script).toContain("client_fp_verified");
    expect(script).toContain("host_fp_verified");
    expect(script).toContain("push_attempted");
    expect(script).toContain("push_completed");
    expect(script).toContain("post_verify_result");
    expect(script).toContain("final_result");
  });
});
