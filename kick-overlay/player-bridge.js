'use strict';
// Kick player bridge — hosts the SAME engine kick.com uses (Amazon IVS
// web player, amazon-ivs-player) inside the extension page, so the wasm
// worker is same-origin (no CORS/importScripts traps) and playback_url
// fetches ride on the extension's host_permissions. Controls are driven
// over postMessage by the content script; state is reported back ~1/s.
const V = document.getElementById('v');
const params = new URLSearchParams(location.search);
const HLS_MODE = params.get('m') === 'hls';
const TWITCH_HLS = HLS_MODE && params.get('tw') === '1';
const PLAYER_TOKEN = params.get('token');
// The embed's parent page. Historically twitch.tv only; since 0.8.2 the
// same bridge also runs over youtube.com pages (the overlay's YT layer).
// The actual origin is LEARNED from the first token-valid message — the
// shared secret (PLAYER_TOKEN, minted per page by the content script) is
// what authenticates the parent, not a hardcoded host — so replies are
// addressed to that exact origin afterwards. Until then the frame does not
// know who its parent is, and a post to the wrong targetOrigin is dropped
// silently by the browser (measured 2026-10-26: 0 deliveries for
// https://www.twitch.tv from a youtube.com page, KO-20261026-02). `ready` is
// emitted at load, before any inbound message can teach us the real parent,
// so an unknown parent is addressed with '*'; the payload still carries the
// per-page token, and the page still validates origin and source.
const PARENT_ORIGINS = new Set([
  'https://www.twitch.tv',
  'https://www.youtube.com',
  'https://m.youtube.com',
  'https://youtube.com',
  'https://youtu.be',
]);
let PARENT_ORIGIN = null; // learned from the first token-valid message
// 0.8.41 diag (KO-20261026-02). The black box on a YouTube watch page with
// player=kick has one measured fact and no cause: the content script never
// received `ready`, while `st` did arrive. Two things had to be measurable
// instead of assumed: (a) what this frame actually posted, to which origin,
// and whether the parent origin had been learned at that moment, and (b) what
// arrived from the parent and what was rejected. Counters only; no behaviour
// change. Read it from the harness with `eval --target=ivs "__koBridgeDiag"`.
const BRIDGE_DIAG = (window.__koBridgeDiag = {
  startedAt: Date.now(),
  mode: HLS_MODE ? (TWITCH_HLS ? 'twitch-hls' : 'yt-hls') : 'ivs',
  token: PLAYER_TOKEN ? String(PLAYER_TOKEN).slice(0, 8) : null,
  parentOrigin: PARENT_ORIGIN,
  learned: false,
  parentLearnedAt: 0,
  learnedFrom: null,
  posts: {},
  firstPost: {},
  postErrors: 0,
  inbound: { total: 0, accepted: 0, rejected: 0, byOrigin: {}, firstReject: null },
});
const beacon = (ev, data) => {
  try {
    chrome.runtime.sendMessage({ __koDiag: { ev, data } }, () => void chrome.runtime.lastError);
  } catch {
    /* beacon must never break the player */
  }
};
window.addEventListener('error', (e) => beacon('ivs_page_err', { msg: String((e && e.message) || e).slice(0, 150), src: (e && e.filename ? e.filename.slice(-40) : '') }));
window.addEventListener('unhandledrejection', (e) => beacon('ivs_page_err', { rej: String((e && e.reason) || '').slice(0, 150) }));
const post = (m) => {
  if (!PLAYER_TOKEN) return;
  const d = BRIDGE_DIAG;
  // Unknown parent (`ready` at load) goes to '*' so it cannot be dropped by a
  // targetOrigin mismatch; every post after the first valid inbound message
  // uses that exact origin.
  const target = PARENT_ORIGIN || '*';
  d.posts[m.t] = (d.posts[m.t] || 0) + 1;
  if (!d.firstPost[m.t]) {
    // A post to the wrong targetOrigin is dropped by the browser with no
    // error, so the origin in effect is the fact worth keeping.
    d.firstPost[m.t] = {
      ms: Math.round(performance.now()),
      to: target,
      learned: !!d.learned,
      state: m.st ? m.st.state : null,
    };
  }
  try {
    parent.postMessage({ __koKick: { ...m, _koToken: PLAYER_TOKEN } }, target);
  } catch {
    d.postErrors++;
  }
};

// Shared inbound bookkeeping for both engines (HLS and IVS listeners below).
function noteInbound(ev, stage, detail) {
  const d = BRIDGE_DIAG;
  if (stage === 'head') {
    d.inbound.total++;
    const o = String((ev && ev.origin) || '(none)');
    d.inbound.byOrigin[o] = (d.inbound.byOrigin[o] || 0) + 1;
    return;
  }
  if (stage === 'reject') {
    d.inbound.rejected++;
    if (!d.inbound.firstReject) {
      d.inbound.firstReject = {
        ms: Math.round(performance.now()),
        origin: String((ev && ev.origin) || '(none)'),
        fromParent: !!(ev && ev.source === window.parent),
        hasKick: !!(ev && ev.data && ev.data.__koKick),
        reason: String(detail || ''),
      };
    }
    return;
  }
  d.inbound.accepted++;
  if (!d.learned) {
    d.learned = true;
    d.parentLearnedAt = Math.round(performance.now());
    d.learnedFrom = {
      origin: String(ev.origin || ''),
      fromParent: ev.source === window.parent,
      t: String(detail && detail.t),
    };
  }
}

// Keyboard relay (0.8.6, pain 2): when focus lives INSIDE the extension-page
// iframe (after the user clicks the player — the host's document-level
// keydown capture never sees those presses, because the event targets the
// chrome-extension:// frame's own document), forward the overlay-relevant
// keys up so the content script issues the same seek/fullscreen it would for
// a keypress on the Twitch page. Only the keys the host's onOverlayKeydown
// whitelists (f / arrowleft / arrowright) are relayed, so the native YT
// controls (space = play/pause, and every other key) are left untouched.
// 'f' maps to the host's fullscreen toggle. preventDefault keeps the frame
// from also acting on the arrow (e.g. scrolling the page body).
const RELAY_KEYS = new Set(['f', 'arrowleft', 'arrowright']);
window.addEventListener('keydown', (ev) => {
  const k = String(ev.key).toLowerCase();
  if (!RELAY_KEYS.has(k) || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
  const t = ev.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  try { ev.preventDefault(); } catch { /* ignore */ }
  post({ t: 'key', k });
});

if (HLS_MODE) {
  // ---- HLS engine (YouTube layer) ------------------------------------------
  // Same bridge protocol as IVS: {t:'load'|'play'|'pause'|'mute'|'volume'|
  // 'seek'|'seekToLive'|'getState'} in, {t:'ready'} + ~1/s {t:'st'} + {t:'ev'}
  // out. hls.js plays the innertube hlsManifestUrl; native controls visible.
  V.controls = true; // native controls give the yt layer the embed-era UX
  // Twitch overlay: start muted so Chrome's autoplay policy cannot park the
  // clean player in Buffering/Idle while the native ad is still visible.
  // The badge offers a click-to-unmute after reveal. The YouTube layer keeps
  // its existing mute handling.
  if (TWITCH_HLS) V.muted = true;
  // 0.8.16: Twitch SSAI ads can appear on ANY token type. A playlist that
  // looked clean at probe time can turn ad-only on its next refresh (measured
  // on necros: site/web 15 clean segments -> 15 DCM/Amazon segments). Strip
  // stitched ad segments in hls.js itself, before they are parsed/buffered.
  // Keep the last clean playlist while an ad-only refresh is in flight, so
  // hls.js freezes on the last content frame instead of playing the ad.
  const cleanPlaylistCache = new Map();
  const adFilterStats = { strips: 0, adOnly: 0, last: null, lastSignalAt: 0 };
  let adOnlySignaled = false;
  const twitchPlaylist = (url) => /(^|\.)ttvnw\.net\//i.test(String(url || ''));
  const playlistCounts = (text) => {
    let content = 0;
    let ads = 0;
    for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
      if (!line.startsWith('#EXTINF')) continue;
      if (/,live\s*$/.test(line)) content++;
      else ads++;
    }
    return { content, ads };
  };
  const stripTwitchAds = (text, url) => {
    if (!text) return text;
    const counts = playlistCounts(text);
    if (!counts.ads) {
      adOnlySignaled = false;
      return text;
    }
    const lines = text.replace(/\r/g, '').split('\n');
    const out = [];
    let skipUri = false;
    let leadingRemoved = 0;
    let seenContent = false;
    for (const line of lines) {
      if (skipUri) {
        // The segment URI (and optional byte-range tag) belongs to the ad
        // EXTINF just removed. Tags before that URI are part of the ad too.
        if (line.startsWith('#EXT-X-BYTERANGE')) continue;
        if (line.startsWith('#')) continue;
        skipUri = false;
        if (!seenContent) leadingRemoved++;
        continue;
      }
      if (line.startsWith('#EXTINF')) {
        // Twitch marks content segments ",live"; stitched ad segments do not.
        if (!/,live\s*$/.test(line)) {
          skipUri = true;
          continue;
        }
        seenContent = true;
        out.push(line);
        continue;
      }
      if (line.startsWith('#EXT-X-DATERANGE') && /twitch-stitched-ad|X-TV-TWITCH-AD-URL/i.test(line)) {
        continue;
      }
      out.push(line);
    }
    let clean = out.join('\n');
    const cleanCounts = playlistCounts(clean);
    if (cleanCounts.content === 0) {
      adFilterStats.adOnly++;
      adFilterStats.last = { at: Date.now(), kind: 'ad-only', url: String(url).slice(0, 120) };
      // 0.8.17: an ad-only refresh means this token type has no content right
      // now. Hls.js can sit in Buffering forever on the stale cached window
      // (measured on necros: 40s of black while the ad played). Ask the worker
      // to probe other token types and reload the overlay with a clean one.
      const now = Date.now();
      if (!adOnlySignaled || now - adFilterStats.lastSignalAt > 2500) {
        adOnlySignaled = true;
        adFilterStats.lastSignalAt = now;
        post({ t: 'ev', e: 'ad-only', d: String(counts.ads) });
      }
      // Reuse the last clean live window if we have one; otherwise hand
      // hls.js an empty live playlist so it waits instead of buffering an ad.
      return cleanPlaylistCache.get(url) || '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
    }
    adOnlySignaled = false;
    // Removing leading ad segments shifts hls.js's implicit fragment numbers;
    // bump MEDIA-SEQUENCE by the same amount so the remaining SNs stay monotonic.
    if (leadingRemoved) {
      clean = clean.replace(/#EXT-X-MEDIA-SEQUENCE:(\d+)/, (_m, n) => `#EXT-X-MEDIA-SEQUENCE:${Number(n) + leadingRemoved}`);
    }
    cleanPlaylistCache.set(url, clean);
    adFilterStats.strips++;
    adFilterStats.last = { at: Date.now(), kind: 'stripped', ads: counts.ads, content: cleanCounts.content, url: String(url).slice(0, 120) };
    return clean;
  };
  class TwitchAdFilterLoader extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      const { type, url } = context;
      if ((type === 'manifest' || type === 'level' || type === 'audioTrack') && twitchPlaylist(url)) {
        const complete = callbacks.onSuccess;
        callbacks.onSuccess = (response, stats, successContext, networkDetails) => {
          try {
            if (response && typeof response.data === 'string') {
              const clean = stripTwitchAds(response.data, url);
              if (clean !== response.data) {
                response.data = clean;
                post({ t: 'ev', e: 'adstrip', d: `${adFilterStats.strips}/${adFilterStats.adOnly}` });
              }
            }
          } catch (e) {
            post({ t: 'ev', e: 'adstrip-error', d: String(e).slice(0, 120) });
          }
          complete(response, stats, successContext, networkDetails);
        };
      }
      super.load(context, config, callbacks);
    }
  }
  // 0.8.6 pain-1: the yt rewind window is TUNED, not whatever the playlist
  // grants - liveBackBufferLength anchors the ~20s seekable window the bar,
  // the "LIVE -Ns" pill and the edge-clamp all promise (0.8.5 left it at the
  // hls.js default, so the window was shorter than the UI implied).
  // The Twitch overlay is a fallback surface, not the primary player: start
  // closer to the live edge with a smaller buffer so a clean frame appears
  // in ~1-2s instead of hls.js buffering three live segments (~5s measured).
  // The YouTube layer keeps its tuned 30s/3-segment live buffer.
  const hlsConfig = TWITCH_HLS
    ? {
        maxBufferLength: 30,
        // Live sync in SECONDS, not segment durations (owner report
        // 2026-11-07: "the live comes back several seconds behind after the
        // swap"). `liveSyncDurationCount: 2` targeted two SEGMENT durations,
        // which on a 15s-segment clean master parks the player ~30s behind the
        // edge; hls.js then plays at 1x and the gap never closes. A fixed
        // 3s target is independent of the segment duration, and
        // maxLiveSyncPlaybackRate lets hls.js close drift by playing 1.5x for a
        // moment instead of the old visible seek. 9s is the hard ceiling: above
        // it hls.js seeks, which is the same correction twitch-adblock.js
        // applies on the page side.
        liveSyncDuration: 3,
        liveMaxLatencyDuration: 9,
        maxLiveSyncPlaybackRate: 1.5,
        liveBackBufferLength: 30,
        startPosition: -1,
        // The clean autoplay/android master can be LL-HLS. hls.js's low-latency
        // mode then follows parts with <1s of forward buffer and stalls on a
        // normal segment refresh (measured: 0.04-0.888s buffered on jynxzi).
        // Full-segment live sync gives the hidden/visible clean player runway.
        lowLatencyMode: false,
        // Start level chosen on MANIFEST_PARSED from the lowest-bitrate rung:
        // index 0 is not guaranteed to be the bottom rendition. ABR still steps up.
        startLevel: -1,
        pLoader: TwitchAdFilterLoader,
      }
    : {
        maxBufferLength: 30,
        liveSyncDurationCount: 3,
        liveBackBufferLength: 20,
        pLoader: TwitchAdFilterLoader,
      };
  const h = new Hls(hlsConfig);
  let currentUrl = null;
  let reloaded = false;
  // hls.js can start a DVR playlist at its oldest segment (measured: a 30s
  // window began at currentTime 0 / lat 30). Jump once per load only in that
  // case, or when the player somehow starts inside 1.5s of the edge. Do not
  // pull a player that hls.js already placed behind live: the old unconditional
  // `end - 0.5` jump left the 2026-10-23 clean player at 0.04s of buffer and
  // it stalled on the first refresh. A deliberate user seek later is not
  // overridden because the flag is only reset by a new load.
  let liveJumped = false;
  let standbyLevelLogged = false;
  const LIVE_TARGET_SEC = 3; // = hlsConfig.liveSyncDuration for the Twitch surface
  const jumpToLiveEdge = () => {
    if (liveJumped) return;
    try {
      if (!V.seekable || !V.seekable.length) return;
      const end = V.seekable.end(V.seekable.length - 1);
      if (!isFinite(end) || end <= 0) return;
      const pos = V.currentTime || 0;
      const behind = end - pos;
      // Correct a DVR start, a player sitting on the edge, or one that hls.js
      // left further behind than the hard ceiling. The old `behind > 20` test
      // mistook a normal 30s segment-duration placement for a DVR start and
      // jumped to end-2, leaving only 0.4-1.2s of forward buffer on jynxzi
      // (2026-10-24). The same test is now what twitch-adblock's catch-up uses.
      if (behind > 120 || behind < 1.5 || behind > 9) {
        V.currentTime = Math.max(0, end - LIVE_TARGET_SEC);
      }
      liveJumped = true;
      V.play().catch(() => { /* autoplay policy */ });
    } catch { /* not ready */ }
  };
  h.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
    if (TWITCH_HLS && !standbyLevelLogged) {
      const levels = (data && data.levels) || h.levels || [];
      if (levels.length) {
        // The standby exists to be REVEALED over the native player, so its
        // first rung must fit THAT rect. Picking the lowest bitrate rung (the
        // pre-fix line) made the owner's 1236x695 player open at 360p and stay
        // there until ABR climbed: `overlay-reveal {q:"360p"}` twice in one
        // load. This is capLevelToPlayerSize's rule computed from the element
        // itself, without waiting for a bandwidth sample: the smallest rung
        // that covers the CSS height, or the largest rung if none does.
        let height = 0;
        try { height = V.getBoundingClientRect ? Math.max(0, V.getBoundingClientRect().height) : 0; } catch { /* no rect yet */ }
        // A RECT OF ZERO IS NOT A SMALL PLAYER. A standby iframe that has not
        // been laid out reports height 0, and `lh >= 0` is true for the LOWEST
        // rung, so the rule above chose 360p for a 1236x695 player and stayed
        // there until ABR climbed (the owner's `overlay-reveal {q:"360p"}`).
        // With no usable layout the top rung is the honest pick: a clean picture
        // that is too sharp for one instant is never a defect, and ABR steps it
        // down from a real bandwidth sample instead of never stepping up.
        const MIN_LAYOUT_H = 120;
        const rectOk = height >= MIN_LAYOUT_H;
        let chosen = 0;
        let bestH = Infinity;
        let topH = -1;
        for (let i = 0; i < levels.length; i++) {
          const lh = Number((levels[i] || {}).height);
          if (!Number.isFinite(lh) || lh <= 0) continue;
          if (rectOk && lh >= height && lh < bestH) { bestH = lh; chosen = i; }
          if (lh > topH) topH = lh;
        }
        if (bestH === Infinity && topH > 0) {
          for (let i = 0; i < levels.length; i++) {
            if (Number((levels[i] || {}).height) === topH) { chosen = i; break; }
          }
        }
        h.startLevel = chosen;
        const l = levels[chosen] || {};
        const name = l.height ? `${l.height}p` : (l.width ? `${l.width}w` : String(chosen));
        const bitrate = Number(l.bitrate);
        post({ t: 'ev', e: 'standby-level', d: { chosen, name, bitrate: Number.isFinite(bitrate) ? bitrate : null, count: levels.length, rungs: levels.map((x) => Number(x && x.height) || 0), rectH: Math.round(height), why: rectOk ? 'rect' : 'no-rect' } });
      }
      standbyLevelLogged = true;
    }
    jumpToLiveEdge();
  });
  h.on(Hls.Events.LEVEL_LOADED, jumpToLiveEdge);
  const st = () => {
    let dur = 0;
    try { dur = V.duration || 0; } catch { /* not ready */ }
    if (!isFinite(dur) || dur < 0 || dur >= 1e15) dur = 0;
    let pos = V.currentTime || 0;
    if (!isFinite(pos) || pos < 0 || pos >= 1e15) pos = 0;
    // Distance to the live edge, in the order of honesty:
    //   1. `h.latency` — what hls.js itself measures against the edge it knows
    //      about. The element's own seekable range is NOT that: on Twitch it
    //      ends at the stitched ad segments still listed ahead of the live
    //      content (measured 2026-11-08: a clean player holding 3.6s of buffer
    //      read as 8.6s behind, `overlay-catchup` fired on every tick and the
    //      reveal gate held it back forever), and on the native element it is
    //      the literal sentinel 1073741824 (`native-handoff {se: 1073741824}`
    //      in the owner's ko.adlog).
    //   2. buffered end - pos: the newest frame actually in hand.
    //   3. the seekable end, only when it is a real position (< 1e6 s).
    let lat = 0;
    let latSrc = 'none';
    try {
      const hl = typeof h.latency === 'number' ? h.latency : NaN;
      if (isFinite(hl) && hl >= 0 && hl < 1e6) { lat = hl; latSrc = 'hls'; }
    } catch { /* older hls.js */ }
    if (latSrc === 'none') {
      try {
        if (V.buffered && V.buffered.length) {
          const b = V.buffered.end(V.buffered.length - 1) - pos;
          if (isFinite(b) && b >= 0) { lat = b; latSrc = 'buffered'; }
        }
      } catch { /* not ready */ }
    }
    if (latSrc === 'none') {
      try {
        if (V.seekable && V.seekable.length) {
          const e = V.seekable.end(V.seekable.length - 1);
          if (isFinite(e) && e > 0 && e < 1e6) { lat = e - pos; latSrc = 'seekable'; }
        }
      } catch { /* not ready */ }
    }
    if (!isFinite(lat) || lat < 0) lat = 0;
    const levels = h.levels || [];
    let q = null;
    let bw = null;
    const lv = h.currentLevel >= 0 ? h.currentLevel : null;
    if (h.currentLevel >= 0 && levels[h.currentLevel]) {
      const l = levels[h.currentLevel];
      q = { name: l.height ? `${l.height}p` : `${l.width || ''}w`, w: l.width, h: l.height };
      const br = Number(l.bitrate);
      bw = Number.isFinite(br) ? br : null;
    }
    const qualities = levels.map((l, i) => ({
      id: i,
      name: l.height ? `${l.height}p` : `${l.width || ''}w`,
      w: l.width,
      h: l.height,
    }));
    // A drained live stream ends the element and then sits paused forever, so
    // 'Ended' gets its own name: the content side maps an unknown state to
    // NOT-live, which is what stops a dead YouTube layer from pinning a black
    // box over the deleted Twitch player.
    // readyState < HAVE_CURRENT_DATA means the element is not really producing
    // frames (measured at a 403 segment stall: paused=false / readyState=0 / no
    // buffer, which used to be reported as Playing and masked the failure).
    const state = V.ended
      ? 'Ended'
      : V.paused
        ? (V.readyState === 0 ? 'Idle' : 'Paused')
        : (V.readyState < 2 ? 'Buffering' : 'Playing');
    let buffered = 0;
    try {
      if (V.buffered && V.buffered.length) buffered = V.buffered.end(V.buffered.length - 1) - pos;
    } catch { /* not ready */ }
    return {
      state,
      paused: V.paused,
      muted: V.muted,
      volume: V.volume,
      rs: V.readyState,
      ns: V.networkState,
      err: V.error ? V.error.code : null,
      buffered: isFinite(buffered) ? Math.max(0, buffered) : 0,
      pos,
      lat,
      latSrc,
      dur,
      win: (() => {
        try {
          if (!V.seekable || !V.seekable.length) return 0;
          const ws = V.seekable.start(0);
          const we = V.seekable.end(V.seekable.length - 1);
          return isFinite(ws) && isFinite(we) && we > ws && we < 1e15 ? we - ws : 0;
        } catch { return 0; }
      })(),
      q,
      qcount: qualities.length,
      qualities,
      lv,
      bw,
    };
  };
  const sendSt = () => post({ t: 'st', st: st() });
  window.addEventListener('message', (ev) => {
    noteInbound(ev, 'head');
    if (ev.source !== window.parent || !PARENT_ORIGINS.has(ev.origin)) {
      noteInbound(ev, 'reject', 'source-or-origin');
      return;
    }
    const m = ev.data && ev.data.__koKick;
    if (!m || m._koToken !== PLAYER_TOKEN) {
      noteInbound(ev, 'reject', m ? 'token' : 'no-koKick');
      return;
    }
    noteInbound(ev, 'accept', m);
    PARENT_ORIGIN = ev.origin; // answers follow the page that owns us
    switch (m.t) {
      case 'load':
        try {
          currentUrl = m.url;
          reloaded = false;
          liveJumped = false;
          standbyLevelLogged = false;
          h.loadSource(m.url);
          h.attachMedia(V);
          V.play().catch(() => { /* autoplay policy — unlock via gesture */ });
        } catch (e) {
          post({ t: 'ev', e: 'error', d: String(e) });
        }
        break;
      case 'play':
        V.play().catch(() => { /* ignore */ });
        break;
      case 'state':
        // On-demand sample. A background tab's heartbeat can be throttled to
        // one message a minute, so the page pulls a fresh one when it becomes
        // visible instead of waiting for the next tick.
        sendSt();
        break;
      case 'pause':
        V.pause();
        break;
      case 'mute':
        V.muted = !!m.m;
        break;
      case 'volume':
        if (Number.isFinite(m.v)) V.volume = Math.max(0, Math.min(1, m.v));
        break;
      case 'seek':
        if (Number.isFinite(m.s) && m.s >= 0 && m.s < 1e15) {
          // Clamp into the actual seekable range (the live window), never
          // past the live edge — an un-clamped currentTime there silently
          // snaps back to the buffer head on the next 'st' (0.8.5: arrow
          // overshoot left the playhead visibly jittering instead of live).
          let lo = 0, hi = m.s;
          try {
            if (V.seekable && V.seekable.length) {
              lo = V.seekable.start(0);
              hi = V.seekable.end(V.seekable.length - 1);
            }
          } catch { /* not ready */ }
          V.currentTime = Math.max(lo, Math.min(hi, m.s));
        }
        break;
      case 'seekToLive':
        try {
          if (V.seekable && V.seekable.length) {
            const se = V.seekable.end(V.seekable.length - 1);
            const be = V.buffered && V.buffered.length ? V.buffered.end(V.buffered.length - 1) : 0;
            // Aim at the newest frame that can PLAY, never at `seekable.end`.
            // `seekable.end` is where the playlist says live is, not data this
            // player holds: seeking there parks the picture until the next
            // segment arrives — the owner's "chega ao final e trava, fica
            // pausado por 1 segundo, e o slider fica atrasado" (2026-11-11).
            // A buffered end ahead of us is playable right now; with nothing
            // buffered ahead, one sync window behind the edge is.
            const target = be > V.currentTime + 0.25 ? be : Math.max(0, se - LIVE_TARGET_SEC);
            V.currentTime = Math.min(target, Math.max(0, se - 0.2));
          }
        } catch { /* ignore */ }
        break;
      case 'quality':
        if (m.q === 'auto') h.currentLevel = -1;
        else if (Number.isInteger(m.q) && m.q >= 0 && m.q < h.levels.length) h.currentLevel = m.q;
        break;
      // Vertical quality menu (0.8.2): the REAL hls.js levels, not a static
      // guess list. 'levels' mirrors the {t:'st'} qualities shape; the menu
      // adds its own Auto row.
      case 'getLevels':
        post({
          t: 'levels',
          levels: (h.levels || []).map((l, i) => ({
            id: i,
            name: l.height ? `${l.height}p` : `${l.width || ''}w`,
            w: l.width,
            h: l.height,
          })),
        });
        break;
      case 'setLevel':
        if (m.l === 'auto') h.currentLevel = -1;
        else if (Number.isInteger(m.l) && m.l >= 0 && m.l < (h.levels || []).length) h.currentLevel = m.l;
        sendSt(); // the checkmark follows the engine, not the click
        break;
      case 'getState':
        sendSt();
        break;
    }
  });
  h.on(Hls.Events.ERROR, (_e, d) => {
    beacon('hls_err', { type: d.type, details: d.details, fatal: !!d.fatal });
    post({ t: 'ev', e: 'hls', d: String(d.details || d.type || ''), fatal: !!d.fatal, url: String(d.url || '').slice(0, 160) });
    if (d.fatal) {
      post({ t: 'ev', e: 'error', d: String(d.details || d.type) });
      // One reload per url (stale manifest on live switches); then the
      // content script's fallback (kick) takes over.
      if (currentUrl && !reloaded) {
        reloaded = true;
        setTimeout(() => {
          h.loadSource(currentUrl);
          h.attachMedia(V);
        }, 1500);
      }
    }
  });
  // The heartbeat is a TIMER, and a timer inside an iframe of a background tab
  // is throttled by Chrome (measured in the owner's ko.adlog 2026-11-08:
  // `playing-not-healthy` samples up to 32s apart while `pos` advanced at 1x).
  // The ad path's health gate counted ticks, so a sparse heartbeat made a
  // healthy clean player read as "never playing" and the 12s bound stopped the
  // overlay — the black panel he pasted with the tab in the background.
  // Publishing from the element's own events keeps the state fresh whenever
  // the media pipeline moves; the 200ms coalescing keeps it one message.
  let stQueued = 0;
  const sendStSoon = () => {
    if (stQueued) return;
    stQueued = setTimeout(() => { stQueued = 0; sendSt(); }, 200);
  };
  for (const ev of ['playing', 'timeupdate', 'progress', 'waiting', 'canplay', 'seeked', 'pause', 'volumechange']) {
    try { V.addEventListener(ev, sendStSoon); } catch { /* not ready */ }
  }
  setInterval(sendSt, 1000);
  // Report the first real frame immediately. The 1/s `st` heartbeat can lag
  // up to a second; the content script uses this to swap surfaces exactly when
  // the clean player can paint, not on a fixed timeout.
  let firstFrameSent = false;
  const firstFrame = () => {
    if (firstFrameSent || V.readyState < 2) return;
    firstFrameSent = true;
    post({ t: 'ev', e: 'firstframe', st: st() });
  };
  V.addEventListener('playing', firstFrame);
  post({ t: 'ready' });
} else {
  const IVS = window.IVSPlayerModule;
  beacon('ivs_page', { mod: typeof IVS, create: typeof (IVS || {}).create });
  const create = IVS.create;
  const ET = IVS.PlayerEventType || {};
  const p = create({
    wasmWorker: chrome.runtime.getURL('ivs/amazon-ivs-wasmworker.min.js'),
    wasmBinary: chrome.runtime.getURL('ivs/amazon-ivs-wasmworker.min.wasm'),
    logLevel: 'warn',
  });
  beacon('ivs_boot', { ver: p.getVersion(), worker: chrome.runtime.getURL('ivs/amazon-ivs-wasmworker.min.js').slice(-44) });
  p.attachHTMLVideoElement(V);
  p.setAutoplay(true);
  p.setMuted(true);

// A position to apply once the next load() completes (kick-style rewind:
// switch to the DVR url, then seek within the loaded broadcast).
let pendingSeek = null;
let pendingTries = 0; // seek retry budget (1/s) - give up instead of looping
let seekGen = 0;      // cancels a stale retry when a newer seek/live wins

function sendSt() {
  let q = null;
  try {
    const qq = p.getQuality();
    if (qq) q = { name: qq.name, w: qq.width, h: qq.height };
  } catch {
    /* not ready */
  }
  let qualities = [];
  try {
    qualities = p.getQualities().map((quality, id) => ({
      id,
      name: quality.name,
      w: quality.width,
      h: quality.height,
    }));
  } catch {
    /* not ready */
  }
  let dur = 0;
  try {
    dur = p.getDuration() || 0;
  } catch {
    /* not ready */
  }
  // Sanitize everything that reaches the bar: a poisoned seek (or IVS
  // quirks) can report MAX_SAFE_INTEGER / NaN positions — the content
  // script must never format Infinity or set an insane input range.
  let pos = 0;
  try {
    pos = p.getPosition();
  } catch {
    /* not ready */
  }
  if (!isFinite(pos) || pos < 0 || pos >= 1e15) pos = 0;
  // getLiveLatency() is the SDK's smoothed latency and does NOT update
  // immediately after a manual seek (measured: pos dropped 5s at t=0, lat
  // still read 1.5s until t≈5s). The buffered range end is the real newest
  // live frame and moves with the seek instantly, so the bar/pill and the
  // seekToLive target use `buffered.end - pos`. On the DVR/VOD url there is
  // no live edge: the player can buffer far ahead, which made this formula
  // report 30s+ "latency" and label the replay "LIVE -38s". A finite
  // duration identifies that url, where latency is meaningless (0). Live
  // streams report Infinity here (JSON turns that into null), so the
  // isFinite check must come before deciding "this is VOD".
  let lat = 0;
  if (!(isFinite(dur) && dur > 0)) {
    try {
      const b = p.getBuffered();
      if (b && isFinite(b.end) && isFinite(pos)) lat = Math.max(0, b.end - pos);
    } catch {
      /* not ready */
    }
    if (!(lat > 0)) {
      try {
        lat = p.getLiveLatency();
      } catch {
        /* not ready */
      }
    }
  }
  if (!isFinite(lat)) lat = 0;
  if (!isFinite(dur) || dur < 0 || dur >= 1e15) dur = 0;
  // The live element's own rewind window (seconds). A back-seek INSIDE it can be
  // done in place, without reloading the source — reloading is what makes the
  // picture stop while a seek is "applied" ("nao e pra ele pausar e despausar",
  // owner 2026-11-11).
  let win = 0;
  try {
    if (V.seekable && V.seekable.length) {
      const ws = V.seekable.start(0);
      const we = V.seekable.end(V.seekable.length - 1);
      if (isFinite(ws) && isFinite(we) && we > ws && we < 1e15) win = we - ws;
    }
  } catch { /* not ready */ }
  // The SAME measurement from the buffer, which is the number that decides an
  // in-place rewind. `V.seekable` is useless for that on a live IVS element:
  // it reports [0, 1073741824] (a sentinel) or nothing at all, while the
  // element really holds `pos - buffered.start(0)` seconds behind the
  // playhead (measured 2026-11-20: at pos 1934 with buffered 1908.6.. the
  // element held 25.4s, and a seek 12s back landed but STOPPED - paused=true,
  // readyState 1 - which is the owner's "flashes and the live gets in the way").
  // `hold` is what an arrow step may spend without reloading the source.
  let hold = 0;
  try {
    if (pos > 0 && V.buffered && V.buffered.length) {
      const bs = V.buffered.start(0);
      if (isFinite(bs)) hold = Math.max(0, pos - bs);
    }
  } catch { /* not ready */ }
  // Retry a pending rewind seek every poll until it lands, capped — IVS
  // drops a seekTo issued before the loaded media is seekable (first
  // Playing can fire with an empty seekable range), but a target that
  // never becomes reachable must give up instead of seeking forever
  // (that "video replays every second" bug — each seek restarts playback).
  // Compare in BOTH directions: IVS can start a replay url at its live edge
  // (pos > target), and the old `pos < pendingSeek - 1` test then declared
  // the seek landed without ever issuing it, so the rewind stayed at the edge.
  if (pendingSeek !== null && pendingSeek < 1e15) {
    if (pendingTries-- > 0) {
      if (Math.abs(pos - pendingSeek) > 1.5) {
        try {
          p.seekTo(pendingSeek);
        } catch {
          pendingSeek = null; // outside the timeline — give up quietly
        }
      } else {
        pendingSeek = null; // landed
      }
    } else {
      pendingSeek = null; // capped — stop hammering
    }
  }
  post({
    t: 'st',
    st: {
      state: p.getState(),
      paused: p.isPaused(),
      muted: p.isMuted(),
      volume: p.getVolume(),
      pos,
      lat,
      dur,
      win,
      hold,
      q,
      qcount: qualities.length,
      qualities,
    },
  });
}

window.addEventListener('message', (ev) => {
  noteInbound(ev, 'head');
  if (ev.source !== window.parent || !PARENT_ORIGINS.has(ev.origin)) {
    noteInbound(ev, 'reject', 'source-or-origin');
    return;
  }
  const m = ev.data && ev.data.__koKick;
  if (!m || m._koToken !== PLAYER_TOKEN) {
    noteInbound(ev, 'reject', m ? 'token' : 'no-koKick');
    return;
  }
  noteInbound(ev, 'accept', m);
  PARENT_ORIGIN = ev.origin; // answers follow the page that owns us
  switch (m.t) {
    case 'load':
      try {
        seekGen++;
        pendingSeek = null;
        p.load(m.url);
        if (Number.isFinite(m.seekTo) && m.seekTo > 0 && m.seekTo < 1e15) {
          pendingSeek = m.seekTo;
          pendingTries = 30;
        }
        p.play();
      } catch (e) {
        post({ t: 'ev', e: 'error', d: String(e) });
      }
      break;
    case 'play':
      try { p.play(); } catch (e) { /* ignore */ }
      break;
    case 'pause':
      try { p.pause(); } catch (e) { /* ignore */ }
      break;
    case 'mute':
      try { p.setMuted(!!m.m); } catch (e) { /* ignore */ }
      break;
    case 'volume':
      try { p.setVolume(m.v); } catch (e) { /* ignore */ }
      break;
    case 'seek':
      // IVS owns its own clock: writing video.currentTime (the HLS bridge's
      // path) is ignored/re-based on a live element, which is why a 5s
      // rewind looked like a forward jump. getPosition()/seekTo() are the
      // player's own timeline, so a relative arrow step lands correctly.
      try {
        if (Number.isFinite(m.s) && m.s >= 0 && m.s < 1e15) {
          const cur = p.getPosition() || 0;
          // A finite duration means this is the replay (DVR/VOD) url: its
          // seekable timeline is the whole broadcast, so a forward jump must
          // not be clamped to the buffered window (IVS reports buffered.end
          // near the playhead, which made every DVR seek look like "one
          // second forward"). A live url reports Infinity (mapped to 0)
          // duration; there the newest buffered frame is the edge.
          let edge = 0;
          let replay = false;
          try {
            const dur = p.getDuration();
            if (isFinite(dur) && dur > 0 && dur < 1e15) { edge = dur; replay = true; }
          } catch { /* not ready */ }
          if (!(edge > 0)) {
            try {
              const b = p.getBuffered();
              if (b && isFinite(b.end)) edge = b.end;
            } catch { /* not ready */ }
          }
          if (!(edge > 0)) {
            const lat = p.getLiveLatency();
            edge = cur + (isFinite(lat) && lat > 0 ? lat : 0);
          }
          const target = Math.max(0, Math.min(m.s, Math.max(0, edge - 0.25)));
          // IVS drops a seekTo issued while the live buffer is still
          // attaching (observed: first ArrowLeft after a fresh load did
          // nothing, second landed). Retry only when the player clearly did
          // not move: position reached/approached the target, or a live
          // rewind raised the latency. Same-target retries are harmless.
          const beforeLat = Math.max(0, edge - cur);
          const gen = ++seekGen;
          let tries = 0;
          const attempt = () => {
            if (gen !== seekGen) return; // a newer seek/live owns the player
            try { p.seekTo(target); p.play(); } catch { /* not ready */ }
            tries++;
            if (tries >= 3) return;
            setTimeout(() => {
              if (gen !== seekGen) return;
              try {
                const nowPos = p.getPosition() || 0;
                let nowLat = 0;
                try {
                  const b = p.getBuffered();
                  if (b && isFinite(b.end)) nowLat = Math.max(0, b.end - nowPos);
                } catch { /* not ready */ }
                // On the replay url only the position is meaningful: buffered
                // end is not an edge, so the live latency rise is not proof.
                const ok = Math.abs(nowPos - target) < 3 || (!replay && nowLat > beforeLat + 2);
                if (!ok) attempt();
              } catch { attempt(); }
            }, 450);
          };
          attempt();
        }
      } catch (e) { /* ignore */ }
      break;
    case 'seekToLive':
      seekGen++; // a pending ArrowLeft retry must not pull us back again
      try {
        // The newest actually-buffered frame is the live edge. getLiveLatency()
        // lags a manual rewind by several seconds, so `pos + getLiveLatency()`
        // used to "go live" to a point only just ahead of the rewound playhead.
        // Buffered end tracks the edge immediately and shares getPosition()'s
        // timeline. Do NOT use the media element's seekable.end: IVS reports a
        // sentinel ~2^30 on a live edge and seeking there froze the player.
        const cur = p.getPosition() || 0;
        let target = 0;
        try {
          const b = p.getBuffered();
          if (b && isFinite(b.end) && b.end > 0) target = b.end - 0.25;
        } catch { /* not ready */ }
        if (!(target > cur)) {
          try {
            const lat = p.getLiveLatency();
            if (isFinite(lat) && lat > 0) target = cur + lat;
          } catch { /* not ready */ }
        }
        if (target > 0 && target > cur + 0.5) p.seekTo(target);
        p.play(); // already at the edge, or start the seek immediately
      } catch (e) { /* ignore */ }
      break;
    case 'quality':
      try {
        if (m.q === 'auto') {
          p.setAutoQualityMode(true);
        } else if (Number.isInteger(m.q)) {
          const qualities = p.getQualities();
          const selected = qualities[m.q];
          if (selected) {
            p.setAutoQualityMode(false);
            p.setQuality(selected);
          }
        }
      } catch (e) { /* quality menu is best-effort */ }
      break;
    // Vertical quality menu (0.8.2): IVS's real quality ladder, same
    // {id,name,w,h} shape the 'st' message carries.
    case 'getLevels': {
      let levels = [];
      try {
        levels = p.getQualities().map((quality, id) => ({
          id,
          name: quality.name,
          w: quality.width,
          h: quality.height,
        }));
      } catch (e) { /* not ready yet */ }
      post({ t: 'levels', levels });
      break;
    }
    case 'setLevel':
      try {
        if (m.l === 'auto') {
          p.setAutoQualityMode(true);
        } else if (Number.isInteger(m.l) && m.l >= 0) {
          const selected = p.getQualities()[m.l];
          if (selected) {
            p.setAutoQualityMode(false);
            p.setQuality(selected);
          }
        }
      } catch (e) { /* quality menu is best-effort */ }
      sendSt(); // the checkmark follows the engine, not the click
      break;
    case 'getState':
      sendSt();
      break;
  }
});

try {
  p.addEventListener(ET.ERROR || 'PlayerError', (e) => {
    const info = { d: (e && e.message) || 'unknown', code: (e && e.code) || 0 };
    post({ t: 'ev', e: 'error', d: info.d, code: info.code });
    beacon('ivs_err', info);
  });
  p.addEventListener(ET.REBUFFERING || 'PlayerRebuffering', () => post({ t: 'ev', e: 'rebuffering' }));
} catch {
  /* event wiring is best-effort; state polling still reports errors via getState */
}
setInterval(sendSt, 1000);
post({ t: 'ready' });
} // /else (IVS engine)

// ---- pointer relay (BOTH engines) ---------------------------------------
// The frame covers the whole player, so a pointer over the picture never
// reaches the page: the page's own hover listener is blind exactly where the
// user moves the mouse ("passar o mouse e fazer hover pra mostrar o player
// tambem e inconsistente", owner 2026-11-11). This relay used to live INSIDE
// the hls.js branch, so the kick layer -- which runs on IVS -- never posted a
// single `ptr`: its bar could only be re-armed by the page's own rectangle
// hit-test, and the frame swallows exactly those events (owner 2026-11-16:
// "hover nao mostrava o player"). Installed once, for whichever engine loaded,
// with the engine/arm taken from the branch that actually ran: player.html
// loads ivs/index.js unconditionally, so the IVS global exists in HLS mode too
// and cannot identify the engine.
try {
  let ptrAt = 0;
  const engine = HLS_MODE ? 'hls' : 'ivs';
  const ptrTick = () => {
    const now = Date.now();
    if (now - ptrAt < 120) return;
    ptrAt = now;
    post({ t: 'ptr', engine, mode: BRIDGE_DIAG.mode });
  };
  for (const ev of ['pointermove', 'pointerdown']) document.addEventListener(ev, ptrTick, { capture: true, passive: true });
  document.addEventListener('pointerleave', () => { ptrAt = 0; }, { passive: true });
} catch { /* a document without pointer events */ }
