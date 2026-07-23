# R181 postfix repetition 2 checkpoint

Selected cells: **28**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 803,742 | 81,822 | 9 | 21,028 | 32345.7 | 4/0/0 |
| continuous | large | C (grep-read) | 2,660,532 | 286,388 | 21 | 139,809 | 0.0 | 3/1/0 |
| continuous | small | B (v2-mcp) | 644,153 | 103,737 | 8 | 28,947 | 9273.8 | 4/0/0 |
| continuous | small | C (grep-read) | 2,569,905 | 260,273 | 23 | 724,777 | 0.0 | 3/0/1 |
| one-shot | large | B (v2-mcp) | 224,185 | 63,673 | 7 | 24,231 | 25729.5 | 3/0/0 |
| one-shot | large | C (grep-read) | 243,139 | 41,667 | 10 | 68,523 | 0.0 | 3/0/0 |
| one-shot | small | B (v2-mcp) | 278,598 | 51,270 | 10 | 43,122 | 4419.3 | 3/0/0 |
| one-shot | small | C (grep-read) | 282,201 | 52,313 | 11 | 80,779 | 0.0 | 3/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.302 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.251 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 0.922 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 0.987 | n/a | n/a | n/a |
