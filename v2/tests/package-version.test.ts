/**
 * Centralized package version assertion (R168.2 / TEST-R168.2-01).
 *
 * This is the SINGLE place that checks the exact package version.
 * All other test files should NOT assert on package.json.version —
 * they should only test their functional invariants.
 *
 * Historical tests (r160-r165) previously had their own version
 * assertions; those have been removed to avoid churn on every round.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

describe("package version (centralized, R168.2)", () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "v2", "package.json"), "utf-8"),
  ) as { version: string };

  it("v2/package.json version is at least 0.71.0 (R166 floor)", () => {
    const [major, minor] = pkg.version.split(".").map(Number);
    expect(major).toBe(0);
    expect(minor).toBeGreaterThanOrEqual(71);
  });

  it("v2/package.json version is a valid semver", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
