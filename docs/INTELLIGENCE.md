# Intelligence Layer — Codebase Memory V2

V2 is not just a storage layer — it's **proactive and graph-aware**. The agent gets context automatically instead of having to ask for everything manually.

## How It Works

### Graph Freshness Detection

V2 knows if the code graph is stale. It uses two signals:

1. **DB file mtime** — the SQLite DB file modification time serves as a proxy for "last indexed" (V1 writes the DB on each index run).
2. **Git log** — `git log --name-only --since="@<unix_ts>"` finds source files changed since the last index.

The freshness score (0.0 to 1.0) is computed from:

| Condition | Score |
|---|---|
| Graph unavailable or empty | 0.0 |
| >50 stale files | 0.2 |
| >10 stale files | 0.4 |
| >0 stale files | 0.6 |
| Age >24h (no stale files) | 0.5 |
| Age >1h (no stale files) | 0.8 |
| Fresh | 1.0 |

Labels: `FRESH` (≥0.9) → `RECENT` (≥0.7) → `STALE` (≥0.5) → `OLD` (≥0.3) → `CRITICAL` (<0.3).

### `prepare_edit_context` — The Flagship Tool

This is the single call that makes the agent "smart" about what it's about to modify.

**Before V2** (agent must manually call 5+ tools):
```
Agent: "I want to edit src/auth/login.ts"
→ grep for functions in the file
→ grep for callers of those functions
→ search for bugs in the repo
→ search for ADRs in the repo
→ check conventions
Total: 5+ calls, ~4600 tokens
```

**With V2** (one call):
```
Agent: prepare_edit_context(file_path="src/auth/login.ts")
→ V2 returns: code nodes, dependencies, bugs, ADRs, refactors,
  conventions, blast radius, risk score, graph freshness, recommendation
Total: 1 call, ~1500 tokens (-67%)
```

### Smart Recommendations

`get_project_overview` now returns actionable recommendations:

```json
{
  "recommendations": [
    "Refresh the code graph: 47 files modified. Run cbm index_repository.",
    "2 open bug(s) — review before making changes.",
    "Documentation coverage is 35% — 8 critical modules undocumented."
  ]
}
```

The agent gets a prioritized action list without having to ask "what should I do?".

## Architecture

```
src/intelligence/
  graph-status.ts    — freshness detection (getGraphStatus, getFreshnessScore, freshnessLabel)

src/mcp/tools/
  prepare_edit_context.ts  — flagship tool (context before editing)
  get_project_overview.ts  — enhanced with graph_status + recommendations
```

## Data Flow

```
Agent calls prepare_edit_context(file_path="src/auth/login.ts")
  ↓
1. Search code graph for nodes matching file_path
  ↓
2. For each node: getNeighbors (callers/callees)
  ↓
3. For each node: listNodesByCbmNodeId (human notes: bugs, ADRs, refactors, conventions)
  ↓
4. Compute risk score (degree × complexity × documentation)
  ↓
5. Collect blast radius (unique dependent node IDs)
  ↓
6. Get graph freshness (git log + DB mtime)
  ↓
7. Build recommendation (warnings → "PROCEED WITH CAUTION" or "SAFE TO EDIT")
  ↓
Return complete context in one response
```

## Future Intelligence Features (Planned)

| Feature | Description | Status |
|---|---|---|
| `cbm-v2 watch` | Daemon: auto-sync Obsidian + code graph | Planned |
| Git hooks | Auto-journal after each commit | Planned |
| Proactive suggestions | V2 suggests creating notes for undocumented modules | Planned |
| Smart-sync | Incremental sync based on mtime (10x faster) | Planned |
| Conflict detection | Read sync_state to detect DB-vs-vault conflicts | Planned |
