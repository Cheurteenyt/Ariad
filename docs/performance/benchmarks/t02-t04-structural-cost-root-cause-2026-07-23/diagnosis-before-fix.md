# R181 T02-T04 structural-cost diagnosis before product changes

## Verdict

The R176 single-sample direction pattern is **not replicated**. Only 2 of 24
task/configuration/arm groups satisfy the pre-registered `max/min <= 1.20`
token-stability rule. Six of the twelve paired task/configuration cells change
direction in at least one repetition, and all three continuous/large cells
reverse R176 in every repetition: B is now cheaper than C.

The fresh evidence does isolate one narrower project-controlled mechanism.
One-shot T02 lacks a structural type-dependency answer in V2, so the agent
reconstructs it with many distinct literal searches and module reads. T02
accounts for 969,993 of the 1,108,424 one-shot B-over-C tokens (87.5%). This
supports a general, alias-aware type-impact operation inside the existing
`lookup_source_text` tool. It does not support schema compression, response
deduplication, a T01/direct-caller change, or a claim that continuous sessions
amortize V2 cost.

## Integrity and environment

All 24 invocations and 84 raw cells completed on attempt 1 with exit code 0.
The 72 decision cells are T02-T04; the 12 continuous T01 cells are context-only
warm-ups and are not graded in this diagnosis. Environment capture started at
`2026-07-22T23:32:59.385Z`; measured cells ran from
`2026-07-22T23:33:00.674Z` through `2026-07-23T00:26:01.247Z`.

Every environment record has the same pre-registration SHA
`1ced999a49a647b22fc5e08a6a1d5a50fafc1bbe`, clean branch head
`79d64f4e50c3e8eee6f5ff1190bdaf575387934c`, Windows 11 Pro
`10.0.26200` x64, AMD Ryzen 9 5900X with 24 logical processors,
42,849,894,400 bytes RAM, Node `v24.15.0`, npm `11.12.1`, Codex CLI
`0.144.4`, model `gpt-5.6-sol`, and reasoning `medium`. No environment or
version drift occurred.

Each repetition is independently checkpointed. The manifests hash the raw
phase plus all eight environment captures and exclude only regenerated
`derived/**` output:

- repetition 1: [aggregate](baseline-rep-1/aggregate-and-ratios.md),
  [per-task table](baseline-rep-1/per-task.md),
  [selected-run CSV](baseline-rep-1/selected-runs.csv), and
  [raw manifest](baseline-rep-1/raw-artifact-manifest.json) - 148 artifacts,
  999,798 bytes, tree
  `fec5487fe1c08936b29132476bfd8b569485ce91dfd079cfc05800cf61f2149d`;
- repetition 2: [aggregate](baseline-rep-2/aggregate-and-ratios.md),
  [per-task table](baseline-rep-2/per-task.md),
  [selected-run CSV](baseline-rep-2/selected-runs.csv), and
  [raw manifest](baseline-rep-2/raw-artifact-manifest.json) - 148 artifacts,
  1,694,001 bytes, tree
  `5429d5848e5b3f0e050986f893553f5de2708aa2db391a8fc220b34d299791a4`;
- repetition 3: [aggregate](baseline-rep-3/aggregate-and-ratios.md),
  [per-task table](baseline-rep-3/per-task.md),
  [selected-run CSV](baseline-rep-3/selected-runs.csv), and
  [raw manifest](baseline-rep-3/raw-artifact-manifest.json) - 148 artifacts,
  1,031,809 bytes, tree
  `0009644a4098b96ac2711eff3b6e804e57e2985b22564e331259f4205d0db652`.

## Correctness and aggregate cost

Correctness remains tied across all 36 samples per arm: both B and C have 34
PASS and 2 PARTIAL, with no FAIL. T03 and T04 are each 12/12 PASS in both
arms. T02 is 10 PASS and 2 PARTIAL in each arm, though the partials occur in
different repetitions.

| Repetition | Arm | PASS/PARTIAL/FAIL | Raw tokens | Uncached + output | Calls | Response bytes |
|---:|---|---:|---:|---:|---:|---:|
| 1 | B | 12/0/0 | 3,848,443 | 497,659 | 65 | 361,979 |
| 1 | C | 11/1/0 | 4,567,775 | 516,831 | 43 | 237,256 |
| 2 | B | 11/1/0 | 3,592,407 | 413,911 | 69 | 397,421 |
| 2 | C | 11/1/0 | 5,798,802 | 554,898 | 52 | 240,243 |
| 3 | B | 11/1/0 | 4,134,354 | 526,546 | 66 | 421,712 |
| 3 | C | 12/0/0 | 4,924,413 | 432,893 | 53 | 201,190 |

The 72 decision cells consumed 26,866,194 native raw tokens. B used
11,575,204 and C used 15,290,990, so the descriptive full-round B/C ratio is
`0.756995067x`: B used 24.3005% fewer tokens at tied aggregate correctness.
This combined result must not hide the usage-mode split:

- one-shot B: 3,076,143 tokens, 113 calls, 616,480 response bytes, 18/18 PASS;
- one-shot C: 1,967,719 tokens, 79 calls, 460,842 response bytes, 17 PASS and
  1 PARTIAL; B/C is `1.563307x`, so B is 56.33% more expensive;
- continuous B: 8,499,061 tokens, 87 calls, 564,632 response bytes, 16 PASS
  and 2 PARTIAL;
- continuous C: 13,323,271 tokens, 69 calls, 217,847 response bytes, 17 PASS
  and 1 PARTIAL; B/C is `0.637932x`, so B is 36.21% cheaper.

Including the excluded T01 warm-ups, all 84 raw cells used 29,062,128 native
tokens; T01 accounts for 2,195,934 of that total.

## R176 direction replication

`B<C` means V2 used fewer native tokens. Ratios are B/C.

| Configuration | Task | R176 | R1 | R2 | R3 | Fresh ratios | B grades | C grades |
|---|---|---|---|---|---|---|---|---|
| one-shot/small | T02 | B>C | B>C | B>C | B>C | 2.747x, 3.108x, 1.225x | PASS/PASS/PASS | PASS/PASS/PASS |
| one-shot/small | T03 | B>C | B<C | B>C | B>C | 0.566x, 1.020x, 1.263x | PASS/PASS/PASS | PASS/PASS/PASS |
| one-shot/small | T04 | B>C | B>C | B<C | B>C | 1.174x, 0.832x, 2.687x | PASS/PASS/PASS | PASS/PASS/PASS |
| one-shot/large | T02 | B>C | B>C | B>C | B>C | 1.257x, 1.703x, 1.308x | PASS/PASS/PASS | PASS/PARTIAL/PASS |
| one-shot/large | T03 | B>C | B>C | B>C | B>C | 2.882x, 1.684x, 1.801x | PASS/PASS/PASS | PASS/PASS/PASS |
| one-shot/large | T04 | B>C | B>C | B<C | B<C | 1.168x, 0.862x, 0.780x | PASS/PASS/PASS | PASS/PASS/PASS |
| continuous/small | T02 | B<C | B<C | B<C | B<C | 0.875x, 0.565x, 0.507x | PASS/PASS/PARTIAL | PASS/PASS/PASS |
| continuous/small | T03 | B<C | B<C | B<C | B<C | 0.912x, 0.650x, 0.585x | PASS/PASS/PASS | PASS/PASS/PASS |
| continuous/small | T04 | B<C | B>C | B<C | B<C | 1.099x, 0.861x, 0.738x | PASS/PASS/PASS | PASS/PASS/PASS |
| continuous/large | T02 | B>C | B<C | B<C | B<C | 0.441x, 0.230x, 0.905x | PASS/PARTIAL/PASS | PARTIAL/PASS/PASS |
| continuous/large | T03 | B>C | B<C | B<C | B<C | 0.475x, 0.284x, 0.916x | PASS/PASS/PASS | PASS/PASS/PASS |
| continuous/large | T04 | B>C | B<C | B<C | B<C | 0.527x, 0.343x, 0.923x | PASS/PASS/PASS | PASS/PASS/PASS |

The universal R176 pattern therefore fails. T02 retains a consistent sign
within each usage mode on both repositories, but T03/T04 do not preserve the
one-shot pattern and continuous/large reverses completely.

## Per-group samples and pre-registered stability

`U+O` is uncached input plus output. The percentage beside response bytes is
the largest individual response divided by the run's total response bytes.
The final column is `max/min` followed by the stability verdict.

### One-shot

| Target/task | Arm | Raw r1/r2/r3 | U+O r1/r2/r3 | Calls | Response bytes (largest share) | Prior context | Wall ms | Grades | Spread/stable |
|---|---|---|---|---:|---|---|---|---|---|
| small/T02 | B | 475,447 / 496,879 / 400,530 | 53,815 / 50,415 / 68,242 | 19/18/16 | 75,828 (16.0%) / 111,211 (15.9%) / 90,404 (13.4%) | 0/0/0 | 79,078/77,352/79,499 | PASS/PASS/PASS | 1.241x / no |
| small/T02 | C | 173,094 / 159,886 / 327,090 | 26,662 / 30,606 / 43,954 | 7/6/13 | 48,245 (47.8%) / 62,647 (39.0%) / 56,642 (20.6%) | 0/0/0 | 47,098/52,421/73,642 | PASS/PASS/PASS | 2.046x / no |
| small/T03 | B | 48,014 / 48,435 / 47,562 | 8,846 / 9,267 / 4,298 | 1/1/1 | 516 (100.0%) / 516 (100.0%) / 516 (100.0%) | 0/0/0 | 14,021/10,001/9,503 | PASS/PASS/PASS | 1.018x / yes |
| small/T03 | C | 84,829 / 47,495 / 37,650 | 9,309 / 5,255 / 5,650 | 4/2/2 | 14,242 (38.7%) / 5,644 (92.5%) / 2,737 (85.1%) | 0/0/0 | 18,901/13,055/12,593 | PASS/PASS/PASS | 2.253x / no |
| small/T04 | B | 57,526 / 70,306 / 69,556 | 10,422 / 13,986 / 13,236 | 2/2/2 | 13,244 (64.3%) / 13,244 (64.3%) / 13,244 (64.3%) | 0/0/0 | 28,029/23,775/26,077 | PASS/PASS/PASS | 1.222x / no |
| small/T04 | C | 48,998 / 84,521 / 25,890 | 19,814 / 20,265 / 14,114 | 2/4/1 | 7,048 (57.0%) / 8,791 (45.7%) / 4,019 (100.0%) | 0/0/0 | 28,194/32,745/18,706 | PASS/PASS/PASS | 3.265x / no |
| large/T02 | B | 360,775 / 289,101 / 271,861 | 35,655 / 39,245 / 55,285 | 12/12/10 | 66,845 (24.5%) / 74,256 (22.0%) / 105,448 (25.1%) | 0/0/0 | 90,554/79,488/65,246 | PASS/PASS/PASS | 1.327x / no |
| large/T02 | C | 286,918 / 169,757 / 207,855 | 39,622 / 29,213 / 31,983 | 9/6/8 | 116,336 (34.7%) / 54,812 (65.3%) / 65,521 (34.7%) | 0/0/0 | 63,679/49,216/59,427 | PASS/PARTIAL/PASS | 1.690x / no |
| large/T03 | B | 89,461 / 109,046 / 85,892 | 14,965 / 15,606 / 12,676 | 3/5/4 | 14,010 (89.1%) / 20,708 (48.1%) / 12,163 (69.7%) | 0/0/0 | 35,041/57,784/33,238 | PASS/PASS/PASS | 1.270x / no |
| large/T03 | C | 31,041 / 64,747 / 47,688 | 13,121 / 10,475 / 15,688 | 1/3/2 | 2,367 (100.0%) / 4,917 (46.9%) / 4,043 (58.5%) | 0/0/0 | 10,978/23,337/15,633 | PASS/PASS/PASS | 2.086x / no |
| large/T04 | B | 53,650 / 53,945 / 48,157 | 7,570 / 7,865 / 8,989 | 2/2/1 | 1,456 (61.0%) / 2,303 (75.3%) / 568 (100.0%) | 0/0/0 | 22,175/11,895/11,215 | PASS/PASS/PASS | 1.120x / yes |
| large/T04 | C | 45,922 / 62,586 / 61,752 | 7,778 / 18,554 / 8,504 | 2/4/3 | 501 (73.9%) / 1,091 (45.7%) / 1,239 (40.3%) | 0/0/0 | 13,982/16,329/14,140 | PASS/PASS/PASS | 1.363x / no |

### Continuous

| Target/task | Arm | Raw r1/r2/r3 | U+O r1/r2/r3 | Calls | Response bytes (largest share) | Prior context | Wall ms | Grades | Spread/stable |
|---|---|---|---|---:|---|---|---|---|---|
| small/T02 | B | 451,465 / 383,326 / 315,874 | 53,897 / 41,822 / 41,698 | 14/14/11 | 96,536 (18.5%) / 78,178 (17.3%) / 83,566 (22.8%) | 4,590/4,589/4,590 | 86,024/62,023/53,342 | PASS/PASS/PARTIAL | 1.429x / no |
| small/T02 | C | 515,991 / 678,867 / 623,525 | 56,727 / 61,651 / 47,525 | 11/11/11 | 35,886 (24.1%) / 40,932 (35.8%) / 35,554 (32.8%) | 46,648/687,180/48,734 | 53,100/50,280/58,557 | PASS/PASS/PASS | 1.316x / no |
| small/T03 | B | 544,588 / 510,714 / 437,038 | 58,444 / 47,098 / 46,894 | 1/2/2 | 8,247 (100.0%) / 8,763 (94.1%) / 8,763 (94.1%) | 103,944/85,276/90,316 | 13,528/10,778/12,054 | PASS/PASS/PASS | 1.246x / no |
| small/T03 | C | 596,948 / 786,119 / 747,687 | 58,324 / 62,919 / 51,623 | 1/1/2 | 398 (100.0%) / 398 (100.0%) / 5,325 (92.5%) | 85,794/731,787/87,439 | 13,758/7,912/15,022 | PASS/PASS/PASS | 1.317x / no |
| small/T04 | B | 748,140 / 818,435 / 616,582 | 67,436 / 67,587 / 56,454 | 3/5/3 | 17,102 (49.8%) / 48,480 (68.5%) / 21,486 (39.6%) | 112,723/94,686/99,726 | 31,485/51,746/28,481 | PASS/PASS/PASS | 1.327x / no |
| small/T04 | C | 680,623 / 951,107 / 835,054 | 62,639 / 67,907 / 55,534 | 1/2/1 | 4,019 (100.0%) / 4,021 (100.0%) / 4,019 (100.0%) | 86,773/732,877/93,709 | 24,225/25,025/25,341 | PASS/PASS/PASS | 1.397x / no |
| large/T02 | B | 263,799 / 181,425 / 501,249 | 53,623 / 32,177 / 68,609 | 6/4/13 | 56,931 (28.7%) / 26,188 (37.8%) / 74,098 (33.5%) | 9,829/9,828/9,829 | 58,113/39,446/99,155 | PASS/PARTIAL/PASS | 2.763x / no |
| large/T02 | C | 598,636 / 789,235 / 553,844 | 69,740 / 78,579 / 49,524 | 2/10/7 | 5,182 (82.6%) / 52,477 (61.6%) / 19,016 (44.0%) | 69,193/74,239/73,265 | 20,718/71,760/53,449 | PARTIAL/PASS/PASS | 1.425x / no |
| large/T03 | B | 338,704 / 269,022 / 626,837 | 65,552 / 37,598 / 74,133 | 1/2/2 | 10,376 (100.0%) / 12,467 (83.2%) / 10,568 (94.3%) | 68,352/37,243/86,482 | 14,197/22,646/22,277 | PASS/PASS/PASS | 2.330x / no |
| large/T03 | C | 713,297 / 948,215 / 684,019 | 73,553 / 83,703 / 53,491 | 2/2/2 | 2,922 (79.0%) / 4,403 (57.1%) / 2,714 (85.0%) | 75,741/130,869/95,201 | 14,366/19,012/22,364 | PASS/PASS/PASS | 1.386x / no |
| large/T04 | B | 416,874 / 361,773 / 713,216 | 67,434 / 51,245 / 76,032 | 1/2/1 | 888 (100.0%) / 1,107 (51.3%) / 888 (100.0%) | 79,587/50,673/97,981 | 10,033/15,898/10,536 | PASS/PASS/PASS | 1.971x / no |
| large/T04 | C | 791,478 / 1,056,267 / 772,359 | 79,542 / 85,771 / 55,303 | 1/1/1 | 110 (100.0%) / 110 (100.0%) / 361 (100.0%) | 79,906/136,790/99,210 | 6,650/7,452/7,132 | PASS/PASS/PASS | 1.368x / no |

Only one-shot/small T03 B and one-shot/large T04 B pass the token-stability
rule. Four T02 groups also change grade: continuous/small B,
continuous/large B, continuous/large C, and one-shot/large C. All other grade
groups are stable.

## Per-cell tools and response concentration

Signatures list tool counts for repetitions 1, 2, and 3 separated by `;`.
Exact ordered sequences are retained in each selected-run CSV.

| Configuration | Task | B signatures r1; r2; r3 | C signatures r1; r2; r3 |
|---|---|---|---|
| one-shot/small | T02 | lookup:11,module:7,search:1; search:1,lookup:9,module:7,prepare:1; search:1,module:7,lookup:8 | exec:7; exec:6; exec:13 |
| one-shot/small | T03 | lookup:1; lookup:1; lookup:1 | exec:4; exec:2; exec:2 |
| one-shot/small | T04 | lookup:2; lookup:2; lookup:2 | exec:2; exec:4; exec:1 |
| one-shot/large | T02 | lookup:7,search:1,module:3,prepare:1; module:4,search:1,lookup:6,prepare:1; lookup:5,search:3,module:1,prepare:1 | exec:9; exec:6; exec:8 |
| one-shot/large | T03 | lookup:3; lookup:4,module:1; lookup:3,search:1 | exec:1; exec:3; exec:2 |
| one-shot/large | T04 | lookup:2; search:1,lookup:1; lookup:1 | exec:2; exec:4; exec:3 |
| continuous/small | T02 | search:1,module:6,prepare:1,lookup:6; search:1,module:8,prepare:1,lookup:4; search:1,module:5,lookup:5 | exec:11; exec:11; exec:11 |
| continuous/small | T03 | lookup:1; lookup:2; lookup:2 | exec:1; exec:1; exec:2 |
| continuous/small | T04 | lookup:3; lookup:5; lookup:3 | exec:1; exec:2; exec:1 |
| continuous/large | T02 | prepare:1,search:1,lookup:4; search:1,module:1,lookup:2; module:3,search:1,prepare:1,lookup:8 | exec:2; exec:10; exec:7 |
| continuous/large | T03 | lookup:1; lookup:2; lookup:2 | exec:2; exec:2; exec:2 |
| continuous/large | T04 | lookup:1; lookup:2; lookup:1 | exec:1; exec:1; exec:1 |

For T02 B, the largest response is only 13.4%-37.8% of a run's response
bytes. The calls have distinct argument sets; no exact request is repeated
within any T02 B run. The excess is therefore a many-call investigation, not
one accidental oversized response or literal duplicate. Across all one-shot
decision cells, native raw tokens correlate strongly with completed calls
(`r=0.993` for B, `r=0.980` for C) and response bytes (`r=0.932` for B,
`r=0.900` for C). These are descriptive correlations, not independent causal
estimates, but they agree with the trace-level mechanism.

## Mechanism attribution

### Fixed MCP schema cost is real but not the root cause

Every B decision cell records the same 10,168 schema-response bytes, including
resumed continuous turns. The 36 B decision cells therefore expose 366,048
schema bytes. This fixed cost can matter for a one-call task, but it is not
amortized by this runner and cannot explain target/task sign reversals or the
hundreds of thousands of T02 tokens. Compressing the public eight-tool schema
is not supported as the R181 correction.

### T02 exposes a structural type-impact capability gap

One-shot T02 B uses 87 calls and 2,294,593 tokens; C uses 49 calls and
1,324,600 tokens. The 969,993-token T02 difference is 87.5% of the entire
one-shot B-over-C difference. B is more expensive in all six one-shot T02
matches while returning 6/6 PASS versus C's 5 PASS and 1 PARTIAL.

Read-only inspection of the pinned V2 indexes explains the call path:

- the small index has 9,444 `CALLS` and 10,153 `CONTAINS` edges, a `GraphData`
  node, and no type-reference edge family;
- the large index has 246,155 `CALLS` and 54,287 `CONTAINS` edges, no
  `PlaywrightTestConfig` node (it is a type alias), and no type-reference edge
  family.

`prepare_edit_context` is an edit-risk/file-context tool, not an exact
alias-aware type-impact query. When agents try it, its 13-16 KB response is one
of many calls and may analyze unrelated nodes from the whole declaration file.
The model then follows aliases and dependent types through distinct
`lookup_source_text`, `get_module_context`, and search calls. This is a real,
cross-repository product capability gap, not a single bad payload.

The evidence supports an additive `type_dependents` operation in the existing
read-only `lookup_source_text` tool. It must use TypeScript symbol identity,
follow aliases and re-exports, accept an exact declaration path plus symbol and
bounded include prefixes, exclude tests by default, return sorted impacted
files with completeness metadata, and remain general rather than encode T02
answers. This is an MCP contract extension, but the repeated cross-target
one-shot mechanism and correctness requirement justify it. It is not a new
MCP tool and requires no index-format migration if implemented as bounded
on-demand analysis over indexed source paths.

### T03/T04 do not justify a second correction

Small T03 B is a stable one-call `lookup_source_text` path. Large T03 B uses
3-5 calls because the stored direct-caller summary is name-ambiguous and does
not return exact call-site line/column locations, so agents verify aliases with
literal searches. Small T04 similarly uses two calls to convert caller counts
to exact repeated call-site lines. Those limitations belong to the existing
`direct_callers` surface, which R181 explicitly excludes after R177/R179.
T04 signs also flip, and its combined one-shot difference is only 23,471
tokens. No T03/T04 or direct-caller change is authorized by this round.

### Continuous/small is carry-over, not V2 amortization

The runner reconnects the MCP server and exposes the same 10,168 schema bytes
on every resumed B turn, so there is no measured schema amortization. Instead,
T02 begins after the mandatory T01 warm-up:

| Target/arm | T01 raw r1/r2/r3 | T01 response bytes r1/r2/r3 | T02 prior observed bytes r1/r2/r3 |
|---|---|---|---|
| small/B | 50,471/50,351/41,838 | 2,767/2,767/2,767 | 4,590/4,589/4,590 |
| small/C | 190,075/288,758/267,070 | 42,973/681,556/44,078 | 46,648/687,180/48,734 |
| large/B | 69,681/68,938/68,834 | 6,747/6,747/6,747 | 9,829/9,828/9,829 |
| large/C | 489,147/331,752/279,019 | 61,146/67,509/66,483 | 69,193/74,239/73,265 |

The small/C repetition-2 warm-up alone injects 681,556 response bytes before
T02. Subsequent continuous turns repeatedly pay for prior conversation state;
continuous B raw tokens correlate with the recorded prior observed bytes at
`r=0.721`, while one-shot has zero prior context. The fresh continuous B
advantage is therefore session carry-over from a much cheaper out-of-scope T01
warm-up, not evidence that T02-T04 fixed costs were amortized. The fact that
continuous/large also reverses R176 shows that the old repository-size story
was a single-sample artifact.

## Pre-fix decision

R181 will implement only the general alias-aware `type_dependents` operation
inside `lookup_source_text`, with focused correctness, safety, truncation, and
schema tests. It will not change T01/direct callers, add a ninth MCP tool,
change the persistent index format, compress schemas, or tune prompts. After
the correction is committed and pushed, the identical N=3 B/C schedule will
be rerun. The pre-registered non-overlapping-range thresholds will decide
whether each cell helped, was inconclusive, or worsened; an attractive mean
alone cannot accept the change.
