# harness/twins: recorded offline twins

A twin is recorded bytes plus a grader that compares a fresh tool run against those bytes. It is not a mock. The ring recordings are the `ko.adlog` rows the shipped extension wrote during finished `ko-replica` runs, and the route golden is the stdout of the shipped `kick-overlay/yt-route-test.cjs`. `replay.mjs` grades the fresh output against `twins.json`: exact substrings, exact `VERDICT` defect-bullet set, and exact exit code. A new bullet or a missing bullet is a FAIL, with both sets named in the reason.

## The three live waits this package replaces

| Friction row | Twin id | Evidence recorded | Replay command |
|---|---|---|---|
| `friction.twitch_live_dep` | `dev-handback-wait` | 129 ring rows, `0.8.126`, hand-back at 28.0 s with the native parked at `rs=2` | `node harness/twins/replay.mjs --twin dev-handback-wait` |
| `friction.browser_live_wait` | `dev-ring-buzzyi` | 215 ring rows, replayed real-broadcast ring, one parked-player finding | `node harness/twins/replay.mjs --twin dev-ring-buzzyi` |
| `friction.youtube_live_dep` | `yt-route` | 8 lines of stdout from the resolver suite, including the negative arm | `node harness/twins/replay.mjs --twin yt-route` |

Run all of them with `node harness/twins/replay.mjs --all`, or get the machine object with `node harness/twins/replay.mjs --twin dev-handback-wait --json`. No command here launches Chrome, reads a live page, or touches the network. The `harness` tree is skipped by the friction scanner's walk, so the recorded bytes cannot re-trigger the live-dependency detector.

## Capture procedure

A ring twin starts with a finished replica run. `run.mjs` launches the isolated guest Chrome and writes `<scratch>/report.json`; the default scratch root is `G:/Temp/ko-replica/runs`. The run that produced a recording is named verbatim in `twins.json` under `source_run`.

```
node _tools/ko-replica/run.mjs --scenario _tools/ko-replica/scenarios/dev-handback-wait.json
node harness/twins/capture.mjs --run G:/Temp/ko-replica/runs/dev-handback-wait-1795722597544 --id dev-handback-wait
```

The three recordings came from these exact runs: `dev-handback-wait-1795722597544` (129 rows), `dev-preroll-hold-1795723612165` (135 rows), and `dev-ring-buzzyi-1795723785197` (215 rows). `capture.mjs` reads `report.json`, refuses a missing run dir or missing rows with exit 2, and writes one compact LF line plus a trailing LF to `harness/twins/recordings/<id>.json`. The route golden was written by redirecting one run of `node kick-overlay/yt-route-test.cjs` to `harness/twins/recordings/yt-route-golden.txt`. `dev-preroll-hold.json` is kept as a companion recording; it has no registered friction row, so `--all` grades the three twins in the table above.

## The 15 s law

Every replay command has to finish inside 15 s from a warm checkout. The grader gives each spawned tool a 12 s timeout. Measured in this worktree on 2026-11-26:

```
$ node harness/twins/replay.mjs --all
TWIN PASS dev-handback-wait kind=ring-replay defects=3 ms=196
TWIN PASS dev-ring-buzzyi kind=ring-replay defects=1 ms=141
TWIN PASS yt-route kind=suite-golden defects=0 ms=252
TWIN RESULT PASS twins=3 failed=0 ms=590
```

That is 590 ms for all three, which leaves the per-twin budget mostly unused. One caveat is measured, not hidden: a cold first `yt-route-test.cjs` run on the SMR volume took 24 s, so the budget is a property of the warm recorded replay path, not of a cold filesystem cache.

`node harness/twins/replay.mjs --selftest` proves the grader is capable of failing. It corrupts one expected bullet in memory and grades again, then grades a temporary copy of a recording truncated to 5 rows. Both arms must FAIL, and the temp copy is deleted. It prints `SELFTEST PASS arms=2` only when both arms fail.

## Why `expected_rc` is 1 for a ring twin

`_tools/ko-adlog-verdict.mjs` prints `VERDICT ... defects=<n>` followed by one `  - <finding>` line per defect class, and exits 1 when any such class is present. These rings deliberately contain parked-player and frozen-display findings: `dev-handback-wait` starves the native at the pod end so the hand-back resumes at `rs=2`, and the same park is present in the replayed real-broadcast ring. A green exit would mean the intended evidence was lost. The expected exit code is therefore 1, and the grader requires the observed code to match it. The route suite exits 0 on its six passing checks, so `yt-route` expects 0.

## What these twins cannot prove

The limits below are copied from `_tools/ko-replica/README.md`, with the twin-specific limits added at the end.

- No real stitched-ad playlist. Five 100 s captures with `--navigate` on live channels (rodil, shygo twice, xqc on 2026-11-26 at 20 640 viewers) produced zero pods. The clean bodies from xqc carry only `timestamp`, `twitch-session`, `twitch-stream-source` and `twitch-trigger` DATERANGE classes, so the ad shape in a replica is reconstructed from the extension's own worker digests, not a live sample. A capture that prints `ad-segments=0` measures the window, not a `false`.
- No hand-back with `basis:'pod-end'`, where `se` trails the wall clock by a pod length. The replica's `se` follows the element clock, so that branch can only be proven by its unit arm.
- No viewer who watched longer than the pod lasted, which is the real condition for that branch.
- A native element below `HAVE_FUTURE_DATA` at the pod end while the clean frame is still decoding is now produced. `dev-handback-wait` uses `stall:{on:'native', atMs:0, ms:30000, allowFirst:2}` and reaches `rs=2`. The earlier `on:'all'` attempt starved both surfaces and produced `native-seek-skipped {rs:4, podExtent:14}` with `handback-wait n=0`; writing `readyState` from the page would fake the product's own input and is not done.
- One variant and one fixed bitrate, so quality switching is not exercised. `#EXT-X-START` and `EXT-X-PLAYLIST-TYPE:EVENT` are ignored by the bundled hls.js; the join position is always `edge - liveSyncDuration`.
- The kick layer never mounts because its API answers 404 here, so these scenarios measure the ad path, not the cross-platform swap.
- Nothing here proves the product on the owner's machine and it is not a substitute for that: the extension's own gate plus a live run stay the reference.
- `fetchedBy` is `CANNOT-MEASURE` from a report: the extension ring has no page-fetch event, so a report can only say `worker`. From a replica-server capture it is also `CANNOT-MEASURE`, because the server cannot attribute an HTTP request to a CDP target.
- A ring records the extension's decisions. It cannot prove decoded pixels or Chrome-only DOM behaviour, including what the owner actually saw on screen.
- `dev-ring-buzzyi` is a replay of a real-broadcast ring captured earlier, not a fresh live run and not a fresh browser page wait.
