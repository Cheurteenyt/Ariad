# R181 T02-T04 structural cost baseline repetition 3: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 400,530 / 16 / 90,404 / PASS / valid | 327,090 / 13 / 56,642 / PASS / valid |
| T03 | 47,562 / 1 / 516 / PASS / valid | 37,650 / 2 / 2,737 / PASS / valid |
| T04 | 69,556 / 2 / 13,244 / PASS / valid | 25,890 / 1 / 4,019 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 271,861 / 10 / 105,448 / PASS / valid | 207,855 / 8 / 65,521 / PASS / valid |
| T03 | 85,892 / 4 / 12,163 / PASS / valid | 47,688 / 2 / 4,043 / PASS / valid |
| T04 | 48,157 / 1 / 568 / PASS / valid | 61,752 / 3 / 1,239 / PASS / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 41,838 / 1 / 2,767 / PASS / valid | 267,070 / 15 / 44,078 / FAIL / valid |
| T02 | 315,874 / 11 / 83,566 / PARTIAL / valid | 623,525 / 11 / 35,554 / PASS / valid |
| T03 | 437,038 / 2 / 8,763 / PASS / valid | 747,687 / 2 / 5,325 / PASS / valid |
| T04 | 616,582 / 3 / 21,486 / PASS / valid | 835,054 / 1 / 4,019 / PASS / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 68,834 / 1 / 6,747 / PASS / valid | 279,019 / 10 / 66,483 / FAIL / valid |
| T02 | 501,249 / 13 / 74,098 / PASS / valid | 553,844 / 7 / 19,016 / PASS / valid |
| T03 | 626,837 / 2 / 10,568 / PASS / valid | 684,019 / 2 / 2,714 / PASS / valid |
| T04 | 713,216 / 1 / 888 / PASS / valid | 772,359 / 1 / 361 / PASS / valid |
