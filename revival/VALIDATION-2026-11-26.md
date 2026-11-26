# Validation 2026-11-26 — adversarial verification of revival v3.0.1 (P0-04..P0-08)

Lane: SubOrch-Verify (adversarial). Base commit `e66f551`, worktree
`G:/Temp/revival-wt/kicktwitchyoutube_instagram/SubOrch-Verify-20261126T201838Z-59036`.
Read-only on product code. Every row below was executed on this machine; commands and outputs are quoted
verbatim, trimmed only to the field that decides the row.

Scope note: the brief names "the 0.8.127 hand-back wait". No 0.8.127 exists in this tree
(`jq -r .version kick-overlay/manifest.json` -> `0.8.126`, and `grep -rn "0.8.127"` over the repo -> 0 hits).
The hand-back wait is the 0.8.122..0.8.126 code in `kick-overlay/twitch-adblock.js:3106-3206`.

| # | Claim under test | Test (command) | Result (measured) | Verdict |
|---|---|---|---|---|
| A1 | Build `0.8.127` carries the hand-back wait | `jq -r .version kick-overlay/manifest.json`; `grep -rn "0.8.127" .` | `0.8.126`; zero hits for `0.8.127` anywhere | **REFUTED** (label only; the code exists at 0.8.126) |
| A2 | At a pod end with the native below HAVE_FUTURE_DATA the wait arms, the frame stays mounted and the native is not resumed | probe `hb-probe.cjs` case A (real world from `kick-overlay/mute-decision-test.cjs`, `setNative rs:1` + `pod()` + `bypass {type:'ad-end'}`) | `handback-wait {"rs":1,"cleanLat":3,"capMs":3000}`, `frameMounted:true`, native `{rs:1,paused:true}`, `native-resume:[]` | **SUPPORTED** |
| A3 | "A pod end never puts a frozen native on screen" (the 0.8.122 defect class) | probe cases B and C: same starved state, pod ended by `bypass {type:'ad-fail'}` and by the 180 s ceiling | B: `frameMounted:false`, `handback-wait:[]`, `native-resume [{"tag":"ad-end","rs":1,"ct":37}]`. C (181 s of a healthy advancing frame): `frameMounted:false`, `handback-wait:[]`, `native-resume [{"tag":"ad-end","rs":1,"ct":30,"selfPaused":180}]` | **REFUTED** — the wait is scoped to `reason === 'ad-end'` (`twitch-adblock.js:3141`); two other pod-end doors hand back `rs:1` |
| A4 | Those doors are production-reachable, not theoretical | source: `setTimeout(() => stopAdOverlay('timeout'), 180*1000)` armed at reveal (`:3470`); `stopAdOverlay('ad-fail')` with no revealed/rs guard (`:4850-4852`); `ad-fail` producer `postBypass({type:'ad-fail'})` (`:5740`, `:5744`). Owner ring: `AGENTS.md:1863`, `:1878`, `:2234` (`native-handoff {podAgeMs:180008}` / `180012`, two pods that ran the whole ceiling) | the 180 s door is the ceiling the owner's own ring already recorded; the `ad-fail` door has no guard | **SUPPORTED** (reachability) |
| A5 | A visibility change after the wait is armed bounds or cancels it | `grep -rn handbackWait kick-overlay/` outside `twitch-adblock.js`; handler at `:650-661` | only the suite's `stats().handbackWait()` reads it; the `visibilitychange` handler touches `hiddenAt` and `requestStandby` only. The ceiling is a `setTimeout`, and a hidden tab's timer deferral is not measurable in the stub world | **CANNOT-MEASURE** (no door cancels it; throttled-tab duration unproven) |
| B1 | The virtual clock keeps both timer-heavy suites green with identical check counts | `node mute-decision-test.cjs`, `node ad-time-continuity-test.cjs` (worktree, no mutant) | `RESULT PASS mute-decision checks=95 failed=0` wall `1.107s`; `RESULT PASS ad-time-continuity checks=185 failed=0`, `ARMS 29/29 present`, wall `7.569s` | **SUPPORTED** (budget ceilings 15 s / 60 s, `benchmarks/budgets.json:70,89`) |
| B2 | The suites really depend on `advance()` (a no-op advance must fail them) | scratch copy of the clock with `function advance(ms) { return undefined; ... }`, both suites | `RESULT FAIL mute-decision checks=95 failed=12` rc=1; `ad-time-continuity` rc=1, `RESULT FAIL the hidden gap was not accounted for: {"hiddenAt":0,"hiddenGapMs":0,...}` | **SUPPORTED** |
| B3 | `KO_REAL_CLOCK=1` replays the real-timer path and stays green | `KO_REAL_CLOCK=1 node mute-decision-test.cjs`; `KO_REAL_CLOCK=1 node ad-time-continuity-test.cjs` | `RESULT PASS mute-decision checks=95 failed=0` wall `74.567s`; `RESULT PASS ad-time-continuity checks=185 failed=0`, `ARMS 29/29`, wall `271.378s` | **SUPPORTED** (documented 70.7 s / 269.8 s reproduced) |
| C1 | `KO-20261109-01` was repaired to `fixed_in 0.8.57` | `git log --grep='0\.8\.5[2-7]'`; `git log -S inheritState`; `git show 01e954a:kick-overlay/manifest.json` | history goes `0.8.52` (`00d6598`) -> `0.8.57` (`01e954a`); no 0.8.53/54/55/56 commit exists; `inheritState` first appears in `01e954a`; manifest there = `0.8.57` | **SUPPORTED** (0.8.57 is the first version that ever contained the fix) |
| C2 | `KO-20261115-01` was repaired to `fixed_in 0.8.92` | `git log -S native-timeline-reset`; `git show 22a746d:kick-overlay/manifest.json` | first hit `22a746d`; manifest = `0.8.92` | **SUPPORTED** |
| C3 | `KO-20261125-01` was repaired from `unreleased` to `fixed_in 0.8.116` | `git show <c>:kick-overlay/twitch-adblock.js \| grep -c routeWorkerPlaylist` at `370a7f7` (0.8.115 release) and `de94ae9` (0.8.116); `git merge-base --is-ancestor` | `370a7f7` -> `route=0` (manifest 0.8.115); `de94ae9` -> `route=2` (manifest 0.8.116); `370a7f7` is an ancestor of the fix commit `30b48ac`, whose own manifest still reads `0.8.115` | **SUPPORTED** (0.8.116 is the first release carrying it; the feature commit forgot the bump) |
| C4 | The 7 unearned `verified` rows were demoted | `jq '[.bugs[].state] \| group_by(.) \| ...'` | `fixed=77 recurrence-watch=2 reproduced=1`, zero `verified` / `arm-verified` | **SUPPORTED** — side effect: every `verified-artifacts` binding is now vacuous (`PASS verified-artifacts  0 claim(s) bound to a fresh arm artifact`) |
| C5 | `AGENTS.md` "0.8.91 ships the two defects (KO-20261114-01/02)" matches history | `git log --grep='0.8.91'`; `git log -S readyForPodSeek` | no `0.8.91` commit exists; `readyForPodSeek` first appears in `22a746d` (manifest `0.8.92`), which is also what the ledger says | **REFUTED** (the wave prose is off by one version; the ledger is right) |
| D1 | An empty product list turns the gate red | scratch worktree, `PRODUCT_JS = []`, `node _tools/ko-verify.mjs` | `FAIL syntax  syntax has no product files to check`, `RESULT FAIL  checks=29  failed=3` (baseline below is `failed=2`) | **SUPPORTED** |
| D2 | A captured arm from a failed run is refused | scratch worktree: capture moved ahead of `assert(r.status === 0)` plus a harness forced to exit 1 | `FAIL youtube-resume`, `FAIL verified-artifacts  captured arm(s) from a failed run: youtube-resume=FAIL`; the artifact was written with `check: youtube-resume -> FAIL, exit=1` | **SUPPORTED** |
| D3 | The shipped capture order cannot fabricate an artifact | same failing harness, capture order restored (`e66f551` shape) | `FAIL youtube-resume` and `PASS verified-artifacts  0 claim(s)`, `_evidence/KO-20261026-04-arms.md` absent (`ls: cannot access`) | **SUPPORTED** |
| D4 | A ledger that did not load is refused | scratch worktree, `_tools/ko-bug-ledger.json` replaced with `{ this is not json` | `FAIL bug-ledger  Expected property name ...`; `FAIL verified-artifacts  bug-ledger did not load; refusing to verify artifacts against an empty ledger` | **SUPPORTED** |
| D5 | The gate at `e66f551` is "28 PASS / 1 FAIL" (commit body) | pristine worktree of `e66f551` on `G:`, `node _tools/ko-verify.mjs` | 27 PASS, `RESULT FAIL  checks=29  failed=2`: `FAIL revival-features  feature '_tools' has 1 unmapped file(s): ['_tools/test-clock.cjs']` and `FAIL revival-friction` | **REFUTED** (the shipped tree is 27/2; `_tools/test-clock.cjs` is in no feature map) |
| D6 | The gate is a read-only receipt | two consecutive runs in the same tree, `git diff revival/FRICTION.json` | the gate rewrites its own input: `"after_s": 4.986` -> `11.154`, `"updated_at"` bumped; the second run measures a tree the first one edited | **REFUTED** |
| D7 | The friction record names the clock's real path | `ls kick-overlay/_clock.cjs`; `jq '.frictions[] \| .twin_or_script' revival/FRICTION.json` | `No such file or directory`; the row says `kick-overlay/_clock.cjs`, the file is `_tools/test-clock.cjs` (the commit body says it was moved out of `kick-overlay`) | **REFUTED** (stale path in a VERIFIED row) |
| D8 | The gate is self-contained in the repo | `grep -n REVIVAL_SCRIPTS _tools/ko-verify.mjs` | `C:/Users/Administrador/.agents/skills/project-revival/scripts`, overridable by env; on another host both revival checks fail with `missing <path> (set REVIVAL_SCRIPTS)` | **REFUTED** as portability; fails closed, so not a silent green |

## What the refutations mean, in order of cost to the owner

1. `stopAdOverlay` waits only for `reason === 'ad-end'` (`twitch-adblock.js:3141`). The 180 s pod ceiling
   (`:3470`) and the `ad-fail` door (`:4852`) both remove a revealed, healthy frame and resume a native at
   `rs:1` with no `handback-wait` row. Probe C reproduces the 0.8.121 defect exactly, from the timer rather
   than from `ad-end`: `native-resume {"tag":"ad-end","rs":1,"ct":30,"selfPaused":180}`. Pods that live the
   full ceiling are already in the owner's ring (`AGENTS.md:1863`, `:2234`), so this is a live door, not a
   hypothetical one. Fix shape: the same arm condition with `reason` in a declared pod-end set, or the wait
   armed from `finishAdOverlay` before the reason is chosen.
2. Two receipt artifacts disagree with the tree they describe: `revival/FRICTION.json` points at
   `kick-overlay/_clock.cjs` (deleted) and is rewritten by the gate that reads it, and the commit body's
   "28 PASS / 1 FAIL" is 27/2 on a clean checkout because `_tools/test-clock.cjs` was never added to
   `features/features.json`. Both are one-line fixes; neither is a product defect.
3. `AGENTS.md`'s 0.8.91 attribution for `KO-20261114-01/02` has no commit behind it; the ledger's 0.8.92 is
   the evidence-backed value.

## Limits of this verification

- No live Twitch pod and no owner browser: the hand-back rows are harness measurements on the real page
  module, and reachability of the `ad-fail` door during an existing pod is source-traced, not observed.
- The gate runs were made in a throwaway worktree on `G:` (`git worktree add --detach ... e66f551`), removed
  afterwards; the `I:` checkout was never written.
- `KO_REAL_CLOCK=1` timings (74.6 s, 271.4 s) exceed the 15 s / 60 s budget ceilings by design: they are the
  replay arm, not the inner loop.
