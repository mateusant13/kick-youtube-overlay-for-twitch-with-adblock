# A11 · codeintel `full` here, and the revival gate that already exists

Receipt for DM `dm-0d23648ea897a2fb1d16-5` (lane-gravador). Run on this checkout 2026-11-27,
load `{"verdict":"READY","total":63.1,"busiest":82.7,"pinned":0}` measured immediately before.

## 1. Producer (small clean scope, ceiling declared: 1 process, 400 files, 10 min, output on `G:`)

Re-run at the commit this checkpoint names, same scope, so a reader can tell these numbers from last
week's. **A verdict without the build that produced it is `CANNOT-COMPARE`** (seat, DM
`dm-1ab8ac747808dd73e77b`): the detector set lives in the installed codeintel, not in this tree, and two
builds of the same argv disagree here. The build line below is the tool's own:

```
$ py -3 -m codeintel --version
codeintel 14.0.0 root=H:\codeintel-worktrees\triad-milestones-20261105 sha=d552474de514
  branch=mission/consolidated-20261105 dist=consultgpt
$ py -3 -m codeintel full --scope kick-overlay --json --max-population-files 400 \
      --stream G:/Temp/ko-scratch/a11-stream3.json H:/kicktwitchyoutube_instagram
rc=2  real 0m23.9s
population_counts       = {scope: 65, outside-scope: 0, scratch: 0}
population_class_counts = {product: 65, docs: 0, tests: 0, benchmarks: 0}
findings=65  verdict=partial  total=25
detectors_measured=25/25  detectors_pending=[]  cannot_measure=259
HEAD medido: 1e87c89
```

An earlier run of the same argv on this box resolved an older install and returned `rc=0`,
`verdict=pass`, `total=18`, `18/18`, `cannot_measure=0` in 3.3 s. **That build no longer resolves here**,
so its `pass` is `CANNOT-REPRODUCE` and must not be published as this tool's verdict; the numbers above
(25 detectors, `partial`, 259 refusals) are what the installed build says today. The delta was the BUILD,
not the tree: both runs agree on `population=65` and `findings=65`.

**The 65 findings are one class, not 65 defects.** All 65 are `CONFIG-KEY-ORPHAN` from detector
`config_drift`, evidence `origin: config file entry`, e.g. `"name"` at `kick-overlay/manifest.json:2`
("config file entry but no reader names it"). Grouped by file: `kick-overlay/manifest.json` 47,
`kick-overlay/rules.json` 18. **Zero findings land on a source file** — they are dead config KEYS.

**Population beside the verdict, and what it does not cover.** The walk enumerates 65 files
(`population_counts.scope=65`) and `population_class_counts` labels all of them `product`, so the
population is **not** zero — `scope=0` is not what this command returns. But the label is the walk's,
not coverage: it counts files the walker classified, and every finding it produced is over JSON config.

The walk is also where the tool states its own limit, no longer just where we derive it: the **259
`cannot_measure` rows are 7 detectors x 37 files** (`ARCHITECTURE-CONTRACT-DRIFT`,
`MISSING-CHECKPOINT-LONG-WALK`, `MISSING-OBSERVABILITY`, `MISSING-RETRY-BOUND`, `NO-CACHE-OR-INCREMENTAL`,
`SILENT-WORKER-NO-TELEMETRY`, `UNBOUNDED-GROWTH-NO-CAP`), each refusing with
`reason: revival_std cannot measure <file>: syntax error: invalid syntax (<file>, line 3)` — i.e. the
Python parser handed a non-Python file. **161 of those 259 rows name a `.js`/`.mjs`/`.cjs`/`.ts` file.**

File census, measured at `fd3893e` rather than quoted from the preflight (whose `js` column counts
`.js`/`.mjs`/`.ts` only and therefore omits `.cjs`):

| population | .js | .mjs | .ts | .cjs | total |
|---|---:|---:|---:|---:|---:|
| tracked (`git ls-files`) | 12 | 70 | 0 | 15 | **97** |
| on disk (`fd -t f`) | 21 | 91 | 1 | 15 | **128** |

So the honest sentence is:

```
populacao JS: 113 arquivos (.js/.mjs/.ts) + 15 .cjs = 128; o auditor nao cobre, CANNOT-MEASURE
```

`verdict=partial` (and the earlier `pass`) is therefore a statement about Python-side detectors over this
tree's config surface, never a clean bill for the JS product. `total=25` counts detectors that *ran*,
which is a different count from detectors that *apply*.

Whole-repo run, same build, same commit (the scope that also sees the root config/registry files):
`population_counts.scope=205`, `population_class_counts.product=205`, `findings=205`,
`verdict=partial`, `total=25`, `detectors_measured=25/25`, `cannot_measure=1421`, 6.6 s. The earlier
18-detector build reported `scope=187` / `findings=187` / `verdict=fail` for the same scope, which is the
same build-dependence as above: the walk the two builds share is the tree, the counts are the build's.

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

`node _tools/ko-verify.mjs` → `RESULT PASS checks=43 failed=0`, re-measured at the commit the receipt
names (`1e87c89`, 100.2 s, load `{"verdict":"READY","via":"watcher-traffic-light"}` immediately
before); the four rows read
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
