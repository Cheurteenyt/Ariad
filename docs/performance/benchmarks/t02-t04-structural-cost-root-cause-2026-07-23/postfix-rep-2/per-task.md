# R181 postfix repetition 2: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 153,031 / 6 / 21,120 / PASS / valid | 193,462 / 7 / 64,708 / PASS / valid |
| T03 | 48,078 / 1 / 516 / PASS / valid | 38,649 / 2 / 6,918 / PASS / valid |
| T04 | 77,489 / 3 / 21,486 / PASS / valid | 50,090 / 2 / 9,153 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 65,990 / 1 / 952 / PASS / valid | 159,240 / 6 / 64,753 / PASS / valid |
| T03 | 92,661 / 4 / 20,976 / PASS / valid | 47,045 / 2 / 2,922 / PASS / valid |
| T04 | 65,534 / 2 / 2,303 / PASS / valid | 36,854 / 2 / 848 / PASS / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 50,613 / 1 / 2,767 / PASS / valid | 339,524 / 12 / 677,037 / FAIL / valid |
| T02 | 129,611 / 3 / 7,556 / PASS / valid | 603,631 / 8 / 38,312 / PASS / valid |
| T03 | 194,902 / 2 / 5,380 / PASS / valid | 759,347 / 2 / 5,372 / PASS / valid |
| T04 | 269,027 / 2 / 13,244 / PASS / valid | 867,403 / 1 / 4,056 / PASS / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 69,399 / 1 / 6,747 / PASS / valid | 219,143 / 8 / 62,977 / PARTIAL / valid |
| T02 | 129,236 / 1 / 952 / PASS / valid | 661,398 / 10 / 73,800 / PASS / valid |
| T03 | 265,118 / 5 / 12,144 / PASS / valid | 832,298 / 2 / 2,922 / PASS / valid |
| T04 | 339,989 / 2 / 1,185 / PASS / valid | 947,693 / 1 / 110 / PASS / valid |
