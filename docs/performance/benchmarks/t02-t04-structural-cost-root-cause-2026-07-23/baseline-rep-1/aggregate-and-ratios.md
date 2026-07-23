# R181 T02-T04 structural cost baseline repetition 1 checkpoint

Selected cells: **28**. Selected invalid cells: **0**.

## Aggregates

| Usage | Target | Arm | Raw tokens | Uncached + output | Calls | Response bytes | Query ms | PASS/PARTIAL/FAIL |
|---|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | B (v2-mcp) | 1,089,058 | 198,946 | 9 | 74,942 | 31885.6 | 4/0/0 |
| continuous | large | C (grep-read) | 2,592,558 | 284,718 | 23 | 69,360 | 0.0 | 2/2/0 |
| continuous | small | B (v2-mcp) | 1,794,664 | 194,152 | 19 | 124,652 | 10278.5 | 4/0/0 |
| continuous | small | C (grep-read) | 1,983,637 | 215,445 | 24 | 83,276 | 0.0 | 4/0/0 |
| one-shot | large | B (v2-mcp) | 503,886 | 58,190 | 17 | 82,311 | 39841.5 | 3/0/0 |
| one-shot | large | C (grep-read) | 363,881 | 60,521 | 12 | 119,204 | 0.0 | 3/0/0 |
| one-shot | small | B (v2-mcp) | 580,987 | 73,083 | 22 | 89,588 | 10975.7 | 3/0/0 |
| one-shot | small | C (grep-read) | 306,921 | 55,785 | 13 | 69,535 | 0.0 | 3/0/0 |

## Pre-registered ratios

| Usage | Target | V2/V1 tokens | V1/grep tokens | V2/grep tokens | Hybrid/grep tokens | V2/V1 calls | Hybrid/grep calls |
|---|---|---:|---:|---:|---:|---:|---:|
| continuous | large | n/a | n/a | 0.420 | n/a | n/a | n/a |
| continuous | small | n/a | n/a | 0.905 | n/a | n/a | n/a |
| one-shot | large | n/a | n/a | 1.385 | n/a | n/a | n/a |
| one-shot | small | n/a | n/a | 1.893 | n/a | n/a | n/a |
