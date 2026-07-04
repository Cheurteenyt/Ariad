# Token Economy — How V2 Saves API Tokens

V2 is designed to **minimize the number of API calls and tokens** an AI agent needs to understand and modify a codebase.

## The Problem

Without V2, an AI agent exploring a codebase must:

1. **Search for code structure** — grep, read files, understand dependencies
2. **Search for human context** — look for ADRs, bug reports, conventions in the repo
3. **Assess risk** — try to figure out what depends on the file being edited
4. **Check for freshness** — guess if the code analysis is up-to-date

Each step requires multiple API calls (grep, read, search), consuming thousands of tokens.

## The V2 Solution

V2 consolidates all these steps into **single MCP tool calls** that return pre-computed, structured data.

## Token Savings by Scenario

### Scenario 1: Preparing to edit a file

| Step | Without V2 | With V2 |
|---|---|---|
| Find functions in file | grep (~500 tokens) | Included in prepare_edit_context |
| Find callers/callees | grep (~800 tokens) | Included |
| Read the file | read (~2000 tokens) | Not needed (context provided) |
| Find known bugs | grep comments (~500 tokens) | Included |
| Find ADRs | search docs (~500 tokens) | Included |
| Find conventions | search docs (~300 tokens) | Included |
| Assess risk | manual analysis (~1000 tokens) | Included (risk score + recommendation) |
| **Total** | **~5600 tokens, 7 calls** | **~1500 tokens, 1 call** |
| **Savings** | | **-73% tokens, -86% calls** |

### Scenario 2: Project overview

| Step | Without V2 | With V2 |
|---|---|---|
| Count modules/routes | grep + wc (~500 tokens) | Included in get_project_overview |
| Find bugs/ADRs | search (~1000 tokens) | Included |
| Check documentation | manual review (~800 tokens) | Included (coverage %) |
| Check staleness | git log + manual (~500 tokens) | Included (freshness score) |
| **Total** | **~2800 tokens, 4 calls** | **~800 tokens, 1 call** |
| **Savings** | | **-71% tokens, -75% calls** |

### Scenario 3: Finding undocumented hotspots

| Step | Without V2 | With V2 |
|---|---|---|
| List all modules | grep (~500 tokens) | Included in get_undocumented_hotspots |
| Check each for docs | read N files (~2000 tokens) | Included (pre-computed) |
| Prioritize by criticality | manual analysis (~500 tokens) | Included (sorted by degree+complexity) |
| **Total** | **~3000 tokens, 3+ calls** | **~400 tokens, 1 call** |
| **Savings** | | **-87% tokens** |

## How V2 Minimizes Response Size

### Compact excerpts
- `body_excerpt` is capped at 200-500 chars (not full note body)
- Only `title`, `status`, `id` are included for each note (not all fields)

### No duplication
- `human_notes` excludes ADRs/bugs/refactors (they have their own arrays)
- Deduplication by ID across multiple code nodes in the same file
- Balanced search results (code + human interleaved, not concatenated)

### Pre-computed metrics
- Risk score (0.0-1.0) — no need for the agent to calculate
- Documentation coverage % — no need to count manually
- Blast radius count — no need to traverse the graph
- Freshness score — no need to run git commands

### Structured recommendations
- "SAFE TO EDIT" or "PROCEED WITH CAUTION" with specific warnings
- Agent doesn't need to interpret raw data — V2 tells it what to do

## Estimated Monthly Savings

Assuming an agent makes 100 edits/month on a mid-size project:

| Metric | Without V2 | With V2 | Monthly Savings |
|---|---|---|---|
| API calls | ~700 | ~100 | -600 calls |
| Tokens consumed | ~560K | ~150K | **-410K tokens** |
| Latency | ~35 min | ~5 min | **-30 min** |

At typical LLM pricing ($0.01/1K tokens), that's **~$4.10/month saved** per developer.

For a team of 10 developers: **~$41/month, ~$492/year**.

## Best Practices for Agents

1. **Always call `prepare_edit_context` before editing** — it's the single most token-efficient call
2. **Call `get_project_overview` first** — it tells you if data is stale and what needs attention
3. **Use `search_code_and_memory` for exploration** — unified search saves a round-trip
4. **Create notes via `create_human_note`** — one call instead of file write + sync + edge creation
5. **Check `graph_status.freshness_label`** — if STALE or worse, recommend re-indexing before trusting the data
