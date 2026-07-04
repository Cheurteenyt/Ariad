# Changelog — Codebase Memory V2

## 0.4.3 — Round 10 Deep Precision (2026-07-04)

11 bugs fixed (4 HIGH, 4 MEDIUM, 3 LOW). Token economy improvements.

### HIGH fixes
- `prepare_edit_context` risk/blast-radius underestimated (capped at 50 neighbors). Fixed: use uncapped `getNodeDegree()`.
- `get_undocumented_hotspots` duplicates (critical Modules in both module and critical arrays). Fixed: exclude Module/Route from critical array.
- Importer created edges from AUTO-GENERATED wikilinks (duplicating existing DECIDES edges with MENTIONS). Fixed: parse wikilinks only from HUMAN NOTES.
- `get_module_context` include_adrs/bugs/refactors ignored when include_human=false. Fixed: moved outside the guard.

### Token economy
- `human_notes` no longer includes ADRs/bugs/refactors (they have their own arrays). Saves ~500 chars × N notes.
- `prepare_edit_context` now reports `nodes_found` so agent knows if 20-node limit was hit.

## 0.4.2 — Clean Audit (2026-07-04)

15 bugs fixed (1 CRITICAL, 5 HIGH, 6 MEDIUM, 3 LOW). Export idempotency fix.

### CRITICAL fix
- Export was NOT idempotent — every sync re-wrote every file forever. "Last sync" timestamp in body + regex leaving empty line gap. Fixed: removed body timestamp, fixed regex to consume newline.

## 0.4.1 — Precision Fixes (2026-07-04)

10 bugs in intelligence code fixed. 14 new tests (graph-status).

## 0.4.0 — Intelligence Layer (2026-07-04)

Major release: V2 is now PROACTIVE and GRAPH-AWARE.

### New features
- `prepare_edit_context` MCP tool (flagship) — context before editing
- Graph freshness detection (stale detection via git log + DB mtime)
- Enhanced `get_project_overview` with graph_status + smart recommendations
- 7 MCP tools (was 6)

## 0.3.0-0.3.4 — Project Identity + Rounds 5-8

- LICENSE, CONTRIBUTING.md, .gitlab-ci.yml, Dockerfile
- `cbm-v2 demo`, `cbm-v2 stats`, `cbm-v2 backup export/import`
- README rewritten in English
- 4 audit rounds (R5-R8), 121 bugs fixed
- Constants centralization (16/16)
- Export idempotency regression test

## 0.2.0-0.2.3 — Audit Rounds 1-4

- 249 bugs fixed across 4 rounds
- 114 → 139 tests
- Constants centralization started
- `safeJsonParse` helper
- `process.exit` → `process.exitCode` refactor
- Transaction wrap for `createNode` (TOCTOU fix)
- Path traversal protection
- MCP protocol compliance (batch, ping, -32600/-32601/-32602, id:null vs undefined)

## 0.1.0 — MVP (2026-07-04)

Initial release. Human memory graph + Obsidian sync + 6 MCP tools + CLI. 10 tests.
