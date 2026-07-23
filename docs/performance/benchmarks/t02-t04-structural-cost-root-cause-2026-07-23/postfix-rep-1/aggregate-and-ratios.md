# R181 postfix repetition 1 checkpoint

Selected cells: **28**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 492,186 | 72,090 | 4 | 10,329 | 28488.7 | 4/0/0 |
| continuous | large | C (grep-read) | 4,154,612 | 299,252 | 28 | 176,887 | 0.0 | 3/1/0 |
| continuous | small | B (v2-mcp) | 933,565 | 99,517 | 14 | 73,122 | 10437.5 | 4/0/0 |
| continuous | small | C (grep-read) | 2,422,882 | 250,978 | 27 | 97,337 | 0.0 | 3/0/1 |
| one-shot | large | B (v2-mcp) | 196,771 | 39,331 | 6 | 18,285 | 22378.4 | 3/0/0 |
| one-shot | large | C (grep-read) | 370,351 | 51,631 | 17 | 69,488 | 0.0 | 3/0/0 |
| one-shot | small | B (v2-mcp) | 269,516 | 42,188 | 10 | 39,982 | 6089.5 | 3/0/0 |
| one-shot | small | C (grep-read) | 388,209 | 47,729 | 15 | 74,878 | 0.0 | 3/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.118 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.385 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 0.531 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 0.694 | n/a | n/a | n/a |
