# R181 postfix repetition 3 checkpoint

Selected cells: **28**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 750,705 | 95,345 | 9 | 22,146 | 29927.1 | 4/0/0 |
| continuous | large | C (grep-read) | 3,522,780 | 351,452 | 27 | 137,299 | 0.0 | 3/0/1 |
| continuous | small | B (v2-mcp) | 726,904 | 123,768 | 10 | 41,631 | 8328.8 | 4/0/0 |
| continuous | small | C (grep-read) | 1,873,861 | 168,645 | 18 | 88,942 | 0.0 | 4/0/0 |
| one-shot | large | B (v2-mcp) | 210,568 | 24,712 | 7 | 19,387 | 19206.4 | 3/0/0 |
| one-shot | large | C (grep-read) | 191,031 | 26,167 | 9 | 36,085 | 0.0 | 2/1/0 |
| one-shot | small | B (v2-mcp) | 194,038 | 43,510 | 6 | 21,465 | 4404.9 | 3/0/0 |
| one-shot | small | C (grep-read) | 172,647 | 40,295 | 8 | 73,786 | 0.0 | 3/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.213 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.388 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 1.102 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 1.124 | n/a | n/a | n/a |
