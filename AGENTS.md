# AGENTS.md
## Owner rule — ship work without paperwork drag (2026-10-31T02:59:01-03:00)
Keep useful behavior and its minimum proof/docs moving in the same fast delivery. Skip optional process artifacts when they cost more than the change. Before agent fan-out or disk-heavy builds/tests, use `fast-land-shared-artifacts`: measure total disk growth, share the sanctioned target/cache across lanes, and serialize instead of duplicating heavy artifacts when sharing is unsafe. This owner direction supersedes older process checklists that add optional work without protecting a concrete risk; keep only minimum proof for correctness, security, data integrity, or destructive work.

## This machine is weak: declare the ceiling BEFORE the job (owner order 2026-11-11)

The owner's machine must not be starved by this project's tooling. Assume the box is 10x weaker than
it looks and write code for that machine, not for a build server. Order of preference, and it is not
negotiable: **do less work, do it once, batch it, reuse a cached result, make it incremental, drop the
duplicate** — a CPU/thread/MB cap comes only after the work itself got cheaper. Throttling a job whose
design redoes work is the worst available answer.

- **One heavy job at a time, with a number attached before launch.** Every measurement/scan/build slot
  declares its ceiling in the command that starts it: processes/workers, threads (`--jobs`,
  `OMP_NUM_THREADS`, `torch.set_num_threads`), RSS, MB/s, and the instrument that will prove it. A
  limit that was not measured before the run is not a limit.
- **The guest browser is the only heavy thing this project starts**, and its ceiling is already
  declared: ONE guest, 1 page tab, ≤20 chrome processes, ≤1.6 GB RSS, `--disk-cache-size=256 MB`,
  `--renderer-process-limit=4`. Measured violation on 2026-11-09: two guests = 31 processes / 2.89 GB;
  after killing the duplicate = 15 / 1.33 GB. `ko-harness.mjs` refuses a second guest on purpose — reuse
  the running one (`KO_PORT=N`) instead of starting another, and `stop` at the end of every run.
- **Never leave a guest, a scan, or a watcher spawned as a side effect of a measurement.** The probe is
  part of the job: `stop` when the numbers are taken. A probe left running is the freeze the owner
  reports two hours later.
- **One heavy job at a time is ENFORCED, not remembered (measured 2026-11-27).** The landing gate and the
  edit loop's deep tier each spawned `node kick-overlay/ad-time-continuity-test.cjs`, so TWO copies of a
  196-check suite (one `new Function` compile of the 6 500-line product per arm) ran at once on a box at
  64 % CPU with `I:` at 419.9 % busy and a 50.7 ms queue; the pair was the top pressure the owner felt as a
  stutter (watcher DM `dm-f77bd3e66a863677296f`). The suite now takes a single-flight lock
  (`_tools/ko-heavy-lock.cjs`): the edit loop is REFUSED in <1 ms with the holder's pid
  (`LOOP DEFERRED <suite>`, exit 3), the landing gate QUEUES (`KO_HEAVY_WAIT_MS`, set in
  `_tools/gate/checks/suites.mjs`) so its run still lands, and a dead holder is stolen from instead of
  wedging the lane. Gate check `heavy-lock` runs the lock's own selftest
  (`_tools/gate/heavy-lock-selftest.mjs`, 4 arms: refuse / queue / stale / release) and refuses if the
  suite stops holding it. Proven both ways: the same selftest against a no-op lock prints
  `RESULT FAIL heavy-lock checks=10 failed=5`. Whatever the loop cannot run is DEFERRED, never silently
  green — the landing gate is the run of record.
- **Reuse before re-running: key by CONTENT.** A measurement whose inputs did not change is a cache
  hit, not a new data point. `node _tools/ko-verify.mjs` takes ~60 s and `content-fix-test.cjs` ~2 s —
  run the narrow instrument once (the file you touched), the whole gate once per version bump, never in
  a loop with one flag changed per iteration. Missing keys are reported as `MISS`, hits as `CACHE HIT`.
- **No unbounded loop, fan-out or in-memory accumulation.** The harnesses here are sequential by design;
  a per-file sweep needs a duty cycle at the source (sleep a declared multiple of the time the last
  batch spent working), not a tighter loop with a CPU cap.
- **Measure, then say it.** A performance claim names process id (or job), measured CPU/RSS before and
  after, and the instrument. `CANNOT-MEASURE` is an acceptable answer; an unqualified "otimizado" is not.
- **Scratch and measurement output never land on `I:`** (owner-side measurement 2026-11-18, relayed by
  the watcher lane: that volume is a 4 TB SMR platter with a write backlog, `99 ms` to `10 930 ms` per
  operation and `WriteLatencyMax 31.5 s`, reads fine). Every probe script, log dump and generated file
  goes to the declared store `G:/Temp/ko-scratch` (add it to the census with `--own "G:/Temp/ko-scratch*"`
  the same day you create it), and the files a run created are deleted by exact path, never by wildcard.
- **The guest marker is `G:/Temp/ko-harness/guest.json`, and the filename is not a contract.**
  Measured 2026-11-18: a guest launched with `KO_MARKER=…/guest-9447.json` read as "no guest" while the
  browser lived, and `stop` printed `stopped` having killed nothing (15 procs / 1582.9 MB stayed up).
  Both launchers now scan every `guest*.json` in that directory: `ko-guest.mjs stop` kills the tree for each
  port a LIVE marker names and deletes every marker, printing `killed pid N on port P (file)` or
  `stale marker … (pid … not running)`; `ko-harness.mjs` uses the same scan for `guestUp()` and for the
  second-guest guard. A marker whose pid is dead is deleted, never left to name a process that is gone.

## Owner rule — every report is answered FROM THE LOG, never from the code (2026-11-15)

Verbatim: *"QUALQUER coisa q eu te falo tu tem q ver nos logs. bota isso no agents.md"*, and before it the
same order in the diagnostic form: *"os logs nao devem ser hints, mas a resposta inteira"*.

- The FIRST action on any owner report is a read of his own ring:
  `node _tools/ko-adlog-verdict.mjs --episodes=N` (defect classes, exits 1 when one is present) and
  `node _tools/ko-adlog-window.mjs 9222 ROWS --keep a,b,c` for the rows behind a verdict. Re-reading the
  source is what happens when the ring cannot answer, and **that gap is itself the defect to fix**.
- A row must be a TRANSITION, never a per-heartbeat sample: 70 identical `audio-mismatch` lines buried the
  chronology they were supposed to explain, and the same class of duplication pushed the pod rows out.
- Every write that changes what he sees or hears names its author and its numbers in the row that makes
  it: `native-nudge {from,to,ahead,runway}`, `native-resume {behind}`, `reveal-caught-up {lat,target}`,
  `audio-intent {origin,ev}`, `ad-ui-hold {ct,rs}`. A clock move with no row is the defect KO-20261115-08.
- When a report is about a window the ring no longer holds, say so and name the missing row instead of
  explaining the code. `CANNOT-MEASURE` is an answer; a plausible narrative is not.

## Owner rule — nothing is done until a LIVE Twitch stream proved it (2026-11-08)

**Do not declare done, fixed, working or finished until the change is tested and observed on a real
live Twitch stream** (the owner's Chrome, a channel that is actually broadcasting, the extension
loaded). Unit arms, fixture harnesses and guest-Chrome runs are supporting evidence only: they prove a
mechanism, never the product. A row in `_evidence/` reaches `verified` only with the live run that
showed it; otherwise it stays `fixed` and names the exact live check that is still owed. Reporting
"done" on fixture-only evidence is the failure this rule exists to stop, and it is the same rule the
owner already applies to the spectacle of a claim being repeated back to him.

## Disk: this project measures its own bytes (owner order 2026-11-08)

`python I:/!watcher/tools/artifact-census.py --project I:/kicktwitchyoutube_instagram --own "G:/Temp/ko-harness*" --own "G:/Temp/ko-scratch*" --own "G:/Temp/ko-replica*" --budget-gib 0.4 --gate` — only **rc 0** is a measurement: 2 = above the ceiling, 3 = the walk was cut, 4 = a declared pattern resolved to nothing (a half declaration, and no `OK` is printed beside it). A `du` of the checkout cannot answer this: on 2026-11-08 the repo read 41 MiB while 1424 MiB of guest Chrome profiles sat in fifteen `G:/Temp/ko-harness-*` directories. Every profile this project creates lives under the declared root `G:/Temp/ko-harness` (`KO_PROFILE_ROOT`), `ko-harness.mjs start --fresh` keeps the last run plus one previous (an older profile silently serves the previous build), and any new store (download, model, cache) MUST be created under a declared path and added here with `--own`. Measured after the cleanup: 123 MiB owned, 82 MiB of it the declared store, 0 UNPROVEN. The offline replica (`_tools/ko-replica`, see its README) is the second declared store: `G:/Temp/ko-replica` holds certs, two generated media programs and one Chrome profile per run (deleted by exact path at exit), and it is declared here with `--own "G:/Temp/ko-replica*"`.

## Skill routing (mandatory)

- **`task-resolver` is the entry point for every non-trivial task** in this project, defect, feature, refactor, performance, configuration or research. Load it first, before choosing any other skill, and re-run its classification when the objective, domain or scope changes. Trivial edits (typo, rename, single-line fix) do not need it.
- `project-revival` governs work whose outcome spans product, design and engineering at once; `task-resolver` hands off to it rather than duplicating it.
- Every other skill is reached THROUGH `task-resolver`: it names the domain pack (`task-skill-pack`, `debugging-skill-pack`, `performance-skill-pack`, `design-skill-pack`, `agents-skill-pack` in `C:/Users/Administrador/.agents/skills`), and the pack row names the skill file. Do not select a skill from its one-line description alone.

## Browser: agent-browser default.
Owner browser: authorized for task-needed authentication; follow this project's access scope.
## Herdr panes (mandatory)
Cap: one visible pane per canonical project across workspaces/worktrees. The pane-admission tool was `I:/!manager/tools/herdr-visible-pane-budget.py` and both that repo and the tool were deleted on 2026-11-26 (seat DM: route and mailbox moved to `I:/!watcher/`), so until the watcher republishes an admission tool under `I:/!watcher/tools/` there is no sanctioned way to CREATE a pane: reuse this project's main pane, keep extra workers headless, and never raw-create, focus, move, resize, close, or kill one. Messaging goes through `python I:/!watcher/tools/herdr-dm.py --target <pane>` (mailbox `I:/!watcher/state/herdr-inbox`).

## Writing

- Avoid AI-slop prose: text that sounds generated, over-polished, or written to sell.
- Lead with the concrete point. Cut generic intros, throat-clearing, and closing paragraphs that repeat the section.
- Write features, installation, usage, limitations, and privacy. Do not add persuasion sections.
- Do not use slogan taglines, rhetorical questions, binary contrasts ("not X, but Y"; "não é só X, é Y"), faux-insight lines, or fake-profound endings.
- Do not use three-item lists for rhythm, repeated sentence shapes, or a new synonym for the same thing.
- Avoid marketing verbs and filler: unlock, transform, elevate, empower, streamline, robust, seamless, delve, tapestry, realm, journey, pivotal, testament.
- Avoid unqualified claims such as "free", "best", "no ads", or "never".
- Prefer "is" and "has". Use concrete nouns, numbers, commands, and behavior.
- Avoid em dashes. Use commas, periods, colons, or parentheses.
- Keep `README.md` in Portuguese and `README.en.md` in English. Keep them in sync.
- Do not rename the repository.
- Avoid "slug", proxy/VPS mentions, OBS comparisons, and claims that a version is validated without evidence.

## Kick overlay tooling

- Installed copy: `C:\Users\Administrador\Desktop\Nova pasta (3)\TESTE\VOD.RIP\vendor\kick-overlay`. Syncing this folder is part of the task; do not ask for permission.
- Install/update: `_tools\ko-auto-install.cmd` (debug profile `C:\ChromeDebugProfile`).
- Stage files and reload without a window: `node _tools\ko-reload-persistent.mjs --port=9222`. It prints `loaded`, `expected` and `after`; `after` must equal the manifest version. It compares VERSIONS only, so a rebuilt folder that keeps its version reads as current: for the byte-level answer use the shared `chrome-unpacked-extension-deploy` skill (`node <skill>/scripts/deploy.mjs status|reload --port 9222 --dir "<installed copy>"`), which reports `changed-since-last-load` and the loaded path.
- Reload the content script of an open tab with `_tools\ko-cdp.mjs` + `Page.reload`. A page reload can trigger a Twitch preroll.
- **Ask what the extension believes RIGHT NOW**: `node _tools/ko-snapshot.mjs [port] [--json]` reads the state the page publishes (`data-ko-owner`, `data-ko-audio-*`, `data-ko-adblock`), samples the main media element twice 1.5 s apart, and prints PLAYING / FROZEN / PAUSED / REPEAT per tab, exiting 1 on an anomaly (`#ko-wrap` with no iframe, an owner published with nothing mounted, an element that claims to play while its clock does not advance, playing at `readyState <= 1`). Read-only: no click, seek, pause or navigate, so it is safe on the owner's tab while he watches. It exists because the ring only holds TRANSITIONS: measured 2026-11-20, a native element sat at `rs=1` with a frozen clock for 70 s and the ring had no row for that stretch, so "is it stuck right now" had no instrument. `KO` itself is unreachable (a closure in the content script); the attributes are the extension's own published contract. What the DOM cannot answer (which seek branch ran, the standby frame's `pos`/`lat`, WHY a video is paused) is printed at the end of every run instead of guessed.
- **Ask the code what it decides in silence**: `node _tools/ko-census.mjs [--json] [--gate]` parses `content.js`, `twitch-adblock.js` and `player-bridge.js` and lists every `return`/`continue` that is a DECISION with no log call of its own — split into `silent` (nothing nearby) and `guard-shaped` (the enclosing function logs elsewhere, so the author knew that exit should be explainable). It also cross-checks the ad path's declared state against every suite and names the fields no arm references. Measured 2026-11-20 on 0.8.107: **113 guard-shaped silent exits** (`content.js` 50, `twitch-adblock.js` 63) and **39 of 58 ad-path state fields never referenced by an arm**. `--gate` compares against `_tools/ko-census-budget.json` (a CEILING, never a target) and refuses growth; it is check `silent-census` in `ko-verify`. Proof it bites: plant `if (overlay.standby && !overlay.revealed) return;` in `adUiHoldTick()` — the check goes FAIL naming that file.
- **The census named tonight's bug before tonight's bug happened.** Ranking the same run by function puts `catchUpClean` (8), `adUiHold` (6), `armNativeRecovery` (6), `stopAdOverlay` (6) and `adUiHoldTick` (5) at the top of `twitch-adblock.js` — and `adUiHoldTick` is exactly the guard that let a 62.6 s ad play. The worst offenders are the code paths that decide about the owner's screen. Read that ranking when choosing where to add a row next, not after a report.
- **`nativeStallWatch` is the reference implementation of the rule**, and it is the only one: 18 exits, every refusal goes through `nativeStallRefuse(why, data)` which writes `native-stall-refused {why}`, and every recovery writes `native-stall`/`native-stall-recovered`. Copy its shape (a refusal helper that names the reason, called from every guard) rather than sprinkling `diag()` calls, because the helper makes "silent" and "explained" impossible to confuse.
- **This is the tool the owner asked for on 2026-11-20**, verbatim: *"e por que a gente continua sendo surpreendido pelo codigo inves de saber tudo que ta errado com ele? que ferramenta falta?"*. The measured answer is that 113 decisions could refuse with no row, so the ring could not report them and reading the source was the only way to find one. Lower the budget as guards get their row; never raise it silently.
- **Debug the log with the verdict, not with a dump**: `node _tools/ko-adlog-verdict.mjs [--port=9222|--file=dump.json] [--episodes=N] [--span=MINUTES]` prints `ON SCREEN` / `FROZEN` / `JUMPS` / `SOUND` / `ANSWER` per page load and exits 1 when a defect class is present (a swap that is not one pod, a freeze past a hand-back, a forward jump he would see, a sound change with no author). Every `audio-intent` line it prints names the AUTHOR: `user:pointer`, `user:ui:bar-*`, `user:frame-slider`, `code:adpath`, or `code:UNLABELLED` (which is the defect, not a missing field).
- Prove the mute author live: `node _tools/ko-harness.mjs muteauthor` (pointer -> `user:pointer->visible`, our bar -> `user:ui:bar-mute`, a machine write with no input -> refused `stale-input`, element re-asserted, intent unmoved).
- Read `ko.adlog` raw, without the worker noise: `node _tools\ko-adlog-window.mjs [port] [rows] [--keep a,b,c]` (opens a hidden extension page, because the service worker sleeps and cannot be asked directly). Use it only when the verdict script does not answer.
- Inspect the owner tab and the extension service worker (`ko.adlog`): `G:\Temp\opencode\ko-adlog-dump.mjs`, `ko-stats-poll.mjs` (both present). `ko-owner-probe.mjs` and `ko-one-soak.mjs` were cited here and no longer exist — the single-channel harness is `_tools\ko-harness.mjs`.
- Gate: `node _tools\ko-verify.mjs`; require `RESULT PASS` and `failed=0` (19 checks as of 0.8.48; the count grows with the suite, so pin the verdict, not the number).
- `kick-overlay/content-fix-test.cjs` is NOT wired into the gate and its H4 arm ('the re-pick re-mints exactly once') FAILS at HEAD; measured 2026-11-08 by running it against `git show HEAD:kick-overlay/content.js`, so it is drift from the 0.8.47 frame-ready gate, not a live defect. Run it from `kick-overlay/` (it reads `manifest.json` from the cwd). Do not read its red as a regression you caused.
- agent-browser: `H:\env\npm-global\agent-browser.cmd`, `connect 9222`. Use it for page UI, not for the extension service worker or `ko.adlog`.

### 0.8.123, same wave: the wait's owner was `stopAdOverlay`, and `ad-start` does not go through it

A read-only refutation pass on the 0.8.122 diff (source-traced, no edits, no runs) found the one
ownership hole the arms could not see. The wait is cancelled only inside `stopAdOverlay`, but the
`ad-start` branch never reaches it, and during the wait `overlay.frame && overlay.revealed` are BOTH
true by design: without `msg.switch` the branch returned without mounting the new pod (the ad played
uncovered for the rest of the 3 s window), and with `msg.switch` `startAdOverlay(..., true)` nulled
`overlay.frame` while the wait stayed armed, so the next 150 ms poll computed `!covered`, logged
`handback-ready {capped:false, covered:false}` and tore down the **replacement** frame mid-pod. Both
limbs are reachable from the ordinary new-pod producer and from `need-source`.

`cancelHandbackWait(why)` is now the single canceller - it writes `handback-wait-cancelled {ms, why}`
and is called from `stopAdOverlay`, from the top of the `ad-start` branch and from the entry of
`startAdOverlay` - and it has no early return, because the first version's `return false` was counted
by the census as a new guard-shaped silent exit (`guard-shaped silent=64 > budget 63`; reshaped, budget
untouched at 111).

Two smaller holes from the same pass, both fixed with their own arm: a single transient blind frame
sample (one repeated `pos` or one `Paused` report) used to be terminal and put the frozen native back on
screen, so `cover-lost` now needs two consecutive blind samples (300 ms); and a user play during the
wait was ignored for up to 3 s with our picture over the player he had just taken back, so the wait now
ends on `userResumedHeld()` as `handback-ready {why:'user-resume'}`. `handback-ready` carries `why`
(`ready` / `cap` / `cover-lost` / `no-video` / `user-resume`), which is the field the next log read needs.

Arms: `a new pod during the hand-back wait cancels it and keeps a picture up`, `one blind cover sample
does not end the hand-back wait`, `a user play during the hand-back wait ends it with its reason`, and
`RED: without the cancel a switch during the wait tears the new frame down` (both cancel calls removed;
red with `the mutant left the wait armed across a source switch`). `RESULT PASS ad-time-continuity
checks=180 failed=0`, `ARMS 24/24 present`.

The refutation also REFUTED six claims with named checks, which is worth keeping: every other teardown
door (clean-stall, timeout, overlay-owns, standby-ad-only, source switch) passes through the canceller;
the 180 s pod watchdog, the 7 s frame watchdog, the 12 s cold-cover bound and `nativeStallWatch` all sit
far outside the 3 s wait, and `freezeNativeForPod()` returning null keeps the 500 ms tick from pausing a
second time; a user PAUSE during the wait already wins through `userPausedInPod`; `capped:false` at
`rs<3` is not a lie because it always ships beside `covered:false`; and the three 0.8.122 arms cannot
pass without the product change (arm 1 asserts the live `handbackWait()` and `frameMounted()`, the cap
arm requires its own `handback-ready`, the RED target occurs once and `mutate` throws when absent).

## History: waves, measured receipts, re-arm conditions

Wave records (the measured narrative behind every rule above, with each defect's
re-arm condition) live verbatim in `docs/AGENTS-archive-2026-11-27.md`. Rules stay in
this file. Read the archive before re-arming a ledger row or changing a guard whose
reason is recorded there.

## Project notes

- The extension is in `kick-overlay/`.
- The cold-open bug is **not fixed**: the owner reproduced a real preroll on 2026-10-25 (`srdogg`), with the ad visible for 7.4 s before `overlay-reveal`.
- Time contract of the ad path (0.8.44, `twitch-adblock.js`): the clean player aims at the offset the native had at take-over (`cleanLatTarget()`: 3 s target, catch-up above 8 s, forced re-align at reveal), and the hand-back seeks to `nativeEdge - cleanLatTarget()` — never to `buffered.end`. Keep both surfaces on one offset; a multi-second rewind or a buffered-end hand-off reads to the owner as "the live came back late" and "it jumped at the end of the ad".
- Ownership of playback: a hidden tab and a native the user had paused are never started by the ad path (`resumeRefusedByUser`). A cold preroll (paused at `currentTime < 1`, page just loaded) is the only exception. Mute is tracked live through `volumechange`, with our own writes attributed by `noteMuteWrite`.
- Do not commit generated receipts in `_evidence/`; they are local and regenerated by `_tools/ko-verify.mjs`.

## A fix may not trade one visible defect for another (owner correction 2026-11-07/08)

Verbatim, twice: *"tomei ad que a tela ficou inteira preta ate o ad acabar"* (2026-11-07) and, after
0.8.48 answered it with an opaque panel, the screenshot *"sério que tu fez essa merda?"* (2026-11-08).
0.8.48 replaced "a 30 s ad is visible" with "up to 9 s of a full black page", and the test suite was
written to ENFORCE the panel (`nativeHiddenAtHold === true`), so the gate could never have caught it.

- The screen is the owner's, not the code's: a hold freezes the picture (pause), it never hides the
  surface the user is watching and never paints `inset:0`.
- Before replacing one visible failure with another, name the two user-visible outcomes and pick with a
  number (seconds of black vs seconds of ad), inside the same sentence as the change.
- A test that asserts the NEW behaviour must also carry a mutation that restores the OLD defect. The
  cold-cover suite now does: its RED-2 re-inserts `hideNativeVideos()` on the hold tick.

## Audio ownership — one rule, one writer (0.8.50, 2026-11-08)

`kick-overlay/ko-audio.js` is the only code in this extension allowed to write a mute or a volume.
Everything else declares and reads:

    muted(surface) = intent[surface].muted || policy(surface) || surface !== visible
    volume(surface) = intent[surface].volume

- **intent** is the user's choice for that surface, persisted in `ko.v2` → `vols.{twitch,page,kick,yt}`.
  Only a real gesture sets it: a `volumechange` on the surface's main element that the arbiter did not
  write, the overlay bar, the popup, or the ad badge.
- **policy** is silence Chrome forced (an autoplay refusal). It never becomes intent and the first
  gesture clears it (`setPolicy`).
- **visible** is the one surface being listened to. `setVisible()` is the page's own layers; `claim('ad')`
  is the ad path's clean player covering the page, and it wins while it is up.
- Surfaces: `twitch` (the page video on twitch.tv), `page` (the page video on a YouTube host — a
  separate row, because a Twitch decision must not silence YouTube), `kick` and `yt` (the overlay
  layers, command surfaces) and `ad` (the ad path's clean iframe, which SHARES the `twitch` intent
  because it renders the same stream).

Writers are registered (`register` for a command surface, `registerNative` for elements) and applied as
a diff; every write is stamped in one `WeakMap`, so a `volumechange` echo can never be read back as a
user decision. `content.js` keeps `KO.kickMuted/kickVol/ytMuted/ytVol` only as the UI mirror.

`twitch-adblock.js` runs in the **MAIN world** (manifest `world: "MAIN"`) and cannot reach that file, so
`adblock-bridge.js` carries it across the boundary: `data-ko-audio-m` / `data-ko-audio-v` attributes
carry the derived state DOWN (the ad path applies it to its own iframe and to nothing else), and
`ko-audio-claim` / `ko-audio-intent` CustomEvents carry the claim and the user's gesture UP. Two
`audioSent`/`audioRefused` facts stay in the ad path, both about its own frame. The nine trackers that
used to live there (`wasMuted`, `wasVolume`, `muteIntent`, `muteSent`, `autoplayMuted`, `muteWrite`,
`holdWasMuted`, `holdVolume`, `hiddenVideos[].muted/volume`) are gone: they were snapshots, and a swap
restored the snapshot over the user's newer decision.

Tests: `mute-decision-test.cjs` runs ko-audio.js + adblock-bridge.js + twitch-adblock.js together in one
world (18 checks, incl. a mute-ignoring-authority negative arm), and `ad-time-continuity-test.cjs` keeps
its 30 checks on top of the same world. Gate: `RESULT PASS checks=19 failed=0`.

Status, per the live-proof rule above: the mechanism is proven in the harness and the wiring is proven
loaded in Chrome; the SWAP on a real pod is still owed — the next live stream with 0.8.50 installed must
show `reveal-muted`/mute traffic stopping at one message per transition, no `mute` command after the user
unmutes, and the native back at his intent at ad-end.

## omp relay: the sanctioned way to drive the owner's own Chrome (owner order 2026-11-09)

Verbatim: *"por que tu nao ta usando omp relay"* and *"tu ja usou varias vezes antes"*. Driving his
Chrome by hand over `--remote-debugging-port=9222` with our own CDP client is the wrong tool: the
relay is the prelude's channel, it keeps its tabs in an `omp` group, and it is the only path that
survives what killed the hand-rolled attempts (a wedged relay daemon, stale sessions, and 15 s CDP
timeouts on a loaded browser).

What is installed and measured here (2026-11-09):

- `omp config get browser.relay` → `true`; `browser.relayUrl` → `http://127.0.0.1:9333`.
- The extension lives at `C:/Users/Administrador/.omp/browser-relay/extension` (manifest
  `OMP Browser Relay`, build `18.18.5`, same as `omp --version`) and is loaded into
  `C:\ChromeDebugProfile` as id `jdphdacdpdgbfdcolnnlangmpfajejno`. It was loaded over CDP:
  `Extensions.loadUnpacked {path}` on the browser endpoint — no clicking in his window.
- The extension reads its port from `chrome.storage.local {port}` (default 9224). It connects to
  `ws://127.0.0.1:<port>/ext`. Pointing it at 9333 is what made it work here:
  `[relay] extension connected {"tabs":12,"version":"Chrome/156.0.0.0","omp":"18.18.5"}`.
- `omp browser-relay` and `omp browser-relay --port 9333 --verbose` both serve; `--verbose` prints the
  handshake and each `tab claimed` / `grouped tabs`, which is the only place the truth about a
  connection is visible (`proc://<service>` shows it live).

The failure mode to expect, and it is NOT "the extension is broken": an MV3 service worker sleeps, and
while it sleeps the relay answers `its extension disconnected and has not come back` (or
`its extension never connected`). It reconnects on its own 30 s keepalive alarm, so the repair is to
wake the worker or wait, never to reinstall:
`Target.getTargets` → the `service_worker` target of the extension id → attach → evaluate anything.

API shape that works with it:

    const t = await browser.targets({ app: { relay: true } });        // his pages, `shown` = active tab
    const tab = await browser.open({ name: 'x', url: 'https://…', app: { relay: true } });
    const tab2 = await browser.open({ name: 'y', app: { relay: true, target: 'kick.com/titiltei' } }); // borrows

`browser.open` with `wait_until: 'load'` TIMES OUT on pages that never fire `load` (kick.com measured:
tab created, `open` threw after 90 s, tab alive). Open with `wait_until: 'domcontentloaded'`, or adopt
the tab afterwards with `app.target`. A borrowed tab is HIS page: never navigate it unasked.

**What still cannot be measured this way, and it is not the relay's fault:** kick.com mounts no
`<video>` in a tab nobody looks at. Measured on his Chrome: `{"n":0, title:"titiltei Live Stream -
Watch Live on KICK", visibilityState:"hidden"}`; after `Page.setWebLifecycleState('active')` +
consent dismissal `visibilityState` became `visible` and one `<video>` appeared at `readyState 4,
paused`, but three later `Runtime.evaluate` calls timed out at 8 s. So the kick.com REFERENCE side of a
parity run needs a rendered (focused) kick tab, which is exactly what he forbade. Our own side
(`kickparity`, 9/9 rows) is measurable in the guest; parity stays `UNPROVEN` until someone leaves a
kick.com tab in front.

**Corrected 2026-11-11: the reference side IS measurable in his Chrome without stealing focus.** A
relay tab (`browser.open({app:{relay:true}, url:'https://kick.com/titiltei', wait_until:'domcontentloaded'})`)
reported `{n:2, vis:"visible"}` about 6 s later with the page never activated by the owner: the main
`<video>` at `rs=4, paused=false, ct=15.01, h=720`, plus kick.com's own pre-roll
`static.kick.com/ads/black_2s.mp4` (paused, muted). So the previous "no video in a tab nobody looks
at" was the `hidden` lifecycle of that particular create, not a property of kick.com. Two caveats,
both measured: the element's `seekable.end` is the literal sentinel `1073741824`, so the reference's
live edge has to come from its player (not from `seekable`), and one CDP round-trip after
`Page.setWebLifecycleState('active')` hung the tab past the grace window and the handle was killed —
probe first, mutate the lifecycle last, and treat a killed handle as a released tab.

## Assume this machine is ten times weaker (owner order 2026-11-11, via watcher DM)

Verbatim: *"cancela todos os trabalhos. em todas as lanes. fala pra matar tudo que ta rodando.
ate a da gravacao. fala que voltamos em breve"* — and the standing demand that came with it: write
code that assumes the box is **10x weaker than it looks**, so a lane never causes the freeze the
owner feels.

- **One heavy job at a time, per box.** A second guest browser, a second sweep, a second encoder is a
  defect, not parallelism: the harness already refuses a second guest (`a guest browser is already
  running on port N`), and every new instrument inherits that rule.
- **Declare the ceiling BEFORE the job starts**, not after it hurts: threads (`OMP_NUM_THREADS`,
  `--jobs`, pool size), MB of RSS, MB/s of I/O, GiB of disk, and the pid + instrument that will prove
  the number. A limit nobody measured is not a limit.
- **Throttling is the LAST resort.** Cheaper first, in this order: do less work, do it once, batch it,
  reuse a cache, make it incremental, delete the duplicate. A CPU cap (`watcher run --cpu`) bounds CPU
  and NOT I/O — a job that `scandir`s, `stat`s, `git`s or reads bytes needs a duty cycle at the source
  (measured: 20.5 MB/s on a saturated volume inside a 40 % CPU cage).
- **Cache and resume by content**, so a re-run of the same question costs a hit, not a re-read: hash
  the inputs plus the parameters, and print `MISS <key>` / `CACHE HIT <key>` so eleven "measurements"
  that were nine hits cannot be counted as evidence.
- **No unbounded loop, fan-out or in-memory accumulation.** No `while true` poll, no per-item bash
  respawn (coalesce into one supervisor), no array that grows with the session, no log ring read whole
  into a variable.
- A measurement taken under starvation is the QUEUE, not the instrument: re-run it once in a quiet
  window before claiming a floor.

## Read the box before the one heavy step (measured 2026-11-26, seat freeze order)

The owner reported the PC freezing hard twice in one hour. Measured by the seat in that window: 12
P-cores at 77% mean, **all 8 E-cores pinned at 100%**, total 86%, watcher tick gaps of 35 s with verdict
`not_scheduled`, and `I:` at 0.2% free. This pane's own tree measured **16.7% of one core**, dropping to
**11.9%** once its one heavy job (the gate) was cancelled, so the gate was not the burn - but a suite
started on a box in that state buys wall time and steals the machine back from the owner, and that is
the report.

- **`node _tools/ko-load-check.mjs --gate` is the pre-flight, and it must be the left side of `&&`:**
  `node _tools/ko-load-check.mjs --gate && node _tools/ko-verify.mjs`. Inside `$(...)` it cannot gate
  anything - measured 2026-11-26, the reading printed `BUSY (pinned=8, busiest=100)` and the `&&` still
  launched the gate because the substitution's status never reached the shell. Run in one 1.5 s window with `os.cpus()`
  deltas (no child process, no tree walk, no disk I/O). It prints `{verdict, total, busiest, pinned,
  perCore}` and exits **2 (BUSY)** when the whole box is above 70% or any single core is above 90%.
  A BUSY reading means the heavy step is **queued, not started**; re-read after the load leaves, and
  never "retry in a loop" - the box is the reason, and polling it is another cost.
- The same run is the READY receipt: measured twice minutes apart in that freeze, `56.5% total with 8
  cores pinned` (BUSY) and `49% total, busiest 70.8, pinned 0` (READY). Two samples of the same
  instrument, opposite verdicts, which is what makes the check discriminating instead of decorative.
- **The gate is this project's one heavy step** (`node _tools/ko-verify.mjs`, ~330 s serial on the SMR
  volume). One at a time, with the READY reading quoted beside its result, and no second suite, build,
  replica scenario or browser guest started while it runs.
- A lane that cannot measure the box (a worktree without the tool) inherits the parent's reading and
  does not re-derive it: the census is the seat's, the cost is shared.

<!-- REVIVAL:WORKFLOW:START -->
## Universal Problem-Handling Workflow (All Models: Small -> Frontier)

Follow this exact decision tree on **every** user message before touching code:

1. **Classify the Request First (pick ONE primary type):**
   - **Question / Explanation** (*"how does X work?", "why did Y happen?"*) -> Read `features/INDEX.md` first, then jump directly to the named owning `file:line`. Never scan the whole repo blindly.
   - **Proposal / Design / Trade-off** -> Read `features/INDEX.md` + `benchmarks/budgets.json` + `benchmarks/sliders.json`. State current behavior, target shape, blast radius, and metric impact before writing code.
   - **Bug / Defect / Regression** -> Check `features/INDEX.md` (inputs/outputs & interlinks) + `harness/angles.tsv` + `codeintel trace` / runtime logs. Reproduce with a failing RED test or offline twin in `harness/twins/` **before** editing.
   - **Feature / Improvement** -> Check `features/INDEX.md` + `revival/COMMANDS.md` + `benchmarks/budgets.json`. Plan the smallest vertical slice (`<=400` LOC), isolate in a git worktree, wire into real entrypoints (zero unwired ghosts).
   - **Performance / Slow Loop / Refactor** -> Run `codeintel health` + `codeintel trace` + `benchmarks/budgets.json` + `revival/FRICTION.json`. Measure BEFORE on the real target, optimize, prove AFTER on the same instrument.

2. **Mandatory Fast-Lookup Order (Save Tokens, Prevent Drift):**
   1. `features/INDEX.md` — macro architecture, inputs, outputs, and feature interlinks.
   2. `revival/COMMANDS.md` — verified build, fast-test (`<15s`), offline twin, and gate commands.
   3. `benchmarks/budgets.json` — required metrics & ceilings (basic -> E2E) that MUST NOT regress.
   4. `harness/angles.tsv` & `harness/twins/` — falsifiers and offline replayable twins.
   5. `revival/GOAL.json` & `revival/MILESTONES.json` — durable multi-day goal and active wave.

3. **Execution & Landing Contract (Non-Negotiable):**
   - Never guess runtime behavior from reading code alone; prove with a runnable command + RED/GREEN arm.
   - Work in an isolated git worktree for non-trivial edits; snapshot with `git_checkpoint.py` before drastic refactors.
   - Run the project gate (which runs **metric budgets**, **blast-radius checks**, and **`feature_map_sync.py --gate`**) before claiming done.
   - Never leave `AGENTS.md` or `features/INDEX.md` stale after adding/renaming a macro feature.
<!-- REVIVAL:WORKFLOW:END -->

<!-- REVIVAL:FEATURES:START -->
## Macro Feature Map (Gate-Synced — Details in `features/INDEX.md`)

| Feature | Files | Inputs -> Outputs | Interlinks |
|---|---:|---|---|
| `_tools` | 57 | the repository working tree and its git history, the extension's ring dump (`chrome.storage.local['ko.adlog']`) read over CDP -> a gate verdict + receipt (`_evidence/ko-verify-latest.md`), machine artifacts per verified bug (`_evidence/<bug>-arms.md`) and reachability records | kick-overlay |
| `kick-overlay` | 23 | the Twitch watch page DOM: `[data-a-target="video-player"]`, the squeezeback/slate ad text, the page's own `HTMLVideoElement`, Twitch's HLS playlists as fetched by the page's own player worker (token, `adExtinf`, `#EXT-X-DATERANGE`) and the GQL usher (`playbackAccessToken`) -> the overlay iframe + bar (`#ko-wrap`, `#ko-g1`, seek bar) with the kick/YouTube picture, published attributes the instruments read: `data-ko-owner`, `data-ko-audio-m/-v/-vis/-wt/-it`, `data-ko-adpark`, `data-ko-adblock` | _tools |

Full macro contracts, verify commands, and file ownership live in `features/INDEX.md` and `features/features.json` (enforced on every gate by `feature_map_sync.py --gate`).
<!-- REVIVAL:FEATURES:END -->
