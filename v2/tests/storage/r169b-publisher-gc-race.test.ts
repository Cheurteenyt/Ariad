/**
 * R169B-STEP3 — Publisher/GC race test (GPT 5.6 §15 — C2).
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * Validates the safety of concurrent Publisher vs GC operations:
 *
 *   1. STALE plan detection (in-process, deterministic):
 *      - Publish 4 generations.
 *      - Plan GC (retainCount=2) → the plan targets ids[0] for deletion.
 *      - Between plan and apply, publish a 5th generation (which
 *        increments the CAS revision).
 *      - Apply the GC plan — it MUST refuse with `GC_PLAN_STALE` and
 *        delete NOTHING. All 5 generations (including the new active)
 *        MUST remain on disk.
 *
 *   2. No-race GC succeeds (in-process, deterministic):
 *      - Publish 4 generations, plan GC (retainCount=2), apply immediately.
 *      - The oldest (ids[0]) is deleted; the active (ids[3]) and the
 *        2 most-recent non-active (ids[2], ids[1]) are retained.
 *
 *   3. No-race GC with retainCount=N (N = total generations) deletes nothing.
 *
 *   4. Multi-process race (real child processes via tsx):
 *      - Spawn two children simultaneously: one runs plan+apply GC,
 *        the other publishes a new generation.
 *      - At least one operation MUST make progress (publisher succeeds
 *        OR GC applies OR GC returns STALE).
 *      - In ALL outcomes, the final state MUST be consistent:
 *          - Exactly one active generation in the manifest.
 *          - The active generation's DB exists on disk.
 *          - The CAS catalog has exactly one ACTIVE entry matching
 *            the manifest's active.
 *          - No DELETING entries left over (no partial deletes).
 *          - Every .db file in generations/ has a corresponding ACTIVE
 *            or DELETED catalog entry (no orphans).
 *          - Every ACTIVE catalog entry has a corresponding .db file
 *            (no catalog ghosts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import {
  reserveGenerationStaging,
  prepareGenerationForPublication,
  publishPreparedGeneration,
} from "../../src/storage/generation-publisher.js";
import {
  planGenerationGc,
  applyGenerationGcPlan,
} from "../../src/storage/generation-gc.js";
import { activeManifestPath, generationsDir } from "../../src/storage/generation-paths.js";
import { openCasStore } from "../../src/storage/internal/generation-cas-store.js";
import {
  freshCacheRoot,
  createValidStagingDb,
  FIXTURE_PROJECT_NAME,
} from "../helpers/r169b-publisher-fixtures.js";

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = freshCacheRoot("r169b-pubgc-");
});

afterEach(() => {
  try { rmSync(cacheRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── Helper: publish N generations, return their IDs in order ────────

function publishNGenerations(n: number): string[] {
  const ids: string[] = [];
  let expectedActive: string | null = null;
  for (let i = 0; i < n; i++) {
    const r = reserveGenerationStaging(FIXTURE_PROJECT_NAME, { cacheRoot });
    const { close } = createValidStagingDb(r.stagingPath);
    close();
    const p = prepareGenerationForPublication(r);
    const result = publishPreparedGeneration(
      p,
      { expectedActiveGenerationId: expectedActive },
      { cacheRoot },
    );
    ids.push(result.generationId);
    expectedActive = result.generationId;
  }
  return ids;
}

function listGenerationDbFiles(): string[] {
  const dir = generationsDir(FIXTURE_PROJECT_NAME, cacheRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
}

// ─── In-process race tests ─────────────────────────────────────────────

describe("R169B-STEP3 — Publisher/GC race (C2)", () => {
  it("STALE: a publish between plan and apply makes the plan stale (no deletions)", () => {
    // 1. Publish 4 generations. The active is ids[3].
    //    retainCount=2 → planner retains {ids[3], ids[2], ids[1]} and
    //    targets ids[0] for deletion.
    const ids = publishNGenerations(4);
    expect(ids.length).toBe(4);
    expect(listGenerationDbFiles().length).toBe(4);

    // 2. Plan GC with retainCount=2.
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 2 });
    expect(plan.delete.length).toBe(1);
    expect(plan.delete[0].generationId).toBe(ids[0]);
    const revisionAtPlan = plan.casRevision;

    // 3. Publish a 5th generation between plan and apply. This bumps
    //    the CAS revision.
    const r = reserveGenerationStaging(FIXTURE_PROJECT_NAME, { cacheRoot });
    const { close } = createValidStagingDb(r.stagingPath);
    close();
    const p = prepareGenerationForPublication(r);
    const pubResult = publishPreparedGeneration(
      p,
      { expectedActiveGenerationId: ids[3] },
      { cacheRoot },
    );
    const newActiveId = pubResult.generationId;

    // 4. The CAS revision MUST have bumped.
    const cas1 = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    const revisionAfterPublish = cas1.getRevision();
    cas1.close();
    expect(revisionAfterPublish).toBeGreaterThan(revisionAtPlan);

    // 5. Apply the (now stale) plan. It MUST refuse with GC_PLAN_STALE
    //    and delete nothing.
    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("GC_PLAN_STALE");
    expect(result.deletedGenerations.length).toBe(0);
    expect(result.deletedTmp.length).toBe(0);

    // 6. All 5 generations (4 originals + 1 new) MUST still be on disk.
    expect(listGenerationDbFiles().length).toBe(5);

    // 7. The active is the new generation.
    const manifestPath = activeManifestPath(FIXTURE_PROJECT_NAME, cacheRoot);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.generationId).toBe(newActiveId);

    // 8. The CAS active matches.
    const cas2 = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    expect(cas2.getActiveGenerationId()).toBe(newActiveId);
    cas2.close();
  });

  it("OK: plan→apply with no intervening publish deletes the oldest generation", () => {
    // 1. Publish 4 generations.
    const ids = publishNGenerations(4);
    expect(listGenerationDbFiles().length).toBe(4);

    // 2. Plan GC with retainCount=2 → targets ids[0] for deletion.
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 2 });
    expect(plan.delete.length).toBe(1);
    expect(plan.delete[0].generationId).toBe(ids[0]);

    // 3. Apply immediately (no publish in between).
    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations.length).toBe(1);
    expect(result.deletedGenerations[0]).toBe(ids[0]);

    // 4. The oldest generation's DB and metadata are gone.
    const dbFiles = listGenerationDbFiles();
    expect(dbFiles.length).toBe(3);
    expect(dbFiles).not.toContain(`generation-${ids[0]}.db`);
    expect(dbFiles).toContain(`generation-${ids[1]}.db`);
    expect(dbFiles).toContain(`generation-${ids[2]}.db`);
    expect(dbFiles).toContain(`generation-${ids[3]}.db`);

    // 5. The active is still the 4th generation.
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    expect(cas.getActiveGenerationId()).toBe(ids[3]);
    // The deleted generation's catalog entry is now DELETED.
    const deletedEntry = cas.getGenerationCatalogEntry(ids[0]);
    expect(deletedEntry?.status).toBe("DELETED");
    cas.close();
  });

  it("OK: GC plan with retainCount=N (where N = total generations) deletes nothing", () => {
    // 1. Publish 3 generations.
    publishNGenerations(3);

    // 2. Plan with retainCount=3 → delete list is empty (active + 3
    //    previous = 4 retained, but only 3 exist).
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 3 });
    expect(plan.delete.length).toBe(0);

    // 3. Apply → no deletions.
    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations.length).toBe(0);
    expect(listGenerationDbFiles().length).toBe(3);
  });

  it("OK: GC plan with retainCount=0 deletes all non-active, non-pinned generations", () => {
    // 1. Publish 4 generations.
    const ids = publishNGenerations(4);
    expect(listGenerationDbFiles().length).toBe(4);

    // 2. Plan with retainCount=0 → retains only the active. The other
    //    3 are targeted for deletion.
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 0 });
    expect(plan.delete.length).toBe(3);
    // The delete list MUST NOT contain the active (ids[3]).
    const deleteIds = plan.delete.map((e) => e.generationId);
    expect(deleteIds).not.toContain(ids[3]);
    expect(deleteIds.sort()).toEqual([ids[0], ids[1], ids[2]].sort());

    // 3. Apply → all 3 are deleted.
    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations.length).toBe(3);
    expect(listGenerationDbFiles().length).toBe(1);
    expect(listGenerationDbFiles()).toContain(`generation-${ids[3]}.db`);

    // 4. The active is still ids[3].
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    expect(cas.getActiveGenerationId()).toBe(ids[3]);
    cas.close();
  });

  // ─── Multi-process race test ────────────────────────────────────────

  it("MULTI-PROCESS: concurrent publisher and GC end in a consistent state", () => {
    // 1. Publish 4 generations in-process to set up the initial state
    //    (so the GC plan has something to delete).
    const ids = publishNGenerations(4);
    expect(listGenerationDbFiles().length).toBe(4);

    // 2. Write two child scripts: one runs plan+apply GC, the other
    //    publishes a 5th generation. Both are spawned simultaneously.
    const V2_ROOT = path.resolve(__dirname, "../..");
    const SRC_ROOT = path.join(V2_ROOT, "src");
    const TESTS_ROOT = path.join(V2_ROOT, "tests");
    const TSX_BIN = path.join(V2_ROOT, "node_modules/.bin/tsx");

    const gcChildScript = `
import { planGenerationGc, applyGenerationGcPlan } from ${JSON.stringify(SRC_ROOT + "/storage/generation-gc.ts")};
import { FIXTURE_PROJECT_NAME } from ${JSON.stringify(TESTS_ROOT + "/helpers/r169b-publisher-fixtures.ts")};

try {
  const cacheRoot = process.argv[2];
  const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 2 });
  const result = applyGenerationGcPlan(plan, { cacheRoot });
  console.log(JSON.stringify({
    ok: true,
    role: "gc",
    applied: result.applied,
    reason: result.reason,
    deleted: result.deletedGenerations,
  }));
} catch (e) {
  console.log(JSON.stringify({
    ok: false,
    role: "gc",
    code: e?.code || "UNKNOWN",
    message: e?.message || String(e),
  }));
}
`;

    const pubChildScript = `
import { reserveGenerationStaging, prepareGenerationForPublication, publishPreparedGeneration } from ${JSON.stringify(SRC_ROOT + "/storage/generation-publisher.ts")};
import { createValidStagingDb, FIXTURE_PROJECT_NAME } from ${JSON.stringify(TESTS_ROOT + "/helpers/r169b-publisher-fixtures.ts")};

try {
  const cacheRoot = process.argv[2];
  const expectedActive = process.argv[3];
  const r = reserveGenerationStaging(FIXTURE_PROJECT_NAME, { cacheRoot });
  const { close } = createValidStagingDb(r.stagingPath);
  close();
  const p = prepareGenerationForPublication(r);
  const result = publishPreparedGeneration(
    p,
    { expectedActiveGenerationId: expectedActive === "null" ? null : expectedActive },
    { cacheRoot },
  );
  console.log(JSON.stringify({
    ok: true,
    role: "publisher",
    generationId: result.generationId,
  }));
} catch (e) {
  console.log(JSON.stringify({
    ok: false,
    role: "publisher",
    code: e?.code || "UNKNOWN",
    message: e?.message || String(e),
  }));
}
`;

    const parentScript = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const tsx = ${JSON.stringify(TSX_BIN)};
const cwd = ${JSON.stringify(V2_ROOT)};
const cacheRoot = process.argv[2];
const expectedActive = process.argv[3];
const env = { ...process.env, NODE_OPTIONS: "" };

const gcScript = ${JSON.stringify(gcChildScript)};
const pubScript = ${JSON.stringify(pubChildScript)};
const gcPath = path.join(os.tmpdir(), "r169b-pubgc-gc-" + process.pid + ".ts");
const pubPath = path.join(os.tmpdir(), "r169b-pubgc-pub-" + process.pid + ".ts");
fs.writeFileSync(gcPath, gcScript);
fs.writeFileSync(pubPath, pubScript);

const gc = spawn(tsx, [gcPath, cacheRoot], { stdio: ["pipe", "pipe", "pipe"], cwd, env });
const pub = spawn(tsx, [pubPath, cacheRoot, expectedActive], { stdio: ["pipe", "pipe", "pipe"], cwd, env });

let gcOut = "", pubOut = "";
gc.stdout.on("data", (d) => gcOut += d);
pub.stdout.on("data", (d) => pubOut += d);

Promise.all([
  new Promise((res) => gc.on("close", () => res(gcOut))),
  new Promise((res) => pub.on("close", () => res(pubOut))),
]).then(([g, p]) => {
  try { fs.unlinkSync(gcPath); } catch {}
  try { fs.unlinkSync(pubPath); } catch {}
  console.log(JSON.stringify({ gc: g.trim(), pub: p.trim() }));
});
`;

    const parentPath = join(tmpdir(), `r169b-pubgc-parent-${process.pid}-${Date.now()}.js`);
    writeFileSync(parentPath, parentScript, "utf-8");

    try {
      const result = spawnSync(process.execPath, [parentPath, cacheRoot, ids[3]], {
        encoding: "utf-8",
        timeout: 60000,
        cwd: path.resolve(__dirname, "../.."),
      });
      expect(result.status).toBe(0);

      const stdout = (result.stdout || "").trim();
      const lines = stdout.split("\n");
      let combined: { gc: string; pub: string } | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.gc !== undefined && parsed.pub !== undefined) {
            combined = parsed;
            break;
          }
        } catch { continue; }
      }
      expect(combined).not.toBeNull();
      const gcResult = JSON.parse(combined!.gc);
      const pubResult = JSON.parse(combined!.pub);

      // Both children MUST have produced a result (ok or error).
      expect(gcResult).toBeDefined();
      expect(pubResult).toBeDefined();

      // Consistency checks (regardless of who won the race):
      // 1. The active manifest exists and points at a generation that exists on disk.
      const manifestPath = activeManifestPath(FIXTURE_PROJECT_NAME, cacheRoot);
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const activeId = manifest.generationId;
      expect(activeId).toBeTruthy();

      // 2. The active generation's DB file exists.
      const dbFiles = listGenerationDbFiles();
      expect(dbFiles).toContain(`generation-${activeId}.db`);

      // 3. The CAS active matches the manifest.
      const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
      expect(cas.getActiveGenerationId()).toBe(activeId);
      // 4. The active's catalog entry is ACTIVE (not DELETING/DELETED).
      const activeEntry = cas.getGenerationCatalogEntry(activeId);
      expect(activeEntry).toBeDefined();
      expect(activeEntry!.status).toBe("ACTIVE");
      // 5. No DELETING entries left over (GC either completed or didn't start).
      const deleting = cas.listCatalogEntriesByStatus("DELETING");
      expect(deleting.length).toBe(0);
      cas.close();

      // 6. Every .db file in generations/ has a corresponding catalog entry
      //    (no orphan DBs).
      const cas2 = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
      for (const f of dbFiles) {
        const gid = f.replace(/^generation-/, "").replace(/\.db$/, "");
        const entry = cas2.getGenerationCatalogEntry(gid);
        expect(entry).toBeDefined();
        expect(entry!.status === "ACTIVE" || entry!.status === "DELETED").toBe(true);
      }
      cas2.close();

      // 7. Every ACTIVE catalog entry has a corresponding .db file.
      const cas3 = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
      const activeEntries = cas3.listCatalogEntriesByStatus("ACTIVE");
      cas3.close();
      for (const e of activeEntries) {
        expect(dbFiles).toContain(`generation-${e.generationId}.db`);
      }

      // 8. At least one of the two children made progress.
      //    - If the publisher won, pubResult.ok === true.
      //    - If the GC won, gcResult.applied === true.
      //    - If the publisher committed between plan and apply,
      //      gcResult.reason === "GC_PLAN_STALE".
      //    - If the GC held the lock when the publisher tried to
      //      BEGIN IMMEDIATE, pubResult.code === "PUBLICATION_CAS_BUSY".
      //    - If the GC committed between the publisher's reserve and
      //      its BEGIN IMMEDIATE, pubResult.code === "PUBLICATION_CAS_MISMATCH".
      const publisherSucceeded = pubResult.ok === true;
      const gcApplied = gcResult.applied === true;
      const gcStale = gcResult.reason === "GC_PLAN_STALE";
      const publisherBusy = pubResult.code === "PUBLICATION_CAS_BUSY";
      const publisherMismatch = pubResult.code === "PUBLICATION_CAS_MISMATCH";
      expect(publisherSucceeded || gcApplied || gcStale || publisherBusy || publisherMismatch).toBe(true);
    } finally {
      try { require("node:fs").unlinkSync(parentPath); } catch { /* best effort */ }
    }
  }, 90000);
});
