# R181 T02-T04 structural cost baseline repetition 2: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 496,879 / 18 / 111,211 / PASS / valid | 159,886 / 6 / 62,647 / PASS / valid |
| T03 | 48,435 / 1 / 516 / PASS / valid | 47,495 / 2 / 5,644 / PASS / valid |
| T04 | 70,306 / 2 / 13,244 / PASS / valid | 84,521 / 4 / 8,791 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 289,101 / 12 / 74,256 / PASS / valid | 169,757 / 6 / 54,812 / PARTIAL / valid |
| T03 | 109,046 / 5 / 20,708 / PASS / valid | 64,747 / 3 / 4,917 / PASS / valid |
| T04 | 53,945 / 2 / 2,303 / PASS / valid | 62,586 / 4 / 1,091 / PASS / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 50,351 / 1 / 2,767 / PASS / valid | 288,758 / 16 / 681,556 / PASS / valid |
| T02 | 383,326 / 14 / 78,178 / PASS / valid | 678,867 / 11 / 40,932 / PASS / valid |
| T03 | 510,714 / 2 / 8,763 / PASS / valid | 786,119 / 1 / 398 / PASS / valid |
| T04 | 818,435 / 5 / 48,480 / PASS / valid | 951,107 / 2 / 4,021 / PASS / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 68,938 / 1 / 6,747 / PASS / valid | 331,752 / 12 / 67,509 / PARTIAL / valid |
| T02 | 181,425 / 4 / 26,188 / PARTIAL / valid | 789,235 / 10 / 52,477 / PASS / valid |
| T03 | 269,022 / 2 / 12,467 / PASS / valid | 948,215 / 2 / 4,403 / PASS / valid |
| T04 | 361,773 / 2 / 1,107 / PASS / valid | 1,056,267 / 1 / 110 / PASS / valid |
