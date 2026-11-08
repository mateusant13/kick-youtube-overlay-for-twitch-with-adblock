# AGENTS.md
## Owner rule — ship work without paperwork drag (2026-10-31T02:59:01-03:00)
Keep useful behavior and its minimum proof/docs moving in the same fast delivery. Skip optional process artifacts when they cost more than the change. Before agent fan-out or disk-heavy builds/tests, use `fast-land-shared-artifacts`: measure total disk growth, share the sanctioned target/cache across lanes, and serialize instead of duplicating heavy artifacts when sharing is unsafe. This owner direction supersedes older process checklists that add optional work without protecting a concrete risk; keep only minimum proof for correctness, security, data integrity, or destructive work.

## Owner rule — nothing is done until a LIVE Twitch stream proved it (2026-11-08)

**Do not declare done, fixed, working or finished until the change is tested and observed on a real
live Twitch stream** (the owner's Chrome, a channel that is actually broadcasting, the extension
loaded). Unit arms, fixture harnesses and guest-Chrome runs are supporting evidence only: they prove a
mechanism, never the product. A row in `_evidence/` reaches `verified` only with the live run that
showed it; otherwise it stays `fixed` and names the exact live check that is still owed. Reporting
"done" on fixture-only evidence is the failure this rule exists to stop, and it is the same rule the
owner already applies to the spectacle of a claim being repeated back to him.

## Disk: this project measures its own bytes (owner order 2026-11-08)

`python I:/!watcher/tools/artifact-census.py --project I:/kicktwitchyoutube_instagram --own "G:/Temp/ko-harness*" --budget-gib 0.4 --gate` — only **rc 0** is a measurement: 2 = above the ceiling, 3 = the walk was cut, 4 = a declared pattern resolved to nothing (a half declaration, and no `OK` is printed beside it). A `du` of the checkout cannot answer this: on 2026-11-08 the repo read 41 MiB while 1424 MiB of guest Chrome profiles sat in fifteen `G:/Temp/ko-harness-*` directories. Every profile this project creates lives under the declared root `G:/Temp/ko-harness` (`KO_PROFILE_ROOT`), `ko-harness.mjs start --fresh` keeps the last run plus one previous (an older profile silently serves the previous build), and any new store (download, model, cache) MUST be created under a declared path and added here with `--own`. Measured after the cleanup: 123 MiB owned, 82 MiB of it the declared store, 0 UNPROVEN.

## Skill routing (mandatory)

- **`task-resolver` is the entry point for every non-trivial task** in this project, defect, feature, refactor, performance, configuration or research. Load it first, before choosing any other skill, and re-run its classification when the objective, domain or scope changes. Trivial edits (typo, rename, single-line fix) do not need it.
- `project-revival` governs work whose outcome spans product, design and engineering at once; `task-resolver` hands off to it rather than duplicating it.
- Every other skill is reached THROUGH `task-resolver`: it names the domain pack (`task-skill-pack`, `debugging-skill-pack`, `performance-skill-pack`, `design-skill-pack`, `agents-skill-pack` in `C:/Users/Administrador/.agents/skills`), and the pack row names the skill file. Do not select a skill from its one-line description alone.

## Browser: agent-browser default.
Owner browser: authorized for task-needed authentication; follow this project's access scope.
## Herdr panes (mandatory)
Cap: one visible pane per canonical project across workspaces/worktrees. Create via `python I:/!manager/tools/herdr-visible-pane-budget.py workspace --cwd <root> --label <id>` only; unknown/already-present projects refuse. Reuse main pane; extra workers headless; no raw create/focus/move/close.

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
- Inspect the owner tab and the extension service worker (`ko.adlog`): `G:\Temp\opencode\ko-adlog-dump.mjs`, `ko-stats-poll.mjs` (both present). `ko-owner-probe.mjs` and `ko-one-soak.mjs` were cited here and no longer exist — the single-channel harness is `_tools\ko-harness.mjs`.
- Gate: `node _tools\ko-verify.mjs`; require `RESULT PASS` and `failed=0` (19 checks as of 0.8.48; the count grows with the suite, so pin the verdict, not the number).
- `kick-overlay/content-fix-test.cjs` is NOT wired into the gate and its H4 arm ('the re-pick re-mints exactly once') FAILS at HEAD; measured 2026-11-08 by running it against `git show HEAD:kick-overlay/content.js`, so it is drift from the 0.8.47 frame-ready gate, not a live defect. Run it from `kick-overlay/` (it reads `manifest.json` from the cwd). Do not read its red as a regression you caused.
- agent-browser: `H:\env\npm-global\agent-browser.cmd`, `connect 9222`. Use it for page UI, not for the extension service worker or `ko.adlog`.

## Project notes

- The extension is in `kick-overlay/`.
- The cold-open bug is **not fixed**: the owner reproduced a real preroll on 2026-10-25 (`srdogg`), with the ad visible for 7.4 s before `overlay-reveal`.
- Time contract of the ad path (0.8.44, `twitch-adblock.js`): the clean player aims at the offset the native had at take-over (`cleanLatTarget()`: 3 s target, catch-up above 8 s, forced re-align at reveal), and the hand-back seeks to `nativeEdge - cleanLatTarget()` — never to `buffered.end`. Keep both surfaces on one offset; a multi-second rewind or a buffered-end hand-off reads to the owner as "the live came back late" and "it jumped at the end of the ad".
- Ownership of playback: a hidden tab and a native the user had paused are never started by the ad path (`resumeRefusedByUser`). A cold preroll (paused at `currentTime < 1`, page just loaded) is the only exception. Mute is tracked live through `volumechange`, with our own writes attributed by `noteMuteWrite`.
- Do not commit generated receipts in `_evidence/`; they are local and regenerated by `_tools/ko-verify.mjs`.

## Wave record — 2026-11-08, the mute reverted by a second writer (0.8.49/0.8.50)

Owner report: "fica mutando quando eu desmuto o tempo inteiro". Measured cause, from his own
`ko.adlog` and the code, not guessed:

- `revealOverlay()` runs on every `st` heartbeat (1/s) and re-sent `mute:true`: **50 `reveal-muted` in
  70 s** of his pod. Unmuting was overwritten within a second. 0.8.49 made it a transition.
- `content.js syncMute()` re-assigned `muted = true` on the native `<video>` every 400 ms, and the ad
  path's `silenceNative()`/`hiddenVideos[]` did the same on its own tick. Twitch's volume button writes
  to that same element, so his click was undone half a second later. Both writers are gone in 0.8.50.
- `content.js` had no route from a native unmute to the layer he was actually hearing (`player=kick`),
  and its 400 ms tick re-muted the element it wrote to.
- The ad path held nine snapshot fields (`wasMuted`, `wasVolume`, `muteIntent`, `muteSent`,
  `autoplayMuted`, `muteWrite`, `holdWasMuted`, `holdVolume`, `hiddenVideos[].muted/volume`); a swap
  restored a frozen value over a newer decision.

0.8.50 replaces all of it with `ko-audio.js` (see the contract above). `mute-decision-test.cjs` was
rewritten to run the three real files together and now asserts the CONTRACT with 18 checks (a
mute-ignoring authority is a negative arm); `ad-time-continuity-test.cjs` kept its 30 checks on the same
world. Gate `RESULT PASS checks=19 failed=0`.

Live proof, measured 2026-11-08 in a fresh guest Chrome on twitch.tv/buzzyi_ with the installed copy
(0.8.50, `deploy.mjs` reports `loaded=0.8.50`): `data-ko-audio-m`/`-v` are published by the bridge, a
gesture on the page's own volume control moved the published volume 0.50 → 0.33 (so the gesture reader
crosses the world boundary), and the native stayed unmuted for 2.4 s of the 400 ms tick (6/6 samples).
**The pod swap itself is still owed**: it needs a real ad on a live channel with 0.8.50 loaded, and the
row is NOT `verified` until that run exists.

## Wave record — 2026-11-08, the black page ("sem anúncio · carregando a live…", 0.8.51)

Owner paste: a screenshot of `twitch.tv/pinnkpawz`, whole viewport black, one centred
line of text. Three separate mechanisms produced that screen, all measured in his own
`ko.adlog` (read with `_tools/ko-adlog-window.mjs`, which filters the worker noise out
of `chrome.storage.local['ko.adlog']` from a hidden extension page):

1. **The hold painted the screen.** `ad-hold` with the clean source not yet playing
   entered the cold-cover branch, which called `hideNativeVideos()` and raised a panel
   with `inset:0;background:#000`, bounded by `COLD_COVER_BOUND_MS = 9000`. With the
   native hidden and the frame still at opacity 0.01, the panel WAS the entire page.
2. **The health gate counted a heartbeat it could not have.** The frame publishes `st`
   from `setInterval(sendSt, 1000)` inside a hidden iframe; in a background tab Chrome
   throttles that timer. His log shows `playing-not-healthy` samples **18 s, 32 s and
   10 s apart** while `pos` advanced at 1× — a healthy player, reported far too slowly.
   The gate required **three consecutive** healthy samples, so it could never qualify
   there, and the 12 s bound stopped a player that was fine.
3. **The latency number was wrong.** The frame measured `lat = seekable.end - pos`. On
   Twitch that end includes the stitched ad segments still listed ahead of the live
   content, and on the native element it is the literal sentinel `1073741824`
   (`native-handoff {se: 1073741824}`, repeatedly). Measured consequence in his log: a
   clean player holding **3.6 s** of buffer read as **8.6-8.7 s** behind
   (`overlay-catchup {lat:8.6, pos:29.5}`), which is above `CLEAN_LAT_MAX = 8`, so
   `revealOverlay()` forced `playing = false` and re-armed a 12 s timeout on every
   attempt — the churn behind "a live volta vários segundos".

0.8.51, one fix per mechanism:

- `player-bridge.js`: `lat` in the order of honesty — `h.latency` (what hls.js measures
  against the edge it knows), else `buffered.end - pos`, else `seekable.end` **only**
  when it is a real position (`< 1e6 s`). The payload carries `latSrc`, so the next log
  says which instrument answered. The heartbeat is now also driven by the element's own
  events (`playing, timeupdate, progress, waiting, canplay, seeked, pause,
  volumechange`, coalesced to 200 ms) and the page can pull a sample with `{t:'state'}`
  on the visibility edge.
- `twitch-adblock.js`: the gate asks for **two** consecutive healthy samples on a dense
  heartbeat and **one** when the measured gap exceeds 1.5 s; the tab returning to
  visible pulls a fresh sample instead of waiting for the next tick.
- The hold now freezes instead of covering: `pauseNativeForHold(v)` pauses the native
  (a paused video keeps its last decoded frame), the native is **not** hidden, the
  notice is a small centred panel (`translate(-50%,-50%)`, no `inset:0`, no opaque
  background), and the bound is **3000 ms**. Past the bound it fails open: the handoff
  seeks the native to the live edge, which also skips the rest of the pod.

Contract change, stated because a test used to enforce the old one:
`cold-cover-fixture-test.cjs` asserted `nativeHiddenAtHold === true` and now asserts the
opposite (frozen, not hidden; the notice is a panel). Its RED-2 mutation is the defect
itself — restoring `hideNativeVideos()` in the hold — and a new SPARSE arm drives one
healthy sample after a 1.7 s gap, with SPARSE-RED proving the old count-based gate fails
it. Suite: 11 → **15 checks**.

Verification: gate `RESULT PASS checks=19 failed=0`. Not verified: the frame's new
payload in a live browser — the guest Chrome on this machine produced no clean source
(`standbyReady: 0` on two live channels, so no frame ever published `st`), so `latSrc`
and the event-driven heartbeat are proven by parse + the page-side contract only. The
first live pod with 0.8.51 must show `lat` in the 3-4 s range with `latSrc: 'hls'`, no
`overlay-catchup` churn, and no full-screen panel in `ko.adlog`.

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

## Wave record — 2026-11-07, ad-path live-time and playback ownership

Destination: the four defects the owner reported on 2026-11-07 (live several seconds behind after the swap, a jump at ad-end, mute flipping during the swap, a paused background tab unpaused) close as one property — the clean and native players must sit at one offset from the live edge, and the extension must not overrule the user's pause or mute. Delivered in 0.8.44: `cleanLatTarget`/`catchUpClean`/`resumeRefusedByUser`/`onNativeVolumeChange` in `kick-overlay/twitch-adblock.js`, one gate check (`ad-time-continuity`, 13 assertions, four pre-fix arms), four ledger entries `KO-20261107-01..04`, README split updated in both languages.

Scope decision (`project-revival`): this stays a contained defect wave, not a project-revival programme. The failure modes live in one module and one gate, and the product surface (features, install, usage) does not change, so the containment the skill asks for is already met.

Shipped build: 0.8.45, synced to the installed copy and reloaded into the debug-profile Chrome (`loaded=0.8.44 expected=0.8.45`, `after=0.8.45`). 0.8.44 was cut and then corrected before it reached the browser, so the four ledger rows name 0.8.45 as `fixed_in`.

Two claims were demoted from `verified` to `fixed` instead of being carried on evidence that predates this commit, because `_tools/ko-verify.mjs` refuses a reachability record older than the source it measured: `KO-20261023-01` (cold cover) and `KO-20261026-04` (YouTube resume). Both keep their old records and a `next` naming the exact re-arm command, and the re-arm is NOT chased with a retry loop: three guest runs on 2026-11-07 measured the reason for the first one (a cover resolved at 15.3 s past the 12 s bound on `buffered=2.45 < 4`, two NO-VERDICT), and repeated guest starts are what the owner reported as terminal popups.

`KO-20261026-04` is back to `verified`: the arm's own precondition (a native page player really playing) fails in a fresh guest, because an unset preference makes the overlay load its own player and the native `<video>` stays paused by design. Setting `ko.v2.player='twitch'` through a hidden extension page and reloading the tab produced a playing native (`paused=false rs=4 ct=6.2`), and the arm then passed both limbs: the user-paused video stayed paused across 50 s, and the positive control still resumed through the same probe path.

**0.8.46 — the black screen (owner report 2026-11-07, "tela inteira preta ate o ad acabar").** Read from his own `ko.adlog` over CDP, not from a guest: `cold-cover` at 457399 ms with every native `<video>` hidden, then `overlay-no-playing` `fallback-timeout` at 474407 ms — 17 s with nothing on screen, and the worker had answered `no-source` 1.7 s before the cover. The cold hold raised the frame to opacity 1 and hid the native on the same tick; an iframe with no decoded picture is a black rectangle, so the user got black instead of either the clean picture or the muted ad. 0.8.46 makes the hold a hold: no paint, no hide, `cold-cover` logs `painted:false`, the badge explains it, and `revealOverlay()` does the swap only when the clean player is actually playing. `cold-cover-fixture-test.cjs` now asserts the native stays visible and the frame stays transparent on the hold tick, and its new RED-2 arm re-inserts the paint and makes that assertion fail. Gate: `RESULT PASS checks=18 failed=0`.

`KO-20261023-01` went back to `fixed`: its fresh record measured the 0.8.45 contract (opaque frame over a hidden native), which is the very behaviour 0.8.46 removed. Two re-arm attempts returned NO-VERDICT because the guest never created `#ko-adfix` — `prewarm.fail` for the channel means there is no standby to hold, a source problem in the guest, not a verdict.

The delay half of the report is open as `KO-20261107-06` (`reproduced`) and is NOT guessed at: his log shows `overlay-catchup lat=20.3` / `20.6` (the clean picture sat ~20 s behind live) and a hand-back target of `edge - cleanLatTarget()`, which preserves up to 8 s of the native's own lag. Which of the two the user feels, and whether a 3 s ceiling is playable on his connection, is decided from his next pod's log, not invented.

**0.8.47 — the console dump (owner paste 2026-11-07, `local://paste-1.md`).** Three defects, all measured in his console. (a) `resolveYtPageKick()` invented a kick channel out of a YouTube **video id** (and out of a UC id on the next tier): `Unsafe attempt to load URL https://kick.com/api/v2/channels/__uw9vktm-m from frame with URL https://www.youtube.com/watch?v=__Uw9vKtm-M`, twice per video, ~20 videos. Both guessing tiers are deleted (the same file's doctrine already says never guess another streamer's stream onto a page) and `plausibleKickSlug()` refuses a UC-shaped or empty slug before any fetch. (b) `overlaySend()` posted with the extension origin as targetOrigin into a frame whose navigation had not committed, where the contentWindow still belongs to the page origin — the browser rejects the post (`Failed to execute 'postMessage' on 'DOMWindow' …`) and the command is LOST. Commands now queue behind a ready gate (frame `load` or first token-valid message); `ytSend()` in content.js queues the same way. (c) every frame set both an `allow` attribute carrying fullscreen and `allowFullScreen`, so Chrome logged `Allow attribute will take precedence over 'allowfullscreen'`; the property is gone from all three builders.

Proof: `kick-overlay/yt-route-test.cjs` extracts the shipped `resolveYtPageKick`/`plausibleKickSlug` out of content.js and runs them (6 checks, negative arm restores the tiers and is caught); `ad-time-continuity-test.cjs` gained two arms on an un-navigated frame (`makePage(SOURCE,{autoLoad:false})`) plus a `PRE_FIX_POST_EARLY` mutation that is caught (18 checks); the shared stub now models Chrome by firing the frame `load` a tick after creation, which is what the other harnesses needed to stay honest. Gate `RESULT PASS checks=19 failed=0`. Measured on a fresh background YouTube tab with a live control: the instrument saw a console line it was asked to see, our content-script world existed on the page, and the tab made **zero** requests to `kick.com` (pre-fix: two per video).

Console windows: `_tools/ko-guest.mjs:41` (the `powershell -Command Get-CimInstance … taskkill` kill), `:84` (the Chrome child) and `_tools/ko-harness.mjs:58` (the `guest stop` child) spawned without a console flag from a console-less parent, which is what Windows presented to the owner as a popup window (herdr DMs `dm-09d12544c5fb3ffeadee`, `dm-17db5363d76e5e8d0b0b`). All three now carry `windowsHide: true`, and the per-measurement start/stop loop was replaced by one combined invocation. The two `pythonw.exe` rows (`tools\tray.ps1`) are not this lane.

Declined parts and their re-arm conditions:
- **No live-pod measurement.** A real pod was not painted in the guest Chrome during the 2026-10-26 runs (5 `ad-net` requests, 0 visible-ad samples over 150 s), so the arms are unit-level through the real module. Re-arm: the first time the owner reports a pod while 0.8.45 is installed, time the reveal and the hand-back on his Chrome and move the four ledger rows off `fixed`.
- **No cold-open (preroll cover) work.** That defect has its own trap (`cold-cover-fixture`, 7.4 s observed on 2026-10-25) and is not in the four reports. Re-arm: only if the owner names the cold open again.
