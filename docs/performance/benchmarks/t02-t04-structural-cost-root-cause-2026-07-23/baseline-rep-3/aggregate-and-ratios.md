# R181 T02-T04 structural cost baseline repetition 3 checkpoint

Selected cells: **28**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 1,910,136 | 232,312 | 17 | 92,301 | 47318.8 | 4/0/0 |
| continuous | large | C (grep-read) | 2,289,241 | 193,369 | 20 | 88,574 | 0.0 | 3/0/1 |
| continuous | small | B (v2-mcp) | 1,411,332 | 154,884 | 17 | 116,582 | 10003.5 | 3/1/0 |
| continuous | small | C (grep-read) | 2,473,336 | 183,160 | 29 | 88,976 | 0.0 | 3/0/1 |
| one-shot | large | B (v2-mcp) | 405,910 | 76,950 | 15 | 118,179 | 24094.8 | 3/0/0 |
| one-shot | large | C (grep-read) | 317,295 | 56,175 | 13 | 70,803 | 0.0 | 3/0/0 |
| one-shot | small | B (v2-mcp) | 517,648 | 85,776 | 19 | 104,164 | 8183.4 | 3/0/0 |
| one-shot | small | C (grep-read) | 390,630 | 63,718 | 16 | 63,398 | 0.0 | 3/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.834 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.571 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 1.279 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 1.325 | n/a | n/a | n/a |
