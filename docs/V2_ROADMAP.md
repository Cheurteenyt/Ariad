# V2 Roadmap — Codebase Memory V2

> Updated 2026-07-04 for version 0.4.3.

## Current State (0.4.3)

### ✅ Completed

| Feature | Version | Details |
|---|---|---|
| Human Memory DB | 0.1.0 | 11 node labels, 12 edge types, SQLite WAL, transactions |
| Obsidian vault sync | 0.1.0 | Bidirectional, HUMAN NOTES preserved, backup rotation |
| Code graph bridge | 0.1.0 | Read-only access to V1 SQLite, bulk fetch, column aliases |
| 7 MCP tools | 0.1.0-0.4.0 | get_project_overview, get_module_context, get_undocumented_hotspots, create_human_note, link_note_to_code_node, search_code_and_memory, prepare_edit_context |
| CLI (15+ commands) | 0.1.0-0.3.0 | init, doctor, mcp, stats, demo, backup, obsidian, human, report |
| Intelligence layer | 0.4.0 | Graph freshness detection, smart recommendations, prepare_edit_context |
| Project identity | 0.3.0 | LICENSE, CONTRIBUTING, CI/CD, Dockerfile, README EN |
| 10 audit rounds | 0.2.0-0.4.3 | 351 bugs fixed, 156 tests |
| Export idempotency | 0.4.2 | Sync doesn't re-write unchanged files |
| Token economy | 0.4.3 | Compact responses, no duplication, pre-computed metrics |

### 📊 Metrics

| Metric | Value |
|---|---|
| Source files | 31 |
| Test files | 14 |
| Tests | 156 (all passing) |
| Bugs fixed (10 rounds) | 351 |
| MCP tools | 7 |
| CLI commands | 15+ |
| CI pipeline stages | 3 (typecheck → build → test) |
| Production dependencies | 3 |

## Roadmap

### Phase 1: Stability & Developer Experience (0.5.0)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| `cbm-v2 watch` daemon | High | Medium | Planned |
| Refactor `generateVault` (230 LOC → sub-functions) | High | Medium | Planned |
| Refactor `importVault` (188 LOC → sub-functions) | High | Medium | Planned |
| Tests for reports (hotspots, undocumented, risk) | High | Medium | Planned |
| ESLint + Prettier configuration | Medium | Low | Planned |
| `noUncheckedIndexedAccess` in tsconfig | Medium | Low | Planned |
| Compact MCP responses (shorter excerpts) | Medium | Low | Planned |

### Phase 2: Proactive Intelligence (0.6.0)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| Git hooks (post-commit → auto-journal) | High | Medium | Planned |
| `smart-sync` incremental (mtime-based) | High | Medium | Planned |
| Proactive suggestions (undocumented modules) | Medium | Medium | Planned |
| Conflict detection (read sync_state) | Medium | Medium | Planned |
| MCP tool timeout (30s) | Medium | Low | Planned |

### Phase 3: V1 Complete (0.7.0)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| 9 remaining MCP tools | Medium | High | Planned |
| UI React dashboard | Low | Very High | Planned |
| Plugin system (C ABI) | Low | Very High | Planned |
| `human_metrics` cache table | Low | Low | Planned |

### Phase 4: Scale (1.0.0)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| Streaming MCP (NDJSON) | Medium | High | Planned |
| Multi-user / remote store | Low | Very High | Planned |
| LSP coverage (147/158 remaining) | Low | Very High | Planned |
| `ingest_traces` V1 stub completion | Low | Medium | Planned |

## Audit History

| Round | Version | Bugs Found | Bugs Fixed | Tests |
|---|---|---|---|---|
| MVP | 0.1.0 | — | — | 10 |
| R1 | 0.2.0 | 77 | 77 | 114 |
| R2 | 0.2.1 | 85 | 85 | 114 |
| R3 (Kimi) | 0.2.2 | 9 | 9 | 124 |
| R4 | 0.2.3 | 78 | 78 | 124 |
| Identity | 0.3.0 | — | — | 124 |
| R5 | 0.3.1 | 10 | 10 | 124 |
| R6 (invisible) | 0.3.2 | 20 | 20 | 139 |
| R7 (final) | 0.3.3 | 19 | 19 | 139 |
| R8 (excellence) | 0.3.4 | 17 | 17 | 139 |
| Intelligence | 0.4.0 | — | — | 139 |
| R9 (precision) | 0.4.1 | 10 | 10 | 153 |
| R10 (clean) | 0.4.2 | 15 | 15 | 156 |
| R11 (deep) | 0.4.3 | 11 | 11 | 156 |
| **Total** | | **351** | **351** | **156** |
