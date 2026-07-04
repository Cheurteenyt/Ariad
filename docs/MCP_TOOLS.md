# MCP Tools Reference — Codebase Memory V2

V2 exposes **7 MCP tools** via JSON-RPC 2.0 over stdio. This document describes each tool's input, output, and usage.

## Connection

```json
{
  "mcpServers": {
    "codebase-memory-v2": {
      "command": "node",
      "args": ["/path/to/v2/dist/cli/index.js", "mcp", "--project", "my-app"]
    }
  }
}
```

## Tools

### 1. `get_project_overview`

**Purpose**: High-level project stats — first call when an agent starts exploring a codebase.

**Input**: `{ project?: string }`

**Output**:
```json
{
  "project": "my-app",
  "code_graph": { "total_nodes": 1542, "total_edges": 4200, "nodes_by_label": { "Function": 800, "Module": 120 } },
  "human_memory": { "total_notes": 45, "adrs": 12, "bugs": 8, "refactors": 5 },
  "documentation_coverage": { "critical_modules_total": 20, "critical_modules_documented": 14, "coverage_pct": 70.0 },
  "graph_status": {
    "freshness_score": 1.0,
    "freshness_label": "FRESH",
    "stale": false,
    "last_indexed": "2026-07-04T10:00:00Z",
    "stale_files_count": 0,
    "recommendation": "FRESH"
  },
  "recommendations": [
    "Project is in good shape. Use prepare_edit_context before modifying any file."
  ]
}
```

### 2. `get_module_context`

**Purpose**: Full context of a module — code structure + human notes + ADRs + bugs + refactors.

**Input**: `{ project?: string, module_name: string, include_human?: boolean, include_adrs?: boolean, include_bugs?: boolean, include_refactors?: boolean, max_nodes?: number }`

**Output**: Module info, code neighbors, human notes (non-ADR/bug/refactor), ADRs, bugs, refactors, risk score.

### 3. `get_undocumented_hotspots`

**Purpose**: Find critical code nodes (high degree/complexity) WITHOUT human notes.

**Input**: `{ project?: string, label?: "Module"|"Route"|"Function"|"Class"|"Interface", limit?: number }`

**Output**: Coverage stats + list of undocumented critical nodes.

### 4. `create_human_note`

**Purpose**: Create an ADR, BugNote, RefactorPlan, etc. + optionally link to code nodes.

**Input**: `{ project?: string, label: HumanNodeLabel, title: string, body_markdown?: string, status?: "draft"|"active"|"reviewed"|"deprecated", tags?: string[], links?: [{ cbm_node_id: number, edge_type: HumanEdgeType }], author?: string }`

**Output**: Created note ID, slug, obsidian_path, and edge IDs.

### 5. `link_note_to_code_node`

**Purpose**: Link an existing note to a code node (or another human note).

**Input**: `{ project?: string, human_note_id: number, target_kind: "code"|"human", target_cbm_node_id?: number, target_human_node_id?: number, edge_type: HumanEdgeType, properties?: object }`

**Output**: Edge ID and details.

### 6. `search_code_and_memory`

**Purpose**: Unified search across code graph AND human memory.

**Input**: `{ project?: string, query: string, limit?: number, search_code?: boolean, search_human?: boolean }`

**Output**: Balanced results from both sources (interleaved).

### 7. `prepare_edit_context` ⭐ Flagship

**Purpose**: Call this BEFORE editing any source file. Returns everything the agent needs to know.

**Input**: `{ project?: string, file_path?: string, symbol_name?: string }` (at least one required)

**Output**:
```json
{
  "found": true,
  "nodes_found": 5,
  "nodes_analyzed": 5,
  "nodes": [{ "node": {...}, "dependencies": {...}, "human_notes": {...}, "risk": {...} }],
  "blast_radius": { "total_dependent_nodes": 12, "affected_modules": 3, "affected_routes": 1 },
  "human_memory_summary": { "open_bugs": 2, "active_adrs": 1, "pending_refactors": 1 },
  "risk_assessment": { "max_risk_score": 0.72, "max_risk_level": "HIGH" },
  "graph_freshness": { "score": 1.0, "label": "FRESH" },
  "recommendation": "⚠️ PROCEED WITH CAUTION:\n  - HIGH RISK: login has risk score 0.72...\n  - 2 known bug(s)..."
}
```

## Node Labels (11)

`ArchitectureNote`, `ADR`, `BugNote`, `RefactorPlan`, `LegacyNote`, `Convention`, `Prompt`, `JournalEntry`, `ModuleNote`, `RouteNote`, `RiskNote`

## Edge Types (12)

`EXPLAINS`, `DECIDES`, `AFFECTS`, `TOUCHES`, `DOCUMENTS`, `DEPRECATES`, `REPLACES`, `RISKS`, `MENTIONS`, `JUSTIFIES`, `OWNS`, `TODO_FOR`
