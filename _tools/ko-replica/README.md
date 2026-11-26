# ko-replica — offline Twitch watch page for the ad path

A deterministic local stand-in for `twitch.tv/<channel>` so the real `kick-overlay` extension can be
measured end to end without an account, a live channel, an ad spend, or the owner's browser.

It is not a mock of the extension. The extension is loaded from `kick-overlay/` unchanged, and it sees
what it sees on Twitch: an HTTPS GQL endpoint returning a playback access token, a master playlist, a
media playlist with an ad block inside a live window, and a page whose player runs in a blob worker
with `MediaSourceHandle`.

## What the replica cannot measure, stated instead of faked

- **A real stitched-ad playlist.** Five 100 s captures with `--navigate` on live channels (rodil,
  shygo twice, xqc 2026-11-26 at 20 640 viewers) produced **0 pods**. The DATERANGE class census of the
  120 clean bodies from xqc is `timestamp` / `twitch-session` / `twitch-stream-source` /
  `twitch-trigger` and nothing else, so a clean playlist carries no ad class at all: the ad shape here
  is a reconstruction from the extension's own worker digests, not a sample.
- **A hand-back whose `se` is behind the wall clock by a pod's length** (`basis:'pod-end'`). The
  replica's `se` advances with the element's own clock, so the pod-extent branch can only be proven by
  its unit arm, never by a scenario.
- **A viewer who watched longer than the pod lasted**, which is the real condition for the same branch.
- **A native element below `HAVE_FUTURE_DATA` at the pod end while the clean frame is still
  decoding** was a limit until 2026-11-26, and is now produced. `dev-handback-wait.json` uses
  `stall:{on:'native', atMs:0, ms:30000, allowFirst:2}`: the edge serves the init and ONE native
  segment, then refuses native media (503) while clean_-prefixed segments keep the clean iframe
  playing a content picture. The native drains to `rs 2` before the 10-24 s midroll, so
  `handback-wait` arms at pod end with the frame still covering the screen. The earlier refuted
  attempt (`on:'all'`) starved both surfaces together and produced
  `native-seek-skipped {rs:4, podExtent:14}` with `handback-wait n=0`; writing `readyState` from
  the page would fake the product's own input and is still forbidden.

Both are named divergences: a capture that prints `ad-segments=0` is a measurement of the window, not a
`false`, and a scenario that cannot reach a branch reports it as unreached.

## What is impersonated

| surface | how |
|---|---|
| `www.twitch.tv/<channel>` | served over HTTPS from this process |
| `gql.twitch.tv` | `streamPlaybackAccessToken` with a signed token, field-compatible with the client |
| `usher.ttvnw.net` / `video-edge-a.playlist.ttvnw.net` | master with a 720/480/360 ladder; live media playlists in Twitch's measured tag set (see "Measured against the real page") |
| player shape | `page/player-worker.js` fetches inside a Worker, appends in the worker, hands a `MediaSourceHandle` to `<video>` |
| ad DOM | `wrapper` (squeezeback container with a painted inner div), `countdown`, `slate` |
| `kick.com/api/v{1,2}/channels/<slug>` | 404, so the kick layer stays unmounted |

Chrome maps those hosts to the local port with `--host-resolver-rules` and accepts the fixture's
self-signed certificate with `--ignore-certificate-errors`. No proxy, no DNS change, no traffic leaves
the machine.

## Token asymmetry, as measured on Twitch

The same playlist URL answers differently depending on the playback token: `autoplay` (and
`mobile`+`android`) is clean during an ad break, everything else carries the stitched ad block. That
asymmetry is what lets the extension mint a clean source while `show_ads` is true.

## The two programs

| program | media | detector |
|---|---|---|
| content | `testsrc2`, 120 s | blue fraction < 0.2 |
| ad | solid blue, 30 s | blue fraction > 0.35 |

The screen is captured over the player's own rect at 120 px on the long side and classified by the
fraction of pixels with `B > 150 && B - max(R,G) > 80`. A 2×2 centre sample was tried first and read
the test pattern's blue bar as an ad; the fraction over the whole rect does not. The captured rect
includes the player's letterbox bars, which is why a full-screen ad reads 0.56 rather than 1.0.

## Playlist rules that cost a run each to learn

- **One `#EXT-X-MAP` at the window head, no per-segment discontinuity.** A `DISCONTINUITY` + `MAP`
  before every segment makes hls.js anchor the live window at its first fragment.
- **The window is shorter than the media program.** A window that wraps past the program repeats one
  file URI inside a single playlist, and hls.js dedupes fragments by URL; the playhead then drains to
  `readyState 2`.
- **The ad window slides with the pod.** A static all-ad playlist never grows, so every refresh is
  deduped and the native element sits at `ct 0`.
- **Nothing is published ahead of the wall clock.** This file used to justify a segment declared as
  in-flight (`EXTINF = 0.8 × segment`) with "a live origin publishes a segment before it finishes
  producing it". That is not what a live origin does: a fragment appears in the playlist when it is
  complete, with its full duration (measured 2026-11-26 on `twitch.tv/buzzyi_`: 14 × `#EXTINF:2.000,live`,
  `TARGETDURATION:6`). The shortcut was there so the forward buffer would clear the extension's 3 s gate,
  which made the fixture unable to report that gate's cost. `KO_REPLICA_EDGE_AHEAD=N` re-adds it as an
  explicitly labelled knob; measured runs keep it at 0.
- **The measured `TARGETDURATION` and the window length are one decision, not two.** Advertising
  `TARGETDURATION:6` with a **13**-segment (26 s) window broke `dev-preroll-hold` at
  `pixel at 20000 is not the ad` while the same scenario passed with `KO_REPLICA_TARGET=2`. The clean
  frame (`hls.js`, `liveSyncDuration:3`) refreshes a live playlist on a cadence derived from the target
  duration (up to 3 s at 6) while the window advances a 2 s segment every 2 s, so it reached the
  published end and drained (`hold 0.04`, `rs 2` across two samples) on the way to a reveal. Twitch's own
  playlists list **14** segments; with `KO_REPLICA_WINDOW=14` the same scenario is
  `RESULT PASS checks=12 failed=0` at the measured `TARGETDURATION:6`. Both are env knobs
  (`KO_REPLICA_TARGET`, `KO_REPLICA_WINDOW`) so the A/B is reproducible instead of a comment.

### What the comparison says today (2026-11-26, `rodil`, 100 s)

`RESULT DIVERGE 1/12 (intentional 1, scenario 3)`; the remaining red is the OBSERVER
(`fetchedBy real=both replica=page`: the replica server sees an HTTP request and cannot attribute it to
a CDP target, which the reader refuses as `CANNOT-MEASURE` once the capture carries
`dom.source=replica-server`). A `report.json` side refuses `fetchedBy` too, for a different reason: the
extension's ring has no page-fetch event (`page-playlist`/`fetch-playlist` exist nowhere in
`kick-overlay/*.js`), so it can only ever say `worker`, and MEASURED 2026-11-26 that reader reported
`DIVERGE fetchedBy` (`real=both`, `report=worker`) for a page that fetched exactly what the CDP capture
showed. Two dimensions are `CANNOT-MEASURE` for the same reason: this window
served no ad, so `adDiscontinuity` and the pod's own length (`adWindow`) have nothing to compare.

## Measured against the real page

Two tools make "is the replica faithful" a printed table instead of an opinion:

```
node _tools/ko-real-capture.mjs --port 9446 --url https://www.twitch.tv/<channel> --seconds 90 \
  --out G:/Temp/ko-replica/real/<stamp>/capture.json      # real guest Chrome, never 9222/9333

node _tools/ko-real-capture.mjs --port 9446 --url https://www.twitch.tv/<channel> --seconds 100 \
  --navigate --out .../capture.json                       # record the LOAD: a preroll pod lands here
node _tools/ko-replica/compare.mjs --real <capture.json> --replica <capture.json|report.json>

node _tools/ko-real-capture.mjs --summarize <capture.json>  # re-analyse a SAVED capture: no Chrome,
                                                           # no network, same bodies, seconds
```

`--summarize` exists because the classifier is part of the instrument: when it was wrong (2026-11-26,
`rodil`, `non-live-titles=0 ad-segments=1562` on one line, ledger `KO-20261126-07`), the only honest
way to prove the fix was to re-read the SAME 114 playlists. Ad media is a segment TITLE (the contract
`twitch-adblock.js:4876` uses, `,live` means content); an `#EXT-X-DATERANGE` marker is reported as
`ad-markers` and never turns a `,live` segment into an ad one, because Twitch writes a
`twitch-trigger` row on every playlist of a channel that runs ads and its base64 `TRIGGER-URL` contains
`ad` by chance.

`compare.mjs` prints one line per dimension and exits 0/1/2:

| verdict | meaning | decides the exit code |
|---|---|---|
| `SAME` | both sides agree on the value | no |
| `DIVERGE` | a fidelity difference that is a defect | **yes (exit 1)** |
| `ACCEPTED` | the named intentional divergence (the fMP4 tag set) | no |
| `SCENARIO` | a property of the fixture, not a target: the rung ladder, the unsigned token query | no |
| `CANNOT-MEASURE` | one side has no population for the dimension (e.g. a window with no ad), naming which side | yes (exit 2) when no `DIVERGE` exists |

A `NOTE` line carries measurements that are not verdicts (page geometry, records ignored because a
capture predates the playlist-only filter). `node _tools/ko-replica/compare.mjs --selftest` drives 11
fixture cases, including "a tag diff that is not in the intentional list still `DIVERGE`s" and "a window
with no ad is `CANNOT-MEASURE`, not `false`". The replica side of a comparison comes from
`run.mjs --capture-out`, which merges the served playlists with that run's browser samples after the
server exits (its own 500 ms flush otherwise overwrites the merge).
`node _tools/ko-replica/compare.mjs --selftest` drives nine fixture cases, including "a tag diff that is
not in the intentional list still DIVERGEs". The replica side of a comparison comes from
`run.mjs --capture-out`, which merges the served playlists with that run's DOM samples.

What the real page actually sends (measured 2026-11-26: `twitch.tv/buzzyi_`, 13 media playlists and
one master; then `twitch.tv/rodil`, 107 media playlists and 3 masters in a 100 s window with
`player=twitch`):

| field | real Twitch | this replica |
|---|---|---|
| media `#EXT-X-VERSION` | `3` | `7` (needs 6+ for `EXT-X-MAP`) |
| `#EXT-X-TARGETDURATION` | `6`, segments `2.000` | `6`, segments `2.000` (same) |
| segment container | MPEG-TS `.ts`, no `#EXT-X-MAP` | fMP4 `.m4s` + one `#EXT-X-MAP` |
| `#EXTINF` title | `,live` for content | `,live` for content, empty for ad segments (same classifier) |
| `#EXT-X-PROGRAM-DATE-TIME` | one before EVERY segment (182/182) | same |
| `#EXT-X-TWITCH-LIVE-SEQUENCE` / `-ELAPSED-SECS` / `-TOTAL-SECS` | present | present |
| `#EXT-X-DATERANGE` | `timestamp`, `twitch-session`, `twitch-stream-source` | same three, plus `twitch-stitched-ad` inside a pod |
| `#EXT-X-TWITCH-PREFETCH` | 2 per playlist on the playlists the worker fetches, NONE on the one the page fetches | 2 per playlist on every media playlist |
| `#EXT-X-DATERANGE` classes on `rodil` | `timestamp`, `twitch-session`, `twitch-stream-source`, `twitch-trigger` (carries the ad trigger URL) | the first three plus `twitch-stitched-ad`; no `twitch-trigger` |
| master ladder | depends on the broadcaster's transcode settings (`rodil`: `630000/640x360`, `230000/284x160`, `160000/…`) | fixed `720/480/360` rungs, so `ladder` and `masterVariants` DIVERGE on any channel whose ladder differs |
| master | no `#EXT-X-VERSION`, `#EXT-X-SESSION-DATA` block, variants `720p60`-style with `FRAME-RATE`/`SCORE`/`STABLE-VARIANT-ID`/`IVS-NAME` | same shape |

TWO DIVERGENCES ARE INTENTIONAL, and each has a reason that is about the product, not about effort:

- **fMP4 instead of MPEG-TS.** `page/player-worker.js` appends fMP4 into `MediaSource` and skips any
  segment that has no init (`if (!it.map) continue`). Switching the fixture to TS would mean writing a
  transmuxer inside the worker, and the extension reads playlist TEXT only (`#EXTINF` titles and the
  stitched-ad markers, `twitch-adblock.js:4876-4882`) , never the container. The divergence is visible
  to `compare.mjs` and named here instead of being hidden.
- **`#EXT-X-VERSION:7`.** `EXT-X-MAP` requires 6+; Twitch's own TS playlists send 3. No consumer of the
  replica reads this tag.
- **A fixed 720/480/360 ladder.** Twitch's rungs are the broadcaster's transcode output (`rodil`
  served `640x360`, `284x160`, `160k`), so `ladder` and `masterVariants` diverge on every capture whose
  channel does not happen to transcode to our three rungs. The replica needs more than one rung (the
  360p-reveal defect is only observable with a ladder), and the rungs are a scenario property, not a
  fidelity claim.
- **`#EXT-X-TWITCH-PREFETCH` on every media playlist.** Measured 2026-11-26: the playlists the player
  worker fetches carry two prefetch rows, the one the page fetches carries none. The replica emits two
  uniformly; no consumer of the replica reads prefetch rows (they exist so a diff can see the tag).

NOT MEASURED YET: the `#EXTINF` title Twitch puts on a **stitched ad** segment. Three capture windows
(`buzzyi_` 2026-11-26, `rodil` 2026-11-26 twice) served no pod, so 1551 of 1551 `#EXTINF` lines were
`,live`; `compare.mjs` reports `adDiscontinuity` as `CANNOT-MEASURE ... no ad media in the captured
window` instead of inventing a `false`. Until a window serves an ad, whether `adExtinf` on the real page
is counted by title or by position stays a `CANNOT-MEASURE`; the replica's ad segments carry an empty
title, which the extension's classifier reads as "not `,live`".

## Running

```
KO_REPLICA_SEG=2 KO_REPLICA_MEDIA=G:/Temp/ko-replica/media \
  node _tools/ko-replica/run.mjs --scenario _tools/ko-replica/scenarios/dev-preroll-hold.json --replica-port 8443
```

Options: `--guest-port` (9446), `--replica-port` (8443), `--no-ext` (loads no extension: the negative
arm), `--keep-guest`, `--out`, `--capture-out <path>`. Every run writes `report.json` under
`G:/Temp/ko-replica/runs/<name>-<ts>/` with the samples, the ring rows of that page load, and one
verdict per check.

`--capture-out` writes every playlist body the replica served in the same shape
`_tools/ko-real-capture.mjs` emits (one entry per `host+path+query`, capped, rewritten at most twice a
second), so the offline page and a real page are compared by the same reader:

```
node _tools/ko-replica/run.mjs --scenario _tools/ko-replica/scenarios/dev-preroll-hold.json \
  --capture-out G:/Temp/ko-replica/captures/replica-preroll.json
node _tools/ko-replica/compare.mjs --real G:/Temp/ko-replica/real/<stamp>/capture.json \
  --replica G:/Temp/ko-replica/captures/replica-preroll.json
```

A capture that writes nothing is a failure, not an empty success: a missing parent directory prints
`capture-dir-failed`, a failed write prints `capture-write-failed` once, and the first pilot proved the
need (a full scenario ran to `RESULT PASS` with no file because a bare `catch` swallowed `ENOENT`).

A run takes ~60–120 s: server start, one guest Chrome on a profile unique to the run (deleted on exit),
one page load, then the scenario's samples.

`node _tools/ko-replica/run.mjs` without `--scenario` runs `dev-baseline.json`. `--help` is not
implemented: it executes the baseline.

## Scenarios

| file | shape | asserts |
|---|---|---|
| `dev-baseline.json` | no ad | page loads, player plays content |
| `dev-preroll-hold.json` | all-ad preroll 0.3–14.3 s | the ad is covered from 4 s, the pod ends, hand-back |
| `dev-midroll-hold.json` | stitched midroll at 10 s for 14 s | the picture stays the stream, the pod ends, hand-back |
| `dev-timeline-probe.json` | 16 ct/blue samples at 2 s steps over 32 s, no expectations | fixture sanity: wall-clock paced timeline (`--no-ext`) |
| `dev-handback-wait.json` | midroll 10-24 s; native-only segment refusal (init + 1 segment, then 503 to 30 s) | `handback-wait {rs:2}` -> `handback-ready {why:'cap'}` with a clean content picture, no reload |

Checks are `row`, `absent`, `within`, `noReload`, `probe`, `pixelBlue`, `pixelNotBlue`, `pixelDark`,
`rowsAtMost`, `rowField` (`op` is `lt`, `in`, or `eq`) and `coverDuring` (a clean, non-blue sample
within the wait-to-ready window, `at` can be an array). A failure is a product finding when the
fixture's own preconditions (worker playlist observed, standby minted, hold taken) pass; those
preconditions are checks of their own so a broken fixture cannot read as a broken extension.

The `stall` knob takes `on:'native' | 'content' | 'all'` (default `all`), `atMs`, `ms`, and
`allowFirst`. With `on:'native'` the edge answers ONLY the first `allowFirst` native segment
requests (init + one 2 s fragment in `dev-handback-wait`), then refuses native media with 503 for
the window. Clean iframe requests use `clean_`-prefixed URIs and are never refused, so the picture
on screen stays real. `all`/`content` delay responses until the window ends instead. Both surfaces
are reported separately as `stallNative`/`stallClean` in `/__ko/state`.

`dev-timeline-probe.json` is the permanent fixture-sanity scenario: 16 samples at 2 s steps over
32 s with `--no-ext` and no expectations. It measures the page's own `<video>` timeline against the
wall clock (`ct` must grow ~2 s per sample, with no jump above 3 s) and the program on screen (ad
blue >0.35 through 16 s, content <0.2 from 18 s). Its `CONTROL-PASS` is vacuous by design: with zero
pixel expectations it only says no check failed, never that the product is healthy. Trust the
fixture only after THREE consecutive clean runs (one initial plus two repeats); if a jump appears
in any run, chase it through the worker ticks and the server playlist window before using any
product result from this fixture.
Each SAMPLE line prints `wall=` (actual ms since navigation) and `pxMs=` (sample cost). A `ct` jump
that matches a `wall` jump is a stalled sampler, not a media jump (measured 2026-11-25: an ffmpeg
spawn per pixel stalled 7-17 s; PNGs are now decoded in-process).

## Store

Everything lives under `G:/Temp/ko-replica` (never on `I:`, which is the SMR spindle):

| path | what | retention |
|---|---|---|
| `certs/` | self-signed cert + key, 3 KB | kept |
| `media/`, `media6/` | generated content + ad segments, ~29 MB each | kept, regenerated only when the ffmpeg signature changes |
| `profiles/run-<ts>/` | one Chrome profile per run, ~7 MB | the exiting run deletes its own exact path; whatever Chrome still holds is reaped by the next run's sweep (any `run-*` older than 60 s, one path at a time, refusals named). Measured 2026-11-25: a 2 h threshold left 117 MB of dead profiles behind and the census went 0.33 -> 0.44 GiB against a 0.40 ceiling, so the threshold is a minute and the sweep is the durable mechanism, not the exit hook. |
| `runs/` | one report per run | kept |

Census (the repo's own instrument, which is the only admissible measurement here):

```
python I:/!watcher/tools/artifact-census.py --project I:/kicktwitchyoutube_instagram \
  --own "G:/Temp/ko-harness*" --own "G:/Temp/ko-scratch*" --own "G:/Temp/ko-replica*" --budget-gib 0.4 --gate
```

## Limits, stated

- One variant, one fixed bitrate: quality switching is not exercised.
- `#EXT-X-START` and `EXT-X-PLAYLIST-TYPE:EVENT` are both ignored by the bundled hls.js
  (no `EXT-X-START` string in `kick-overlay/hls/hls.min.js`); the join position is always
  `edge − liveSyncDuration`.
- The kick layer never mounts (kick answers 404), so these scenarios measure the ad path, not the
  cross-platform swap.
- Nothing here proves the product on the owner's machine, and it is not a substitute for that: the
  extension's own gate plus a live run stay the reference.
