# R181 T02-T04 structural cost baseline repetition 1: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 475,447 / 19 / 75,828 / PASS / valid | 173,094 / 7 / 48,245 / PASS / valid |
| T03 | 48,014 / 1 / 516 / PASS / valid | 84,829 / 4 / 14,242 / PASS / valid |
| T04 | 57,526 / 2 / 13,244 / PASS / valid | 48,998 / 2 / 7,048 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 360,775 / 12 / 66,845 / PASS / valid | 286,918 / 9 / 116,336 / PASS / valid |
| T03 | 89,461 / 3 / 14,010 / PASS / valid | 31,041 / 1 / 2,367 / PASS / valid |
| T04 | 53,650 / 2 / 1,456 / PASS / valid | 45,922 / 2 / 501 / PASS / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 50,471 / 1 / 2,767 / PASS / valid | 190,075 / 11 / 42,973 / PASS / valid |
| T02 | 451,465 / 14 / 96,536 / PASS / valid | 515,991 / 11 / 35,886 / PASS / valid |
| T03 | 544,588 / 1 / 8,247 / PASS / valid | 596,948 / 1 / 398 / PASS / valid |
| T04 | 748,140 / 3 / 17,102 / PASS / valid | 680,623 / 1 / 4,019 / PASS / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 69,681 / 1 / 6,747 / PASS / valid | 489,147 / 18 / 61,146 / PARTIAL / valid |
| T02 | 263,799 / 6 / 56,931 / PASS / valid | 598,636 / 2 / 5,182 / PARTIAL / valid |
| T03 | 338,704 / 1 / 10,376 / PASS / valid | 713,297 / 2 / 2,922 / PASS / valid |
| T04 | 416,874 / 1 / 888 / PASS / valid | 791,478 / 1 / 110 / PASS / valid |
