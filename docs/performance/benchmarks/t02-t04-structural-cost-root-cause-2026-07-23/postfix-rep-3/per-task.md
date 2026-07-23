# R181 postfix repetition 3: complete selected per-task tables

Each arm cell is `raw native tokens / completed calls / response bytes / grade / validity`.
The committed CSV beside this file is the canonical machine-readable table and retains every registered attribution field.

## one-shot — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 87,467 / 3 / 7,705 / PASS / valid | 87,225 / 4 / 58,947 / PASS / valid |
| T03 | 48,763 / 1 / 516 / PASS / valid | 53,407 / 3 / 10,820 / PASS / valid |
| T04 | 57,808 / 2 / 13,244 / PASS / valid | 32,015 / 1 / 4,019 / PASS / valid |

## one-shot — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T02 | 66,024 / 1 / 952 / PASS / valid | 102,565 / 4 / 31,575 / PARTIAL / valid |
| T03 | 105,544 / 5 / 17,867 / PASS / valid | 51,630 / 3 / 3,662 / PASS / valid |
| T04 | 39,000 / 1 / 568 / PASS / valid | 36,836 / 2 / 848 / PASS / valid |

## continuous — small

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 50,642 / 1 / 2,767 / PASS / valid | 224,898 / 10 / 36,473 / PASS / valid |
| T02 | 129,856 / 3 / 7,705 / PASS / valid | 466,489 / 6 / 48,052 / PASS / valid |
| T03 | 218,763 / 3 / 9,673 / PASS / valid | 548,810 / 1 / 398 / PASS / valid |
| T04 | 327,643 / 3 / 21,486 / PASS / valid | 633,664 / 1 / 4,019 / PASS / valid |

## continuous — large

| Task | B: v2-mcp | C: grep-read |
|---|---:|---:|
| T01 | 72,868 / 1 / 6,747 / PASS / valid | 413,729 / 14 / 70,652 / FAIL / valid |
| T02 | 124,207 / 1 / 952 / PASS / valid | 848,163 / 9 / 63,177 / PASS / valid |
| T03 | 243,477 / 5 / 12,143 / PASS / valid | 1,073,259 / 3 / 3,357 / PASS / valid |
| T04 | 310,153 / 2 / 2,304 / PASS / valid | 1,187,629 / 1 / 113 / PASS / valid |
