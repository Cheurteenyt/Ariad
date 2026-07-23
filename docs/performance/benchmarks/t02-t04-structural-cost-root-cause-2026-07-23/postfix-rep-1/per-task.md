# R181 postfix repetition 1: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 151,783 / 6 / 17,980 / PASS / valid | 292,290 / 11 / 63,740 / PASS / valid |
| T03 | 39,356 / 1 / 516 / PASS / valid | 47,100 / 2 / 6,918 / PASS / valid |
| T04 | 78,377 / 3 / 21,486 / PASS / valid | 48,819 / 2 / 4,220 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 53,829 / 1 / 952 / PASS / valid | 269,904 / 12 / 65,221 / PASS / valid |
| T03 | 88,849 / 3 / 15,877 / PASS / valid | 63,566 / 3 / 3,398 / PASS / valid |
| T04 | 54,093 / 2 / 1,456 / PASS / valid | 36,881 / 2 / 869 / PASS / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 51,231 / 1 / 2,767 / PASS / valid | 204,616 / 13 / 41,292 / FAIL / valid |
| T02 | 177,551 / 5 / 16,889 / PASS / valid | 623,990 / 11 / 47,097 / PASS / valid |
| T03 | 253,308 / 2 / 8,763 / PASS / valid | 752,173 / 2 / 4,929 / PASS / valid |
| T04 | 451,475 / 6 / 44,703 / PASS / valid | 842,103 / 1 / 4,019 / PASS / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 57,583 / 1 / 6,747 / PASS / valid | 295,376 / 10 / 81,451 / PARTIAL / valid |
| T02 | 108,488 / 1 / 952 / PASS / valid | 1,103,405 / 15 / 92,404 / PASS / valid |
| T03 | 144,297 / 1 / 2,091 / PASS / valid | 1,308,771 / 2 / 2,922 / PASS / valid |
| T04 | 181,818 / 1 / 539 / PASS / valid | 1,447,060 / 1 / 110 / PASS / valid |
