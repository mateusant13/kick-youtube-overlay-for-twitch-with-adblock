# AGENTS.md
## Owner rule — ship work without paperwork drag (2026-10-31T02:59:01-03:00)
Keep useful behavior and its minimum proof/docs moving in the same fast delivery. Skip optional process artifacts when they cost more than the change. Before agent fan-out or disk-heavy builds/tests, use `fast-land-shared-artifacts`: measure total disk growth, share the sanctioned target/cache across lanes, and serialize instead of duplicating heavy artifacts when sharing is unsafe. This owner direction supersedes older process checklists that add optional work without protecting a concrete risk; keep only minimum proof for correctness, security, data integrity, or destructive work.

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
- Inspect the owner tab and the extension service worker (`ko.adlog`): `G:\Temp\opencode\ko-owner-probe.mjs`.
- Single-channel harness: `G:\Temp\opencode\ko-one-soak.mjs`.
- Gate: `node _tools\ko-verify.mjs`; require `RESULT PASS` and `failed=0` (18 checks as of 0.8.45; the count grows with the suite, so pin the verdict, not the number).
- agent-browser: `H:\env\npm-global\agent-browser.cmd`, `connect 9222`. Use it for page UI, not for the extension service worker or `ko.adlog`.

## Project notes

- The extension is in `kick-overlay/`.
- The cold-open bug is **not fixed**: the owner reproduced a real preroll on 2026-10-25 (`srdogg`), with the ad visible for 7.4 s before `overlay-reveal`.
- Time contract of the ad path (0.8.44, `twitch-adblock.js`): the clean player aims at the offset the native had at take-over (`cleanLatTarget()`: 3 s target, catch-up above 8 s, forced re-align at reveal), and the hand-back seeks to `nativeEdge - cleanLatTarget()` — never to `buffered.end`. Keep both surfaces on one offset; a multi-second rewind or a buffered-end hand-off reads to the owner as "the live came back late" and "it jumped at the end of the ad".
- Ownership of playback: a hidden tab and a native the user had paused are never started by the ad path (`resumeRefusedByUser`). A cold preroll (paused at `currentTime < 1`, page just loaded) is the only exception. Mute is tracked live through `volumechange`, with our own writes attributed by `noteMuteWrite`.
- Do not commit generated receipts in `_evidence/`; they are local and regenerated by `_tools/ko-verify.mjs`.

## Wave record — 2026-11-07, ad-path live-time and playback ownership

Destination: the four defects the owner reported on 2026-11-07 (live several seconds behind after the swap, a jump at ad-end, mute flipping during the swap, a paused background tab unpaused) close as one property — the clean and native players must sit at one offset from the live edge, and the extension must not overrule the user's pause or mute. Delivered in 0.8.44: `cleanLatTarget`/`catchUpClean`/`resumeRefusedByUser`/`onNativeVolumeChange` in `kick-overlay/twitch-adblock.js`, one gate check (`ad-time-continuity`, 13 assertions, four pre-fix arms), four ledger entries `KO-20261107-01..04`, README split updated in both languages.

Scope decision (`project-revival`): this stays a contained defect wave, not a project-revival programme. The failure modes live in one module and one gate, and the product surface (features, install, usage) does not change, so the containment the skill asks for is already met.

Shipped build: 0.8.45, synced to the installed copy and reloaded into the debug-profile Chrome (`loaded=0.8.44 expected=0.8.45`, `after=0.8.45`). 0.8.44 was cut and then corrected before it reached the browser, so the four ledger rows name 0.8.45 as `fixed_in`.

Two claims were demoted from `verified` to `fixed` instead of being carried on evidence that predates this commit, because `_tools/ko-verify.mjs` refuses a reachability record older than the source it measured: `KO-20261023-01` (cold cover) and `KO-20261026-04` (YouTube resume). Both keep their old records and a `next` naming the exact re-arm command, and the re-arm is NOT chased with a retry loop: three guest runs on 2026-11-07 measured the reason for the first one (a cover resolved at 15.3 s past the 12 s bound on `buffered=2.45 < 4`, two NO-VERDICT), and repeated guest starts are what the owner reported as terminal popups.

`KO-20261023-01` is back to `verified` on a fresh arm: the cover timer fired at exactly 12000 ms with the branch logged by nothing, so a source that could not get healthy measured as a violation of its own bound. `COLD_COVER_BOUND_MS = 9000` and the `cold-cover-timeout` log line fixed both halves, and the next guest run landed `cold-cover` at 3674 ms, native hidden, resolved by `overlay-reveal` at 7306 ms.

`KO-20261026-04` is also back to `verified`: the arm's own precondition (a native page player really playing) fails in a fresh guest, because an unset preference makes the overlay load its own player and the native `<video>` stays paused by design. Setting `ko.v2.player='twitch'` through a hidden extension page and reloading the tab produced a playing native (`paused=false rs=4 ct=6.2`), and the arm then passed both limbs: the user-paused video stayed paused across 50 s, and the positive control still resumed through the same probe path. Only the four 2026-11-07 rows stay `fixed`, because they need a real pod on his Chrome.

Console windows: `_tools/ko-guest.mjs:41` (the `powershell -Command Get-CimInstance … taskkill` kill), `:84` (the Chrome child) and `_tools/ko-harness.mjs:58` (the `guest stop` child) spawned without a console flag from a console-less parent, which is what Windows presented to the owner as a popup window (herdr DMs `dm-09d12544c5fb3ffeadee`, `dm-17db5363d76e5e8d0b0b`). All three now carry `windowsHide: true`, and the per-measurement start/stop loop was replaced by one combined invocation. The two `pythonw.exe` rows (`tools\tray.ps1`) are not this lane.

Declined parts and their re-arm conditions:
- **No live-pod measurement.** A real pod was not painted in the guest Chrome during the 2026-10-26 runs (5 `ad-net` requests, 0 visible-ad samples over 150 s), so the arms are unit-level through the real module. Re-arm: the first time the owner reports a pod while 0.8.45 is installed, time the reveal and the hand-back on his Chrome and move the four ledger rows off `fixed`.
- **No cold-open (preroll cover) work.** That defect has its own trap (`cold-cover-fixture`, 7.4 s observed on 2026-10-25) and is not in the four reports. Re-arm: only if the owner names the cold open again.
