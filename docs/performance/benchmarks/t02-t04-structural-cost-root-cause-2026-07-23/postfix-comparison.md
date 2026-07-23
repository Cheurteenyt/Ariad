# R181 T02-T04 correction comparison

## Decision

The `lookup_source_text.type_dependents` correction is **accepted** under the
pre-registered gate. All four targeted T02 B groups are `HELPED`: every
post-fix maximum is at least 10% below the corresponding baseline minimum,
and no grade regresses. None of the eight selected T03/T04 B groups is
`WORSE`. Six are `NO CONCLUSIVE MATERIAL CHANGE`; the two continuous/small
T03/T04 groups meet the help threshold because they inherit a substantially
smaller preceding T02 turn, not because their own operation changed.

All 12 post-fix T02 B cells used the new `type_dependents` operation. The six
large-target cells use exactly one MCP call and return 952 response bytes. The
small-target agent still performs some optional discovery, but its T02 mean
call counts fall from 17.67 to 5.00 one-shot and from 13.00 to 3.67 continuous.
This is the supported many-call mechanism identified before the fix, not a
post-hoc aggregate correlation.

## Integrity and environment

The identical 24-invocation postfix schedule completed on attempt 1 with exit
code 0 in 2,817.9 seconds. It produced 84 raw cells: 72 T02-T04 decision cells
and 12 continuous T01 context-only warm-ups. Every repetition selects 28
cells, including its four warm-ups, with zero invalid cell.

All 24 append-once environment captures record pre-registration SHA
`1ced999a49a647b22fc5e08a6a1d5a50fafc1bbe`, clean branch head
`cd78ae40c4f834d6a1dfdb02c2eabcb688f4f329`, Windows 11 Pro, AMD Ryzen 9
5900X with 24 logical processors, 42,849,894,400 bytes RAM, Node `v24.15.0`,
npm `11.12.1`, Codex CLI `0.144.4`, model `gpt-5.6-sol`, and reasoning
`medium`. Captures span `2026-07-23T00:55:25.781Z` through
`2026-07-23T01:36:11.081Z`; no version, branch, cleanliness, or host drift is
present.

The immutable postfix checkpoints are:

- [repetition 1 aggregate](postfix-rep-1/aggregate-and-ratios.md),
  [per-task table](postfix-rep-1/per-task.md),
  [selected runs](postfix-rep-1/selected-runs.csv), and
  [raw manifest](postfix-rep-1/raw-artifact-manifest.json): 156 artifacts,
  833,246 bytes, tree
  `6362e5e8f15cc5a230c3a15d5e2ad01aa3c2762e484f220bd37a2f5c5176800c`;
- [repetition 2 aggregate](postfix-rep-2/aggregate-and-ratios.md),
  [per-task table](postfix-rep-2/per-task.md),
  [selected runs](postfix-rep-2/selected-runs.csv), and
  [raw manifest](postfix-rep-2/raw-artifact-manifest.json): 156 artifacts,
  1,389,660 bytes, tree
  `0d2b287c67f16a77d8baf873c382a0855129a95383c06d3f943ec1601d93c7ee`;
- [repetition 3 aggregate](postfix-rep-3/aggregate-and-ratios.md),
  [per-task table](postfix-rep-3/per-task.md),
  [selected runs](postfix-rep-3/selected-runs.csv), and
  [raw manifest](postfix-rep-3/raw-artifact-manifest.json): 156 artifacts,
  692,127 bytes, tree
  `10a26088e33dcdb036f93cf266f433341c1ffd158743a91f5964a9100b20f62b`.

## B correction gate

Raw-token columns are `min-max (arithmetic mean)` across N=3. Grade triples
are repetitions 1/2/3, with `P` meaning PASS. Calls and response bytes are
arithmetic means. `HELPED`
and `NO CHANGE` apply the pre-registered non-overlapping-range rules, not the
mean delta alone.

| Configuration/task | Baseline raw | Postfix raw | Mean delta | Grades pre -> post | Calls pre -> post | Response bytes pre -> post | Gate |
|---|---:|---:|---:|---|---:|---:|---|
| one-shot/small T02 | 400,530-496,879 (457,619) | 87,467-153,031 (130,760) | -71.4% | P/P/P -> P/P/P | 17.67 -> 5.00 | 92,481 -> 15,602 | **HELPED** |
| one-shot/small T03 | 47,562-48,435 (48,004) | 39,356-48,763 (45,399) | -5.4% | P/P/P -> P/P/P | 1.00 -> 1.00 | 516 -> 516 | NO CHANGE |
| one-shot/small T04 | 57,526-70,306 (65,796) | 57,808-78,377 (71,225) | +8.3% | P/P/P -> P/P/P | 2.00 -> 2.67 | 13,244 -> 18,739 | NO CHANGE |
| one-shot/large T02 | 271,861-360,775 (307,246) | 53,829-66,024 (61,948) | -79.8% | P/P/P -> P/P/P | 11.33 -> 1.00 | 82,183 -> 952 | **HELPED** |
| one-shot/large T03 | 85,892-109,046 (94,800) | 88,849-105,544 (95,685) | +0.9% | P/P/P -> P/P/P | 4.00 -> 4.00 | 15,627 -> 18,240 | NO CHANGE |
| one-shot/large T04 | 48,157-53,945 (51,917) | 39,000-65,534 (52,876) | +1.8% | P/P/P -> P/P/P | 1.67 -> 1.67 | 1,442 -> 1,442 | NO CHANGE |
| continuous/small T02 | 315,874-451,465 (383,555) | 129,611-177,551 (145,673) | -62.0% | P/P/Partial -> P/P/P | 13.00 -> 3.67 | 86,093 -> 10,717 | **HELPED** |
| continuous/small T03 | 437,038-544,588 (497,447) | 194,902-253,308 (222,324) | -55.3% | P/P/P -> P/P/P | 1.67 -> 2.33 | 8,591 -> 7,939 | HELPED |
| continuous/small T04 | 616,582-818,435 (727,719) | 269,027-451,475 (349,382) | -52.0% | P/P/P -> P/P/P | 3.67 -> 3.67 | 29,023 -> 26,478 | HELPED |
| continuous/large T02 | 181,425-501,249 (315,491) | 108,488-129,236 (120,644) | -61.8% | P/Partial/P -> P/P/P | 7.67 -> 1.00 | 52,406 -> 952 | **HELPED** |
| continuous/large T03 | 269,022-626,837 (411,521) | 144,297-265,118 (217,631) | -47.1% | P/P/P -> P/P/P | 1.67 -> 3.67 | 11,137 -> 8,793 | NO CHANGE |
| continuous/large T04 | 361,773-713,216 (497,288) | 181,818-339,989 (277,320) | -44.2% | P/P/P -> P/P/P | 1.33 -> 1.67 | 961 -> 1,343 | NO CHANGE |

The public MCP schema grows from 10,168 to 10,945 response bytes per B cell,
a fixed increase of 777 bytes. That overhead is present in every selected B
cell and is therefore included in the table. It produces no pre-registered
`WORSE` result: all four one-shot T03/T04 groups have overlapping raw-token
ranges and unchanged PASS grades.

## C environmental control

The control confirms why range gates matter. C changes even though its product
path is untouched: one-shot C falls 16.3% in aggregate while continuous C
rises 16.4%. These shifts are agent/session variance and prevent attributing
the whole B aggregate change to product code. They do not erase the four T02 B
decisions, whose post-fix ranges are fully separated below their own baseline
ranges and whose traces all exercise the new operation.

| Configuration/task | Baseline raw | Postfix raw | Grades pre -> post | Calls pre -> post | Response bytes pre -> post |
|---|---:|---:|---|---:|---:|
| one-shot/small T02 | 159,886-327,090 (220,023) | 87,225-292,290 (190,992) | P/P/P -> P/P/P | 8.67 -> 7.33 | 55,845 -> 62,465 |
| one-shot/small T03 | 37,650-84,829 (56,658) | 38,649-53,407 (46,385) | P/P/P -> P/P/P | 2.67 -> 2.33 | 7,541 -> 8,219 |
| one-shot/small T04 | 25,890-84,521 (53,136) | 32,015-50,090 (43,641) | P/P/P -> P/P/P | 2.33 -> 1.67 | 6,619 -> 5,797 |
| one-shot/large T02 | 169,757-286,918 (221,510) | 102,565-269,904 (177,236) | P/Partial/P -> P/P/Partial | 7.67 -> 7.33 | 78,890 -> 53,850 |
| one-shot/large T03 | 31,041-64,747 (47,825) | 47,045-63,566 (54,080) | P/P/P -> P/P/P | 2.00 -> 2.67 | 3,776 -> 3,327 |
| one-shot/large T04 | 45,922-62,586 (56,753) | 36,836-36,881 (36,857) | P/P/P -> P/P/P | 3.00 -> 2.00 | 944 -> 855 |
| continuous/small T02 | 515,991-678,867 (606,128) | 466,489-623,990 (564,703) | P/P/P -> P/P/P | 11.00 -> 8.33 | 37,457 -> 44,487 |
| continuous/small T03 | 596,948-786,119 (710,251) | 548,810-759,347 (686,777) | P/P/P -> P/P/P | 1.33 -> 1.67 | 2,040 -> 3,566 |
| continuous/small T04 | 680,623-951,107 (822,261) | 633,664-867,403 (781,057) | P/P/P -> P/P/P | 1.33 -> 1.00 | 4,020 -> 4,031 |
| continuous/large T02 | 553,844-789,235 (647,238) | 661,398-1,103,405 (870,989) | Partial/P/P -> P/P/P | 6.33 -> 11.33 | 25,558 -> 76,460 |
| continuous/large T03 | 684,019-948,215 (781,844) | 832,298-1,308,771 (1,071,443) | P/P/P -> P/P/P | 2.00 -> 2.33 | 3,346 -> 3,067 |
| continuous/large T04 | 772,359-1,056,267 (873,368) | 947,693-1,447,060 (1,194,127) | P/P/P -> P/P/P | 1.00 -> 1.00 | 194 -> 111 |

## Aggregate boundary

Across the 36 decision cells per arm, B improves from 34 PASS / 2 PARTIAL to
36 PASS and falls from 11,575,204 to 5,372,595 raw tokens (-53.585%), from 200
to 94 calls (-53.0%), and from 1,181,112 to 335,133 response bytes (-71.626%).
C moves from 34 PASS / 2 PARTIAL to 35 PASS / 1 PARTIAL and rises from
15,290,990 to 17,154,864 tokens (+12.189%).

Post-fix B uses 1,373,676 one-shot tokens versus C's 1,647,578, a B/C ratio
of `0.833754760x`; the baseline ratio was `1.563307x`. B therefore changes
from 56.33% more expensive to 16.62% less expensive in the measured one-shot
T02-T04 aggregate. Continuous B uses 3,998,919 tokens versus 15,507,286 for C,
but that usage mode remains context-confounded and is not an amortization
claim. Across both modes, post-fix B/C is `0.313182022x`, or 68.682% fewer B
tokens at slightly higher aggregate correctness.

These are protocol- and repository-specific results. They establish that the
confirmed T02 many-call defect is fixed; they do not establish a universal
token-savings percentage for arbitrary repositories or questions.
