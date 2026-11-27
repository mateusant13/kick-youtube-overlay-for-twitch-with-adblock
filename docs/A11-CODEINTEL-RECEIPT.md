# A11 · codeintel `full` here, and the revival gate that already exists

Receipt for DM `dm-0d23648ea897a2fb1d16-5` (lane-gravador). Run on this checkout 2026-11-27,
load `{"verdict":"READY","total":63.1,"busiest":82.7,"pinned":0}` measured immediately before.

## 1. Producer (small clean scope, ceiling declared: 1 process, 400 files, 10 min, output on `G:`)

```
$ py -3 -m codeintel full --scope kick-overlay --json --max-population-files 400 \
      --stream G:/Temp/ko-scratch/a11-stream.json H:/kicktwitchyoutube_instagram
rc=0  real 0m8.096s  150571 bytes
summary: AMBIGUOUS-PROVENANCE=35 CONFIG-KEY-ORPHAN=65 DEAD-CONFIG-KEY=71 INERT-GRADUATION=23
  NEAR-DUPLICATE-CAUSE=3 PASS=2 RUNG-LAG=5 SELECTOR-MATCHES-NOTHING=4 STALE-UNRESOLVED=35
  UNORDERED-CAP-SLICE=3 VIOLATION=1 total=65 cannot_measure=0 detectors_measured=18/18 exit=0
```

`detectors_measured=18/18`, `cannot_measure=0` — the two figures the proven recipe also quotes.

## 2. Scorer: CANNOT-MEASURE, by the scorer's own refusal

```
$ py -3 benchmarks/full_audit/score.py --findings G:/Temp/ko-scratch/a11-kick.json --expect-scope kick-overlay
score.py: error: the following arguments are required: --truth
```

No truth file exists for this repo (`fd -H ground_truth`, `fd -H FullAudit` → nothing;
`.agents/work/FullAudit` absent). Grading the producer against a truth written from its own
findings is circular, so recall/precision/outside_scope are **CANNOT-MEASURE**, not a number.

## 3. The revival gate is code here, and it runs

```
$ grep -rn "revival-" --include=*.mjs _tools/gate/checks/
_tools/gate/checks/revival.mjs:52  name: 'revival-features'
_tools/gate/checks/revival.mjs:67  name: 'revival-budgets'
_tools/gate/checks/revival.mjs:96  name: 'revival-friction'
_tools/gate/checks/revival.mjs:128 name: 'revival-failfast'
```

`node _tools/ko-verify.mjs` → `RESULT PASS checks=43 failed=0`; the four rows read
`revival-features PASS · revival-budgets PASS (3/3 timing rows refused on a starved box) ·
revival-friction PASS · revival-failfast PASS (119 files, 0 unbounded fetch/spawn/loop)`.
They call `feature_map_sync.py --repo . --gate`, `benchmark_history.py`, `loop_friction_audit.py
measure --repo . --gate` and `fail_fast_audit.py scan --repo . --gate --all-code`.

## 3b. The gap that WAS real, now closed in code

`_tools/gate/checks/suites.mjs` reported all 13 behavioural suites from `r.status === 0` alone,
while its own header claimed "the gate checks rc and the verdict string". A suite printing
`RESULT FAIL ... failed=1` and exiting 0 read as PASS in the receipt — a red laundered into a green
by the gate itself.

```
$ git diff HEAD -- _tools/gate/checks/suites.mjs | grep '^+.*assertPrintedVerdict'
+export function assertPrintedVerdict(ctx, r, rel) {
+  assertPrintedVerdict(ctx, r, rel);      # runSuite, once for every suite
$ node _tools/gate/suite-verdict-selftest.mjs
ok rc 0 with a printed RESULT FAIL is REFUSED
RESULT PASS suite-verdict checks=7 failed=0 arms=6/6
```

Registered as check `suite-verdict` in `_tools/gate/checks/instruments.mjs`: rc 0 + printed
`RESULT FAIL` refused, rc 0 + `RESULT PASS` accepted, rc 2 refused, no verdict refused, last verdict
decides, and the runner still calls it.

## 4. `harness/angulos.tsv` is the falsifier matrix

```
$ head -1 harness/angulos.tsv
# feature	angle	cmd	expect	neg	note	timeout_s        # 15 data rows
$ node kick-overlay/ad-detect-test.cjs
ARMS 134/134
RESULT PASS ad-detect: the DOM detector sees the ad Twitch paints, and the media worker is hooked (failed=0)
```

Superset of the DM's `<regra>\t<feature>\t<comando>`: also carries the expected output and a
negative/plant command per row, so a row is a falsifier. The one matrix keeps that definition;
`_tools/gate/checks/tooling.mjs`, `_tools/harness-cwd.mjs`,
`_tools/harness-plant.mjs` and `AGENTS.md:485,493` already read `angulos.tsv`.

## Reproduce

```
py -3 -m codeintel full --scope kick-overlay --json --max-population-files 400 H:/kicktwitchyoutube_instagram
py -3 benchmarks/full_audit/score.py --findings <that json> --truth <a real truth set> --expect-scope kick-overlay
node _tools/ko-verify.mjs
node kick-overlay/ad-detect-test.cjs
```
