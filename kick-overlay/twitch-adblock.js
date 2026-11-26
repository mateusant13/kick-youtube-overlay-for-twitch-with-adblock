'use strict';
// Twitch SSAI adblock (MAIN world, document_start).
//
// How Twitch ads work (measured 2026-10-20, Chrome 155 / Twitch v2 HLS):
//  - The page mints a PlaybackAccessToken through gql.twitch.tv, then asks
//    usher.ttvnw.net/api/v2/channel/hls/<channel>.m3u8 for the master.
//  - The player itself runs in a blob:https://www.twitch.tv worker, which
//    fetches the media playlists. Ads are stitched INTO those playlists
//    (CLASS="twitch-stitched-ad" / X-TV-TWITCH-AD-URL / #EXTINF without
//    ",live"), so blocking domains or segments by URL cannot work.
//  - The player type embedded in the token decides ad eligibility. Measured
//    on this IP: playerType "embed" produced stitched midroll ads, while
//    "popout" served the same channel clean. This is the modern VAFT/
//    TTV LOL PRO idea without an external proxy: force the clean player type
//    at token-mint time, then strip any stitched ad blocks that still leak.
//
// Two layers:
//  1. GQL request rewrite (primary): any PlaybackAccessToken body gets
//     variables.playerType = "popout". Works for the page's token request
//     and for XHR transports.
//  2. Worker wrapper (fallback): Twitch's blob worker is re-created with a
//     tiny fetch hook that (a) re-mints a popout usher master if the page
//     hook was missed and (b) removes ad segment blocks from media playlists.
//     If the wrapper cannot be built, the original worker is used unchanged.
//
// 2026-10-20: ads can arrive as an **all-ad** preroll playlist or as a
// **mixed** midroll (e.g. 51 ad segments + 1 content segment). Stripping is
// not enough: the player may already have buffered the ad. We now cover the
// native player with a separate hls.js video fed by a freshly minted clean
// master (site/web HD when available, autoplay/android 360p otherwise), hide
// and mute the native video, and uncover it after two consecutive clean
// playlists + the ad DOM clears. `ALL_AD_FALLBACK` stays false: feeding the
// foreign MSE into Twitch's player left it permanently paused.
// `workerPlaylistLog`/`workerDebugLog` expose what the worker actually saw
// (BroadcastChannel, scoped by a per-page id) for future diagnosis.
(() => {
  if (window.__koTwitchAdblock) return;
  window.__koTwitchAdblock = true;

  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const GQL_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
  const GQL_URL = 'https://gql.twitch.tv/gql';
  const PLAYER_TYPE = 'popout'; // clean token type; "embed" is the ad-bearing one
  // 0.8.18: platform is configurable so a clean-during-ad platform (from the
  // ad-matrix probe) can be adopted without touching the native player.
  const CLEAN_PLATFORM = 'web';
  const stats = { rewrites: 0, workerHooks: 0, workerFailures: 0 };
  window.__koTwitchAdblockStats = stats;
  // BroadcastChannel is origin-wide, so two Twitch tabs would otherwise react
  // to each other's ad events. Every worker carries this page id.
  const pageId = Math.random().toString(36).slice(2, 10);
  stats.pageId = pageId;
  let bypassChannel = null;
  // A second handle on the SAME channel: BroadcastChannel never delivers a
  // post back to the object that sent it, so the ad path needs a separate
  // poster to reach its own bypass listener (a real second handle, not a shim).
  let playlistBypassChannel = null;
  try { playlistBypassChannel = new BroadcastChannel('ko-adblock-bypass'); } catch { /* optional */ }
  // The early, honest ad signal on Twitch's current player. Playlists are
  // fetched INSIDE the player worker, so no page fetch hook sees them: the
  // replica's preroll had 14 ad-bearing `worker-playlist` rows and ZERO
  // playlist-derived `ad-hold` rows, and the ad played end to end. Carry the
  // evidence onto the page's own bypass channel, where the cooldown/ownership
  // guards already live. One pod per episode; two clean playlists close it —
  // the same streak the worker uses in its own (unreachable here) path.
  let workerRoutePodAt = 0;
  let workerRouteClean = 0;
  const WORKER_ROUTE_CLEAN_END = 2;
  const WORKER_LIVE_MEDIA = /\/v1\/playlist\/|\.playlist\.live-video\.net\//;
  function workerAdSeconds(msg) {
    const samples = Array.isArray(msg && msg.adExtinfSamples) ? msg.adExtinfSamples : [];
    let total = 0;
    for (const line of samples) {
      const m = /^#EXTINF:([0-9.]+)/.exec(String(line).replace(/\r/g, ''));
      if (m && isFinite(Number(m[1]))) total += Number(m[1]);
    }
    return total > 0 ? +total.toFixed(1) : null;
  }
  function routeWorkerPlaylist(msg) {
    // VOD segments have no ",live" and look like ads to playlistInfo(); only a
    // live media playlist can open a bypass pod.
    if (!WORKER_LIVE_MEDIA.test(String(msg.url || ''))) return;
    if (Number(msg.adExtinf) > 0 || !!msg.adOnly) {
      workerRouteClean = 0;
      if (workerRoutePodAt) return; // one pod per episode, not one per segment refresh
      workerRoutePodAt = Date.now();
      // The route can fire BEFORE the page's cold-start standby request lands,
      // and `adActive` would then suppress every later request: measured in the
      // first fixed replica run, ad-hold at 284 ms with no frame, and the first
      // standby URL only at 5163 ms. Ask for the source this pod will cover.
      if (!overlay.frame) requestStandby(0, true, 'worker-playlist');
      try {
        if (playlistBypassChannel) playlistBypassChannel.postMessage({
          type: 'ad-hold',
          page: pageId,
          from: 'worker-playlist',
          channel: pageChannel(),
          extinf: msg.extinf,
          adExtinf: msg.adExtinf,
          adOnly: !!msg.adOnly,
          hasStitched: !!msg.hasStitched,
          adSec: workerAdSeconds(msg),
          at: Date.now(),
        });
      } catch {
        /* diagnostics only */
      }
      return;
    }
    if (Number(msg.extinf) > 0 && Number(msg.adExtinf) === 0 && workerRoutePodAt) {
      if (++workerRouteClean < WORKER_ROUTE_CLEAN_END) return;
      workerRoutePodAt = 0;
      workerRouteClean = 0;
      try {
        if (playlistBypassChannel) playlistBypassChannel.postMessage({
          type: 'ad-end', page: pageId, from: 'worker-playlist', channel: pageChannel(),
          reason: 'clean-playlists', at: Date.now(),
        });
      } catch {
        /* diagnostics only */
      }
    }
  }

  // Persistent event log. The ISOLATED bridge (adblock-bridge.js) listens for
  // this DOM event and appends to chrome.storage.local['ko.adlog'] (ring
  // buffer, 500 events). Unlike console/stats, this survives a page refresh:
  // if an ad appears after a reload, the timestamps are still there next time.
  // `ms` is relative to navigation start, so content->ad delay can be read
  // directly from the log without correlating clocks.
  function adLog(ev, detail) {
    const d = Object.assign({ ms: Math.round(performance.now()) }, detail || {});
    stats.adLogCount = (stats.adLogCount || 0) + 1;
    stats.lastAdLog = { ev, d };
    try {
      document.dispatchEvent(new CustomEvent('ko-adlog', { detail: JSON.stringify({ ev, d }) }));
    } catch {
      /* bridge may not be ready very early */
    }
  }
  adLog('script-start', { href: location.href });

  // Debug channel: the player worker cannot touch page globals, so it posts
  // a compact digest of every playlist it sees. This is how we tell stitched
  // SSAI (ad lines inside the m3u8) from client-side MSE (no ad lines at all).
  // Ring-buffered; expose via window.__koTwitchAdblockStats.workerPlaylistLog.
  try {
    const debugChannel = new BroadcastChannel('ko-adblock-debug');
    debugChannel.onmessage = (ev) => {
      const msg = ev && ev.data;
      if (!msg || typeof msg !== 'object' || msg.page !== pageId) return;
      if (msg.type === 'playlist') {
        if (!Array.isArray(stats.workerPlaylistLog)) stats.workerPlaylistLog = [];
        stats.workerPlaylistLog.push(msg);
        if (stats.workerPlaylistLog.length > 40) stats.workerPlaylistLog.shift();
        stats.lastWorkerPlaylist = msg;
        if (msg.adOnly) stats.adOnlySeen = (stats.adOnlySeen || 0) + 1;
        if (msg.changed === 'adOnly->fallback') stats.fallbacks = (stats.fallbacks || 0) + 1;
        if (msg.adOnly || msg.adExtinf > 0 || msg.changed) {
          adLog('worker-playlist', {
            extinf: msg.extinf,
            adExtinf: msg.adExtinf,
            adOnly: !!msg.adOnly,
            hasStitched: !!msg.hasStitched,
            adSec: workerAdSeconds(msg),
            changed: msg.changed || null,
            url: String(msg.url || '').slice(0, 180),
          });
        }
        routeWorkerPlaylist(msg);
        return;
      }
      if (msg.type === 'debug') {
        if (!Array.isArray(stats.workerDebugLog)) stats.workerDebugLog = [];
        stats.workerDebugLog.push(msg);
        if (stats.workerDebugLog.length > 40) stats.workerDebugLog.shift();
        stats.lastWorkerDebug = msg;
        if (msg.step === 'probe.clean' && msg.detail) {
          stats.lastFallbackType = `${msg.detail.playerType}/${msg.detail.platform}`;
        }
        // Keep the durable log small: only decisions, not every probe.
        if (/^(bypass|prewarm)\./.test(String(msg.step || ''))) {
          adLog('worker-debug', { step: msg.step, detail: msg.detail || null });
        }
      }
    };
  } catch {
    /* debug channel is optional */
  }

  // ---- clean HLS overlay for ad playlists ----------------------------------
  // SSAI ads (all-ad prerolls or mixed midrolls) cannot be fixed by handing
  // the web player a different token's playlist: its MSE rejects the clean
  // autoplay profile. hls.js CAN play that profile in a separate video. Cover
  // the Twitch player with the clean stream, mute/hide the native player, and
  // remove the overlay when the worker reports content again. This never
  // touches the player's own MSE.
  // 0.8.20 fallback ladder: the proxy is still the best path (native HD), but
  // when an ad is already stitched the client can still avoid showing it by
  // covering the native player with a separate hls.js video fed by a clean
  // lower-quality stream. This is deliberately a worse experience (reduced
  // quality, no Twitch controls during the break) but it keeps the live
  // visible and never lets the ad play. The native player is restored after
  // two clean playlists.
  const AD_OVERLAY_ENABLED = true;
  // Preload one clean 360p/1080p surface while the channel is live. This is
  // the only way to make the swap effectively 0s: a second hls.js player
  // cannot share the native player's decoded frames. It costs bandwidth/CPU
  // only while the Twitch tab is visible and an ad is not already active.
  const AD_STANDBY_ENABLED = true;
  // Hybrid: on the first ad signal, jump the native player back this many
  // seconds. 5s = the user's observed ~4s content grace + 1s safety. The real
  // value is measured from ko.adlog (`ad-rewind` / `content-play`); this is
  // only the starting point.
  // The cold-path rewind was meant to hide the hls.js fetch, but on ad-heavy
  // channels it seeks the native into an unbuffered ad-only region: jynxzi
  // dropped to readyState 1 at currentTime 5 for ~9s after a 5s rewind. Keep
  // the native where Twitch left it; the clean overlay either covers or the
  // native ad stays visible.
  const AD_REWIND_SEC = 0;
  // How long a pod opened from the playlist alone may cover the native. It has
  // no page lifecycle to end it, and the measured failure was 180 s of a 360p
  // cover over an ad that lasted 3 s (owner ring 2026-11-16).
  const AD_POD_MAX_MS = 60000;
  // ---- live-time alignment (owner report 2026-11-07) ----------------------
  // Three of the four owner symptoms are one property: the clean player and
  // the native player must sit at the SAME small offset from the live edge.
  //  - "when it swaps because of an ad the live comes back several seconds" —
  //    the clean player was only pulled forward when it was 20s+ behind, so a
  //    revealed player could be 5-19s behind and never close the gap (hls.js
  //    plays at 1x). The user can drag the bar forward a few seconds and it
  //    keeps working, so a forward seek is safe: do it ourselves.
  //  - "when the ad ends there is a jump in time" — that is the same delay
  //    being corrected in one step when the native (nearer the edge) returns.
  //    Keep both surfaces at one offset and the hand-off is the same frame.
  //  - "it unpauses a paused Twitch tab" — the ad path resumed playback with
  //    no visibility and no user-intent check.
  const CLEAN_LAT_TARGET = 3; // seconds behind the live edge the clean player aims for
  const CLEAN_LAT_MAX = 8; // above this the clean player is seeked back to the edge
  // A reveal may go out at a looser offset than catch-up aims for. Keep this at
  // the pre-2026-11-07 bound: the cold-cover contract resolves inside 12 s, and
  // measuring showed a source whose live window could not be pulled under 8 s
  // held the cover past that bound (guest arm 2026-11-07T13:40Z: cold-cover at
  // 3292 ms, hand-off at 15294 ms). The catch-up below still moves the picture
  // to the edge on the next tick, so a late reveal corrects itself.
  const CLEAN_LAT_REVEAL_MAX = 20;
  // HEALTH_BUFFER_SEC is a CATCH-UP LANDING RUNWAY (see catchUpClean and
  // nudgeNativeToBuffer), not the reveal gate. It used to be the reveal floor
  // too: replica 2026-11-25 (KO_REPLICA_NO_INFLIGHT=1) measured an rs=4 player
  // decoding at 1x with hold 2.85/2.02/1.36/0.96 s against a 3 s floor, so no
  // reveal fired for the whole pod and the ad painted end to end. hls.js
  // deliberately sits liveSyncDuration behind the edge, so the forward buffer
  // OSCILLATES around that target; the gate measures progress instead.
  const HEALTH_BUFFER_SEC = 3;
  // A POD END IS NOT A LICENCE TO PUT A FROZEN ELEMENT ON SCREEN. Measured in the
  // replica 2026-11-26 (dev-preroll-hold 1795677985765, 0.8.121): `ad-ui-release
  // {act:'pod-end'}` at 14743 ms, `native-handoff {ct:0, se:16}` at 14747 and
  // `native-resume {rs:1}` x4 (15049, 15949, 17248, 18748) - the clean frame was
  // torn down while it was decoding (`cleanLat:6`) and the user watched a frozen
  // native for ~4 s. The clean picture stays on screen until the native can
  // actually play forward, bounded by this ceiling so a native that never
  // recovers still gets the hand-back it would have had.
  const HANDBACK_WAIT_MS = 3000;
  // A cold cover holds the picture while the clean source is still minting, so
  // it needs a hard deadline INSIDE the 12 s contract, not equal to it. Equal
  // was unpassable: the timer fired at 12000 ms and the reachability arm
  // requires resolution at <= 12000 ms, so the timer branch always measured as
  // a violation (guest run 2026-11-07T13:40Z: cold-cover 3410 ms, hand-off
  // 15294 ms, `buffered=2.450291` never reaching the 4 s reveal gate).
  // A hold that lasts longer than this is worse than the ad: at 9s the owner
  // photographed a full black page. The clean source normally reveals in
  // 1-2s; past 3s the honest move is to hand the native back (the handoff
  // seeks to the live edge, which also skips the rest of the pod).
  const COLD_COVER_BOUND_MS = 3000;
  // ONE POD PER AD BREAK. The two signals that open and close a pod disagree:
  // the playlist keeps the ad segments listed for minutes after the break
  // (`worker-playlist {adExtinf:16, extinf:17}` in the owner's 2026-11-16 ring),
  // while the page's own detector correctly reports the ad UI leaving. Measured
  // on twitch.tv/srdogg, 0.8.97: pod #1 ended at ms 25977 (`native-handoff
  // {podAgeMs:23235}`) and a playlist-derived `ad-hold` re-opened a pod 717 ms
  // later (`cold-cover {ct:22.6}`), so the native and the clean player swapped
  // the screen three times in 28 s - the "they fight" report in its 0.8.78 form.
  // After a pod ends, a hold from the playlist is refused for this window
  // UNLESS the page's own detector sees an ad right now.
  const AD_REOPEN_COOLDOWN_MS = 30000;
  // A clean-source switch aborts the load in flight; the floor must exceed the
  // time a fresh live url takes to produce frames (~10 s measured).
  const SWITCH_FLOOR_MS = 12000;
  const RESUME_GAP_SEC = 1.5; // a smaller native/clean difference is not worth a seek
  // How long a reveal waits for the frame to report the position its catch-up
  // seek aimed at. One frame report is ~1 s; past this the picture is shown
  // regardless, because a pod with no picture is worse than a late one.
  const REVEAL_AWAIT_MS = 1600;
  // A revealed frame survives a degenerate player rect this long before it is
  // taken off screen: a hover preview, a quality switch and Twitch's own player
  // rebuild all produce one, and hiding on sight blanked a picture that was on
  // screen the whole time (owner report 2026-11-13).
  // Retained only for the comment trail: the rect hide is derived from the
  // element's presence (`isConnected`), not from a timer. See positionOverlay.
  const bypassStats = {
    starts: 0,
    stops: 0,
    errors: 0,
    playing: 0,
    standbyStarts: 0,
    standbyReady: 0,
    standbyHits: 0,
    last: null,
    lastStandby: null,
  };
  stats.adBypass = bypassStats;
  const overlay = {
    frame: null,
    token: null,
    // A postMessage into a frame whose navigation has not committed yet is
    // rejected by the browser against the page's origin (`Failed to execute
    // 'postMessage' on 'DOMWindow': target origin chrome-extension://… does not
    // match https://www.twitch.tv`, measured in the owner console 2026-11-07)
    // and the command is LOST. Every command therefore waits for the frame's
    // load or for its first token-valid message.
    frameReady: false,
    queue: [],
    url: null,
    channel: null,
    video: null,
    // AUDIO. This script runs in the MAIN world, so it cannot call the audio
    // authority (ko-audio.js, extension world) directly: the DERIVED state
    // arrives as the data-ko-audio-m / data-ko-audio-v attributes and the user's
    // intent + the "I cover the page" claim leave as string-detail events
    // (adblock-bridge.js is the other half). Two facts are kept here, both about
    // THIS frame only:
    //   audioSent    what we last told the iframe (spam/echo guard, no decision)
    //   audioRefused the browser refused audible playback on the clean frame
    //                (policy, cleared by an explicit gesture)
    // Everything that used to live here (wasMuted, wasVolume, muteIntent,
    // muteSent, autoplayMuted, muteWrite, holdWasMuted, holdVolume and the
    // per-element snapshot in hiddenVideos) was a FROZEN COPY of a value, and a
    // swap restored the copy over the user's newer decision.
    audioSent: null,
    audioRefused: false,
    // Live-time alignment + user-intent tracking (owner report 2026-11-07).
    nativeLat: 0, // native latency (edge - currentTime) captured at take-over
    holdAt: 0, // wall clock at take-over: the timeline the live edge advanced on
    holdCt: 0, // native currentTime at take-over
    // One `native-handoff` row per pod. Cleared at take-over, consumed at the
    // hand-back: a stale `holdAt` left by an earlier pod must not make every
    // later standby/ad-only/clean-stall teardown look like a hand-back.
    nativeHandoffLogged: false,
    // The pod END consumed the take-over stamp and owns the hand-back. A DOM
    // hold raised before that end can outlive it: its expiry must not resume
    // the same element a second time from a now-consumed stamp. Cleared at the
    // next take-over and when a NEW hold takes the element.
    podHandoffAt: 0,
    holdBehind: 0, // native distance behind the live edge at take-over (DVR offset)
    userDvr: false, // a take-over behind the edge by a pod-sized margin: keep the offset
    hiddenAt: 0, // wall clock when the tab went hidden
    hiddenGapMs: 0, // gap consumed by the next hand-back, never counted as freeze
    layoutSaved: null, // reversible full-size layout for a banner squeeze
    playlistPodAt: 0, // wall clock when the playlist hook opened this pod
    // The native RESTARTED its timeline during the pod. Measured in the guest
    // Chrome 2026-11-15 on a live element (twitch.tv/rodil, player=twitch): a
    // paused live <video> is EMPTIED by Twitch after ~20 s and reloads from 0,
    // i.e. at the live edge (`ct 211.8 buf 212.9` -> `ct 0 buf null rs 1`).
    // When that happens `holdCt` names a timeline Deleted and the wall-clock
    // deficit (`elapsed - advanced`) is not a deficit at all: it is the reload
    // plus the pod. His own ko.adlog 2026-11-13 has the arithmetic:
    // `native-handoff {ct:30.1, buf:42.4}` -> `native-edge-recover {behind:144.9,
    // to:172}` on an element whose whole downloaded window was 42.4 s.
    timelineReset: false,
    // ONE wall-clock recovery per pod. A usable edge can still be the pod's own
    // extent, and a retry can report a deficit the hand-back never saw. Either
    // may recover once; a second seek is the visible jump the retries were
    // split out to prevent.
    edgeRecovered: false,
    pauseBeforeAd: false, // the native was PAUSED when the pod took over
    selfPausedAt: 0, // when WE paused it (a hold is not the user parking it)
    coldPreroll: false, // ...and it had never played (page had just loaded)
    held: false,
    hiddenVideos: [],
    startedAt: 0,
    positionTimer: 0,
    lastRect: null, // last REAL player rect, kept through a degenerate tick
    smallRectSince: 0, // when the rect first went degenerate (0 = healthy)
    timeoutTimer: 0,
    lastEndAt: 0, // when the last pod ended (feeds AD_REOPEN_COOLDOWN_MS)
    extTimer: 0,
    adEndTimer: 0,
    adEndTries: 0,
    ready: false,
    autoplayRetry: false,
    playing: false,
    healthyTicks: 0,
    nudgeTries: 0,
    lastSt: null,
    lastStAt: 0,
    // Consecutive 1 Hz reports in which the clean frame said `paused`. A
    // standby that just started says it while its first segment is fetched; a
    // standby left behind by a previous pod says it for the whole pod. The
    // difference is the run length (`standbyStale()` reads this).
    standbyPausedReports: 0,
    catchupAt: 0,
    unmuteTried: false,
    audioAgreedAt: 0, // page clock when the frame's report first matched our command
    audioDisagreeSince: 0, // page clock of the FIRST report in the current disagreement streak
    audioStaleLogged: false, // the streak's lag row was already written
    audioMismatchLogged: false, // the streak's real-mismatch row was already written
    unmuteTries: 0, // bounded audible-apply retries before a refusal is declared
    unmuteCheck: 0,
    switchTries: 0,
    watchdogTimer: 0,
    stallTimer: 0,
    adoptTimer: 0,
    switchPrev: null,
    badge: null,
    unmuteHandler: null,
    onMessage: null,
    // Hybrid ad handling: on the first ad signal, rewind the native player a
    // few seconds so it replays already-buffered content while the clean
    // overlay starts. The overlay stays transparent and the native stays
    // visible until the overlay actually reports Playing (or the fallback
    // timer fires), which avoids the black frame.
    rewound: false,
    revealed: false,
    coldCover: false,
    coldTimer: 0,
    nativeHidden: false,
    hideTimer: 0,
    // Preloaded clean player. It runs muted at 1% opacity over the native
    // surface, so an ad can be covered immediately instead of paying the
    // ~1.6-2.6s HLS segment-fetch cost after ad-hold. It is not an ad until
    // adActive is set; firstframe/Playing only mark it ready while standby.
    standby: false,
    adActive: false,
  };

  // The worker owns the prewarm probes and the ad state; it posts
  // `standby-start` with a clean URL when a standby may run. This page-side
  // request asks it to re-use a fresh prewarm or probe a new one, after an ad
  // or when the tab becomes visible again. It never starts anything directly.
  let standbyRequestTimer = 0;
  let lastStandbyRequestAt = 0;
  let standbyRefusedSig = ''; // one refusal row per reason, cleared by a real request
  // ONE pod-start bypass of the 4 s mint cooldown. The worker saw the ad
  // playlist before the page's cold ask aged out (replica: ad-hold 284 ms,
  // first clean URL 5163 ms) and the DOM hold asks on the same tick. The pod
  // end clears this; no second pod counter is introduced.
  let standbyBypassAt = 0;
  let standbyBypassPod = null;
  const standbyLife = { requestAt: 0, urlAt: 0, frameAt: 0, frameLogged: false, firstStLogged: false, firstDecodedLogged: false, playLogged: false };
  function pageChannel() {
    try {
      return (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    } catch {
      return '';
    }
  }
  // ONE page-load clean-source warm, cached with the SHAPE and lifetime the
  // worker already uses for its standby: `{channel, url, at}` for PREWARM_TTL
  // (90 s, twitch-adblock.js:5204). A cold pod used to force a fresh GQL mint
  // inside the hold (3-4 s of ad on screen before the clean picture), even
  // when a finished prewarm was sitting in the worker. This cache is an
  // optimisation: every failure ends in the same forced request as before.
  const STANDBY_PREWARM_TTL_MS = 90000;
  // One mint/variant probe is bounded at 8-10 s (twitch-adblock.js:5314,
  // :5253); past 12 s a page-load warm is a failure, not a pending source.
  const STANDBY_PREWARM_WAIT_MS = 12000;
  const standbyPrewarm = { kickAt: 0, at: 0, channel: null, url: null, pending: false };
  // Forced asks that arrived while the page-load warm was still IN FLIGHT.
  // MEASURED 2026-11-26 (replica `dev-preroll-hold`, ledger KO-20261126-06): the
  // pod's forced asks fired at 284 and 303 ms while the warm resolved at 307 ms,
  // so `consumeStandbyPrewarm()` saw an empty slot 5 ms early, minted a SECOND
  // clean source, and every `standby-prewarm-used` row was absent. A parked ask
  // is served by the resolve that is already on its way - no clock is added;
  // the ONLY clock is the warm's own 12 s budget, and its timeout flushes the
  // parked asks instead of dropping them.
  const standbyPrewarmWaiters = [];
  let standbyPrewarmWaitMs = STANDBY_PREWARM_WAIT_MS;
  // How long a forced ask may ride a warm that has NOT resolved yet. MEASURED:
  // the warm resolves in 193 ms (replica 1795670018437), and one mint/variant
  // probe is bounded at 8-10 s, so a warm older than this is a failure in
  // progress, not a source about to arrive: the pod mints its own source as it
  // always did. Without this ceiling a stuck warm would hold a pod's only ask
  // for the warm's full 12 s budget - seconds of ad, for an optimisation.
  const STANDBY_PREWARM_PARK_MS = 1500;
  let standbyPrewarmTimer = 0;
  function prewarmResult(ok, why, ms) {
    adLog('standby-prewarm', { ok: !!ok, ms: Number.isFinite(ms) ? Math.round(ms) : null, why: String(why) });
    return !!ok;
  }
  function cacheStandbyPrewarm(msg) {
    const ms = standbyPrewarm.kickAt ? Date.now() - standbyPrewarm.kickAt : null;
    standbyPrewarm.pending = false;
    try { clearTimeout(standbyPrewarmTimer); } catch { /* ignore */ }
    standbyPrewarmTimer = 0;
    const ch = String(msg.channel || '').toLowerCase();
    if (!msg.url || !ch || ch !== pageChannel().toLowerCase()) {
      return prewarmResult(false, !msg.url ? 'no-url' : 'channel-changed', ms);
    }
    standbyPrewarm.channel = ch;
    standbyPrewarm.url = String(msg.url);
    standbyPrewarm.at = Date.now();
    prewarmResult(true, 'resolved', ms);
    // A parked ask waited for exactly this: hand it the source in the same
    // task the source becomes usable, so the pod never mints a second one.
    if (standbyPrewarmWaiters.length) {
      const asks = standbyPrewarmWaiters.splice(0);
      adLog('standby-prewarm-served', { asks: asks.map(String) });
      consumeStandbyPrewarm();
    }
    return true;
  }
  function consumeStandbyPrewarm() {
    if (!standbyPrewarm.url) {
      return prewarmResult(false, 'unavailable', null);
    }
    const ageMs = Date.now() - standbyPrewarm.at;
    const stale = !Number.isFinite(ageMs) || ageMs < 0 || ageMs > STANDBY_PREWARM_TTL_MS;
    if (stale || standbyPrewarm.channel !== pageChannel().toLowerCase()) {
      standbyPrewarm.url = null;
      standbyPrewarm.at = 0;
      return prewarmResult(false, stale ? 'expired' : 'channel-changed', ageMs);
    }
    const url = standbyPrewarm.url;
    const ch = standbyPrewarm.channel;
    standbyPrewarm.url = null; // single-use: the next pod must ask again
    standbyPrewarm.at = 0;
    standbyPrewarm.pending = false;
    // The second handle on this channel is how the page reaches its OWN
    // listener: BroadcastChannel never delivers a post back to its sender.
    try {
      playlistBypassChannel.postMessage({ type: 'standby-start', channel: ch, url, src: 'prewarm-cache' });
    } catch { prewarmResult(false, 'post-failed', ageMs); }
    adLog('standby-prewarm-used', { ageMs });
    return true;
  }
  function kickStandbyPrewarm() {
    if (!isChannelPath() || !pageChannel()) return prewarmResult(false, 'no-channel', 0);
    standbyPrewarm.kickAt = Date.now();
    standbyPrewarm.pending = true;
    standbyPrewarmTimer = setTimeout(() => {
      standbyPrewarmTimer = 0;
      // A resolve that already landed cleared `pending` AND this timer; a timer
      // that still runs with `pending` false is either that cleared one or a
      // replaced warm, and it must not write a timeout for a decided fate.
      if (standbyPrewarm.pending) {
        standbyPrewarm.pending = false;
        prewarmResult(false, 'timeout', Date.now() - standbyPrewarm.kickAt);
        // A parked ask must not be lost with the warm it was waiting for: it is
        // re-issued through the ordinary door, once per distinct reason.
        const asks = standbyPrewarmWaiters.splice(0);
        if (asks.length) {
          adLog('standby-prewarm-timeout-flush', { asks: asks.map(String) });
          requestStandby(0, true, asks[0]);
        }
      }
    }, standbyPrewarmWaitMs);
    requestStandby(0, false, 'prewarm');
  }
  function isChannelPath() {
    try {
      const parts = location.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return false;
      return !/^(directory|downloads|friends|gift|jobs|login|notifications|search|settings|subscriptions|inventory|wallet|drops|video|videos|p|turbo|store|legal|privacy|about|embed|popout|moderator|dashboard|creatorcamp|security|activate|signup|messages|whispers)$/i.test(parts[0]);
    } catch {
      return false;
    }
  }
  function requestStandby(delay = 1200, force = false, why = 'unspecified') {
    // A REFUSAL IS A ROW, NEVER SILENCE. Both guards below drop a request, and
    // both are decisions this ring has to be able to read: the cold boot asks
    // four times (200/1000/2500/5000 ms) and `worker-ready` asks again, so a
    // dropped ask is indistinguishable from an ask that never happened. Keyed
    // by reason (`standbyRefusedSig`, cleared when a request is really made) so
    // this is one line per transition, never one per call - the KO-20261114-02
    // class. Written INLINE at each site instead of through a helper: the
    // census reads a helper call as an exit of its own and would flag both.
    // A standby that keeps failing (offline channel, bad token) must not turn
    // into a mint/error loop. Normal requests still re-post immediately and
    // do not arm the cooldown, so recovery after an ad is not delayed.
    if (force) {
      if (consumeStandbyPrewarm()) return;
      // The warm is already in flight: minting now would run a second
      // `findCleanHlsUrl` beside one that resolves in milliseconds and then
      // throw the warm away. Park the ask; the resolve (or the warm's own
      // timeout) serves it. A row per ask, keyed by reason, so the ring can
      // tell a parked ask from an ask that never happened.
      const warmAge = standbyPrewarm.kickAt ? Date.now() - standbyPrewarm.kickAt : Infinity;
      if (standbyPrewarm.pending && warmAge <= STANDBY_PREWARM_PARK_MS) {
        const ask = String(why || 'unspecified');
        standbyPrewarmWaiters.push(ask);
        adLog('standby-prewarm-wait', { ask, pendingMs: standbyPrewarm.kickAt ? Date.now() - standbyPrewarm.kickAt : null, parked: standbyPrewarmWaiters.length });
        return;
      }
    }
    let bypassWhy = null;
    if (force) {
      const now = Date.now();
      const throttled = now - lastStandbyRequestAt < 4000;
      const canBypass = (why === 'worker-playlist' || why === 'ad-ui-hold') && standbyBypassPod === null;
      if (throttled && !canBypass) {
        if (standbyRefusedSig !== 'throttle') {
          standbyRefusedSig = 'throttle';
          adLog('standby-refused', { why: 'throttle', ask: String(why || 'unspecified'), forMs: delay, sinceMs: now - lastStandbyRequestAt, cooldownMs: 4000 });
        }
        return;
      }
      if (throttled && canBypass) {
        bypassWhy = 'pod-start';
        standbyBypassAt = now;
        standbyBypassPod = overlay.playlistPodAt || workerRoutePodAt || adUiHeldAt || now;
      }
      lastStandbyRequestAt = now;
    }
    try { clearTimeout(standbyRequestTimer); } catch { /* ignore */ }
    standbyRequestTimer = setTimeout(() => {
      standbyRequestTimer = 0;
      if (overlay.frame || overlay.held || overlay.adActive) {
        if (standbyRefusedSig !== 'busy') {
          standbyRefusedSig = 'busy';
          adLog('standby-refused', { why: 'busy', ask: String(why || 'unspecified'), forMs: delay, frame: !!overlay.frame, held: !!overlay.held, adActive: !!overlay.adActive });
        }
        return;
      }
      standbyRefusedSig = '';
      standbyLife.requestAt = Date.now();
      standbyLife.urlAt = 0;
      standbyLife.frameAt = 0;
      standbyLife.frameLogged = false;
      standbyLife.firstDecodedLogged = false;
      standbyLife.firstStLogged = false;
      standbyLife.playLogged = false;
      adLog('standby-request', Object.assign({ why: String(why || 'unspecified'), delay: Number(delay) || 0 }, bypassWhy ? { bypass: bypassWhy } : null));
      try {
        bypassChannel?.postMessage({
          type: 'standby-request',
          page: pageId,
          channel: pageChannel() || null,
          force: !!force,
        });
      } catch {
        /* overlay is optional */
      }
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (overlay.hiddenAt) {
        overlay.hiddenGapMs = Date.now() - overlay.hiddenAt;
        overlay.hiddenAt = 0;
      }
      requestStandby(0, false, 'visible');
    } else {
      overlay.hiddenAt = Date.now();
    }
  });

  // ---- THE LOG CARRIES THE ANSWER, NOT A HINT ----------------------------
  // Owner order 2026-11-12: "os logs nao devem ser hints, mas a resposta
  // inteira". Every line that matters used to say only what IT did — `{ct:468,
  // rs:1}` here, `{lat:9, pos:36}` there — and reconstructing one transition
  // took a join across a dozen events, several of which named a value without
  // the surface that owned the picture. `snap()` publishes the whole state of
  // the decision in one object, so a single line answers: which surface is on
  // screen, which one the authority believes is audible and at what volume,
  // where each element is on the timeline, and who owns playback. Attached ONLY
  // to transitions — never to the 1 Hz heartbeat, which is what makes it
  // affordable to read four elements and five attributes there.
  function snap() {
    const out = { srf: String(document.documentElement.getAttribute('data-ko-owner') || '') || null };
    try {
      const root = document.documentElement;
      out.aud = {
        owner: root.getAttribute('data-ko-owner') || '',
        m: root.getAttribute('data-ko-audio-m'),
        v: root.getAttribute('data-ko-audio-v'),
      };
    } catch { /* ignore */ }
    try {
      const v = mainVideo();
      out.nat = v
        ? {
            ct: +Number(v.currentTime || 0).toFixed(1),
            rs: Number(v.readyState || 0),
            paused: !!v.paused,
            buf: v.buffered && v.buffered.length ? +Number(v.buffered.end(v.buffered.length - 1)).toFixed(1) : null,
            se: v.seekable && v.seekable.length ? +Number(v.seekable.end(v.seekable.length - 1)).toFixed(0) : null,
            muted: !!v.muted,
            vol: +Number(v.volume || 0).toFixed(2),
            vis: !!document.visibilityState && document.visibilityState === 'visible',
          }
        : null;
    } catch { /* ignore */ }
    const st = overlay.lastSt;
    if (st) {
      out.clean = {
        pos: +Number(st.pos || 0).toFixed(1),
        lat: +Number(st.lat || 0).toFixed(1),
        hold: Number.isFinite(Number(st.buffered)) ? +Number(st.buffered).toFixed(2) : null,
        rs: st.rs == null ? null : Number(st.rs),
        paused: !!st.paused,
        muted: !!st.muted,
        src: st.latSrc || null,
        age: overlay.lastStAt ? Math.round(Date.now() - overlay.lastStAt) : null,
      };
    }
    out.who = {
      adActive: !!overlay.adActive,
      standby: !!overlay.standby,
      revealed: !!overlay.revealed,
      playing: !!overlay.playing,
      own: overlayOwnsPlayback(),
      holdAt: overlay.holdAt ? Math.round((Date.now() - overlay.holdAt) / 100) / 10 : 0,
      holdCt: +Number(overlay.holdCt || 0).toFixed(1),
      cold: !!overlay.coldPreroll,
      parked: !!overlay.pauseBeforeAd,
    };
    return out;
  }
  stats.snap = snap;
  // `adLog(ev, snap()-merged detail)`: the transition's own fields stay, so
  // existing readers and the ledger arms keep working, and the snapshot is
  // added beside them under `st`.
  function adLogState(ev, detail) {
    let extra = null;
    try { extra = snap(); } catch { extra = null; }
    adLog(ev, Object.assign({}, detail || {}, extra ? { st: extra } : {}));
  }

  function mainVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      // A DETACHED NODE IS NOT A PLAYER. A real DOM never returns one from
      // querySelectorAll, so this is a cheap invariant rather than a branch:
      // it keeps `mainVideo()` honest for any surface that has been removed
      // from the document but still answers a stale list.
      if (v.isConnected === false) continue;
      try {
        const r = v.getBoundingClientRect();
        const area = Math.max(0, r.width) * Math.max(0, r.height);
        if (area > bestArea) {
          bestArea = area;
          best = v;
        }
      } catch {
        /* ignore */
      }
    }
    return best;
  }

  // Rewind live by a few seconds so the native player replays already-buffered
  // content instead of immediately reaching the stitched ad. Twitch's live
  // video reports duration=Infinity but currentTime is seekable in the DVR
  // window; seekable.start(0) is 0, so `currentTime - seconds` is the target.
  function rewindNative(seconds) {
    const v = mainVideo();
    if (!v) return null;
    if (v.paused || v.readyState < 2) return { skipped: 'not-playing', rs: v.readyState, paused: v.paused };
    const before = v.currentTime;
    let target = before - seconds;
    try {
      const s = v.seekable;
      if (s && s.length) {
        const start = s.start(0);
        if (Number.isFinite(start)) target = Math.max(start, target);
      }
    } catch {
      /* fall back to before-seconds */
    }
    if (!(target < before - 0.5)) return { skipped: 'no-window', before: +before.toFixed(2), target: +target.toFixed(2) };
    // The old path blindly sought 5s back. On an ad-only part of the playlist
    // that target is not buffered, and the native dropped to readyState 1 and
    // never recovered (kimkataguiri, 2026-10-23). Only rewind into data the
    // element already has; leave a live native alone otherwise.
    let buffered = false;
    try {
      const b = v.buffered;
      for (let i = 0; i < (b ? b.length : 0); i++) {
        if (target >= b.start(i) && target <= b.end(i)) buffered = true;
      }
    } catch { /* ignore */ }
    if (!buffered) return { skipped: 'no-buffer', before: +before.toFixed(2), target: +target.toFixed(2) };
    try {
      v.currentTime = target;
      return { before: +before.toFixed(2), target: +target.toFixed(2), delta: +(before - target).toFixed(2) };
    } catch {
      return { skipped: 'seek-failed', before: +before.toFixed(2), target: +target.toFixed(2) };
    }
  }
  stats.rewindNative = rewindNative;
  // Diagnostic only: start the clean overlay against an arbitrary HLS URL so
  // the surface-swap (native visible -> firstframe -> hide native) can be
  // tested without waiting for a real ad. Not used by the ad path.
  stats.testOverlay = (url) => startAdOverlay(url, 'test', false);

  // ---- live-time alignment helpers ----------------------------------------
  // The live edge of a native <video>. Twitch live reports duration=Infinity,
  // so the seekable end is the only honest "now" -- but only when it IS a
  // position. Twitch also reports `seekable.end = 1073741824` (2^30) as a
  // "live, timeline unknown" sentinel, measured in the owner's own ko.adlog on
  // 2026-11-08 (`native-handoff {se: 1073741824}`): trusting it made the
  // hand-back seek the native to 1e9 seconds, i.e. a frozen player.
  const EDGE_MAX_SEC = 1e6; // ~11.5 days of stream: beyond this it is a sentinel
  function nativeEdge(v) {
    try {
      const s = v && v.seekable;
      if (s && s.length) {
        const e = s.end(s.length - 1);
        if (!(isFinite(e) && e > 0 && e < EDGE_MAX_SEC)) return 0;
        const d = Number(v.duration);
        if (isFinite(d) && d > 0 && e > d + 1) return 0; // edge beyond the media
        return e;
      }
    } catch {
      /* not ready */
    }
    return 0;
  }
  // The newest frame the element actually holds. Safe where the live edge is a
  // sentinel: a buffered range is always a real position.
  function nativeBufferedEnd(v) {
    try {
      const b = v && v.buffered;
      if (b && b.length) {
        const e = b.end(b.length - 1);
        return isFinite(e) && e > 0 && e < EDGE_MAX_SEC ? e : 0;
      }
    } catch {
      /* not ready */
    }
    return 0;
  }
  stats.nativeEdge = nativeEdge;
  // Can this element actually land on `want`? Two honest sources say yes:
  // the media is already downloaded there (`buffered.end`), or the element is
  // at HAVE_FUTURE_DATA or better and its own network stack is fetching, which
  // is the state every healthy hand-back in the owner's logs was in when a
  // forward seek worked (`readyState 4` -> ct advanced). At `readyState 1`
  // (HAVE_METADATA only, no future data — the state Twitch leaves an element in
  // after its surface is restored) a forward seek goes nowhere: measured in his
  // ko.adlog 2026-11-12, `native-edge-recover {from:468, to:470.5}` on an
  // `rs:1` element parked it at 467 and froze the picture for ~10 s.
  // A SMALL FORWARD SEEK IS NEVER WORTH A STALL. `readyState` alone is not the
  // test: the measured freeze happened at `rs:4` with `buffered.end` EQUAL to
  // currentTime (no forward data at all), because the sentinel edge means the
  // fetch target is unknown and Twitch leaves the element at `rs:1` afterwards.
  // So the rule is about what the element can prove it holds, plus the one case
  // where the risk is worth taking: recovering a whole pod's worth of delay
  // (>= POD_RECOVER_MIN sec), which is the "deixou a live com delay múltiplas
  // vezes" report and cannot be fixed by waiting.
  const POD_RECOVER_MIN = 10;
  function seekCovered(v, want) {
    if (!v) return false;
    const from = Number(v.currentTime || 0);
    const end = nativeBufferedEnd(v);
    // LANDING ON THE LAST HALF SECOND OF DATA IS NOT LANDING. `want <= end`
    // accepted a seek to `buffered.end - 0.5`, and that is exactly what the
    // owner's ko.adlog 2026-11-12 shows three times in ONE second:
    //   native-edge-recover {behind:2.5, gap:6.8, from:18.8, to:25.6} (buf 26.1)
    //   native-resume {ct:25.6, rs:1}  video-pause {rs:1}
    //   native-catchup {gap:2, from:25.6, to:27.6} (buf 28.1)  rs:1  pause
    // The element parked at readyState 1 each time: half a second is not enough
    // media to rebuild HAVE_FUTURE_DATA after a seek, so the picture froze and
    // Twitch's own player paused — "travou ... depois destravou". The landing
    // must leave the same runway the health gate demands of the clean player.
    if (end > 0 && want <= end - HEALTH_BUFFER_SEC) return true; // room to play on
    const se = nativeEdge(v);
    if (se > 0 && want <= se - RESUME_GAP_SEC) return true; // a real edge ahead
    // The element holds NOTHING in front of the playhead and has not reached
    // HAVE_FUTURE_DATA: a forward seek there parks it at readyState 1 and Twitch
    // only recovers by rebuilding the source. Measured in the owner's ko.adlog
    // 2026-11-12: `native-handoff {buf:468, ct:468}` -> `native-edge-recover
    // {from:468, to:470.5}` left the element at 467/rs:1 and the picture froze
    // for seven seconds ("travou por uns 7 segundos"). Doing nothing IS the
    // recovery: the element keeps its position and Twitch refills from the edge.
    // Below HAVE_FUTURE_DATA (the state a restored surface is left in) a seek
    // past the playhead parks the element: measured `video-pause {rs:1}` for
    // seven seconds in the reported episode. At HAVE_FUTURE_DATA or better the
    // element IS fetching, and a forward seek there is how the 2026-11-11
    // "deixou a live com delay multiplas vezes" case gets its pod's duration
    // back — worth it even past the downloaded data.
    if (Number(v.readyState || 0) < 3) return false;
    // ...and past the downloaded data only for a POD-SIZED recovery. The
    // previous `return true` here accepted ANY forward seek at rs>=3, which is
    // the shape his 2026-11-12 log punished: `native-edge-recover to 25.6` with
    // `buffered.end` 26.1 (0.5 s of runway) parked the element at rs:1, then
    // `native-catchup to 27.6` with 28.1 parked it again — twice in one second
    // under a picture that had already stalled.
    //
    // AND THE ASK IS NOT THE LANDING. Measured in the owner's own ring
    // 2026-11-16 (0.8.95, twitch.tv/iolkaida, the pod he described):
    //   native-edge-recover {behind:22.4, from:23.4, to:39.7, gap:16.3, edge:"buffered"}
    //   native-resume       {ct:39.7, rs:1, selfPaused:22.4}  video-pause {rs:1}
    // `buffered.end` was 42.3, so the landing left 2.6 s of runway: below
    // HEALTH_BUFFER_SEC, i.e. the exact stall this function exists to refuse,
    // admitted because the DISTANCE was pod-sized. A pod-sized ask may only be
    // accepted when the element holds enough media to land this side of the
    // frontier, because `resumeNative` clamps the target to that landing. The
    // remaining deficit is closed by the next hand-back, when Twitch has
    // downloaded more — a picture that plays at 3 s behind is the product; a
    // picture parked at rs:1 until the user clicks pause/unpause is not.
    return want - from >= POD_RECOVER_MIN && end > 0 && end - from >= HEALTH_BUFFER_SEC + RESUME_GAP_SEC;
  }
  stats.seekCovered = seekCovered;
  function nativeLatency(v) {
    const e = nativeEdge(v);
    if (!(e > 0)) return 0;
    return Math.max(0, e - Number(v.currentTime || 0));
  }
  // The offset the clean player aims for. Taken from the native player at
  // take-over, so the swap and the hand-back land on the same wall-clock
  // second the user was already watching. Falls back to the bridge's own
  // liveSyncDuration target.
  function cleanLatTarget() {
    // A cold preroll never played, so the native's own offset (the whole live
    // DVR, potentially hundreds of seconds) carries no meaning: aim at the
    // bridge's own live-sync target instead.
    if (overlay.coldPreroll) return CLEAN_LAT_TARGET;
    const n = Number(overlay.nativeLat);
    // Adopting the native's offset is what keeps the swap continuous, but an
    // 8s ceiling on the ADOPTION hands the user an 8s-delayed picture for the
    // whole pod ("a live volta vários segundos", owner 2026-11-08). Match the
    // native within one second of the clean player's own target and let the
    // catch-up close the rest.
    if (isFinite(n) && n > 0) return Math.min(CLEAN_LAT_TARGET + 1, Math.max(CLEAN_LAT_TARGET - 1, n));
    return CLEAN_LAT_TARGET;
  }
  // The offset the NATIVE must come back at, in the same unit (distance from
  // its own live edge): the offset the clean player was actually showing on the
  // tick the ad ended. `cleanLatTarget()` alone is the offset captured at
  // take-over, so a clean player that had drifted (or a pod that started from a
  // native 8s behind) made the hand-back jump relative to the picture the user
  // was watching — the "salto no tempo" half of his report.
  function cleanHandoffLat() {
    const st = overlay.lastSt;
    const lat = st ? Number(st.lat) : NaN;
    if (isFinite(lat) && lat >= 0) return Math.min(CLEAN_LAT_MAX, Math.max(CLEAN_LAT_TARGET - 1, lat));
    return cleanLatTarget();
  }
  stats.cleanHandoffLat = cleanHandoffLat;
  // Health is PROGRESS, not a forward-buffer snapshot. Two consecutive
  // heartbeats are the instrument: a decoding live frame advances ~1 s per
  // second; a stalled one repeats its position (replica: pos 15.95 twice with
  // rs=2 and 0.05 s in hand). A gap outside 0.3-4 s cannot measure progress
  // (back-to-back harness samples, or a throttled tab's sparse heartbeat), so
  // it is UNKNOWN, never a failure. A seek is not progress either: hls.js's
  // own live sync closes latency smoothly, and the next sample after the seek
  // is the one the gate judges.
  function cleanFrameAdvancing(st) {
    const prev = overlay.prevSt;
    const at = overlay.prevStAt;
    if (!prev || !at || typeof prev.pos !== 'number' || typeof st.pos !== 'number') return null;
    const gap = Date.now() - at;
    if (gap < 300 || gap > 4000) return null;
    const moved = Number(st.pos) - Number(prev.pos);
    if (!(moved >= 0)) return false; // a rewind is never evidence of health
    const expected = gap / 1000;
    return moved >= Math.min(0.25, expected * 0.5) && moved <= expected * 2 + 0.2;
  }
  // Some media ahead of the playhead must exist, but its LENGTH is not a
  // health threshold: `buffered` is the last segment boundary, not the amount
  // the decoder needs for the next frame (readyState >= 3 already says that).
  function cleanFrameHasForward(st) {
    return st.buffered === undefined || (Number.isFinite(Number(st.buffered)) && Number(st.buffered) > 0);
  }

  // A hold that ran out of time still has to leave the user on the picture
  // that was meant to be on screen. A mounted clean frame that is decoding is
  // that picture; NO gate is loosened here to get it (same rs/lat/forward-data/
  // progress requirements as the heartbeat, which also must have marked it
  // playing). Replica 2026-11-25: a hold released at ct 0.4 with a healthy
  // clean frame at pos 22.8, and the native resumed at the parked ad position.
  function cleanFrameCanCover() {
    if (!overlay.frame || !overlay.playing || !overlay.lastSt) return false;
    const st = overlay.lastSt;
    if (st.paused || (st.state && st.state !== 'Playing')) return false;
    const lat = Number(st.lat);
    const rs = Number(st.rs);
    if (!(lat >= 0) || lat > CLEAN_LAT_REVEAL_MAX) return false;
    if (!(rs >= 3) || !cleanFrameHasForward(st)) return false;
    if (cleanFrameAdvancing(st) === false) return false;
    if (overlay.prevSt && overlay.prevStAt && Date.now() - overlay.prevStAt > 2000
      && Number(st.pos) > 0 && typeof overlay.prevSt.pos === 'number'
      && Math.abs(Number(st.pos) - Number(overlay.prevSt.pos)) < 0.05) return false;
    return true;
  }
  // Freeze what is on screen without erasing it. A paused <video> keeps its
  // last decoded frame, which is why this exists: the alternative (hide the
  // video and paint a panel) is the black screen the owner reported.
  // Our own pause explains a paused element only while the hold that made it is
  // still recent: a pod can run for minutes, so the stamp is bounded rather than
  // alive forever.
  const SELF_PAUSE_TRUST_MS = 10 * 60 * 1000;
  function selfPausedRecently() {
    return !!overlay.selfPausedAt && Date.now() - overlay.selfPausedAt < SELF_PAUSE_TRUST_MS;
  }

  // The DOM tick calls adUiHold() and adUiHoldTick() back to back. The pause
  // between them is OURS, so the second half of that same tick must not name it
  // a native pause: the replica wrote `act:'paused'` and `act:'skip',
  // why:'native-paused'` in the same millisecond. Matches the 250 ms `ours`
  // window used by the pause listener, but it is its own decision.
  const AD_UI_OWN_PAUSE_MS = 250;
  function pauseNativeForHold(v) {
    try {
      if (!v || v.paused) return false;
      if (userResumedHeld()) return false; // the user unpaused during a DOM hold
      if (resumeRefusedByUser(v)) return false; // a user-parked player stays parked
      v.pause();
      overlay.selfPausedAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }
  // ONE PICTURE, ONE CLOCK. While a pod owns the screen the native element must
  // not keep playing behind the clean frame. Measured in the owner's own ring
  // (cellbit, 0.8.111): `ad-ui-hold {act:"skip", why:"pod-owns", revealed:true}`
  // for the whole pod while `ad-tick {video:{ct:260.5, paused:false, rs:4}}`
  // advanced 1x - so the element decoded the ad he reported seeing, consumed the
  // media the hand-back needed, and arrived at `native-handoff {ct:290.6,
  // buf:292.5}` with 1.9 s of runway: the forward seek was refused as "no data
  // in hand", the element parked at `rs:1` and the picture jumped 21.6 s
  // (`display-clock pos:318.51 delta:21.56`). Twitch's own ad renderer calls
  // play() again, so one pause is not a freeze; the tick re-asserts it, exactly
  // like the hold has done since 0.8.51.
  // OUR PAUSE MUST BE ATTRIBUTABLE FROM THE ISOLATED WORLD. `content.js`'s
  // stall watchdog cannot tell a page that parked its own player from a hold
  // that parked it, and it answers "a healthy parked player stays parked" -
  // which is how a hold that expired left his picture frozen (measured
  // 2026-11-24, twitch.tv/cellbit, 0.8.112: `hb {paused:true, ct:1023.3, rs:4}`
  // at the same position for 71 s after `ad-ui-hold {act:"skip",
  // why:"hold-expired", heldMs:12498}`, cured only by the page reload).
  // One attribute, written BEFORE the pause it describes so the `pause` event
  // can never be stamped with the previous value, and cleared by the 500 ms
  // tick's own derivation so no exit path can leak it.
  function markAdPark(on) {
    try {
      const root = document.documentElement;
      if (root) root.setAttribute('data-ko-adpark', on ? '1' : '0');
    } catch { /* document tearing down */ }
  }
  let adParkShown = false;
  function publishAdPark() {
    const want = !!(overlay.adActive || overlay.revealed || adUiHeldAt);
    if (want === adParkShown) return;
    adParkShown = want;
    markAdPark(want);
  }
  function freezeNativeForPod() {
    const v = mainVideo();
    if (!v || !v.isConnected) return null;
    if (userResumedHeld()) return null; // the user unpaused during a DOM hold
    // A hand-back is waiting for this element to reach HAVE_FUTURE_DATA; pausing
    // it again would make the wait impossible to satisfy (it is hidden behind
    // the clean frame for those 3 s, so nothing is audible or visible from it).
    if (overlay.handbackWait) return null;
    if (v.paused) return null;
    if (resumeRefusedByUser(v)) return null; // a user-parked player stays parked
    markAdPark(true);
    try {
      v.pause();
    } catch {
      return null;
    }
    overlay.selfPausedAt = Date.now();
    return v;
  }
  // Pull the clean player back onto the live edge. Bounded to one seek per 2s
  // so a stalling manifest cannot turn into a seek storm. This replaces the
  // old "only when 20s+ behind" gate: the picture is revealed at real time,
  // not one segment-duration behind.
  function catchUpClean(st, force) {
    if (!overlay.frame || !st) return false;
    const lat = Number(st.lat);
    const pos = Number(st.pos);
    if (!(lat >= 0) || !(pos >= 0)) return false;
    if (!force && !(lat > CLEAN_LAT_MAX)) return false;
    // The throttle exists to stop a stalling manifest turning into a seek storm,
    // never to block the ONE seek that puts a revealed picture at real time.
    // Measured in the owner's 2026-11-15 ring (0.8.92): the reveal asked for a
    // forced catch-up 0.2 s after a periodic one, the 2 s window swallowed it,
    // and `overlay-reveal` went up with `lat 6.4` on screen — his report "ao
    // trocar pro outro player, não sei se tá em tempo real".
    if (!force && overlay.catchupAt && Date.now() - overlay.catchupAt < 2000) return false;
    overlay.catchupAt = Date.now();
    const want = Math.max(0, pos + lat - cleanLatTarget());
    // Never aim past the data the element already holds. `lat` is the distance
    // to the PLAYLIST edge while `buffered` is what has actually been
    // downloaded, so `edge - target` is normally 4-5s beyond the buffer:
    // seeking there forces a download the player cannot finish before the frame
    // is due, and the measured result was `playing-not-healthy buffered≈2`
    // followed by `overlay-stall-stop` on every single catch-up (owner ko.adlog
    // 2026-11-08, four for four). The buffer end is the honest ceiling; the rest
    // of the gap belongs to hls.js's own maxLiveSyncPlaybackRate, not to a skip
    // the user sees as the picture jumping.
    const hold = Number(st.buffered);
    // NOTHING in hand means nothing to nudge: an empty-buffer player is being
    // placed by hls.js's own live sync, and seeking it to the playlist edge makes
    // it fetch a segment it has no runway for. Measured in the headless guest on
    // kaicenat 2026-11-08: `overlay-catchup {hold:0, lat:30, pos:27, to:54}` was
    // followed 2 s later by `playing-not-healthy {buffered:0.019, rs:2}` and the
    // standby never played — the clean source was dead for the whole pod.
    if (!(hold > 0)) return false;
    // THE BUFFER FRONTIER IS THE HONEST LIVE EDGE. `lat` is the distance to the
    // PLAYLIST edge (hls.js's own number, `latSrc:'hls'`); `hold` is how much
    // media is already downloaded in front of the playhead. When they are
    // equal, the newest downloaded second IS the edge and there is nothing to
    // skip to — the remaining seconds are the source's own segment cadence, not
    // a delay this code can remove. Seeking there spends the buffer and buys
    // zero latency. Measured in the owner's ko.adlog 2026-11-12 (the reported
    // episode): five catch-ups while the clean player was on screen, each one
    // `{lat:8-9, hold:8, pos:36, to:41}` -> `{pos:41, to:47}` -> `{47.5, 53}`
    // -> `{58, 63}`: the picture jumped forward 5-7 s roughly every 6 s, the
    // reported seconds never closed, and the user saw "avançou pra uma parte da
    // live que eu não sei se é tempo real". Only skip when the distance to the
    // edge EXCEEDS what is already in hand.
    // THE CEILING MUST LEAVE THE RUNWAY THE HEALTH GATE DEMANDS. It used to be
    // `pos + hold - 1`, so a standby holding 6 s that was 18.8 s behind the edge
    // seeked to `pos + 5` and had ONE second of media left. That is the same
    // starvation the ceiling was introduced to prevent (measured 2026-11-08:
    // aiming past the buffer starved the player and `overlay-stall-stop` fired
    // four for four), and it is repeated every 2 s window because `lat` never
    // closes: the owner's own 0.8.91 ko.adlog 2026-11-15 has the row
    // `overlay-catchup {hold:6, lat:18.8, pos:160, source:"standby"}` with a
    // 1 s landing. Landing `HEALTH_BUFFER_SEC` short of the frontier hands the
    // player the same 3 s of runway the reveal gate asks for, and repeating it
    // every 2 s window walks the picture to the edge (6 s of buffer, 3 s of
    // travel, 3 s in hand) instead of jumping into an empty one.
    const ceiling = pos + hold - HEALTH_BUFFER_SEC;
    const target = Math.min(want, ceiling);
    // A seek that leaves under 1.5s of buffer is worse than the drift it fixes.
    if (!(target - pos >= RESUME_GAP_SEC)) return false;
    // A REVEALED LIVE PLAYER IS NEVER NUDGED FORWARD BY THIS CODE. Two measured
    // reports agree that the forward seek never closed the reported latency and
    // only jumped the picture: 2026-11-07 (`overlay-catchup lat=20.3` firing
    // over a whole pod) and 2026-11-12, five times while the clean player was on
    // screen — `{lat:9, hold:8.98, pos:36, to:41}` -> `{41, to:47}` ->
    // `{47.5, 53}` -> `{58, 63}`, the picture jumping 5-6 s every 6 s and `lat`
    // never closing ("avancou e malguma parte da live que eu nao sei se e tempo
    // real"). The reason is structural, not incidental: in a healthy hls.js
    // live player the playhead SITS `liveSyncDuration` behind the playlist edge
    // while the buffer ends within a second of that edge (`hold - lat` ~ 0,4s in
    // both rows above), so a seek to `pos + hold - 1` lands where the player
    // already is and hls.js's own maxLiveSyncPlaybackRate pulls it back. The
    // drift is hls.js's to close, at 1.5x, smoothly. `force` (pre-reveal
    // standbys, the go-live chip) is the only caller allowed to jump.
    if (overlay.revealed && !force) return false;
    // TWO KINDS OF GAP, and only one of them is ours to close.
    //  (a) the buffer frontier is the edge (`lat - hold` ~ 0): the remaining
    //      seconds are the source's own segment cadence, and a seek to the
    //      frontier lands where the player already is — hls.js then pulls the
    //      playhead straight back to its own live position. Measured in the
    //      owner's ko.adlog 2026-11-12, five times while the clean player was
    //      ON SCREEN: `{lat:9, hold:8.98, pos:36, to:41}` -> `{41, to:47}` ->
    //      `{47.5, 53}` -> `{58, 63}`, `lat` never closing, the picture jumping
    //      5-6 s every 6 s ("avancou e malguma parte da live que eu nao sei se
    //      e tempo real"). Do not seek there.
    //  (b) there is real runway at the destination (>= HEALTH_BUFFER_SEC of
    //      buffer left after the jump), or the frontier is a genuine gap behind
    //      the edge (`lat - hold` >= 2 s, i.e. a delay the viewer can feel).
    //      Both are honest catch-ups: 2026-11-08 measured that aiming PAST the
    //      buffer starves the player, which is why the ceiling exists.
    // (The runway is guaranteed by the ceiling above: `target <= pos + hold -
    // HEALTH_BUFFER_SEC`, so a landing always keeps the health gate's runway.
    // The old `runway >= HEALTH_BUFFER_SEC || frontierGap >= 2` let a 12.8 s
    // frontier gap override a 1 s landing, which is how the owner's 0.8.91 row
    // fired: `{hold:6, lat:18.8, pos:160}`.)
    overlaySend({ t: 'seek', s: target });
    overlaySend({ t: 'play' });
    adLogState('overlay-catchup', {
      lat: +lat.toFixed(1),
      pos: +pos.toFixed(1),
      to: +target.toFixed(1),
      want: +want.toFixed(1),
      hold: isFinite(hold) ? +hold.toFixed(2) : null,
      source: overlay.standby ? 'standby' : 'ad',
    });
    return true;
  }
  stats.cleanLatTarget = cleanLatTarget;
  stats.catchUpClean = catchUpClean;

  // ---- audio, read from the authority across the world boundary ------------
  // ko-audio.js derives (muted = intent || policy || not-visible) and publishes
  // the state for THIS frame's surface as two attributes. This script applies
  // it to its own iframe and nothing else: it never writes .muted/.volume on a
  // page video, which is what two independent policies used to do to each
  // other (owner reports 2026-11-07 / 2026-11-08).
  function audioState() {
    const root = document.documentElement;
    const m = root ? root.getAttribute('data-ko-audio-m') : null;
    const v = root ? root.getAttribute('data-ko-audio-v') : null;
    return { muted: m === '1', volume: Number.isFinite(Number(v)) ? Number(v) : 1 };
  }

  // "I cover the page" / "I no longer do": the claim is what makes the native
  // surface silent while the clean player is up.
  function audioClaim(on) {
    try {
      document.dispatchEvent(new CustomEvent('ko-audio-claim', { detail: on ? 'ad' : '' }));
    } catch {
      /* ignore */
    }
  }

  // WHEN the claim is taken, and why it is not a timer. Owner correction
  // 2026-11-11: "é pra ser smooth/acontecer na hora/tempo real". A claim taken at
  // TAKE-OVER silences the page while the page is still the surface on screen -
  // his ko.adlog shows `video-emptied {targetMuted:true}` 1.08 s ahead of
  // `overlay-reveal`, and an earlier cycle with `audio-state {audible:0, vis:"ad",
  // wt:"1"}` for 8.66 s ("voltou pro player, mutado"). Bounding that silence with
  // a grace was the wrong shape: the claim belongs in revealOverlay(), in the
  // tick the clean picture appears, and in stopAdOverlay() when it leaves - so
  // the sound is never anywhere but on the surface that is showing, and there is
  // no window to bound.

  // A user gesture the authority cannot see (a click on OUR badge, inside our
  // own UI) goes up as intent.
  function audioIntent(muted, volume) {
    try {
      document.dispatchEvent(
        new CustomEvent('ko-audio-intent', {
          detail: JSON.stringify({ muted: !!muted, volume: Number(volume) }),
        }),
      );
    } catch {
      /* ignore */
    }
  }

  // ONE writer for the clean frame, diffed against what it was last told.
  function applyOverlayAudio() {
    if (!overlay.frame) return;
    const a = audioState();
    const muted = !!(a.muted || overlay.audioRefused);
    const volume = a.volume;
    const last = overlay.audioSent;
    if (last && last.muted === muted && Math.abs(last.volume - volume) < 0.02) return;
    overlay.audioSent = { muted, volume };
    overlay.audioSentAt = Date.now();
    overlay.audioAgreedAt = 0; // a new command restarts the "how long until the frame agrees" clock
    overlay.audioSends = (overlay.audioSends || 0) + 1;
    adLogState('overlay-audio', { muted, volume: +Number(volume).toFixed(2), refused: !!overlay.audioRefused });
    overlaySend({ t: 'mute', m: muted });
    overlaySend({ t: 'volume', v: volume });
  }

  // The authority republishes the attributes on every change; a fresh frame
  // must also be told, so the observer drives both.
  try {
    const mo = new MutationObserver((records) => {
      let ownerChanged = false;
      for (const r of records || []) {
        if (r && r.attributeName === 'data-ko-owner') ownerChanged = true;
      }
      if (ownerChanged && overlayOwnsPlayback()) {
        // The user switched to the overlay player (or the page booted in that
        // mode and the attribute arrived after the first standby): EVERYTHING
        // this path owns leaves in the same tick - the cover, the claim, and the
        // standby player, which measured `paused:false, h:360` while the kick
        // layer owned the page (2026-11-11, the "fica a 360p" half of the owner's
        // report). A standby is a whole second player: it is not free.
        if (overlay.adActive || overlay.standby || overlay.frame) stopAdOverlay('overlay-owns');
        return;
      }
      applyOverlayAudio();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ko-audio-m', 'data-ko-audio-v', 'data-ko-owner'] });
    overlay.audioObserver = mo;
  } catch {
    /* document may be unavailable very early */
  }

  // The notice panel is a FUNCTION of state, never a flag. Owner report
  // 2026-11-09: "sem anuncio carregando a live" stayed on the normal stream the
  // whole session out of fullscreen (fullscreen only masked it). Three exits
  // cleared overlay.coldCover without ever un-painting the element, and the
  // early return below (video smaller than 40px, or a player that went away)
  // left it painted forever. Enforced on the 500 ms tick, so no exit path can
  // leave it on screen.
  // The hold is where an ad's first frames reach the screen, and Twitch paints
  // an undecoded/placeholder ad frame GREEN (owner 2026-11-11: "quando eu
  // reiniciei a pagina, tinha uma tela totalmente verde ... aparentemente o verde
  // era do inicio de um anuncio ... tira esse verde. deixa preto"). So the hold
  // paints the player's own rect BLACK - never the whole viewport, never over the
  // rest of the page - and the notice rides inside it.
  function sizeCover(c) {
    const v = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
    let r = null;
    try { r = v && v.getBoundingClientRect(); } catch { r = null; }
    if (!r || r.width < 40 || r.height < 40) {
      // No native rect to cover: stay a small centred notice. A full-viewport
      // opaque rectangle is the black screen the owner photographed on
      // 2026-11-07/08, so the no-rect case never takes the screen.
      c.style.left = '50%';
      c.style.top = '50%';
      c.style.width = 'auto';
      c.style.height = 'auto';
      c.style.transform = 'translate(-50%,-50%)';
      c.style.padding = '8px 14px';
      c.style.borderRadius = '8px';
      c.style.background = 'rgba(0,0,0,.72)';
      return;
    }
    c.style.transform = 'none';
    c.style.padding = '0';
    c.style.borderRadius = '0';
    c.style.background = '#000';
    c.style.left = `${Math.round(r.left)}px`;
    c.style.top = `${Math.round(r.top)}px`;
    c.style.width = `${Math.round(r.width)}px`;
    c.style.height = `${Math.round(r.height)}px`;
  }

  function syncCover() {
    const c = overlay.cover;
    if (!c || c.isConnected === false) return; // a detached node cannot paint
    const show = !!(overlay.coldCover && !overlay.revealed && overlay.adActive);
    const shown = c.style.display !== 'none';
    if (show) sizeCover(c);
    if (show === shown) return;
    c.style.display = show ? 'flex' : 'none';
  }

  function positionOverlay() {
    syncCover();
    if (!overlay.frame) return;
    const v = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
    if (!v) {
      // NO PLAYER ANYWHERE is the one case that really ends the frame: this
      // layer positions itself over Twitch's player, so with that element gone
      // there is nothing to cover and the picture must not float over the rest
      // of the page. (While ANY player exists — including a rebuilt one, or the
      // hover preview — the branch below keeps the last real geometry, because
      // a timer on a degenerate rect is what hid the picture under a hovering
      // mouse. Owner reports 2026-11-13.)
      if (overlay.revealed || overlay.coldCover) {
        overlay.frame.style.display = 'none';
        if (overlay.badge) overlay.badge.style.display = 'none';
      }
      return;
    }
    let r;
    try {
      r = v.getBoundingClientRect();
    } catch {
      return;
    }
    // A DEGENERATE RECT IS NOT THE END OF THE FRAME. This used to hide the
    // frame the first tick `width < 40`, and Twitch produces that tick for
    // reasons that have nothing to do with the ad path being over: hovering the
    // player opens the floating preview (a second, tiny <video> that mainVideo()
    // happily picks as "largest" while the real player is mid-swap), a quality
    // switch re-creates the element, and the player itself is briefly 0×0 when
    // it rebuilds. Measured owner report 2026-11-13: "ele da hide mesmo dando
    // hover" — the clean picture vanished from a player that was on screen the
    // whole time. While the frame is REVEALED the geometry may only improve:
    // keep the last rect that was real, and only hide when the small rect
    // is really gone (see the branch below).
    const areaOk = !!(r && r.width >= 40 && r.height >= 40);
    if (areaOk) {
      overlay.lastRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      overlay.smallRectSince = 0;
    } else if (overlay.revealed && overlay.lastRect) {
      // A DEGENERATE RECT IS NOT A DEPARTURE, AND A TIMER CANNOT TELL THE
      // DIFFERENCE. Hovering the player opens Twitch's floating preview for as
      // long as the user keeps pointing at it, so ANY fixed grace still hid the
      // clean picture under a mouse that never left the player (owner
      // 2026-11-13: "ele da hide mesmo dando hover"). The question is not "how
      // long has this rect been small" but "is the element we revealed still on
      // screen at all": a player that really left is REMOVED (or the document
      // is being navigated), which is observable in one tick and needs no timer.
      // Resolve the element FRESH: `overlay.video` is the one this path latched
      // at take-over, and its presence says nothing about whether TWITCH's
      // current element is still on the page (a swap replaces the node, which
      // is exactly what a quality switch or the hover preview causes). A cached
      // reference answering "still here" is how the frame outlives its player.
      let live = null;
      try {
        if (overlay.video && overlay.video.isConnected) {
          live = overlay.video;
        } else {
          // The latched element is gone: follow whichever player is on the page
          // now. `mainVideo()` only sees attached nodes, so a candidate here is
          // by definition still on screen.
          live = mainVideo();
        }
      } catch { live = null; }
      if (!live) {
        // No player anywhere: the player really went away.
        overlay.frame.style.display = 'none';
        if (overlay.badge) overlay.badge.style.display = 'none';
        overlay.smallRectSince = 0;
        return;
      }
      overlay.video = live; // follow the player across a swap
      // Still in the tree with a degenerate rect: a swap, a rebuild, or the
      // preview. Keep the last real geometry; the picture never blinks.
      r = overlay.lastRect;
      overlay.smallRectSince = overlay.smallRectSince || Date.now();
    } else {
      // Never revealed: the native is the surface anyway.
      overlay.frame.style.display = 'none';
      if (overlay.badge) overlay.badge.style.display = 'none';
      return;
    }
    overlay.frame.style.display = 'block';
    if (overlay.badge) {
      // Keep the badge hidden while the native player is still the visible
      // surface; it appears together with the clean player.
      overlay.badge.style.display = (overlay.revealed || overlay.coldCover) ? 'block' : 'none';
      overlay.badge.style.left = `${Math.round(r.left) + 12}px`;
      overlay.badge.style.top = `${Math.round(r.top) + 12}px`;
    }
    // Put the frame INSIDE the player's stacking context. A body-level fixed
    // frame sat behind Twitch's video on channel pages; Chrome then treated it
    // as occluded and hls.js never loaded a segment (measured: rs=0, ns=2).
    const container = v.closest('[data-a-target="video-player"], .video-player, .video-player__container, .pbyp-player-instance');
    const host = document.fullscreenElement || container || document.body;
    if (overlay.frame.parentElement !== host) {
      try { host.appendChild(overlay.frame); } catch { /* ignore */ }
    }
    if (host === document.body) {
      overlay.frame.style.position = 'fixed';
      overlay.frame.style.left = `${Math.round(r.left)}px`;
      overlay.frame.style.top = `${Math.round(r.top)}px`;
      overlay.frame.style.width = `${Math.round(r.width)}px`;
      overlay.frame.style.height = `${Math.round(r.height)}px`;
      overlay.frame.style.right = 'auto';
      overlay.frame.style.bottom = 'auto';
    } else {
      // The host is the video's own container (or the fullscreen element);
      // filling it avoids coordinate/scroll drift and keeps the frame above
      // the native video in the same stacking context.
      overlay.frame.style.position = 'absolute';
      overlay.frame.style.left = '0';
      overlay.frame.style.top = '0';
      overlay.frame.style.width = '100%';
      overlay.frame.style.height = '100%';
      overlay.frame.style.right = 'auto';
      overlay.frame.style.bottom = 'auto';
    }
    // Hide native videos only after the clean player has been revealed; while
    // it is transparent the native player is the visible surface. After the
    // reveal, keep hiding any video Twitch recreates during the ad.
    if (overlay.revealed) hideNativeVideos();
  }

  // How long after a reveal the frame's own audio report is allowed to correct
  // our command (see the `st` handler). Long enough to survive a slow first
  // report in a throttled tab, short enough that it never looks like a fight.
  const AUDIO_ASSERT_MS = 4000;
  // A disagreement reported this soon after our own command cannot have seen it:
  // the frame publishes `st` once a second, so the first report after a reveal
  // still carries the mute it had before we told it anything. Under this bound
  // the row is `audio-stale-report` (report lag), never `audio-mismatch` (a real
  // disagreement), and the command is re-sent either way.
  const AUDIO_REPORT_LAG_MS = 400;
  function overlaySend(msg) {
    if (!overlay.frame || !overlay.token) return;
    // Before the frame's navigation commits its contentWindow still belongs to
    // the PAGE origin, so a post with the extension as targetOrigin throws and
    // the command never arrives. Hold it until the frame reports in.
    if (!overlay.frameReady) {
      if (!overlay.queue) overlay.queue = [];
      // Bounded: a frame that never loads must not grow this forever.
      if (overlay.queue.length < 32) overlay.queue.push(msg);
      return;
    }
    try {
      overlay.frame.contentWindow.postMessage({ __koKick: { ...msg, _koToken: overlay.token } }, new URL(overlay.frame.src).origin);
    } catch {
      /* frame gone */
    }
  }

  function flushOverlayQueue() {
    if (!overlay.frameReady || !overlay.frame || !overlay.token) return;
    const q = overlay.queue || [];
    overlay.queue = [];
    for (const msg of q) overlaySend(msg);
  }

  // The native element is NOT ours: ko-audio.js mutes it while this overlay
  // claims the page, from the user's intent. Writing `.muted` here was the
  // second writer that reverted his unmute half a second later.

  function hideNativeVideos() {
    for (const v of document.querySelectorAll('video')) {
      const known = overlay.hiddenVideos.find((x) => x.el === v);
      if (known) {
        // Twitch can re-show a video after we hid it. Re-apply the CSS on every
        // position tick instead of trusting the first hide. Sound is not part of
        // the snapshot any more: the arbiter owns it for the whole claim.
        try { v.style.visibility = 'hidden'; } catch { /* ignore */ }
        continue;
      }
      overlay.hiddenVideos.push({ el: v, visibility: v.style.visibility });
      try { v.style.visibility = 'hidden'; } catch { /* ignore */ }
    }
  }

  function restoreNativeVideos() {
    for (const { el, visibility } of overlay.hiddenVideos) {
      try {
        if (el.isConnected) el.style.visibility = visibility;
      } catch { /* ignore */ }
    }
    overlay.hiddenVideos = [];
  }

  // Real ad chrome only. The old any-aria-label match treated Twitch's
  // "Experimenta 1 mês sem anúncios" promo button (32x32) as an ad, which
  // logged fake ad-ui-on events and could delay uncovering the native player.
  // How big is this ad surface REALLY? Twitch's wrapper is a shell: on his own
  // Chrome (measured 2026-11-15) the only wrapper on the page was the
  // squeezeback node, 0x0 itself, while its inner container carried the size
  // inline. Measuring the wrapper alone therefore answered 0x0 for a surface
  // that was painting.
  // At most 256 nodes (the wrapper plus its descendants) are inspected per call.
  // `adUiDetail()` runs from the 500 ms tick, so this is O(256) style + rect reads
  // per tick no matter how deep Twitch mounts the ad subtree: a bound, not a
  // heuristic. The WIDEST painted node wins; a small logo before the banner must
  // not hide the banner from the half-player-width gate.
  const AD_SURFACE_MAX_NODES = 256;
  function adSurfaceRect(root) {
    let best = { width: 0, height: 0 };
    const consider = (el) => {
      try {
        const cs = getComputedStyle(el);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return;
        if (Number(cs.opacity) === 0) return;
        const r = el.getBoundingClientRect();
        if (r.width > best.width || (r.width === best.width && r.height > best.height)) best = r;
      } catch {
        /* geometry is best-effort */
      }
    };
    try {
      const stack = [root];
      while (stack.length) {
        const el = stack.pop();
        consider(el);
        const kids = el && el.children;
        if (!kids) continue;
        // Keep at most 255 queued descendants so a single node with a huge
        // child list cannot make the next iteration unbounded.
        for (let i = kids.length - 1; i >= 0 && stack.length < AD_SURFACE_MAX_NODES - 1; i--) {
          if (kids[i]) stack.push(kids[i]);
        }
      }
    } catch {
      /* ignore */
    }
    return best;
  }
  // TEST SEAM: the harness has no Twitch DOM, so it injects the detail the
  // detector would have returned. Production always takes the DOM walk below.
  let adUiDetailOverride = null;
  // Measured 2026-11-24 in the isolated guest: a HEALTHY player has the video
  // at 714x325 inside a 714x402 player box — the difference is the viewport
  // cap, not an ad. The honest banner signal is a PAINTED wrapper: the
  // permanent shell is visibility:hidden / opacity:0 and is never an ad.
  function isOurOwnVideo(v) {
    try {
      return !!(v && v.closest && v.closest('#ko-wrap, iframe, [data-ko-frame]'));
    } catch {
      return false;
    }
  }
  function adWrapperPaint(el) {
    try {
      if (typeof getComputedStyle !== 'function') return null;
      const cs = getComputedStyle(el);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) return null;
      const r = adSurfaceRect(el);
      if (!(r.width > 20 && r.height > 20)) return null;
      return r;
    } catch {
      return null;
    }
  }
  function adLayoutNodes() {
    const q = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
    return {
      container: q('.video-player__container'),
      videoRef: q('.video-ref'),
      persistent: q('.persistent-player'),
      video: mainVideo(),
    };
  }
  function adLayoutRelease() {
    const saved = overlay.layoutSaved;
    overlay.layoutSaved = null;
    // No saved snapshot is not a decision worth a silent `return`: the loop
    // below is empty and the row is skipped, which is the same answer with one
    // exit fewer (silent-census budget, 2026-11-24).
    const rows = saved && saved.saved ? saved.saved : [];
    const nodes = adLayoutNodes();
    let videos = [];
    try { videos = Array.from(document.querySelectorAll('video') || []); } catch { /* ignore */ }
    let stale = 0;
    for (const s of rows) {
      const detached = !s.el || s.el.isConnected === false;
      let el = s.el;
      if (detached) {
        stale++;
        // A detached node cannot be written back. Restore the same ROLE on the
        // node that is connected now, or a wrapper Twitch replaced mid-pod
        // keeps the hidden inline style we wrote on its predecessor.
        if (s.name === 'wrapper') {
          try {
            const list = document.querySelectorAll('[class*="stream-display-ad"], [data-test-selector="sda-wrapper"]');
            el = list && list.length ? list[0] : null;
          } catch { el = null; }
        } else if (s.name === 'video') {
          el = videos.find((v) => v && v.isConnected !== false) || null;
        } else {
          el = nodes[s.name] && nodes[s.name].isConnected !== false ? nodes[s.name] : null;
        }
      }
      if (el && el.style) {
        for (const key of s.keys) {
          try {
            if (s.values[key] === undefined) delete el.style[key];
            else el.style[key] = s.values[key];
          } catch { /* ignore */ }
        }
      }
    }
    if (saved) {
      adLog('ad-layout', {
        act: 'release', before: saved.after, after: saved.before, banner: saved.banner, stale,
      });
    }
  }
  function adLayoutRestore(detail, wrapper) {
    const saved = overlay.layoutSaved;
    if (saved && saved.saved.some((s) => !s.el || s.el.isConnected === false)) {
      // Twitch replaced the nodes we wrote. Unhide the CURRENT wrapper before
      // taking a fresh snapshot: a clone of the hidden wrapper would otherwise
      // be captured as "visible" and stay hidden after the next release.
      try { wrapper.style.visibility = saved.before.wrapperVis || ''; } catch { /* ignore */ }
      overlay.layoutSaved = null;
    }
    if (!overlay.layoutSaved) adLayoutWrite(detail, wrapper);
  }
  function adLayoutWrite(detail, wrapper) {
    const nodes = adLayoutNodes();
    const keys = ['height', 'width', 'max-height'];
    const targets = [
      { name: 'container', el: nodes.container, keys },
      { name: 'videoRef', el: nodes.videoRef, keys },
      { name: 'video', el: nodes.video, keys },
      { name: 'wrapper', el: wrapper, keys: ['visibility'] },
    ];
    const missing = targets.filter((t) => !t.el || !t.el.style).map((t) => t.name);
    // `persistent` is READ below: without it the old code threw into
    // `adUiDetail`'s catch and disabled detection for the rest of the pod.
    if (!nodes.persistent || !nodes.persistent.style) missing.push('persistent');
    const val = (el, key) => (el && el.style ? el.style[key] : null);
    const before = {
      containerH: val(nodes.container, 'height'),
      containerW: val(nodes.container, 'width'),
      containerMaxH: val(nodes.container, 'max-height'),
      videoRefH: val(nodes.videoRef, 'height'),
      videoRefW: val(nodes.videoRef, 'width'),
      videoRefMaxH: val(nodes.videoRef, 'max-height'),
      videoH: val(nodes.video, 'height'),
      videoW: val(nodes.video, 'width'),
      videoMaxH: val(nodes.video, 'max-height'),
      wrapperVis: val(wrapper, 'visibility'),
    };
    if (missing.length) {
      adLog('ad-layout', {
        act: 'restore', skipped: 'missing-node', missing, before, after: null,
        banner: { w: detail.dw, h: detail.dh },
      });
    } else {
      const cr = nodes.container.getBoundingClientRect();
      const pr = nodes.persistent.getBoundingClientRect();
      const height = Math.round(Math.max(cr.height + detail.dh, pr.height));
      // A loop, not a `map` callback: every `return` a helper adds is a silent
      // exit the census budget has to pay for (2026-11-24 gate refusal).
      const saved = [];
      for (const t of targets) {
        const values = {};
        for (const key of t.keys) values[key] = val(t.el, key);
        saved.push({ name: t.name, el: t.el, keys: t.keys, values });
      }
      nodes.container.style.height = `${height}px`;
      nodes.container.style.width = '100%';
      nodes.container.style['max-height'] = 'none';
      nodes.videoRef.style.height = `${height}px`;
      nodes.videoRef.style.width = '100%';
      nodes.videoRef.style['max-height'] = 'none';
      nodes.video.style.height = '100%';
      nodes.video.style.width = '100%';
      nodes.video.style['max-height'] = 'none';
      wrapper.style.visibility = 'hidden';
      const after = {
        containerH: val(nodes.container, 'height'),
        containerW: val(nodes.container, 'width'),
        containerMaxH: val(nodes.container, 'max-height'),
        videoRefH: val(nodes.videoRef, 'height'),
        videoRefW: val(nodes.videoRef, 'width'),
        videoRefMaxH: val(nodes.videoRef, 'max-height'),
        videoH: val(nodes.video, 'height'),
        videoW: val(nodes.video, 'width'),
        videoMaxH: val(nodes.video, 'max-height'),
        wrapperVis: val(wrapper, 'visibility'),
      };
      overlay.layoutSaved = { saved, before, after, banner: { w: detail.dw, h: detail.dh } };
      adLog('ad-layout', { act: 'restore', before, after, banner: { w: detail.dw, h: detail.dh }, height });
    }
  }
  function adUiDetail() {
    try {
      if (adUiDetailOverride) {
        const injected = adUiDetailOverride();
        if (injected) return injected;
      }
      // A PAINTED wrapper is the signal. The permanent shell is hidden and
      // opacity:0, so it never matches. A wide lower third (>50% of the
      // player's WIDTH) is a banner squeeze even at 12% of the area: the old
      // area gate is why the owner's banner was refused.
      const playerEl = document.querySelector('[data-a-target="video-player"]') || document.querySelector('.video-player');
      const pRect = playerEl && playerEl.getBoundingClientRect ? playerEl.getBoundingClientRect() : null;
      const widthBase = pRect && pRect.width > 0 ? pRect.width : 0;
      for (const sda of document.querySelectorAll('[class*="stream-display-ad"], [data-test-selector="sda-wrapper"]')) {
        const r = adWrapperPaint(sda);
        if (!r || !widthBase || r.width < 0.5 * widthBase) continue;
        const v = mainVideo();
        // A surface covering the HEIGHT too is a full ad, not a squeeze:
        // hold/freeze it behind the clean picture, never change its layout.
        if (pRect && r.height >= 0.5 * pRect.height) {
          return { kind: 'wrapper', w: Math.round(r.width), h: Math.round(r.height) };
        }
        if (document.fullscreenElement || isOurOwnVideo(v)) return null;
        const vr = v ? v.getBoundingClientRect() : { width: 0, height: 0 };
        const nodes = adLayoutNodes();
        const cr = nodes.container ? nodes.container.getBoundingClientRect() : vr;
        const detail = {
          kind: 'banner-squeeze',
          vw: Math.round(vr.width), vh: Math.round(vr.height),
          cw: Math.round(cr.width), ch: Math.round(cr.height),
          dw: Math.round(r.width), dh: Math.round(r.height),
          wrapper: String((sda.className && String(sda.className)) || sda.getAttribute('data-test-selector') || 'stream-display-ad').slice(0, 120),
        };
        adLayoutRestore(detail, sda);
        return detail;
      }
      // Twitch's real countdown is like "Anúncio (0:12)" /
      // "Advertisement (0:15)". Require the numeric part so plain labels and
      // promo buttons cannot match.
      for (const e of document.querySelectorAll('[aria-label]')) {
        const label = e.getAttribute('aria-label') || '';
        if (!/an.ncio|advert/i.test(label)) continue;
        if (/sem\s+an.ncios|without\s+ads?|no\s+ads?|ad-?free|remove\s+ads?|experimenta|teste|try\s+1/i.test(label)) continue;
        if (!/\(\s*\d|\d+\s*(s|seg|segundos?|seconds?)\b/i.test(label)) continue;
        const r = e.getBoundingClientRect();
        if (r.width > 10 && r.height > 5) {
          return { kind: 'aria', label: label.slice(0, 120), w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
      // The slate the owner pasted verbatim on 2026-11-15 ("Continue com
      // FredTheFinch logo após esse anúncio comercial … Anúncio (0:15)") is
      // TEXT in the player, with no aria-label and no sized wrapper, so both
      // branches above answered null while a whole pod played. Scan only the
      // player subtree (not the document) and only text nodes, so the cost
      // stays well under a millisecond on a 500 ms tick.
      const player = document.querySelector('[data-a-target="video-player"]') || document.querySelector('.video-player');
      if (player) {
        const walker = document.createTreeWalker(player, NodeFilter.SHOW_TEXT);
        let node = null;
        let seen = 0;
        while ((node = walker.nextNode()) && seen++ < 400) {
          const t = String(node.nodeValue || '').trim();
          if (!t || t.length > 200) continue;
          // Both halves of the real slate, and the countdown itself. The promo
          // button ("Teste 1 mês sem anúncios") never carries a countdown.
          const countdown = /\(\s*\d{1,2}\s*:\s*\d{2}\s*\)/.test(t) && /an.ncio|advert/i.test(t);
          const slate = /logo\s+ap[oó]s\s+esse\s+an.ncio|right\s+after\s+this\s+ad|apoiar\s+a\s+transmiss/i.test(t);
          if (!countdown && !slate) continue;
          const host = node.parentElement;
          const r = host ? host.getBoundingClientRect() : null;
          return {
            kind: countdown ? 'countdown' : 'slate',
            label: t.slice(0, 120),
            w: r ? Math.round(r.width) : 0,
            h: r ? Math.round(r.height) : 0,
          };
        }
      }
    } catch {
      /* DOM can be mid-mutation */
    }
    return null;
  }

  function adUiPresent() {
    return !!adUiDetail();
  }

  // The earliest honest ad signal on the page. `ad-hold` arrives from the
  // worker's playlist probe, which needs a segment refresh to see the ad
  // segments; Twitch's own ad wrapper is in the DOM before that. Multiplying a
  // measurement on the owner's live tab (2026-11-15, 0.8.92) put the wrapper up
  // 1.5-3.5 s before `ad-hold`, and those are the seconds he reports as "ad toca
  // por uns 4 segundos até finally ser defendido".
  //
  // It PAUSES and does not paint: the cover and the claim belong to the pod's own
  // lifecycle (revealOverlay/stopAdOverlay), which knows when the clean picture
  // is up. A frozen frame is what a hold is (measured 2026-11-08: hiding the
  // native is the black screen he photographed), and resuming is the release.
  let adUiHeldAt = 0;
  // A fresh USER play ends the hold. The 500 ms tick must not undo it: that
  // was "ficou pausando o anuncio toda hora que eu tentava despausar".
  let adUiUserResumeAt = 0;
  let adUserResumeLogged = false;
  let lastUserInputAt = 0;
  // ONE RULE FOR BOTH GESTURES. A media event is the user's only when a real
  // input arrived within this window; `play` already used it, and `pause` did
  // not - which is the defect measured in the owner's ring on 2026-11-26.
  const USER_GESTURE_MS = 1500;
  const hasFreshInput = () => !!lastUserInputAt && Date.now() - lastUserInputAt <= USER_GESTURE_MS;
  let userPlayAt = 0;
  let ownPlayAt = 0;
  // A user pause made AFTER this pod took over. Unlike a play, a pause needs
  // no gesture clock: the browser fires it when the control parks the player.
  // Our own pause is stamped first (`selfPausedAt`), so it is never mistaken
  // for this. Only a fresh user play gives the picture back.
  let userPausedInPod = false;
  let userPauseLogged = false;
  let userPauseRefusedLogged = false;
  function userResumedHeld() {
    return !!adUiUserResumeAt && Date.now() - adUiUserResumeAt < AD_UI_HOLD_MAX_MS;
  }
  let adUiReasserts = 0;
  // A hold that OUTLIVED its budget without a clean picture hands the page back
  // and must not re-take the SAME episode (see the tick's `hold-expired`
  // branch). Module state, cleared at the episode's own end.
  let adUiFailedAt = 0;
  let adUiFailedLogged = false;
  // One `ad-skip {reason:'hidden-tab'}` per detected episode, not one per tick.
  let adUiHiddenLogged = false;
  // One `ad-skip {reason:'overlay-owns'}` per detected episode, for the same
  // reason. That return was the ONLY silent exit left in this function, and it
  // is the one that cost a whole pod: measured 2026-11-19 on twitch.tv/alanzoka
  // (no kick channel at all), `data-ko-owner` read "kick" for 30 s of slate
  // (`ad-ui-on` 188911 -> `ad-ui-off {adSec:29.7}` 218566) with
  // `wrapShown:false` and `kick:null` on every heartbeat, so `adUiHold`
  // returned at the ownership test and the ring could not say why - the
  // verdict printed "NOTHING SAW AN AD" over a page that had detected one.
  let adUiOwnerLogged = false;
  // A banner or a squeezeback is not a playing ad and must never cost the user
  // his picture: the hold needs the ad surface to cover most of the player, or
  // the countdown label (which only exists while one is running).
  function adHoldWorthy(detail, v) {
    if (!detail) return false;
    // A label the page itself puts in the player (the countdown or the slate
    // text) is the ad talking, not a background element: it has no size to
    // measure, and requiring one is how the detector lost a whole pod.
    if (detail.kind === 'aria' || detail.kind === 'countdown' || detail.kind === 'slate') return true;
    if (detail.kind === 'banner-squeeze') return true;
    try {
      const r = v && v.getBoundingClientRect ? v.getBoundingClientRect() : null;
      if (!r || !r.width || !r.height) return true; // geometry unknown: trust the wrapper
      return detail.w >= 0.5 * r.width; // a wide lower third is a played ad
    } catch {
      return true;
    }
  }
  const AD_UI_HOLD_MAX_MS = 12000; // the mint's own ceiling; past it the watchdog owns the screen
  // ---- A STANDBY IS NOT A COVER UNTIL IT CAN PLAY -------------------------
  // Owner report 2026-11-20, verbatim: "eu peguei anuncio por varios segundos".
  // His own Chrome's ring (twitch.tv/xqc, player=kick): `ad-ui-on=0 ad-hold=0
  // worker-playlist=0`, 31 `overlay-catchup-skip {why:"standby-paused"}` rows,
  // and ~62.6 s of the native playing the ad. A standby left PAUSED by a
  // previous pod (never revealed, never torn down) keeps `overlay.standby` true
  // and this tick read that flag as "a clean picture is warmed and ready" on
  // every tick, so it never re-asserted a pause and never asked for a source
  // that can actually play. `overlay.standby` means a clean source EXISTS; it
  // says nothing about whether that source can be painted.
  //
  // One `paused` report is not the answer: a frame that was just minted reports
  // it while its first segment is fetched. A run of them is a duration (the
  // frame reports at 1 Hz), and twelve seconds of a standby that was supposed to
  // be warming is a standby that is not coming.
  const STANDBY_PAUSED_REPORTS = 12;
  function standbyStale() {
    if (!overlay.standby) return false;
    if (overlay.adActive || overlay.revealed || overlay.playing) return false;
    if (!overlay.lastSt || !overlay.lastSt.paused) return false;
    // A throttled background frame legitimately stops advancing; only a visible
    // tab's reports describe a standby the user could have been shown.
    if (!document.visibilityState || document.visibilityState !== 'visible') return false;
    // A report that is not fresh describes a frame that stopped talking, not a
    // frame that cannot play (`stGapMs` is measured, up to 32 s in a hidden tab).
    if (!overlay.lastStAt || Date.now() - overlay.lastStAt > 3000) return false;
    return (overlay.standbyPausedReports || 0) >= STANDBY_PAUSED_REPORTS;
  }
  // One row per reason transition: the tick runs every 500 ms for the length of
  // a pod, so a row per call would bury the chronology the ring exists for.
  //
  // BUT A DEDUPE THAT OUTLIVES ITS EPISODE IS THE SAMPLE-NOT-TRANSITION DEFECT
  // THIS FILE ALREADY PAID FOR. It is reset at BOTH ends of an episode: at the
  // `ad !== rec.ad` transition (the unknown direction, so neither a held nor a
  // refused pod can leak its reason) and in `adUiRelease()`. Measured
  // 2026-11-20 on twitch.tv/buzzyi_: a 1200-event ring with 52 `ad-tick` rows,
  // two `ad-ui-on`/`ad-ui-off` pairs and ZERO `ad-ui-hold` skip rows - the ring
  // could not name a single hold refusal.
  let adUiTickWhy = '';
  function adUiTickSkip(why, extra) {
    if (adUiTickWhy !== why) {
      adUiTickWhy = why;
      adLog('ad-ui-hold', Object.assign({ act: 'skip', why }, extra || {}));
    }
  }
  // Twitch's ad renderer calls play() again on its own element, so a single
  // pause is undone in milliseconds. Re-asserting is not a fight with the page:
  // it is the only way a pause survives the ad it is meant to stop.
  function adUiHoldTick() {
    // Once he has taken the picture back, no later tick may re-pause it.
    if (userResumedHeld()) return;
    // THE STALE STANDBY IS TORN DOWN BEFORE ANY OTHER QUESTION IS ASKED. It is
    // the flag every later branch reads as "the pod owns it now", so leaving it
    // set is how a previous pod's paused source refuses a whole new pod (the
    // ring above). `stale-standby` is the same exit `overlay-stall-stop` uses
    // for a source that cannot play, and `requestStandby(0, true)` is the
    // hold's own warming path, so the replacement starts in this tick.
    if (standbyStale()) {
      const st = overlay.lastSt || {};
      adLog('ad-ui-hold', {
        act: 'standby-stale',
        why: 'paused-never-revealed',
        reports: overlay.standbyPausedReports || 0,
        pos: isFinite(Number(st.pos)) ? +Number(st.pos).toFixed(1) : null,
        lat: isFinite(Number(st.lat)) ? +Number(st.lat).toFixed(1) : null,
        ageMs: overlay.startedAt ? Date.now() - overlay.startedAt : null,
      });
      stopAdOverlay('stale-standby');
      requestStandby(0, true, 'stale-standby');
    }
    // ONLY A POD THAT OWNS THE PICTURE GETS HERE, AND IT KEEPS THE NATIVE
    // FROZEN. `overlay.adActive` is the pod's own claim and `overlay.revealed`
    // is a clean picture actually on screen; a warm standby and a minted-but-
    // hidden frame are neither. Measured on the owner's live tab 2026-11-20
    // (`snap().who`): `{standby:true, revealed:false, adActive:false,
    // playing:true}` with NO ad on screen, so the old three-flag guard armed in
    // STEADY STATE and refused every DOM hold on a page where a standby merely
    // existed.
    //
    // The freeze is checked BEFORE the hold stamp, because a playlist pod never
    // runs `adUiHold` (there is no DOM signal to run it), and its own take-over
    // pause is undone by Twitch's ad renderer within a second. Measured in the
    // owner's ring above: 30 s of the native playing under a revealed frame.
    if (overlay.adActive || overlay.revealed) {
      const pv = freezeNativeForPod();
      if (pv) {
        adUiReasserts++;
        if (adUiReasserts === 1) {
          adLogState('ad-ui-hold', { act: 'reassert', own: 'pod', ct: +Number(pv.currentTime || 0).toFixed(1), n: 1 });
        }
      }
      return adUiTickSkip('pod-owns', {
        adActive: !!overlay.adActive,
        revealed: !!overlay.revealed,
        standby: !!overlay.standby,
        frame: !!overlay.frame,
        froze: !!pv,
      });
    }
    if (!adUiHeldAt) return adUiTickSkip('no-hold');
    if (overlayOwnsPlayback()) return adUiTickSkip('overlay-owns');
    if (Date.now() - adUiHeldAt > AD_UI_HOLD_MAX_MS) {
      // THE HOLD'S BUDGET EXPIRING IS NOT A FREEZE. Measured in the owner's own
      // ring (twitch.tv/cellbit, 0.8.112, 2026-11-24): the pod handed back onto a
      // break that was still running, `ad-ui-hold {act:"paused", ct:1023.1}`
      // took the element, a clean source that never became healthy
      // (`playing-not-healthy buffered 0.4-2.8` for 200 s) meant no cover
      // arrived, `ad-ui-hold {why:"hold-expired", heldMs:12498}` fired - and then
      // NOTHING resumed it. Two defects in that one line: the stamp stayed set
      // (so every later tick returned here instead of judging afresh) and the
      // pause outlived the hold, reading `{paused:true, ct:1023.3, rs:4}` on
      // every heartbeat for 71 s until Twitch reloaded the page himself.
      // FAIL OPEN, like the cold cover does: an ad the user can SEE beats a
      // picture that never moves, which is the report ("travou a live").
      const heldMs = Date.now() - adUiHeldAt;
      adUiHeldAt = 0;
      adUiReasserts = 0;
      adUiFailedAt = Date.now();
      if (!adUiFailedLogged) {
        adUiFailedLogged = true;
        adLog('ad-ui-hold', { act: 'skip', why: 'hold-failed', heldMs: Math.round(heldMs) });
      }
      const v0 = mainVideo();
      const ct0 = v0 ? +Number(v0.currentTime || 0).toFixed(1) : null;
      // A release is a transition: one row for the episode, with the numbers.
      adLogState('ad-ui-hold', { act: 'release', why: 'hold-expired', heldMs: Math.round(heldMs), ct: ct0, paused: !!(v0 && v0.paused) });
      // THE POD END OWNS THIS ELEMENT. Its `stopAdOverlay('ad-end')` already
      // consumed `holdAt`/`holdCt` and handed the picture back (with its own
      // seek and retries). Measured in the owner's ring 2026-11-25: the pod
      // hand-back at ms 55784 was followed 284 ms later by a stale hold
      // expiry that resumed the SAME element at ct 0.5 with `holdAt:0` - the
      // deficit was gone, so Twitch played the ad program from its start for
      // 49 s. Fail closed here (the pod's recovery owns the picture), and name
      // the reason in the ring instead of writing a second hand-back.
      markAdPark(false);
      if (overlay.podHandoffAt) {
        adLog('ad-ui-hold', { act: 'skip', why: 'pod-handoff-owns', ct: ct0, handoffAgeMs: Date.now() - overlay.podHandoffAt });
        return;
      }
      // Keep a source warming so the REST of this break can still be covered if
      // one becomes ready; the episode itself stays failed (see `adUiHold`).
      requestStandby(1200, false, 'hold-expired');
      // LAND ON THE PICTURE, NOT ON THE PARKED AD FRAME. The native was paused
      // at ct 0.4 while the clean frame sat healthy at pos 22.8; `seek:false`
      // resumed exactly that ad frame and `behind:15.6` was computed but never
      // used (replica 2026-11-25). A mounted, healthy clean picture wins;
      // otherwise fail open with a real hand-back that consumes `behind`.
      // A player the USER parked still stays parked.
      if (v0 && v0.isConnected && !resumeRefusedByUser(v0)) {
        if (cleanFrameCanCover()) {
          revealOverlay('hold-expired');
          adLog('ad-ui-hold', { act: 'handed-to-clean', ct: ct0 });
        } else {
          resumeNative(v0, 'hold-expired');
        }
      }
      return;
    }
    const v = mainVideo();
    if (!v || !v.isConnected) return adUiTickSkip('no-video');
    if (v.paused) {
      // `adUiHold()` in this very tick issued that pause and stamped it. A
      // "native-paused" skip here is the replica's same-millisecond
      // contradiction: the hold had just taken the element.
      if (overlay.selfPausedAt && Date.now() - overlay.selfPausedAt <= AD_UI_OWN_PAUSE_MS) {
        adLog('ad-ui-hold', { act: 'reassert', own: 'hold', ct: +Number(v.currentTime || 0).toFixed(1) });
        return;
      }
      return adUiTickSkip('native-paused');
    }
    try { v.pause(); } catch { /* ignore */ }
    overlay.selfPausedAt = Date.now();
    adUiReasserts++;
    // One line for the whole episode: the count is what answers "did the page
    // take the pause back", and a row per tick would bury the chronology.
    if (adUiReasserts === 1) {
      adLogState('ad-ui-hold', { act: 'reassert', ct: +Number(v.currentTime || 0).toFixed(1), n: 1 });
    }
  }
  function adUiHold(detail) {
    if (adUiHeldAt) return; // already held by this signal
    if (userResumedHeld()) return adUiTickSkip('user-resume');
    if (!AD_OVERLAY_ENABLED) return adUiTickSkip('overlay-disabled');
    // NAMED, ONCE PER EPISODE, AND ONLY FOR A POD THAT OWNS THE PICTURE. This
    // return wrote NOTHING, and the comment above `adUiOwnerLogged` claiming
    // `overlay-owns` was "the ONLY silent exit left" was wrong: this was a
    // second one, and it is the one that arms in steady state because a warm
    // standby is not a cover. Measured 2026-11-20 (twitch.tv/buzzyi_, pod 2,
    // same page load): `ad-ui-on` at ms 130359 with a standby reporting
    // clean/playing at 129899, the whole 36.6 s native (`ad-tick` paused:false,
    // ct 4.7 -> 34.6), and not one `ad-ui-hold` row in a 1200-event ring.
    if (overlay.adActive || overlay.revealed) {
      // The pod owns the picture: keep the native frozen here too, so the DOM
      // edge does not wait up to 500 ms for the tick (Twitch's ad renderer
      // resumes its own element within that window).
      const pv = freezeNativeForPod();
      return adUiTickSkip('pod-owns', {
        adActive: !!overlay.adActive,
        revealed: !!overlay.revealed,
        standby: !!overlay.standby,
        frame: !!overlay.frame,
        froze: !!pv,
      });
    }
    // ONE FAILED HOLD PER EPISODE. A hold that ran out its budget without a
    // picture moving did not fail for lack of asking: re-taking it every tick
    // would pause the page for 12 s, fail open, pause again - a stutter on the
    // ad the user IS watching. The episode is given the page back and the next
    // pod starts clean (`adUiRelease` clears this).
    if (adUiFailedAt) {
      if (!adUiFailedLogged) {
        adUiFailedLogged = true;
        adLog('ad-ui-hold', { act: 'skip', why: 'hold-failed', ageMs: Math.round(Date.now() - adUiFailedAt) });
      }
      return;
    }
    if (overlayOwnsPlayback()) {
      // NAMED, ONCE PER EPISODE. A refusal the ring cannot see is how a whole
      // 30 s pod read as "NOTHING SAW AN AD" (measured 2026-11-19). `own` is
      // the raw attribute and `wrap` proves whether a layer can exist at all:
      // `own:"kick"` with `wrap:false` is a stale publish, not a covered page.
      if (!adUiOwnerLogged) {
        adUiOwnerLogged = true;
        adLog('ad-skip', { reason: 'overlay-owns', own: ownerAttr() || null, wrap: !!document.getElementById('ko-wrap') });
      }
      return; // the overlay player is the picture: no ad here
    }
    if (document.visibilityState && document.visibilityState !== 'visible') {
      // A REFUSAL IS NAMED, ONCE PER EPISODE. The tick retries this every 500 ms
      // (see the tick's own comment), so the tab coming back inside a pod gets
      // its hold; without the row, a pod the ring shows no attempt for is
      // indistinguishable from one that was never detected.
      if (!adUiHiddenLogged) {
        adUiHiddenLogged = true;
        adLog('ad-skip', { reason: 'hidden-tab', adUi: detail ? detail.kind : null, hidden: true });
      }
      return;
    }
    const v = mainVideo();
    if (!v || !v.isConnected) return adUiTickSkip('no-video');
    // A DETECTED POD THAT IS NOT WORTH PAUSING FOR SAYS SO. `adUiDetail` can
    // answer for a 160x90 banner, and silence there read as "nothing detected".
    if (!adHoldWorthy(detail, v)) return adUiTickSkip('not-worthy', { kind: detail ? detail.kind : null });
    adUiReasserts = 0;
    if (v.paused) {
      adUiHeldAt = Date.now();
      overlay.podHandoffAt = 0;
      // A cold cover (or the tick's previous re-assert) paused this element;
      // the following half must not re-label that pause as the native's.
      if (selfPausedRecently()) overlay.selfPausedAt = adUiHeldAt;
      adLog('ad-ui-hold', { act: 'already-paused', ct: +Number(v.currentTime || 0).toFixed(1) });
      return;
    }
    adUiHeldAt = Date.now();
    markAdPark(true);
    overlay.podHandoffAt = 0;
    try { v.pause(); } catch { /* ignore */ }
    // The pod's take-over reads `v.paused` to decide whether the USER parked the
    // player, and this pause is ours: stamp it or the hand-back refuses to
    // resume its own hold (the 2026-11-15 freeze).
    overlay.selfPausedAt = adUiHeldAt;
    // A paused ad frame is still an ad frame. The worker's playlist probe only
    // fires on the next segment refresh — that gap IS the "ad toca por uns 4
    // segundos até finalmente ser defendido" report (owner 2026-11-15). The ad
    // wrapper appearing is proof enough to start warming a clean source now,
    // so the cover is the freeze plus one HLS segment instead of a full refresh.
    requestStandby(0, true, 'ad-ui-hold');
    adLogState('ad-ui-hold', { act: 'paused', ct: +Number(v.currentTime || 0).toFixed(1), rs: v.readyState });
  }
  // Any play the extension did not issue means the user took the player back:
  // the stamp that explains a pause must not outlive his own resume.
  // INPUT CLOCK. Only a play inside a fresh gesture is HIS; Twitch's own ad
  // renderer calls play() too, and that machine play is still ours to freeze.
  const markUserInput = () => { lastUserInputAt = Date.now(); };
  try {
    for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click']) {
      for (const target of [window, document]) target.addEventListener(type, markUserInput, true);
    }
  } catch { /* ignore */ }
  try {
    document.addEventListener('play', (e) => {
      const t = e && e.target;
      if (!t || t.tagName !== 'VIDEO') return;
      if (overlay.selfPausedAt && Date.now() - overlay.selfPausedAt > 250) overlay.selfPausedAt = 0;
      if (!hasFreshInput()) return; // machine play
      // Our own resume is not a user takeover, but a gesture AFTER it is.
      if (ownPlayAt && Date.now() - ownPlayAt <= 500 && lastUserInputAt <= ownPlayAt) return;
      userPlayAt = Date.now();
      userPausedInPod = false; // only a fresh user play gives the picture back
      userPauseLogged = false;
      userPauseRefusedLogged = false;
      const pod = adUiHeldAt ? 'hold' : (overlay.adActive || overlay.revealed ? 'playlist' : null);
      if (!pod || userResumedHeld()) return;
      // A playlist pod opened by `ad-hold` has no DOM ad: `adUiHeldAt` was
      // never stamped, but the pod owns the freeze. Release it here so the
      // next 500 ms tick does not undo what the user just did.
      if (adUiHeldAt) adUiRelease();
      adUiFailedAt = Date.now();
      adUiFailedLogged = true;
      adUiUserResumeAt = Date.now();
      markAdPark(false);
      if (!adUserResumeLogged) {
        adUserResumeLogged = true;
        // The input that authorized it, so "who resumed this" is one field and
        // not a join across the ring.
        adLog('ad-ui-hold', {
          act: 'user-resume', pod, ct: +Number(t.currentTime || 0).toFixed(1),
          inputAgeMs: Math.round(Date.now() - lastUserInputAt),
        });
      }
    }, true);
  } catch { /* ignore */ }
  try {
    // A USER pause during the pod stays parked at hand-back, and the ONLY
    // evidence that a pause is the user's is a real input beside it. This used
    // to accept "any pause that was not ours", and the owner's own ring
    // (2026-11-26, 0.8.116, buzzyi_) shows what that costs: he was ALT-TABBED
    // when the page paused its own element inside a playlist pod
    // (`ad-tick playing while owned=6`), the listener stamped
    // `ad-ui-hold {act:"user-pause", ct:3.4}`, and `userPausedInPod` then
    // refused every hand-back resume for the rest of the pod -
    // `native-handoff {resume:NEVER, podAge:3m12.1}` with the picture parked.
    // That is literally his report: "a live pausou enquanto eu estava alt tab".
    // Our pauses are still excluded first (`selfPausedAt` before the write, and
    // `ownPlayAt` for a resume we issued); a refusal is a row, never silence.
    document.addEventListener('pause', (e) => {
      const t = e && e.target;
      const ours = (overlay.selfPausedAt && Date.now() - overlay.selfPausedAt <= 250)
        || (ownPlayAt && Date.now() - ownPlayAt <= 250);
      if (!t || t.tagName !== 'VIDEO' || !(overlay.adActive || overlay.revealed) || ours) return;
      if (!hasFreshInput()) {
        if (!userPauseRefusedLogged) {
          userPauseRefusedLogged = true;
          adLog('ad-ui-hold', {
            act: 'pause-refused', why: 'no-input',
            ct: +Number(t.currentTime || 0).toFixed(1),
            sinceInputMs: lastUserInputAt ? Math.round(Date.now() - lastUserInputAt) : null,
          });
        }
        return;
      }
      userPausedInPod = true;
      if (!userPauseLogged) {
        userPauseLogged = true;
        adLog('ad-ui-hold', {
          act: 'user-pause', ct: +Number(t.currentTime || 0).toFixed(1),
          inputAgeMs: Math.round(Date.now() - lastUserInputAt),
        });
      }
    }, true);
  } catch { /* ignore */ }

  function adUiRelease(fromUiOff) {
    // THE REASON IS CLEARED ON EVERY EPISODE END, HELD OR NOT. It used to sit
    // after `if (!adUiHeldAt) return;`, so the first pod that was refused
    // poisoned the per-episode dedupe for the rest of the page load: the ring
    // got its one row, and every later pod on the same reason was silent.
    adUiTickWhy = '';
    // A NEW EPISODE STARTS WITH A FULL BUDGET. The failed flag is per episode
    // for the same reason the reason-dedupe is (the 2026-11-20 wave): a refusal
    // that outlives its pod makes every later pod silent or, here, unheld.
    adUiFailedAt = 0;
    adLayoutRelease();
    if (fromUiOff) {
      adUiUserResumeAt = 0;
      adUserResumeLogged = false;
      adAfterRevealLogged = false;
    }
    adUiFailedLogged = false;
    const wasHeld = !!adUiHeldAt;
    const heldMs = wasHeld ? Date.now() - adUiHeldAt : 0;
    const reasserts = adUiReasserts;
    if (wasHeld) {
      adUiHeldAt = 0;
      adUiReasserts = 0;
    }
    // The DOM proved the ad ended: a playlist-opened pod must not outlive it.
    // finishAdOverlay() owns the chrome-linger grace and stopAdOverlay() the
    // single audio-claim release, so this only chooses the door.
    if (fromUiOff && overlay.playlistPodAt && (overlay.adActive || overlay.revealed)) {
      adLog('ad-ui-release', {
        act: 'pod-end',
        heldMs,
        podAgeMs: Date.now() - overlay.playlistPodAt,
        revealed: !!overlay.revealed,
      });
      finishAdOverlay();
      return;
    }
    if (!wasHeld) return;
    // ONLY A CLAIMED / PAINTED POD OWNS THE RESUME. Two resumers on one element
    // was the pause/resume churn the 2026-11-09 wave removed, but a warm
    // standby does not resume anything (a standby shutdown never touches the
    // native), so deferring to it left this hold's pause in place - the frozen
    // picture. `resumeNative` only acts on a paused element, so a pod that has
    // already resumed is a no-op.
    if (overlay.adActive || overlay.revealed) {
      adLog('ad-ui-release', { heldMs, act: 'pod-owns', reasserts });
      return;
    }
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    const v = mainVideo();
    if (!v || !v.isConnected) return;
    adLog('ad-ui-release', { heldMs, act: v.paused ? 'resume' : 'playing', reasserts });
    if (v.paused) resumeNative(v, 'ad-ui-release');
  }
  // Exposed for diagnostics/tests only; not used by the ad path.
  stats.adUiDetail = adUiDetail;
  // Test seam: the DOM walk is not available in the harness world, so the two
  // halves are driven directly - the decision (`adHoldWorthy`) and the effect.
  stats.adUiHold = adUiHold;
  stats.adUiRelease = adUiRelease;
  // Test/diagnostic seam: drive standby lifecycle rows without a worker round trip.
  stats.requestStandby = requestStandby;
  stats.standbyBypass = () => ({ at: standbyBypassAt, pod: standbyBypassPod });
  stats.standbyPrewarm = () => Object.assign({}, standbyPrewarm);
  stats.ageStandbyPrewarm = (ms) => { if (standbyPrewarm.at) standbyPrewarm.at = Date.now() - ms; };
  // The warm's budget is 12 s of wall clock - too long to drive in a suite. The
  // seam shortens the SAME timer (it is not a second clock) so both outcomes of
  // a parked ask (served by the resolve, flushed by the timeout) are reachable.
  stats.setPrewarmWaitMs = (ms) => {
    const n = Number(ms);
    if (Number.isFinite(n) && n > 0) standbyPrewarmWaitMs = n;
  };
  stats.standbyPrewarmWaiters = () => standbyPrewarmWaiters.slice();
  stats.ageStandbyPrewarmKick = (ms) => { if (standbyPrewarm.kickAt) standbyPrewarm.kickAt = Date.now() - ms; };
  stats.adUiHoldTick = adUiHoldTick;
  stats.adHoldWorthy = adHoldWorthy;
  stats.adUiHeldAt = () => adUiHeldAt;
  // The host of the pod claim is the thing the worker→page route is supposed
  // to set; an arm that could not read it would have to infer adActive from a
  // log row written by a different branch.
  stats.adActive = () => !!overlay.adActive;
  stats.revealed = () => !!overlay.revealed;
  // The hand-back wait is only worth anything if the PICTURE is still mounted:
  // the first version of this wait sat after `overlay.frame.remove()` and held
  // an empty screen, which the arm could not see without this seam.
  stats.frameMounted = () => !!(overlay.frame && overlay.frame.isConnected !== false);
  stats.handbackWait = () => (overlay.handbackWait ? { ms: Date.now() - overlay.handbackWait.at, reason: overlay.handbackWait.reason } : null);
  // Diagnostic seam: how many consecutive reports said the clean frame is
  // paused. The stale-standby decision reads it, and an arm that could not read
  // it would have to re-count reports beside the product and pass either way.
  stats.standbyPausedReports = () => overlay.standbyPausedReports;
  stats.userPlayAt = () => userPlayAt;
  stats.adTestClock = ({ hiddenGapMs, holdAgeMs, holdUiAgeMs, selfPauseAgeMs, clearHold, clearInput } = {}) => {
    if (Number.isFinite(hiddenGapMs)) overlay.hiddenGapMs = Math.max(0, hiddenGapMs);
    if (Number.isFinite(holdAgeMs)) overlay.holdAt = Date.now() - holdAgeMs;
    if (Number.isFinite(holdUiAgeMs)) adUiHeldAt = Date.now() - holdUiAgeMs;
    if (Number.isFinite(selfPauseAgeMs)) overlay.selfPausedAt = Date.now() - selfPauseAgeMs;
    if (clearHold) adUiHeldAt = 0;
    if (clearInput) lastUserInputAt = 0;
    return { hiddenAt: overlay.hiddenAt, hiddenGapMs: overlay.hiddenGapMs, holdCt: overlay.holdCt, userDvr: overlay.userDvr };
  };
  stats.setAdUiDetailForTest = (fn) => { adUiDetailOverride = typeof fn === 'function' ? fn : null; };
  function adUiHoldTarget() {
    const d = adUiDetail();
    if (!d) return null;
    try { return adHoldWorthy(d, mainVideo()) ? d : null; } catch { return null; }
  }
  let adAfterRevealLogged = false;
  function holdAfterReveal(d) {
    if (!adAfterRevealLogged) {
      adAfterRevealLogged = true;
      adLog('ad-ui-hold', { act: 'ad-after-reveal', kind: d && d.kind });
    }
    adUiHold(d);
  }

  function finishAdOverlay() {
    // A NEW AD AFTER THE CLEAN FRAME REVEALED IS NOT A HAND-BACK. Holding it
    // keeps the cover up instead of resuming the native onto the live ad.
    const target = adUiHoldTarget();
    if (target) {
      holdAfterReveal(target);
      return;
    }
    if (!overlay.frame) {
      stopAdOverlay('ad-end');
      requestStandby(1200, false, 'ad-end');
      return;
    }
    // The worker waits for clean playlists, but Twitch's ad chrome can linger
    // for a beat. Keep covering the native player until the ad UI is gone.
    if (overlay.adEndTries < 3 && adUiPresent()) {
      overlay.adEndTries++;
      overlay.adEndTimer = setTimeout(finishAdOverlay, 1000);
      return;
    }
    stopAdOverlay('ad-end');
    requestStandby(1200, false, 'ad-end');
  }

  // The mute decision is NOT captured here any more: the authority already
  // holds it and keeps it, so a pod cannot restore a stale copy. What the swap
  // still needs from this element is its latency, so the clean player and the
  // hand-back happen on the same wall-clock second.
  function adoptNativeMute(v) {
    if (!v) return;
    overlay.nativeLat = nativeLatency(v);
  }

  function restoreHeldMute() {
    if (!overlay.held) return;
    restoreNativeVideos();
    // The claim is released by stopAdOverlay(), the single site every exit
    // passes through, so the page surface comes back at the user's CURRENT
    // intent — not at a value captured before the pod.
    overlay.held = false;
  }

  // Hiding the native video does not normally pause it, but Twitch may pause
  // when the element is occluded, and on a cold preroll the native was never
  // playing at all. If it is parked at the live edge with readyState < 3, seek
  // back two seconds first so play() has data to work with.
  // The element's own distance to the media it already holds, 0 when the
  // playhead is not inside a range (nothing to measure is nothing to trust).
  function forwardRunway(v) {
    try {
      const ct = Number(v.currentTime || 0);
      const b = v.buffered;
      let ahead = 0;
      for (let i = 0; i < (b ? b.length : 0); i++) {
        if (ct >= b.start(i) - 0.1 && ct <= b.end(i) + 0.1) ahead = Math.max(ahead, b.end(i) - ct);
      }
      return ahead;
    } catch {
      return 0;
    }
  }

  // A live element reports `duration = Infinity` (Twitch) or a duration that
  // grows; a DVR replay does not. The nudge must never move a user's rewind.
  function isLiveElement(v) {
    try {
      const d = Number(v && v.duration);
      return !isFinite(d) || d <= 0;
    } catch {
      return false;
    }
  }

  function nudgeNativeToBuffer(v) {
    if (!v) return false;
    try {
      let ahead = 0;
      let target = null;
      const ct = Number(v.currentTime || 0);
      const b = v.buffered;
      for (let i = 0; i < (b ? b.length : 0); i++) {
        if (ct >= b.start(i) - 0.1 && ct <= b.end(i) + 0.1) {
          ahead = Math.max(ahead, b.end(i) - ct);
          // THE RANGE THAT CONTAINS THE PLAYHEAD IS THE ONE THAT MATTERS. The
          // old test only looked for ranges ENDING BEFORE the playhead, so an
          // element parked at the head of a range it already holds (the exact
          // hand-back state) was left with no data in front and no nudge: it
          // sat at readyState 2 until Twitch refilled it on its own schedule.
          // Measured in the owner's ko.adlog 2026-11-15: `native-resume {ct:19.1,
          // rs:2}` then eight seconds of nothing ("travou. e pra destravar eu q
          // tenho q clicar em pause despause"). Rewinding INSIDE the range costs
          // no network: it gives play() media to start on, and Twitch's own
          // live-sync pulls the picture back to the edge right after.
          // THE RUNWAY IS THE HEALTH GATE'S, NOT HALF A SECOND. A live element
          // with 0.6 s in front is exactly the state that reports `rs:2` and
          // refuses to start: `play()` needs `HAVE_FUTURE_DATA`, and Twitch's own
          // refill is what the user ends up waiting for. Measured in his 0.8.92
          // ring 2026-11-15, the hand-back parked at `{ct:19.1, rs:2}` for 8.7 s
          // ("pra destravar eu q tenho q clicar em pause despause").
          if (b.end(i) - b.start(i) >= HEALTH_BUFFER_SEC + 0.5 && b.end(i) - ct < HEALTH_BUFFER_SEC) {
            target = Math.max(target === null ? -Infinity : target, Math.max(b.start(i), b.end(i) - HEALTH_BUFFER_SEC));
          }
        }
        if (b.end(i) < ct && b.end(i) - b.start(i) >= 1) {
          target = Math.max(target === null ? -Infinity : target, b.end(i) - 1);
        }
      }
      if (ahead >= HEALTH_BUFFER_SEC || target === null) return false;
      // Move back only into a range the element already has. Seeking to an
      // arbitrary seekable point can land in an unbuffered ad-only part and
      // leave readyState 1 (measured on kimkataguiri).
      if (target < ct - 0.25) {
        v.currentTime = target;
        // EVERY MOVE OF THE CLOCK IS IN THE RING (owner order 2026-11-13: the
        // logs are the answer, not a hint). This one is invisible by design - it
        // rewinds inside media the element already holds - and it is exactly the
        // kind of write that used to be impossible to find after the fact.
        adLog('native-nudge', {
          from: +ct.toFixed(1),
          to: +target.toFixed(1),
          ahead: +ahead.toFixed(1),
          runway: +(v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) - target : 0).toFixed(1),
          rs: v.readyState,
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // THE HAND-BACK MUST UNSTICK ITSELF. Every wave that ended with "and I have to
  // click pause/unpause to unstick it" (owner 2026-11-13, 2026-11-15 twice) was
  // the same shape: the element is handed back at readyState < 3 with nothing in
  // front of the playhead, the four retries call play() on it, play() is refused,
  // and the picture only returns when the user's own click forces Twitch to
  // rebuild. One bounded watcher replaces that click: nudge into the buffer we
  // already hold, and if the element still has not advanced, reload the source
  // ONCE - a live element that reloads lands at the live edge, which is where a
  // hand-back belongs. Both halves are logged, so "it recovered by itself" and
  // "it recovered because a timer reloaded it" are told apart by the log.
  function armNativeRecovery(v, tag) {
    if (!v) return;
    try { clearTimeout(overlay.nativeRecoverTimer); } catch { /* ignore */ }
    const ct0 = Number(v.currentTime || 0);
    // THE FIRST CHECK IS TIMED BY THE STATE, NOT BY A CONSTANT. 2500 ms is a
    // reasonable ceiling for "did it start playing on its own", but an element
    // handed back at readyState < 3 is ALREADY known-bad, and waiting 2.5 s to
    // notice is 2.5 s of frozen picture the user reports as "travou". Measured
    // in the owner's own 0.8.92 ring 2026-11-15: hand-back at `rs:4` with
    // `buf:4774.1`, then `rs:2` and `rs:1` 1.5 s later, recovered only by
    // Twitch reloading its own source 1.3 s after that. `play()` needs
    // HAVE_FUTURE_DATA, so the nudge below has to happen while the element
    // still has data in hand.
    const firstDelay = Number(v.readyState || 0) < 3 ? 700 : 2500;
    overlay.nativeRecoverTimer = setTimeout(() => {
      overlay.nativeRecoverTimer = 0;
      if (!v.isConnected || overlay.adActive) return;
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      if (resumeRefusedByUser(v)) return;
      const ct = Number(v.currentTime || 0);
      const advanced = ct - ct0;
      if (!v.paused && v.readyState >= 3 && advanced > 0.2) return; // healthy
      const nudged = nudgeNativeToBuffer(v);
      adLogState('native-recover', {
        tag,
        nudged,
        advanced: +advanced.toFixed(2),
        ct: +ct.toFixed(1),
        rs: v.readyState,
        paused: !!v.paused,
      });
      if (nudged || v.paused) {
        try {
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        } catch { /* ignore */ }
        return;
      }
      // Still frozen with data in hand: the element itself is wedged. Reloading
      // the source is the only recovery left, and on a live stream it lands at
      // the edge - the same thing his manual pause/unpause produced.
      try {
        v.load();
        adLog('native-reload', { tag, ct: +ct.toFixed(1) });
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      } catch { /* ignore */ }
    }, firstDelay);
  }

  // `seek` is only for the hand-back itself. The 300/1200/2500/4000 ms retries
  // exist to resume a paused element, and each one that ALSO seeked produced a
  // visible jump: the owner's ko.adlog 2026-11-11 has three consecutive
  // `native-catchup` rows 13, 17 and 17 s forward after the pod ended
  // ("flicked/glitched ... then advanced and returned").
  function resumeNative(v, tag, { seek = true } = {}) {
    if (!v || !v.isConnected) return;
    let seekedNow = false;
    try {
      // Hand the native back AT THE SAME OFFSET the clean player was showing.
      // The old code seeked to `buffered end - 0.5`, which is the newest frame
      // the element happens to hold: on a native that Twitch paused while it
      // was covered, that is a seek of the whole pod; on one that kept playing
      // it is a free jump forward. Both read as "the picture jumped when the
      // ad ended" (owner report 2026-11-07). Seeking to `edge - cleanLatTarget`
      // is the same wall-clock second the clean player had, so the hand-off is
      // continuous. Failure paths still land in real time.
      const from = Number(v.currentTime || 0);
      const se = nativeEdge(v);
      const cleanLat = cleanHandoffLat();
      // No usable live edge (Twitch's 2^30 sentinel, or a timeline that is not
      // seekable yet): DO NOTHING. This used to be `buffered.end - 0.5`, and
      // `buffered.end` on a live stream is the newest frame DOWNLOADED, not the
      // live edge: the element is routinely 8-300 s ahead of its own playhead
      // (his ko.adlog: `buf 305.1 ct 302.4`, `buf 80 ct 77.5`). Landing there is
      // a forward jump of the whole downloaded window, i.e. exactly the "it
      // skipped and cut the sentence the streamer was saying" report (owner
      // 2026-11-13), measured as `native-handoff {ct:18.8} ->
      // native-edge-recover {to:25.6, edge:"buffered"}` = +6.8 s past the frame
      // he was watching. The hand-back now lands on the offset he was watching
      // and lets the recovery below (which knows the watched latency) decide.
      const target = se > 0 ? Math.max(0, se - cleanLat) : from;
      // Say WHICH edge source the hand-back used: a sentinel that silently
      // became "buffered" is indistinguishable from a healthy timeline, and
      // that ambiguity is what hid the 1e9 seek for a whole pod.
      if (se <= 0) adLog('native-edge-unusable', { from: +from.toFixed(1), rs: v.readyState });
      // Twitch's native edge is the 2^30 sentinel, so `se > 0` is false on the
      // exact surface this extension spends most of its life on, and the
      // hand-back then only seeks inside buffered data — a native that sat
      // frozen through a pod keeps its old position and the live stays behind
      // by the pod's whole duration, pod after pod (owner report 2026-11-11:
      // "deixou a live com delay multiplas vezes"). The wall clock is the one
      // timeline that always exists: the edge advanced by the elapsed time, the
      // element advanced by its currentTime delta, and the difference is what
      // was missed. Seek that difference forward; nothing is fabricated.
      // ONE seek per hand-back. Both recovery paths used to run in the same
      // call against the pre-seek `from`, so the element jumped forward by the
      // pod's cost and then back to the newest buffered frame - measured in the
      // owner's log 2026-11-11: `native-edge-recover to 554.8` followed by
      // `native-catchup to 531.7` one millisecond later ("showed a part of the
      // livestream, then advanced and returned").
      //
      // The target is the wall-clock position the stream should be at, clamped
      // to the newest frame the element actually holds: seeking past
      // `buffered.end` is a guaranteed stall, and Twitch then yanks the element
      // back to the buffer head, which is the second half of the same flick.
      if (seek) {
        let want = from;
        let why = null;
        const hiddenMs = Math.max(0, Number(overlay.hiddenGapMs || 0));
        overlay.hiddenGapMs = 0; // consumed once by this hand-back
        // THESE INPUTS BELONG TO THE HAND-BACK, not to the sentinel branch
        // below: a REAL live edge exposes exactly the owner's snap-back shape.
        const ct0 = overlay.holdAt ? Number(overlay.holdCt || 0) : 0;
        const elapsed = overlay.holdAt
          ? Math.max(0, (Date.now() - overlay.holdAt - hiddenMs) / 1000)
          : 0;
        // A USABLE EDGE IS NOT NECESSARILY THE LIVE EDGE. The replica's ad-end
        // has se 14 with holdCt 0 and 14.3 s elapsed: `se - cleanLat` lands
        // inside the stitched ad, and its newest frame is the pod's own end.
        // A real Twitch hand-back has an edge (and a buffer) that advanced
        // PAST the take-over position plus the pod's wall-clock cost.
        const podExtentEdge = se > 0 && overlay.holdAt > 0
          && se <= ct0 + elapsed + 0.25
          && nativeBufferedEnd(v) <= ct0 + elapsed + 0.25;
        if (hiddenMs > 1000) {
          adLog('native-seek-declined', {
            why: 'hidden-tab', hiddenMs: Math.round(hiddenMs),
            from: +from.toFixed(1), ct0: +ct0.toFixed(1),
          });
        }
        // `cleanPos` CANNOT BE THE TARGET, and this is measured rather than a
        // matter of taste: the clean frame's `pos` is ITS OWN media element's
        // clock (0 when the frame mounts), while the native's `currentTime` is
        // the page player's clock (0 when the tab loaded). Two origins, so
        // `cleanPos - from` is meaningless - his own 0.8.95 ring shows the
        // native at `ct 33.2 / buf 38.1` while the clean frame reported
        // `pos 44.9 / lat 6.2`, i.e. the native's whole timeline is shorter than
        // the clean one. Only DELTAS are comparable: `lat` (distance to the
        // edge) and `behind` (the time the element missed). So the hand-off keeps
        // the wall clock as its clock and LOGS the numbers that decide the
        // recovery (`native-handoff`), instead of inventing a seek between
        // incomparable timelines.
        if ((se <= 0 || podExtentEdge) && overlay.holdAt) {
          // The sentinel branch below is unchanged: it is the only timeline
          // available there. Here the edge exists but points at the pod, so
          // the same wall-clock arithmetic applies until content is fed.
          const advanced = from - ct0;
          const behind = elapsed - advanced;
          // A NATIVE THAT WENT BACKWARDS RELOADED, and a reload lands AT THE
          // LIVE EDGE. Measured 2026-11-15 in the guest on a live element:
          // pausing a Twitch <video> for 22 s EMPTIES it (`ct 211.8 buf 212.9`
          // -> `ct 0 buf null rs 1`) and it resumes at the edge, not at the
          // position it held. So when `from < ct0` the deficit is not the pod's
          // cost: it is the pod plus the position the element LOST. His own
          // ko.adlog 2026-11-13 measured the arithmetic (`behind:144.9` from a
          // 42.4 s downloaded window) and the seek it justified (`to:172`, on a
          // timeline whose newest frame was 42.4) - the browser refused, the
          // element parked at rs:1, and the delay he reported ("volta com MAIOR
          // delay ainda") was never removed. A reset timeline needs NO seek:
          // the element is already where the live edge is, and nudging it is
          // what hurts.
          if (hiddenMs > 1000) {
            // declined above: a gap is not a freeze, on either edge source
          } else if (advanced < -RESUME_GAP_SEC) {
            overlay.timelineReset = true;
            adLogState('native-timeline-reset', {
              from: +from.toFixed(1),
              holdCt: +ct0.toFixed(1),
              elapsed: +elapsed.toFixed(1),
              rs: v.readyState,
            });
          } else if (behind > RESUME_GAP_SEC && behind < 3600) {
            // Land on the offset the CLEAN PLAYER was showing, not on the live
            // edge. The clean picture the owner sat watching for the whole pod
            // is `cleanLat` behind the edge (measured 2.4 s in his 2026-11-12
            // hand-off, 6-9 s in the 2026-11-11 pods). Seeking to
            // `from + behind` lands `cleanLat` PAST that picture: the last
            // frames of the pod, which he did watch, are skipped, and the frame
            // he was reading continues from a later sentence. That is the
            // reported cut. The continuous target is therefore
            // `from + behind - cleanLat`: the same wall-clock second his eyes
            // were on, which is what "the swap is invisible" means.
            want = Math.max(0, from + behind - cleanLat);
            why = 'edge-recover';
            overlay.recoverBehind = +behind.toFixed(1);
            overlay.recoverLat = +cleanLat.toFixed(1);
            if (podExtentEdge && want <= se) {
              // The offset the clean player showed is STILL INSIDE THE POD.
              // Seeking there keeps the ad on screen; refuse with both numbers
              // instead of silently spending the one recovery on ad media.
              adLogState('native-seek-skipped', {
                why: 'inside-pod',
                from: +from.toFixed(1),
                to: +want.toFixed(1),
                buffered: +nativeBufferedEnd(v).toFixed(1),
                rs: v.readyState,
                podExtent: +se.toFixed(1),
              });
              want = from;
              why = null;
              overlay.recoverBehind = 0;
              overlay.recoverLat = 0;
              // ...BUT "NO SEEK" IS NOT "NO DECISION". The refusal used to leave
              // `why = null`, and the generic catch-up three lines later then
              // seeked into exactly the media the refusal had just named
              // (`native-catchup {to:7}` on a pod extent of 14, measured in the
              // replica on 0.8.118), and the retry watcher seeked AGAIN 300 ms
              // later (`native-edge-recover {basis:'wall', to:11}`). Two seeks,
              // both inside the pod, and the element landed further back than
              // the media it already held allowed. The one landing this shape
              // earns is the END OF THE POD WE HOLD: every second before it is
              // ad media the owner should not see twice.
              const podLand = se - HEALTH_BUFFER_SEC;
              if (podLand > from + RESUME_GAP_SEC) {
                want = +podLand.toFixed(1);
                why = 'pod-end';
                overlay.recoverBehind = +behind.toFixed(1);
                overlay.recoverLat = +cleanLat.toFixed(1);
              }
            }
          }
        }
        // A DVR POSITION IS THE USER'S. With a sentinel edge the deficit maths
        // would seek to live; with a real edge the `target` below would.
        if (overlay.userDvr && hiddenMs <= 1000 && elapsed > RESUME_GAP_SEC) {
          const offsetWant = Math.max(0, ct0 + elapsed);
          if (offsetWant > from + RESUME_GAP_SEC) {
            want = offsetWant;
            why = 'user-dvr';
          } else {
            adLog('native-seek-declined', {
              why: 'user-dvr', from: +from.toFixed(1), to: +offsetWant.toFixed(1),
              ct0: +ct0.toFixed(1), elapsed: +elapsed.toFixed(1),
            });
          }
        }
        // (A pod-end landing needs no guard here: `want = se - HEALTH_BUFFER_SEC`
        // is always FURTHER than `target = se - cleanLat` for any cleanLat past
        // the runway, so `target > want` cannot hold for it. A guard that can
        // never be false is not a guard; the RED for this change targets the
        // landing itself.)
        if (target > want && hiddenMs <= 1000 && !overlay.userDvr) {
          want = target;
          why = why ? 'edge-recover+catchup' : 'catchup';
        }
        // NOT clamped to `buffered.end`: on a live stream that is not a ceiling,
        // it is simply how much media is downloaded at the OLD position, and the
        // wall-clock target is a real seekable offset (his own log: buffer ended
        // at 532.2 while the live offset was 554.8, so clamping would have kept
        // 23 s of delay for good). One target, one seek.
        //
        // EXCEPT WHEN THE ELEMENT HOLDS NOTHING AT ALL. A seek on an element
        // with no data at either end parks it at readyState 1 and it stays
        // there: play() cannot start, every retry re-logs the same refusal, and
        // Twitch only recovers when its own player rebuilds the source.
        // Measured in the owner's ko.adlog 2026-11-12 (the reported freeze):
        // `native-handoff {buf:468, ct:468, cleanPos:187.5}` ->
        // `native-edge-recover {from:468, gap:2.6, to:470.5}` ->
        // `native-resume {ct:467, rs:1}` repeated at 300/1200/2500/4000/watch
        // ms for SEVEN seconds, every one `native-edge-unusable {rs:1}`,
        // `video-pause {rs:1}` under each: "travou por uns 7 segundos". His
        // own element had been emptied by the surface restore. With a live
        // seek that the buffer cannot cover, doing nothing is the recovery: the
        // element keeps its position, Twitch refills from its live edge, and
        // the play() retries then succeed on their own.
        let covered = seekCovered(v, want);
        // The deficit (the pod's own cost) is what justifies a seek past the
        // downloaded data, not the landing distance: the landing is
        // `behind - cleanLat`, which on a short pod sits below the pod-sized
        // floor even though the deficit is a whole pod (measured 2026-11-13:
        // behind 12.2 s, cleanLat 3 s -> 9.2 s of travel, refused by a 10 s
        // floor that was meant to test the DEFICIT).
        // ...but NEVER as an override of the readiness guard. The escape hatch
        // existed to justify a LONG seek, not to justify seeking an element that
        // holds nothing: it read `covered = true` with no reference to
        // `readyState`, so the one case `seekCovered` refuses for a stated
        // reason was overridden by the very pod it was protecting. Measured in
        // the owner's own ko.adlog 2026-11-13 (0.8.90, twitch.tv/buzzyi_):
        //   native-edge-unusable {from:30.1, rs:2}
        //   native-edge-recover  {behind:144.9, from:30.1, to:172, buf:42.4}
        //   native-resume        {ct:41.4, rs:1}
        // = a seek 130 s past the last buffered frame on an element at
        // HAVE_METADATA; the browser rejected it and left the picture at rs:1.
        // Readiness is a precondition of length, never a competitor to it.
        const readyForPodSeek = Number(v.readyState || 0) >= 3;
        if (!covered && readyForPodSeek && why === 'edge-recover' && overlay.recoverBehind >= POD_RECOVER_MIN) covered = true;
        // THE ASK IS NOT THE LANDING (owner ring 2026-11-16: `to:39.7` with
        // `buffered.end` 42.3 landed at 2.6 s of runway and parked the element
        // at rs:1 until he clicked pause/unpause). Whatever the request, the
        // landing stays HEALTH_BUFFER_SEC this side of what the element holds,
        // and the row says the target it could not reach.
        const askedWant = want;
        const runwayEnd = nativeBufferedEnd(v);
        // ONLY WHEN THE EDGE IS UNUSABLE does `buffered.end` bound the landing.
        // A REAL seekable edge means hls.js will fetch from that offset, so a
        // `want` behind it is legal however much is downloaded (the cold-preroll
        // hand-back depends on it: the element sits at 0.2 s with 40 s buffered
        // and must come back at the live edge, not at `buffered.end - 3`).
        // A sentinel edge means nobody can tell what is seekable, and there the
        // newest downloaded frame is the only place `play()` can start.
        if (covered && se <= 0 && runwayEnd > 0 && want > runwayEnd - HEALTH_BUFFER_SEC) {
          const land = +(runwayEnd - HEALTH_BUFFER_SEC).toFixed(1);
          if (land > from + RESUME_GAP_SEC) want = land;
          else covered = false; // nothing landable ahead: doing nothing IS the recovery
        }
        if (!covered) {
          if (why === 'user-dvr') {
            adLog('native-seek-declined', {
              why: 'user-dvr', from: +from.toFixed(1), to: +want.toFixed(1),
              hiddenMs: Math.round(hiddenMs),
            });
          }
          adLogState('native-seek-skipped', {
            why: 'no-data',
            from: +from.toFixed(1),
            to: +want.toFixed(1),
            buffered: v.buffered && v.buffered.length ? +Number(v.buffered.end(v.buffered.length - 1)).toFixed(1) : null,
            rs: v.readyState,
          });
        } else if (want > from + RESUME_GAP_SEC) {
          v.currentTime = want;
          seekedNow = true;
          const payload = {
            from: +from.toFixed(1),
            to: +want.toFixed(1),
            gap: +(want - from).toFixed(1),
            lat: +(se > 0 ? se - want : -1).toFixed(1),
            edge: se > 0 ? 'seekable' : 'buffered',
            // The edge source and the RECOVERY source are different questions.
            // `edge` says where the position came from; `basis` says which
            // clock decided the seek, so a wall recovery on a seekable edge is
            // never silently read as a plain edge catch-up.
            basis: why === 'user-dvr' ? 'dvr'
              : (why === 'pod-end' ? 'pod-end'
                : (why && why.startsWith('edge-recover') ? 'wall' : 'edge')),
            why,
          };
          if (why.startsWith('edge-recover')) payload.behind = overlay.recoverBehind;
          // A pod-end landing names the media it landed on: `podExtent` is the
          // last frame the element holds from the pod, so the next reader can
          // tell "landed at the end of what we hold" from "landed on content".
          if (why === 'pod-end') payload.podExtent = +se.toFixed(1);
          // A clamped landing is a DIFFERENT decision from the one the wall
          // clock asked for: say both numbers, or the next reader cannot tell a
          // 16 s recovery from a 13 s one.
          if (want !== askedWant) {
            payload.asked = +askedWant.toFixed(1);
            payload.runway = +(runwayEnd - want).toFixed(1);
          }
          overlay.recoverBehind = 0;
          // A pod-end landing is NOT the recovery: it only moves the picture to
          // the end of the media the element already holds, and the wall-clock
          // recovery still has to land it on content once the buffer grows past
          // the pod. Marking it recovered would leave the element playing pod
          // media to its last frame and never reach the live offset.
          if (why.startsWith('edge-recover') || why === 'user-dvr') overlay.edgeRecovered = true;
          adLogState(why === 'user-dvr' || why.startsWith('edge-recover') ? 'native-edge-recover' : 'native-catchup', payload);
        }
        overlay.holdAt = 0;
      }
      // RETRIES: `holdAt` was consumed by the hand-back and `seek:false` kept
      // every retry from moving the picture. When the usable edge itself now
      // reports more than RESUME_GAP_SEC behind, it is the same deficit the
      // wall clock measured at hand-back: land on the offset the clean player
      // showed, clamped by the runway rule, ONCE per pod.
      if (!seek && se > 0 && !overlay.edgeRecovered && !overlay.timelineReset
          && !overlay.userDvr && overlay.hiddenGapMs <= 0) {
        const retryBehind = se - from;
        if (retryBehind > RESUME_GAP_SEC && retryBehind < 3600) {
          const askedWant = Math.max(0, from + retryBehind - cleanLat);
          let want = askedWant;
          let covered = seekCovered(v, want);
          const runwayEnd = nativeBufferedEnd(v);
          if (covered && runwayEnd > 0 && want > runwayEnd - HEALTH_BUFFER_SEC) {
            const land = +(runwayEnd - HEALTH_BUFFER_SEC).toFixed(1);
            if (land > from + RESUME_GAP_SEC) want = land;
            else covered = false; // no landing with runway: do not park the element
          }
          if (!covered) {
            adLogState('native-seek-skipped', {
              why: 'no-landing',
              from: +from.toFixed(1),
              to: +want.toFixed(1),
              buffered: runwayEnd > 0 ? +runwayEnd.toFixed(1) : null,
              rs: v.readyState,
            });
          } else if (want > from + RESUME_GAP_SEC) {
            v.currentTime = want;
            seekedNow = true;
            overlay.edgeRecovered = true;
            const payload = {
              from: +from.toFixed(1),
              to: +want.toFixed(1),
              gap: +(want - from).toFixed(1),
              lat: +(se - want).toFixed(1),
              edge: 'seekable',
              basis: 'wall',
              why: 'edge-recover-retry',
              behind: +retryBehind.toFixed(1),
            };
            if (want !== askedWant) {
              payload.asked = +askedWant.toFixed(1);
              payload.runway = +(runwayEnd - want).toFixed(1);
            }
            adLogState('native-edge-recover', payload);
          }
        }
      }
      // readyState 2 with paused=false is still a frozen frame. Nudge behind
      // live and call play() even when the element claims it is not paused.
      //
      // AND A LIVE ELEMENT HANDED BACK WITH LESS RUNWAY THAN THE HEALTH GATE IS
      // THE FREEZE ITSELF, however healthy it looks for the first second. The
      // hand-back lands on the newest frame Twitch has downloaded, which on a
      // live stream is the edge: measured in the owner's own 0.8.92 ring
      // 2026-11-15, `native-handoff {ct:4771.9, buf:4774.1}` — 2.2 s in front of
      // the playhead — then `rs:2` and `rs:1` inside 1.5 s ("travou, e pra
      // destravar eu tenho q clicar em pause despause"). Rewinding inside the
      // range costs no network and gives play() the 3 s it needs; Twitch's own
      // live-sync pulls the picture back to the edge afterwards.
      // A seek we just issued IS the position; rewinding it in the same tick
      // would undo the landing (`seekedNow`). Everything else is the state the
      // element came back in, which is what this repairs.
      if (!seekedNow && (v.readyState < 3 || (isLiveElement(v) && forwardRunway(v) < HEALTH_BUFFER_SEC))) nudgeNativeToBuffer(v);
      if (v.paused || v.readyState < 3) {
        ownPlayAt = Date.now(); // our play() is not a user takeover
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch {
      /* ignore */
    }
    // The hand-back has to answer, in one line: was it paused, did we dare move
    // it, and HOW FAR FROM THE EDGE is the picture the user is now looking at.
    // His 2026-11-15 question ("ao trocar pro outro player, não sei se tá em
    // tempo real") is the `behind` field below; without it every report needed
    // the code to be re-read instead of the log being read.
    const edgeNow = nativeEdge(v);
    const ctNow = Number(v.currentTime || 0);
    adLogState('native-resume', {
      tag,
      paused: v.paused,
      ct: +ctNow.toFixed(1),
      rs: v.readyState,
      behind: edgeNow > 0 ? +(edgeNow - ctNow).toFixed(1) : null,
      selfPaused: selfPausedRecently() ? Math.round((Date.now() - overlay.selfPausedAt) / 100) / 10 : 0,
      userParked: !!overlay.pauseBeforeAd && !overlay.coldPreroll,
    });
  }

  // Twitch can pause the native player a couple of seconds after an overlay is
  // removed, even when it was playing at the now/300ms retries. Retry past the
  // old 1200ms window. Do not click Twitch's play/pause button: its label and
  // state race with the element (measured: a click on the "Pausar" button
  // paused a native that had just resumed), so the button is not a safe resume.
  // The two guards that belong to the USER, not to the overlay lifecycle:
  //  - a hidden tab is never touched (playback starting there is what the user
  //    hears from another tab);
  //  - a native that was already PAUSED when the pod took over was parked by
  //    the user, so it is not ours to start. A cold preroll (never played, at
  //    the very beginning) is the one case where it is ours.
  // Owner report 2026-11-07: "with a paused Twitch tab in another tab,
  // something unpauses it".
  function resumeRefusedByUser(v) {
    if (!v || !v.isConnected) return true;
    if (document.visibilityState && document.visibilityState !== 'visible') return true;
    // A user pause during the pod and a player parked before it are the same
    // refusal with one exit, so the census budget does not pay twice.
    if (userPausedInPod || (overlay.pauseBeforeAd && !overlay.coldPreroll)) return true;
    return false;
  }

  // A pod that ends while the tab is hidden leaves the native paused BY US.
  // Refusing to start it in the background is right (that is the owner report),
  // but leaving it paused when the user comes back is a defect of the same
  // guard: it hands back a frozen player he never paused. One shot, on the next
  // visible tick, and only when the user did not park it himself.
  function armResumeWhenVisible(v, tag) {
    if (!v || !v.isConnected) return;
    if ((overlay.pauseBeforeAd && !overlay.coldPreroll) || userPausedInPod) return; // the user parked it
    const onVisible = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      try { document.removeEventListener('visibilitychange', onVisible, true); } catch { /* ignore */ }
      if (!v.isConnected || overlay.adActive) return;
      if ((overlay.pauseBeforeAd && !overlay.coldPreroll) || userPausedInPod) return;
      if (!v.paused) return;
      adLog('native-resume-visible', { tag, ct: +Number(v.currentTime || 0).toFixed(1) });
      resumeNative(v, `${tag}+visible`);
    };
    try { document.addEventListener('visibilitychange', onVisible, true); } catch { /* ignore */ }
  }

  function resumeNativeIfAllowed(v, tag, opts) {
    if (!v || !v.isConnected) return;
    if (overlay.adActive) return;
    if (overlay.frame && !overlay.standby) return;
    if (resumeRefusedByUser(v)) {
      // Only the visibility half is deferrable; a user-parked element never is.
      if (!(overlay.pauseBeforeAd && !overlay.coldPreroll) && !userPausedInPod) armResumeWhenVisible(v, tag);
      return;
    }
    resumeNative(v, tag, opts);
  }

  function clearOverlayStall() {
    if (!overlay.stallTimer) return;
    try { clearTimeout(overlay.stallTimer); } catch { /* ignore */ }
    overlay.stallTimer = 0;
  }

  function maybeNudgeOverlay(st, kind) {
    if (!overlay.frame || !st) return false;
    const pos = Number(st.pos);
    if (!(pos > 2)) return false;
    if ((overlay.nudgeTries || 0) >= 2) return false;
    overlay.nudgeTries = (overlay.nudgeTries || 0) + 1;
    // The clean player parks at its own live edge with no forward buffer and
    // hls.js reports bufferStalledError. Seek FORWARD to the newest frame the
    // element already holds and play again.
    // The old nudge seeked `pos - 2`, i.e. two seconds back, twice, plus the
    // catch-up's own skip: measured in the owner's ko.adlog on 2026-11-08 as 14
    // `overlay-nudge` rewind events and the complaint "a live volta vários
    // segundos". On a live stream a backward seek is exactly the delay being
    // reported, so nothing here may move the picture back.
    const hold = Number(st.buffered);
    const ahead = isFinite(hold) && hold > 0.5 ? hold - 0.3 : 0;
    overlaySend({ t: 'seek', s: Math.max(0, pos + ahead) });
    overlaySend({ t: 'play' });
    adLog('overlay-nudge', { kind: String(kind || ''), pos: +pos.toFixed(2), to: +(pos + ahead).toFixed(2), hold: isFinite(hold) ? +hold.toFixed(2) : null, tries: overlay.nudgeTries });
    return true;
  }

  function scheduleOverlayStall(kind, ms = 2500) {
    if (!overlay.frame) return;
    // One timer per overlay. A healthy Playing/rs>=3 message clears it; if the
    // clean player stays stalled we nudge it back once or twice, then restore
    // the native surface instead of leaving a frozen frame.
    if (overlay.stallTimer) return;
    overlay.stallTimer = setTimeout(() => {
      overlay.stallTimer = 0;
      if (!overlay.frame) return;
      if (maybeNudgeOverlay(overlay.lastSt, kind)) {
        scheduleOverlayStall(kind, 3000);
        return;
      }
      // A cold ad can start while the clean player is still at the beginning
      // of its window (pos <= 2), so there is nothing to rewind into yet. Keep
      // the hidden frame alive while the native ad is on screen instead of
      // stopping it; the 12s hideTimer and the ad-end path still bound it.
      const age = Date.now() - (overlay.startedAt || 0);
      if (overlay.adActive && age < 12000) {
        scheduleOverlayStall(kind, 1500);
        return;
      }
      const wasStandby = overlay.standby;
      adLog('overlay-stall-stop', {
        kind: String(kind || ''),
        revealed: overlay.revealed,
        playing: overlay.playing,
        switchPrev: !!overlay.switchPrev,
        // The samples that led here. Without them the verdict ("the clean
        // player stalled") cannot be checked against what the source was
        // actually doing, and his 2026-11-12 episode needed a join across
        // nine `playing-not-healthy` lines to see it was starved throughout.
        hist: (overlay.healthLog || []).slice(-6),
        reveals: overlay.reveals || 0,
      });
      stopAdOverlay('clean-stall');
      if (wasStandby) requestStandby(600, true, 'clean-stall');
    }, ms);
  }

  // `opts.noWait` is the wait's own re-entry: a capped wait must hand back on the
  // SAME element, not arm a second wait on a native that is still at rs 1
  // (measured: `handback-ready` followed 150 ms later by another `handback-wait`,
  // i.e. a loop for as long as the pod-end path kept being called).
  // A wait belongs to ONE hand-back. Anything that replaces the picture it is
  // protecting (a new pod, a switch, a teardown that takes another door) ends it
  // HERE, with a row: an armed wait whose frame was replaced tears the
  // replacement down 150 ms after it mounted, and a refusal nobody logged is the
  // silent-green class this repo paid for twice.
  function cancelHandbackWait(why) {
    const wait = overlay.handbackWait;
    // No early return: `clearTimeout` on 0 is a no-op, and the row is written
    // only when there WAS a wait, so ending nothing stays silent while ending
    // something is always explained.
    try { if (wait) clearTimeout(wait.timer); } catch { /* ignore */ }
    if (wait) adLog('handback-wait-cancelled', { ms: Date.now() - wait.at, why: String(why || '') });
    overlay.handbackWait = null;
    return !!wait;
  }

  function stopAdOverlay(reason, opts = {}) {
    const revealedAd = adUiHoldTarget();
    if (revealedAd) holdAfterReveal(revealedAd);
    adLayoutRelease();
    // A standby that was never adopted is invisible content behind the native
    // player. Stopping it must not post overlay-stop (that clears the worker's
    // ad state without an ad) and must not resume/seek the native player.
    const wasStandby = !!overlay.standby && !overlay.revealed && !overlay.adActive;
    // A second teardown (a source switch, a clean stall, a new pod) ends the
    // wait and proceeds: the wait exists to protect ONE hand-back, never to
    // hold a frame that something else has already decided to replace.
    cancelHandbackWait(reason);
    if (!wasStandby) overlay.lastEndAt = Date.now();
    // A POD END IS NOT A LICENCE TO PUT A FROZEN ELEMENT ON SCREEN. Measured in
    // the replica 2026-11-26 (dev-preroll-hold 1795677985765, 0.8.121):
    // `ad-ui-release {act:'pod-end'}` at 14743 ms, `native-handoff {ct:0, se:16}`
    // at 14747, `native-resume {rs:1}` x4 (15049, 15949, 17248, 18748) and the
    // first `display-clock` LIVE at ~19 s - the clean frame was torn down while it
    // was decoding (`cleanLat:6`) and the user watched a frozen native for ~4 s.
    // This runs BEFORE the frame, the badge and the audio claim are released:
    // waiting after `overlay.frame.remove()` would keep nothing on screen.
    // Only a pod end qualifies; a clean-stall/ad-only teardown has no picture to
    // wait on. Bounded by HANDBACK_WAIT_MS so a native that never recovers still
    // gets the hand-back it would have had.
    if (!opts.noWait && !overlay.handbackWait && reason === 'ad-end' && overlay.frame && overlay.revealed && cleanFrameCanCover()) {
      const wv = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
      const wrs = wv ? Number(wv.readyState) || 0 : 0;
      if (wv && wrs < 3 && !resumeRefusedByUser(wv)) {
        const wait = { at: Date.now(), reason, capped: false, timer: 0 };
        overlay.handbackWait = wait;
        const finish = () => {
          // A cancelled wait clears this timer; `active` keeps a callback that
          // was already dequeued from tearing down a pod that has moved on.
          const active = overlay.handbackWait === wait;
          const nv = active ? (overlay.video && overlay.video.isConnected ? overlay.video : mainVideo()) : null;
          const nrs = nv ? Number(nv.readyState) || 0 : 0;
          const ms = Date.now() - wait.at;
          const covered = active && cleanFrameCanCover();
          if (active) wait.blind = covered ? 0 : (wait.blind || 0) + 1;
          // ONE TRANSIENT SAMPLE IS NOT A LOST PICTURE. `cleanFrameCanCover()`
          // reads the frame's last report, and a single heartbeat whose `pos`
          // moved less than the advancing floor, or one `Paused` report, says
          // nothing about the next 150 ms: ending the wait on it reveals the
          // frozen native this change exists to keep off screen. Two
          // consecutive blind samples (300 ms) are a lost cover.
          const coverLost = !covered && (wait.blind || 0) >= 2;
          // The user's own takeover ends the wait: a fresh play on the page
          // element is a gesture, and holding OUR picture over a player he just
          // took back is the 0.8.114 pause fight from the other side.
          const why = !nv ? 'no-video' : nrs >= 3 ? 'ready' : userResumedHeld() ? 'user-resume'
            : ms >= HANDBACK_WAIT_MS ? 'cap' : coverLost ? 'cover-lost' : '';
          if (active && why) {
            overlay.handbackWait = null;
            adLogState('handback-ready', { ms, rs: nrs, capped: why === 'cap', covered, why });
            stopAdOverlay(wait.reason, { noWait: true });
          } else if (active) {
            wait.timer = setTimeout(finish, 150);
          }
        };
        wait.timer = setTimeout(finish, 150);
        return adLogState('handback-wait', { rs: wrs, cleanLat: overlay.lastSt ? +Number(overlay.lastSt.lat || 0).toFixed(1) : null, capMs: HANDBACK_WAIT_MS, ct: +Number(wv.currentTime || 0).toFixed(1) });
      }
    }
    if (wasStandby) {
      // A standby-only teardown is not a pod end. Consume any take-over stamp
      // left by an earlier episode so a later stop cannot report it as one.
      overlay.holdAt = 0;
      overlay.holdCt = 0;
      overlay.nativeHandoffLogged = true;
    }
    try { clearTimeout(overlay.extTimer); } catch { /* ignore */ }
    overlay.extTimer = 0;
    try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
    overlay.adEndTimer = 0;
    try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
    overlay.watchdogTimer = 0;
    try { clearTimeout(overlay.adoptTimer); } catch { /* ignore */ }
    overlay.adoptTimer = 0;
    clearOverlayStall();
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
    if (overlay.held) restoreHeldMute();
    // ONE release site for every exit, including the frame-less early return
    // below. A source switch can null overlay.frame while the claim is still
    // set; the early return used to skip the release, and the page stayed
    // silent until the user touched the volume bar. claim(null) is idempotent,
    // so a standby that never claimed costs nothing. Released before the frame
    // is removed is still one synchronous task: no audio renders in between.
    audioClaim(false);
    if (!overlay.frame) {
      // Even without a frame, a badge/unmute handler can be left over from a
      // source switch that failed between teardown and rebuild.
      if (overlay.switchPrev) {
        try { clearTimeout(overlay.switchPrev.timer); } catch { /* ignore */ }
        try { overlay.switchPrev.frame.remove(); } catch { /* ignore */ }
        overlay.switchPrev = null;
      }
      if (overlay.badge) { try { overlay.badge.remove(); } catch { /* ignore */ } overlay.badge = null; }
      if (overlay.cover) { try { overlay.cover.remove(); } catch { /* ignore */ } overlay.cover = null; }
      if (overlay.unmuteHandler) {
        try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
        overlay.unmuteHandler = null;
      }
      overlay.playing = false;
      overlay.healthyTicks = 0;
      overlay.nudgeTries = 0;
      overlay.lastSt = null;
      overlay.catchupAt = 0;
    overlay.catchupWaitAt = 0;
    overlay.catchupAsked = false;
    try { clearTimeout(overlay.revealTimer); } catch { /* ignore */ }
    overlay.revealTimer = 0;
      overlay.unmuteTried = false; overlay.unmuteTries = 0;
      try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
      overlay.unmuteCheck = 0;
      overlay.lastStAt = 0;
      overlay.switchTries = 0;
      overlay.rewound = false;
      overlay.revealed = false;
      overlay.coldCover = false;
    try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
    overlay.coldTimer = 0;
      overlay.nativeHidden = false;
      overlay.standby = false;
      overlay.adActive = false;
      overlay.playlistPodAt = 0;
      standbyBypassPod = null;
      standbyBypassAt = 0;
      // A HOLD THAT NEVER GOT A FRAME STILL PAUSED THE PLAYER. Since the hold no
      // longer waits for the frame, this exit is now reachable WITH the native
      // paused by it — and leaving it paused is the owner's "a live pausou e
      // tive que despausar" (2026-11-15). Nothing to hand back to: the picture
      // never left, so the only work is to start it again.
      try {
        const nv = mainVideo();
        if (!revealedAd && nv && nv.isConnected && nv.paused && !resumeRefusedByUser(nv)) {
          resumeNative(nv, 'no-frame-exit');
          armNativeRecovery(nv, 'no-frame-exit');
        }
      } catch { /* ignore */ }
      overlay.holdAt = 0;
      overlay.holdCt = 0;
      overlay.nativeHandoffLogged = true;
      return;
    }
    try { clearInterval(overlay.positionTimer); } catch { /* ignore */ }
    try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
    if (overlay.onMessage) window.removeEventListener('message', overlay.onMessage);
    if (overlay.unmuteHandler) {
      try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
      overlay.unmuteHandler = null;
    }
    if (overlay.badge) {
      try { overlay.badge.remove(); } catch { /* ignore */ }
      overlay.badge = null;
    }
    if (overlay.cover) {
      try { overlay.cover.remove(); } catch { /* ignore */ }
      overlay.cover = null;
    }
    if (overlay.switchPrev) {
      try { clearTimeout(overlay.switchPrev.timer); } catch { /* ignore */ }
      try {
        if (overlay.switchPrev.frame !== overlay.frame) overlay.switchPrev.frame.remove();
      } catch { /* ignore */ }
      overlay.switchPrev = null;
    }
    try { overlay.frame.remove(); } catch { /* ignore */ }
    if (!wasStandby) {
      // ONE row per pod, and only when THIS pod actually took over. `!wasStandby`
      // alone named every teardown as a hand-back when an earlier pod's
      // `holdAt` survived: standby timeout / ad-only / clean-stall printed
      // hand-backs at the same ct for minutes.
      const podEnd = !!overlay.holdAt && !overlay.nativeHandoffLogged;
      // Capture the position BEFORE any resume/seek; the row is emitted after
      // the recovery decision so consuming the stamp cannot change its inputs.
      let handoff = null;
      try {
        const hv = mainVideo();
        handoff = {
          replaced: !!(hv && overlay.video && hv !== overlay.video),
          ct: hv ? +Number(hv.currentTime || 0).toFixed(1) : null,
          buf: hv && hv.buffered.length ? +hv.buffered.end(hv.buffered.length - 1).toFixed(1) : null,
          se: hv && hv.seekable.length ? +hv.seekable.end(hv.seekable.length - 1).toFixed(1) : null,
          cleanPos: overlay.lastSt ? +Number(overlay.lastSt.pos || 0).toFixed(1) : null,
          cleanLat: overlay.lastSt ? +Number(overlay.lastSt.lat || 0).toFixed(1) : null,
          // WHICH instrument answered the latency: hls.js's own measure, the
          // forward buffer, or a seekable end. A 9 s steady state that never
          // closes is a different bug depending on this field.
          cleanLatSrc: (overlay.lastSt && overlay.lastSt.latSrc) || null,
          // THE INPUTS OF THE RECOVERY DECISION, in the row that starts it. The
          // verdict could only say `recovery NEVER RAN` for his 2026-11-16
          // hand-back, because `holdAt`/`holdCt` were consumed here and never
          // logged: the next reader had to re-read this file to learn whether the
          // wall clock had been stamped at all. A decision without its inputs in
          // the log is the "os logs nao devem ser hints" defect again.
          podAgeMs: overlay.holdAt ? Date.now() - overlay.holdAt : null,
          holdCt: overlay.holdCt == null ? null : +Number(overlay.holdCt).toFixed(1),
          cleanHold: overlay.lastSt && isFinite(Number(overlay.lastSt.hold)) ? +Number(overlay.lastSt.hold).toFixed(2) : null,
        };
      } catch { /* ignore */ }
      // CSS back (mute ownership never left the authority); the claim was
      // released above, so the page surface is audible again at the user's
      // CURRENT intent — including an unmute made during the pod.
      restoreNativeVideos();
      const v = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
      if (v && !revealedAd) {
        // Hand back NOW, not at the 300ms retry: the frame is still mounted and
        // adActive is still set at this point, so the lifecycle gate would
        // refuse this call and leave a frozen native for another 300ms (the
        // "player comes back and then jumps" half of the owner's report). Only
        // the user-intent guard applies here.
        if (!resumeRefusedByUser(v)) resumeNative(v, 'ad-end');
        else if (!(overlay.pauseBeforeAd && !overlay.coldPreroll)) armResumeWhenVisible(v, 'ad-end');
        // A hand-back that lands on an element with nothing in front of its
        // playhead stays frozen until something unsticks it. That something used
        // to be the owner's own pause/unpause click; this watcher replaces it.
        if (!resumeRefusedByUser(v)) armNativeRecovery(v, 'ad-end');
        // Retries resume, they do not seek: `seek: false`. Each seek after the
        // hand-back was a visible jump (measured 2026-11-11: three catchups of
        // 13, 17 and 17 s in the five seconds after ad-end).
        setTimeout(() => {
          // A new *hidden standby* must not block the native resume retries;
          // only a visible/held ad overlay should. Measured: starting the new
          // standby at ~1s prevented the 1200ms retry and left Twitch paused.
          resumeNativeIfAllowed(v, '300ms', { seek: false });
        }, 300);
        setTimeout(() => resumeNativeIfAllowed(v, '1200ms', { seek: false }), 1200);
        setTimeout(() => resumeNativeIfAllowed(v, '2500ms', { seek: false }), 2500);
        setTimeout(() => resumeNativeIfAllowed(v, '4000ms', { seek: false }), 4000);
        // A stalled clean overlay can leave Twitch's native player parked at
        // the live edge, paused, with no forward buffer. Four one-shot retries
        // are not enough: measured 2026-10-23 `jynxzi` stayed paused for ~7s
        // after clean-stall. Keep nudging it back behind live for 10s, but only
        // after a failure path, not after a normal ad-end.
        if (/clean-stall|ad-only|standby-timeout/.test(String(reason || ''))) {
          let n = 0;
          const timer = setInterval(() => {
            if (++n > 10) {
              clearInterval(timer);
              return;
            }
            if (overlay.adActive) return;
            if (overlay.frame && !overlay.standby) return;
            const nv = mainVideo();
            if (!nv || !nv.isConnected) return;
            if (!nv.paused && nv.readyState >= 3) return;
            resumeNativeIfAllowed(nv, 'watch');
          }, 1000);
        }
      }
      if (podEnd || overlay.holdAt) {
        if (podEnd && handoff) adLogState('native-handoff', handoff);
        if (podEnd) overlay.podHandoffAt = Date.now();
        overlay.holdAt = 0;
        overlay.holdCt = 0;
        overlay.nativeHandoffLogged = true;
      }
    }
    if (wasStandby) {
      bypassStats.lastStandby = { type: 'stop', reason: String(reason || ''), at: Date.now() };
    } else {
      bypassStats.stops++;
      bypassStats.last = { type: 'stop', reason: String(reason || ''), at: Date.now() };
    }
    overlay.frame = null;
    overlay.token = null;
    overlay.url = null;
    overlay.channel = null;
    overlay.video = null;
    overlay.ready = false;
    overlay.autoplayRetry = false;
    overlay.playing = false;
    overlay.healthyTicks = 0;
    overlay.nudgeTries = 0;
    overlay.lastSt = null;
    overlay.catchupAt = 0;
    overlay.unmuteTried = false; overlay.unmuteTries = 0;
    try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
    overlay.unmuteCheck = 0;
    overlay.lastStAt = 0;
    overlay.switchTries = 0;
    overlay.onMessage = null;
    overlay.rewound = false;
    overlay.revealed = false;
    overlay.coldCover = false;
    try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
    overlay.coldTimer = 0;
    overlay.nativeHidden = false;
    overlay.standby = false;
    overlay.adActive = false;
    overlay.playlistPodAt = 0;
    standbyBypassPod = null;
    standbyBypassAt = 0;
    // Tell the worker the overlay is gone so a timeout/player-error can retry
    // on a later ad playlist instead of leaving adBypassActive stuck true.
    // Standby shutdowns are invisible to the ad state machine.
    if (!wasStandby) {
      try {
        if (bypassChannel) {
          bypassChannel.postMessage({ type: 'overlay-stop', page: pageId, reason: String(reason || '') });
        }
      } catch {
        /* overlay is optional */
      }
    }
    if (wasStandby && String(reason || '') === 'standby-timeout') requestStandby(800, false, 'standby-timeout');
  }

  function revealOverlay(reason) {
    if (!overlay.frame) return;
    try { clearTimeout(overlay.adoptTimer); } catch { /* ignore */ }
    overlay.adoptTimer = 0;
    const wasStandby = overlay.standby;
    // Revealing adopts the standby into the ad path: from now on ad-end and
    // overlay-stop behave exactly like a normal clean overlay.
    if (wasStandby) {
      bypassStats.starts++;
      bypassStats.last = { type: 'start', channel: overlay.channel, at: Date.now() };
      // The standby timeout started at page load; reset it from the ad so a
      // warm player that has been running for minutes still covers the pod.
      try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
      overlay.timeoutTimer = setTimeout(() => stopAdOverlay('timeout'), 180 * 1000);
    }
    overlay.standby = false;
    overlay.adActive = true;
    // A standby that sat hidden while the tab was throttled can be far behind
    // the live edge (measured on srdogg 2026-10-25: lat 115.8s, dur 224s).
    // Revealing it would show a delayed stream and then jump forward at
    // ad-end. Seek inside the live window first and keep the native surface
    // (already muted by ad-hold) until the clean player is healthy again.
    if (wasStandby && overlay.lastSt) {
      const lat0 = Number(overlay.lastSt.lat);
      const pos0 = Number(overlay.lastSt.pos);
      if (Number.isFinite(lat0) && lat0 > CLEAN_LAT_MAX) {
        overlay.playing = false;
        overlay.healthyTicks = 0;
        catchUpClean(overlay.lastSt);
        adLog('overlay-catchup', {
          lat: +lat0.toFixed(1),
          pos: +pos0.toFixed(1),
          target: cleanLatTarget(),
          latSrc: (overlay.lastSt && overlay.lastSt.latSrc) || null,
        });
        try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
        overlay.hideTimer = setTimeout(() => {
          if (overlay.frame && !overlay.revealed && !overlay.playing) stopAdOverlay('catchup-timeout');
        }, 12000);
        return;
      }
    }
    // A revealed player must sit at the same offset the native had. A standby
    // that is only 4-8s behind is still a visible delay against the native
    // edge, so pull it in before it is shown.
    // ANY frame that is not on screen yet, not only a standby: a source switch
    // creates a fresh frame (`reason:"playing"`, `wasStandby` false) and it went
    // up at `lat 6.3` in the owner's own 2026-11-16 ring. NEVER a revealed one:
    // forcing a seek on a picture he is already watching is the jump-cut that
    // `ad-time-continuity` ("a catch-up never seeks when the buffer already
    // reaches the edge") caught the moment this gate was widened.
    if (!overlay.revealed && overlay.lastSt && Number(overlay.lastSt.lat) > cleanLatTarget() + 1.5) {
      // A SEEK AND A REVEAL IN THE SAME TICK IS A REVEAL AT THE OLD POSITION.
      // The frame applies the seek asynchronously, so raising it here puts a
      // picture on screen that is still the distance the seek was meant to
      // close. Measured in the owner's own 0.8.92 ring 2026-11-15:
      // `overlay-reveal {clean:{lat:6.3, hold:4.34}}` — six seconds behind live
      // on the first picture he saw, his report "ao trocar pro outro player,
      // não sei se tá em tempo real".
      const lat = Number(overlay.lastSt.lat);
      if (!overlay.catchupAsked) {
        // Ask once. A second ask would re-seek a frame that is already moving.
        // Nothing to seek (no buffer in hand, or it is already at the ceiling)
        // falls through: waiting would delay the picture for a move that cannot
        // happen.
        if (catchUpClean(overlay.lastSt, true)) {
          overlay.catchupAsked = true;
          overlay.catchupWaitAt = Date.now();
          try { clearTimeout(overlay.revealTimer); } catch { /* ignore */ }
          overlay.revealTimer = setTimeout(() => {
            overlay.revealTimer = 0;
            if (!overlay.frame || overlay.revealed) return;
            adLog('reveal-behind', {
              ms: Date.now() - (overlay.catchupWaitAt || Date.now()),
              lat: overlay.lastSt && Number.isFinite(Number(overlay.lastSt.lat)) ? +Number(overlay.lastSt.lat).toFixed(1) : null,
              target: cleanLatTarget(),
            });
            revealOverlay('reveal-timeout');
          }, REVEAL_AWAIT_MS);
          return;
        }
      }
      if (lat > cleanLatTarget() + 1.5 && Date.now() - overlay.catchupWaitAt < REVEAL_AWAIT_MS) {
        return; // the seek has not been reported back yet
      }
      // The frame reported the new position once it moved: raise it now.
      adLog('reveal-caught-up', {
        ms: Date.now() - (overlay.catchupWaitAt || Date.now()),
        lat: +lat.toFixed(1),
        target: cleanLatTarget(),
      });
    }
    overlay.catchupAsked = false;
    try { clearTimeout(overlay.revealTimer); } catch { /* ignore */ }
    overlay.revealTimer = 0;
    if (wasStandby || reason === 'standby') bypassStats.standbyHits++;
    if (!overlay.revealed) {
      overlay.revealed = true;
      overlay.coldCover = false;
      // Claim BEFORE the frame is raised and before the native is hidden: one
      // synchronous task, so the sound moves in the same tick as the picture
      // and neither surface is briefly doubled nor briefly silent. The
      // assertion window covers the swap: the frame's own report is reconciled
      // for AUDIO_ASSERT_MS, because a fresh media element starts muted and a
      // diffed command is never re-sent (owner report 2026-11-11: "player
      // switched, and its muted").
      audioClaim(true);
      overlay.audioAssertUntil = Date.now() + AUDIO_ASSERT_MS;
      // A NEW PICTURE IS A NEW AUTOPLAY ATTEMPT. `audioRefused` is a verdict on
      // THE FRAME THAT WAS TESTED, and it used to outlive it for the whole page
      // load: one refusal at boot silenced every later pod's clean player
      // (`overlay-audio {muted:true, refused:true}` at every reveal in the
      // owner's 0.8.111 ring, while the authority published `ad:-1.00`, i.e.
      // audible), and the only thing that cleared it was an unrelated click on
      // the page, which unmuted the pod at a random moment - his "fica mutando e
      // desmutando em hora errada". The frame in front of us is playing (that is
      // why it is being revealed), so the unmute is ours to send; if Chrome
      // still refuses, the bounded retry below declares policy again for THIS
      // frame.
      overlay.audioRefused = false;
      overlay.unmuteTried = false;
      overlay.unmuteTries = 0;
      // ...and the native stops in the same tick: see freezeNativeForPod().
      const frozen = freezeNativeForPod();
      if (frozen) adLog('native-pod-freeze', { ct: +Number(frozen.currentTime || 0).toFixed(1), rs: frozen.readyState });
      // ...and the frame is COMMANDED in that same tick, unconditionally. The
      // command is diffed against what this frame was last told, and a standby
      // was told `mute:true` when it was created, so the unmute that follows the
      // claim could be swallowed as "no change" while the arbiter had just
      // silenced the page — measured: `audio-state {audible:0, el:"1|1.00",
      // vis:"ad", wt:"1"}` = the page muted and the frame still muted, i.e. the
      // owner's "trocou pro player de 360p, MUTADO. antes eu tava DESMUTADO".
      // The claim and the command belong to the same synchronous task.
      overlay.audioSent = null;
    try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
    overlay.coldTimer = 0;
      // The clean picture is up: drop the notice panel in the same tick as the
      // frame raise, so the user never sees the panel over a playing stream.
      syncCover();
      try {
        overlay.frame.style.opacity = '1';
        overlay.frame.style.pointerEvents = 'auto';
      } catch {
        /* frame gone */
      }
      overlay.reveals = (overlay.reveals || 0) + 1;
      // "IS IT REAL TIME?" is the owner's own question (2026-11-15), and it is
      // answered by the LATENCY OF THE PICTURE THAT JUST WENT UP, not by the
      // reveal having happened. `lat`/`latSrc`/`hold` say how far behind the edge
      // the clean player is and which instrument measured it; `edgeBehind` says
      // the same for the native it is replacing, so the two surfaces can be
      // compared in one row instead of across a dozen.
      const stR = overlay.lastSt || null;
      const natR = mainVideo();
      const natEdge = natR ? nativeEdge(natR) : 0;
      adLogState('overlay-reveal', {
        n: overlay.reveals, // 2, 3, 4 ...: a re-reveal is now countable at a glance
        reason,
        rewound: overlay.rewound,
        playing: overlay.playing,
        sinceMs: overlay.revealedAt ? Date.now() - overlay.revealedAt : null,
        lat: stR && Number.isFinite(Number(stR.lat)) ? +Number(stR.lat).toFixed(1) : null,
        latSrc: (stR && stR.latSrc) || null,
        hold: stR && Number.isFinite(Number(stR.buffered)) ? +Number(stR.buffered).toFixed(2) : null,
        q: (stR && stR.q && stR.q.name) || null,
        lv: stR && stR.lv != null ? stR.lv : null,
        bw: stR && stR.bw != null ? stR.bw : null,
        target: cleanLatTarget(),
        edgeBehind: natEdge > 0 && natR ? +(natEdge - Number(natR.currentTime || 0)).toFixed(1) : null,
        advanced:
          overlay.lastRevealPos != null && overlay.lastSt && typeof overlay.lastSt.pos === 'number'
            ? +(Number(overlay.lastSt.pos) - Number(overlay.lastRevealPos)).toFixed(1)
            : null,
      });
      overlay.revealedAt = Date.now();
      overlay.lastRevealPos = overlay.lastSt && typeof overlay.lastSt.pos === 'number' ? Number(overlay.lastSt.pos) : null;
      if (overlay.switchPrev) {
        try { clearTimeout(overlay.switchPrev.timer); } catch { /* ignore */ }
        try {
          if (overlay.switchPrev.frame !== overlay.frame) overlay.switchPrev.frame.remove();
        } catch { /* ignore */ }
        overlay.switchPrev = null;
      }
    }
    if (!overlay.nativeHidden) {
      hideNativeVideos();
      overlay.nativeHidden = true;
    }
    // Audio is applied from the authority's state, diffed against what this
    // frame was last told — never re-sent on a heartbeat (the old code re-sent
    // `mute:true` once a second forever: 50 `reveal-muted` in 70 s of the
    // owner's ko.adlog, each one overwriting the unmute he had just made).
    overlaySend({ t: 'play' });
    applyOverlayAudio();
    // Chrome can refuse audible playback on a fresh frame even though the
    // gesture existed. That refusal is POLICY, not the user's decision — and it
    // must not be decided while it can still resolve. The old check declared
    // `audioRefused` at 1.5 s whenever the frame reported muted, INCLUDING a
    // frame that was already PLAYING (a muted start that simply had not been
    // told to unmute yet, or a command still in the queue). Once declared, only
    // a click on the page cleared it, which is the owner's 2026-11-13 report:
    // "tive que desmutar na mão". Now: retry the audible apply while the element
    // is playing, bounded, and declare policy only when the retries fail.
    if (!overlay.audioRefused && !overlay.unmuteTried) {
      overlay.unmuteTried = true;
      const attempt = () => {
        const st = overlay.lastSt;
        if (!overlay.frame || !st) return;
        if (!st.muted) {
          if (overlay.badge) overlay.badge.style.display = 'none';
          adLog('unmute-ok', { tries: overlay.unmuteTries || 0 });
          return;
        }
        const tries = (overlay.unmuteTries || 0) + 1;
        overlay.unmuteTries = tries;
        // A frame that is PLAYING but muted is not a policy refusal: the clean
        // player started muted by design (`if (TWITCH_HLS) V.muted = true`), and
        // the unmute is ours to send. Re-assert and look again.
        if (!st.paused && tries <= 3) {
          overlay.audioSent = null; // force re-send
          applyOverlayAudio();
          adLog('unmute-retry', { tries, muted: true, paused: false, rs: st.rs });
          try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
          overlay.unmuteCheck = setTimeout(attempt, 900);
          return;
        }
        overlay.audioRefused = true;
        overlay.audioSent = null; // force the next apply to re-send muted
        applyOverlayAudio();
        adLog('unmute-blocked', { muted: !!st.muted, paused: !!st.paused, tries });
      };
      try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
      overlay.unmuteCheck = setTimeout(attempt, 1500);
    }
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
  }

  // The overlay player (kick/yt) OWNS playback while it is selected: the native
  // Twitch player is paused by the content script, so there is no ad on screen
  // to cover and nothing to swap. A pod in that mode is damage, not protection
  // (owner 2026-11-11: "por que ele troca de player dizendo sem anuncio - 360p
  // quando eu to no player da kick que NUNCA tem anuncio?"). The attribute is
  // published by content.js on its enforcement tick.
  function ownerAttr() {
    try {
      return String(document.documentElement.getAttribute('data-ko-owner') || '');
    } catch {
      return '';
    }
  }

  // LATCH, on top of content.js's own hysteresis. Owner 2026-11-11: *"depois de
  // uns segundos, o anuncio volta, mas o player volta tambem. ficam brigando,
  // sendo que isso nao ocorria antes."* The ad path used to read the attribute
  // as a live sample: one flapping frame was enough to start a pod on a page
  // whose screen belonged to the overlay. Once the overlay has owned this page
  // at least once, a pod may only start after the attribute has been EMPTY for
  // OWNER_CLEAR_MS - so a re-buffer cannot hand the screen back to Twitch.
  // Before the first ownership (a cold open) nothing changes: there is nothing
  // to protect yet.
  const OWNER_CLEAR_MS = 4000;

  function overlayOwnsPlayback() {
    const owner = ownerAttr();
    // THE ATTRIBUTE IS A CLAIM; THE NODE IS THE PROOF. Measured 2026-11-19 on
    // twitch.tv/alanzoka (no kick channel, so no layer can exist at all): the
    // ring carried `ad-ui-on` at 188911 and `ad-ui-off {adSec:29.7}` at 218566
    // - a whole 30 s slate - with `visible {own:"kick"}` in the middle, while
    // every heartbeat in that window said `kick:null wrapShown:false` and a
    // live probe read `#ko-wrap` ABSENT. `overlayOwnsPlayback()` returned true
    // on the stale publish, `adUiHold` returned at the ownership test, and the
    // verdict could only print "NOTHING SAW AN AD" over a page that had
    // detected one. A layer that has no node in the document cannot be the
    // picture, whatever the attribute says - so ownership requires both.
    // Existence, not visibility: a layer hidden for a probe frame is still a
    // layer, and that is the flap the latch below exists for.
    let wrap = null;
    try {
      wrap = document.getElementById('ko-wrap');
    } catch {
      wrap = null;
    }
    if (!wrap) {
      // A stale publish is released immediately, latch included: there is no
      // screen to protect, so the native is free to be defended.
      if (owner) overlay.staleOwnerAt = Date.now();
      overlay.ownerSeenAt = 0;
      overlay.ownerClearAt = 0;
      return false;
    }
    if (owner) {
      overlay.ownerSeenAt = overlay.ownerSeenAt || Date.now();
      overlay.ownerClearAt = 0;
      return true;
    }
    if (!overlay.ownerSeenAt) return false; // never owned this page: cold open
    if (!overlay.ownerClearAt) overlay.ownerClearAt = Date.now();
    return Date.now() - overlay.ownerClearAt < OWNER_CLEAR_MS;
  }

  function startAdOverlay(url, channel, switchSource = false, standby = false) {
    if (!AD_OVERLAY_ENABLED) return;
    if (!url) return;
    // Mounting a frame is the same fact as "the hand-back this wait protected is
    // gone": a switched source nulls `overlay.frame`, which would make the next
    // 150 ms poll report `cover-lost` and tear the NEW frame down.
    cancelHandbackWait('start-overlay');
    if (overlayOwnsPlayback()) {
      if (overlay.adActive || overlay.standby || overlay.frame) stopAdOverlay('overlay-owns');
      return;
    }
    const prevAudioSent = overlay.audioSent;
    // A stall timer belongs to the previous frame/source. Starting a new
    // overlay/switch invalidates it; the new frame gets its own.
    clearOverlayStall();
    try { clearTimeout(overlay.adoptTimer); } catch { /* ignore */ }
    overlay.adoptTimer = 0;
    if (document.documentElement.getAttribute('data-ko-adblock') === '0') {
      stopAdOverlay('disabled');
      return;
    }
    if (!document.documentElement.getAttribute('data-ko-ext-id')) {
      // The isolated bridge sets this on its first storage callback. An ad
      // that starts in the first few hundred ms of a page load can beat it.
      if (!overlay.extTimer) {
        overlay.extTimer = setTimeout(() => {
          overlay.extTimer = 0;
          startAdOverlay(url, channel, switchSource, standby);
        }, 400);
      }
      return;
    }
    if (overlay.frame) {
      // standby-start never calls this with an existing frame; guard anyway so
      // a standby can never be reloaded into a visible player.
      if (standby) return;
      if (switchSource) {
        // 0.8.17: the old hls.js instance can stay stuck in Buffering after an
        // ad-only playlist (measured on necros). Build a fresh iframe for the
        // replacement source; this resets the MediaSource instead of calling
        // loadSource on a wedged instance.
        //
        // 0.8.26: when the old frame was already visible, keep it underneath
        // while the replacement decodes. Removing it immediately left ~2.4s of
        // black (native video was already hidden) during a long Necros pod.
        if (overlay.switchPrev && overlay.revealed) {
          // The current frame is visible; it becomes the new fallback, so the
          // older fallback (if any) can go. If the current frame was not yet
          // revealed, keep the existing visible fallback through this retry.
          try { clearTimeout(overlay.switchPrev.timer); } catch { /* ignore */ }
          try { overlay.switchPrev.frame.remove(); } catch { /* ignore */ }
          overlay.switchPrev = null;
        }
        try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
        try { clearInterval(overlay.positionTimer); } catch { /* ignore */ }
        try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
        try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
        overlay.watchdogTimer = 0;
        if (overlay.onMessage) {
          try { window.removeEventListener('message', overlay.onMessage); } catch { /* ignore */ }
        }
        if (overlay.unmuteHandler) {
          try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
          overlay.unmuteHandler = null;
        }
        if (overlay.badge) {
          try { overlay.badge.remove(); } catch { /* ignore */ }
          overlay.badge = null;
        }
        if (overlay.revealed) {
          const prev = overlay.frame;
          try { prev.style.pointerEvents = 'none'; } catch { /* ignore */ }
          try { prev.style.zIndex = '2147483646'; } catch { /* ignore */ }
          overlay.switchPrev = {
            frame: prev,
            timer: setTimeout(() => {
              const p = overlay.switchPrev;
              if (!p) return;
              try { p.frame.remove(); } catch { /* ignore */ }
              overlay.switchPrev = null;
            }, 12000),
          };
        } else {
          try { overlay.frame.remove(); } catch { /* ignore */ }
        }
        overlay.frame = null;
        overlay.onMessage = null;
        overlay.ready = false;
        overlay.playing = false;
        overlay.healthyTicks = 0;
        overlay.nudgeTries = 0;
        overlay.lastSt = null;
        overlay.catchupAt = 0;
        overlay.unmuteTried = false; overlay.unmuteTries = 0;
        try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
        overlay.unmuteCheck = 0;
        overlay.lastStAt = 0;
        overlay.standby = false;
        overlay.adActive = true;
        overlay.frameReady = false;
        overlay.queue = [];
      } else {
        // A second ad event with a fresher URL: reload the same frame and
        // cancel any pending ad-end grace timer from the previous pod.
        try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
        overlay.adEndTimer = 0;
        overlay.adEndTries = 0;
        overlay.autoplayRetry = false;
        overlay.startedAt = Date.now();
        // A long ad pod can outlast 60s; the worker's two-clean-playlist
        // `ad-end` is the normal stop, this is only a safety net.
        try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
        overlay.timeoutTimer = setTimeout(() => stopAdOverlay('timeout'), 180 * 1000);
        overlay.url = url;
        overlaySend({ t: 'load', url });
        return;
      }
    }
    const v = mainVideo();
    // A standby may win the race against Twitch's <video> element. Start the
    // hidden player anyway; positionOverlay() attaches it once the native
    // player exists. The normal ad path still waits for the native surface.
    if (!v && !standby) return;
    const extId = document.documentElement.getAttribute('data-ko-ext-id');
    const token = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.id = 'ko-adfix';
    frame.dataset.koToken = token;
    frame.src = `chrome-extension://${extId}/player.html?m=hls&tw=1&token=${encodeURIComponent(token)}`;
    frame.title = 'Clean Twitch stream (ad bypass)';
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    // No `allowFullscreen`: with an `allow` attribute present the property is
    // redundant and Chrome logs "Allow attribute will take precedence over
    // 'allowfullscreen'" on every frame (owner console 2026-11-07).
    // Keep the iframe composited while it is still invisible: `opacity:0`
    // made Chrome treat the clean player as occluded and hls.js never left
    // rs=0 (measured). 1% black over the native frame is imperceptible and
    // lets hls.js decode; on Playing we switch to opacity 1 and hide native.
    frame.style.cssText = 'position:fixed;z-index:2147483647;border:0;background:#000;opacity:0.01;pointer-events:none;left:0;top:0;width:100%;height:100%;';
    frame.addEventListener('load', () => {
      bypassStats.frameLoads = (bypassStats.frameLoads || 0) + 1;
      overlay.frameReady = true;
      flushOverlayQueue();
      if (standby && !standbyLife.frameLogged) {
        standbyLife.frameLogged = true;
        standbyLife.frameAt = Date.now();
        const ms = standbyLife.urlAt ? standbyLife.frameAt - standbyLife.urlAt : (standbyLife.requestAt ? standbyLife.frameAt - standbyLife.requestAt : null);
        adLog('standby-frame', { ms });
      }
    });
    frame.addEventListener('error', () => {
      bypassStats.frameErrors = (bypassStats.frameErrors || 0) + 1;
    });
    document.body.appendChild(frame);

    overlay.frame = frame;
    overlay.token = token;
    overlay.frameReady = false;
    overlay.queue = [];
    overlay.url = url;
    overlay.channel = channel || null;
    overlay.video = v;
    // What the previous frame was told is only useful while the SAME frame
    // keeps playing (a source switch); a new frame has been told nothing.
    overlay.audioSent = switchSource ? prevAudioSent : null;
    overlay.held = false;
    overlay.startedAt = Date.now();
    overlay.stGapMs = 0;
    overlay.ready = false;
    overlay.autoplayRetry = false;
    overlay.adEndTries = 0;
    overlay.playing = false;
    overlay.healthyTicks = 0;
    overlay.nudgeTries = 0;
    overlay.lastSt = null;
    overlay.catchupAt = 0;
    overlay.unmuteTried = false; overlay.unmuteTries = 0;
    // A fresh frame starts unmuted (autoplay is muted by the 'ready' handler),
    // so the cache must be cleared: an unmute the user asked for has to be able
    // to re-assert itself on the new frame.
    if (!switchSource) overlay.audioSent = null;
    try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
    overlay.unmuteCheck = 0;
    overlay.lastStAt = 0;
    overlay.revealed = false;
    overlay.coldCover = false;
    try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
    overlay.coldTimer = 0;
    overlay.nativeHidden = false;
    // A standby is a clean player that is already running behind the native
    // surface; it becomes an ad only when ad-hold/ad-start sets adActive.
    overlay.standby = !!standby;
    // A hidden source mounted by a cold-cover pod must not clear that pod's
    // claim: the health gate reveals it as soon as it is actually playing.
    overlay.adActive = standby ? overlay.adActive : true;
    if (!standby) overlay.playlistPodAt = overlay.playlistPodAt || Date.now();
    if (!switchSource) overlay.switchTries = 0;
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
    // Bounded fallback: if hls.js cannot reach a healthy Playing state, do not
    // reveal a black/frozen frame. Restore the native player instead. (A
    // standby must never reveal itself: it is invisible content, not an ad, so
    // it has no fallback timer.)
    // A cold pre-roll can start before the clean source has buffered anything
    // (jynxzi 2026-10-24: ad at 2.6s, prewarm.ok at 2.1s). The old 5s limit
    // stopped the overlay while it was still filling the 11s buffer, so the
    // whole first ad played. The frame stays hidden at 1% until healthy, so a
    // longer window costs no visible artifact; ad-end still stops it earlier.
    if (!standby) {
      overlay.hideTimer = setTimeout(() => {
        if (!overlay.frame || overlay.revealed) return;
        if (!overlay.playing) {
          adLog('overlay-no-playing', { reason: 'fallback-timeout' });
          stopAdOverlay('no-playing');
          return;
        }
        revealOverlay('fallback-timeout');
      }, 12000);
    }

    // Small, non-interactive indicator so the reduced-quality player is not
    // mistaken for a broken Twitch player. Positioned in positionOverlay().
    // A rebuild creates this element again. Overwriting the reference while the
    // old node stayed in the DOM is how a painted panel outlived every owner
    // (owner report 2026-11-09: the notice stayed on the normal stream until the
    // page was reloaded, and only fullscreen hid it). One node per id, always.
    for (const staleId of ['ko-adfix-badge', 'ko-adfix-cover']) {
      try {
        const old = document.getElementById(staleId);
        if (old && old !== overlay.badge && old !== overlay.cover) old.remove();
      } catch { /* ignore */ }
    }
    if (overlay.badge) { try { overlay.badge.remove(); } catch { /* ignore */ } overlay.badge = null; }
    if (overlay.cover) { try { overlay.cover.remove(); } catch { /* ignore */ } overlay.cover = null; }
    const badge = document.createElement('div');
    badge.id = 'ko-adfix-badge';
    badge.textContent = switchSource ? 'sem anúncio · trocando fonte limpa…' : 'sem anúncio · conectando fonte limpa…';
    badge.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:auto;cursor:pointer;display:none;' +
      'background:rgba(0,0,0,.72);color:#fff;font:12px/1.4 system-ui,sans-serif;' +
      'padding:3px 7px;border-radius:4px;white-space:nowrap;';
    try { document.body.appendChild(badge); } catch { /* ignore */ }
    overlay.badge = badge;
    // The cover: what the user sees while the clean source is still minting and
    // the ad must not be watched. 0.8.46 answered the "17s of black" report by
    // never painting at all, so a pod whose source never got healthy showed the
    // WHOLE ad (owner report 2026-11-08: "abri a live e tomei um anúncio
    // completo de 30 segundos"). Neither black nor the ad: an opaque panel that
    // says what is happening, above the frame (the frame's own player is black
    // until it decodes) and below nothing else.
    const cover = document.createElement('div');
    cover.id = 'ko-adfix-cover';
    cover.textContent = 'sem anúncio · carregando a live…';
    cover.style.cssText =
      'position:fixed;z-index:2147483648;pointer-events:none;display:none;' +
      'left:0;top:0;width:100vw;height:100vh;background:#000;color:#c8c8c8;' +
      'font:14px/1.4 system-ui,sans-serif;align-items:center;justify-content:center;text-align:center;';
    try { document.body.appendChild(cover); } catch { /* ignore */ }
    overlay.cover = cover;
    // A throttled tab comes back with stale state. Pull one sample on the
    // visibility edge instead of waiting for the next (possibly 30s-away) tick.
    if (!overlay.onVisible) {
      overlay.onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        if (!overlay.frame || !overlay.frameReady) return;
        overlaySend({ t: 'state' });
      };
      try { document.addEventListener('visibilitychange', overlay.onVisible); } catch { /* ignore */ }
    }
    // Do NOT hide the native video here. Measured: hiding it immediately is
    // what produced the black/buffering frame while the clean source started.
    // Keep it visible until revealOverlay() (overlay Playing or the 2.5s
    // fallback), then hide all native videos.

    overlay.onMessage = (ev) => {
      const m = ev.data && ev.data.__koKick;
      if (!m || ev.source !== overlay.frame?.contentWindow || m._koToken !== overlay.token) return;
      // A token-valid message can only come from a frame that has navigated:
      // the load event is the usual signal, this is the belt.
      if (!overlay.frameReady) {
        overlay.frameReady = true;
        flushOverlayQueue();
      }
      bypassStats.msgs = (bypassStats.msgs || 0) + 1;
      bypassStats.lastMsg = { t: m.t, state: m.st && m.st.state, st: m.st || null, at: Date.now() };
      if (m.t === 'ready') {
        overlay.ready = true;
        if (overlay.badge) overlay.badge.textContent = 'sem anúncio · carregando…';
        // Start muted so Chrome can autoplay the frame, then hand it straight to
        // the authority's state (which already includes the user's decision).
        overlaySend({ t: 'mute', m: true });
        overlay.audioSent = { muted: true, volume: audioState().volume };
        overlaySend({ t: 'load', url: overlay.url });
        overlaySend({ t: 'play' });
        return;
      }
      if (m.t === 'ev' && m.e === 'standby-level') {
        adLog('standby-level', m.d || {});
        return;
      }
      if (m.t === 'ev' && m.e === 'hls') {
        bypassStats.lastHls = { d: m.d, fatal: m.fatal, url: m.url, at: Date.now() };
        if (m.fatal) bypassStats.errors++;
        // A visible clean player that stalls must not freeze forever over the
        // hidden native video. Give it a short chance to recover, then restore
        // the native surface. Standbys are ignored: they are invisible and
        // have their own timeout/probe path.
        if (!overlay.standby && m.d === 'bufferStalledError') {
          scheduleOverlayStall('bufferStalledError');
        }
        return;
      }
      if (m.t === 'ev' && m.e === 'adstrip') {
        bypassStats.adStrips = (bypassStats.adStrips || 0) + 1;
        bypassStats.lastAdStrip = { d: m.d, at: Date.now() };
        return;
      }
      if (m.t === 'ev' && m.e === 'adstrip-error') {
        bypassStats.adStripErrors = (bypassStats.adStripErrors || 0) + 1;
        bypassStats.lastAdStripError = { d: m.d, at: Date.now() };
        return;
      }
      if (m.t === 'ev' && m.e === 'ad-only') {
        // The overlay's current token type went ad-only. Ask the worker to
        // probe another type; its ad-start rebuilds this iframe with a clean
        // master instead of leaving hls.js in Buffering.
        bypassStats.adOnly = (bypassStats.adOnly || 0) + 1;
        bypassStats.lastAdOnly = { d: m.d, at: Date.now() };
        if (overlay.standby) {
          // A standby whose token went ad-only is useless. Tear it down and
          // probe a fresh clean master; the ad path remains normal meanwhile.
          stopAdOverlay('standby-ad-only');
          requestStandby(600, true, 'standby-ad-only');
          return;
        }
        if (overlay.badge) overlay.badge.textContent = 'sem anúncio · trocando fonte limpa…';
        // The current clean source is ad-only. If it is already visible and
        // freezes, the stall timer restores the native player instead of
        // leaving a frozen frame. The switch usually finishes first.
        if (overlay.revealed) scheduleOverlayStall('ad-only', 4000);
        try {
          bypassChannel?.postMessage({ type: 'need-source', page: pageId, channel: overlay.channel || null });
        } catch {
          /* overlay is optional */
        }
        return;
      }
      if (m.t === 'ev' && m.e === 'error') {
        bypassStats.errors++;
        if (overlay.standby) {
          stopAdOverlay('standby-player-error');
          requestStandby(2000, true, 'standby-player-error');
          return;
        }
        stopAdOverlay('player-error');
        return;
      }
      if (m.t === 'ev' && m.e === 'firstframe') {
        // A standby stays hidden. Do not mark it ready from the first decoded
        // frame alone: hls.js can emit firstframe while still stalled at rs=2.
        // Readiness comes from a healthy `Playing` state below.
        if (overlay.standby && !overlay.adActive) {
          try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
          overlay.watchdogTimer = 0;
          return;
        }
        // The clean player has produced its first frame, but it may not be
        // moving yet (`playing:false` was measured on the Necros source switch).
        // Revealing that frame hides the native player and leaves the user
        // with a frozen picture. Wait for Playing instead; the native/old clean
        // frame stays visible in the meantime.
        if (!overlay.playing) {
          adLog('firstframe-not-playing', { rs: 0 });
          scheduleOverlayStall('firstframe-not-playing');
          return;
        }
        revealOverlay('firstframe');
        return;
      }
      if (m.t === 'st' && m.st) {
        // How dense the heartbeat is: in a background tab Chrome throttles the
        // frame's timer (measured gaps up to 32s in the owner's ko.adlog), so a
        // gate that COUNTS samples can never pass there. The gate below asks
        // for less evidence exactly when the evidence arrives slowly.
        const nowSt = Date.now();
        const gap = overlay.lastStAt ? nowSt - overlay.lastStAt : 0;
        if (gap > 0) overlay.stGapMs = gap;
        // HOW LONG THE FRAME HAS SAID IT CANNOT PLAY. A standby that just
        // started reports `paused` while its first segment is fetched, so one
        // report proves nothing; a RUN of them is a duration, because the frame
        // reports at 1 Hz (`player-bridge.js`). `standbyStale()` reads this to
        // tell a source that is warming from one a previous pod left paused and
        // never revealed. Reset on a new frame's first report: `startAdOverlay`
        // nulls `lastSt`, and a counter carried across frames would make every
        // replacement look stale on its first sample.
        const firstStForFrame = !overlay.lastSt;
        if (firstStForFrame) overlay.standbyPausedReports = 0;
        overlay.standbyPausedReports = m.st.paused ? (overlay.standbyPausedReports || 0) + 1 : 0;
        // Keep the PREVIOUS report beside the current one: the frozen-position
        // test below compares two samples, and `lastSt` is overwritten here.
        overlay.prevSt = overlay.lastSt;
        overlay.prevStAt = overlay.lastStAt;
        overlay.lastSt = m.st;
        overlay.lastStAt = nowSt;
        if (overlay.standby && firstStForFrame && !standbyLife.firstStLogged) {
          standbyLife.firstStLogged = true;
          const base = standbyLife.frameAt || standbyLife.urlAt || standbyLife.requestAt || 0;
          adLog('standby-firstst', {
            ms: base ? Date.now() - base : null,
            rs: m.st.rs == null ? null : m.st.rs,
            pos: typeof m.st.pos === 'number' ? +Number(m.st.pos).toFixed(2) : null,
            lat: typeof m.st.lat === 'number' ? +Number(m.st.lat).toFixed(2) : null,
            q: (m.st.q && m.st.q.name) || null,
            lv: m.st.lv == null ? null : m.st.lv,
          });
        }
        if (overlay.standby && !standbyLife.firstDecodedLogged && Number(m.st.rs) >= 3) {
          standbyLife.firstDecodedLogged = true;
          const decodedBase = standbyLife.frameAt || standbyLife.urlAt || standbyLife.requestAt || 0;
          adLog('standby-firstdecoded', {
            ms: decodedBase ? Date.now() - decodedBase : null,
            rs: m.st.rs,
            pos: typeof m.st.pos === 'number' ? +Number(m.st.pos).toFixed(2) : null,
            lat: typeof m.st.lat === 'number' ? +Number(m.st.lat).toFixed(2) : null,
            q: (m.st.q && m.st.q.name) || null,
            lv: m.st.lv == null ? null : m.st.lv,
          });
        }
        // The frame reports what its OWN element is doing. If it disagrees with
        // the state we commanded, the element was replaced or muted underneath
        // (a fresh media element starts muted, and a diffed command is never
        // re-sent). Owner report 2026-11-11: "just got an ad, player switched,
        // and its muted" — the log could not answer it because nothing recorded
        // either side. Re-assert on the DISAGREEMENT, once per change.
        // The assertion window is the SWAP (AUDIO_ASSERT_MS after the claim):
        // there, a disagreement is ours to fix and is re-sent until the frame
        // agrees. After it, the frame's own state is reported, never overridden —
        // a late disagreement is the user on the frame's controls or a browser
        // policy, and re-sending would be the mute fight the 0.8.50 wave ended.
        if (overlay.revealed && overlay.audioSent && typeof m.st.muted === 'boolean') {
          const cmd = overlay.audioSent;
          const sentAge = overlay.audioSentAt ? Date.now() - overlay.audioSentAt : null;
          const inSwap = Date.now() < (overlay.audioAssertUntil || 0);
          // Agreement clears the memory, so a disagreement that RETURNS after
          // being fixed is logged again. Without this, a cleared-then-broken
          // state would be silent for the rest of the page load.
          const volAgrees = !(typeof m.st.volume === 'number' && Math.abs(Number(m.st.volume) - cmd.volume) > 0.02);
          if (m.st.muted === cmd.muted && volAgrees) {
            overlay.audioDisagreeSince = 0;
            overlay.audioStaleLogged = false;
            overlay.audioMismatchLogged = false;
            // HOW LONG the swap was actually silent is the number the owner
            // asked for, and the old log could not give it: the disagreement
            // row named a report that might predate the command. One row per
            // command, from the command to the first report that agrees.
            if (inSwap && !overlay.audioAgreedAt) {
              overlay.audioAgreedAt = Date.now();
              adLog('audio-agreed', {
                ms: overlay.audioAgreedAt - (overlay.audioSentAt || overlay.audioAgreedAt),
                wantMuted: !!cmd.muted,
                wantVol: +Number(cmd.volume).toFixed(2),
                sends: overlay.audioSends || 0,
              });
            }
          }
          const volDiff = !volAgrees;
          if (m.st.muted !== cmd.muted || volDiff) {
            // ONE ROW PER DISAGREEMENT STREAK, never one per heartbeat. The
            // owner's rule for this log is transition-only ("teus logs nao e pra
            // ter dump inutil"), and this site broke it: his own 2026-11-13 ring
            // held 77 `audio-mismatch` rows of which 70 were the SAME `late`
            // signature ({wantMuted:true, frameMuted:false, both 0.76}) repeated
            // on every 1 Hz `st`. A repeated late disagreement is stable state,
            // not news, and 70 copies of it evicted the pod chronology he needed.
            //
            // `sentAge` alone cannot classify a disagreement: a re-send inside the
            // swap window resets it, so a real remute arriving 30 ms after a
            // re-send was excused forever — the arm "a swap disagreement the frame
            // had time to heed is still a mismatch" caught exactly that on 0.8.101.
            // The streak clock measures from the FIRST disagreeing report: one that
            // survives `AUDIO_REPORT_LAG_MS` is a mute, one that does not is a
            // report that never saw the command.
            const now = Date.now();
            if (!overlay.audioDisagreeSince) overlay.audioDisagreeSince = now;
            const held = now - overlay.audioDisagreeSince;
            const row = {
              phase: inSwap ? 'swap' : 'late',
              wantMuted: !!cmd.muted,
              frameMuted: !!m.st.muted,
              wantVol: +Number(cmd.volume).toFixed(2),
              frameVol: typeof m.st.volume === 'number' ? +Number(m.st.volume).toFixed(2) : null,
              // Our last write to the frame and its age: a value that moved with
              // NO write from us in between is the frame's own doing, and that
              // is the only way the owner's 0.93 -> 0.80 -> 0.65 -> 0.63 ramp in
              // 500 ms can be attributed.
              sentAgeMs: sentAge,
              heldMs: held,
              sends: overlay.audioSends || 0,
              asserted: inSwap,
            };
            // The lag excuse is for the SWAP only: it exists because a command of
            // ours is racing the frame's own 1 Hz report. Outside that window no
            // command is pending, so a disagreement is real on its first report
            // (the "late" arm has always asserted exactly that).
            if (inSwap && held < AUDIO_REPORT_LAG_MS) {
              if (!overlay.audioStaleLogged) {
                overlay.audioStaleLogged = true;
                adLog('audio-stale-report', row);
              }
            } else if (!overlay.audioMismatchLogged) {
              overlay.audioMismatchLogged = true;
              adLog('audio-mismatch', row);
            }
            if (inSwap) {
              overlay.audioSent = null; // force the next apply to re-send
              applyOverlayAudio();
            }
          }
        }
        // A clean player that drifted behind live must not be revealed: the
        // user would see a delayed stream and a jump at ad-end. Seek forward
        // inside the live window, at most every 2s, and let the healthy gate
        // below hold the overlay hidden until latency is back under
        // CLEAN_LAT_REVEAL_MAX. Before 2026-11-07 this only ran while an ad was
        // active and only above 20s, so a warm standby could sit 5-19s behind
        // and be revealed as-is.
        // A PAUSED STANDBY THAT IS CHASED NEVER CONVERGES. `catchUpClean` seeks
        // to `pos + hold - HEALTH_BUFFER_SEC`, and hold is the distance to the
        // newest DOWNLOADED frame: a paused playhead never moves while that
        // frontier advances at 1x, so the same seek fires again as soon as the
        // buffer grows past the gap. The owner's own 0.8.96 ring (2026-11-16,
        // twitch.tv/lua_hx, player=kick) shows it running forever:
        // `overlay-catchup {hold:8.04, lat:8, pos:82, source:"standby"}` ->
        // `{hold:9, lat:9, pos:87}` -> `{pos:93}` -> `{pos:103}` ... 20 rows over
        // two minutes, `lat` never closing, each one throwing away the hls.js
        // buffer it had just filled. A standby is caught up WHEN IT IS REVEALED
        // (revealOverlay asks once and waits for the new position), so the
        // paused case has nothing to gain and a decoder to lose.
        if ((overlay.adActive || overlay.standby) && typeof m.st.lat === 'number') {
          const pausedStandby = !!overlay.standby && !overlay.revealed && !!m.st.paused;
          if (pausedStandby) {
            const sig = String(Math.round(Number(m.st.lat)));
            if (sig !== overlay.catchupSkipSig) {
              overlay.catchupSkipSig = sig;
              adLog('overlay-catchup-skip', { why: 'standby-paused', lat: +Number(m.st.lat).toFixed(1), pos: +Number(m.st.pos || 0).toFixed(1) });
            }
          } else if (catchUpClean(m.st)) {
            overlay.catchupSkipSig = '';
          } else {
            overlay.catchupSkipSig = '';
          }
        }
        if (m.st.state === 'Playing') {
          // HAVE_FUTURE_DATA plus four seconds of forward buffer is the minimum
          // that survived the ad-heavy 2026-10-23 channels without a freeze.
          // A stalled hls.js still reports state=Playing with rs=2 and buffered=0
          // (measured on the Necros long pod); a 2s buffer was not enough on
          // kimkataguiri (it drained one second after reveal). Keep the native
          // surface up until the clean player can survive several refreshes.
          const latOk = !overlay.adActive
            || typeof m.st.lat !== 'number'
            || m.st.lat <= CLEAN_LAT_REVEAL_MAX;
          const buffered = typeof m.st.buffered === 'number' ? m.st.buffered : undefined;
          const rsOk = typeof m.st.rs !== 'number' || m.st.rs >= 3;
          // A FRAME THAT REPEATS ITS POSITION IS NOT DECODING. Measured in the
          // owner's ko.adlog 2026-11-12 (tab visible): `overlay-reveal {pos:30.2,
          // hold:5.75}` at 11.5 s and `overlay-reveal {pos:30.2, hold:7.83}` at
          // 35.8 s — the same picture position 24 s later, reported as healthy
          // both times, and the second reveal put that stale frame on screen.
          // Only when the report is fresh and the tab is visible: a throttled
          // background frame legitimately does not advance.
          // Two seconds, not one sample: the measured case was 24 s of the same
          // position reported as Playing, and a genuine sample pair 1-2 s apart
          // legitimately repeats a position on a sparse heartbeat (the
          // cold-cover fixture drives exactly that and must not be refused).
          const posFrozen = overlay.prevSt
            && overlay.prevStAt
            && Date.now() - overlay.prevStAt > 2000
            && Number(m.st.pos) > 0
            && typeof overlay.prevSt.pos === 'number'
            && Math.abs(Number(m.st.pos) - Number(overlay.prevSt.pos)) < 0.05
            && !(document.visibilityState && document.visibilityState !== 'visible');
          // A decoding frame ADVANCES; its forward-buffer snapshot oscillates
          // with segment boundaries around hls.js's liveSyncDuration. A 2.85 s
          // buffer at rs=4 that moves 1x is healthy; a frozen pos at rs=2 with
          // 0.05 s in hand is not. Progress is unknown on a sparse heartbeat,
          // so rs and the presence of forward data decide there.
          const advancing = cleanFrameAdvancing(m.st);
          const forwardOk = cleanFrameHasForward(m.st);
          const decoding = advancing !== false && forwardOk;
          const healthy = !posFrozen && latOk && rsOk && decoding;
          // NAME THE REFUSAL. A row that says `why:null` cannot answer "was this
          // gate right?" - measured on the replica 2026-11-26 (dev-preroll-hold
          // 1795677250450): `playing-not-healthy {buffered:2.917, rs:4, why:null}`
          // at 916 ms and the reveal at 1392 ms, where the frame had advanced
          // 0.07 s in 0.74 s (the provider's own start-up stall, correctly
          // refused). Without the name, that 476 ms reads as an over-strict gate.
          const refuseWhy = posFrozen ? 'pos-frozen'
            : !rsOk ? 'rs'
              : !latOk ? 'lat'
                : !cleanFrameHasForward(m.st) ? 'no-forward'
                  : advancing === false ? 'advancing'
                    : null;
          // A player that is ALREADY on screen and still decoding is not torn
          // down for a jitter dip: that cycle (unhealthy -> nudge 2s back ->
          // still thin -> stall-stop -> native returns behind) is the owner's
          // "voltou vários segundos" (ko.adlog 2026-11-08). Only a frozen
          // playhead or a loss of future data stops it now: the buffer length
          // oscillates with segment boundaries and is not that signal.
          const alive = overlay.playing && rsOk && !posFrozen && decoding;
          if (!healthy && !alive) {
            // A single healthy heartbeat is not enough. The 2026-10-23 run
            // revealed at a healthy tick and lost the buffer one second later;
            // mark the frame not-playing so a standby cannot be adopted from
            // stale state.
            overlay.healthyTicks = 0;
            overlay.playing = false;
            if (!overlay.lastUnhealthyLogAt || Date.now() - overlay.lastUnhealthyLogAt > 2000) {
              overlay.lastUnhealthyLogAt = Date.now();
              overlay.healthLog = (overlay.healthLog || []).concat([{
                ms: Math.round(performance.now()),
                rs: m.st.rs,
                buf: typeof m.st.buffered === 'number' ? +Number(m.st.buffered).toFixed(2) : null,
                pos: typeof m.st.pos === 'number' ? +Number(m.st.pos).toFixed(1) : null,
                lat: typeof m.st.lat === 'number' ? +Number(m.st.lat).toFixed(1) : null,
                why: refuseWhy,
              }]).slice(-8);
              adLog('playing-not-healthy', { rs: m.st.rs, buffered: m.st.buffered, pos: m.st.pos, why: refuseWhy, advanced: advancing, moved: (overlay.prevSt && typeof overlay.prevSt.pos === 'number' && typeof m.st.pos === 'number') ? +(Number(m.st.pos) - Number(overlay.prevSt.pos)).toFixed(2) : null, lv: m.st.lv == null ? null : m.st.lv, bw: m.st.bw == null ? null : m.st.bw });
            }
            if (!overlay.standby || m.st.pos > 2) scheduleOverlayStall('rs' + m.st.rs);
            return;
          }
          overlay.healthyTicks = (overlay.healthyTicks || 0) + 1;
          clearOverlayStall();
          const wasPlaying = overlay.playing;
          if (!overlay.playing) {
            // Two consecutive healthy samples on a dense heartbeat (the clean
            // source can report rs=4 once and then drain to 0.04s while a
            // hidden standby is still starting); ONE on a sparse one, because
            // a background tab delivers the next sample 10-30s later and the
            // fallback bound would stop a player that is perfectly fine.
            // ONE PROGRESSING SAMPLE IS HEALTHY. The playhead moved at least
            // 0.2 s since the previous report and the decoder still holds a
            // full HEALTH_BUFFER_SEC landing runway. A stalled frame repeats
            // its position or has no runway and still needs a second sample
            // on a dense heartbeat; the sparse-heartbeat rule is unchanged.
            const progressed = !!overlay.prevSt
              && typeof overlay.prevSt.pos === 'number'
              && typeof m.st.pos === 'number'
              && Number(m.st.pos) - Number(overlay.prevSt.pos) >= 0.2
              && buffered >= HEALTH_BUFFER_SEC;
            const need = (overlay.stGapMs || 0) > 1500 || progressed ? 1 : 2;
            if (overlay.healthyTicks < need) return;
            overlay.playing = true;
          }
          try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
          overlay.watchdogTimer = 0;
          if (overlay.standby && !overlay.adActive) {
            // Warm and hidden. Do not cover the native video or show a badge.
            if (!wasPlaying) {
              bypassStats.standbyReady++;
              if (!standbyLife.playLogged) {
                standbyLife.playLogged = true;
                const base = standbyLife.firstStLogged ? (standbyLife.frameAt || standbyLife.urlAt || standbyLife.requestAt || 0) : (standbyLife.requestAt || 0);
                adLog('standby-play', { ms: base ? Date.now() - base : null });
              }
            }
            return;
          }
          // The clean player is actually running: now it is safe to cover the
          // native video. Before this point the native stays visible.
          revealOverlay('playing');
          if (overlay.badge) {
            const qn = m.st.q && m.st.q.name ? m.st.q.name : 'qualidade reduzida';
            overlay.badge.textContent = m.st.muted
              ? `sem anúncio · ${qn} · clique para som`
              : `sem anúncio · ${qn}`;
          }
          bypassStats.playing++;
          if (bypassStats.last?.type !== 'playing') {
            bypassStats.last = { type: 'playing', q: m.st.q, at: Date.now() };
          }
        } else if (!overlay.autoplayRetry && Date.now() - overlay.startedAt > 2500 && Date.now() - overlay.startedAt < 9000 && m.st.paused) {
          // Autoplay-with-audio was blocked. Retry muted; native controls let
          // the user unmute without losing the clean video.
          overlay.autoplayRetry = true;
          overlay.audioRefused = true; // policy, not the user's decision
          overlay.audioSent = null;
          applyOverlayAudio();
          overlaySend({ t: 'play' });
        }
      }
    };
    window.addEventListener('message', overlay.onMessage);

    // Sound is restored on request: the native player is covered by the iframe,
    // so Twitch's own volume control is not reachable while the fallback is
    // active. A badge click is an explicit request and always counts. A generic
    // page click (chat, layout) only retries the autoplay unlock when the user
    // had sound on to begin with: it must never overrule a mute.
    const requestOverlaySound = (explicit) => {
      // Never unmute a hidden standby or a clean player that has not been
      // revealed. The standby runs 1.5-2s behind the native; unmuting it on a
      // click produced doubled/echoed audio (user report). Keep the handler
      // installed so the first click after reveal still unmutes.
      if (overlay.standby || !overlay.revealed) return;
      // A generic page click (chat, layout) is only an autoplay unlock: the
      // user already asked for sound and Chrome refused it. It must never
      // overrule a mute — before 2026-11-07 every click on the page unmuted a
      // muted user again ("or the other way round": muted, and it unmuted).
      const a = audioState();
      if (!explicit && (a.muted || !overlay.audioRefused)) return;
      overlay.audioRefused = false;
      overlay.unmuteTried = true;
      // The click is the user's answer: it becomes intent in the authority (so
      // it survives the pod, the next frame and a reload) and is applied here.
      audioIntent(false, a.volume || 1);
      overlay.audioSent = null;
      applyOverlayAudio();
      overlaySend({ t: 'play' });
      if (overlay.badge) overlay.badge.textContent = 'sem anúncio · qualidade reduzida';
      try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
      overlay.unmuteHandler = null;
    };
    overlay.unmuteHandler = () => requestOverlaySound(false);
    try { document.addEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
    try { badge.addEventListener('click', () => requestOverlaySound(true)); } catch { /* ignore */ }

    // Watchdog: the clean master can still go ad-only on its media playlist.
    // The iframe reports that, but if hls.js simply never reaches Playing we
    // must not leave a permanent black frame. Ask the worker for a different
    // source, at most twice, then restore the native player.
    try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
    overlay.watchdogTimer = setTimeout(() => {
      if (!overlay.frame || overlay.playing) return;
      if (overlay.switchTries >= 2) {
        stopAdOverlay('no-source');
        return;
      }
      overlay.switchTries++;
      if (overlay.badge) overlay.badge.textContent = 'sem anúncio · trocando fonte limpa…';
      try {
        bypassChannel?.postMessage({ type: 'need-source', page: pageId, channel: overlay.channel || null });
      } catch {
        /* overlay is optional */
      }
    }, 7000);

    positionOverlay();
    overlay.positionTimer = setInterval(positionOverlay, 500);
    // Safety net if Twitch stops requesting playlists while its <video> is
    // hidden. Long ad pods are common; the two-clean-playlist `ad-end` is the
    // normal stop. A standby is long-lived; 5min bounds its stale URL/token
    // while still covering many midrolls.
    overlay.timeoutTimer = setTimeout(
      () => stopAdOverlay(standby ? 'standby-timeout' : 'timeout'),
      (standby ? 300 : 180) * 1000
    );
    if (standby) {
      bypassStats.standbyStarts++;
      bypassStats.lastStandby = { type: 'start', channel: overlay.channel, at: Date.now() };
    } else {
      bypassStats.starts++;
      bypassStats.last = { type: 'start', channel: overlay.channel, at: Date.now() };
    }
    // The bridge may already be listening; the 'ready' handler covers a slow
    // iframe. Sending here too avoids a race on warm starts.
    setTimeout(() => {
      if (!overlay.frame) return;
      overlaySend({ t: 'mute', m: true }); // autoplay gate, corrected below
      overlay.audioSent = { muted: true, volume: audioState().volume };
      overlaySend({ t: 'load', url: overlay.url });
      overlaySend({ t: 'play' });
      applyOverlayAudio();
    }, 400);
  }

  try {
    bypassChannel = new BroadcastChannel('ko-adblock-bypass');
    bypassChannel.onmessage = (ev) => {
      const msg = ev && ev.data;
      if (!msg || typeof msg !== 'object' || msg.page !== pageId) return;
      adLog('bypass-msg', {
        type: String(msg.type || ''),
        channel: msg.channel || null,
        switch: !!msg.switch,
        hasUrl: !!msg.url,
        reason: msg.reason ? String(msg.reason).slice(0, 80) : null,
        // The playlist evidence a cover was opened from, and the ceiling that
        // closed it. `ad-hold` used to arrive here with no numbers at all.
        from: msg.from || null,
        adExtinf: msg.adExtinf === undefined ? null : msg.adExtinf,
        extinf: msg.extinf === undefined ? null : msg.extinf,
        adOnly: msg.adOnly === undefined ? null : msg.adOnly,
        hasStitched: msg.hasStitched === undefined ? null : msg.hasStitched,
        adSec: msg.adSec === undefined ? null : msg.adSec,
        adChanged: msg.adChanged === undefined ? null : msg.adChanged,
        podAgeMs: msg.podAgeMs === undefined ? null : msg.podAgeMs,
        markerAgeMs: msg.markerAgeMs === undefined ? null : msg.markerAgeMs,
      });
      if (msg.type === 'worker-ready') {
        // BroadcastChannel does not replay: the page's 200/1000/2500/5000 ms
        // cold-start requests were posted BEFORE this worker existed (owner
        // ring: worker-hook 1444 ms, first standby-start 8135 ms). Re-ask from
        // the pathname at the moment the worker can actually hear us, without
        // a new timer. requestStandby's guards still refuse a hidden tab, an
        // owned overlay or a held cold pod.
        requestStandby(0, false, 'worker-ready');
        return;
      }
      if (document.documentElement.getAttribute('data-ko-adblock') === '0') {
        stopAdOverlay('disabled');
        return;
      }
      if (msg.type === 'ad-hold') {
        if (!AD_OVERLAY_ENABLED) return;
        if (
          !overlay.adActive &&
          overlay.lastEndAt &&
          Date.now() - overlay.lastEndAt < AD_REOPEN_COOLDOWN_MS &&
          // THE ESCAPE HATCH ASKS THE SAME QUESTION THE HOLD ASKS. A bare
          // `adUiDetail()` is truthy for Twitch's PERMANENT squeezeback shell
          // (0x0, `__wrapper-hidden`, measured 2026-11-15), so the cooldown that
          // exists to stop a second cover could be unlocked by a node that is not
          // an ad at all - his "tomou anuncio DE NOVO" after our player came in.
          // `adHoldWorthy` is what decides an ad everywhere else in this file;
          // the cooldown reads the same verdict or it reads nothing.
          !adHoldWorthy(adUiDetail(), mainVideo())
        ) {
          // The playlist marker that produced the pod we just closed is still
          // there, and the page itself shows no ad. Refusing is the whole fix:
          // the marker cannot be trusted to say the ad is still running.
          adLog('ad-skip', {
            reason: 'cooldown',
            sinceEndMs: Date.now() - overlay.lastEndAt,
            adUi: null,
            markerAdExtinf: msg.adExtinf === undefined ? null : msg.adExtinf,
          });
          return;
        }
        if (overlayOwnsPlayback()) {
          // No cover, no claim, no native pause: the overlay player is what the
          // user is watching and it never carries this ad.
          adLog('ad-skip', { reason: 'overlay-owns', owner: String(document.documentElement.getAttribute('data-ko-owner') || '') });
          if (overlay.adActive) stopAdOverlay('overlay-owns');
          return;
        }
        // SPA channel switch: never reveal the previous channel's hidden
        // player. Drop it and fall through to the normal cold-start path.
        if (overlay.standby) {
          const sc = String(overlay.channel || '').toLowerCase();
          const pc = pageChannel();
          if (sc && pc && sc !== pc) stopAdOverlay('standby-channel-change');
        }
        if (overlay.frame && !overlay.standby) {
          try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
          overlay.adEndTimer = 0;
          overlay.adEndTries = 0;
          return;
        }
        if (overlay.held) return;
        // Warm standby: do NOT rewind the native. 0.8.26 rewound 5s here and
        // the user saw the live jump ~4s backwards right before the swap. The
        // standby is already at the live edge; the swap itself is 1-2ms.
        // The rewind remains only for the cold path, where the native has to
        // cover the hls.js segment fetch.
        const warmStandby = !!(overlay.standby && overlay.playing);
        if (!overlay.rewound) {
          overlay.rewound = true;
          if (warmStandby) {
            adLog('ad-rewind-skip', { reason: 'standby', seconds: AD_REWIND_SEC });
          } else {
            const rew = rewindNative(AD_REWIND_SEC);
            adLog('ad-rewind', { seconds: AD_REWIND_SEC, result: rew });
          }
        }
        const v = mainVideo();
        if (!v) return;
        overlay.held = true;
        // Live-time alignment: remember where the native sat relative to the
        // edge, and whether it was PLAYING. Both are used to (a) put the clean
        // player at the same offset so the swap is invisible, and (b) refuse to
        // start a player the user had parked (a paused tab in the background).
        overlay.nativeLat = nativeLatency(v);
        // A PAUSE WE CAUSED IS NOT A PAUSE HE CAUSED. `ad-ui-hold` pauses the
        // native seconds before this line runs, so `!!v.paused` was reading our
        // own hold back as "the user parked this player" - and that single
        // misread is the freeze: `resumeRefusedByUser()` then refused every
        // resume, and the picture stayed stopped until he clicked pause/unpause
        // (owner report 2026-11-15). The self-pause stamp is the difference.
        overlay.pauseBeforeAd = !!v.paused && !selfPausedRecently() && !overlay.coldPreroll;
        // The pod's cost, measured rather than assumed. Every pod freezes the
        // native (0.8.51 hold) and the clean picture is ~9 s behind the edge
        // while it is up (measured 2026-11-11 on buzzyi_: `overlay-catchup
        // {lat:9}` fired 70 times), so the hand-back used to resume a native
        // that had missed exactly the pod's duration and never catch it up —
        // the owner's "deixou a live com delay multiplas vezes por causa do
        // anuncio e da troca de player". Both ends are captured here: the
        // position at take-over and the wall clock that owns the edge.
        overlay.holdAt = Date.now();
        overlay.nativeHandoffLogged = false;
        overlay.podHandoffAt = 0;
        overlay.holdCt = Number(v.currentTime || 0);
        const edgeAt = nativeEdge(v);
        overlay.holdBehind = edgeAt > 0 ? Math.max(0, edgeAt - overlay.holdCt) : 0;
        overlay.userDvr = overlay.holdBehind > POD_RECOVER_MIN && overlay.holdCt > POD_RECOVER_MIN;
        overlay.hiddenGapMs = 0; // a gap BEFORE the pod is not a freeze
        overlay.timelineReset = false;
        overlay.edgeRecovered = false;
        overlay.playlistPodAt = overlay.playlistPodAt || overlay.holdAt;
        // A cold preroll is the ONLY case where a paused native is ours to
        // start: it has never played at all, so it sits at the very beginning.
        // A user-parked player is at some real position — never < 1s — and must
        // stay parked (owner report 2026-11-07: "a paused Twitch tab gets
        // unpaused by the extension").
        overlay.coldPreroll = !!v.paused && Number(v.currentTime || 0) < 1;
        // This is the takeover moment: the clean player renders the same
        // stream, so it inherits the user's decision from the authority.
        if (!overlay.revealed) adoptNativeMute(v);
        // The claim is NOT taken here: at take-over the surface on screen is
        // still the native player showing the ad, so its sound is the right
        // sound. revealOverlay() claims the moment the clean picture appears
        // (owner correction 2026-11-11: "na hora/tempo real"), and every
        // teardown releases. No element-level write here — that was the second
        // writer the arbiter replaced.
        overlay.adActive = true;
        // The clean source is still minting. Do NOT paint over the native yet:
        // raising the frame here (and hiding every native <video>) is exactly
        // what showed the owner a full black screen until the ad ended
        // (2026-11-07). The frame is an iframe with its own black background and
        // its own player, so an opaque frame with no decoded picture is a black
        // rectangle; with the native hidden there is nothing else on screen. On
        // his own Chrome that state lasted 17 s (ko.adlog: cold-cover 457399ms,
        // native hidden, then overlay-no-playing fallback-timeout 474407ms).
        //
        // Fail open instead: the native stays visible (the ad path already muted
        // it), the badge says what is happening, and revealOverlay() only raises
        // the frame once the clean player is actually playing. If it never gets
        // there, the bound below restores the native and nothing was ever black.
        // THE HOLD DOES NOT WAIT FOR THE FRAME. It used to, and `ad-hold` is
        // posted by the worker BEFORE the clean source is minted (`ad-start`
        // carries the url), so the branch never ran: nothing paused the ad and
        // nothing covered it until the mint finished. Measured in the owner's
        // own report 2026-11-15: "ad toca por uns 4 segundos até finalmente ser
        // defendido", and in his ring the paint lands on `ad-start`, one to
        // three seconds of ad later. The hold's job is to stop the ad NOW; the
        // frame's job is to replace it.
        if (!overlay.revealed && !overlay.playing) {
          overlay.coldCover = true;
          // Cover the ad, not the screen: hide the native videos and raise the
          // notice panel. An iframe with no decoded picture is a black
          // rectangle, so the frame is NOT raised here — the panel is, and
          // revealOverlay() swaps in the frame the moment the clean player is
          // playing. If it never gets there, the bound below (or the watchdog's
          // no-source stop) restores the native and nothing unexplained stays
          // on screen.
          // The native is PAUSED, not hidden (owner screenshot 2026-11-08:
          // an all-black page reading "sem anúncio · carregando a live…").
          // A paused video keeps its last decoded frame on screen, so the hold
          // freezes the live picture instead of replacing it with black, and
          // the ad is not watched because the player is stopped.
          try { pauseNativeForHold(v); } catch { /* ignore */ }
          try {
            if (overlay.cover) {
              overlay.cover.textContent = 'sem anúncio · carregando a live…';
              overlay.cover.style.display = 'flex';
            }
          } catch { /* ignore */ }
          adLog('cold-cover', {
            reason: 'ad-hold',
            painted: 'panel',
            paused: !!v.paused,
            ct: +Number(v.currentTime || 0).toFixed(1),
          });
          overlay.coldCoverAt = Date.now();
          try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
          overlay.coldTimer = setTimeout(() => {
            if (!overlay.coldCover || overlay.revealed) return;
            // Announce the branch before handing back: the reachability arm
            // (and anyone reading ko.adlog) sees WHY the hold ended. Without
            // this line the timer path was invisible and read as "resolved at
            // 15.3s by nothing" (measured guest run 2026-11-07T13:40Z).
            adLog('cold-cover-timeout', { ms: Date.now() - (overlay.coldCoverAt || Date.now()) });
            stopAdOverlay('cold-cover-timeout');
          }, COLD_COVER_BOUND_MS);
        }
        // A warm standby is already playing the clean live edge. Reveal it
        // now: this is the 0s path. If it is still buffering, adopt it here:
        // adActive makes the Playing handler reveal it without waiting for
        // ad-start, which is one more round trip in the cold path.
        if (overlay.standby) {
          if (overlay.playing) revealOverlay('standby');
        }
        return;
      }
      if (msg.type === 'ad-start') {
        if (!AD_OVERLAY_ENABLED) return;
        // A NEW POD ENDS A HAND-BACK WAIT. The wait keeps the old frame revealed
        // on purpose, so `frame && revealed` here is the normal state during it:
        // cancelling first is what lets the new pod mount (and what stops the
        // stale wait from tearing the replacement down 150 ms later).
        cancelHandbackWait('ad-start');
        overlay.playlistPodAt = overlay.playlistPodAt || Date.now();
        if (overlay.frame && overlay.standby) {
          overlay.adActive = true;
          // ad-start can arrive without ad-hold; the mute decision still
          // belongs to the native surface being covered.
          if (!overlay.held && !overlay.revealed) {
            const nv = mainVideo();
            adoptNativeMute(nv);
            if (nv) {
              overlay.nativeLat = nativeLatency(nv);
              overlay.pauseBeforeAd = !!nv.paused && !selfPausedRecently();
              overlay.coldPreroll = !!nv.paused && Number(nv.currentTime || 0) < 1;
            }
          }
          if (overlay.playing) {
            revealOverlay('standby');
            return;
          }
          // The standby was already buffering before ad-start. A young
          // standby has no chance, so rebuild almost immediately; an older
          // one is often one segment away from Playing, so give it enough
          // time to win before throwing away its decoded buffer.
          const standbyAge = Date.now() - (overlay.startedAt || 0);
          const graceMs = standbyAge >= 1200 ? 900 : 300;
          if (!overlay.adoptTimer) {
            overlay.adoptTimer = setTimeout(() => {
              overlay.adoptTimer = 0;
              if (!overlay.frame || !overlay.standby || !overlay.adActive || overlay.playing) return;
              startAdOverlay(msg.url, msg.channel, true);
            }, graceMs);
          }
          try {
            overlaySend({ t: 'play' });
          } catch {
            /* iframe may not be ready */
          }
          return;
        }
        if (overlay.frame && overlay.revealed) {
          if (msg.switch) startAdOverlay(msg.url, msg.channel, true);
          return;
        }
        startAdOverlay(msg.url, msg.channel, !!msg.switch);
        return;
      }
      if (msg.type === 'ad-end') {
        if (!AD_OVERLAY_ENABLED) return;
        finishAdOverlay();
        return;
      }
      if (msg.type === 'standby-start') {
        if (standbyPrewarm.pending) cacheStandbyPrewarm(msg);
        if (!AD_OVERLAY_ENABLED || !AD_STANDBY_ENABLED) return;
        // Ignore stale handoffs and never start over an ad, another overlay,
        // or a hidden tab. The worker re-posts on the next prewarm.
        if (msg.at && Date.now() - msg.at > 120000) return;
        const mc = String(msg.channel || '').toLowerCase();
        const pc = pageChannel();
        if (!mc || (pc && mc !== pc)) return;
        if (overlay.frame) {
          // SPA channel switch: the hidden player still shows the previous
          // channel. Replace it instead of revealing stale video on an ad.
          if (!overlay.standby) return;
          if (String(overlay.channel || '').toLowerCase() === mc) return;
          stopAdOverlay('standby-channel-change');
        }
        // A cold-cover pod has NO frame: its clean source is what ends the
        // cover, so a standby minted after ad-hold must mount while it is held.
        // A pod with a frame still refuses a second overlay.
        if ((overlay.held || overlay.adActive) && overlay.frame) return;
        if (document.visibilityState !== 'visible') return;
        if (!standbyLife.urlAt) {
          standbyLife.urlAt = Date.now();
          const ms = standbyLife.requestAt ? standbyLife.urlAt - standbyLife.requestAt : null;
          adLog('standby-url', { ms, src: String(msg.src || 'worker') });
        }
        // Do not require the native <video> here: on a fast prewarm the clean
        // URL can be ready before Twitch creates its player. positionOverlay()
        // attaches the hidden frame once the native surface exists.
        startAdOverlay(msg.url, msg.channel, false, true);
        return;
      }
      if (msg.type === 'ad-fail') {
        if (!AD_OVERLAY_ENABLED) return;
        stopAdOverlay('ad-fail');
      }
    };
  } catch {
    /* overlay is optional */
  }

  // Cold preroll: ask the worker to mint the clean source before Twitch asks
  // for the live master. The master hook is the earliest reliable point, but
  // it still lands after navigation; these retries cover the window where the
  // worker hook is still installing.
  if (isChannelPath()) {
    setTimeout(() => requestStandby(0, false, 'cold-start'), 200);
    setTimeout(() => requestStandby(0, false, 'cold-start'), 1000);
    setTimeout(() => requestStandby(0, false, 'cold-start'), 2500);
    setTimeout(() => requestStandby(0, false, 'cold-start'), 5000);
    // ONE kick per page load: idle when the browser offers it, otherwise a
    // 150 ms delay - ahead of the 200 ms cold retries, far inside the measured
    // 3-4 s cold-preroll window and clear of an existing arm's 60 ms count.
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => kickStandbyPrewarm(), { timeout: 1000 });
    else setTimeout(kickStandbyPrewarm, 150);
  }

  // SPA channel switch (owner report 2026-10-27: "it keeps the last stream").
  // Twitch changes channels without reloading the page, so this module keeps
  // running with the previous channel's clean player. The channel checks in
  // ad-hold/standby-start only cover an invisible STANDBY; an overlay that is
  // already revealed (a live pod) had no path back, so after a switch it kept
  // streaming the old channel and kept the native player hidden. Watch the
  // pathname directly — the same signal content.js uses (SPA_MS) — and hand
  // the new channel's native player back. stopAdOverlay() restores the hidden
  // videos, resumes the native player and posts overlay-stop so the worker
  // clears its ad state and can retry on the new channel.
  let routeChannel = pageChannel();
  setInterval(() => {
    const ch = pageChannel();
    if (ch === routeChannel) return;
    routeChannel = ch;
    const oc = String(overlay.channel || '').toLowerCase();
    if (overlay.frame && oc !== ch) {
      adLog('channel-change', { from: oc || null, to: ch || null, standby: !!overlay.standby, revealed: !!overlay.revealed });
      stopAdOverlay('channel-change');
    }
  }, 900);

  // The ISOLATED bridge (adblock-bridge.js) mirrors the user's toggle into
  // this attribute at document_start. Absent attribute = default ON.
  const isOn = () => {
    try {
      return (document.documentElement && document.documentElement.getAttribute('data-ko-adblock') !== '0');
    } catch {
      return true;
    }
  };

  // ---- durable recorder ----------------------------------------------------
  // Runs whether adblock is ON or OFF. This is what makes a refresh useful:
  // every content/ad transition is appended to storage with `ms` since
  // navigation, so a preroll that appears 4s after load is still measurable
  // after the tab has moved on.
  const rec = { ad: false, playing: false, adSince: 0, lastTick: 0, netSeen: new Map() };
  function videoInfo(v) {
    if (!v) return null;
    return {
      ct: Math.round(v.currentTime * 10) / 10,
      dur: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
      w: v.videoWidth,
      h: v.videoHeight,
      rs: v.readyState,
      paused: v.paused,
      muted: v.muted,
    };
  }
  function sampleVideo() {
    try {
      const vs = [...document.querySelectorAll('video')];
      const v =
        vs.find((x) => x.isConnected && !x.paused && x.videoWidth > 0) ||
        vs.find((x) => x.videoWidth > 0) ||
        vs[0] ||
        null;
      return videoInfo(v);
    } catch {
      return null;
    }
  }
  function recLog(ev, detail) {
    adLog(ev, Object.assign({ video: sampleVideo(), adblock: isOn() }, detail || {}));
  }

  try {
    for (const type of ['playing', 'pause', 'waiting', 'stalled', 'loadedmetadata', 'emptied', 'error']) {
      document.addEventListener(
        type,
        (e) => {
          const t = e && e.target;
          if (!t || t.tagName !== 'VIDEO') return;
          recLog('video-' + type, { targetMuted: !!t.muted });
        },
        true,
      );
    }
  } catch {
    /* recorder is best-effort */
  }

  // Resource timing catches the ad SDK / creative requests even when the
  // adblock fetch hook is disabled, and gives a timestamp before the ad UI.
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const u = String(e.name || '');
        if (!/edge\.ads\.twitch\.tv|amazon-adsystem|doubleclick|imasdk|ads\.twitch/i.test(u)) continue;
        const key = u.slice(0, 120);
        const prev = rec.netSeen.get(key) || 0;
        if (Date.now() - prev < 800) continue;
        rec.netSeen.set(key, Date.now());
        if (rec.netSeen.size > 40) {
          const first = rec.netSeen.keys().next().value;
          rec.netSeen.delete(first);
        }
        adLog('ad-net', {
          url: u.slice(0, 180),
          start: Math.round(e.startTime || 0),
          dur: Math.round(e.duration || 0),
          initiator: String(e.initiatorType || ''),
        });
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch {
    /* PerformanceObserver is optional */
  }

  setInterval(() => {
    try {
      const adDetail = adUiDetail();
      // Presence is not an ad: Twitch keeps a squeezeback wrapper shell in the
      // DOM permanently, and a banner must never cost the user his picture.
      // The same predicate that gates the hold now gates the log and the tick,
      // so `ad-ui-on` can never name a node that is not worth pausing for.
      const ad = adHoldWorthy(adDetail, mainVideo());
      // A PLAYLIST POD HAS NO DOM SIGNAL TO DRIVE `adUiHoldTick`, so its freeze
      // is re-asserted here or not at all. Measured (owner ring 0.8.111): the
      // native ran the whole 30 s pod under a revealed frame and handed back at
      // `buf - ct = 1.9 s`, which is the freeze at the worst possible moment.
      // Nothing to do costs one `.paused` read; a re-pause is the page's own
      // play() being undone, which is the hold's documented job since 0.8.51.
      if (overlay.adActive || overlay.revealed) freezeNativeForPod();
      if (ad !== rec.ad) {
        const since = rec.adSince;
        // THE EPISODE BOUNDARY IS THE ONLY PLACE A REASON CANNOT GO STALE. The
        // dedupe in `adUiTickSkip` is what stops one row per 500 ms tick, and a
        // dedupe that survives its episode is what makes the SECOND pod silent
        // (measured 2026-11-20: 52 `ad-tick` rows and zero reason rows across a
        // whole ring). Cleared in BOTH directions, before either handler runs.
        const prev = {
          why: adUiTickWhy || null,
          held: !!adUiHeldAt,
          heldMs: adUiHeldAt ? Date.now() - adUiHeldAt : 0,
          reasserts: adUiReasserts,
        };
        adUiTickWhy = '';
        rec.ad = ad;
        if (ad) rec.adSince = Date.now();
        rec.lastTick = 0;
        recLog(ad ? 'ad-ui-on' : 'ad-ui-off', {
          // Never derive a duration from adSince=0; that printed epoch seconds.
          adSec: ad ? 0 : since ? Number(((Date.now() - since) / 1000).toFixed(1)) : null,
          match: adDetail,
          // WHY THIS POD WAS OR WAS NOT HELD, ON THE ROW THAT IS ALWAYS WRITTEN.
          // On `ad-ui-on` it is the state the hold has to work with (a warm
          // standby is not a cover); on `ad-ui-off` it is the verdict. This is
          // the question the ring must answer without reading the code.
          hold: ad
            ? {
                standby: !!overlay.standby,
                adActive: !!overlay.adActive,
                revealed: !!overlay.revealed,
                frame: !!overlay.frame,
                own: overlayOwnsPlayback(),
              }
            : prev,
        });
        // THE AD UI IS THE AD, and it appears one segment-refresh before the
        // worker's playlist probe can prove it. Owner report 2026-11-15: "ad
        // toca por uns 4 segundos até finalmente ser defendido". Pausing here
        // costs nothing when the pod arrives a moment later (it pauses the
        // same element) and covers the window where nothing else knew.
        //
        // AND IT IS RETRIED, BECAUSE THE DETECTION AND THE HOLD DISAGREE ABOUT
        // HIDDEN TABS (measured 2026-11-19). `adUiDetail()` reads the DOM, which
        // a background tab keeps updating; `adUiHold` refuses to pause a page
        // the user is not looking at. So when a pod's whole UI appears while the
        // tab is in the background, the ONE transition that could hold it is the
        // one moment the hold is not allowed to - and nothing ever asked again.
        // His ring (0.8.100, twitch.tv/alanzoka, 30.0 s of a whole pod): the ad
        // went `ad-ui-on` at 188911 with `hidden:true` on the very next row, the
        // same line at 200850 and 203141, and the slate cleared at 218566
        // (`ad-ui-off {adSec:29.7}`) - `ad-ui-hold` was NEVER written, and no
        // `ad-skip` existed to say why. `adUiHoldTick` already re-asserts a pause
        // every tick for a tab that IS visible; the same tick now gets the
        // chance to take it the moment the tab comes back inside the episode.
        adUiHiddenLogged = false;
        adUiUserResumeAt = 0;
        adUserResumeLogged = false;
        // A new episode starts with no user pause recorded: the stamp exists to
        // survive THIS pod's hand-back, not the page load.
        userPausedInPod = false;
        userPauseLogged = false;
        userPauseRefusedLogged = false;
        if (!overlay.revealed) adAfterRevealLogged = false;
        adUiOwnerLogged = false;
        if (ad) {
          // A flap inside the ad-ui-off linger must keep the pod alive.
          try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
          overlay.adEndTimer = 0;
          overlay.adEndTries = 0;
          adUiHold(adDetail);
        } else {
          adUiRelease(true);
        }
        if (!ad) rec.adSince = 0;
      } else if (ad) {
        // The episode is still running and the hold has not taken yet: this is
        // the retry. Both callees early-return on "already held", so a tick that
        // has nothing to do costs nothing.
        adUiHold(adDetail);
      }
      const v = sampleVideo();
      const playing = !!(v && !v.paused && v.w > 0 && v.rs >= 2);
      if (playing !== rec.playing) {
        rec.playing = playing;
        // A video playing while the ad UI is up is the ad creative, not
        // content. Label it separately so content->ad is unambiguous.
        recLog(playing ? (ad ? 'ad-video-play' : 'content-play') : 'content-stop', { ad });
      }
      if (ad) adUiHoldTick();
      // THE PARK FLAG IS DERIVED, so no exit path can leave it set: a pod that
      // ended, a hold that expired and a page that resumed itself all clear it
      // here within one tick. `content.js` reads it when stamping a pause.
      publishAdPark();
      if (ad && Date.now() - rec.lastTick > 1000) {
        rec.lastTick = Date.now();
        recLog('ad-tick', { adSec: Number(((Date.now() - rec.adSince) / 1000).toFixed(1)) });
      }
    } catch {
      /* DOM can be mid-mutation */
    }
  }, 500);
  // At document_start the bridge has not applied storage yet, so logging
  // `adblock` here would always say true. Log the resolved state after the
  // async storage read has had time to set the attribute.
  adLog('recorder-start', { href: location.href, video: sampleVideo() });
  setTimeout(() => recLog('recorder-ready', { href: location.href }), 500);

  function rewriteTokenBody(body) {
    if (typeof body !== 'string' || body.length < 8) return body;
    if (!body.includes('PlaybackAccessToken') && !body.includes('playerType')) return body;
    try {
      const parsed = JSON.parse(body);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      let changed = false;
      for (const item of items) {
        const v = item && item.variables;
        if (!v || typeof v !== 'object') continue;
        // Some token calls omit playerType entirely; a live/VOD request with
        // no type must be forced to popout too, otherwise Twitch defaults to
        // the ad-bearing site player.
        if (typeof v.playerType !== 'string') {
          if (v.isLive !== true || v.isVod === true) continue;
        }
        const before = v.playerType;
        v.playerType = PLAYER_TYPE;
        if (typeof v.platform === 'string') v.platform = CLEAN_PLATFORM;
        stats.lastPlayerType = { before: before || '(none)', after: PLAYER_TYPE };
        if (before === 'picture-by-picture') stats.pbpRewrites = (stats.pbpRewrites || 0) + 1;
        changed = true;
      }
      if (!changed) return body;
      stats.rewrites++;
      return JSON.stringify(parsed);
    } catch {
      return body;
    }
  }

  // ---- VOD CSAI ad-decision block -----------------------------------------
  // VOD pre-roll/mid-roll ads are not in the HLS manifest; the player fetches
  // an ad creative from edge.ads.twitch.tv and renders it over paused content.
  // Community scripts use an empty ad list ([]) as the safe "no ads" shape.
  // Keep this to ad hosts only; normal Twitch requests are untouched.
  const AD_CREATIVE_HOSTS = new Set([
    'edge.ads.twitch.tv',
    'imasdk.googleapis.com',
    'securepubads.g.doubleclick.net',
    'pubads.g.doubleclick.net',
  ]);
  function isAdCreativeUrl(value) {
    try {
      const u = new URL(String(value || ''), location.href);
      return AD_CREATIVE_HOSTS.has(u.host);
    } catch {
      return false;
    }
  }
  function isAdTelemetryUrl(value) {
    try {
      const u = new URL(String(value || ''), location.href);
      if (u.host === 'countess.twitch.tv') return true;
      return u.host === 'spade.twitch.tv' && /ad|midroll|preroll|video_ad/i.test(u.pathname + u.search);
    } catch {
      return false;
    }
  }
  function emptyAdResponse() {
    stats.vodAdsBlocked = (stats.vodAdsBlocked || 0) + 1;
    return new Response('[]', {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    });
  }
  function noContentResponse() {
    return new Response('', { status: 204, statusText: 'No Content' });
  }

  // ---- layer 1: page fetch / XHR token rewrite -----------------------------
  try {
    const realFetch = window.fetch;
    if (typeof realFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          if (!isOn()) return realFetch.apply(this, arguments);
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (isAdCreativeUrl(url)) return Promise.resolve(emptyAdResponse());
          if (isAdTelemetryUrl(url)) return Promise.resolve(noContentResponse());
          if (url.includes('gql.twitch.tv/gql') && init && typeof init.body === 'string') {
            const next = rewriteTokenBody(init.body);
            if (next !== init.body) init = { ...init, body: next };
          }
        } catch {
          /* never break a page request */
        }
        // MUST forward the possibly-rewritten `init`. The old code used
        // `arguments`, so the playout token body stayed ad-bearing even
        // though stats.rewrites incremented — the exact failure that let a
        // midroll through.
        return realFetch.call(this, input, init);
      };
    }
  } catch {
    /* best-effort */
  }

  try {
    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    const xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__koUrl = String(url);
        if (isOn() && isAdCreativeUrl(url)) {
          // A data: URL makes the ad-decision XHR resolve with [] without a
          // network request; 4xx/5xx would make the player retry the break.
          this.__koBlockedAd = true;
          stats.vodAdsBlocked = (stats.vodAdsBlocked || 0) + 1;
          return xhrOpen.call(this, method, 'data:application/json;base64,' + btoa('[]'), true);
        }
      } catch {
        /* ignore */
      }
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function () {
      // data: URLs reject custom headers (edge.ads.twitch.tv sends some).
      if (this.__koBlockedAd) return;
      return xhrSetRequestHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (!this.__koBlockedAd && isOn() && String(this.__koUrl || '').includes('gql.twitch.tv/gql')) {
          const next = rewriteTokenBody(body);
          if (next !== body) arguments[0] = next;
        }
      } catch {
        /* ignore */
      }
      return xhrSend.apply(this, arguments);
    };
  } catch {
    /* best-effort */
  }

  // ---- layer 2: blob-worker HLS hook ---------------------------------------
  // Self-contained function serialized into the replacement worker.
  function workerMain() {
    const workerId = Math.random().toString(36).slice(2, 6);
    // Legacy playlist-swap code is kept but disabled: the clean autoplay
    // variant uses an MSE profile Twitch's web player cannot append, so
    // swapping left the player permanently paused. 0.8.15 uses the separate
    // hls.js overlay instead (see the page-side code above).
    const ALL_AD_FALLBACK = false;
    // 0.8.20: the client-side fallback ladder. The page covers the native
    // player with a clean lower-quality HLS stream during stitched ads. This
    // is opt-out via the adblock toggle (data-ko-adblock=0).
    const AD_BYPASS_ENABLED = true;
    const realFetch = self.fetch.bind(self);
    const cleanCache = new Map();
    const mediaFallbackCache = new Map();
    let lastChannel = null;
    let lastMaster = null;
    let debugChannel = null;
    let bypassChannel = null;
    try {
      debugChannel = new BroadcastChannel('ko-adblock-debug');
    } catch {
      debugChannel = null;
    }
    try {
      bypassChannel = new BroadcastChannel('ko-adblock-bypass');
    } catch {
      bypassChannel = null;
    }

    function postBypass(msg) {
      if (!bypassChannel) return;
      try {
        bypassChannel.postMessage({
          ...msg,
          at: Date.now(),
          worker: workerId,
          page: typeof __KO_PAGE_ID !== 'undefined' ? __KO_PAGE_ID : '',
        });
      } catch {
        /* overlay is optional */
      }
    }
    // The worker is installed by the page's Worker hook; the page's early
    // cold-start posts are already gone by then. Ask for one fresh request at
    // the earliest point we can receive it instead of waiting for the first
    // master fetch (the owner's 8135 ms standby-start).
    postBypass({ type: 'worker-ready' });

    if (bypassChannel) {
      bypassChannel.onmessage = (ev) => {
        const msg = ev && ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (typeof __KO_PAGE_ID !== 'undefined' && msg.page !== __KO_PAGE_ID) return;
        if (msg.type === 'overlay-stop') {
          adBypassActive = false;
          cleanPlaylistStreak = 0;
          debugLog('bypass.overlayStop', { reason: String(msg.reason || '').slice(0, 60) });
        } else if (msg.type === 'need-source' && adBypassActive) {
          switchCleanSource(msg.channel || lastChannel);
        } else if (msg.type === 'standby-request') {
          // Page asks for a hidden clean player (after ad-end, tab visible,
          // or a standby token went bad). Re-use a fresh prewarm or probe.
          const ch = msg.channel || lastChannel;
          if (!ch || adBypassActive || bypassBusy) return;
          if (msg.force && !prewarm.busy) {
            prewarm = { channel: null, url: null, at: 0, busy: false };
          }
          if (prewarm.channel === ch && prewarm.url && Date.now() - prewarm.at < PREWARM_TTL) {
            postBypass({ type: 'standby-start', channel: ch, url: prewarm.url });
          } else {
            prewarmCleanSource(ch);
          }
        }
      };
    }

    function debugLog(step, detail) {      if (!debugChannel) return;
      try {
        debugChannel.postMessage({
          type: 'debug',
          at: Date.now(),
          worker: workerId,
          page: typeof __KO_PAGE_ID !== 'undefined' ? __KO_PAGE_ID : '',
          step,
          detail: detail || null,
        });
      } catch {
        /* diagnostics only */
      }
    }

    function playlistInfo(text) {
      const lines = String(text || '').replace(/\r/g, '').split('\n');
      const extinf = lines.filter((l) => l.startsWith('#EXTINF'));
      const adExtinf = extinf.filter((l) => !/,live\s*$/.test(l));
      return {
        lines,
        extinf: extinf.length,
        adExtinf: adExtinf.length,
        adOnly: extinf.length > 0 && adExtinf.length === extinf.length,
        hasStitched: /stitched|X-TV-TWITCH-AD-URL|twitch-stitched-ad/i.test(text),
        adExtinfSamples: adExtinf.slice(0, 3).map((l) => l.slice(0, 160)),
      };
    }

    function digestPlaylist(url, text, changed) {
      if (!debugChannel || typeof text !== 'string') return;
      try {
        const info = playlistInfo(text);
        debugChannel.postMessage({
          type: 'playlist',
          at: Date.now(),
          worker: workerId,
          page: typeof __KO_PAGE_ID !== 'undefined' ? __KO_PAGE_ID : '',
          url: String(url || '').slice(0, 300),
          len: text.length,
          extinf: info.extinf,
          adExtinf: info.adExtinf,
          adExtinfSamples: info.adExtinfSamples,
          hasStitched: info.hasStitched,
          adOnly: info.adOnly,
          changed: changed || false,
          sample: text.slice(0, 1200),
        });
      } catch {
        /* diagnostics only */
      }
    }

    function contentCount(text) {
      const info = playlistInfo(text);
      return info.extinf - info.adExtinf;
    }

    // Live ad bypass must never run for VOD. VOD media segments have no
    // ",live" suffix, so playlistInfo() reports every VOD segment as an "ad";
    // without this guard a live->VOD SPA navigation could cover the VOD with
    // the old channel's live stream. Twitch live media is served from
    // *.playlist.ttvnw.net/v1/playlist/ or *.playlist.live-video.net/, while
    // VOD media is a cloudfront index-dvr.m3u8.
    function isLiveMediaUrl(url) {
      const u = String(url || '');
      return /\/v1\/playlist\//.test(u) || /\.playlist\.live-video\.net\//.test(u);
    }

    function parseVariants(masterText) {
      const lines = String(masterText || '').replace(/\r/g, '').split('\n');
      const urls = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        // Audio-only renditions have no RESOLUTION. Feeding one to the video
        // player makes a clean-but-black stream, so skip them.
        if (!/RESOLUTION=/.test(lines[i])) continue;
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j].trim();
          if (!line) continue;
          if (line.startsWith('#')) break;
          urls.push(line);
          break;
        }
      }
      return urls;
    }

    async function mintMasterUrl(channel, playerType, platform) {
      const device = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
      const body = {
        operationName: 'PlaybackAccessToken',
        variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType, platform },
        extensions: { persistedQuery: { version: 1, sha256Hash: __KO_GQL_HASH } },
      };
      const gr = await realFetch(__KO_GQL_URL, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          'Client-ID': __KO_CLIENT_ID,
          'X-Device-Id': device,
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body: JSON.stringify(body),
      });
      if (!gr.ok) return null;
      const gj = await gr.json();
      const token = gj && gj.data && gj.data.streamPlaybackAccessToken;
      if (!token || !token.value || !token.signature) return null;
      const u = new URL(`https://usher.ttvnw.net/api/v2/channel/hls/${encodeURIComponent(channel)}.m3u8`);
      u.searchParams.set('sig', token.signature);
      u.searchParams.set('token', token.value);
      u.searchParams.set('allow_source', 'true');
      u.searchParams.set('allow_audio_only', 'true');
      u.searchParams.set('p', String(Math.floor(Math.random() * 9000000) + 1000000));
      u.searchParams.set('player', 'twitchweb');
      u.searchParams.set('type', 'any');
      return u.toString();
    }

    async function mintMaster(channel, playerType, platform) {
      const url = await mintMasterUrl(channel, playerType, platform);
      if (!url) return null;
      const mr = await realFetch(url, { credentials: 'omit' });
      if (!mr.ok) return null;
      return await mr.text();
    }

    // Find a master whose first two video renditions have NO stitched ads.
    // The 2026 TwitchAdSolutions forks put popout/site/mobile_web first and
    // use autoplay only as a last resort: autoplay is 360p and can get stuck
    // in a loading loop when used as a long-lived backup. We keep it last.
    async function findCleanHlsUrl(channel, preferFallback = false, prewarmMode = false, firstUrl = null, firstMaster = null) {
      const types = prewarmMode
        ? [
            // Prewarm should maximize the chance the token is still clean
            // when the ad actually lands. autoplay/android is the measured
            // clean-during-SSAI type; it is 360p, but the user accepts lower
            // quality during the break. The overlay can still switch to a
            // better web type if this one goes ad-only.
            ['autoplay', 'android'],
            ['mobile', 'android'],
            ['mobile_web', 'web'],
            ['popout', 'web'],
            ['site', 'web'],
            ['embed', 'web'],
          ]
        : preferFallback
        ? [
            ['mobile_web', 'web'],
            ['popout', 'web'],
            ['site', 'web'],
            ['mobile', 'android'],
            ['autoplay', 'android'],
            ['embed', 'web'],
          ]
        : [
            // Cold preroll: the web token types are usually already ad-only,
            // and probing all of them costs ~9s before the overlay can start.
            // autoplay/android is the measured clean-during-SSAI type; start
            // with it (360p) so the ad is covered immediately. The overlay can
            // still switch to a web/HD type if this one goes ad-only.
            ['autoplay', 'android'],
            ['mobile_web', 'web'],
            ['popout', 'web'],
            ['site', 'web'],
            ['mobile', 'android'],
            ['embed', 'web'],
          ];
      let usedFirstUrl = false;
      for (const [playerType, platform] of types) {
        try {
          let url;
          let master = null;
          if (!usedFirstUrl && firstUrl) {
            url = firstUrl;
            master = firstMaster;
            usedFirstUrl = true;
          } else {
            url = await mintMasterUrl(channel, playerType, platform);
          }
          if (!url) continue;
          if (!master) {
            const mr = await realFetch(url, { credentials: 'omit' });
            if (!mr.ok) continue;
            master = await mr.text();
          }
          const variants = parseVariants(master);
          for (const variant of variants.slice(0, 1)) {
            let variantUrl = variant;
            try { variantUrl = new URL(variant, url).toString(); } catch { /* keep raw */ }
            const vr = await realFetch(variantUrl, { credentials: 'omit' });
            if (!vr.ok) continue;
            const text = await vr.text();
            const info = playlistInfo(text);
            debugLog('bypass.probe', {
              playerType,
              platform,
              extinf: info.extinf,
              adExtinf: info.adExtinf,
              adOnly: info.adOnly,
            });
            if (info.extinf > 0 && info.adExtinf === 0) return url;
          }
        } catch (e) {
          debugLog('bypass.probeError', { playerType, platform, error: String(e).slice(0, 160) });
        }
      }
      return null;
    }

    // The player can be handed an ad-only media playlist (all #EXTINF lines
    // lack ",live"; measured preroll: 3-4 x "#EXTINF:2.0,Amazon|..."). The
    // clean master minted with popout can itself be in an ad window, so try
    // other token types and only adopt one that actually has content segments.
    let fallbackAttemptAt = 0;
    let adBypassActive = false;
    // The last playlist refresh that carried ad evidence, and when this pod
    // opened. Both feed AD_POD_MAX_MS below.
    let lastAdMarker = null;
    let bypassStartedAt = 0;
    let bypassBusy = false;
    let lastBypassAt = 0;
    let cleanPlaylistStreak = 0;
    let switchBusy = false;
    let lastSwitchAt = 0;
    // The first ~4s of a fresh page are usually content before the preroll.
    // Mint and probe a clean backup during that window so an ad can be covered
    // immediately instead of spending 1-3s probing after the ad starts.
    const PREWARM_TTL = 90 * 1000;
    let prewarm = { channel: null, url: null, at: 0, busy: false };
    let prewarmBusyChannel = null;
    let prewarmPromise = null;

    // Advertise a warm clean URL to the page. The page decides whether it can
    // start the hidden player (visible tab, no active ad/overlay). Never
    // advertise while an ad is being bypassed or probed.
    function postStandbyStart(channel, url) {
      if (!channel || !url) return;
      if (adBypassActive || bypassBusy) return;
      postBypass({ type: 'standby-start', channel, url });
    }

    // A DNS/TLS hang while probing must not leave the native player muted for
    // the rest of the ad. The probe itself keeps running, but the caller gets
    // null and restores the native player / asks the watchdog to retry.
    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), ms)),
      ]);
    }

    // The overlay's current source went ad-only mid-pod. Probe the types that
    // are known to stay clean during SSAI (autoplay/android first) and post a
    // fresh ad-start; the page rebuilds the hls.js iframe with it.
    async function switchCleanSource(channel) {
      if (bypassBusy || switchBusy) return;
      // A SWITCH NEEDS AS LONG AS A LIVE LOAD, NOT 4 SECONDS. Measured in the
      // owner's 2026-11-16 ring (twitch.tv/srdogg, 0.8.97): two `ad-start
      // {switch:true}` 8.2 s apart, and the reveal between them reported
      // `advanced:0.1 since:7708ms` - the first switch's frame was still filling
      // when the second one replaced it, so the picture that went up was a
      // rebuilt player showing its own first seconds (the "repeticoes"). A fresh
      // live url needs ~10 s to first frames on this product's own measurement,
      // so the floor sits above that and the refusal is a row.
      if (Date.now() - lastSwitchAt < SWITCH_FLOOR_MS) {
        postBypass({ type: 'switch-skip', channel: channel || lastChannel, reason: 'loading', sinceMs: Date.now() - lastSwitchAt });
        return;
      }
      switchBusy = true;
      lastSwitchAt = Date.now();
      try {
        // Prefer the source that is measured clean during SSAI. A web/HD
        // token can be clean before the pod and go ad-only mid-pod, which
        // forces another switch while the ad is on screen. autoplay/android
        // is lower quality but stays clean, so a switch lands on a source the
        // page can keep for the rest of the break.
        const url = await withTimeout(findCleanHlsUrl(channel || lastChannel, true, true), 10000);
        if (url && adBypassActive) {
          debugLog('bypass.switch', { channel: channel || lastChannel });
          postBypass({ type: 'ad-start', channel: lastChannel, url, switch: true });
        } else if (!adBypassActive) {
          debugLog('bypass.switchAborted', { channel: channel || lastChannel });
        } else {
          debugLog('bypass.switchFail', { channel: channel || lastChannel });
        }
      } catch (e) {
        debugLog('bypass.switchError', { error: String(e).slice(0, 180) });
      } finally {
        switchBusy = false;
      }
    }

    async function prewarmCleanSource(channel) {
      if (!channel || prewarm.busy) return;
      if (prewarm.channel === channel && Date.now() - prewarm.at < PREWARM_TTL) return;
      prewarm.busy = true;
      prewarmBusyChannel = channel;
      prewarmPromise = (async () => {
        // Audit the whole cold chain in the page's ring: request -> mint start
        // -> fast URL -> mint end. Without the worker's own stamps, "the page
        // never asked" and "the worker took eight seconds" are indistinguishable.
        postBypass({ type: 'standby-mint', reason: 'start', channel });
        try {
          // prewarmMode starts with autoplay/android: it is the only measured
          // clean-during-SSAI type. Starting a hidden HD web token here is what
          // made the warm standby go ad-only in the middle of the Necros pod.
          //
          // Start the hidden player as soon as the autoplay master URL exists
          // and responds OK, before probing its first variant. hls.js fetches
          // that variant anyway and its own ad filter strips stitched
          // segments; the full probe below still verifies the URL for later
          // prewarm hits. On a cold preroll this moves the standby ~1s earlier.
          let fastUrl = null;
          let fastMaster = null;
          try {
            fastUrl = await withTimeout(mintMasterUrl(channel, 'autoplay', 'android'), 4000);
            // A minted URL can still 403 (offline channel, bad signature).
            // Check the master before handing it to the hidden player; this
            // is one round trip, not the full variant probe. Keep the body so
            // the probe below does not fetch the same master again.
            if (fastUrl) {
              const mr = await withTimeout(realFetch(fastUrl, { credentials: 'omit' }), 4000);
              if (mr && mr.ok) fastMaster = await mr.text();
              else fastUrl = null;
            }
          } catch {
            fastUrl = null;
            fastMaster = null;
          }
          if (fastUrl) {
            // Keep `busy` set: the full probe is still running. Only the URL
            // is published early so the page can start its hidden player.
            prewarm = { channel, url: fastUrl, at: Date.now(), busy: true };
            postBypass({ type: 'standby-mint', reason: 'fast-url', channel });
            debugLog('prewarm.fast', { channel });
            postStandbyStart(channel, fastUrl);
          }
          const url = await withTimeout(findCleanHlsUrl(channel, true, true, fastUrl, fastMaster), 8000);
          postBypass({ type: 'standby-mint', reason: 'end', channel, found: !!url });
          if (url) {
            prewarm = { channel, url, at: Date.now(), busy: false };
            debugLog('prewarm.ok', { channel });
            if (!fastUrl) postStandbyStart(channel, url);
          } else {
            prewarm = { channel: null, url: null, at: 0, busy: false };
            debugLog('prewarm.fail', { channel });
          }
        } catch (e) {
          prewarm.busy = false;
          debugLog('prewarm.error', { error: String(e).slice(0, 160) });
        }
      })();
      try {
        await prewarmPromise;
      } finally {
        prewarmBusyChannel = null;
        prewarmPromise = null;
      }
    }

    async function maybeStartBypass() {
      if (!lastChannel || bypassBusy) return;
      if (Date.now() - lastBypassAt < 15000) return;
      bypassBusy = true;
      lastBypassAt = Date.now();
      // WHO STARTED THIS POD. `ad-hold` was posted here with no row at all, so a
      // page load with `ad-ui-on=0` and no `ad-hold` left the ring unable to say
      // what covered the native: the owner's 2026-11-16 load on fredthefinch has
      // `ad-rewind-skip {reason:"standby"}` and an `overlay-reveal` and nothing
      // naming the trigger. `ad-bypass-start` is the transition that answers it,
      // and it carries the playlist evidence that produced the decision.
      // The worker region has no `adLog` (it is a separate eval scope: calling it
      // threw `ReferenceError: adLog is not defined`), so the playlist evidence
      // that opens this pod rides the message the page side already logs as
      // `bypass-msg`. Without it a load with `ad-ui-on=0` and no DOM signal has
      // an `overlay-reveal` and nothing naming what covered the native.
      postBypass({
        type: 'ad-hold',
        channel: lastChannel,
        from: 'playlist',
        adExtinf: lastAdMarker ? lastAdMarker.adExtinf : undefined,
        extinf: lastAdMarker ? lastAdMarker.extinf : undefined,
        adOnly: lastAdMarker ? lastAdMarker.adOnly : undefined,
        hasStitched: lastAdMarker ? lastAdMarker.hasStitched : undefined,
        adChanged: lastAdMarker ? lastAdMarker.changed : undefined,
      });
      try {
        let url = null;
        let prewarmAge = 0;
        if (prewarm.channel === lastChannel && prewarm.url && Date.now() - prewarm.at < PREWARM_TTL) {
          url = prewarm.url;
          prewarmAge = Date.now() - prewarm.at;
          prewarm = { channel: null, url: null, at: 0, busy: false };
          debugLog('bypass.prewarmHit', { channel: lastChannel, age: prewarmAge });
        }
        if (!url && prewarmPromise && prewarmBusyChannel === lastChannel) {
          // The page-load prewarm is still in flight. On a cold preroll it
          // usually needs 3-5s, and the ad is visible for that whole wait.
          // Give it only 800ms, then start the autoplay 360p source; the
          // prewarm can still populate `prewarm` for the next ad.
          await withTimeout(prewarmPromise, 800);
          if (prewarm.channel === lastChannel && prewarm.url && Date.now() - prewarm.at < PREWARM_TTL) {
            url = prewarm.url;
            prewarmAge = Date.now() - prewarm.at;
            prewarm = { channel: null, url: null, at: 0, busy: false };
            debugLog('bypass.prewarmWaitHit', { channel: lastChannel, age: prewarmAge });
          }
        }
        if (!url) url = await withTimeout(findCleanHlsUrl(lastChannel), 10000);
        if (url) {
          adBypassActive = true;
          bypassStartedAt = Date.now();
          postBypass({ type: 'ad-start', channel: lastChannel, url });
        } else {
          postBypass({ type: 'ad-fail', channel: lastChannel });
        }
      } catch (e) {
        debugLog('bypass.startError', { error: String(e).slice(0, 200) });
        postBypass({ type: 'ad-fail', channel: lastChannel });
      } finally {
        bypassBusy = false;
      }
    }

    async function cleanMediaFallback() {
      if (!lastChannel) {
        debugLog('fallback.noChannel', null);
        return null;
      }
      const cached = mediaFallbackCache.get(lastChannel);
      if (cached && Date.now() - cached.at < 8000 && contentCount(cached.text) > 0) return cached.text;
      if (Date.now() - fallbackAttemptAt < 10000) return null;
      fallbackAttemptAt = Date.now();
      const types = [
        // Prefer web-container types: autoplay/android is ad-free but its MSE
        // output does not play in the web player (paused at readyState 1).
        ['site', 'web'],
        ['site', 'android'],
        ['mobile', 'web'],
        ['mobile', 'android'],
        ['android', 'web'],
        ['android', 'android'],
        ['autoplay', 'web'],
        ['autoplay', 'android'],
      ];
      for (const [playerType, platform] of types) {
        try {
          const master = await mintMaster(lastChannel, playerType, platform);
          if (!master) {
            debugLog('probe.masterFail', { playerType, platform });
            continue;
          }
          const variants = parseVariants(master);
          debugLog('probe.master', { playerType, platform, variants: variants.length });
          for (const variant of variants.slice(0, 2)) {
            const r = await realFetch(variant, { credentials: 'omit' });
            if (!r.ok) continue;
            const text = await r.text();
            const clean = stripAds(text);
            const content = contentCount(clean);
            const info = playlistInfo(text);
            debugLog('probe.media', {
              playerType,
              platform,
              len: text.length,
              content,
              extinf: info.extinf,
              adExtinf: info.adExtinf,
              adOnly: info.adOnly,
              hasStitched: info.hasStitched,
            });
            if (content > 0) {
              mediaFallbackCache.set(lastChannel, { text: clean, at: Date.now() });
              digestPlaylist(lastChannel + ' [mediaFallback]', clean, 'fallback');
              debugLog('probe.clean', { playerType, platform, content });
              return clean;
            }
          }
        } catch (e) {
          debugLog('probe.error', { playerType, platform, error: String(e).slice(0, 200) });
        }
      }
      debugLog('probe.fail', { channel: lastChannel });
      return null;
    }

    function stripAds(text) {
      if (!/stitched|X-TV-TWITCH-AD-URL|twitch-stitched-ad/i.test(text)) return text;
      const lines = text.replace(/\r/g, '').split('\n');
      const out = [];
      let skipUri = false;
      let removed = false;
      for (const line of lines) {
        if (skipUri) {
          // The segment URI (and an optional byte-range tag) belongs to the
          // ad EXTINF just removed.
          if (line.startsWith('#EXT-X-BYTERANGE')) continue;
          if (line.startsWith('#')) continue;
          skipUri = false;
          removed = true;
          continue;
        }
        if (line.startsWith('#EXTINF')) {
          // Twitch marks content segments ",live"; stitched ad segments do
          // not carry that marker.
          if (!/,live\s*$/.test(line)) {
            skipUri = true;
            removed = true;
            continue;
          }
          out.push(line);
          continue;
        }
        if (line.startsWith('#EXT-X-DATERANGE') && /twitch-stitched-ad|X-TV-TWITCH-AD-URL/i.test(line)) {
          removed = true;
          continue;
        }
        if (line.startsWith('#EXT-X-TWITCH-PREFETCH')) {
          removed = true;
          continue;
        }
        out.push(
          line
            .replace(/X-TV-TWITCH-AD-URL="[^"]*"/g, 'X-TV-TWITCH-AD-URL="https://twitch.tv"')
            .replace(/X-TV-TWITCH-AD-CLICK-TRACKING-URL="[^"]*"/g, 'X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://twitch.tv"'),
        );
      }
      // All-ad playlist: keep the original instead of handing the player an
      // empty list (it would stall/black-screen).
      if (!removed || !out.some((l) => l.startsWith('#EXTINF'))) return text;
      return out.join('\n');
    }

    async function cleanMaster(url) {
      const m = url.match(/\/channel\/hls\/([^/?#]+)\.m3u8/);
      if (!m) {
        debugLog('cleanMaster.nochannel', { url: String(url).slice(0, 200) });
        return null;
      }
      const channel = decodeURIComponent(m[1]);
      lastChannel = channel;
      const incoming = tokenInfo(url);
      debugLog('cleanMaster.start', { channel, token: incoming });
      // The page hook already rewrote this master to the clean popout type.
      // Do not mint a second master here: the extra GQL/usher round-trip and
      // the replacement master made the player rebuffer when it re-requested
      // the master on fullscreen/quality changes.
      if (incoming && incoming.player_type === __KO_PLAYER_TYPE && incoming.platform === __KO_PLATFORM) {
        debugLog('cleanMaster.skipCleanToken', { channel, playerType: incoming.player_type, platform: incoming.platform });
        return null;
      }
      const cached = cleanCache.get(channel);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.text;
      try {
        // Keep the normal web container. autoplay/android has clean media
        // playlists during an ad, but its MSE output is not playable in the
        // web player (video stays paused at readyState 1), so it is only a
        // last-resort source and must not replace the main master.
        const text = await mintMaster(channel, __KO_PLAYER_TYPE, __KO_PLATFORM);
        if (!text) {
          debugLog('cleanMaster.fail', { channel });
          return null;
        }
        lastChannel = channel;
        lastMaster = text;
        debugLog('cleanMaster.ok', {
          channel,
          len: text.length,
          variants: parseVariants(text).length,
          playerType: __KO_PLAYER_TYPE,
          platform: __KO_PLATFORM,
        });
        digestPlaylist(url + ' [cleanMaster]', text, false);
        cleanCache.set(channel, { text, at: Date.now() });
        return text;
      } catch (e) {
        debugLog('cleanMaster.error', { channel, error: String(e).slice(0, 300) });
        return null;
      }
    }

    function tokenInfo(url) {
      try {
        const raw = new URL(url).searchParams.get('token');
        if (!raw) return null;
        // Twitch's usher `token` is URL-encoded JSON today, not base64. Try
        // both so this keeps working if the encoding changes.
        let t = null;
        try {
          t = JSON.parse(raw);
        } catch {
          const b = raw.replace(/-/g, '+').replace(/_/g, '/');
          t = JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4)));
        }
        if (!t) return null;
        return {
          player_type: t.player_type,
          platform: t.platform,
          show_ads: t.show_ads,
          server_ads: t.server_ads,
          hide_ads: t.hide_ads,
          adblock: t.adblock,
          user_id: t.user_id,
          channel: t.channel,
        };
      } catch {
        return null;
      }
    }

    self.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        // A VOD page reuses the same worker/page after an SPA navigation from
        // a live channel. Drop the stale live channel so the VOD playlists
        // can never trigger the live-only bypass ladder.
        if (typeof url === 'string' && /\/vod\/v2\//.test(url)) lastChannel = null;
        // Clean picture-by-picture masters too. Twitch's 2025 SDA ads can
        // arrive on that player type; skipping them let a PBP master through
        // even though the page token itself had been rewritten to popout.
        if (typeof url === 'string' && url.includes('/channel/hls/')) {
          try {
            const cm = url.match(/\/channel\/hls\/([^/?#]+)\.m3u8/);
            if (cm) lastChannel = decodeURIComponent(cm[1]);
          } catch {
            /* ignore */
          }
          // Fallback prewarm for SPA channel switches and for pages where the
          // document_start request did not reach the worker. A plain cold open
          // already asked from the pathname before this master arrived.
          if (lastChannel) prewarmCleanSource(lastChannel);
          let tokenRaw = null;
          try { tokenRaw = new URL(url).searchParams.get('token'); } catch {}
          debugLog('master.request', {
            token: tokenInfo(url),
            tokenLen: tokenRaw ? tokenRaw.length : 0,
            tokenHead: tokenRaw ? tokenRaw.slice(0, 24) : null,
          });
          const text = await cleanMaster(url);
          if (text) {
            return new Response(text, {
              status: 200,
              headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
            });
          }
        }
      } catch {
        /* fall through to the original response */
      }
      const response = await realFetch(input, init);
      try {
        if (
          response &&
          response.ok &&
          typeof url === 'string' &&
          (url.includes('/playlist/') || /\.m3u8(?:[?#]|$)/.test(url))
        ) {
          const text = await response.clone().text();
          const info = playlistInfo(text);
          const clean = stripAds(text);
          const liveMedia = isLiveMediaUrl(url);
          if (liveMedia && info.extinf > 0 && info.adExtinf > 0) {
            lastAdMarker = { at: Date.now(), adExtinf: info.adExtinf, extinf: info.extinf, adOnly: info.adOnly, hasStitched: info.hasStitched, changed: info.adExtinf !== (lastAdMarker && lastAdMarker.adExtinf) ? true : null };
          }
          // A POD OPENED FROM THE PLAYLIST HAS NO PAGE LIFECYCLE TO CLOSE IT.
          // `ad-start` is posted here, not by a page element, so nothing on the
          // page ever reports `ad-end`: the pod ends on the clean-playlist
          // streak or on the page-side 180 s timeout. Measured in the owner's own
          // ring 2026-11-16 (twitch.tv/fredthefinch, 0.8.97): the ad's own
          // playlist window was `adOnly:true` for 3 s and then content came back
          // while 16 ad segments stayed listed, so the streak never reached two
          // and `native-handoff {podAgeMs:180008}` closed the pod THREE MINUTES
          // after the ad was over - 360p on screen for the whole wait. A real
          // break is under a minute, so a playlist-derived pod may not outlive
          // AD_POD_MAX_MS; past it the native is handed back and the row says so.
          if (adBypassActive && bypassStartedAt && Date.now() - bypassStartedAt > AD_POD_MAX_MS) {
            const podAgeMs = Date.now() - bypassStartedAt;
            adBypassActive = false;
            cleanPlaylistStreak = 0;
            bypassStartedAt = 0;
            postBypass({
              type: 'ad-end',
              channel: lastChannel,
              reason: 'pod-max',
              podAgeMs,
              adExtinf: info.adExtinf,
              extinf: info.extinf,
              adOnly: info.adOnly,
              markerAgeMs: lastAdMarker ? Date.now() - lastAdMarker.at : undefined,
            });
          }
          if (info.extinf > 0) {
            if (liveMedia && info.adExtinf > 0) {
              // Any stitched ad, not just an all-ad preroll. A midroll can be
              // mixed (e.g. 51 ad segments + 1 content segment in the same
              // refreshed playlist), and the player may already have buffered
              // the ad by the time stripAds() sees it. Cover the native player
              // with the clean hls.js stream immediately; stripAds() still
              // removes future ad segments from the native playlist.
              cleanPlaylistStreak = 0;
              if (AD_BYPASS_ENABLED && !adBypassActive) maybeStartBypass();
            } else if (liveMedia && adBypassActive) {
              // One clean playlist can still sit next to buffered ad media.
              // Require two consecutive clean refreshes before uncovering the
              // native player, so a midroll tail is not shown.
              cleanPlaylistStreak++;
              if (cleanPlaylistStreak >= 2) {
                adBypassActive = false;
                cleanPlaylistStreak = 0;
                postBypass({ type: 'ad-end', channel: lastChannel });
              }
            } else {
              cleanPlaylistStreak = 0;
            }
          }
          // Use the pre-ad grace window: while the live playlist is clean,
          // keep one warm, pre-probed clean master ready. When the preroll
          // lands, maybeStartBypass() can cover it without the 1-3s probe.
          if (liveMedia && info.extinf > 0 && info.adExtinf === 0 && !adBypassActive) {
            prewarmCleanSource(lastChannel);
          }
          // All-ad preroll/master window: there is no content segment to keep.
          // Swap in a live media playlist from the clean master instead of
          // letting the player play the ad-only list.
          if (ALL_AD_FALLBACK && info.adOnly) {
            const fallback = await cleanMediaFallback();
            if (fallback) {
              digestPlaylist(url, text, 'adOnly->fallback');
              return new Response(fallback, {
                status: 200,
                headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
              });
            }
          }
          digestPlaylist(url, text, clean !== text);
          if (clean !== text) {
            // Only Content-Type: copying content-encoding/length from the
            // already-decoded body makes the consumer misread it.
            return new Response(clean, {
              status: 200,
              headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
            });
          }
        }
      } catch {
        /* keep the original response */
      }
      return response;
    };
  }

  // Twitch moved its player to a SHARED worker feeding `video.srcObject =
  // MediaSourceHandle` (measured on the owner's Chrome 2026-11-15: the page
  // video had `srcObject` of type MediaSourceHandle, and the playlist never
  // crossed `self.fetch` in ANY context we patched). The old hook wrapped only
  // `window.Worker`, so that entire player ran unpatched: the ring had zero
  // `worker-playlist` rows for a whole page load while a 15 s pod played, and
  // the only defence left was the DOM detector. Both constructors now go
  // through one wrapper, because which one the player picks is Twitch's
  // decision, not ours.
  function makePatchedWorker(Native, isShared) {
    return class KoAdblockWorker extends Native {
      constructor(url, options) {
        const src = String(url);
        if (!isOn()) {
          super(url, options);
          return;
        }
        if (!/^blob:https:\/\/(?:www\.)?twitch\.tv\//.test(src)) {
          super(url, options);
          return;
        }
        let code = '';
        try {
          const x = new XMLHttpRequest();
          x.open('GET', src, false);
          x.overrideMimeType('text/javascript');
          x.send();
          code = x.responseText || '';
        } catch {
          stats.workerFailures++;
        }
        if (!code) {
          super(url, options);
          return;
        }
        try {
          const prelude =
            'const __KO_CLIENT_ID=' + JSON.stringify(CLIENT_ID) + ';' +
            'const __KO_GQL_HASH=' + JSON.stringify(GQL_HASH) + ';' +
            'const __KO_GQL_URL=' + JSON.stringify(GQL_URL) + ';' +
            'const __KO_PLAYER_TYPE=' + JSON.stringify(PLAYER_TYPE) + ';' +
            'const __KO_PLATFORM=' + JSON.stringify(CLEAN_PLATFORM) + ';' +
            'const __KO_PAGE_ID=' + JSON.stringify(pageId) + ';';
          const blob = new Blob([prelude + '(' + workerMain.toString() + ')();\n' + code], {
            type: 'text/javascript',
          });
          super(URL.createObjectURL(blob), options);
          if (isShared) stats.workerHooksShared = (stats.workerHooksShared || 0) + 1;
          else stats.workerHooks++;
          // Say it out loud: "no worker-playlist rows" must never again be
          // ambiguous between "the playlist was clean" and "we never saw it".
          adLog('worker-hook', { kind: isShared ? 'shared' : 'worker', src: src.slice(0, 90) });
        } catch (e) {
          stats.workerFailures++;
          adLog('worker-hook-fail', { kind: isShared ? 'shared' : 'worker', err: String(e).slice(0, 120) });
          super(url, options);
        }
      }
    };
  }
  try {
    if (typeof window.Worker === 'function') window.Worker = makePatchedWorker(window.Worker, false);
  } catch {
    /* worker hook is optional — the GQL rewrite remains active */
  }
  try {
    if (typeof window.SharedWorker === 'function') {
      window.SharedWorker = makePatchedWorker(window.SharedWorker, true);
    }
  } catch {
    /* shared-worker hook is optional */
  }
})();
