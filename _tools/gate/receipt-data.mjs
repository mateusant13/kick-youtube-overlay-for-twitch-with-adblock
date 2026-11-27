// The receipt's prose: the installed build, what this static gate does NOT
// measure, and the live numbers that were measured elsewhere. Extracted
// byte-for-byte from the pre-refactor gate; `installedVersion(ROOT)` reads the
// manifest at receipt time so a receipt can never claim a version nobody shipped.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function installedVersion(ROOT) {
  try {
    const m = JSON.parse(readFileSync(path.join(ROOT, 'kick-overlay', 'manifest.json'), 'utf8'));
    return String(m.version || 'unknown');
  } catch { return 'unknown'; }
}
export function notMeasured(ROOT) {
  return [
  'A Twitch-served ad that actually paints, on the owner own Chrome, across repeated runs and channels: the only way to time a real cold preroll and to confirm the cover against production timing. Measured 2026-10-26: 5 ad-net requests and 0 visible-ad samples over 150 s on live Caedrel, so no pod existed to time. The cold-cover branch is proven by the fixture suite with an injected ad-hold (kick-overlay/cold-cover-fixture-test.cjs, arms regenerated in _evidence/KO-20261023-01-arms.md), which asserts the hold freezes the picture and never hides the native; _evidence/KO-20261023-01-reachability.txt recorded the older contract that KO-20261107-05 demoted (the black screen), so it is not proof of the shipped branch. That is a different claim from a real pod.',
  'KO-20261026-04 behaviour on youtube.com itself: the guest profile is served a YouTube login/bot check, so the guard was proven on a real Twitch watch page through the shared page-player resume path. Confirming it on the owner own YouTube session needs his Chrome.',
  // The version is read from the manifest, never written here: this line said
  // 0.8.43 while the installed build was 0.8.52, which is the same stale-claim
  // defect the receipt exists to prevent.
  `The installed ${installedVersion(ROOT)} build in the owner Chrome while he watches a real pod: unit, gate and guest-Chrome evidence exist, the owner own live session has not been observed for it yet.`,
  ];
}
// Measured on a live channel, not in this static gate: the numbers come from
// runs recorded here so the receipt stops claiming they were never taken.
export const MEASURED_LIVE = [
  'Heavy `ko-harness.mjs check` suite, 0.8.42, guest Chrome, live channel twitch.tv/n3on (38,305 viewers at discovery): PASS 20, FAIL 1, 71,436 ms. The one failure is `adblock.native-twitch` (native Twitch <video> paused=false rs=0). Re-measured by hand: with the overlay disabled the native video stayed rs=0 / duration null for 24 s on n3on, while the control on twitch.tv/rodil with the overlay disabled played (rs=4, currentTime 13.58 -> 18.49). Native playback for that channel does not start in this profile, with or without the extension; not an overlay defect.',
  'KO-20261026-01 (routes), owner Chrome 0.8.42, live twitch.tv/n3on, real clicks on Clips and Videos: /n3on/clips covered 0 of 22 sampled frames, /n3on/videos covered 0 of 22, back on /n3on covered 32 of 32; Kick layer state null -> Ready. The overlay no longer survives a non-root channel route and returns on the root channel.',
  'KO-20261026-02 (YouTube player=kick black box), owner Chrome 0.8.42: youtube.com/watch?v=0sfDth4lMLc with `ko.v2.player=kick` mapped to live Kick `n3on`. Wrap `ko-kick ko-placed`, firstWrapMs 25, firstPlayingMs 8,856, states null -> Buffering -> Playing, everPlayed true. Player region sampled twice from screenshots: run A mean luminance 35.3 / sd 52.1 / 54.6 % dark, run B mean 34.8 / sd 50.5 / 53.6 % dark, picture moved between samples. A black box would be mean ~0 with sd ~0; this is a playing picture.',
  'KO-20261026-02 long run (stability), owner Chrome 0.8.42, live Kick layer on twitch.tv/n3on, 20 minutes: 120 samples, states {"Playing":120}, playingPct 100, remounts 0, frameSeq [1], single player URL, errors 0, hls events 0, heap 208 -> 76 MB (max 208), no page exceptions; only benign Twitch GraphQL console errors.',
  'KO-20261026-03 (mute across a pod), owner Chrome 0.8.42, live twitch.tv/Caedrel with the native player really playing (rs=4, ct 141.1 s), reveal driven through the real `startAdOverlay` -> healthy gate -> `revealOverlay` path via `stats.testOverlay(<live kick hls>)`. Arm muted: `overlay-reveal` 30,153 ms (reason `playing`), `reveal-muted` 30,158 / 31,100 / 32,094 ms, zero `unmute-ok`, badge "sem anúncio · 1080p · clique para som", revealed frame muted=true rs=4 t=31 s. Arm unmuted: `overlay-reveal` 25,692 ms, `unmute-ok` 27,202 ms, no `reveal-muted`, badge "sem anúncio · 1080p", revealed frame muted=false rs=4 t=32.2 s. Two earlier runs reproduced the same split.',
  'Ad-path wall measured, same channel, 150 s, 141 samples: 5 `ad-net` requests, 0 samples with a visible ad (getBoundingClientRect + computed style + ad label text), 0 native pauses, 0 `cold-cover`, 0 `overlay-reveal`, worker rewriting the playlist to `index-muted-*.m3u8`. Twitch is not painting ads in this profile right now, so a cold preroll could not be timed on a real pod.',
];
