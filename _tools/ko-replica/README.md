# ko-replica — offline Twitch watch page for the ad path

A deterministic local stand-in for `twitch.tv/<channel>` so the real `kick-overlay` extension can be
measured end to end without an account, a live channel, an ad spend, or the owner's browser.

It is not a mock of the extension. The extension is loaded from `kick-overlay/` unchanged, and it sees
what it sees on Twitch: an HTTPS GQL endpoint returning a playback access token, a master playlist, a
media playlist with an ad block inside a live window, and a page whose player runs in a blob worker
with `MediaSourceHandle`.

## What is impersonated

| surface | how |
|---|---|
| `www.twitch.tv/<channel>` | served over HTTPS from this process |
| `gql.twitch.tv` | `streamPlaybackAccessToken` with a signed token, field-compatible with the client |
| `usher.ttvnw.net` / `video-edge-a.playlist.ttvnw.net` | master + live media playlists, one variant |
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
- **The newest listed segment is declared as in-flight** (`EXTINF = 0.8 × segment` while the file holds
  the whole fragment). A live origin publishes a segment before it finishes producing it, and that lag
  is the only reason a player's forward buffer clears the extension's 3 s gate. Without it `buffered`
  reads exactly `liveSyncDuration − ε` (measured 2.86–2.95 s) forever.

## Running

```
KO_REPLICA_SEG=2 KO_REPLICA_MEDIA=G:/Temp/ko-replica/media \
  node _tools/ko-replica/run.mjs --scenario _tools/ko-replica/scenarios/dev-preroll-hold.json --replica-port 8443
```

Options: `--guest-port` (9446), `--replica-port` (8443), `--no-ext` (loads no extension: the negative
arm), `--keep-guest`, `--out`. Every run writes `report.json` under `G:/Temp/ko-replica/runs/<name>-<ts>/`
with the samples, the ring rows of that page load, and one verdict per check.

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

Checks are `row`, `absent`, `within`, `noReload`, `probe`, `pixelBlue`, `pixelNotBlue`, `pixelDark`,
`rowsAtMost`. A failure is a product finding when the fixture's own preconditions (worker playlist
observed, standby minted, hold taken) pass; those preconditions are checks of their own so a broken
fixture cannot read as a broken extension.

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
| `profiles/run-<ts>/` | one Chrome profile per run | deleted by exact path at exit |
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
