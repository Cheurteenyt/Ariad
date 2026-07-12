# Atomic Generation Publication — R169A Target Architecture

> **Status: FOUNDATION / INACTIVE**
>
> This document describes the **target architecture** for atomic generation
> publication in Codebase Memory V2. As of R169A the foundational pieces are
> merged (`v2/src/storage/generation-store.ts`,
> `v2/src/storage/generation-types.ts`,
> `v2/tests/storage/r169a-generation-store.test.ts`), but **no production
> code path calls them yet**. The indexer still writes to the legacy
> `<project>.db` path; readers still open the legacy DB directly.
>
> Nothing in this document describes active behavior. Every "does" statement
> is a target contract. The "current behavior" is unchanged from R168.1:
> publication is **not** atomic, and `DATA-CARRY-01` (P1) remains open.
>
> **Version:** 0.75.0
> **Semantics:** `CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8`,
> `CURRENT_DISCOVERY_POLICY_VERSION = 2`
> **Manifest format:** `CURRENT_GENERATION_MANIFEST_VERSION = 1`
> **Tracking round:** R169A (foundation). Activation rounds: R169B–R169E.

---

## 0. TL;DR

R169A lands the **plumbing** for atomic generation publication:
path helpers, manifest V1 types, a fail-closed read-only resolver, and an
atomic JSON writer. The pieces are independently tested, inert by default,
and impose **zero overhead** when unused.

Activation is staged across R169B–R169E:

| Round | Scope | Status |
|-------|-------|--------|
| R169A | Path helpers, manifest V1 types, resolver, atomic JSON writer | **MERGED — INACTIVE** |
| R169B | Indexer writes generation DBs under `generations/` + manifest | planned |
| R169C | Readers switch from `legacyCodeDbPath` → `resolveActiveCodeDb` | planned |
| R169D | GC policy (keep active + 2 previous) | planned |
| R169E | Legacy migration finish + DATA-CARRY-01 close | planned |

`DATA-CARRY-01` (P1) is **not** closed by R169A. It is closed only when
R169B+R169C are merged and the legacy fallback is removed from the hot path.

---

## 1. Goal

A reader of the code graph must see **either the old complete snapshot or
the new complete snapshot — never a partial publication**.

```
   reader sees:
     old complete snapshot
     OR
     new complete snapshot
     NEVER a partial publication
```

This is the contract that closes `DATA-CARRY-01` (P1). R169A delivers the
non-active foundation; R169B–R169E deliver activation, GC, migration, and
the formal close-out.

## 2. Invariants (specification section 4)

1. A published generation is **immutable**. Once a DB file is referenced by
   `active-generation.json`, no writer modifies or deletes it.
2. No writer modifies a DB that is currently referenced by
   `active-generation.json`.
3. A reader always sees a complete snapshot:
   - either the previously published generation (manifest still points to
     the old generation DB),
   - or the newly published generation (manifest now points to the new
     generation DB),
   - **never** a half-written DB or a manifest whose target does not
     exist.
4. The manifest swap is the only visible mutation. It happens via atomic
   rename of a pre-validated file.
5. The legacy DB is **only** used when no manifest exists. Once a manifest
   has been written, the legacy DB is no longer in the reader path; an
   invalid manifest never silently falls back to legacy.

## 3. Storage layout

All generation-store data lives under the platform cache directory:

```
<XDG_CACHE_HOME or ~/.cache>/
└── codebase-memory-mcp/                       # cbmCacheDir()
    ├── <project>.db                            # legacy DB (current behavior)
    └── projects/                               # generationStoreRoot()
        └── <sha256(project)>/                  # projectStoreDir()
            ├── active-generation.json          # manifest (the single pointer)
            ├── index-state.json                # diagnostics sidecar (no graph data)
            ├── generations/
            │   └── generation-<uuid>.db        # immutable published DB
            └── tmp/                            # staging area for new DBs
```

### 3.1 Project key = SHA-256 of project name

`projectStorageKey(project)` returns
`createHash("sha256").update(project, "utf8").digest("hex")`.

Why a hash and not the project name?

- **Path traversal:** project names like `../escape` cannot escape the
  store, because the key is a 64-char hex digest.
- **Separator injection:** `/`, `\`, `:` (Windows drive), NUL, etc. cannot
  corrupt the path.
- **Length / Unicode:** any project name collapses to a fixed-width
  directory name.
- **Collisions:** SHA-256 collision resistance is the only assumption; no
  human-readable name is trusted on the filesystem.

The original project name is **not** recoverable from the directory name.
It is stored inside the manifest (`project` field) and validated against
the requested project on every read.

### 3.2 Why `active-generation.json` is a single pointer

The manifest is the **only** file that decides which generation is
"active". Generation DBs in `generations/` are content — they never move,
never get overwritten, and never get renamed once published. Switching the
active generation is exactly one atomic rename of the manifest file.

This is what gives us the atomic-swap property: the manifest rename is
atomic on POSIX, and the new manifest points to a DB that has already been
fully written and fsynced.

### 3.3 `index-state.json` is diagnostics, not graph data

`index-state.json` records the operational state of the indexing process
(last attempt UUID, outcome, stale reason, recovery action). It is **not**
copied or moved during publication. A crash that leaves `index-state.json`
in an inconsistent state does not affect readers — they only look at
`active-generation.json`.

### 3.4 `tmp/` is scratch space

`tmp/` holds DB files while they are being built. Files in `tmp/` are
never read by readers. They are renamed into `generations/` only after
full validation. A crash leaves orphan files in `tmp/`; the GC reclaims
them.

## 4. Manifest schema V1

Stored as `active-generation.json`. The exact key set is enforced — **no
extra keys are allowed** for V1. A future incompatible change requires
bumping `formatVersion` and a migration plan.

### 4.1 Keys

| Key | Type | Constraint |
|---|---|---|
| `formatVersion` | integer | Must be `1`. Any other value → `MANIFEST_UNSUPPORTED_VERSION`. |
| `project` | string | Must match the requested project exactly. |
| `generationId` | string | Canonical UUID v4 (lowercase, with hyphens). |
| `dbFile` | string | Relative path from the project store directory. Must not contain `..`, must not be absolute, must not contain `\`. Example: `generations/generation-<uuid>.db`. |
| `createdAt` | string | ISO-8601 **with timezone**. `Z` or `±HH:MM`. |
| `rootFingerprint` | string | Non-empty. Stable fingerprint of the project root (e.g. `dev:ino`). |
| `extractorSemanticsVersion` | integer | `>= 0`. |
| `discoveryPolicyVersion` | integer | `>= 0`. |
| `nodeCount` | integer | `>= 0`. |
| `edgeCount` | integer | `>= 0`. |
| `fileCount` | integer | `>= 0`. |
| `sizeBytes` | integer | `>= 0`. |
| `sha256` | string | 64 lowercase hex chars. |

The exact set of keys is exported as `MANIFEST_V1_KEYS` in
`v2/src/storage/generation-types.ts`.

### 4.2 Validation rules

`validateGenerationManifest(value, expectedProject)` enforces:

1. `value` must be a JSON object (not array, not null).
2. **Exact key set.** Missing any of the 13 keys → `MANIFEST_SCHEMA_ERROR`.
   Adding any extra key → `MANIFEST_SCHEMA_ERROR`. This is intentional: V1
   is closed so that future versions can add keys without ambiguity.
3. `formatVersion === 1`. Any other value, including `2`, `null`, `""`,
   `1.0` → `MANIFEST_UNSUPPORTED_VERSION`.
4. `project === expectedProject`. → `MANIFEST_PROJECT_MISMATCH` on
   mismatch. This catches a manifest that was somehow copied between
   projects.
5. `generationId` matches the canonical UUID v4 regex
   `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
6. `dbFile` is a non-empty string, not absolute, contains no `..`
   segment, contains no `\`. → `MANIFEST_TARGET_OUTSIDE_STORE` on
   violation.
7. `createdAt` matches
   `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`.
   Date-only or no-timezone timestamps are rejected.
8. `rootFingerprint` is a non-empty string.
9. `extractorSemanticsVersion`, `discoveryPolicyVersion`, `nodeCount`,
   `edgeCount`, `fileCount`, `sizeBytes` are integers `>= 0`. Floats and
   negatives are rejected.
10. `sha256` matches `^[0-9a-f]{64}$`. Uppercase hex is rejected.
11. No string field contains `\n` or `\r`. This keeps the manifest a
    single-line-friendly record and prevents newline-injection tricks.

A manifest that fails any of these is **invalid** and triggers fail-closed
behavior in the resolver (section 8).

### 4.3 Example manifest

```json
{
  "formatVersion": 1,
  "project": "my-project",
  "generationId": "550e8400-e29b-41d4-a716-446655440000",
  "dbFile": "generations/generation-550e8400-e29b-41d4-a716-446655440000.db",
  "createdAt": "2026-07-13T00:00:00.000Z",
  "rootFingerprint": "/home/me/code/my-project:2049:1234567",
  "extractorSemanticsVersion": 8,
  "discoveryPolicyVersion": 2,
  "nodeCount": 12345,
  "edgeCount": 67890,
  "fileCount": 432,
  "sizeBytes": 9876543,
  "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
}
```

## 5. State machine overview

Publication is a sequence of states. Each transition is durable before
the next begins. A crash at any state has a deterministic recovery.

```
START
  │
  ▼
BUILD_STAGING     write generations/generation-<uuid>.db into tmp/
  │                 (sqlite build, fully populated, not yet visible)
  ▼
VALIDATE          open staging DB, run consistency checks
  │                 (row counts, sha256, schema version, root fingerprint)
  ▼
FINALIZE          fsync the staging DB file
  │                 (durability: DB content on disk before swap)
  ▼
CAS               move staging DB from tmp/ to generations/
  │                 (rename is atomic on POSIX; generations/ entry now exists)
  ▼
MANIFEST          write active-generation.json atomically (section 7)
  │                 (temp + fsync + rename + fsync dir)
  ▼
FINAL_STATE       new generation is live; old generation is now stale
                    (GC will eventually remove it)
```

Key properties:

- The DB is **fully written and fsynced** before the manifest is touched.
- The manifest swap is the **only** visible mutation to readers.
- The old generation DB remains on disk (and is still referenced by the
  old manifest content) until the new manifest is in place. A crash
  before the manifest rename leaves the old generation live.
- A crash after the manifest rename leaves the new generation live. The
  old generation DB becomes garbage and is collected by GC (section 10).

## 6. Durability ordering

The atomic writer enforces the following ordering, in this exact sequence:

1. **Create temp file** in the same directory as the target, using
   `openSync(tmpPath, "wx", 0o600)`. The `wx` flag fails if the file
   already exists — this prevents two concurrent writers from clobbering
   each other's temp file. Mode `0o600` keeps the file readable only by
   the owner.
2. **Write the complete content** to the temp file. Partial content is
   never visible to readers because the temp file is not the target name.
3. **fsync the temp file.** `fsyncSync(fd)`. This is the critical step:
   it forces the file **content** to stable storage. Without this, a
   crash after `rename` could leave a zero-length or partially-flushed
   file at the target path. On failure → `ATOMIC_FSYNC_FAILED`.
4. **Close the temp file.** `closeSync(fd)`.
5. **rename temp → target.** `renameSync(tmpPath, targetPath)`. This is
   atomic on POSIX: the target path is either the old file or the new
   file, never both, never neither. On failure → `ATOMIC_RENAME_FAILED`.
6. **fsync the directory.** Open the directory read-only and `fsync` it.
   This forces the directory entry (the rename) to stable storage.
   Without this, a crash could roll back the rename and leave the old
   file in place — which is correct for a writer (the old file is still
   valid) but undesirable for an indexer that wants confirmation that
   the new file is committed. Directory fsync is best-effort on some
   platforms (notably Windows); if it fails, we **do not** fail the
   write, because the rename itself has already succeeded.

The ordering can be summarized as:

```
fsync file  →  rename  →  fsync dir
```

Any deviation breaks the durability contract. In particular:

- `rename` before `fsync file` → a crash can leave the target empty.
- `fsync dir` before `rename` → useless; the rename hasn't happened yet.
- Skipping `fsync file` → on crash, the rename succeeds but the file
  content is lost.

This is implemented in `writeJsonAtomically(targetPath, value)` in
`v2/src/storage/generation-store.ts`.

## 7. Reader contract

The reader contract is the **only** thing readers need to know:

> **Resolve once. Open the resolved DB. Keep the handle.**

Concretely:

1. **Resolve once.** Call `resolveActiveCodeDb(project)` **once**, at the
   start of the read session. This returns a `ResolvedCodeDb`:
   - `{ source: "generation", dbPath, generationId, manifest }` — a
     published generation was found via the manifest.
   - `{ source: "legacy", dbPath, generationId: null }` — no manifest,
     but a legacy `<project>.db` exists.
   - `{ source: "missing", dbPath: null, generationId: null }` — neither
     exists.
2. **Open the resolved DB.** Use `resolved.dbPath` to open the SQLite
   file. Do not re-resolve.
3. **Keep the handle.** Hold the SQLite connection open for the duration
   of the read session. Even if a concurrent publication swaps the
   manifest, your handle still points to the generation you opened,
   which is **immutable** (section 2 invariant 1).

What the reader must **not** do:

- Re-resolve mid-session. The manifest may swap; the second resolution
  could return a different generation. This is fine for a new session,
  but a single session must use one DB.
- Open the DB by constructing the path manually. Always go through
  `resolveActiveCodeDb`. Direct path construction bypasses the manifest
  and the fail-closed contract.
- Hold the manifest file open. The manifest is read once, validated,
  and discarded. Only the DB handle is kept.

This contract is enforced by the `ResolvedCodeDb` type in
`v2/src/storage/generation-types.ts`. The discriminated union makes it
impossible to forget the `missing` case at compile time.

## 8. Legacy migration

The legacy DB lives at `<cbmCacheDir>/<project>.db`. It is the path used
by all current production code (indexer, readers, UI, MCP, CLI). R169A
does **not** remove this path. It does **not** write to it either. The
legacy path is kept as a fallback for the resolver.

The resolver's decision table:

| Manifest state | Legacy DB state | Resolver result |
|---|---|---|
| valid | (ignored) | `generation` |
| absent | exists | `legacy` |
| absent | absent | `missing` |
| invalid (any reason) | (ignored) | **FAIL CLOSED** — `GenerationStoreError` |
| manifest target missing | (ignored) | **FAIL CLOSED** — `MANIFEST_TARGET_MISSING` |
| manifest target outside store | (ignored) | **FAIL CLOSED** — `MANIFEST_TARGET_OUTSIDE_STORE` |
| manifest project mismatch | (ignored) | **FAIL CLOSED** — `MANIFEST_PROJECT_MISMATCH` |
| manifest is a symlink | (ignored) | **FAIL CLOSED** — `MANIFEST_SYMLINK_REJECTED` |
| manifest target is a symlink | (ignored) | **FAIL CLOSED** — `GENERATION_TARGET_SYMLINK_REJECTED` |

**The fail-closed rule is absolute.** An invalid manifest never silently
falls back to the legacy DB. The reasoning:

- A manifest that exists but is invalid is **evidence of corruption**.
  Falling back to legacy would hide that corruption and serve data that
  may be stale or wrong.
- The legacy DB may itself be corrupt or partial (it's the source of
  `DATA-CARRY-01`). Switching to it because the manifest is broken
  trades one bug for another.
- Operators should see the failure and repair the manifest. Silent
  fallback turns a hard failure into a soft data-correctness bug, which
  is exactly what R169 is supposed to eliminate.

Migration to generation-only operation happens in stages:

- **R169A (this round):** resolver exists, but no production code calls
  it. Legacy path is the only path used.
- **R169B:** indexer starts writing generation DBs alongside the legacy
  DB. Manifest is written. Resolver still not called by production
  readers.
- **R169C:** readers switch from `legacyCodeDbPath` to
  `resolveActiveCodeDb`. Legacy DB is still written as a fallback.
- **R169D–R169E:** legacy DB write is removed. Legacy DB is only read
  for projects that have not yet been re-indexed under the new path.
  Eventually the legacy path is removed entirely.

## 9. Failure taxonomy

The generation store uses **structured error codes**, never a single
`DB_ERROR` bucket. Each code corresponds to a specific failure mode with
a specific recovery action.

```typescript
type GenerationStoreErrorCode =
  | "GENERATION_STORE_CONFIG_ERROR"          // misconfiguration (e.g. bad store root)
  | "MANIFEST_PARSE_ERROR"                   // file unreadable or invalid JSON
  | "MANIFEST_SCHEMA_ERROR"                  // JSON valid but schema wrong
  | "MANIFEST_TARGET_MISSING"                // dbFile does not exist
  | "MANIFEST_TARGET_OUTSIDE_STORE"          // dbFile escapes the project store
  | "MANIFEST_PROJECT_MISMATCH"              // project field != requested project
  | "MANIFEST_UNSUPPORTED_VERSION"           // formatVersion != 1
  | "MANIFEST_SYMLINK_REJECTED"              // manifest path is a symlink
  | "GENERATION_TARGET_SYMLINK_REJECTED"     // dbFile is a symlink
  | "LEGACY_SOURCE_OPEN_FAILED"              // legacy DB exists but cannot be opened
  | "ATOMIC_WRITE_FAILED"                    // generic write failure
  | "ATOMIC_RENAME_FAILED"                   // rename failed (e.g. cross-device)
  | "ATOMIC_FSYNC_FAILED"                    // fsync failed (storage issue)
  | "PATH_TRAVERSAL_REJECTED"                // reserved: path escapes store
  | "PROJECT_KEY_INVALID";                   // project name was empty/non-string
```

`GenerationStoreError` carries:

- `code` — one of the above.
- `phase` — the function name where the error was raised, e.g.
  `"validateGenerationManifest"`, `"resolveActiveCodeDb"`,
  `"writeJsonAtomically"`.
- `project` — the project name being operated on (may be `""` for
  writer-level errors).
- `message` — human-readable detail.

This taxonomy is exhaustive on the foundation path. New failure modes
that emerge during R169B–R169E will be added as new codes, never folded
into existing ones.

## 10. GC policy

**Keep the active generation plus the two most recent previous
generations. Older generations are deleted.**

- The active generation is identified by reading `active-generation.json`.
- The "two most recent previous" are identified by `createdAt` timestamp
  in their manifest entries (a future GC scan will read each generation's
  manifest from a sidecar or from a generations index).
- `tmp/` is swept on every GC pass: any file older than a threshold
  (default 1 hour) is deleted. This reclaims space from crashed
  publications.
- GC is **best-effort**. If a deletion fails (e.g. file is locked on
  Windows), GC logs the failure and continues. The next GC pass will
  retry.
- GC never deletes the active generation. GC never deletes a DB that
  has been opened by a reader in the current process (the OS holds the
  file handle; deletion only unlinks the directory entry).
- GC is **not** enabled in R169A. The policy is documented here so that
  R169B+ can implement it without redesign.

## 11. Recovery

The recovery model is **fail closed and stay closed** until the operator
or the indexer repairs the state. There is no silent fallback, no
automatic downgrade, no manual bypass flag.

- A manifest that fails validation must be repaired or deleted. Until
  then, the resolver throws on every read for that project.
- A missing generation target (manifest says `dbFile` but the file is
  absent) must be repaired by re-indexing. Until then, the resolver
  throws.
- A legacy DB that cannot be opened must be repaired by re-indexing. The
  resolver does not try to "open it read-only" or "skip the broken
  table" — it throws.
- There is **no `--skip-manifest` flag**, **no `--force-legacy` flag**,
  **no `CBM_IGNORE_GENERATION_STORE=1` environment variable**. The
  integrity guarantee depends on the resolver being the only path; an
  escape hatch defeats the purpose.

This is a deliberate departure from the R168 and earlier behavior, where
the indexer would sometimes "do its best" with corrupt state. R169's
contract is that the reader sees a complete snapshot or an error — never
a partial snapshot. The price of that contract is that some failures
require operator action.

## 12. Crash matrix (C01–C20)

This is the **target** crash matrix. Each row identifies a crash point,
the on-disk state after the crash, and what the resolver does on the
next read. The matrix is exhaustive for the foundation path; R169B–R169E
will extend it with indexer-specific crash points (extraction failure,
discovery failure, etc.).

| ID | Crash point | On-disk state | Resolver behavior |
|----|-------------|---------------|-------------------|
| C01 | Before opening the temp DB file | No temp file. Active manifest unchanged. | Read returns previous generation (or legacy, or missing). |
| C02 | While writing the temp DB file | Partial temp file in `tmp/`. Active manifest unchanged. | Read returns previous generation. GC later removes the temp file. |
| C03 | After writing, before fsync of temp DB | Temp file fully written but not durable. Active manifest unchanged. | Read returns previous generation. On reboot, temp file may be empty or partial. |
| C04 | During fsync of temp DB | Temp file may be partially durable. Active manifest unchanged. | Read returns previous generation. |
| C05 | After fsync of temp DB, before rename to `generations/` | Temp file durable in `tmp/`. Active manifest unchanged. | Read returns previous generation. GC later promotes or removes the temp file. |
| C06 | During rename `tmp/ → generations/` | Rename is atomic on POSIX: either the old state or the new state. Active manifest unchanged. | Read returns previous generation. The new generation DB is in `generations/` but unreferenced. |
| C07 | After rename, before writing the new manifest | New generation DB is in `generations/`. Active manifest still points to the old generation. | Read returns previous generation. The new DB is unreferenced; GC later removes it. |
| C08 | While writing the manifest temp file | Partial manifest temp file in the project store. Active manifest unchanged. | Read returns previous generation. |
| C09 | After writing manifest temp, before fsync | Manifest temp file written but not durable. Active manifest unchanged. | Read returns previous generation. |
| C10 | During fsync of manifest temp | Manifest temp may be partially durable. Active manifest unchanged. | Read returns previous generation. |
| C11 | After fsync of manifest temp, before rename | Manifest temp durable. Active manifest still points to old generation. | Read returns previous generation. |
| C12 | During rename `manifest.tmp → active-generation.json` | Atomic on POSIX: either old manifest or new manifest. | Read returns either the old or the new generation, never a partial manifest. |
| C13 | After manifest rename, before fsync of directory | New manifest is in place but the directory entry may not be durable. On crash, the rename could roll back. | Read returns either the old or the new generation, depending on whether the rename survived. Both are valid. |
| C14 | After directory fsync | New generation is fully live and durable. | Read returns the new generation. |
| C15 | Crash during GC, between unlink of two old generations | Some old generations deleted, some remain. | Read returns the active generation (GC never touches the active generation). |
| C16 | Crash during `tmp/` sweep | Some temp files deleted, some remain. | Read returns the active generation. |
| C17 | Disk full while writing temp DB | Temp file is partial or absent. Active manifest unchanged. | Read returns previous generation. Indexer must retry or fail visibly. |
| C18 | Disk full while writing manifest temp | Manifest temp file is partial or absent. Active manifest unchanged. | Read returns previous generation. Indexer must retry or fail visibly. |
| C19 | Permission denied on `generations/` directory | Temp DB cannot be created. Active manifest unchanged. | Read returns previous generation. Indexer must surface the permission error. |
| C20 | Permission denied on the project store directory (manifest write) | Manifest temp cannot be created. Active manifest unchanged. | Read returns previous generation. Indexer must surface the permission error. |

The common property: **a crash never leaves the reader seeing a partial
publication.** The reader either sees the previous complete snapshot or
the new complete snapshot, depending on whether the manifest rename
(C12) survived.

## 13. Performance contract

R169A is **zero overhead** when unused.

- No production code imports `generation-store.js` at startup. The
  module is only loaded by its own tests.
- No `fsync`, no `mkdir`, no `lstat` is performed on the hot path. The
  indexer, readers, UI, MCP, and CLI all continue to use
  `defaultCodeDbPath` (which equals `legacyCodeDbPath`).
- The test suite that verifies the no-overhead property lives at
  `v2/tests/storage/r169a-generation-store.test.ts`, in the
  `R169A — No production behavior change` block. It checks that:
  - `defaultCodeDbPath` still exists and is importable.
  - `legacyCodeDbPath(project)` produces the same path as
    `defaultCodeDbPath(project)`.
  - `CURRENT_GENERATION_MANIFEST_VERSION` is still `1`.

When R169B activates the writer, the cost model is:

- One extra `fsync` of the generation DB file per publication.
- One extra `fsync` of the manifest file per publication.
- One extra `fsync` of the project store directory per publication.
- One `rename` of the generation DB from `tmp/` to `generations/`.
- One `rename` of the manifest temp file to `active-generation.json`.

These costs are paid **once per indexing run**, not per query. Readers
pay no cost — they open the resolved DB once and keep the handle.

## 14. R170 boundary (lease / fencing)

R169A is the foundation for atomic publication **within a single host**.
It does **not** address multi-host coordination. That is R170.

R170 will add:

- **Project lease:** an indexer must acquire a lease before publishing.
  The lease is identified by a fencing token (monotonic integer).
- **Fencing on write:** the manifest writer includes the lease token in
  the manifest. A stale indexer (one whose lease has expired) cannot
  overwrite a newer manifest — the writer checks the token and refuses.
- **Fencing on read:** not required for correctness (readers always see
  a complete snapshot), but useful for diagnostics: a reader can detect
  that the active generation was published by a stale indexer and warn.
- **Lease storage:** likely in `index-state.json` (a sidecar, not the
  manifest). The manifest stays clean of operational metadata.

The R169A schema deliberately leaves room for this:

- `MANIFEST_V1_KEYS` is closed, so adding a `leaseToken` field requires
  bumping `formatVersion` to `2` and a migration. This is intentional:
  lease tokens are an operational concern, not a content concern.
- `index-state.json` is already defined as the sidecar for operational
  state. R170 can extend it without breaking the manifest schema.

R169A does **not** implement lease or fencing. Multi-host deployments
that share a cache directory (rare, but possible over NFS) are not safe
under R169A alone. The single-host contract (section 2) is the only
contract R169A provides.

## 15. Status: FOUNDATION / INACTIVE

To repeat the headline, because it is the most important fact in this
document:

> **R169A is merged but NOT active. No production code path uses the
> generation store. The indexer still writes to the legacy DB. Readers
> still open the legacy DB directly. `DATA-CARRY-01` (P1) remains
> open.**

What R169A delivers:

- `v2/src/storage/generation-store.ts` — path helpers, manifest parser
  and validator, resolver, atomic JSON writer.
- `v2/src/storage/generation-types.ts` — manifest V1 types,
  `ResolvedCodeDb` discriminated union, error taxonomy.
- `v2/tests/storage/r169a-generation-store.test.ts` — full test matrix
  for the above.

What R169A does **not** deliver:

- Indexer integration (R169B).
- Reader integration (R169C).
- GC (R169D).
- Legacy migration completion and `DATA-CARRY-01` close (R169E).
- Multi-host fencing (R170).

The foundation is merged so that R169B–R169E can land incrementally,
each round activating one piece with its own tests and audit. There is
no "big bang" activation.

## 16. References

- `v2/src/storage/generation-store.ts` — implementation.
- `v2/src/storage/generation-types.ts` — types and error codes.
- `v2/tests/storage/r169a-generation-store.test.ts` — test matrix.
- `docs/V2_ARCHITECTURE.md` — section 10 (publication, current state +
  R169 target) and section 15 (R169A generation store target).
- `docs/V2_CURRENT_STATE.md` — R169A section (foundation in progress).
- `v2/CHANGELOG.md` — R169A entry (foundation, feature inactive).
- `v2/src/indexer/schema.ts` — `CURRENT_GENERATION_MANIFEST_VERSION = 1`.
- `v2/src/bridge/sqlite-ro.ts` — `defaultCodeDbPath` (the legacy path,
  unchanged by R169A).
