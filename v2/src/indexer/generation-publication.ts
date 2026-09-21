// v2/src/indexer/generation-publication.ts
// R192 (R169C): Atomic generation publication — indexer integration.
//
// Wires the merged-but-inactive R169B publisher primitives into the
// indexer's write path (see docs/architecture/ATOMIC_GENERATION_PUBLICATION.md).
// After a clean main-path run (errors=0 AND graph not stale — exactly the
// SUCCESS / SUCCESS_WITH_WARNINGS outcomes), the legacy DB is snapshotted
// with the SQLite online backup into the publisher-reserved staging file,
// then prepared (WAL finalize + validate + hash) and published under the
// CAS optimistic lock. Readers keep opening the legacy DB — the reader
// cutover is R169D; the generation store gives every successful run a
// complete, crash-consistent snapshot.
//
// Failure isolation: publication problems NEVER fail the index run. The
// legacy DB remains the product of record; failures surface through
// IndexResult.generationPublication (status='failed') and as an indexer
// warning so the run outcome downgrades to SUCCESS_WITH_WARNINGS.
//
// Platform: the R169B primitives are Linux-certified only (doc §12/§13);
// other platforms skip with a recorded reason. Env kill-switch:
// CBM_DISABLE_GENERATION_PUBLICATION=1.

import type Database from 'better-sqlite3';
import {
  discardGenerationReservation,
  discardPreparedGeneration,
  prepareGenerationForPublication,
  publishPreparedGeneration,
  reserveGenerationStaging,
} from '../storage/generation-publisher.js';
import { openCasStore } from '../storage/internal/generation-cas-store.js';

/** Env kill-switch: set to 1 to disable generation publication. */
export const GENERATION_PUBLICATION_DISABLED_ENV = 'CBM_DISABLE_GENERATION_PUBLICATION';

/** R192 (R169C): outcome of one publication attempt, embedded in IndexResult. */
export interface GenerationPublicationOutcome {
  status: 'published' | 'skipped' | 'failed';
  /** status='published': the new active generation ID. */
  generationId?: string;
  /** status='published': CAS dedup reused an identical existing generation. */
  deduped?: boolean;
  /** status='skipped': why the run did not publish. */
  reason?: string;
  /** status='failed': structured GenerationStoreError code when available. */
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface GenerationPublicationGateInput {
  platform: string;
  envDisabled: boolean;
  hasErrors: boolean;
  crossFileStale: boolean;
}

/**
 * Pure decision for whether a main-path run publishes a generation.
 * Publishable = Linux-certified platform + not disabled by env + clean
 * outcome (errors=0 AND graph not stale — the SUCCESS /
 * SUCCESS_WITH_WARNINGS precondition; STALE graphs fail the publisher's
 * `cross_file_calls_stale = 0` validation anyway).
 */
export function generationPublicationDecision(
  input: GenerationPublicationGateInput,
): { publish: boolean; reason?: string } {
  if (input.envDisabled) return { publish: false, reason: 'disabled-by-env' };
  if (input.platform !== 'linux') return { publish: false, reason: 'platform-not-certified' };
  if (input.hasErrors) return { publish: false, reason: 'outcome-with-errors' };
  if (input.crossFileStale) return { publish: false, reason: 'stale-graph' };
  return { publish: true };
}

/**
 * Publish the current state of the open legacy DB as a new generation.
 *
 * The caller has already decided eligibility via generationPublicationDecision.
 * Steps (doc §12.2): RESERVE → POPULATE (SQLite online backup into the
 * reserved 0-byte staging file — the backup reads a committed snapshot of
 * the live DB and initializes the reserved file in place, preserving its
 * 0600 mode) → FINALIZE/VALIDATE/HASH (prepareGenerationForPublication)
 * → PUBLISH (CAS-guarded, `expectedActiveGenerationId` = current active or
 * null for the first publication).
 *
 * Never throws: every failure is returned as status='failed' with the
 * structured code when available, after best-effort cleanup of the
 * reservation/prepared token (a token already mutated into CONSUMED state
 * is left for the GC/recovery sweep, which owns unreferenced artifacts).
 */
export async function publishGenerationSnapshot(
  db: Database.Database,
  params: { project: string; rootFingerprint?: string },
): Promise<GenerationPublicationOutcome> {
  const start = Date.now();
  let reservation: ReturnType<typeof reserveGenerationStaging> | undefined;
  let prepared: ReturnType<typeof prepareGenerationForPublication> | undefined;
  try {
    reservation = reserveGenerationStaging(params.project);
    await db.backup(reservation.stagingPath);
    prepared = prepareGenerationForPublication(
      reservation,
      params.rootFingerprint !== undefined ? { rootFingerprint: params.rootFingerprint } : undefined,
    );
    const cas = openCasStore(params.project);
    let expectedActive: string | null;
    try {
      expectedActive = cas.getActiveGenerationId();
    } finally {
      cas.close();
    }
    const published = publishPreparedGeneration(prepared, { expectedActiveGenerationId: expectedActive });
    return {
      status: 'published',
      generationId: published.generationId,
      deduped: published.cas.deduped,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    try {
      if (prepared !== undefined) {
        discardPreparedGeneration(prepared);
      } else if (reservation !== undefined) {
        discardGenerationReservation(reservation);
      }
    } catch {
      // CONSUMED tokens and unreferenced artifacts belong to the GC/recovery
      // sweep; cleanup failure must not mask the publication failure.
    }
    return {
      status: 'failed',
      errorCode: typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
}
