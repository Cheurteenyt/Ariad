# R181 T02-T04 structural cost baseline repetition 2 checkpoint

Selected cells: **28**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 881,158 | 132,614 | 9 | 46,509 | 30984.3 | 3/1/0 |
| continuous | large | C (grep-read) | 3,125,469 | 301,533 | 25 | 124,499 | 0.0 | 3/1/0 |
| continuous | small | B (v2-mcp) | 1,762,826 | 165,642 | 22 | 138,188 | 10133.4 | 4/0/0 |
| continuous | small | C (grep-read) | 2,704,851 | 234,707 | 30 | 726,907 | 0.0 | 4/0/0 |
| one-shot | large | B (v2-mcp) | 452,092 | 62,716 | 19 | 97,267 | 30420.7 | 3/0/0 |
| one-shot | large | C (grep-read) | 297,090 | 58,242 | 13 | 60,820 | 0.0 | 2/1/0 |
| one-shot | small | B (v2-mcp) | 615,620 | 73,668 | 21 | 124,971 | 9224.7 | 3/0/0 |
| one-shot | small | C (grep-read) | 291,902 | 56,126 | 12 | 77,082 | 0.0 | 3/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.282 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.652 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 1.522 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 2.109 | n/a | n/a | n/a |
