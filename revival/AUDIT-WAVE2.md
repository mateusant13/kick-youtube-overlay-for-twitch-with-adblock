# Audit wave 2 — 2026-11-26 (eight read-only angles over HEAD e66f551)

Second audit pass, scoped to the instruments and the revival machinery rather than the ad path again.
Eight read-only scouts, one angle each, no writes, no browser, no full gate. Every claimed line was
pinned with `grep -n`/`sed`; the census was run because it is the project's per-edit instrument (353 ms).

Evidence legend on every row:
`[V]` = this pass re-read the exact line and/or ran the exact command.
`[S]` = leaf scout static read, not independently re-executed here.

Wave-1 overlap: `revival/AUDIT-2026-11-26.md` already lists the inert surfaces (§10), the audio
authority lines (§4), the silent-exit samples (§3) and replica vacuity (§8). Rows that collapse to a
wave-1 item say `w1 §N`; they are kept here only when wave 2 adds the enforcement mechanism.

## 0. Roll-up

| sev | count | meaning in this repo |
|---|---:|---|
| P0 | 11 | a gate/instrument can print PASS while the product or the mechanism it names is broken |
| P1 | 49 | dead/inert surface or unenforced rule with real drift risk |
| P2 | 24 | stale text, unread log row, paperwork |

The six P0 classes, in repair order:

1. `ko-verify` can bind zero claims, zero bugs and self-matching RED lines (W2-01..W2-04).
2. The census gate can pass with a dropped product file and a zero count (W2-05).
3. The replica models the ad wrapper with the class token real Twitch never toggles (W2-29..W2-32).
4. The revival gate claims blast-radius and RED-arm enforcement it does not run (W2-41).
5. The live-proof rule is satisfied by a headless guest with an injected hold (W2-53).
6. The "only writer" audio contract is literally false (W2-76).

## 1. Gate truth: `_tools/ko-verify.mjs` can pass with an empty subject
Lane owner: **GateTruth** — owns `_tools/ko-verify.mjs`. Do not touch product files.

| ID | sev | path:line | contradiction | fix | ev |
|---|---|---|---|---|---|
| W2-01 | P0 | `_tools/ko-verify.mjs:812` + `:781-783` | The artifact template written by this run contains `EXPECTED-RED` and `the RED line above`, so `/RED\|mutation/i.test(body)` is true for every artifact; `expected_red` (`:793`) is printed (`:890`) but never asserted. | Test only the extracted arm-lines block and assert `expected_red === true` per claimed artifact. | [V] |
| W2-02 | P0 | `_tools/ko-verify.mjs:806` | `claimed` filters `state: verified\|arm-verified`; the shipped ledger has **0 of 80** rows in those states (77 fixed, 1 reproduced, 2 recurrence-watch), so the arms/reachability/freshness loop is vacuous and returns "0 claim(s) bound". | Fail when `claimed.length === 0`, or pin the expected claimed ids. | [V] |
| W2-03 | P0 | `_tools/ko-verify.mjs:544` | `assert(raw && Array.isArray(raw.bugs))` accepts `bugs: []`; every per-bug rule and the `FIXED, NOT VERIFIED` banner go vacuous. | `assert(raw.bugs.length > 0)` plus a pinned id list. | [V] |
| W2-04 | P0 | `_tools/ko-verify.mjs:866` | `payload.result = failed.length ? 'FAIL' : 'PASS'` ignores `unverified`; one run can print `RESULT PASS ... failed=0` and `FIXED, NOT VERIFIED`. | FAIL/UNVERIFIED when `unverified.length > 0`. | [V] |
| W2-05 | P0 | `_tools/ko-verify.mjs:480` + `_tools/ko-census.mjs:203` | The census check accepts any digits, and census builds `files = PRODUCT.map(censusFile).filter(Boolean)` so an unreadable/missing product file drops its own cap and the gate still prints PASS. | Require all three product files parsed, and pin `guardShaped` to the exact budget, not a ceiling. | [V] |
| W2-06 | P1 | `_tools/ko-verify.mjs:600` vs `:550` | Two "verified" predicates: `bug.verified` (ledger-evidence) vs `bug.state` (bug-ledger/verified-artifacts). A row with `state:'fixed', verified:true` skips verifier, arm and reachability, yet the receipt prints verified. | One shared predicate; any verified claim needs verifier + artifacts. | [V] |
| W2-07 | P1 | `_tools/ko-verify.mjs:604-610` | Only artifacts that exist are inspected (`paths.filter(existsSync)`); absent claimed paths are ignored and the only body test is `!== 'missing'`, so a whitespace body passes. | Every claimed path must exist and carry a non-empty verdict/RED body. | [V] |
| W2-08 | P1 | `_tools/ko-verify.mjs:318` + `:458` + `:411-419` | `ARMS (\d+)/\1` admits `0/0`; `ad-time-continuity` has **no** ARMS assertion although its suite prints `ARMS n/n`, so deleting all its arms leaves the gate green. | Require `n >= 1` and apply the ARMS assertion to every suite whose receipt cites it. | [V] |
| W2-09 | P1 | `_tools/ko-verify.mjs:130,148` | `AUTO_FILES` drops absent paths, then `assert(!hits.length)` passes with "0 files checked". | Assert all pinned paths exist before filtering. | [S] |
| W2-10 | P1 | `_tools/ko-verify.mjs:105-106` | Packaged files are checked by `existsSync` only; zero-byte `content.js`, `twitch-adblock.js`, `player.html` pass. | Non-empty size plus required markers per packaged file. | [S] |
| W2-11 | P1 | `_tools/ko-verify.mjs:665-667` | `features: []` passes ("0 feature(s) match"); `inputs: []`/`outputs: []` are truthy. | `features.length > 0` and array lengths > 0. | [V] |
| W2-12 | P1 | `_tools/ko-verify.mjs:675-677` | Only `rc === 0` and `ids.length > 0`; deleting every basic budget row but one still passes, and the recorded failure `basic.import_or_boot_ms` is already gone from the compared set. | Pin expected basic ids/count and refuse dropping a previously failing id. | [V] |
| W2-13 | P1 | `_tools/ko-verify.mjs:672-674` | `--verify-red` is not passed; `benchmark_history.py:216-220` only computes red arms under that flag, so a FALSE-GREEN metric is never reported. | Add `--verify-red` and fail on FALSE-GREEN. | [V] |
| W2-14 | P1 | `_tools/ko-verify.mjs:681-686` | The detail claims every friction row has a `verify_cmd`, but `loop_friction_audit.py:191-198` skips `WAIVED` rows and `frictions: []` yields PASS. | Require non-empty rows and a non-empty `verify_cmd` regardless of status. | [S] |
| W2-15 | P1 | `_tools/ko-verify.mjs:845-849` | Freshness compares artifact mtime to the last **commit** time; an uncommitted source edit keeps the old commit time, and `age_days` is printed but never bounded. | Compare against the source file mtime/hash and enforce a max age. | [V] |
| W2-16 | P2 | `_tools/ko-verify.mjs:493-520` | `live-state-probe` asserts substrings in its own source; comments or dead branches satisfy it and the probe is never spawned. | Parse the verdict assignments or run it on a replay fixture. | [S] |
| W2-17 | P2 | `_tools/ko-verify.mjs:69-78` | `node --check` exits 0 on a zero-byte file, so six empty product files still report "6 files". | Assert non-empty and pin a minimum size. | [S] |
| W2-18 | P2 | `_tools/ko-verify.mjs:88-96` | The CRLF filter treats an empty file as LF-clean. | Assert non-zero length before the CRLF test. | [S] |
| W2-19 | P2 | `_tools/ko-verify.mjs:197-198,232-237` | Docs/README checks use `existsSync`/filtered lists; zero-byte or absent files can pass one of the two checks. | Assert content markers and the exact file count. | [S] |

## 2. Silent-exit census: measured 111, budget slack, and four unlogged decisions
Lane owner: **CensusBudget** — owns `_tools/ko-census.mjs`, `_tools/ko-census-budget.json`.

Measured on 0.8.126 in this pass: `node _tools/ko-census.mjs --gate` -> `RESULT PASS guardShaped=111
unexercisedState=32 (budget met)`. Per file: `content.js 48/50`, `twitch-adblock.js 63/63` (**at cap**),
`player-bridge.js 0/0`. `--json`: `exits=643 silent=585 guardShaped=111`, declared state 68, referenced 36.

| ID | sev | path:line | contradiction | fix | ev |
|---|---|---|---|---|---|
| W2-20 | P1 | `_tools/ko-census.mjs:155` | `guardShaped` requires `fnLogs > 0`, so a logging-free helper's silent refusals are invisible; `resumeRefusedByUser` (`twitch-adblock.js:2989-2992`) returns four times with no row. | Count unexplained decision exits in logging-free helpers, or add a second budget for them. | [V] |
| W2-21 | P1 | `_tools/ko-census-budget.json:2` | Comment says "measured 2026-11-20 on 0.8.107"; measured today is 48/63/0 and 32, caps are 50/63/0 and 39. `twitch-adblock.js` is exactly at 63, so any new silent guard fails while the other slack hides growth, and AGENTS.md calls 111 "the budget" while the file sums 113. | Re-measure on 0.8.126, lower caps to 48/63/0 and 32, and fail on `>=` or ratchet per release. | [V] |
| W2-22 | P1 | `_tools/ko-census.mjs:64-79` | `functionIndex` clears `current` only at global depth 0: callback exits after `adLog` are attributed to `adLog`, and class bodies keep `current='makePatchedWorker'`, so value-returns count as decisions. | Track each function's own closing brace and ignore `return class/true/false/{`. | [V] |
| W2-23 | P1 | `_tools/ko-census.mjs:39-47` | `stateCensus` reads a hardcoded 7-suite list; fields exercised by any other arm stay "unexercised". | Enumerate suite files from the directory. | [V] |
| W2-24 | P1 | `twitch-adblock.js:2542` | `armNativeRecovery` aborts silently on `resumeRefusedByUser(v)`; a stale `userPausedInPod` reproduces `resume:NEVER` with no ring row, against the sibling rule at `:2255-2257` that a refusal is a row. | Log `native-recover-refused {why}` before returning. | [S] |
| W2-25 | P1 | `twitch-adblock.js:2198` | `markUserInput` ignores a play when `!hasFreshInput()` or `!gestureAuthorizesPlay(t)`; the pause half logs `pause-refused`, the play half logs nothing, so the 400 ms chat-click misclassification is invisible. | One `play-refused {inputAgeMs, gesture}` row per episode. | [S] |
| W2-26 | P1 | `twitch-adblock.js:3390-3394` | The hand-back watchdog silently returns on `adActive`, frame ownership, missing video or "healthy"; a teardown that leaves the native paused ends with no explanation. | One `native-handoff-watch-skip {why}` row. | [S] |
| W2-27 | P1 | `twitch-adblock.js:1087-1157` | `catchUpClean` silently refuses the seek that decides whether the picture is at the live edge; only success logs at `:1182-1188`, while the in-code comments describe the user-visible failure. | `overlay-catchup-refused {lat,pos,hold,why}` once per episode. | [S] |
| W2-28 | P1 | `_tools/ko-census.mjs:203,245-250` | Missing/unreadable product files are dropped before the cap loop, so a file that cannot be parsed has no cap at all (census-side of W2-05). | Fail when `files.length !== PRODUCT.length`. | [V] |

## 3. Replica fidelity: the fixture hides four live defect classes
Lane owner: **ReplicaFidelity** — owns `_tools/ko-replica/` (server, page, worker, scenarios).

| ID | sev | path:line | contradiction | fix | ev |
|---|---|---|---|---|---|
| W2-29 | P0 | `page/page.js:41,46` + `page/index.html:44` | The replica adds/removes `stream-display-ad__wrapper-hidden` to signal an ad; real Twitch keeps that class permanently and reveals by painting the inner container. Every `ui:"wrapper"` scenario passes with a class-token detector, hiding the 0.8.93/0.8.94 class. | Keep the class permanent and drive show/hide only by sizing the inner; add a scenario that fails a class-token gate. | [V] |
| W2-30 | P0 | `page/player-worker.js:18,55,171` | No `ms.duration`/seekable is set and `ct = lastEnd`, so `video.seekable.end` is a normal number, never the 2^30 sentinel; hides the 0.8.92 timeline-reset class. | A sentinel knob plus an arm asserting no seek or catch-up derives from it. | [V] |
| W2-31 | P0 | `server.mjs:66,210` | `activeEvent(t)` gates `adOn`, so ad `#EXTINF` rows vanish on the first refresh after the event ends; real Twitch keeps `adExtinf:16` beside content for minutes, which is why `cleanPlaylistStreak` never reached 2 and a cover ran 180 s. | A stale-ad knob keeping ad rows N seconds after the DOM UI ends; assert `ad-end` from the DOM signal. | [V] |
| W2-32 | P0 | `scenarios/dev-reload-midroll.json:11-12`, `scenarios/dev-reload-preroll.json:11-12` | The only countdown/preroll reload scenarios have `samples: []` and `expect: []`; no scenario uses `ui:"slate"` or `"aria"`. | Add countdown/slate samples and `ad-ui-on`/`ad-ui-hold` expectations. | [V] |
| W2-33 | P1 | `page/page.js:56` | The `ui:"squeeze"` branch exists but no scenario or check uses it. | A squeeze scenario with a shallow-rect arm. | [V] |
| W2-34 | P1 | `server.mjs:318` | The slate label is `${CHANNEL} está fazendo um intervalo comercial…`, not the measured sentence, and it lives in `#ko-replica-adtext` rather than a text node inside the player subtree. | Emit the measured sentence inside `[data-a-target="video-player"]`. | [V] |
| W2-35 | P1 | `server.mjs:193` | Every ad block emits `twitch-stitched-ad` and `X-TV-TWITCH-AD-URL`, but measured all-ad playlists reported `hasStitched:false`. | Stitched marker behind a knob; assert the title-based `adExtinf` path without it. | [S] |
| W2-36 | P1 | `server.mjs:92,480` | `tokenFor` builds a synthetic `replica-...` signature; the opaque/signed token, expiry and GQL rewrite are never exercised. | Serve an opaque signed-shaped token and assert the rewrite in an arm. | [S] |
| W2-37 | P1 | `server.mjs:279` | The same full ladder is served to every `player_type`, including `autoplay`; the real clean autoplay path can be 360p-only. | A 360p-only autoplay knob plus a rung-choice arm. | [S] |
| W2-38 | P1 | `server.mjs:548` | `stall.on:'native'` always refuses 503 and cannot refill, so `handback-ready {why:'ready'}` is unreachable; `content`/`all` hold the socket and suppress `ad-end`. | A two-window stall that releases before the ceiling; assert `why:'ready'`. | [S] |
| W2-39 | P1 | `scenarios/dev-ring-buzzyi.json:33` | The file is labelled the owner's freeze ring but cannot model `scenario.hide` or an ad-path self-pause; PASS only asserts "the page plays afterwards". | Add hide/self-pause modeling and a hidden-tab arm. | [S] |
| W2-40 | P2 | `scenarios/dev-timeline-probe.json` | Prints PASS with the extension loaded, so it cannot tell product from fixture (already recorded in w1 §8). | Run it with `--no-ext` and require the inverse verdict. | [S] w1 §8 |

## 4. Revival artifacts: prose where a gate is claimed
Lane owner: **RevivalGates** — owns `revival/*.json`, `revival/*.md`, and the `ko-verify` revival checks.

| ID | sev | path:line | contradiction | fix | ev |
|---|---|---|---|---|---|
| W2-41 | P0 | `revival/MILESTONES.json:56` | "Blast-radius checks wired into every project gate" is false: `grep -n blast _tools/ko-verify.mjs` returns **zero**; `revival-budgets` runs `--tier basic` only and no `--verify-red`; `benchmark_history.py:232-249` only annotates. | Add `--blast-radius --verify-red`, make the tool exit 1 on `blast_hit`/FALSE-GREEN, and assert the verdict in `revival-budgets`. | [V] |
| W2-42 | P1 | `revival/GOAL.json:14-39` | The charter says the mission ends only when 100% of acceptance criteria carry real receipts; all five `receipt` fields are `null` and no tool reads them. | A `revival-goal` check that fails on any null/missing receipt. | [V] |
| W2-43 | P1 | `revival/MILESTONES.json:36` + `revival/AUDIT-2026-11-26.md` §1-8 | Step 5 is marked DONE on a prose audit whose own sections still list open P0/P1 findings. | Machine-readable ledger per finding; fail an open P0 without a named regression test. | [V] |
| W2-44 | P1 | `revival/MILESTONES.json:43` + `revival/FRICTION.json:22,42,62` | Claims twins under `harness/twins/`; `ls harness` shows only `angles.tsv` and `features.json`. The three OPEN friction rows have `verify_cmd: ""`, so the friction gate can only fail, never verify. | Create the twins and assert every `twin_or_script` path exists; require a non-empty `verify_cmd`. | [V] |
| W2-45 | P1 | `revival/MILESTONES.json:50` + `benchmarks/history.jsonl:1` | "Full BEFORE baseline" is one row with `passed:false` and `basic.import_or_boot_ms: UNMEASURED`; 0 of the 6 budget ids are baselined. | Run the six commands and gate `baseline ids == budget ids`. | [V] |
| W2-46 | P1 | `revival/MILESTONES.json:50` + `benchmarks/sliders.json` | All 8 sliders are `current:0`, `proof_cmd:""`, `evidence:"UNMEASURED"`; `slider_scorecard report` defaults to `--min-overall 0`, so unmeasured prints PASS. | Set values and run `report --strict-evidence --min-overall 70` from a gate. | [V] |
| W2-47 | P1 | `revival/COMMANDS.md:16` | `smoke_e2e` omits `--gate` on `ko-load-check`, which exits 0 when BUSY, while AGENTS.md mandates `--gate` as the `&&` left side. | Add `--gate` and execute that literal from the gate. | [V] |
| W2-48 | P1 | `revival/COMMANDS.md:3-13` | 11 of 14 rows are invoked by nothing; the 3 with real equivalents are hardcoded in `ko-verify`, so editing this sheet cannot change any gate. | Parse and execute the sheet, or delete the uninvoked rows. | [V] |
| W2-49 | P1 | `revival/VALIDATION.md:3-7` | The contract is one `# FILL` / `# UNMEASURED` row; the promised 5-15 VAL assertions do not exist and no tool reads the file. | Fill 5-15 rows and add a `revival-validation` check per row plus its adverse arm. | [V] |
| W2-50 | P2 | `revival/FRICTION.json:74-75` | Names `kick-overlay/_clock.cjs`, which does not exist; the clock is `_tools/test-clock.cjs` (`mute-decision-test.cjs:27`, `ad-time-continuity-test.cjs:31`). | Correct the path and assert `twin_or_script` exists. | [V] |
| W2-51 | P2 | `revival/checkpoints.jsonl:1` | Write-only: `git_checkpoint.py:128` appends, `cmd_list` reads git tags, no gate reads the JSONL. | Gate parses the ledger and verifies each tag/head exists. | [S] |
| W2-52 | P2 | `revival/MILESTONES.json:57` | Claims 24 angles including A3 steady-state; `harness/angles.tsv` has 25 data rows and no A3, and no tool reads the file. | Add A3 and gate the claimed count/ids. | [V] |

## 5. AGENTS.md rules with no enforcement
Lane owner: **RuleEnforce** — owns the rule-to-check mapping and the `ko-verify` checks it names.

| ID | sev | path:line | contradiction | fix | ev |
|---|---|---|---|---|---|
| W2-53 | P0 | `AGENTS.md:66-71` | The live-proof rule says `verified` needs a real live Twitch stream in the owner's Chrome; `ko-verify.mjs:550-570` equates `verified` with `reachability_verdict==='PASS'`, which `ko-real-arm-d1.mjs` produces on a headless guest with an **injected** ad-hold (its header: a Twitch-served ad is NOT MEASURED). Zero ledger rows are verified, so it has never blocked anything. | Require an owner-Chrome live artifact for `verified`; guest runs earn only `arm-verified`; add a RED proving a guest-only row is rejected. | [V] |
| W2-54 | P1 | `AGENTS.md:415` | Claims `line-endings` covers every product file and `.gitattributes` pins ~20 patterns, but `ko-verify.mjs:88-96` hardcodes six `kick-overlay/*.js`; CRLF in `_tools/*.mjs`, `kick-overlay/*.cjs`, `features/*.json`, `benchmarks/*.json`, `revival/*` and `harness/*.tsv` passes. | Derive the check's file list from the `.gitattributes` patterns. | [V] |
| W2-55 | P1 | `AGENTS.md:225,1522` | `KO_VER` is trusted to agree with `manifest.json`; `ko-verify.mjs:101-108` checks a version regex plus five files and `grep -c KO_VER _tools/ko-verify.mjs` is 0, so a bump can desync `recoverStale()` with no gate failure. | Assert `KO_VER === manifest.version`. | [V] |
| W2-56 | P1 | `AGENTS.md:119` + `benchmarks/budgets.json:101` | "Pin the verdict, not the number", but the e2e output requires `RESULT PASS checks=25 failed=0` while `ko-verify.mjs` registers **29** `check()` calls and prints the raw count; no floor guard, so a removed check still passes. | Verdict-only output plus `RESULTS.length >= 29`. | [V] |
| W2-57 | P1 | `AGENTS.md:2746` | Budgets basic->E2E "MUST NOT regress"; `revival-budgets` runs `--tier basic` only, leaving 3 subsystem and 1 e2e ceilings unenforced (and `e2e.gate_wall_ms` is declared but never run). | Gate every tier, or delete the unenforced ids. | [V] |

Cross-references, not duplicated: census ceiling claim -> W2-21; ARMS receipt -> W2-08; blast-radius
claim -> W2-41; proxy-absence invariant -> W2-67.

## 6. Wiring ghosts: 14 declared tools with no executable caller
Lane owner: **WiringCleanup** — owns `features/features.json`, `features/INDEX.md`.

| ID | sev | path:line | contradiction | fix | ev |
|---|---|---|---|---|---|
| W2-58 | P1 | `features/features.json:21-24,28-33,37,47-48,50-51` | 14 declared `_tools/*.mjs` have no executable caller (only the registry or prose): `ko-click`, `ko-ctx`, `ko-eval`, `ko-gql-probe`, `ko-hook-probe`, `ko-live-latency-arm`, `ko-live-watch`, `ko-look`, `ko-orphan-cover-arm`, `ko-reload-persistent`, `ko-sw-net`, `ko-twitch-net`, `ko-yt-net`, `relay`. | Wire each to a command/suite/angle or drop it from `files`. | [V] |
| W2-59 | P1 | `harness/angles.tsv:23` | The "pixel expectation with the extension off" falsifier invokes `_tools/ko-replica/scenarios/dev-fast.json`; the file does not exist (9 scenarios, none named dev-fast). The negative arm cannot run. | Point at an existing scenario or add `dev-fast.json`. | [V] |
| W2-60 | P1 | `features/features.json:83` | Declares `e2e.gate_wall_ms` (budget `benchmarks/budgets.json:101`) but no path runs `--tier e2e`. | Add an e2e-tier gate run or drop the id. | [V] |
| W2-61 | P2 | `features/features.json:4` | `git_head: 35c8d8f` while HEAD is `e66f551`; `feature_map_sync.py:349-394` never compares the field. | Re-sync or add the comparison. | [V] |
| W2-62 | P2 | `features/features.json:6` | `total_tracked_files: 116` while `git ls-files` is 118. | Refresh or enforce. | [V] |
| W2-63 | P2 | `features/INDEX.md:35` | "`background.js` owns storage and the badging"; it has neither (`grep` for `chrome.storage`/`chrome.action`/badge returns nothing). | Sync from the curated contract. | [V] |
| W2-64 | P2 | `features/features.json:125` | Says `background.js` installs the DNR rules and packaged resources; both are declared in `manifest.json:15,37`, and `background.js` has no `declarativeNetRequest`/`getURL` call. | Attribute them to `manifest.json`. | [V] |
| W2-65 | P2 | `features/features.json:130` + `INDEX.md:36` | Lists "the server-space preference" as an input; no such preference exists after the proxy removal. | Delete the dangling input. | [S] |

## 7. Inert surfaces left after the proxy removal
Lane owner: **InertCleanup** — owns dead comments, knobs, attributes and rows. Wave-1 §10 overlap noted.

The proxy sweep itself **holds** for shipped code: `grep -rnI -E "chrome\.proxy|webRequest|
onAuthRequired|8899|twitch-proxy" kick-overlay/` hits 8 lines, all in `ADBLOCK-FINDINGS.md`; zero in
`.js/.json/.html`. The broader wording ("proxy lives only in ADBLOCK-FINDINGS.md") is false (W2-68).

| ID | sev | path:line | contradiction | fix | ev |
|---|---|---|---|---|---|
| W2-67 | P1 | `AGENTS.md:189` | The proxy-absence invariant exists only as a manual sweep receipt; no instrument greps the tokens, so reintroduction passes the gate. | Add the exact token grep as a `ko-verify` check. | [V] |
| W2-68 | P2 | `twitch-adblock.js:14,198` | Shipped comments still call the removed proxy "the best path (native HD)" and mention an external proxy. | Delete or reword around the current clean-HLS path. | [V] w1 §10 |
| W2-69 | P2 | `background.js:86` | `KO_VER_RE` is defined once and referenced nowhere. | Delete. | [S] w1 §10 |
| W2-70 | P2 | `_tools/relay.mjs:10` | `KO_RELAY`/`BASE` are never read; `Cdp.open` hardcodes `ws://127.0.0.1:9224/cdp`. | Derive the URL or remove the override. | [S] w1 §10 |
| W2-71 | P2 | `adblock-bridge.js:241` | Writes `data-ko-adlog-sid`; no reader (the snapshot probe reads 7 other attributes). | Remove the write or probe it. | [S] w1 §10 |
| W2-72 | P2 | `twitch-adblock.js:1576` | Reads `[data-ko-frame]`; no producer exists. | Drop it or restore the producer. | [S] w1 §10 |
| W2-73 | P2 | `content.js:3616` | `setPlayer()` has no production caller; only the test export reaches it. | Route the real switch through it or delete it. | [S] w1 §10 |
| W2-74 | P2 | `twitch-adblock.js:4185,4639,5105` | `standby-firstdecoded`, `ad-rewind` and `recorder-start` rows have no reader in tools, suites or ledger. | Bind a verdict reader or remove the rows. | [S] w1 §10 |
| W2-75 | P2 | `manifest.json:14` | `activeTab` is declared; the only tab APIs are `tabs.query`/`sendMessage`, and host permissions already cover Twitch. | Remove after a popup smoke test. | [S] |

## 8. Duplicate state writers: the "one writer" contracts are not literal
Lane owner: **AudioOwnership** — owns `content.js`, `twitch-adblock.js`, `ko-audio.js`, `adblock-bridge.js`.

Confirmed single-writer (no finding): `data-ko-owner` only at `content.js:2535`; `data-ko-audio-m/-v`
only through `ko-audio.js apply()` -> `adblock-bridge.js:141-151`; `KO.kickMuted/kickVol/ytMuted/ytVol`
only in `mirrorAudio()` at `content.js:1147`.

| ID | sev | path:line | contradiction | fix | ev |
|---|---|---|---|---|---|
| W2-76 | P1 | `AGENTS.md:1052` + `ko-audio.js:32` vs `content.js:1706` | "ko-audio.js is the only code allowed to write a mute or a volume" is false: `content.js:1706` sends `{t:'mute',m:true}` directly, and `player-bridge.js:150,524,527,647,822,825` writes `V.muted`/`V.volume`/`setMuted`/`setVolume`. A hidden-layer load can mute without the arbiter's diff memory, so a later `apply()` skips the re-send and the frame mute is unattributed. | Delete the direct send (`forget('yt')+apply()` already mutes); scope the rule to "decision writer"; route frame writes through the arbiter. | [V] |
| W2-77 | P1 | `twitch-adblock.js:2214` (also 1069,2037,2157) | The comment at `:5088` says the park flag is derived and no exit path can leave it set, but four direct `markAdPark` writers bypass the `adParkShown` mirror updated at `:1056`. A direct `0` without updating the mirror makes the derived writer skip, so `content.js:637` stamps `adpark=false` on a pause the ad path owns. | Make `markAdPark()` the only writer and update `adParkShown` inside it. | [S] |
| W2-78 | P1 | `content.js:1192` vs `popup.js:16-20` | Two whole-record writers to `chrome.storage.local['ko.v2']`; popup re-reads before write, but the await gap can clobber a newer `saveState()`. | Re-read inside `saveState()` before `set`, or one owner via a runtime message. | [S] |
| W2-79 | P1 | `twitch-adblock.js:4057` | The section calls itself one writer for the clean frame, but `overlay.audioSent` has 9 write sites and `overlay.audioRefused` has 4; the frame `ready` handler seeds `{muted:true}` outside `applyOverlayAudio()`, so the observer can send the opposite mute in the same tick. | Route every seed/clear through `applyOverlayAudio()` and key policy to the frame token. | [S] |
| W2-80 | P1 | `content.js:733` vs `twitch-adblock.js:2494,2845,2912` | Two owners write the native `currentTime`; a content nudge followed by an ad-path seek leaves the later position on screen (the jump-cut both exist to avoid), and the ad-path seek can reset `KO.nat` so a wedged element loses content-side recovery. | Ad path owns seeks while `adActive or revealed`; content owns otherwise. | [S] |
| W2-81 | P1 | `content.js:2778,2838` vs `twitch-adblock.js:1018,1071,2951` | Two owners of native `paused`: content's cold hold pauses first, `freezeNativeForPod()` returns on `v.paused` without stamping, then content resumes while the pod still owns playback. | One pause owner; the ad path claims the element instead of returning on `paused`. | [S] |
| W2-82 | P1 | `content.js:1723,1758` vs `content.js:1664` + `ko-audio.js:936` | Two writers of `policy['yt']`: a frame `st.muted=true` sets policy and arms the unlock, any page pointerdown clears it and issues `play()`, and a late muted `st` re-adds it. | Clear policy only in the gesture path that sets intent, or make the arbiter's volumechange reader the only policy writer. | [S] |
| W2-83 | P2 | `adblock-bridge.js:210` | `Number(null) === 0`, so a null volume is written as a real `volume:0` intent. | Reject null before `Number`. | [S] |
| W2-84 | P2 | `twitch-adblock.js:1245,1254` | `overlay.audioRefused` is ORed into the derived mute and sent as a command, a second writer absent from `wanted(...)`. | Fold the refusal into `wanted()`. | [S] |

## 9. Verification and landing

Run in this pass (worktree `G:/Temp/revival-wt/.../SubOrch-Audit-20261126T201829Z-61880`):

- `node _tools/ko-census.mjs --gate` -> `RESULT PASS guardShaped=111 unexercisedState=32`, exit 0.
- `node _tools/ko-census.mjs --json` -> 48/63/0 guard-shaped, 32 unexercised.
- `node -e` ledger probe -> 80 rows, 0 `verified`/`arm-verified` (77 fixed, 1 reproduced, 2 recurrence-watch).
- `grep -n blast _tools/ko-verify.mjs` -> no matches; `grep -c "^check("` -> 29.
- `git rev-parse --short HEAD` -> `e66f551`; `git ls-files | wc -l` -> 118.
- `cat .gitattributes` and `sed -n 88,96` -> 20+ pinned patterns vs 6 gated files.
- `cat` on the two reload scenarios -> `samples: []`, `expect: []`.
- `sed`/`grep` on `_tools/ko-replica/{server.mjs,page/page.js,page/player-worker.js}` -> W2-29..W2-38.
- `grep` for mute/volume writes in `kick-overlay/*.js` -> W2-76.
- `ls harness`, `ls kick-overlay/_clock.cjs`, `ls _tools/test-clock.cjs` -> twins absent, clock path wrong.
- `cat benchmarks/sliders.json`, first row of `benchmarks/history.jsonl` -> 0/8 sliders measured, 1/6 budgets baselined.

NOT run, by assignment: the full gate (`node _tools/ko-verify.mjs`), any suite, any browser/guest, any
server, any live stream. Findings marked `[S]` are the leaf's static read and were not re-executed here.

Landing gate for this file: `node --check kick-overlay/content.js`. This document is the only artifact;
no product file was read-modified, and the wave-2 findings above that need code changes are assigned to
the lane named in each section header, not applied here.

Owed after this audit: GateTruth must make the six P0 gate classes fail (W2-01..W2-05, W2-41, W2-53),
and ReplicaFidelity must make W2-29..W2-32 reproducible offline before any of those repairs can claim a
green arm. A `[V]` row means the contradiction is real at the cited line; it does not mean the fix is
done.
