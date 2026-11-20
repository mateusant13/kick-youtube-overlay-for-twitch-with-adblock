// Kick Overlay — content script.
//
// Runs on https://www.twitch.tv/* AND https://www.youtube.com/*,
// https://m.youtube.com/*, https://youtu.be/* (see manifest). On a Twitch
// channel page it overlays the streamer's Kick or YouTube stream onto the
// Twitch player. On a YouTube page (watch / channel) it resolves the page's
// channel, finds the INVERSE mapping (a mapping whose yt/ytId matches) and
// mounts the Kick player over the YT player. kick.com itself is never
// modified by this content script.
//
// While enabled and the streamer is live on Kick or YouTube too, overlays the
// streamer's REAL Kick or YouTube stream over the Twitch player. The native
// Twitch player is paused and muted while either overlay player is active.
//
// Sources: Kick = the SAME engine kick.com uses (Amazon IVS web player,
// amazon-ivs-player) playing the same playback_url the VOD.RIP downloader
// (full HD, all IVS renditions). The IVS player runs in an extension
// page iframe (player.html) so the wasm worker is same-origin and the
// playback_url fetch rides on host_permissions. YouTube = the extension's
// OWN HLS player (player.html?m=hls) fed by a background-minted stream: the
// official live_stream embed cannot initialize on bot-gated/cookieless
// sessions (the server bakes "Erro 153" into the page), so the yt frame
// speaks the same __koKick protocol as IVS. Return-to-live is the #ko-golive
// pill (seekToLive over the bridge) — the frame has no native chip to lean
// on. The channel handle is resolved to its UC... id by the
// service worker.
//
// ONE player rendering at all times (user mandate 2026-08-13): the hidden
// players are PAUSED (not just covered) — kick frame, yt iframe, and the
// native Twitch player all pause while another layer is shown; switching
// resumes instantly (buffers are kept; kick/yt seek back to the live edge
// on return). Both overlay players offer seek-back within their live
// window: kick seeks its full DVR broadcast, the YT HLS layer rews into
// the ~20s live buffer. Arrow-left/right and the seekbar drive the same
// clamped seek path.
//
// Manual player switches NEVER wait on the Twitch player state: clicking
// KICK/YOUTUBE/TWITCH always takes effect immediately (the Twitch-live
// gate was removed 2026-08-13 — it was destroying the kick player on
// Twitch ad transitions and making the switch appear broken).
'use strict';

const KEY = 'ko.v2';
const POLL_MS = 20000;   // live-status re-check while enabled
const RECT_MS = 400;     // geometry + pause/mute enforcement tick
const YT_EMBED_GRACE = 8000; // yt embed must init (onReady) within this or fall back to kick
const SPA_MS = 900;      // Twitch SPA pathname poll (no reload on channel nav)
const HIDE_TICKS = 3;    // consecutive ticks without a Twitch player before hiding
const MAX_RECONNECT = 3; // kick fatal retries (fresh playback_url each time)
const ARROW_SEEK_SEC = 5; // per-press arrow-left/right step inside the live window
// How long a press's local rewind may go unanswered by a `st` report and still
// compose with the next press. A rapid burst (key repeat ~30/s, a human ~4/s)
// lands several presses inside ONE 1s report; each must add its own step.
const KICK_STEP_ACCUM_MS = 1200;
// Margin kept between a rewind and the edge of what the live element holds: the
// seek itself must not land ON the oldest buffered frame.
const KICK_STEP_MARGIN_SEC = 2;
// A `st` report whose position is within this of the pending target reflects
// that target (the seek landed), so the local burst is spent.
const KICK_STEP_ABSORB_SEC = 1.5;

// YouTube page hosts (inverse-mapping mode) vs Twitch (forward mapping).
const YT_HOSTS = new Set(['www.youtube.com', 'm.youtube.com', 'youtube.com', 'youtu.be']);
const onYtHost = () => YT_HOSTS.has(location.hostname);
// YT watch-page channel anchor: the meta tag is the stable one; ytInitialData
// header metadata is the best-effort fallback (YT DOM churns — never throw).
function ytPageChannelId() {
  try {
    const meta = document.querySelector('meta[itemprop="channelId"]');
    const id = meta && meta.getAttribute && meta.getAttribute('content');
    if (id && /^UC[0-9A-Za-z_-]{22}$/.test(id)) return id;
    const pr = window.ytInitialData && window.ytInitialData.playerResponse &&
      window.ytInitialData.playerResponse.videoDetails;
    if (pr && pr.channelId && /^UC[0-9A-Za-z_-]{22}$/.test(pr.channelId)) return pr.channelId;
    const md = window.ytplayer && window.ytplayer.config && window.ytplayer.config.data &&
      window.ytplayer.config.data.channelId;
    if (md && /^UC[0-9A-Za-z_-]{22}$/.test(md)) return md;
  } catch {
    /* best-effort */
  }
  return null;
}
// Channel handle/name identities the page advertises (watch pages carry the
// owner in the metadata microformat: <link itemprop="url" href="&/@handle">
// and <meta itemprop="name">; /@handle pages carry it in the pathname).
function ytPageHandle() {
  try {
    const mh = location.pathname.match(/^\/@([A-Za-z0-9._-]{3,40})(?:\/|$)/);
    if (mh) return mh[1].toLowerCase();
    const lk = document.querySelector('link[itemprop="url"]');
    const href = lk && lk.getAttribute && lk.getAttribute('href');
    const lm = href && href.match(/\/@([A-Za-z0-9._-]{3,40})(?:\/|$)/);
    if (lm) return lm[1].toLowerCase();
  } catch {
    /* best-effort */
  }
  return null;
}
function ytPageName() {
  try {
    const nm = document.querySelector('meta[itemprop="name"]');
    const v = nm && nm.getAttribute && nm.getAttribute('content');
    if (v && String(v).trim()) return String(v).trim().toLowerCase();
  } catch {
    /* best-effort */
  }
  return null;
}
// The watch/youtu.be video id the page is about (videoId fallback tier).
function ytPageVideoId() {
  try {
    if (location.hostname === 'youtu.be') {
      const m = location.pathname.match(/^\/([A-Za-z0-9_-]{6,20})(?:\/|$)/);
      if (m) return m[1];
    }
    if (location.pathname === '/watch') {
      const v = new URLSearchParams(location.search).get('v');
      if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
    }
  } catch {
    /* best-effort */
  }
  return null;
}
// A mapping may point at a live VIDEO (watch/youtu.be/live URL) instead of a
// channel. Such a value must mint exactly that video, not resolve the channel
// and pick whatever is live there at the moment.
function ytDirectVideoId(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (v.toLowerCase().startsWith('video:')) {
    const id = v.slice(6).trim();
    return /^[0-9A-Za-z_-]{11}$/.test(id) ? id : null;
  }
  const m = v.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([0-9A-Za-z_-]{11})(?:[?&#/]|$)/i,
  );
  return m ? m[1] : null;
}
// Identity of the page for the mapping table. Twitch: the channel slug.
// YouTube: the channel's UC id (watch/channel pages bake the meta tag into
// the HTML), else the /@handle, else the video id (youtu.be / watch).
function ytPageIdentity() {
  const cid = ytPageChannelId();
  if (cid) return 'host:yt:' + cid;
  const m = location.pathname.match(/^\/channel\/(UC[0-9A-Za-z_-]{22})(?:\/|$)/);
  if (m) return 'host:yt:' + m[1];
  const h = ytPageHandle();
  if (h) return 'host:yt:@' + h;
  const v = ytPageVideoId();
  if (v) return 'host:yt:' + v.toLowerCase();
  return null; // home / search / other non-channel pages: no overlay identity
}
// Inverse mapping on YT pages: the stored table maps twitchSlug -> {kick,
// yt, ytId}. The YT page searches the VALUES, not the keys. Priority
// (contract): ytId > yt-name > same-handle > videoId.
function resolveYtPageKick() {
  const cid = ytPageChannelId();
  const handle = ytPageHandle();
  const name = ytPageName();
  const names = new Set();
  if (cid) names.add(cid.toLowerCase());
  if (handle) names.add(handle);
  if (name) names.add(name);
  // Normalize a stored yt value ('@x', 'x', 'https://www.youtube.com/@x')
  // to its comparable last-segment form.
  const norm = (yt) => {
    let s = String(yt || '').trim().toLowerCase();
    if (!s) return null;
    const u = s.match(/youtube\.com\/(@?[A-Za-z0-9._-]{2,40})/);
    if (u) s = u[1];
    if (s.startsWith('http')) return null;
    return s.replace(/^@/, '');
  };
  const slugs = Object.keys(KO.mappings);
  for (const slug of slugs) {
    const m = KO.mappings[slug];
    if (!m || typeof m !== 'object') continue;
    if (cid && m.ytId && String(m.ytId).toLowerCase() === cid.toLowerCase()) return { slug, m, via: 'ytId' };
  }
  // A mapping may store a live VIDEO url. Match it before the name tiers so a
  // video-specific mapping wins over a channel/handle guess.
  const vid = ytPageVideoId();
  if (vid) {
    for (const slug of slugs) {
      const m = KO.mappings[slug];
      if (!m || typeof m !== 'object' || !m.yt) continue;
      if (ytDirectVideoId(m.yt) === vid) return { slug, m, via: 'video' };
    }
  }
  for (const slug of slugs) {
    const m = KO.mappings[slug];
    if (!m || typeof m !== 'object' || !m.yt) continue;
    const n = norm(m.yt);
    if (n && names.has(n)) return { slug, m, via: 'yt' };
  }
  // Same-handle: the mapping whose kick slug matches the page handle (kick
  // and YT handles collide most of the time).
  if (handle) {
    for (const slug of slugs) {
      const m = KO.mappings[slug];
      if (!m) continue;
      const kick = (typeof m === 'string' ? m : m.kick) || '';
      if (kick && kick.toLowerCase() === handle) return { slug, m: typeof m === 'string' ? { kick: m } : m, via: 'handle' };
    }
    // No stored mapping at all — same-handle doctrine (mirrors the Twitch
    // path's `m.kick || slug`): the kick channel named like the page.
    return { slug: 'host:yt:@' + handle, m: { kick: handle }, via: 'handle' };
  }
  // A YouTube VIDEO id and a UC channel id are not kick handles, and the tier
  // that derived one from the other invented a channel that cannot exist: every
  // such page then probed https://kick.com/api/v{1,2}/channels/<guessed> from
  // the youtube.com origin, which the browser blocks ("Unsafe attempt to load
  // URL ... from frame with URL https://www.youtube.com/watch?...", measured in
  // the owner console 2026-11-07, two blocked requests per video). No match,
  // no overlay -- the doctrine three lines above already says never guess
  // another streamer's stream onto a page.
  return null;
}
// Diagnostics stay inside the extension's service-worker console. Only the
// event name is logged there; payloads are intentionally not forwarded.
// Owner report 2026-11-11: "some minutes alt tabbed it pauses or mutes the
// stream". Nothing in the log said WHICH surface he lost or who paused it: the
// ad path publishes `audio-state` for the page's own elements only, and the
// layer he listens to in `player=kick` is a separate frame. One line on every
// visibility edge and on every player-state change makes the next alt-tab
// answerable instead of arguable.
function visAudio(tag) {
  try {
    const k = KO.kickState || {};
    const y = KO.ytState || {};
    const n = document.querySelector('video');
    const intent = window.KOAudio ? window.KOAudio.intent(KO.player === 'youtube' ? 'yt' : 'kick') : null;
    const d = {
      tag,
      hidden: !!document.hidden,
      player: KO.player,
      kick: { state: k.state || null, pos: k.pos == null ? null : +Number(k.pos).toFixed(1), muted: k.muted == null ? null : !!k.muted },
      yt: { state: y.state || null, ct: y.ct == null ? null : +Number(y.ct).toFixed(1), muted: y.muted == null ? null : !!y.muted },
      native: n ? { paused: !!n.paused, muted: !!n.muted } : null,
      intent: intent ? { muted: !!intent.muted, volume: +Number(intent.volume).toFixed(2) } : null,
    };
    // INTO ko.adlog, not only the service-worker console: `diag()` is a
    // console.debug and the owner's log is `chrome.storage.local['ko.adlog']`.
    // The bridge persists whatever arrives as this event (adblock-bridge.js).
    document.dispatchEvent(new CustomEvent('ko-adlog', { detail: JSON.stringify({ ev: 'vis-audio', d }) }));
  } catch {
    /* a diag line must never break the overlay */
  }
}

// ---- the clock the owner actually sees -----------------------------------
// The ring could say where the CLEAN player thought it was (`lat`) and where the
// NATIVE element sat (`ct`), but never "the live is at X and the screen shows
// Y", never "the picture went backwards and is showing those seconds again", and
// never "the display claims to be playing and has not moved in N seconds". His
// 2026-11-16 questions - "quando o player lag behind", "quando a live ta em x
// tempo em tempo real mas o display ta y tempo atras", "quando repeticoes
// acontecem" - are answered by these rows and by nothing else.
const DISP_SAMPLE_MS = 10000; // one row per 10 s while nothing changes
const DISP_FROZEN_MS = 2500; // a playing surface that has not moved this long is frozen
const DISP_REPEAT_SEC = 1; // a backwards step this large is a repeat of what he saw
const DISP_BEHIND_SEC = 8; // CLEAN_LAT_MAX: past this the picture is not live

// ---- the PAGE's own player: a bounded recovery from a stall ---------------
// Owner report 2026-11-18, verbatim: "to vendo uma live. travou do nada e nao
// quer destravar. com certeza destrava se eu clicar pause despause."
// His own ring (0.8.101, twitch.tv/alanzoka, `player=kick` with NO kick mirror:
// `kick:null`, `wrapShown:false` for the whole load):
//
//   39.7s  video-waiting {ct:29.9, rs:2, paused:false}  <- the segment stream stopped
//   42.8s  display-frozen {ms:3049, pos:29.88}          <- the clock he can see is stuck
//   45.6s  video-pause   {ct:30, rs:1, paused:true}     <- the PAGE parked its own element
//  +2m11s  display-clock ... PAUSED pos=29.98 buf=0.05  <- nothing of ours tried anything
//  +2m13s  (his own pause/unpause) ct:0 -> ct:0.1 rs:4  <- the cure he named
//
// The pause was not ours: no `native-pause`, no `ad-ui-hold`, no `ad-hold`, no
// ownership (there was no layer at all), and the element was `rs:1` with 0.05 s
// in front of the playhead. The extension had MEASURED the freeze since 0.8.98
// and had nothing to do with it: `stall`/`reconnect` only ever existed for OUR
// frame, and the native recovery only ever ran on the ad path's hand-back.
// This is that recovery for the page's own surface, driven by the sample that
// was already being taken once a second.
const NATIVE_STALL_MS = 4000; // a stalled episode this long is the "travou" he reports
const NATIVE_STALL_BUFFER_SEC = 1.5; // less forward media than this is not a re-buffer
const NATIVE_USER_PAUSE_MS = 2000; // a pause this soon after real input is HIS
const NATIVE_RECOVER_GAP_MS = 10000; // between attempts: a loop here is the defect
const NATIVE_RECOVER_MAX = 2; // resume inside held media, then ONE source refresh

// Which surface is on screen right now, and where it is. `player=twitch` means
// the page's own element; anything else means our frame, and in that mode the
// native is paused BY DESIGN, so reading it would answer the wrong question.
function dispSurface() {
  // WHAT IS ON SCREEN, not what he PREFERS. His own srdogg load (2026-11-16)
  // reads `player:"kick"` with `kick:null` while the page's native element plays
  // at `rs:4, ct:545` - mapping the preference would have reported NO-SURFACE
  // for a healthy picture. The product already owns this answer in
  // `overlayOwnsPicture()` (a frame report younger than STALE_REPORT_MS, minus a
  // layer proven dead), so the sampler asks it instead of re-deriving ownership.
  if (overlayOwnsPicture()) return KO.player === 'youtube' ? 'youtube' : 'kick';
  return 'twitch';
}

// One sample, on the 1 s timer below. Transition-only output: a row per surface
// change, per verdict change, and at most one every DISP_SAMPLE_MS otherwise -
// the same rule the ad path learned when 70 identical heartbeat lines buried a
// chronology (0.8.90).
function dispSample() {
  try {
    if (document.hidden) {
      // A THROTTLED TAB MEASURES THE THROTTLE, NOT THE PRODUCT (AGENTS.md, the
      // alt-tab wave record), so nothing is measured and nothing is acted on.
      // The decision still gets its row: "nothing happened because the tab was
      // hidden" is the answer a report needs, and it is one row per hidden
      // episode, not one per throttled tick.
      nativeStallHiddenRefuse();
      return;
    }
    const now = Date.now();
    const srf = dispSurface();
    let pos = null;
    let lat = null;
    let latSrc = null;
    let playing = false;
    let buf = null;
    let pageVideo = null;
    let rs = null;
    if (srf === 'kick' || srf === 'youtube') {
      const st = (srf === 'kick' ? KO.kickState : KO.ytState) || {};
      pos = Number(srf === 'kick' ? st.pos : st.ct);
      lat = isFinite(Number(st.lat)) ? Number(st.lat) : null;
      latSrc = lat == null ? null : 'frame';
      playing = st.state === 'Playing';
    } else {
      const v = twitchVideo();
      pageVideo = v;
      if (v) {
        pos = Number(v.currentTime);
        rs = Number(v.readyState);
        playing = !v.paused && v.readyState >= 2;
        // Twitch reports the live edge as the literal 2^30 sentinel on most
        // loads, and then the distance to it is NOT-MEASURABLE - which the row
        // says instead of inventing a number.
        // The runway in hand is measurable even when the live edge is not, and
        // it is what separates "behind live" from "about to freeze": a native at
        // 0.2 s of forward buffer is a stall with a second of delay on it.
        try {
          const b = v.buffered;
          if (b && b.length) buf = Math.max(0, Number(b.end(b.length - 1)) - pos);
        } catch {
          buf = null;
        }
        let e = 0;
        try {
          const s = v.seekable;
          e = s && s.length ? Number(s.end(s.length - 1)) : 0;
        } catch {
          e = 0;
        }
        if (isFinite(e) && e > 0 && e < 1e6) {
          lat = e - pos;
          latSrc = 'seekable';
        }
      }
    }
    if (!isFinite(pos)) {
      // No surface to measure is ITSELF the answer: `player=kick` with no kick
      // state means the layer never produced a position, and silence in the ring
      // used to be indistinguishable from "the sampler never ran". One row per
      // transition, never per tick.
      const n0 = (KO.disp = KO.disp || { srf: null, pos: null, movedAt: 0, verdict: null, loggedAt: 0 });
      if (n0.verdict !== 'NO-SURFACE') {
        n0.verdict = 'NO-SURFACE';
        n0.srf = null;
        n0.pos = null;
        n0.loggedAt = now;
        diag('display-clock', {
          srf: null,
          pos: null,
          delta: null,
          lat: null,
          latSrc: null,
          playing: false,
          verdict: 'NO-SURFACE',
          why: srf === 'kick' ? (KO.kickState ? 'kick state has no pos' : 'no kick state') : srf === 'youtube' ? 'no yt position' : 'no page video',
        });
      }
      return;
    }
    const d = (KO.disp = KO.disp || { srf: null, pos: null, movedAt: 0, verdict: null, loggedAt: 0 });
    const delta = d.srf === srf && d.pos != null ? pos - d.pos : null;
    if (d.srf !== srf || delta == null || Math.abs(delta) > 0.05) d.movedAt = now;
    let verdict;
    if (!playing) verdict = 'PAUSED';
    else if (delta != null && delta <= -DISP_REPEAT_SEC) verdict = 'REPEAT';
    else if (now - d.movedAt > DISP_FROZEN_MS) verdict = 'FROZEN';
    else if (lat != null && lat > DISP_BEHIND_SEC) verdict = 'BEHIND';
    else verdict = 'LIVE';
    const transition = d.srf !== srf || d.verdict !== verdict;
    if (transition || verdict === 'REPEAT' || now - d.loggedAt >= DISP_SAMPLE_MS) {
      const row = {
        srf,
        pos: +pos.toFixed(2),
        delta: delta == null ? null : +delta.toFixed(2),
        lat: lat == null ? null : +lat.toFixed(2),
        latSrc,
        buf: buf == null ? null : +buf.toFixed(2),
        rs,
        playing,
        verdict,
        movedMs: d.movedAt ? now - d.movedAt : null,
      };
      diag('display-clock', row);
      // A repeat is its own sentence: "the picture went back N seconds and will
      // show what he already saw". The clock row carries the numbers; this row
      // names the event so the verdict tool can count them.
      if (verdict === 'REPEAT') {
        diag('display-repeat', {
          srf,
          from: d.pos == null ? null : +d.pos.toFixed(2),
          to: +pos.toFixed(2),
          back: delta == null ? null : +(-delta).toFixed(2),
        });
      }
      if (transition && verdict === 'FROZEN') {
        diag('display-frozen', { srf, pos: +pos.toFixed(2), ms: d.movedAt ? now - d.movedAt : null });
      }
      d.loggedAt = now;
    }
    d.srf = srf;
    d.pos = pos;
    d.verdict = verdict;
    // The CURRENT answer, readable without a row: two identical samples inside
    // DISP_SAMPLE_MS emit nothing by design, and "what does the display say right
    // now" must still be answerable (the suites read it, and so can a probe).
    d.last = { srf, pos: +pos.toFixed(2), delta: delta == null ? null : +delta.toFixed(2), lat: lat == null ? null : +lat.toFixed(2), latSrc, buf: buf == null ? null : +buf.toFixed(2), rs, playing, verdict };
    // The page's own element gets the same second of attention. It runs AFTER
    // the row, so the log always holds the state that caused the attempt before
    // the attempt itself.
    if (srf === 'twitch') {
      try {
        nativeStallWatch(pageVideo, now, { frozen: verdict === 'FROZEN', movedMs: d.movedAt ? now - d.movedAt : 0 });
      } catch {
        /* a recovery must never break the sampler */
      }
    } else {
      // The layer owns the picture, so `dispSurface()` never routes the page's
      // element here at all - and a native parked in a stall SHAPE under our
      // picture is exactly the case the layer's own watchdog owns. Say so once,
      // or a ring cannot tell "the layer had it" from "nothing ran".
      nativeStallOwnedRefuse();
    }
  } catch {
    /* a diag line must never break the overlay */
  }
}

// ---- the recovery itself ---------------------------------------------------
// Rows are transitions with their numbers, never per tick: one `native-stall`
// when an episode is named, one row per attempt, one row when the clock comes
// back or when the budget is spent.
function nativeStallIdle() {
  const nat = KO.nat;
  if (!nat) return;
  nat.since = 0;
  nat.why = '';
  nat.logged = false;
  nat.failed = false;
  nat.tries = 0;
  nat.lastAt = 0;
  nat.from = null;
  nat.refuse = '';
}

// A REFUSAL IS A DECISION, AND EVERY REPORT IS ANSWERED FROM THE LOG. This
// watchdog refuses far more often than it acts - the owner's own pause, a hidden
// tab, a layer or the ad path owning the picture, a spent budget - and until now
// every one of those returns was SILENT, which is why a ring can read as "the
// extension did nothing" when it in fact chose not to. One row per reason per
// episode (`nat.refuse` is the dedupe key, cleared when the element is healthy
// again or the surface changes), never one per tick: a site that can fire on an
// unchanged state is the defect this repo already paid for.
//
// The reason vocabulary:
//   user-paused    real input landed within NATIVE_USER_PAUSE_MS of the pause
//   hidden         the pause was stamped while the tab was hidden (the throttle)
//   overlay-owned  a layer of ours has the picture; its watchdog owns the native
//   ad-owned       the ad path has the screen (clean player or painted cover)
//   cold-hold      our own cold cover is up: there is no picture to protect
//   budget-spent   `native-stall-failed` carries this one, with the ceiling
function nativeStallRefuse(why, data) {
  const nat = (KO.nat = KO.nat || { since: 0, tries: 0, lastAt: 0, why: '', logged: false, failed: false, from: null, refuse: '' });
  const first = nat.refuse !== why;
  // The attempt state does not survive a refusal: whoever takes over next (the
  // layer, the user, a visible tab) starts the episode from zero, or a stale
  // `since` would make the first sample after the hand-back act immediately.
  nat.since = 0;
  nat.tries = 0;
  nat.lastAt = 0;
  nat.logged = false;
  nat.failed = false;
  nat.from = null;
  if (!first) return;
  nat.refuse = why;
  diag('native-stall-refused', Object.assign({ why }, data || {}));
}

// The SHAPE of a stall, for the two sites that refuse WITHOUT running the full
// judgement (a hidden tab, a layer that owns the picture). Same rule the
// watchdog applies, and the same reason for it: `rs < 3` alone or a thin buffer
// alone is NOT a stall - hls.js keeps a healthy live element at 1.3-1.6 s of
// runway while it advances 1.00 s per second (0.8.102 fired on exactly that).
// Only an element that is parked, or cannot play forward, with nothing in front
// of the playhead is a shape worth a row.
function nativeStallShape(v) {
  const rs = Number(v.readyState || 0);
  const buf = +nativeRunway(v).toFixed(2);
  return {
    paused: !!v.paused,
    rs,
    buf,
    ct: +Number(v.currentTime || 0).toFixed(2),
    actionable: (!!v.paused || rs < 3) && buf < NATIVE_STALL_BUFFER_SEC,
  };
}

// A HIDDEN TAB DECIDES NOTHING (the alt-tab wave record in AGENTS.md): the
// sampler returns before it measures anything, and the watchdog never runs, so
// the refusal has to be written from here or it is not answerable at all. Gated
// on the shape and on `nat.refuse`, so a throttled tab writes ONE row per hidden
// episode instead of one per minute.
function nativeStallHiddenRefuse() {
  try {
    if (!KO.enabled) return;
    const v = twitchVideo();
    if (!v || !v.isConnected) return;
    if (KO.twPaused.has(v)) return; // we parked it for a layer: by design, not a refusal
    const s = nativeStallShape(v);
    if (!s.actionable) return nativeStallIdle();
    // NO script code above reads ownership here: `overlayOwnsPicture()` writes
    // the picture clocks, and a hidden tab deciding the hysteresis it will see
    // when the user comes back is exactly the "a hidden tab decides nothing"
    // defect. The published owner travels as context instead.
    nativeStallRefuse('hidden', { ct: s.ct, rs: s.rs, buf: s.buf, paused: s.paused, owner: KO.ownerAttr || null });
  } catch {
    /* a refusal row must never break the sampler */
  }
}

// The layer owns the picture, so `dispSurface()` never routes this element to
// the watchdog at all. The refusal is written from the sampler's layer branch:
// the native is in a stall shape while our picture is on screen, which is the
// case the layer's own watchdog owns.
function nativeStallOwnedRefuse() {
  try {
    const v = twitchVideo();
    if (!v || !v.isConnected) return nativeStallIdle();
    // `KO.twPaused` is what we do on purpose when a layer takes over: not a
    // refusal, and it must not be a row on every kick session.
    if (KO.twPaused.has(v)) return nativeStallIdle();
    const s = nativeStallShape(v);
    if (!s.actionable) return nativeStallIdle();
    nativeStallRefuse('overlay-owned', { ct: s.ct, rs: s.rs, buf: s.buf, paused: s.paused });
  } catch {
    /* a refusal row must never break the sampler */
  }
}

// A pause is not a user pause by itself. Two facts decide: WHEN it happened
// relative to real input, and what the element looked like. A trusted click or
// key lands in INPUT_FRESH_MS of the pause it causes (measured: the owner's own
// pause/unpause at 2m13 of his ring), while the page pausing its own frozen
// element lands with no input at all. The per-element stamp is the record, the
// same rule `KO.twPaused` already applies to the elements we paused ourselves.
function installNativeStamp() {
  if (KO.natStamp) return;
  KO.natStamp = true;
  const mark = (ev) => {
    KO.lastInputAt = Date.now();
    KO.lastInputWhat = String((ev && ev.type) || '');
  };
  for (const t of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click']) {
    try {
      document.addEventListener(t, mark, { capture: true, passive: true });
    } catch {
      /* an engine without capture must not break the sampler */
    }
  }
  try {
    document.addEventListener(
      'pause',
      (e) => {
        const t = e && e.target;
        if (!t || t.tagName !== 'VIDEO') return;
        KO.natPause = {
          el: t,
          at: Date.now(),
          ct: +Number(t.currentTime || 0).toFixed(2),
          rs: t.readyState,
          hidden: !!document.hidden,
          inputAgeMs: KO.lastInputAt ? Date.now() - KO.lastInputAt : null,
          input: KO.lastInputWhat || null,
          ours: KO.twPaused.has(t),
        };
      },
      true,
    );
  } catch {
    /* ignore */
  }
}

// Forward media in hand AT THE PLAYHEAD. `buf` on the clock row is the distance
// to the newest downloaded frame, which can be a later range entirely; the
// runway that decides whether play() can start is the one the playhead sits in.
function nativeRunway(v) {
  try {
    const ct = Number(v.currentTime || 0);
    let ahead = 0;
    const b = v.buffered;
    for (let i = 0; i < (b ? b.length : 0); i++) {
      if (ct >= b.start(i) - 0.1 && ct <= b.end(i) + 0.1) ahead = Math.max(ahead, b.end(i) - ct);
    }
    return ahead;
  } catch {
    return 0;
  }
}

// "No overlay owns the picture" has to include the AD PATH, which mounts its own
// frame (#ko-adfix) over the same element. The ad path owns the hand-back itself
// (native-resume / native-nudge / native-recover), and two recoveries on one
// element would fight - the defect 0.8.78 already paid for.
//
// PRESENCE IS NOT OWNERSHIP. Measured on the guest 2026-11-18 (twitch.tv/rodil,
// 0.8.102): `#ko-adfix` AND `#ko-adfix-cover` were both mounted with NO pod
// running (the standby preload sits at 1% opacity; the cover is `display:none`),
// `data-ko-audio-vis` was `twitch`, and a presence test blocked the recovery of
// an element the page had parked at `rs:1, ct:0` - the exact defect this fixes.
// So the test is what the ad path PUBLISHES about the picture:
//  - `data-ko-audio-vis="ad"`: the audio authority says the clean player is the
//    visible surface (the claim covers the pre-reveal hold, when the native is
//    parked and the cover is not painted yet);
//  - the cover is painted (a pod must not be watched);
//  - the frame is above 1% opacity (it mounts at 0.01 and is switched to 1 the
//    moment it takes the picture).
function adPathOwnsScreen() {
  try {
    const root = document.documentElement;
    if (String(root.getAttribute('data-ko-audio-vis') || '') === 'ad') return true;
    const cover = document.getElementById('ko-adfix-cover');
    if (cover && cover.isConnected && getComputedStyle(cover).display !== 'none') return true;
    const frame = document.getElementById('ko-adfix');
    if (frame && frame.isConnected) {
      const op = parseFloat(String(getComputedStyle(frame).opacity || '0'));
      if (Number.isFinite(op) && op > 0.05) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// A live element reports an infinite (or 2^30 sentinel) duration; a rewind or a
// VOD reports a real one. The refresh below jumps to whatever the source's
// timeline starts at, which is the live edge for a live element and the USER'S
// POSITION for anything else - so it is never applied to the latter.
function nativeIsLive(v) {
  try {
    const d = Number(v.duration);
    return !isFinite(d) || d <= 0;
  } catch {
    return false;
  }
}

// Rewind INSIDE the range the playhead already sits in, and only when that
// range cannot start playing on its own. Never the "range ended before the
// playhead" branch: that position is a fresh forward seek into media not yet
// downloaded, and moving it back is the jump-cut the owner reports as repetition.
function nudgeInsideHeldMedia(v) {
  try {
    const ct = Number(v.currentTime || 0);
    const b = v.buffered;
    let ahead = 0;
    let target = null;
    for (let i = 0; i < (b ? b.length : 0); i++) {
      if (!(ct >= b.start(i) - 0.1 && ct <= b.end(i) + 0.1)) continue;
      ahead = Math.max(ahead, b.end(i) - ct);
      if (b.end(i) - b.start(i) >= NATIVE_STALL_BUFFER_SEC + 0.5 && b.end(i) - ct < NATIVE_STALL_BUFFER_SEC) {
        target = Math.max(target === null ? -Infinity : target, Math.max(b.start(i), b.end(i) - NATIVE_STALL_BUFFER_SEC));
      }
    }
    if (target === null || !(target < ct - 0.25)) return null;
    v.currentTime = target;
    return { from: +ct.toFixed(2), to: +target.toFixed(2), ahead: +ahead.toFixed(2) };
  } catch {
    return null;
  }
}

// One second of judgement over the page's element. Never a hidden tab (the
// sampler does not even run there), never a user pause, never while an overlay
// owns the picture, never on a DVR/VOD position, never a loop.
function nativeStallWatch(v, now, sample) {
  const nat = (KO.nat = KO.nat || { since: 0, tries: 0, lastAt: 0, why: '', logged: false, failed: false, from: null, refuse: '' });
  if (!KO.enabled || !v || !v.isConnected) return nativeStallIdle();
  const rs = Number(v.readyState || 0);
  const ct = +Number(v.currentTime || 0).toFixed(2);
  const runway = +nativeRunway(v).toFixed(2);
  const starved = runway < NATIVE_STALL_BUFFER_SEC;
  // The SHAPE that would have been actionable if nothing else owned the screen:
  // parked with nothing in front of the playhead, or unable to play forward. A
  // refusal row is only written for a stall that WOULD have been acted on -
  // otherwise a healthy native under an ad window writes a row per ad, and a
  // row that fires on unchanged healthy state is the defect this repo paid for.
  const stalledShape = v.paused ? starved : rs < 3 || !!sample.frozen;
  // Every guard below is a DECISION, so it says so (see `nativeStallRefuse`).
  // The order is the order the pictures are protected in: ours first, then the
  // page's own park, then the surfaces.
  if (KO.twPaused.has(v)) {
    // We parked it ourselves for a layer: by design, no episode, no row.
    return nativeStallIdle();
  }
  // Which surface holds the screen right now, asked ONCE: each predicate stamps
  // the picture clocks, and asking twice inside one tick is a decision made on
  // state this tick changed.
  const screenOwner = coldHoldActive() ? 'cold-hold' : overlayOwnsPicture() ? 'overlay-owned' : adPathOwnsScreen() ? 'ad-owned' : '';
  if (screenOwner) {
    if (!stalledShape) return nativeStallIdle();
    return nativeStallRefuse(screenOwner, { ct, rs, buf: runway, paused: !!v.paused });
  }
  // A THIN FORWARD BUFFER IS THE HEALTHY STATE OF A TWITCH LIVE, not a stall.
  // hls.js keeps the playhead `liveSyncDuration` behind the edge, so his own
  // ring measures 1.32-1.63 s of runway on a picture that is advancing 1.00 s
  // per second. 0.8.102 used `runway < 1.5` as a stall trigger and fired on
  // exactly that: `native-stall {why:"clock-frozen", rs:4, buf:1.43,
  // movedMs:0}` on a `display-clock ... delta:5.99 verdict:LIVE` one ms earlier,
  // then `play()` on an element already playing and, on the second step, a
  // source RELOAD of a healthy player (955 s of his ring). A stall is now the
  // CLOCK not advancing: `movedMs` past `DISP_FROZEN_MS`, or a page pause.
  const advancing = sample.movedMs != null && sample.movedMs < DISP_FROZEN_MS;
  const healthy = !v.paused && rs >= 3 && advancing;
  if (healthy) {
    if (nat.tries && !nat.failed) {
      // The transition that answers the report: it came back, and how long the
      // frozen picture lasted after the first attempt.
      diag('native-stall-recovered', { tries: nat.tries, ms: nat.lastAt ? now - nat.lastAt : null, ct, rs, buf: runway });
    }
    return nativeStallIdle();
  }
  if (v.paused) {
    const p = KO.natPause && KO.natPause.el === v ? KO.natPause : null;
    if (!p) {
      // A pause nobody stamped is NOT attributable: the `pause` listener may have
      // been attached after it, or a page script parked the element before boot.
      // Resuming it can undo the user's own pause, so a starved one is refused
      // with a row - and a parked element with media in front of it is simply
      // parked, which is not an episode at all.
      if (!starved) return nativeStallIdle();
      return nativeStallRefuse('unattributed-pause', { ct, rs, buf: runway });
    }
    const fresh = p.inputAgeMs != null && p.inputAgeMs <= NATIVE_USER_PAUSE_MS;
    if (fresh) {
      // HIS PAUSE, and it stays paused: the same distinction `resumeRefusedByUser`
      // makes on the pod path, for the same reason (a 30 s pause of his own must
      // not be undone by a watchdog that thinks it knows better).
      return nativeStallRefuse('user-paused', { ct, rs, buf: runway, inputAgeMs: p.inputAgeMs, input: p.input || null });
    }
    if (p.hidden) return nativeStallRefuse('hidden', { ct, rs, buf: runway });
    if (p.ours) return nativeStallIdle(); // we parked it: by design
    if (!starved) return nativeStallIdle(); // a healthy parked player stays parked
    if (now - p.at < NATIVE_STALL_MS) return; // give the page's own reload a beat
  } else if (!(rs < 3 || sample.frozen)) {
    // `starved` deliberately absent: a thin forward buffer on an ADVANCING
    // element is hls.js's steady state, and poking it is the jump-cut. Only a
    // clock that stopped (`sample.frozen`) or an element that cannot play
    // forward (`rs < 3`) is a stall.
    return nativeStallIdle();
  }
  if (!nat.since) {
    nat.since = now - Math.max(0, Math.min(Number(sample.movedMs) || 0, 600000));
    nat.from = ct;
  }
  if (now - nat.since < NATIVE_STALL_MS) return;
  if (!nat.logged) {
    nat.logged = true;
    nat.why = v.paused ? 'page-pause-starved' : rs < 3 ? 'no-future-data' : 'clock-frozen';
    // NAMES ITSELF. "Was it the page, us, or him" is answered here: `inputAgeMs`
    // is the distance from the last real input to the pause, `ours` is whether
    // this extension had parked the element, and `owner` is who the extension
    // believed owned the picture (empty = nobody).
    diag('native-stall', {
      why: nat.why,
      from: nat.from,
      to: ct,
      rs,
      buf: runway,
      playing: !v.paused,
      paused: !!v.paused,
      movedMs: sample.movedMs == null ? null : +sample.movedMs,
      inputAgeMs: KO.natPause && KO.natPause.el === v ? KO.natPause.inputAgeMs : null,
      owner: KO.ownerAttr || null,
    });
  }
  if (nat.lastAt && now - nat.lastAt < NATIVE_RECOVER_GAP_MS) return;
  if (nat.tries >= NATIVE_RECOVER_MAX) {
    if (!nat.failed) {
      nat.failed = true;
      // The row that closes the episode AND names the ceiling it was stopped by:
      // "the budget is spent, here is the number, nothing more will be tried
      // until the element changes state". A retry loop that never stops is the
      // defect this repo already paid for (the `stall`/`reconnect` wave in
      // AGENTS.md: three reconnects on a picture frozen at the same position).
      diag('native-stall-failed', { tries: nat.tries, max: NATIVE_RECOVER_MAX, ct, rs, buf: runway, why: nat.why });
    }
    return;
  }
  nat.tries += 1;
  nat.lastAt = now;
  if (nat.tries === 1) {
    // THE CHEAPEST ACTION THAT CAN WORK, in this order and no other:
    //  1. the element merely PAUSED: `play()` - one call, no position moved;
    //  2. it is short of runway INSIDE media it already holds: move the playhead
    //     back to the start of that range, which is a local seek in downloaded
    //     data, not a fetch;
    //  3. only then anything heavier (`load()`), and never on a DVR position.
    // `v.load()` on Twitch's own element loses the DVR offset and can trigger a
    // preroll, so it is never the first move.
    const nudged = v.paused ? null : nudgeInsideHeldMedia(v);
    try {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* detached */
    }
    diag('native-stall-resume', {
      step: 1,
      action: nudged ? 'nudge+play' : 'play',
      from: nudged ? nudged.from : ct,
      to: nudged ? nudged.to : ct,
      rs,
      buf: runway,
      nudged: nudged ? nudged.to : null,
      why: nat.why,
    });
    return;
  }
  // Still stalled with the resume spent: reload the source once. Measured in the
  // guest 2026-11-18 (`_evidence/KO-20261118-01-guest.txt`, 0.8.102): the page
  // parked its own element at `{paused:true, rs:1, ct:0}` and the resume step
  // took it back to `{paused:false, rs:4, buf:1.63}` in one second. Never on a
  // DVR/VOD: there the rebuild lands at the START of the timeline, not at the
  // edge, which is the jump he reports.
  if (!nativeIsLive(v)) {
    diag('native-stall-skipped', { why: 'not-live', ct, rs, buf: runway, dur: Number.isFinite(Number(v.duration)) ? Math.round(Number(v.duration)) : 'inf' });
    nat.tries = NATIVE_RECOVER_MAX;
    nat.failed = true;
    return;
  }
  try {
    v.load();
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  } catch {
    /* detached */
  }
  diag('native-stall-reload', { step: nat.tries, action: 'reload+play', from: ct, to: 0, rs, buf: runway, why: nat.why });
}

// The audio authority cannot write the log itself (it has no message channel and
// must stay side-effect free); it dispatches, and this forwards. One listener,
// attached once, so a second copy of content.js cannot double every audio line.
function listenAudioLog() {
  if (window.__koAudioLog) return;
  window.__koAudioLog = true;
  try {
    document.addEventListener(
      'ko-audio-log',
      (ev) => {
        try {
          const d = JSON.parse(String(ev && ev.detail));
          if (d && typeof d.ev === 'string') diag(d.ev, d.d || {});
        } catch {
          /* malformed line */
        }
      },
      true,
    );
  } catch {
    /* document gone */
  }
}

function diag(ev, data) {
  const d = data || {};
  try {
    chrome.runtime.sendMessage({ __koDiag: { ev, data: d } }, () => void chrome.runtime.lastError);
  } catch {
    /* beacon must never break the overlay */
  }
  // ...AND into the ring the owner's reports are read from. The worker message
  // above only reaches the extension console: every ownership decision, pause and
  // player switch this file reported for two days was invisible in `ko.adlog`,
  // which is why the same question had to be asked again (owner 2026-11-12:
  // "era pros logs te falar TUDO que eu ja te falei antes").
  try {
    document.dispatchEvent(new CustomEvent('ko-adlog', { detail: JSON.stringify({ ev, d }) }));
  } catch {
    /* document may be gone */
  }
}

// Fire-and-forget async entry points (probe/apply/reconnect/init) must
// never reject into the console or the chrome://extensions error badge.
// Any failure becomes a diag event instead.
function fire(fn) {
  try {
    const p = fn();
    if (p && typeof p.catch === 'function') {
      p.catch((e) => diag('guard', { err: String((e && e.message) || e).slice(0, 120) }));
    }
  } catch (e) {
    diag('guard', { err: String((e && e.message) || e).slice(0, 120) });
  }
}

// Twitch routes that look like /<slug> but are not channels.
const NOT_CHANNEL = new Set([
  'directory', 'downloads', 'friends', 'gift', 'jobs', 'login', 'notifications',
  'p', 'prime', 'settings', 'subscriptions', 'turbo', 'events', 'search',
  'wallet', 'moderation', 'popout', 'videos', 'clips', 'team', 'tags',
  // Single-segment pages that are NOT a channel root either: they have no
  // channel player (and no channel of that name — Twitch reserves the path).
  'clip', 'following', 'inventory', 'drops', 'squad', 'store', 'activate',
]);

// Build marker for the diag stream — lets us tell which code a tab runs
// (content scripts of pre-reload tabs survive extension reloads).
const KO_VER = '0.8.107';
// How long a lost picture may last before the native player is allowed to
// reclaim the screen (owner 2026-11-11: an ad and the player fighting).
const OWNER_GRACE_MS = 6000;
// A frame report older than this is not evidence about the picture right now.
const STALE_REPORT_MS = 3000;
// ONE canonical yt state object: every reset site (boot, teardown, the
// frame-death watchdog) must agree, or a drained/live flag survives a rebuild.
function freshYtState() {
  return { ready: false, playing: false, muted: true, live: false, ended: false, dur: 0, ct: 0, lat: 0, error: 0 };
}

const KO = {
  playerPreference: 'kick',
  enabled: false,
  adblock: true,  // Twitch SSAI token/playlist adblock (default on)
  player: 'kick', // 'kick' | 'youtube' | 'twitch' — switching never rebuilds players
  mappings: {},   // twitchSlug -> kickSlug (string) | {kick, yt, ytId}
  host: null,     // 'twitch' | 'yt' — set by apply()/probe(); drives rect + anchor paths
  ytPageTarget: null, // resolveYtPageKick() result on YT pages: {slug, m, via}
  ytPageId: null,  // currentSlug() of the YT page whose mapping is bound
  ytBoundMappings: null, // the KO.mappings object identity that produced that binding
  slug: null,
  kickSlug: null,
  ytRaw: '',
  ytId: null,
  activeUrl: null, // kick playback_url currently loaded in the frame
  wrap: null,      // overlay container — persists across switches
  kickFrame: null, // <iframe src=player.html> (IVS engine, same as kick.com)
  kickWin: null,   // kickFrame.contentWindow (set on first ready message)
  kickReady: false,
  kickState: null, // last {state, paused, muted, volume, pos, lat, q, qcount} from the frame
  lastKickSt: 0,   // epoch ms of the last st message (frame-death watchdog)
  lastYtSt: 0,     // epoch ms of the last yt st message (yt frame-death watchdog)
  pendingUrl: null,// playback_url queued until the frame reports ready
  kickVol: 1,
  kickMuted: true, // user's kick mute choice (persisted; hidden-mute is separate); first-run default MUTED
  kickUrlT: 0,      // epoch ms of the current playback_url load (dead-url watchdog)
  kickProbeAt: 0,   // epoch ms the 20s probe loop last CONFIRMED the kick source live
  ytProbeAt: 0,     // epoch ms the probe loop last confirmed the yt source alive/minting
  ytNoEvidence: 0,  // consecutive probe cycles that learned nothing (no live, no failure, no fresh embed)
  kickEverPlayed: false, // current url reached Playing at least once (re-buffers ≠ dead url)
  kickMintSig: '', // last kick probe outcome recorded (the mint is silent otherwise)
  // Per-API memory for the mint probes. One shared slot was defeated by a
  // channel that 404s on both endpoints: v2 and v1 alternate the value, so
  // every poll re-logged both and nothing was ever "unchanged". Measured in
  // the owner's ring 2026-11-16: 20 identical `{api:"v2/…",status:404}` and
  // 20 identical `{api:"v1/…",status:404}` rows for one channel.
  kickApiSig: {},
  // The poll's own outcome. `kick_probe {at:"poll"}` and `kick_offline` were
  // emitted every 20 s whether or not anything moved: 114 identical rows each
  // in that same ring, 228 of 1200 entries, which is what evicted the ad
  // chronology the owner asked the log to answer. Transition only.
  kickPollSig: '',
  kickDvrUrl: null, // replay source (sources.dvr) from the playback bootstrap
  kickOnDvr: false, // frame is playing the DVR url (replay mode)
  // Published replay edge learned from a previous replay: a live VOD grows ~1
  // s/s, so the edge now is `kickDvrDur + elapsed`. The replay publishes
  // ~21.7 s behind the broadcast clock (measured 2026-11-09), and a first load
  // past its edge ends the replay and used to bounce to live.
  kickDvrDur: 0,
  kickDvrDurAt: 0,
  kickDvrLoadedAt: 0, // when a replay load was commanded (Ended-rescue window)
  kickDvrTarget: 0, // the offset that load asked for
  kickDvrClamped: false, // the Ended rescue already re-loaded once for this load
  kickDur: 0,       // broadcast duration (IVS getDuration) — seek-bar range
  // The arrow's LOCAL rewind burst. `st.pos` is up to one report (~1s) stale,
  // so composing a second press on it loses that step; the burst keeps the
  // target and when it was armed, and decays as soon as a report reflects it.
  kickStep: null,   // {base, target, at, onDvr} — see seekOverlayStep
  kickStreamStart: null, // v1/video created_at (ISO-Z, absolute) — bar max base
  kickDvrFetchedAt: 0, // when kickStreamStart was captured (elapsed grows)
  kickStreamId: null, // live stream id (v2 livestream.id) — DVR entry match
  twDeleted: false, // user deleted the Twitch player (popup) — restored on reload
  lastRect: null,   // last Twitch player rect (keeps the overlay pinned when deleted)
  dvrFetchedFor: null, // playback_url the DVR source was fetched for (once per url)
  ytVol: 1,         // user's YouTube volume in the player bridge's 0..1 range
  ytMuted: false,   // user's YouTube mute choice (persisted)
  ytState: freshYtState(),
  ytHlsUrl: null,   // last minted HLS manifest url (refreshed under the background cache TTL)
  ytHlsAt: 0,       // epoch ms of the successful mint
  ytHlsFailed: false, // last mint (or a fatal frame error) failed - fall back to kick
  ytHlsFailedAt: 0,   // epoch ms of the failure (retry backoff)
  ytKickFallbackAt: 0, // epoch ms of the last yt->kick fallback probe (5s throttle)
  ytLoadedUrl: null, // url currently handed to the yt frame (re-load on change)
  ytUnlock: false,
  twLive: false,       // sticky: Twitch channel confirmed live on this page
  twWasPlaying: false, // Twitch was playing when we paused it → resume on switch back
  twPaused: new Set(), // the elements THIS extension paused (resume only these)
  seeking: false,
  reconnectCount: 0,
  stableSince: null, // epoch ms of the current uninterrupted Playing run (budget reset)
  stablePos: null, // the position that run was last seen at (a frozen clock is not progress)
  pollTimer: null,
  rectTimer: null,
  spaTimer: null,
  hideTicks: 0,
  stallTicks: 0,
  ownerPos: 0, // playback position at the last owner publish (regression guard)
  // The baseline of the ONE attribute writer. `undefined` would make the first
  // publish look like a transition (syncOwner compares against this), and the
  // death path now publishes unconditionally: a cold page that tears down
  // before any picture would log `owner {from:null, to:null}`. '' is the truth
  // for a page with no layer on screen.
  ownerAttr: '', // last value published to data-ko-owner
  picLostAt: 0, // epoch ms when the overlay last stopped having a picture
  picSeenAt: 0, // epoch ms of the last picture it DID have (gate for the grace)
  lastTickT: 0,
  frameSeq: 0, // iframe-creation counter — identity proof for the status hook
  lastPath: location.pathname + '@' + location.hostname,
};

// ---- storage ----------------------------------------------------------------

// Storage -> intent. The arbiter is the store; KO.kickMuted/ytMuted are its UI
// ---- storage ----------------------------------------------------------------
// Storage is NOT the audio store. ko-audio.js persists the intent itself, per
// tab (sessionStorage `ko.audio.v2`), because a shared row made one tab's mute
// silence every other tab: `chrome.storage.onChanged` fed `vols` into every
// content script, whose `applyVols()` then called setIntent (owner report
// 2026-11-08: "mutar uma aba e todas mutarem. e vice versa"). The record no
// longer carries `vols` at all; KO.kickMuted/kickVol/ytMuted/ytVol are the UI
// mirror, derived from the arbiter by mirrorAudio().
function mirrorAudio() {
  const audio = window.KOAudio;
  if (!audio) return;
  const k = audio.intent('kick');
  const y = audio.intent('yt');
  if (KO.audioNative === 'page') {
    const p = audio.intent('page');
    KO.pageMuted = p.muted;
    KO.pageVol = p.volume;
  }
  KO.kickMuted = k.muted;
  KO.kickVol = k.volume;
  KO.ytMuted = y.muted;
  KO.ytVol = y.volume;
  updateKickVolUI();
}

function loadState() {
  return new Promise((res) => {
    chrome.storage.local.get(KEY, (o) => {
      void chrome.runtime.lastError;
      const s = (o && o[KEY]) || {};
      KO.enabled = s.enabled === undefined ? true : !!s.enabled;
      KO.adblock = s.adblock === undefined ? true : !!s.adblock;
      KO.player = s.player === 'twitch' ? 'twitch' : s.player === 'youtube' ? 'youtube' : 'kick';
      // Every surface starts audible: a mute nobody chose (the old
      // `kickMuted = true` seed) was inherited by the next player on every
      // swap. "One at a time" is the arbiter's rule, not a default mute.
      if (!o || !o[KEY]) mirrorAudio();
      KO.playerPreference = KO.player;
      KO.mappings = s.mappings && typeof s.mappings === 'object' ? s.mappings : {};
      mirrorAudio();
      res();
    });
  });
}

function saveState(persistPlayer = false) {
  return new Promise((res) => {
    if (persistPlayer) KO.playerPreference = KO.player;
    // playerAt is the popup's retry-intent marker; when the overlay has seen
    // one it must carry it through its own writes unchanged — echoes that
    // erase it would make a later same-value re-pick indistinguishable from a
    // no-op (0.8.6 pain-4). Omit it entirely until the first popup pick.
    const rec = {
      enabled: KO.enabled,
      adblock: KO.adblock !== false,
      mappings: KO.mappings,
      // The YouTube fallback changes KO.player for this session only.
      // NO audio here: ko-audio.js persists the intent per tab (sessionStorage
      // `ko.audio.v2`). A `vols` row in this shared record is exactly what made
      // one tab's mute reach every other tab through storage.onChanged.
      player: KO.playerPreference,
    };
    if (typeof KO.playerAt === 'number') rec.playerAt = KO.playerAt;
    chrome.storage.local.set({ [KEY]: rec }, () => {
      void chrome.runtime.lastError;
      res();
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  const s = changes[KEY].newValue || {};
  const prev = changes[KEY].oldValue || {};
  const pChanged =
    !!s.enabled !== !!prev.enabled ||
    (s.player || 'kick') !== (prev.player || 'kick') ||
    JSON.stringify(s.mappings || {}) !== JSON.stringify(prev.mappings || {});
  KO.enabled = !!s.enabled;
  KO.adblock = s.adblock === undefined ? true : !!s.adblock;
  if (typeof s.playerAt === 'number') KO.playerAt = s.playerAt; // popup intent marker (echoes preserve it)
  const nextPlayer = s.player === 'twitch' ? 'twitch' : s.player === 'youtube' ? 'youtube' : 'kick';
  // A volume/mapping write during the session-only fallback carries the
  // preferred player back to storage; do not let that self-write undo the
  // active fallback. A different incoming player is a real popup switch.
  // A manual youtube switch is an explicit retry request: clear stale mint
  // evidence so the next probe re-mints instead of honouring the 30s backoff
  // with a dead flag (0.8.3 symptom 2 — a flip back to youtube silently
  // handed back to kick while ytHlsFailed stayed true from an old failure).
  // Gated on a GENUINE switch (the stored player actually changing): the
  // persisted field is the preference, and the yt->kick fallback is in-memory
  // only, so a volume/mute/mapping echo from a popup or second tab also
  // arrives with player === 'youtube' — wiping the evidence on every such
  // write, defeating the backoff once per write and re-paying a mint on a
  // dead url.
  if (nextPlayer === 'youtube' && (prev.player || 'kick') !== 'youtube') {
    KO.ytHlsFailed = false;
    KO.ytHlsFailedAt = 0;
  }
  // Re-picking youtube (same stored value) while a session-only yt->kick
  // fallback is live is ALSO a retry request — the pain-4 hole: storage
  // keeps player:'youtube' (the fallback never persists), so a popup re-pick
  // arrives as a same-value write that neither the gate above (player
  // unchanged) nor `:366` (preference unchanged) acts on, and KO.player sits
  // on 'kick'. The retry is separated from a volume/mute/mapping/saveState
  // echo by the popup's explicit intent marker: popup.js stamps `playerAt =
  // Date.now()` on EVERY player change, and nothing else (the overlay's own
  // saveState, a second tab's volume/mapping write) ever stamps it. So
  // `s.playerAt !== prev.playerAt` means the user actually re-picked the
  // player — fire immediately, no 30s backoff wait, and it covers BOTH
  // fallback triggers (ytHlsFailed OR an embed-stall that handed KO.player
  // to kick with ytHlsFailed still false). Firing apply() re-probes this
  // active layer, so KO.player must be pushed back to 'youtube' or probe()
  // keeps dispatching to probeKickLayer.
  else if (
    nextPlayer === 'youtube' && KO.player === 'kick' &&
    typeof s.playerAt === 'number' && s.playerAt !== prev.playerAt
  ) {
    KO.ytHlsFailed = false;
    KO.ytHlsFailedAt = 0;
    KO.player = 'youtube';
    fire(apply);
  }
  if (KO.player === KO.playerPreference || nextPlayer !== KO.playerPreference) KO.player = nextPlayer;
  KO.playerPreference = nextPlayer;
  KO.mappings = s.mappings && typeof s.mappings === 'object' ? s.mappings : {};
  // probe() only re-reads the mapping when the channel identity changes, so a
  // popup edit for the CURRENT Twitch channel used to be ignored until reload
  // (the pChanged apply() re-probed with the old KO.ytRaw). Mirror the row
  // into the live state now; probe() then sees the new value immediately.
  if (!onYtHost() && KO.slug) {
    const m = KO.mappings[KO.slug];
    if (m && typeof m === 'object') {
      KO.kickSlug = m.kick || KO.slug;
      KO.ytRaw = m.yt || '';
      KO.ytId = m.ytId || null;
    } else if (typeof m === 'string') {
      KO.kickSlug = m;
      KO.ytRaw = '';
      KO.ytId = null;
    } else {
      KO.kickSlug = KO.slug; // same-handle fallback
      KO.ytRaw = '';
      KO.ytId = null;
    }
  }
  mirrorAudio();
  if (pChanged) fire(apply); // hot toggle / remap / player switch — no page reload
});

// ---- helpers ----------------------------------------------------------------

function currentSlug() {
  if (onYtHost()) return ytPageIdentity();
  const seg = location.pathname.split('/').filter(Boolean);
  if (!seg.length) return null;
  const s = decodeURIComponent(seg[0]).toLowerCase();
  if (!/^[a-z0-9_]{2,25}$/.test(s) || NOT_CHANNEL.has(s)) return null;
  return s;
}

// Is this route one whose PLAYER the overlay is allowed to mirror?
// The overlay is a position:fixed layer that copies a player's viewport rect,
// so it only makes sense where the page actually shows that player:
//   Twitch  -> the channel root only (/<slug>). /<slug>/clips, /<slug>/videos,
//              /<slug>/about, /clip/<id>, /directory/... are different layouts.
//   YouTube -> the watch/live pages (and youtu.be). /@handle, /channel/...,
//              /feed, /results, /shorts have no player slot to mirror.
// Both hosts KEEP a stale player element in the DOM when you SPA away from a
// player route (Twitch's .persistent-player keeps its old rect), so without
// this gate the overlay followed that ghost and stayed pinned over the new
// layout — the "/<channel>/clips breaks the page" bug (owner report
// 2026-10-26). The route is the only reliable signal: the ghost element
// still reports width/height and a plausible card ancestor.
function overlayTargetRoute() {
  if (onYtHost()) {
    const p = location.pathname;
    if (location.hostname === 'youtu.be') return /^\/[A-Za-z0-9_-]{6,20}(?:\/|$)/.test(p);
    if (p === '/watch') {
      try {
        return !!new URLSearchParams(location.search).get('v');
      } catch {
        return false;
      }
    }
    return /^\/live\/[A-Za-z0-9_-]{6,20}(?:\/|$)/.test(p);
  }
  // Twitch: exactly one path segment, and it must be a channel slug.
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length !== 1) return false;
  const s = decodeURIComponent(segs[0]).toLowerCase();
  return /^[a-z0-9_]{2,25}$/.test(s) && !NOT_CHANNEL.has(s);
}

// Largest visible page <video> that is not ours — the active Twitch player.
// Ranking (0.8.39): the channel player is a <video> inside a player CARD
// (.video-ref / .video-player / .persistent-player) inside the page's MAIN
// layout; Twitch portals the clip viewer modal and the sidebar hover preview
// into a body-level root. Without the ranking the rect loop jumped the overlay
// onto a clip modal opened from the channel page, and onto hover previews.
// Every tier falls back to the next so an unexpected layout still resolves.
function twitchVideo() {
  const visible = [...document.querySelectorAll('video')].filter((v) => v.getClientRects().length);
  const largest = (list) => {
    let best = null;
    let bestArea = 0;
    for (const v of list) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) {
        bestArea = a;
        best = v;
      }
    }
    return best;
  };
  const inCard = (v) => {
    for (let e = v, i = 0; e && i < 6; e = e.parentElement, i++) {
      const cls = (e.className || '').toString();
      if (cls.includes('video-ref') || cls.includes('video-player') || cls.includes('persistent-player')) return true;
    }
    return false;
  };
  const main = document.querySelector('main.twilight-main, main');
  const canTestMain = !!(main && typeof main.contains === 'function');
  const cards = visible.filter(inCard);
  const cardsInMain = canTestMain ? cards.filter((v) => main.contains(v)) : [];
  return largest(cardsInMain) || largest(cards) || largest(visible);
}

function twitchIsLive(v) {
  return !!(v && !v.paused && v.readyState >= 2 && v.currentTime > 0);
}

// Sticky "Twitch is live" — survives OUR pause (overlay shown pauses the
// native player; a paused live must not be treated as offline). Used for
// badges/status only — it no longer gates any player switch.
function updateTwLiveSticky(v) {
  if (twitchIsLive(v)) {
    KO.twLive = true;
  } else if (!v || v.readyState < 1) {
    if (!v) KO.twLive = false;
  }
  // else: video exists but paused by us → keep sticky value
}

// Kick stream source — THE full-HD playback_url (same endpoint the VOD.RIP
// downloader uses; all IVS renditions incl. 1080p+; v2 exposes it TOP-LEVEL).
// Live iff the `livestream` object exists: kick's v2 channel endpoint ALSO
// returns a stale top-level playback_url for OFFLINE channels (proven with
// nyro — livestream:null + playback_url present → the url does not stream),
// which used to put a dead black player over Twitch.
// A kick channel handle: 3-25 chars, letters/digits/underscore/hyphen. Anything
// else is not a channel, so probing kick.com for it only burns a blocked
// cross-origin request.
const KICK_SLUG_RE = /^[a-z0-9][a-z0-9_-]{2,24}$/i;
// How long a freshly loaded playback_url is treated as LOADING rather than
// broken. Measured: a DVR->live switch needs ~10 s to first frames, and the
// stall watchdog firing on the OLD state mid-switch cost three reconnects and a
// teardown for a load that was working (2026-11-13). Every "is it dead yet"
// question reads this one number.
const KICK_GRACE_MS = 25000;
function plausibleKickSlug(slug) {
  const s = String(slug || '').trim();
  return KICK_SLUG_RE.test(s) && !/^uc[0-9a-z_-]{22}$/i.test(s);
}

// The mint is the one place the kick layer can die silently, and it did
// (2026-11-11: the frame sat at state Ready with a media element of
// readyState 0). Record what the API actually answered, once per outcome.
// `diag()` is a service-worker console.debug only, and the owner's log is
// `chrome.storage.local['ko.adlog']`, so the same line also rides the
// `ko-adlog` CustomEvent the bridge persists (that is how `vis-audio` lands).
// Without this the next pod has to re-derive the mint by hand.
function kickLog(ev, d) {
  diag(ev, d); // diag() persists to ko.adlog too - one sink, no double line
}

// Records one mint-probe outcome per api, and only when THAT api's outcome
// changed. Returns true when the row was written, so a caller can act on it.
function kickProbeOnce(api, sig, payload) {
  if (!KO.kickApiSig || typeof KO.kickApiSig !== 'object') KO.kickApiSig = {};
  if (KO.kickApiSig[api] === sig) return false;
  KO.kickApiSig[api] = sig;
  KO.kickMintSig = sig; // `why` on the offline row still names the last outcome
  kickLog('kick_probe', payload);
  return true;
}

async function kickPlaybackUrl(slug) {
  if (!plausibleKickSlug(slug)) return { live: false };
  // A mint started at document_start (init) is CONSUMED here, not repeated: the
  // cold-open swap pays one API round trip in parallel with the page parse
  // instead of one after the frame is created.
  if (KO.kickPrewarm && KO.kickPrewarmSlug === slug) {
    const p = KO.kickPrewarm;
    KO.kickPrewarm = null;
    KO.kickPrewarmSlug = null;
    try {
      const pre = await p;
      if (pre && pre.live && pre.url) return pre;
    } catch {
      /* a failed prewarm falls through to a fresh mint */
    }
  }
  const enc = encodeURIComponent(slug);
  const probes = [
    `https://kick.com/api/v2/channels/${enc}`,
    `https://kick.com/api/v1/channels/${enc}`,
  ];
  for (const url of probes) {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      const api = url.replace('https://kick.com/api/', '');
      if (!r.ok) {
        kickProbeOnce(api, `${api}|${r.status}`, { api, status: r.status });
        continue;
      }
      const d = await r.json();
      const ls = d && d.livestream;
      const shape = ls ? (ls.playback_url ? 'ls.url' : (d.playback_url ? 'top.url' : 'no.url')) : 'no.ls';
      kickProbeOnce(api, `${api}|${shape}`, { api, status: r.status, shape, live: !!ls });
      if (ls) {
        if (ls.playback_url) return { live: true, url: ls.playback_url, streamId: ls.id || null };
        if (d && d.playback_url) return { live: true, url: d.playback_url, streamId: ls.id || null };
      }
      return { live: false }; // livestream null (or url-less) → channel offline
    } catch {
      // transient — try next endpoint / next poll tick
    }
  }
  return { live: false };
}

// Badge texts are clipped by Chrome at 4 chars — every badge is one of the
// normalized <=4-char tokens below, with the PHASE carried by the color:
//   KICK green = Playing | KICK amber = connecting (url/ready pending)
//   KICK gray  = failed/offline | YT red = live | YT amber = minting/loading
//   YT gray    = failed | TW/OFF gray | '' clear.
function setBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || [0, 0, 0, 0] });
    chrome.action.setBadgeText({ text: text || '' });
  } catch {
    /* badge is cosmetic */
  }
}

// ---- YouTube bridge ---------------------------------------------------------

// YouTube layer — the extension's OWN HLS player (player.html?m=hls). The
// live_stream embed cannot initialize on bot-gated/cookieless sessions: the
// server bakes an error config ("Erro 153") into the page and the player
// never issues an innertube request, so no pot in the URL can fix it. The
// background mints the stream via an anonymous MWEB player API call (the
// yt-dlp recipe) and the HLS frame speaks the same __koKick protocol as IVS.
const PLAYER_ORIGIN = new URL(chrome.runtime.getURL('player.html')).origin;

function ytSend(o) {
  const f = document.getElementById('ko-yt');
  const token = f && f.dataset.koToken;
  if (!f || !f.contentWindow || !token) return;
  // Before the frame's navigation commits its contentWindow still belongs to
  // the youtube.com origin, so a post with the extension as targetOrigin is
  // rejected and the command is dropped (owner console 2026-11-07). Queue
  // until the frame reports in.
  if (f.dataset.koReady !== '1') {
    if (!KO.ytQueue) KO.ytQueue = [];
    if (KO.ytQueue.length < 32) KO.ytQueue.push(o);
    return;
  }
  try {
    f.contentWindow.postMessage({ __koKick: { ...o, _koToken: token } }, PLAYER_ORIGIN);
  } catch {
    /* frame gone */
  }
}

function ytReady() {
  const f = document.getElementById('ko-yt');
  if (f) f.dataset.koReady = '1';
  const q = KO.ytQueue || [];
  KO.ytQueue = [];
  for (const msg of q) ytSend(msg);
}

function ytCmd(cmd, arg) {
  switch (cmd) {
    case 'play': return ytSend({ t: 'play' });
    case 'pause': return ytSend({ t: 'pause' });
    case 'mute': return ytSend({ t: 'mute', m: arg === undefined ? true : !!arg });
    case 'unmute': return ytSend({ t: 'mute', m: false });
    case 'setVolume': return ytSend({ t: 'volume', v: arg });
    case 'seekToLive': return ytSend({ t: 'seekToLive' });
    case 'seek': return ytSend({ t: 'seek', s: arg });
  }
}

function resolveYtChannel(raw) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'ko-resolve-yt', value: raw }, (r) => {
        diag('yt_resolve', { raw, id: (r && r.id) ? r.id.slice(0, 10) : null, err: (r && r.error) || null });
        res((r && r.id) || null);
      });
    } catch {
      res(null);
    }
  });
}

async function ensureYtId() {
  if (KO.ytId) return true;
  if (!KO.ytRaw) return false;
  KO.ytId = await resolveYtChannel(KO.ytRaw);
  // Persist only onto a REAL table row. On a YT page with no stored mapping
  // KO.slug is a synthetic 'host:yt:…' key — writing it would poison the
  // owner's table (and the popup would show a ghost channel).
  if (KO.ytId) {
    const m = KO.mappings[KO.slug];
    if (m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(KO.mappings, KO.slug)) {
      m.ytId = KO.ytId;
      saveState();
    }
  }
  return !!KO.ytId;
}

// Mint the live HLS manifest through the background (MWEB player API call —
// Chrome transport, anonymous). The background caches the URL per video id
// for 5 min; content refreshes under that TTL so a re-mint re-resolves the
// live video id (stream restarts) without hammering innertube, and failures
// retry after a short backoff. The old one-shot flags stuck forever — a
// single failed mint ("sts not found", SW cold start, transient network)
// killed the yt layer for the whole page session (observed in the diag log:
// yt_hls err -> yt_fallback, then never retried).
const YT_HLS_TTL_MS = 4 * 60 * 1000; // refresh before the background's 5-min cache expires
const YT_HLS_RETRY_MS = 30 * 1000;   // hard-fail backoff (transient bot-gate/network)
async function ensureYtHls() {
  const now = Date.now();
  if (KO.ytHlsUrl && now - (KO.ytHlsAt || 0) < YT_HLS_TTL_MS) return; // fresh mint
  if (KO.ytHlsFailed && now - (KO.ytHlsFailedAt || 0) < YT_HLS_RETRY_MS) return; // backoff
  const direct = ytDirectVideoId(KO.ytRaw);
  // A video-specific mapping must win over the resolved channel: the user
  // pointed at a live and the channel may have another one running. If that
  // video is over/restarted, fall back to the channel's current live.
  const refs = [];
  // The background accepts the \"video:<id>\" escape hatch for a bare id; a raw
  // 11-char string would otherwise be normalized as a channel handle.
  if (direct) refs.push('video:' + direct);
  if (KO.ytId && KO.ytId !== direct) refs.push(KO.ytId);
  if (!direct && KO.ytRaw && KO.ytRaw !== KO.ytId) refs.push(KO.ytRaw);
  const mint = (channelRef) =>
    new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: 'ko-yt-play', channelRef }, (rr) => res(rr || {}));
      } catch {
        res({});
      }
    });
  try {
    let r = {};
    for (const ref of refs) {
      r = await mint(ref);
      if (r && r.url) break;
    }
    if (r && r.url) {
      KO.ytHlsUrl = r.url;
      KO.ytHlsAt = now;
      KO.ytHlsFailed = false;
      diag('yt_hls', { url: r.url.slice(0, 60), direct: !!direct });
    } else {
      KO.ytHlsFailed = true;
      KO.ytHlsFailedAt = now;
      diag('yt_hls', { err: (r && r.error) || 'no-url' });
    }
  } catch (e) {
    KO.ytHlsFailed = true;
    KO.ytHlsFailedAt = now;
    diag('yt_hls', { err: String(e).slice(0, 120) });
  }
}

function ensureYtIframe() {
  if (document.getElementById('ko-yt')) return;
  if (!KO.wrap) mount();
  if (!KO.ytHlsUrl) return;
  const iframe = document.createElement('iframe');
  iframe.id = 'ko-yt';
  const token = crypto.randomUUID();
  iframe.dataset.koToken = token;
  iframe.src = chrome.runtime.getURL(`player.html?m=hls&token=${encodeURIComponent(token)}`);
  iframe.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
  // No `allowFullscreen`: with `allow` present the property is redundant and
  // Chrome logs "Allow attribute will take precedence over 'allowfullscreen'"
  // on every frame (owner console 2026-11-07).
  KO.ytQueue = [];
  iframe.addEventListener('load', () => { ytReady(); });
  KO.wrap.appendChild(iframe);
  // Pain 2 (0.8.6): focus is deferred to the frame's 'load' — immediately
  // after appendChild the contentWindow is still the pre-navigation context,
  // so an eager focus() is inert AND on the frame-death rebuild path it would
  // steal window focus to the extension frame mid-sentence. Focus only when
  // the yt layer is actually shown (visible + selected).
  iframe.addEventListener('load', () => {
    // Pain 2 (0.8.6): focus deferred past 'load' and layer-gated — an
    // immediate focus() is inert (pre-navigation window) and a rebuild
    // stealing keystrokes mid-edit is worse than no focus. Only focus a
    // freshly-built frame when the yt layer is shown and the user is not
    // editing (mirror of the kick leg).
    if (typeof KO.frameSeq === 'number' && KO.ytFocusSeq === KO.frameSeq) return;
    KO.ytFocusSeq = KO.frameSeq;
    try {
      const ae = document.activeElement;
      const editing = ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
      if (KO.wrap && KO.wrap.style.display !== 'none' && KO.player === 'youtube' && !editing) {
        iframe.contentWindow && iframe.contentWindow.focus();
      }
    } catch { /* not ready */ }
  });
  KO.frameSeq++;
  KO.pendingYtUrl = KO.ytHlsUrl;
  KO.ytEmbedAt = Date.now();
  // ytId is only known once the handle resolved — never assume it.
  diag('yt_embed', { id: (KO.ytId || '').slice(0, 8), hls: !!KO.ytHlsUrl });
}

function enableYtUnlock() {
  if (KO.ytUnlock) return;
  KO.ytUnlock = true;
  const unlock = () => {
    KO.ytUnlock = false;
    KO._ytUnlockDoc = null;
    document.removeEventListener('pointerdown', unlock, true);
    if (KO.player !== 'youtube' || !KO.wrap || KO.wrap.style.display === 'none') return;
    if (window.KOAudio) window.KOAudio.setPolicy('yt', false); // gesture: retry audible
    ytCmd('play');
  };
  // teardown() unbinds a never-fired arm (same contract as teardownHotBar).
  KO._ytUnlockDoc = unlock;
  document.addEventListener('pointerdown', unlock, true);
}

let lastYtProbe = 0;
let ytFirstInfo = false;
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__koKick || ev.origin !== PLAYER_ORIGIN) return;
  const f = document.getElementById('ko-yt');
  if (!f || ev.source !== f.contentWindow || d.__koKick._koToken !== f.dataset.koToken) return; // the yt (hls) frame only
  const m = d.__koKick;
  // A token-valid message proves the frame has navigated; flush what was held.
  if (f.dataset.koReady !== '1') ytReady();
  if (m.t === 'levels') {
    KO.ytState.qualities = Array.isArray(m.levels) ? m.levels : [];
    renderQualityMenu();
    return;
  }
  if (m.t === 'ready') {
    KO.ytWin = ev.source;
    KO.ytState.ready = true;
    if (!ytFirstInfo) {
      ytFirstInfo = true;
      diag('yt_ready', {});
    }
    // A fresh frame knows nothing: drop the command cache so the arbiter
    // re-asserts the user's state instead of trusting the frame that died.
    if (window.KOAudio) {
      window.KOAudio.forget('yt');
      window.KOAudio.apply();
    }
    ytSend({ t: 'getLevels' }); // vertical menu = the frame's REAL levels
    if (KO.pendingYtUrl) {
      ytSend({ t: 'load', url: KO.pendingYtUrl });
      KO.ytLoadedUrl = KO.pendingYtUrl;
      KO.pendingYtUrl = null;
      if (KO.player !== 'youtube') {
        ytSend({ t: 'mute', m: true });
        ytSend({ t: 'pause' });
      }
    }
    return;
  }
  if (m.t === 'st' && m.st) {
    KO.lastYtSt = Date.now(); // yt frame-death watchdog clock
    const st = m.st;
    const prevLive = KO.ytState.live;
    // hls.js state mapping — a paused-but-loaded video is still live. An
    // ENDED element is not: it drains and then reports 'Paused' forever from
    // the bridge's 1s timer, which is exactly how a dead youtube layer kept
    // pinning a black wrap (owner symptom 1). The bridge names that state
    // 'Ended' (0.8.5); it must answer "not live" here and at the keep-up gate.
    KO.ytState.playing = st.state === 'Playing';
    KO.ytState.ended = st.state === 'Ended';
    KO.ytState.muted = !!st.muted;
    KO.ytState.live = st.state === 'Playing' || st.state === 'Buffering' || st.state === 'Paused';
    KO.ytState.dur = st.dur || 0;
    KO.ytState.ct = st.pos || 0;
    KO.ytState.lat = st.lat || 0; // gap to the live edge (absolute seconds)
    KO.ytState.vq = (st.q && st.q.name) || '';
    KO.ytState.qualities = Array.isArray(st.qualities) ? st.qualities : [];
    // A fatal hls error is followed by the bridge's one automatic reload.
    // If the layer is demonstrably playing again, that error is stale — do
    // not let it trigger a kick fallback / gray badge for the rest of the
    // stream (observed on a transient live manifest reload).
    if (KO.ytHlsFailed && KO.ytState.live && KO.ytState.playing) {
      KO.ytHlsFailed = false;
      KO.ytHlsFailedAt = 0;
    }
    updatePlayUI();
    updateKickVolUI();
    renderQualityMenu();
    updateKickBar();
    // The frame's own slider is a user gesture; a value it reports that we did
    // not command becomes the user's intent. Never the reverse: what we sent is
    // already in the arbiter and comes back as an echo.
    if (typeof st.volume === 'number' && st.volume >= 0 && !st.muted) {
      const audio = window.KOAudio;
      const want = audio ? audio.wanted('yt') : null;
      if (audio && want && Math.abs(want.volume - st.volume) > 0.02) {
        audio.setIntent('yt', { volume: st.volume }, { persist: true, origin: 'user:frame-slider', ev: { ownWrite: false, input: 'in-frame', inputAgeMs: null, userActive: true } });
      }
    }
    if (KO.player === 'youtube') throttledYtProbe();
    if (prevLive && !KO.ytState.live && KO.player === 'youtube') throttledYtProbe();
    if (KO.player === 'youtube' && KO.ytState.live && KO.ytState.muted) {
      // The frame is muted although the user wants sound: the browser refused
      // audible autoplay. That is POLICY (never read back as intent) and the
      // first gesture clears it.
      if (window.KOAudio && !window.KOAudio.wanted('yt').muted) window.KOAudio.setPolicy('yt', true);
      enableYtUnlock();
    }
    return;
  }
  // 0.8.6 pain 2: the yt frame relays overlay keys (f / arrows) when focus
  // sits inside it — route to the same seek/fullscreen dispatch as a page
  // keypress (the host's document capture never sees iframe-focused keys).
  if (m.t === 'key') {
    if (KO.player === 'youtube') dispatchOverlayKey(m.k);
    return;
  }
  if (m.t === 'ev' && m.e === 'error') {
    console.log('[ko] yt (hls) error', m.d || '');
    diag('yt_hls_err', { msg: String(m.d || '').slice(0, 140) });
    // The frame already did its one reload per url (player-bridge) — a
    // second fatal error means the URL is dead. Mark the layer failed so
    // the next probe falls back to kick (never leave the native Twitch
    // player with ads visible) and re-mints after the backoff.
    // A proven-dead url must not ANSWER the liveness question either: the
    // frame keeps posting 'st' after the error, so without this the sticky
    // flag re-anchored ytProbeAt on every message and the keep-up gate could
    // never fall through to the failure clock-zero below.
    KO.ytHlsFailed = true;
    KO.ytHlsFailedAt = Date.now();
    KO.ytState.live = false;
    throttledYtProbe();
  }
});

function throttledYtProbe() {
  const now = Date.now();
  if (now - lastYtProbe < 1000) return;
  lastYtProbe = now;
  fire(probe);
}

// ---- Kick frame bridge (IVS — the engine kick.com uses) ---------------------

function kickSend(o) {
  const f = KO.kickFrame;
  const token = f && f.dataset.koToken;
  if (!KO.kickWin || !token) {
    // 0.8.41 diag: a command that never leaves the page cannot teach the frame
    // its parent origin. Recorded, not changed.
    const dd = KO.kickDiag || (KO.kickDiag = newKickDiag());
    dd.blockedSend = (dd.blockedSend || 0) + 1;
    return;
  }
  try {
    KO.kickWin.postMessage({ __koKick: { ...o, _koToken: token } }, PLAYER_ORIGIN);
    const ds = KO.kickDiag || (KO.kickDiag = newKickDiag());
    ds.sent++;
    ds.sentByType[o.t] = (ds.sentByType[o.t] || 0) + 1;
    if (!ds.firstSentAt) ds.firstSentAt = { ms: Math.round(performance.now()), t: o.t, kind: o.e || null };
  } catch {
    /* frame gone */
  }
}

function kickFrame() {
  if (KO.kickFrame && KO.kickFrame.isConnected) return KO.kickFrame;
  if (!KO.wrap) mount();
  const fr = document.createElement('iframe');
  const token = crypto.randomUUID();
  fr.id = 'ko-ivs';
  fr.dataset.koToken = token;
  fr.src = chrome.runtime.getURL(`player.html?token=${encodeURIComponent(token)}`);
  fr.setAttribute('allow', 'autoplay; fullscreen');
  KO.kickFrame = fr;
  KO.kickWin = null;
  KO.kickReady = false;
  KO.kickState = null;
  fr.addEventListener('load', () => {
    KO.kickWin = fr.contentWindow;
    // Pain 2 (0.8.6): focus deferred past 'load' and layer-gated — an eager
    // focus right after appendChild is inert (pre-navigation window) and on
    // the frame-death rebuild path would steal keystrokes from the user
    // typing in Twitch chat or a page input. Focus only when the kick layer
    // is shown, the user is not mid-edit, and only for a freshly-build frame.
    if (typeof KO.frameSeq === 'number' && KO.kickFocusSeq === KO.frameSeq) return;
    KO.kickFocusSeq = KO.frameSeq;
    try {
      const ae = document.activeElement;
      const editing = ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
      if (KO.wrap && KO.wrap.style.display !== 'none' && KO.player === 'kick' && !editing) {
        fr.contentWindow && fr.contentWindow.focus();
      }
    } catch { /* not ready */ }
  });
  KO.wrap.appendChild(fr); // same parent as #ko-yt — detached frame never renders
  KO.frameSeq++;
  return fr;
}

// 0.8.41 diag (KO-20261026-02). The black box on a YouTube watch page with
// player=kick was measured as "no ready reached the content script, st did".
// Nothing said WHERE a message was lost, so these counters record every
// __koKick message that reaches the page, every guard that drops it, and every
// command the page sends into the frame (the frame learns the parent origin
// from the first valid command). Counters only; no behaviour change. Read with
// `eval "KO.kickDiag"` in the content-script world.
function newKickDiag() {
  return {
    startedAt: Date.now(),
    accepted: 0,
    byType: {},
    firstAt: {},
    drops: {},
    firstDrop: null,
    sent: 0,
    sentByType: {},
    firstSentAt: null,
    readyFrame: null,
  };
}
function kickDiagSeen(m) {
  const d = KO.kickDiag || (KO.kickDiag = newKickDiag());
  d.accepted++;
  const t = String(m.t || '(none)') + (m.e ? ':' + m.e : '');
  d.byType[t] = (d.byType[t] || 0) + 1;
  if (d.firstAt[t] === undefined) d.firstAt[t] = Math.round(performance.now());
  if (t === 'ready') {
    d.readyFrame = {
      ms: Math.round(performance.now()),
      token: String(m._koToken || '').slice(0, 8),
      frameToken: String((KO.kickFrame && KO.kickFrame.dataset && KO.kickFrame.dataset.koToken) || '').slice(0, 8),
      frameSeq: KO.frameSeq,
      hadPendingUrl: !!KO.pendingUrl,
      kickReadyBefore: !!KO.kickReady,
    };
  }
}
function kickDiagDrop(reason, m) {
  const d = KO.kickDiag || (KO.kickDiag = newKickDiag());
  d.drops[reason] = (d.drops[reason] || 0) + 1;
  if (!d.firstDrop) {
    d.firstDrop = {
      reason,
      type: String((m && m.t) || '(none)'),
      ms: Math.round(performance.now()),
      hasFrame: !!KO.kickFrame,
      frameSeq: KO.frameSeq,
    };
  }
}

window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__koKick || ev.origin !== PLAYER_ORIGIN) {
    if (d && d.__koKick) kickDiagDrop('origin', d.__koKick);
    return;
  }
  const ytf = document.getElementById('ko-yt');
  if (ytf && ev.source === ytf.contentWindow) {
    kickDiagDrop('yt-frame', d.__koKick);
    return; // the yt (hls) frame — handled by the yt listener
  }
  if (!KO.kickFrame || ev.source !== KO.kickFrame.contentWindow) {
    kickDiagDrop('source', d.__koKick);
    return;
  }
  const m = d.__koKick;
  kickDiagSeen(m);
  if (m.t === 'levels') {
    KO.kickState = KO.kickState || {};
    KO.kickState.qualities = Array.isArray(m.levels) ? m.levels : [];
    renderQualityMenu();
    return;
  }
  // 0.8.6 pain 2: IVS frame relays overlay keys (f / arrows) when focus sits
  // inside it (only when KO.player is kick — the kick layer owns the arrows).
  if (m.t === 'key') {
    if (KO.player === 'kick') dispatchOverlayKey(m.k);
    return;
  }
  if (m.t === 'ready') {
    // Only the actual player frame may declare ready — before the first
    // ready message KO.kickWin is null and the source guard below would
    // accept ANY window (page-world spoof would hijack kickSend).
    if (!KO.kickFrame || ev.source !== KO.kickFrame.contentWindow) return;
    KO.kickWin = ev.source;
    KO.kickReady = true;
    KO.lastKickSt = Date.now();
    // A fresh frame knows nothing: drop the command cache so the arbiter
    // re-asserts the user's state on the new one.
    if (window.KOAudio) {
      window.KOAudio.forget('kick');
      window.KOAudio.apply();
    }
    kickSend({ t: 'getLevels' }); // vertical menu = the frame's REAL levels
    if (KO.pendingUrl) {
      kickSend({ t: 'load', url: KO.pendingUrl });
      KO.pendingUrl = null;
      if (KO.player !== 'kick') {
        // Eager mount while youtube shows: the frame autoplays on load, so
        // park it at once (the rect loop re-asserts this if IVS wins the race).
        // The hidden layer is muted by the arbiter, not by a command here.
        kickSend({ t: 'pause' });
        if (window.KOAudio) window.KOAudio.apply();
      }
    }
  } else if (m.t === 'ptr') {
    // Pointer activity INSIDE the overlay player (the frame swallows the page's
    // own pointer events). Arming here is what makes the bar appear when the
    // mouse moves over the picture, every time, not just before the first hide.
    if (KO._hotArm) KO._hotArm('frame');
  } else if (m.t === 'st') {
    // Carry a wall-clock freshness stamp ON the state object so the kick
    // LIVE pill (P3b) has a production-honest clock — 0.8.5 kept a stale
    // 'LIVE −Ns' aflame through a probe white-out / hidden-state reset.
    // Any freshly-assigned kickState (real st message OR a test fixture that
    // assigns a fresh object) is inherently fresh.
    if (m.st && typeof m.st === 'object') m.st.ts = Date.now();
    const prevKickSig = KO.kickState ? KO.kickState.state + '|' + (KO.kickState.muted ? '1' : '0') : '';
    KO.kickState = m.st;
    // The local arrow burst (seekOverlayStep) is spent once a report reflects
    // it, or once the source changed under it: a stale burst must never drag
    // the next press back to a target the player already answered.
    if (KO.kickStep) {
      const bt = KO.kickStep;
      const landed = Math.abs((Number(m.st && m.st.pos) || 0) - bt.target) <= KICK_STEP_ABSORB_SEC;
      if (landed || bt.onDvr !== !!KO.kickOnDvr) KO.kickStep = null;
    }
    KO.lastKickSt = Date.now();
    if (prevKickSig !== String(m.st && m.st.state) + '|' + (m.st && m.st.muted ? '1' : '0')) visAudio('kick-st');
    if (m.st && m.st.state === 'Playing') {
      KO.kickEverPlayed = true;
      // Time from navigation to the layer's FIRST picture. The cold-open
      // swap can only be as fast as this number (owner 2026-11-11: the ad
      // stayed 3-4 s before the player switched, 'e pra ser instantaneo'),
      // so it is measured, not estimated.
      if (!KO.kickFirstPlayAt && typeof performance !== 'undefined') {
        KO.kickFirstPlayAt = Math.round(performance.now());
        // Persisted (ko.adlog) so the OWNER's own machine answers "how long did
        // the layer take" instead of a guest estimate.
        kickLog('kick-first-play', { at: KO.kickFirstPlayAt, bootAt: KO.bootAt || null, pid: KO.player });
      }
    }
    // Reconnect budget replenishes only after a stable Playing stretch —
    // a fresh url that plays 2s then errors must NOT reset the budget
    // (that was the endless reconnect loop: ensureKick reset it per try).
    // AND "Playing" is not progress: a frozen element reports Playing forever
    // (measured 2026-11-13, `stall {ct:10262}` five times over 80 s while the
    // state never left Playing), so the stretch only counts while the clock
    // actually advances.
    if (m.st && m.st.state === 'Playing') {
      const nowPos = Number(m.st.pos) || 0;
      if (!KO.stableSince || !(nowPos > (KO.stablePos || 0) + 0.1)) {
        KO.stableSince = Date.now();
        KO.stablePos = nowPos;
      } else {
        KO.stablePos = nowPos;
        if (Date.now() - KO.stableSince > 15000) KO.reconnectCount = 0;
      }
    } else {
      KO.stableSince = null;
      KO.stablePos = null;
    }
    if (KO.kickOnDvr && m.st && typeof m.st.dur === 'number' && m.st.dur > 12) {
      KO.kickDvrDur = m.st.dur;
      KO.kickDvrDurAt = Date.now();
    }
    if (KO.kickOnDvr && m.st && m.st.state === 'Ended') {
      // A replay that ends right at its published edge is not "the replay is
      // over, go live": the broadcast is still running and the user asked for
      // an offset inside it. Re-load the replay once at dur-6 (the playlist
      // needs a segment ahead of the playhead), then give up honestly.
      const dur = Number(m.st.dur) || 0;
      const young = Date.now() - (KO.kickDvrLoadedAt || 0) < 15000;
      const atEdge = dur > 12 && (KO.kickDvrTarget || 0) >= dur - 2;
      if (young && atEdge && !KO.kickDvrClamped && KO.kickDvrUrl) {
        KO.kickDvrClamped = true;
        const at = Math.max(0, dur - 6);
        KO.kickDvrTarget = at;
        KO.kickDvrLoadedAt = Date.now();
        diag('dvr_edge_clamp', { why: 'ended', dur: Math.round(dur), at: Math.round(at) });
        kickSend({ t: 'load', url: KO.kickDvrUrl, seekTo: at });
      } else {
        kickBackToLive(); // kick: replay ended → go live
      }
    }
    if (KO.player === 'kick') {
      updateKickBar();
      // Levels appear only after the manifest parses; re-render while the
      // menu is open so the picker is never left showing just 'Auto'.
      const qw = KO.wrap && KO.wrap.querySelector('#ko-quality-wrap');
      if (qw && qw.classList.contains('ko-open')) renderQualityMenu();
    }
  } else if (m.t === 'ev') {
    if (m.e === 'error') {
      console.log('[ko] kick (IVS) error', m.d || '');
      diag('ivs_error', { msg: String(m.d || '').slice(0, 140), code: m.code || 0 });
      if (!KO.enabled || KO.player !== 'kick' || !KO.activeUrl) return;
      // DVR errors → go live once (kick-identical: replay failure returns to
      // the edge), never a reconnect storm. Live errors → budgeted reconnect.
      if (KO.kickOnDvr) kickBackToLive();
      else fire(reconnect);
    } else if (m.e === 'rebuffering') {
      diag('ivs_rebuffer', {});
    }
  }
});

// Attach the current playback_url to the IVS frame. Same-url loads are
// no-ops (switching players never re-attaches). The frame is created once
// and the player is re-created only when the url actually changes.
// `opts.force` is the stall recovery's door: a player that reports `Playing`
// over a FROZEN clock is dead in every way that matters, and the same-url
// no-op below is exactly why the reconnect never repaired it (measured
// 2026-11-13: `stall {ct:10262}` -> `reconnect n:1..3` four times over 80 s
// with the picture never moving, because `ensureKick` saw `Playing` and
// returned).
function ensureKick(url, opts) {
  if (!KO.wrap) mount();
  const force = !!(opts && opts.force);
  if (!force && KO.activeUrl === url && KO.kickFrame && KO.kickReady) {
    if (KO.kickState && KO.kickState.state !== 'Playing') kickSend({ t: 'play' });
    return;
  }
  if (force) {
    // Same url, dead element: reload it in place. The frame, the token and the
    // DVR source all stay; only the media is re-fetched.
    KO.kickUrlT = Date.now();
    KO.kickEverPlayed = false;
    KO.stableSince = null;
    KO.stablePos = null;
    const seekTo = opts && Number.isFinite(opts.seekTo) ? opts.seekTo : null;
    if (KO.kickReady) {
      kickSend(seekTo !== null ? { t: 'load', url, seekTo } : { t: 'load', url });
      KO.pendingUrl = null;
    } else {
      KO.pendingUrl = url;
    }
    return;
  }
  KO.activeUrl = url;
  KO.kickUrlT = Date.now();
  KO.kickEverPlayed = false;
  KO.kickOnDvr = false;
  KO.kickDur = 0;
  // The replay edge belongs to ONE broadcast: a new live url (channel switch,
  // source rotation) invalidates the estimate, or the first rewind on a fresh
  // channel would clamp against the previous stream's duration.
  KO.kickDvrDur = 0;
  KO.kickDvrDurAt = 0;
  KO.kickDvrLoadedAt = 0;
  KO.kickDvrClamped = false;
  KO.stableSince = null;
  kickFrame();
  kickFetchDvr(); // replay source (best-effort, once per url)
  KO.pendingUrl = url;
  if (KO.kickReady) {
    kickSend({ t: 'load', url });
    KO.pendingUrl = null;
  }
}

// DVR/replay source — the same path VOD.RIP's downloader uses: the channel's
// newest VOD entry (id == the live stream's id while live) → its video uuid →
// GET /api/v1/video/<uuid> → `source` (the broadcast's HLS master, served
// from stream.kick.com with Access-Control-Allow-Origin: *). The IVS player
// loads it like any other HLS master; rewinds seek within its timeline.
// Fetched once per playback_url. (The POST /api/v1/stream/<uuid>/playback
// bootstrap needs the page's playbackVideoId, which the overlay — running on
// the Twitch page — cannot see.)
async function kickFetchDvr() {
  if (!KO.activeUrl || KO.dvrFetchedFor === KO.activeUrl) return;
  KO.dvrFetchedFor = KO.activeUrl;
  try {
    const vids = await (await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(KO.kickSlug)}/videos`, { credentials: 'omit' })).json();
    const list = Array.isArray(vids) ? vids : [];
    const cur = KO.kickStreamId ? list.find((v) => v && v.id === KO.kickStreamId) : null;
    const item = cur || list[0];
    if (!item || !item.video || !item.video.uuid) {
      diag('dvr_fetch', { err: 'no vod entry', slug: KO.kickSlug, streamId: KO.kickStreamId });
      return;
    }
    const v1 = await (await fetch(`https://kick.com/api/v1/video/${item.video.uuid}`, { credentials: 'omit' })).json();
    const src = v1 && v1.source;
    if (typeof src === 'string' && src) {
      KO.kickDvrUrl = src;
      // created_at is ISO-8601 UTC ("...Z") — an ABSOLUTE timestamp, so the
      // full-broadcast elapsed (bar max) is wall-clock-safe on any TZ (the
      // naive "YYYY-MM-DD HH:MM:SS" on the v2 channel endpoint is not).
      KO.kickStreamStart = Date.parse(v1.created_at) || null;
      KO.kickDvrFetchedAt = Date.now();
      diag('dvr_fetch', { ok: true, uuid: item.video.uuid.slice(0, 8), host: (src.split('/')[2] || '').slice(0, 40) });
    } else {
      diag('dvr_fetch', { err: 'no source in v1/video', uuid: item.video.uuid.slice(0, 8) });
    }
  } catch (e) {
    diag('dvr_fetch', { err: String(e).slice(0, 120) });
  }
}

// ---- kick.com-identical seek UX ---------------------------------------------
// Contract, measured live 2026-11-09 (twitch.tv/titiltei, player=kick):
//  - a click within 2 s of the edge is the LIVE CHIP: reload the live url.
//    With the old 30 s threshold every 10 s and 60 s back-seek was converted
//    into "go live" (rewind-10s clicked 12450.9 and the playhead came back at
//    47.7 -> live), which is the defect the owner reported.
//  - every deeper click seeks INSIDE the replay url (sources.dvr). A reload of
//    the same url re-starts its playlist at the edge and loses the offset.
//  - the replay's published edge lags the broadcast clock by ~21.7 s, so a
//    first load past it ends the replay and used to bounce to live; the target
//    is clamped into the published range and the `Ended` rescue re-loads at
//    dur-6 instead of going live.
const KICK_EDGE_GO_LIVE_SEC = 2;

function kickSeekTo(target) {
  KO.kickDvrClamped = false; // a new user seek may clamp once again
  const st = KO.kickState || {};
  const max = Math.max(1, KO.kickDur || Math.ceil((st.pos || 0) + (st.lat || 0)));
  const lat = isFinite(st.lat) && st.lat >= 0 ? st.lat : 0;
  const edge = Math.max(0, max - lat); // newest frame actually available
  // Clamp into the real DVR range. A bar click can land past the edge: the
  // broadcast max is wall-clock and runs ahead of the published DVR duration
  // by a few seconds, and IVS re-bases a seek past its timeline.
  const t = Math.max(0, Math.min(target, edge));
  if (edge - t <= KICK_EDGE_GO_LIVE_SEC) {
    kickBackToLive();
    return;
  }
  // Inside the LIVE element's own rewind window the seek is done in place: no
  // source reload, no stopped picture. Reloading the DVR url is only for a
  // target the live window cannot reach, and that path is the only one that can
  // cost a visible stop ("quando eu clico pra dar seek no player da kick nao e
  // pra ele pausar e despausar. e pra continuar rodando", owner 2026-11-11).
  // `win` is the element's own rewind window, and IVS/Twitch both publish the
  // literal sentinel 1073741824 in `seekable.end` when the window is unknown
  // (measured 2026-11-11: the kick bridge reported win=1073741824 on a live
  // url). A sentinel makes EVERY target look reachable, so a 60 s rewind was
  // "seeked in place" on a live timeline that cannot hold it and the frame
  // bounced back to the edge - the owner's "volta UM segundo e a live avanca".
  // A real window is seconds-to-hours; anything past 1e6 is "unknown".
  const win = Number(st.win) || 0;
  const winReal = win > 4 && win < 1e6 ? win : 0;
  if (!KO.kickOnDvr && winReal && edge - t <= winReal - 2) {
    kickSend({ t: 'seek', s: t });
    diag('live_seek', { target: Math.round(t), behind: Math.round(edge - t), win: Math.round(win) });
    updateKickBar();
    return;
  }
  kickStartDvr(t);
}

function kickStartDvr(target) {
  if (!KO.kickDvrUrl) {
    // Honest no-op: without the replay source there is nothing to rewind
    // into. Never fall back to "go live" — that is the defect the owner
    // reported; the live keeps playing and the reason is logged.
    diag('dvr_rewind', { skip: 'no dvr url', target: Math.round(target) });
    return;
  }
  if (KO.kickOnDvr) {
    // Already on the replay url: seek WITHIN it. Reloading the same url
    // restarts the playlist at its own edge and loses the offset. The bar's
    // max is the broadcast clock, which runs ahead of the published replay
    // (publish lag), so clamp a past-the-edge target into the duration the
    // frame reports: dur - 6 leaves the playlist time to publish the next
    // segment instead of ending the replay.
    const dur = Number(KO.kickState && KO.kickState.dur) || 0;
    const at = dur > 12 && target > dur - 6 ? Math.max(0, dur - 6) : target;
    if (at !== target) diag('dvr_edge_clamp', { dur: Math.round(dur), target: Math.round(target), at: Math.round(at) });
    kickSend({ t: 'seek', s: at });
    diag('dvr_seek', { target: Math.round(at) });
    updateKickBar();
    return;
  }
  // The replay's published edge lags the broadcast clock. A previous replay
  // tells us that lag: its duration was known then and the VOD grows ~1s/s,
  // so the edge now is that duration + elapsed. Clamp the first load into it
  // instead of loading past the edge, ending, and reloading once (the Ended
  // rescue still covers a first-ever replay). The clamps and the send itself
  // live in kickLoadReplayAt so a press that arrives DURING this load takes the
  // same path at the deeper offset.
  kickLoadReplayAt(target);
}

// Reload the SAME replay url at a deeper offset. That is the only tool for a
// press that arrives while the replay is still loading (the frame drops a seek
// issued before the media is seekable), and it is why a rapid burst across the
// live->replay handoff still lands N x 5s back instead of restarting at the
// handoff offset.
function kickLoadReplayAt(target) {
  if (!KO.kickDvrUrl) {
    diag('dvr_rewind', { skip: 'no dvr url', target: Math.round(target) });
    return null;
  }
  let loadAt = Math.max(0, target);
  if (KO.kickDvrDur > 0 && KO.kickDvrDurAt) {
    const est = KO.kickDvrDur + (Date.now() - KO.kickDvrDurAt) / 1000;
    if (est > 12 && loadAt > est - 6) loadAt = Math.max(0, est - 6);
    if (loadAt !== target) diag('dvr_edge_clamp', { est: Math.round(est), target: Math.round(target), at: Math.round(loadAt) });
  }
  KO.kickOnDvr = true;
  KO.kickDvrLoadedAt = Date.now();
  KO.kickDvrTarget = loadAt;
  KO.kickState = null;
  KO.kickUrlT = Date.now();
  kickSend({ t: 'load', url: KO.kickDvrUrl, seekTo: loadAt });
  diag('dvr_rewind', { target: Math.round(loadAt), url: 'reload' });
  updateKickBar();
  return loadAt;
}

// Go live = MINT a fresh url, never reload the old one. An IVS playback_url is a
// signed token with its own lifetime; the one this page minted at mount expires
// while the user sits on the DVR, and reloading it is a dead element that
// reports `state:"Playing"` over a frozen clock — measured 2026-11-13 in two
// kickparity runs (`go-live` -> `stall {ct:10529}` x3, `owner-regress
// {from:10529.4, to:46.2}`), and the reconnect repaired it only because THAT
// path mints. `kickBackToLive` now takes the same route.
async function kickGoLive() {
  KO.kickDvrClamped = false;
  diag('go-live', {
    onDvr: !!KO.kickOnDvr,
    from: Math.round(Number(KO.kickState && KO.kickState.pos) || 0),
    st: (KO.kickState && KO.kickState.state) || null,
    dur: Math.round(Number(KO.kickState && KO.kickState.dur) || 0),
    live: !!KO.activeUrl,
  });
  if (!KO.kickOnDvr) {
    // Already on the live url: the element owns the cross, so the player's own
    // seek-to-edge is the right tool (a reload would blink for no reason).
    kickSend({ t: 'seekToLive' });
    updateKickBar();
    return;
  }
  // Leaving the DVR: the replay's flag, position and duration all stop being
  // true, and the bar must not render the replay's clock against the live url.
  KO.kickOnDvr = false;
  if (KO.kickState) {
    KO.kickState.pos = 0;
    KO.kickState.lat = 0;
    KO.kickState.dur = 0;
    KO.kickState.state = 'Buffering';
  }
  KO.kickUrlT = Date.now();
  const k = await kickPlaybackUrl(KO.kickSlug);
  if (!KO.kickOnDvr && KO.enabled && KO.player === 'kick' && k && k.live && k.url) {
    KO.activeUrl = k.url;
    kickSend({ t: 'load', url: k.url });
    diag('go-live', { minted: true, at: Math.round(Number(KO.kickState && KO.kickState.pos) || 0) });
  } else if (!k || !k.live) {
    // The channel went offline while he was in the DVR: honest stop, not a
    // dead element pretending to be live.
    diag('go-live', { err: 'offline' });
    teardown();
    setBadge('KICK', '#6b7280');
  }
  updateKickBar();
}

// One name for the intent ("be at the live edge"). `kickGoLive` owns the mint
// and the DVR exit; `kickBackToLive` is the in-page callers' name for it, kept
// because the recovery paths read better with it.
function kickBackToLive() {
  return kickGoLive();
}

// ---- playback ownership -----------------------------------------------------
// Exactly one player may run at a time. When a visible Kick or YouTube layer
// owns the overlay, pause and mute every native Twitch video; resume only a
// Twitch video that this overlay paused when the layer is hidden or removed.
// The rendering invariant: a layer may play only while it is the SELECTED
// layer of a SHOWN overlay. showKickLayer/showYtLayer/teardown assert it at
// the moment of switching, but an EAGER mount lands afterwards (its frame
// autoplays as soon as it reports ready) — so the rect loop re-asserts it
// every tick. Sends are conditional on the layer actually reporting playback,
// hence idempotent: a parked frame is never churned.
function enforceOverlayRendering(shown) {
  const kickPlays = !!(KO.kickFrame && KO.kickState && KO.kickState.state === 'Playing');
  const ytPlays = !!(KO.ytState.ready && KO.ytState.playing);
  const kickMay = shown && KO.player === 'kick';
  const ytMay = shown && KO.player === 'youtube';
  if (kickPlays && !kickMay) kickSend({ t: 'pause' }); // one rendering: hidden kick player PAUSED
  if (ytPlays && !ytMay) ytCmd('pause');
}

// ---- audio ownership (ko-audio.js) ------------------------------------------
// This extension never writes `.muted` or sends a mute command on its own. It
// registers the surfaces that can render the stream, says which ONE is being
// listened to, and declares the user's intent; ko-audio.js derives the rest
// (muted = intent || policy || not-visible). This replaced `muteWrites`,
// `KO.muted`, `onUserVolumeChange` and every `kickSend({t:'mute'})` /
// `ytCmd('mute')` that used to decide for itself — nine trackers, each holding
// a frozen snapshot of the value, which is why a swap kept restoring an old
// decision over the user's newer one.

function audioBoot() {
  const audio = window.KOAudio;
  if (!audio) return false;
  // The page's own <video> is a surface of its OWN per host: a decision made on
  // Twitch must never silence the YouTube page the extension happens to be
  // overlaying (different player, different volume scale).
  KO.audioNative = onYtHost() ? 'page' : 'twitch';
  audio.registerNative(KO.audioNative, {
    elements: () => document.querySelectorAll('video'),
    main: () => twitchVideo(),
  });
  audio.register('kick', {
    write: (s) => {
      kickSend({ t: 'mute', m: s.muted });
      kickSend({ t: 'volume', v: s.volume });
    },
  });
  audio.register('yt', {
    write: (s) => {
      ytCmd('mute', s.muted);
      ytCmd('setVolume', s.volume);
    },
  });
  // KO.kickMuted/kickVol/ytMuted/ytVol stay as the UI mirror of the intent
  // store (the bar, the popup and the badge read them); they are derived, never
  // authoritative.
  audio.onChange(mirrorAudio);
  mirrorAudio();
  return true;
}

// WHO OWNS PLAYBACK, published for the MAIN-world ad path. The ad path exists to
// cover the NATIVE player; when the kick/yt layer owns the picture, the native
// player is paused by us and has no ad to hide, so a pod there is pure damage:
// the owner's "por que ele troca de player dizendo sem anuncio - 360p quando eu
// to no player da kick que NUNCA tem anuncio?" (2026-11-11), on a surface that
// never carries SSAI at all.
function syncOwner() {
  // Deliberately NOT tied to the bar's display: the bar hides itself when it
  // cannot find a native player to mirror, and the owner's report is a loop of
  // the native coming back and the layer returning seconds behind
  // ("o player vem, fica em tempo real, ai o player da twitch volta, e segundos
  // depois o outro player volta de novo, segundos atras ... e fica a 360p",
  // 2026-11-11). While an overlay player is SELECTED it is the picture, whether
  // or not its bar happens to be painted.
  //
  // SELECTED IS NOT ENOUGH (2026-11-11). The preference used to be the whole
  // term, so a layer that had no picture yet (kick `state:'Ready'` with the
  // media element at readyState 0, the IVS rs=0 defect) still held the
  // attribute: `twitch-adblock.js` reads "the attribute is non-empty" as "the
  // native is covered, do not fight a pod", so a broken layer also cost the ad
  // protection, on a player the user can see is not ours. The term is the
  // PICTURE now — a mount attempt always has a gap with no picture, and that
  // gap must belong to the native player.
  let owned = overlayOwnsPicture();
  // A SEEK IS NOT A PICTURE WE CAN KEEP (2026-11-12). A rewind and a re-show
  // both leave the frame reporting `Playing` for a moment before the element is
  // really advancing, and a frame that cannot advance keeps that report forever
  // (the owner's "o player trava"). A position that goes BACKWARDS while the
  // source is unchanged is the one cheap proof that the element did not follow
  // the command; hand the screen to the native, which the user can drive.
  const here = (KO.kickState && KO.kickState.pos) || (KO.ytState && KO.ytState.pos) || 0;
  if (owned && here > 0 && KO.ownerPos > 0 && here < KO.ownerPos - 3) {
    diag('owner-regress', { from: KO.ownerPos, to: here, pick: KO.player });
    KO.ownerPos = 0;
    owned = false;
  } else if (owned) {
    KO.ownerPos = here;
  } else {
    KO.ownerPos = 0;
  }
  const want = owned ? KO.player : '';
  if (KO.ownerAttr === want) return;
  const prev = KO.ownerAttr;
  KO.ownerAttr = want;
  try { document.documentElement.setAttribute('data-ko-owner', want); } catch { /* teardown */ }
  // TRANSITION LOG. Every owner change answers "who had the screen, and why",
  // which is the first question every owner report of 2026-11-11/12 needed and
  // the log could not answer: the attribute flipped silently while the native
  // and the ad path reacted to it.
  diag('owner', {
    from: prev || null,
    to: want || null,
    pick: KO.player,
    pic: overlayHasPicture(),
    failed: layerFailed(),
    cold: coldHoldActive(),
    graceMs: KO.picLostAt ? Date.now() - KO.picLostAt : 0,
    vis: visibleSurface(),
  });
}

// A TAB OPENED BEFORE AN UPDATE RUNS THE OLD FILE FOREVER. Loading this folder
// into Chrome does not re-inject content scripts into pages that already exist;
// only a navigation does, and `chrome.runtime.reload()` does not either (measured
// 2026-10-27 and again 2026-11-12: the owner's own `ko.adlog` carried
// `boot {ver:'0.8.79'}` while the manifest was 0.8.81, three waves behind, and
// every symptom he reported was the old file). `KO_VER` is a literal for exactly
// this reason; the manifest answers with the code that is really installed.
// One reload per version, recorded in sessionStorage so it can never loop, and a
// VISIBLE page is never reloaded under the user - the tab heals the next time it
// goes to the background, or on his own navigation.
function recoverStale() {
  let live = '';
  try { live = chrome.runtime.getManifest().version; } catch { return; }
  if (!live || live === KO_VER) return;
  let tried = '';
  try { tried = sessionStorage.getItem('ko.staleReload') || ''; } catch { /* private */ }
  if (tried === live) return;
  if (!document.hidden) {
    if (!KO.staleShown) {
      KO.staleShown = true;
      diag('stale-tab', { script: KO_VER, manifest: live, hidden: false, act: 'wait-hidden' });
    }
    return;
  }
  try { sessionStorage.setItem('ko.staleReload', live); } catch { /* private */ }
  diag('stale-tab', { script: KO_VER, manifest: live, hidden: true, act: 'reload' });
  // The ONE sanctioned reload of the page (ko-verify section 3): once per
  // version, hidden tabs only, proven by arm P2p.
  setTimeout(() => { try { location.reload(); } catch { /* teardown */ } }, 800); // ko-versioned-reload
}

// Does the selected overlay layer actually have a picture of its own right now?
// The last frame report is the only evidence: a layer whose state says paused /
// ended has nothing to show, and leaving the native paused would be a dead
// screen; a layer that is playing owns the screen even while its bar is hidden.
function overlayHasPicture() {
  if (KO.player === 'twitch' || !KO.wrap) return false;
  // Each layer reports on its OWN surface. This used to read `KO.kickState` for
  // the youtube player too, so an eagerly-mounted (paused) kick frame made the
  // yt layer read as "no picture" — and, after the ownership change below, a
  // playing yt layer would read the same way and hand the screen to the native
  // underneath it.
  // A report has an AGE. The bridge publishes once a second; a `Playing` state
  // from ten seconds ago describes a player that may already be frozen, and the
  // old code held the screen on it (owner 2026-11-12: "o player trava, e tenho q
  // reiniciar a pagina"). Three missed samples is the line: past it the layer has
  // no picture, the hysteresis grace runs out and the native takes the screen back
  // while the frame watchdog rebuilds in the background.
  const stale = (ts) => !ts || Date.now() - ts > STALE_REPORT_MS;
  if (KO.player === 'youtube') {
    const y = KO.ytState || {};
    if (stale(KO.lastYtSt || y.ts)) return false;
    return !!(y.ready && y.playing && !y.ended);
  }
  const st = KO.kickState;
  if (!st) return false;
  if (stale(st.ts)) return false;
  const state = String(st.state || '');
  if (state) return /playing|buffering|loading/i.test(state) && !/ended|idle|failed/i.test(state);
  return st.paused === false;
}

// The COLD OPEN, bounded. While an overlay layer is selected but has not painted
// yet, the native player's ONLY content is a Twitch preroll (owner 2026-11-11:
// *"ainda to vendo um anuncio tocar quando entro numa live por uns 5 segundos.
// depois disso que o player alternativo entra"*). That gap belongs to us, not to
// Twitch: the native is paused from the moment the preference is known, and the
// window is capped so a layer that never paints can never leave a black screen.
// Trade stated with its numbers: at most 4 s of black (measured picture at 1.9 s
// on a guest, ~2-5 s on the owner's machine) instead of 5 s of ad.
// 8 s, not 4: the release has to outlast the layer's OWN first signal (mint +
// manifest measured at 1.9 s on a guest and ~5 s on the owner's machine), or the
// native plays the preroll for the second between the release and the picture.
// A `Loading`/`Buffering` report already counts as a picture in
// overlayHasPicture(), so the only thing this window covers is the dead air
// before the layer says anything at all.
const COLD_HOLD_MS = 8000;

function coldHoldActive() {
  if (KO.player === 'twitch' || !KO.wrap) return false;
  if (KO.picSeenAt) return false; // it already painted once: the grace rule owns this
  if (layerFailed()) return false; // a dead layer is never held open
  if (typeof performance === 'undefined') return false;
  // The hold exists for a layer that is COMING. Most Twitch channels have no kick
  // counterpart, and holding the native for those would put a black screen in
  // front of a stream the user could simply watch. So the window only opens
  // while the layer is provably on its way: the mint is in flight, the frame
  // exists, or it has already reported a state this page load.
  const coming = !!(KO.kickFrame || KO.ytFrame || KO.kickPrewarm || KO.kickState || KO.ytState || KO.kickMountPending);
  if (!coming) return false;
  const t0 = KO.bootAt || performance.now();
  return performance.now() - t0 < COLD_HOLD_MS;
}

function layerFailed() {
  if (KO.player === 'youtube') {
    const y = KO.ytState || {};
    return !!(y.error || y.ended);
  }
  const st = KO.kickState || {};
  return !!st.error || /failed|error|ended/i.test(String(st.state || ''));
}

// Playback ownership, in one place: the selected overlay layer owns the native
// player only while it can actually paint. Both the 400 ms pause loop and the
// published `data-ko-owner` term read this, so they cannot disagree.
function overlayOwnsPicture() {
  // HYSTERESIS. Owner 2026-11-11: *"depois de uns segundos, o anuncio volta,
  // mas o player volta tambem. ficam brigando, sendo que isso nao ocorria
  // antes."* A raw picture test flips on every re-buffer: the kick frame reports
  // `Buffering`/`Ready` between segments, ownership drops, the native resumes,
  // the ad path takes a pod, the frame reports `Playing`, we take the screen
  // back - an ad/player fight. Ownership is a decision with a pause after a
  // lost picture, not a per-sample reading: 6 s covers an IVS re-buffer and any
  // seek, and the teardown paths still release it immediately by clearing the
  // player preference.
  if (KO.player === 'twitch' || !KO.wrap) {
    KO.picLostAt = 0;
    KO.picSeenAt = 0;
    return false;
  }
  // A layer that REPORTED a failure owns nothing, grace or not: the grace exists
  // so a re-buffer does not hand the screen back, never so a dead frame does.
  if (layerFailed()) {
    KO.picLostAt = 0;
    KO.picSeenAt = 0;
    return false;
  }
  if (overlayHasPicture()) {
    KO.picLostAt = 0;
    KO.picSeenAt = Date.now();
    return true;
  }
  // A layer that has NEVER had a picture owns nothing: the grace is a pause
  // after a lost picture, never a claim made from a preference.
  if (!KO.picSeenAt) return false;
  if (!KO.picLostAt) KO.picLostAt = Date.now();
  return Date.now() - KO.picLostAt < OWNER_GRACE_MS;
}

// Which surface is being LISTENED to — one answer, from the same predicate that
// decides which layer is on screen.
function visibleSurface() {
  // ONE predicate for picture, pause AND sound. This used to read the bar's CSS:
  // a hidden bar (hover-out, or Twitch deleting our node while the layer still
  // painted) declared the NATIVE the audible surface, so the same tick paused the
  // native (ownership) and unmuted it (surface!==visible had stopped applying) -
  // the owner's "saiu do player, foi pro player da twitch, e deixou pausado e
  // desmutado" (2026-11-12). The layer that OWNS the picture is the surface that
  // is listened to, whatever its bar is doing; with no picture the native is.
  const page = KO.audioNative || 'twitch';
  if (KO.player === 'twitch' || !KO.wrap) return page;
  const layer = KO.player === 'youtube' ? 'yt' : 'kick';
  if (overlayOwnsPicture() || coldHoldActive()) return layer;
  return page;
}

// The 400 ms enforcement tick: PLAYBACK ownership only. Audio follows from
// declaring which surface is visible; there is no mute write here any more.
function syncMute() {
  // Ownership of PLAYBACK, not of the bar: while an overlay player is selected
  // the native must never be the picture and never make a sound, whether or not
  // the bar is currently painted ("o player da twitch ta funcionando ao mesmo
  // tempo que o da kick. para com isso", owner 2026-11-11).
  //
  // But a layer with no picture is not the picture. The preference-only term
  // paused the native on every 400 ms tick while the kick layer sat at
  // readyState 0, and the tick's fallback resumed it again: a pause/resume
  // churn on the user's player, with the ad path also standing down for an
  // owner that was not on screen. Only pause what the overlay can replace.
  // A hidden tab changes nothing: not the ownership attribute, not the pause.
  // Every timer it would reason about is throttled, so any decision it took
  // there was a decision about a stale sample (owner 2026-11-12, alt-tab).
  if (document.hidden) return;
  const ownedPicture = overlayOwnsPicture();
  const cold = !ownedPicture && coldHoldActive();
  if (ownedPicture || cold) {
    let pausedNow = 0;
    for (const v of document.querySelectorAll('video')) {
      if (v.paused) continue;
      v.pause();
      KO.twWasPlaying = true;
      KO.twPaused.add(v); // ownership: only an element we paused is ours to resume
      pausedNow += 1;
    }
    if (pausedNow) diag('native-pause', { n: pausedNow, why: ownedPicture ? 'picture' : 'cold-open' });
  }
  syncOwner();
  if (!window.KOAudio) return;
  window.KOAudio.setVisible(visibleSurface());
  // CONVERGENCE. `setVisible()` no-ops when nothing changed, and the arbiter
  // only writes on a change or a claim, so an element another writer muted
  // stayed muted while the intent said "sound": the UI mirrors the INTENT, which
  // is the owner's "o player diz que nao ta mutado, mas ta mutado" (2026-11-11).
  // Re-assert the derived state, never a hand-written mute, and log the moment
  // it was needed so the next pod says whether anything still diverges.
  // EVERY page video, not only the main one: Twitch keeps extra elements
  // (ad/preview/PBP) and they are created after the last apply, so one can sit
  // `muted:false` while the overlay owns the screen (measured in the owner's
  // Chrome, 0.8.73: `{muted:false, paused:true, h:0}` with owner=kick). The
  // derived state is the whole surface's, so one apply() settles all of them.
  // The arbiter owns this now: `enforceSilence()` is MUTE-ONLY (it can never
  // un-mute, so it cannot overwrite the user's choice) and it derives each
  // element's state from the surface it belongs to, so it does not depend on
  // `want(visibleSurface())` being the right row - with the overlay visible that
  // row is the LAYER's "sound on", which is why the old drift check below never
  // saw a page video sitting open under the layer (measured 0.8.73:
  // `{muted:false, paused:true, h:0}` with owner=kick).
  try {
    const audio = window.KOAudio;
    if (typeof audio.enforceSilence === 'function') {
      const open = [...document.querySelectorAll('video')].filter((v) => v.isConnected && !v.muted).length;
      audio.enforceSilence();
      const after = [...document.querySelectorAll('video')].filter((v) => v.isConnected && !v.muted).length;
      if (after !== open) diag('audio-reassert', { open, after, vis: visibleSurface() });
    }
  } catch {
    /* a detached element mid-swap */
  }
}

function resumeTwitchIfOurs() {
  if (!KO.twWasPlaying) return;
  KO.twWasPlaying = false;
  // Resume ONLY the element this extension paused. KO.twWasPlaying is a
  // document-wide flag: a secondary (PBP / preview) video paused by the
  // overlay used to mark the whole page as ours, and the resume then started
  // the MAIN player — which the user had paused himself (owner report
  // 2026-11-07: "a paused Twitch tab is unpaused by the extension"). The
  // per-element set is the ownership record; a video the user parked is not
  // in it, so it stays parked.
  const v = twitchVideo();
  // Prune stale entries so a detached element cannot resurrect a later resume.
  for (const el of KO.twPaused) {
    if (!el || !el.isConnected || !el.paused) KO.twPaused.delete(el);
  }
  if (!v || !KO.twPaused.has(v)) return;
  KO.twPaused.delete(v);
  diag('native-resume', { why: KO.player === 'twitch' ? 'player-twitch' : 'layer-lost-picture', pic: overlayHasPicture(), own: overlayOwnsPicture(), cold: coldHoldActive() });
  try {
    const p = v.play();
    if (p && p.catch) p.catch(() => { /* autoplay policy */ });
  } catch {
    /* detached */
  }
}

// Hand the page's own player back (player=twitch / overlay disabled).
//
// OWNERSHIP IS THE GUARD. This used to start any paused element, and probe()
// runs on a 20 s poll plus on every `playing` event, so on a YouTube watch page
// with player=twitch the extension resumed a video the user had paused himself
// (owner report 2026-10-26: "something unpauses my YouTube by itself"). Only a
// video THIS extension paused (KO.twWasPlaying, set by syncMute) is restarted.
// The old "a paused element should be started" case is a user intent, and the
// user intent lives in storage/popup, not in a periodic probe.
function resumeNativePagePlayer(opts) {
  const ours = opts && opts.ours !== undefined ? !!opts.ours : KO.twWasPlaying;
  if (!ours) return;
  const v = twitchVideo();
  if (!v || !v.paused) return;
  KO.twWasPlaying = false;
  try { v.play().catch(() => { /* autoplay policy */ }); } catch { /* detached */ }
}

// The overlay must sit ABOVE the Twitch player but BELOW page UI that
// overlaps the player (user profile cards, badge hovercards, menus).
// Measured live (2026-08-13): the player lives in main.twilight-main
// (z-index 1, stacking context) → persistent-player (z 1) → video; the
// viewer card renders INSIDE main (right-column z 1 → chat wrapper z 10 →
// card z 10). A body-level overlay with max z-index covers the whole main
// context — card included — which is why profile clicks vanished under
// the overlay. Fix: append the wrap AND the floating buttons INTO main and
// use z-index 5 / 6 — above the player (1), below the chat/card wrapper
// (10). ponytail: if Twitch reworks these z-indexes, re-measure the
// wrapper values; the anchor selector is layout-agnostic ('main').
function overlayAnchor() {
  // The chat-viewer-card stacking context the anchor dance below solves only
  // exists on Twitch; on a YT page body-level (z-index 5) is correct.
  if (onYtHost()) return document.body;
  return document.querySelector('main.twilight-main, main') || document.body;
}

function ensureAttached(el) {
  if (el && !el.isConnected) overlayAnchor().appendChild(el);
}

// ---- overlay lifecycle ------------------------------------------------------

// ---- kick.com-identical player chrome (mined 2026-08-14) ---------------------
// Markup + Tailwind classes copied from kick's real player chunk
// (0x2w0nqf7e3t1.js) + compiled CSS (assets.kick.com): seekbar root
// `group/seekbar absolute -top-7 left-0 h-5 w-full`, track `bg-subtle/50`
// (rgba(146,158,166,.5)), fill + thumb `bg-green-500`/`bg-primary-base`
// (#53fc18), loaded progress `bg-white/50` + indicator `bg-white/30`
// (scaleX), hover time pill `-top-10 rounded-md p-1 text-xs font-bold`,
// thumb hidden until hover (`lg:betterhover:group-hover/seekbar:block`),
// volume slider `w-[100px] h-[3px] bg-[#24272C]` + `bg-white` fill, root
// `bg-gradient-to-t from-black/80 to-black/0`, LIVE badge = OnlineIcon +
// `text-sm font-semibold`, live elapsed `text-xs font-bold tabular-nums`.
// Behavior mirrors the mined store: live → rewind = startPlayingDVR at
// min(click, edge−30s); DVR → ≤30s from edge = goBackToLive, else DVR seek;
// hover shows "LIVE" near the edge, a -countdown behind, the time in DVR.
const KO_SVG = {
  play: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6.251 1H1.743v18h4.508l12.006-9z"/></svg>',
  pause: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M7.66 1H4.15v18h3.51zm8.19 0h-3.51v18h3.51z"/></svg>',
  sound: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M14.5 10A4.5 4.5 0 0 0 10 5.5v2.25A2.257 2.257 0 0 1 12.25 10 2.257 2.257 0 0 1 10 12.25v2.25a4.5 4.5 0 0 0 4.5-4.5"/><path d="M10 1v2.25A6.755 6.755 0 0 1 16.75 10 6.755 6.755 0 0 1 10 16.75V19c4.973 0 9-4.027 9-9s-4.027-9-9-9M1 5.5v9h2.25l4.5 4.5V1l-4.5 4.5z"/></svg>',
  muted: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 14.503c2.486 0 4.5-2.013 4.5-4.497v-.102l-4.489 3.53v1.069zm7.346-9.68L19 3.518l-1.384-1.753-1.777 1.394A9 9 0 0 0 10 1v2.249a6.73 6.73 0 0 1 4.016 1.338l-1.879 1.472A4.45 4.45 0 0 0 10 5.497v2.249L7.75 9.51v-8.5l-4.5 4.497H1v9.32l1.395 1.755zM7.75 19v-3.789l-2.126 1.664z"/><path d="M16.514 8.32c.146.539.236 1.101.236 1.686 0 3.721-3.026 6.745-6.75 6.745V19c4.973 0 9-4.025 9-8.994a8.7 8.7 0 0 0-.608-3.17l-1.878 1.472z"/></svg>',
  fs: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M16.188 12.25v3.938H12.25V19H19v-6.75zM7.75 16.188H3.813V12.25H1V19h6.75zM3.813 7.75V3.813H7.75V1H1v6.75zm8.437-3.937h3.938V7.75H19V1h-6.75z"/></svg>',
  settings: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="m8.1 1-.4 2a7 7 0 0 0-1.6.9L4.2 2.8 2.8 4.2l1.1 1.9a7 7 0 0 0-.9 1.6l-2 .4v2l2 .4a7 7 0 0 0 .9 1.6l-1.1 1.9 1.4 1.4 1.9-1.1a7 7 0 0 0 1.6.9l.4 2h2l.4-2a7 7 0 0 0 1.6-.9l1.9 1.1 1.4-1.4-1.1-1.9a7 7 0 0 0 .9-1.6l2-.4v-2l-2-.4a7 7 0 0 0-.9-1.6l1.1-1.9-1.4-1.4-1.9 1.1a7 7 0 0 0-1.6-.9l-.4-2zM9.1 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6"/></svg>',
};
function fmtDur(sec, incH) {
  // kick's formatVideoDuration: [HH if ≥1h]+[MM]+[SS], 0-padded
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  const out = p(mm) + ':' + p(ss);
  return incH || hh > 0 ? p(hh) + ':' + out : out;
}
function setKickFill(frac) {
  if (!KO.wrap) return;
  const fillEl = KO.wrap.querySelector('#ko-fill');
  const thumbEl = KO.wrap.querySelector('#ko-thumb');
  if (fillEl) fillEl.style.width = (Math.max(0, Math.min(1, frac)) * 100) + '%';
  if (thumbEl) thumbEl.style.left = (Math.max(0, Math.min(1, frac)) * 100) + '%';
}
function updateKickVolUI() {
  if (!KO.wrap) return;
  const isYt = KO.player === 'youtube';
  const muted = isYt ? (KO.ytMuted || KO.ytVol === 0) : (KO.kickMuted || KO.kickVol === 0);
  const v = muted ? 0 : (isYt ? KO.ytVol : KO.kickVol);
  const fillEl = KO.wrap.querySelector('#ko-volfill');
  const thumbEl = KO.wrap.querySelector('#ko-volthumb');
  const muteBtn = KO.wrap.querySelector('#ko-mute');
  if (fillEl) fillEl.style.width = (v * 100) + '%';
  if (thumbEl) thumbEl.style.left = (v * 100) + '%';
  if (muteBtn) {
    const want = v === 0 ? 'muted' : 'sound';
    if (muteBtn.dataset.st !== want) {
      muteBtn.dataset.st = want;
      muteBtn.innerHTML = want === 'muted' ? KO_SVG.muted : KO_SVG.sound;
    }
  }
}

function updatePlayUI() {
  if (!KO.wrap) return;
  const playing = KO.player === 'youtube'
    ? KO.ytState.playing
    : !!(KO.kickState && KO.kickState.state === 'Playing');
  const playBtn = KO.wrap.querySelector('#ko-play');
  if (!playBtn) return;
  const want = playing ? 'pause' : 'play';
  if (playBtn.dataset.st !== want) {
    playBtn.dataset.st = want;
    playBtn.innerHTML = want === 'pause' ? KO_SVG.pause : KO_SVG.play;
  }
}

function renderQualityMenu() {
  const menu = KO.wrap && KO.wrap.querySelector('#ko-quality-menu');
  if (!menu) return;
  const state = KO.player === 'youtube' ? KO.ytState : KO.kickState;
  const qualities = Array.isArray(state && state.qualities) ? state.qualities : [];
  menu.textContent = '';
  const add = (label, value, selected) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('ko-q');
    button.role = 'menuitemradio';
    button.textContent = label;
    button.setAttribute('aria-checked', String(selected));
    button.dataset.quality = value === 'auto' ? 'auto' : String(value);
    button.addEventListener('click', () => {
      const q = button.dataset.quality;
      // setLevel is the authoritative round-trip: the frame answers with
      // {t:'levels'} so the checkmark follows the ENGINE, not the click.
      const message = { t: 'setLevel', l: q === 'auto' ? 'auto' : Number(q) };
      if (KO.player === 'youtube') ytSend(message);
      else kickSend(message);
      const wrapEl = menu.parentElement;
      if (wrapEl) wrapEl.classList.remove('ko-open');
    });
    menu.appendChild(button);
  };
  add('Auto', 'auto', !state || !state.q);
  qualities.forEach((quality, id) => {
    const label = quality.name || (quality.h ? `${quality.h}p` : `${quality.w || ''}w`);
    add(label, Number.isInteger(quality.id) ? quality.id : id, !!state && state.q && state.q.name === label);
  });
}

// The bar re-arms on pointer activity OVER the wrap. The wrap itself is
// pointer-events:none (page UI under it must stay clickable), so once the
// bar fades (it gets pointer-events:none too) NO event can ever reach a
// listener bound to the wrap — the 0.8.2/0.8.3 hot bar never came back after
// its 2.6s cooldown (owner symptom 4). The arm therefore lives at document
// level with a rect hit-test; the wrap's own listeners stay as the cheap
// path while the bar is still visible (events bubble from it).
function setupHotBar(wrap) {
  teardownHotBar();
  KO.hotWrap = wrap;
  // A TRANSITION, not a sample: the bar going from hidden to shown is the fact
  // worth a row, and it names what armed it (`frame` = the overlay player's own
  // pointer relay, `page` = the page's rectangle hit-test). Owner report
  // 2026-11-16: "hover nao mostrava o player" - and the vocabulary that decides
  // where to look for the row that explains it is this one.
  const armHot = (src) => {
    if (!KO.hotWrap) return;
    const wasHot = KO.hotWrap.classList.contains('ko-hot');
    KO.hotWrap.classList.add('ko-hot');
    if (!wasHot) diag('bar-arm', { src: src || 'page' });
    clearTimeout(KO.hotTimer);
    KO.hotTimer = setTimeout(() => {
      if (!KO.hotWrap) return;
      if (KO.hotWrap.classList.contains('ko-hot-lock')) return; // the mouse is still ON the bar
      KO.hotWrap.classList.remove('ko-hot');
      diag('bar-hide', { why: 'timer' });
    }, 2600);
  };
  KO._hotArm = armHot;
  KO._hotArmDoc = (e) => {
    const w = KO.hotWrap;
    if (!w || w.style.display === 'none') return;
    const r = w.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (e.clientX >= r.left && e.clientX <= r.left + r.width &&
        e.clientY >= r.top && e.clientY <= r.top + r.height) armHot('page');
  };
  wrap.addEventListener('pointermove', () => armHot('page'));
  wrap.addEventListener('pointerdown', () => armHot('page'));
  wrap.addEventListener('mouseenter', () => armHot('page'));
  // While the pointer sits ON the bar it stays up; a timer must never hide the
  // controls under a mouse that is still there (the other half of "o ux ta uma
  // merda" on 2026-11-11).
  wrap.addEventListener('pointerenter', () => {
    clearTimeout(KO.hotTimer);
    KO.hotTimer = null;
    if (!KO.hotWrap) return;
    armHot('bar');
    KO.hotWrap.classList.add('ko-hot-lock');
  });
  wrap.addEventListener('pointerleave', () => {
    if (KO.hotWrap) KO.hotWrap.classList.remove('ko-hot-lock');
    armHot('page');
  });
  document.addEventListener('pointermove', KO._hotArmDoc, true);
  document.addEventListener('pointerdown', KO._hotArmDoc, true);
  armHot('boot');
}

function teardownHotBar() {
  clearTimeout(KO.hotTimer);
  KO.hotTimer = null;
  if (KO.hotWrap && KO._hotArm) {
    KO.hotWrap.removeEventListener('pointermove', KO._hotArm);
    KO.hotWrap.removeEventListener('pointerdown', KO._hotArm);
    KO.hotWrap.removeEventListener('mouseenter', KO._hotArm);
  }
  if (KO._hotArmDoc) {
    document.removeEventListener('pointermove', KO._hotArmDoc, true);
    document.removeEventListener('pointerdown', KO._hotArmDoc, true);
    KO._hotArmDoc = null;
  }
  KO.hotWrap = null;
  KO._hotArm = null;
}

function mount() {
  if (KO.wrap) return;
  const wrap = document.createElement('div');
  wrap.id = 'ko-wrap';
  wrap.style.display = 'none';
  wrap.classList.add('ko-kick');
  const bar = document.createElement('div');
  bar.id = 'ko-bar';
  bar.innerHTML =
    '<div id="ko-g1" class="ko-g">' +
    '<button id="ko-play" class="ko-icn" title="Play/Pause"></button>' +
    '<div id="ko-volwrap" class="ko-volwrap">' +
    '<button id="ko-mute" class="ko-icn" title="Mute"></button>' +
    '<div id="ko-vols"><div id="ko-voltrack"><div id="ko-volfill"></div><div id="ko-volthumb"></div></div></div>' +
    '</div>' +
    '<span id="ko-cur" class="ko-t"></span>' +
    '<span class="ko-t ko-sep">/</span>' +
    '<span id="ko-total" class="ko-t"></span>' +
    '</div>' +
    '<div id="ko-g2" class="ko-g"><div id="ko-quality-wrap"><button id="ko-settings" class="ko-icn" title="Quality" aria-label="Quality"></button><div id="ko-quality-menu" role="menu"></div></div><button id="ko-fs" class="ko-icn" title="Fullscreen" aria-label="Fullscreen"></button></div>' +
    '<div id="ko-seekbar">' +
    '<span id="ko-hov" class="ko-hov"></span>' +
    '<div id="ko-loaded" class="ko-prog"></div>' +
    '<div id="ko-loadind" class="ko-prog"></div>' +
    '<div id="ko-track"><div id="ko-fill"></div></div>' +
    '<div id="ko-thumb"></div>' +
    '</div>' +
    '<button id="ko-golive" class="ko-golive" title="Back to live" aria-label="Back to live">LIVE</button>';
  wrap.appendChild(bar);
  const rc = document.createElement('div');
  rc.id = 'ko-reconnecting';
  rc.textContent = 'RECONNECTING\u2026';
  rc.style.display = 'none';
  wrap.appendChild(rc);
  overlayAnchor().appendChild(wrap);
  KO.wrap = wrap;
  // Keyboard focusability (0.8.6 pain 2): the wrap must be reachable by Tab
  // so a keyboard-only user can focus the overlay and drive the seek arrows.
  // Key handling lives in ONE place — the document capture (onOverlayKeydown,
  // fires for any page/renderer focus) + the iframe-bridge relay; a bubble
  // listener here was dead weight because the document capture's
  // stopImmediatePropagation always wins (0.8.6 P3a).
  wrap.tabIndex = 0;
  KO.hideTicks = 0;

  const play = bar.querySelector('#ko-play');
  play.innerHTML = KO_SVG.play;
  play.addEventListener('click', () => {
    const playing = KO.player === 'youtube'
      ? KO.ytState.playing
      : !!(KO.kickState && KO.kickState.state === 'Playing');
    if (KO.player === 'youtube') ytCmd(playing ? 'pause' : 'play');
    else kickSend(playing ? { t: 'pause' } : { t: 'play' });
  });
  const muteBtn = bar.querySelector('#ko-mute');
  muteBtn.innerHTML = KO_SVG.sound;
  const fsBtn = bar.querySelector('#ko-fs');
  fsBtn.innerHTML = KO_SVG.fs;
  const qualityBtn = bar.querySelector('#ko-settings');
  const qualityWrap = bar.querySelector('#ko-quality-wrap');
  qualityBtn.innerHTML = KO_SVG.settings;
  qualityBtn.setAttribute('aria-haspopup', 'menu');
  qualityBtn.setAttribute('aria-expanded', 'false');
  qualityBtn.addEventListener('click', () => {
    renderQualityMenu();
    qualityWrap.classList.toggle('ko-open');
    qualityBtn.setAttribute('aria-expanded', String(qualityWrap.classList.contains('ko-open')));
  });
  // The bar is a user gesture: declare intent, let ko-audio.js write it to the
  // layer the user hears (and persist it once).
  muteBtn.addEventListener('click', () => {
    const audio = window.KOAudio;
    const surface = KO.player === 'youtube' ? 'yt' : 'kick';
    const cur = audio ? audio.intent(surface) : { muted: KO.player === 'youtube' ? KO.ytMuted : KO.kickMuted, volume: KO.player === 'youtube' ? KO.ytVol : KO.kickVol };
    const muted = !cur.muted;
    if (audio) audio.setIntent(surface, { muted, volume: !muted && cur.volume === 0 ? 1 : cur.volume }, { persist: true, origin: 'user:ui:bar-mute' });
    updateKickVolUI();
  });
  const volwrap = bar.querySelector('#ko-volwrap');
  const volTrack = bar.querySelector('#ko-voltrack');
  const volFrac = (e) => {
    const r = volTrack.getBoundingClientRect();
    return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  };
  let volDrag = false;
  const setVolFrom = (e) => {
    const v = volFrac(e);
    const audio = window.KOAudio;
    const surface = KO.player === 'youtube' ? 'yt' : 'kick';
    if (audio) audio.setIntent(surface, { volume: v, muted: v === 0 }, { origin: 'user:ui:bar-slider' });
    updateKickVolUI();
  };
  volwrap.addEventListener('pointerdown', (e) => {
    if (e.target === muteBtn || e.target.closest('#ko-mute')) return;
    e.preventDefault();
    volDrag = true;
    try {
      volwrap.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported */
    }
    setVolFrom(e);
  });
  volwrap.addEventListener('pointermove', (e) => {
    if (!volDrag) return;
    if (e.buttons === 0) {
      // capture lost: release happened outside — still persist
      volDrag = false;
      saveState();
      return;
    }
    setVolFrom(e);
  });
  volwrap.addEventListener('pointerup', () => {
    volDrag = false;
    saveState();
  });
  volwrap.addEventListener('pointercancel', () => {
    volDrag = false;
  });
  const sb = bar.querySelector('#ko-seekbar');
  const hov = bar.querySelector('#ko-hov');
  let dragging = false;
  const fracFromEvent = (e) => {
    const r = sb.getBoundingClientRect();
    return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  };
  const showHover = (frac) => {
    const r = sb.getBoundingClientRect();
    const pos = frac * KO.kickDur;
    const dur = KO.kickDur || 1;
    hov.textContent = KO.kickOnDvr
      ? fmtDur(pos, dur >= 3600)
      : pos >= dur - 30
        ? 'LIVE'
        : '-' + fmtDur(dur - pos, dur >= 3600);
    hov.style.left = Math.max(14, Math.min(r.width - 14, frac * r.width)) + 'px';
    hov.style.display = 'block';
  };
  sb.addEventListener('pointermove', (e) => {
    if (dragging) {
      if (e.buttons === 0) {
        // capture lost: release happened outside the bar — end the drag
        endDrag(e);
        return;
      }
      setKickFill(fracFromEvent(e));
      KO.seeking = true;
      return;
    }
    showHover(fracFromEvent(e));
  });
  sb.addEventListener('pointerleave', () => {
    if (!dragging) hov.style.display = 'none';
  });
  sb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    KO.seeking = true;
    sb.classList.add('ko-drag');
    try {
      sb.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported */
    }
    setKickFill(fracFromEvent(e));
    showHover(fracFromEvent(e));
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    KO.seeking = false;
    sb.classList.remove('ko-drag');
    hov.style.display = 'none';
    const target = fracFromEvent(e) * KO.kickDur;
    if (KO.player === 'youtube') {
      // yt live window: the seekbar spans [edge - window, edge]; a drag maps
      // to an absolute media time, clamped by the frame's own seek logic.
      const edge = (KO.ytState.ct || 0) + (KO.ytState.lat || 0);
      const winStart = edge - KO.kickDur;
      ytCmd('seek', winStart + target);
    } else {
      kickSeekTo(target);
    }
  };
  sb.addEventListener('pointerup', endDrag);
  sb.addEventListener('pointercancel', () => {
    dragging = false;
    KO.seeking = false;
    sb.classList.remove('ko-drag');
    hov.style.display = 'none';
  });
  bar.querySelector('#ko-fs').addEventListener('click', toggleOverlayFullscreen);
  const golive = bar.querySelector('#ko-golive');
  golive.addEventListener('click', () => {
    if (KO.player === 'youtube') ytCmd('seekToLive');
    else kickBackToLive();
  });
  startRectLoop();
  setupHotBar(wrap);
}

function teardown() {
  teardownHotBar();
  stopRectLoop();
  if (KO.kickFrame) {
    try {
      KO.kickFrame.remove();
    } catch {
      /* already gone */
    }
    KO.kickFrame = null;
  }
  if (KO.wrap) {
    KO.wrap.remove();
    KO.wrap = null;
  }
  // THE DEATH PATH MUST PUBLISH THE LOSS, OR THE ATTRIBUTE OUTLIVES THE LAYER.
  // `data-ko-owner` is written by syncOwner() alone, and the only thing that
  // calls it is syncMute() — which the rect loop reaches below `if (!KO.wrap)`.
  // So this function used to null the wrap and stop the loop with `kick` still
  // on the element: a dead layer kept telling `twitch-adblock.js`
  // (`overlayOwnsPlayback`, twitch-adblock.js:2389) that the native was
  // covered, and `adUiHold` returned at line 1297 on a page whose picture was
  // Twitch's own. Measured 2026-11-19 on twitch.tv/alanzoka (no kick channel at
  // all, so the layer dies on the first offline probe): his ring has
  // `ad-ui-on` at 3020767 with the `owner:"kick"` row as the ONLY owner row in
  // 1200 entries, and the live page still reads
  // `data-ko-owner="kick"` with `#ko-wrap` absent. Publish the loss HERE, where
  // the wrap dies, instead of adding a second writer: null already answers
  // `overlayOwnsPicture()===false`, so syncOwner() emits `''` on its own.
  syncOwner();
  // the frame dies with the removed iframe; no ytCmd('destroy') exists
  KO.ytState = freshYtState();
  KO.ytUnlock = false;
  if (KO._ytUnlockDoc) {
    document.removeEventListener('pointerdown', KO._ytUnlockDoc, true);
    KO._ytUnlockDoc = null;
  }
  KO.ytWin = null;
  KO.lastYtSt = 0;
  KO.ytHlsUrl = null;
  KO.ytHlsAt = 0;
  KO.ytHlsFailed = false;
  KO.ytHlsFailedAt = 0;
  KO.ytLoadedUrl = null;
  KO.pendingYtUrl = null;
  KO.ytEmbedAt = 0;
  KO.ytProbeAt = 0;
  KO.ytNoEvidence = 0;
  KO.kickProbeAt = 0;
  KO.kickReady = false;
  KO.kickWin = null; // the destroyed iframe's contentWindow must not outlive it
  KO.kickState = null;
  KO.pendingUrl = null;
  KO.activeUrl = null;
  KO.kickEverPlayed = false;
  KO.kickOnDvr = false;
  KO.kickDur = 0;
  KO.reconnectCount = 0;
  KO.hideTicks = 0;
  KO.stallTicks = 0;
  KO.lastTickT = 0;
  KO.lastKickSt = 0;
  KO.twLive = false;
  KO.twWasPlaying = false;
  if (window.KOAudio) window.KOAudio.setVisible(KO.audioNative || 'twitch');
}

function showWrap() {
  if (!KO.wrap) return;
  KO.wrap.style.display = 'block';
  KO.hideTicks = 0;
  syncMute();
}

function hideWrap() {
  if (!KO.wrap) return;
  KO.wrap.style.display = 'none';
  if (KO.kickFrame && KO.kickState && KO.kickState.state === 'Playing') {
    kickSend({ t: 'pause' }); // one rendering: hidden kick player PAUSED
  }
  if (KO.ytState.ready && KO.ytState.playing) ytCmd('pause');
  syncMute(); // declares the page surface; the arbiter mutes both layers
}

// probe()'s wrap-hide sites: with the Twitch player deleted, hiding the wrap
// shows a blank page (there is no native player left) — keep the loading-state
// wrap up; the badge (chrome.action) + the #ko-golive LIVE pill carry the
// phase instead.
function hideWrapForProbe() {
  if (KO.twDeleted && KO.player !== 'twitch') return;
  if (KO.wrap) hideWrap();
}

// Source-liveness clocks for the rect-loop keep-up gate (0.8.4). 0.8.3
// asked TRANSIENT playback state and only about kick: an IVS re-buffer or
// DVR transition past the 25s grace hid a LIVE kick layer every 400ms
// (symptom 3), and a dead yt layer under twDeleted stayed pinned as a black box
// forever (symptom 1/2). The probes are authoritative (20s poll + event-driven): kickProbeAt/ytProbeAt mark the last time the
// ACTIVE player's source was confirmed — set on every confirming show
// branch, zeroed on a conclusive offline/failure. Transient player states
// never hide anything; the window (3 polls) only covers missed ticks.
function kickLayerLive() {
  // The transient arms are DVR/reconnect transitions — they are only
  // display-worthy while the poll loop still confirms the source (the
  // confirming branch stamps kickProbeAt every 20s). Without the clock test a
  // conclusive offline (`kickProbeAt = 0` + hideWrap) was overruled by a
  // leftover kickOnDvr flag, and the 400ms loop re-showed the black box the
  // poll had just declared dead.
  if ((KO.kickOnDvr || KO.reconnectCount > 0) && KO.kickProbeAt && Date.now() - KO.kickProbeAt < 3 * POLL_MS)
    return true;
  if (!KO.activeUrl) return false;
  const st = KO.kickState;
  if (st && st.state === 'Playing') return true;
  if (KO.kickProbeAt && Date.now() - KO.kickProbeAt < 3 * POLL_MS) return true;
  return !!(KO.kickUrlT && Date.now() - KO.kickUrlT < KICK_GRACE_MS);
}

// The yt leg's ONE liveness answer: the frame's transient 'st' state counts
// only while the bridge is still talking. 3 polls (60s) tolerates the
// hidden-tab throttling documented at the frame-death watchdog below; without
// the freshness AND, a drained/ended element kept reporting 'Paused' from the
// bridge's 1s timer and pinned a blank black wrap forever under twDeleted
// (owner symptom 1) — the sticky flag outlived any source evidence.
function ytBridgeLive() {
  return !!(KO.ytState.live && KO.lastYtSt && Date.now() - KO.lastYtSt < 3 * POLL_MS);
}

function ytLayerLive() {
  if (ytBridgeLive()) return true;
  return !!(KO.ytProbeAt && Date.now() - KO.ytProbeAt < 3 * POLL_MS);
}

// The rect-loop keep-up gate: a pinned overlay is only display-worthy when
// the ACTIVE player's source is live/loading. 0.8.3 asked only about kick,
// so under twDeleted a dead youtube layer stayed pinned as a black box.
function activeLayerLive() {
  if (KO.player === 'youtube') return ytLayerLive();
  if (KO.player === 'kick') return kickLayerLive();
  return true; // twitch mode never reaches this branch (overlay not shown)
}

function showKickLayer() {
  if (!KO.wrap) mount();
  const wasHidden = KO.wrap.style.display === 'none';
  KO.wrap.classList.remove('ko-yt');
  KO.wrap.classList.add('ko-kick');
  showWrap();
  if (KO.ytState.ready && KO.ytState.playing) ytCmd('pause');
  if (KO.kickFrame) {
    kickSend({ t: 'play' });
    // Freshest edge ONLY when re-showing the layer after a hide — probe()
    // re-shows every poll and a per-poll seek would stall live playback. A
    // replay playback is NOT pulled to the edge: the user asked for that
    // offset, and the re-show happens on every poll (measured 2026-11-09: the
    // paused DVR frame was dragged to live by its own re-show).
    if (wasHidden && !KO.kickOnDvr) { KO.kickOnDvr = false; kickSend({ t: 'seekToLive' }); }
  }
  syncMute();
}

function showYtLayer() {
  if (!KO.wrap) mount();
  KO.wrap.classList.remove('ko-kick');
  KO.wrap.classList.add('ko-yt');
  showWrap();
  if (KO.kickFrame && KO.kickState && KO.kickState.state === 'Playing') {
    kickSend({ t: 'pause' }); // one rendering: hidden kick player PAUSED
  }
  ytCmd('play');
  setTimeout(() => {
    // Muted autoplay fallback: unmute on the first user gesture.
    if (KO.player === 'youtube' && KO.ytState.muted) enableYtUnlock();
  }, 500);
  syncMute();
}

// kick fatal — reconnect IN PLACE: the wrap keeps covering Twitch (muted +
// paused) the whole time, so the user never sees the underlying player or
// an ad. Each attempt fetches a FRESH playback_url (IVS tokens rotate).
// The freeze recovery's SOURCE choice, isolated from the reconnect's backoff:
// a forced reload is in-place, so it must reload the source the dead element
// was actually on. On the replay url that is the replay, at the offset he was
// watching; on the live url it is the fresh mint. Named and reachable because
// it is the half a test has to prove, and the reconnect's 2 s backoff lets the
// page's own poll write over any state a test sets up around it.
function kickStallRecover(liveUrl) {
  if (KO.kickOnDvr && KO.kickDvrUrl) {
    const at = Number(KO.kickState && KO.kickState.pos) || Number(KO.kickDvrTarget) || 0;
    ensureKick(KO.kickDvrUrl, { force: true, seekTo: at > 0 ? at : undefined });
    KO.kickDvrLoadedAt = Date.now();
    KO.kickDvrTarget = at;
    return 'dvr';
  }
  ensureKick(liveUrl, { force: true });
  return 'live';
}

async function reconnect() {
  if (KO.reconnectCount >= MAX_RECONNECT) {
    // A REPLAY that keeps stalling is not a dead stream: the live edge is still
    // there, and kick.com's own player returns to it when a replay fails. Only
    // the live case is a teardown.
    if (KO.kickOnDvr && KO.activeUrl) {
      diag('dvr_stall_go_live', { n: KO.reconnectCount });
      kickBackToLive();
      return;
    }
    teardown();
    setBadge('KICK', '#6b7280');
    return;
  }
  KO.reconnectCount++;
  setBadge('KICK', '#d97706');
  if (KO.wrap) {
    const rc = KO.wrap.querySelector('#ko-reconnecting');
    if (rc) rc.style.display = 'flex';
  }
  console.log(`[ko] kick reconnect attempt ${KO.reconnectCount}/${MAX_RECONNECT}`);
  diag('reconnect', { n: KO.reconnectCount, max: MAX_RECONNECT });
  const k = await kickPlaybackUrl(KO.kickSlug);
  if (!k.live || !k.url) {
    teardown();
    setBadge('KICK', '#6b7280');
    return;
  }
  await new Promise((r) => setTimeout(r, 2000)); // back off, then re-attach
  if (!KO.enabled || KO.player !== 'kick') return;
  // FORCE: the stall that asked for this reconnect was a frozen picture, and
  // the url is the same one the dead element already has. A no-op here is the
  // whole defect (`stall {ct:10262}` repeating while the picture never moved).
  //
  // AND RELOAD WHAT HE IS WATCHING. A freeze on the replay url must come back
  // on the replay url at the SAME offset: measured 2026-11-13, the forced
  // reload used the LIVE url, so a stall in DVR teleported him to the edge
  // (`owner-regress {from:10529.4, to:46.2}` after three stalls) — the exact
  // "advancei e perdi a parte que eu estava vendo" class he reported. The DVR
  // source is the one the dead element was on, and its position is the last
  // one it reported.
  kickStallRecover(k.url);
  if (KO.wrap) {
    const rc = KO.wrap.querySelector('#ko-reconnecting');
    if (rc) rc.style.display = 'none';
  }
}

// Unified bar: full-broadcast seek slider (kick-style DVR: rewinds switch
// to the replay url, ≤30s from the edge goes live) + the #ko-golive "back to
// live" pill, shown when the playhead sits behind the edge or on the DVR url
// on EITHER leg (click: seekToLive / kickBackToLive). For kick the bar is
// the whole broadcast; for the yt HLS layer it is the ~20s live window
// (liveBackBufferLength) tracking the current buffered range.
// Position/latency/duration come from the frame's ~1s messages.
function updateKickBar() {
  if (!KO.wrap) return;
  const isYt = KO.player === 'youtube';
  const st = isYt ? null : KO.kickState;
  const liveVisible = isYt
    ? !!KO.ytState.live
    : !!(st && (st.state === 'Playing' || st.state === 'Buffering' || KO.kickOnDvr));
  KO.wrap.classList.toggle('ko-offline', !liveVisible);
  renderQualityMenu();
  const goliveEl = KO.wrap.querySelector('#ko-golive');
  // Reveal the return-to-live pill only when the playhead actually sits
  // behind the edge (more than one arrow step) or on the DVR/replay url;
  // label it with the latency it will remove so the arrows have a readout.
  const setGoLive = (show, label) => {
    if (!goliveEl) return;
    goliveEl.classList.toggle('ko-show', !!show);
    if (show && label) goliveEl.textContent = label;
  };

  if (isYt) {
    // yt live window (hls.js liveBackBufferLength): pos rides the buffer,
    // lat is the gap to the live edge. The bar spans [edge - window, edge].
    let max = KO.ytState.dur || 0;
    if (!(max > 0) || !isFinite(max)) max = Math.max(1, KO.ytState.ct || 1);
    const lat = isFinite(KO.ytState.lat) && KO.ytState.lat >= 0 ? KO.ytState.lat : 0;
    KO.kickDur = max;
    const head = Math.max(0, max - lat);
    if (!KO.seeking) setKickFill(max > 0 ? head / max : 0);
    const loaded = KO.wrap.querySelector('#ko-loaded');
    const loadind = KO.wrap.querySelector('#ko-loadind');
    if (loaded) loaded.style.transform = 'scaleX(1)';
    if (loadind) loadind.style.transform = 'scaleX(1)';
    const cur = KO.wrap.querySelector('#ko-cur');
    const total = KO.wrap.querySelector('#ko-total');
    if (cur) cur.textContent = fmtDur(head, max >= 3600);
    if (total) total.textContent = fmtDur(max, max >= 3600);
    // Show the pill when the yt HLS window sits behind the live edge (lat > 1
    // arrow step); clicking sends seekToLive (player-bridge clamps to the edge).
    setGoLive(lat >= ARROW_SEEK_SEC, lat >= ARROW_SEEK_SEC ? 'LIVE −' + Math.max(1, Math.round(lat)) + 's' : '');
    updatePlayUI();
    updateKickVolUI();
    return;
  }

  if (!st) {
    // A hidden-state kickState reset must not leave a stale 'LIVE / LIVE −Ns'
    // pill shining from a dead state; clear it (0.8.6 P3b).
    setGoLive(false, '');
    return;
  }
  const pos = st.pos || 0;
  const lat = st.lat;
  const liveEdge = isFinite(lat) && lat >= 0 ? pos + lat : null;
  const dur = st.dur > 0 ? st.dur : null;
  // Full-broadcast range when the stream start is known (kick.com's bar is
  // the whole broadcast, playhead riding the edge); window fallback before
  // the first DVR fetch. The max GROWS as the stream runs (wall-clock).
  // Cap at 48h and require finite values — poisoned/NaN player readings
  // (a bad seek, getLiveLatency() quirks) must never reach the bar.
  let max = dur || 0;
  if (Number.isFinite(KO.kickStreamStart) && KO.kickDvrFetchedAt) {
    const elapsed = (Date.now() - KO.kickStreamStart) / 1000;
    if (elapsed > max) max = elapsed;
  }
  if (!(max > 0)) max = Math.ceil(liveEdge || pos || 1);
  if (!isFinite(max) || max > 172800) max = 172800; // 48h ceiling
  KO.kickDur = max;
  const head = KO.kickOnDvr ? pos : Math.max(0, max - (isFinite(lat) && lat >= 0 ? lat : 0));
  if (!KO.seeking) setKickFill(max > 0 ? head / max : 0);
  // Loaded progress (kick: bg-white/50 full + bg-white/30 indicator, scaleX).
  // IVS reports no buffered range; live is always "loaded" to the edge, DVR
  // gets a short lookahead.
  const loadedSec = KO.kickOnDvr ? Math.min(max, pos + 5) : max;
  const lf = max > 0 ? loadedSec / max : 1;
  const loaded = KO.wrap.querySelector('#ko-loaded');
  const loadind = KO.wrap.querySelector('#ko-loadind');
  if (loaded) loaded.style.transform = 'scaleX(' + lf + ')';
  if (loadind) loadind.style.transform = 'scaleX(' + lf + ')';
  const cur = KO.wrap.querySelector('#ko-cur');
  const total = KO.wrap.querySelector('#ko-total');
  if (cur) cur.textContent = fmtDur(head, max >= 3600);
  if (total) total.textContent = fmtDur(max, max >= 3600);
  // Kick pillar: reveal when behind live (lat > 1 arrow step) or on the DVR
  // replay url; clicking kickBackToLive reaches the edge (seekToLive on the
  // live url, a live reload only when actually on DVR).
  const behind = isFinite(lat) && lat >= ARROW_SEEK_SEC;
  // 0.8.6 P3b: gate on kick-state freshness — a probe white-out (no kick st
  // message for 3*POLL_MS) must not keep a stale LIVE / LIVE −Ns pill aflame.
  const freshKick = !!(st && st.ts) && Date.now() - st.ts < 3 * POLL_MS;
  setGoLive(freshKick && (behind || !!KO.kickOnDvr), behind ? 'LIVE −' + Math.max(1, Math.round(lat)) + 's' : KO.kickOnDvr ? 'LIVE' : '');
  updatePlayUI();
  updateKickVolUI();
}

function setPlayer(p) {
  if (p === KO.player) return;
  const from = KO.player;
  KO.player = p;
  const a = window.KOAudio;
  diag('player-switch', {
    from,
    to: p,
    vis: visibleSurface(),
    intent: a
      ? { kick: a.intent('kick'), yt: a.intent('yt'), twitch: a.intent('twitch') }
      : null,
  });
  // Manual switch = retry intent (see the storage.onChanged note): a flip to
  // youtube must attempt a FRESH mint, not replay a stale failure.
  if (p === 'youtube') { KO.ytHlsFailed = false; KO.ytHlsFailedAt = 0; }
  saveState(true).then(() => apply()); // apply() only toggles layers/pause/mute
}

// ---- decision loop ----------------------------------------------------------

async function probe() {
  const slug = currentSlug();
  if (!slug) {
    setBadge('');
    teardown();
    return;
  }
  // Route gate: only a route that actually hosts the mirrored player may run
  // the overlay. Both hosts keep a ghost player element after an SPA
  // navigation, so this is the ONLY reliable signal — see
  // overlayTargetRoute(). Resuming "if ours" first hands back a channel player
  // this overlay paused before the user left the player route.
  if (!overlayTargetRoute()) {
    resumeTwitchIfOurs();
    setBadge('');
    teardown();
    return;
  }
  if (onYtHost()) {
    // ---- YouTube page (inverse mapping) ---------------------------------
    KO.host = 'yt';
    // Re-resolve when the page identity changes OR when the mapping table
    // is edited (storage.onChanged replaces KO.mappings with a fresh
    // object, so an identity compare is enough — no reload needed).
    if (slug === KO.ytPageId && KO.mappings === KO.ytBoundMappings) {
      // Same YT page and the same table it was bound from — nothing to do.
    } else {
      KO.ytPageId = slug;
      KO.ytBoundMappings = KO.mappings;
      const t = resolveYtPageKick();
      if (!t) {
        // No stored mapping matches this page — never guess another
        // streamer's stream onto it.
        KO.slug = null;
        KO.kickSlug = null;
        KO.ytRaw = '';
        KO.ytId = null;
        KO.ytPageTarget = null;
        setBadge('');
        teardown();
        return;
      }
      KO.ytPageTarget = t;
      // The table row that owns this YT channel IS the stream identity here
      // (its key is the streamer's twitch slug): volume/mute prefs and the
      // popup's channel entry all key off it.
      KO.slug = t.slug;
      const m = KO.mappings[t.slug];
      KO.kickSlug = (typeof m === 'string' ? m : (m && m.kick)) || t.m.kick || t.slug;
      // The yt layer of a YT page is the PAGE'S OWN live stream: the stored
      // row's yt value when present, else the page identity itself (UC id or
      // @handle — both accepted by the background resolver).
      KO.ytRaw = (typeof m === 'object' && m && m.yt) || t.m.yt || slug.replace(/^host:yt:/, '');
      KO.ytId = (typeof m === 'object' && m && m.ytId) || t.m.ytId || (/^UC[0-9A-Za-z_-]{22}$/.test(KO.ytRaw) ? KO.ytRaw : null);
      teardown();
    }
    if (!KO.enabled) {
      setBadge('OFF', '#6b7280');
      // teardown() clears KO.twWasPlaying, so carry the ownership across it:
      // turning the overlay off must still hand back a player we paused.
      const ours = KO.twWasPlaying;
      teardown();
      resumeNativePagePlayer({ ours });
      return;
    }
    if (KO.player === 'twitch') {
      // No native player of ours to hand back on a YT page — 'twitch' means
      // "the page's own player": drop the overlay, leave YouTube alone.
      hideWrapForProbe();
      resumeTwitchIfOurs();
      resumeNativePagePlayer();
      setBadge('', undefined);
      return;
    }
    if (KO.player === 'kick') {
      await probeKickLayer();
      // Eager dual-mount (instant switch): while kick plays, mint the yt
      // layer in the background so a flip never waits on the network.
      if (KO.activeUrl && KO.kickState && KO.kickState.state === 'Playing') fire(ensureYtEager);
      return;
    }
    await probeYtLayer();
    // Symmetric eager mount: while YT plays, attach kick (paused+muted).
    if (!KO.activeUrl) fire(ensureKickEager);
    return;
  }
  // ---- Twitch page (forward mapping) -------------------------------------
  KO.host = 'twitch';
  KO.ytPageId = null;
  if (slug !== KO.slug) {
    KO.slug = slug;
    const m = KO.mappings[slug];
    KO.kickSlug = typeof m === 'string' ? m : (m && m.kick) || slug; // same-handle fallback
    KO.ytRaw = m && typeof m === 'object' ? m.yt || '' : '';
    KO.ytId = m && typeof m === 'object' ? m.ytId || null : null;
    teardown();
  }
  if (!KO.enabled) {
    setBadge('OFF', '#6b7280');
    const ours = KO.twWasPlaying;
    teardown();
    resumeNativePagePlayer({ ours });
    return;
  }
  // NOTE (2026-08-13): no Twitch-live gate here anymore. It used to
  // teardown() the whole overlay whenever the native player paused or
  // swapped elements during ad transitions, which made the manual KICK
  // switch appear broken (clicks did nothing until Twitch happened to be
  // playing). Manual switches always take effect; kick liveness is gated
  // by kickPlaybackUrl(), youtube by the embed's own live state.
  updateTwLiveSticky(twitchVideo());

  if (KO.player === 'twitch') {
    // Native player; overlay players paused (rect loop keeps them so).
    hideWrapForProbe();
    resumeNativePagePlayer();
    const kl = await kickPlaybackUrl(KO.kickSlug);
    const yl = KO.ytState.live;
    setBadge(kl.live ? 'KICK' : yl ? 'YT' : 'TW', kl.live ? '#059669' : yl ? '#ff0000' : '#6b7280');
    return;
  }

  if (KO.player === 'kick') {
    await probeKickLayer();
    return;
  }
  await probeYtLayer();
  // Eager dual-mount on twitch pages too: the popup flip becomes a class
  // change instead of a mint round-trip.
  if (!KO.activeUrl) fire(ensureKickEager);
}

// Kick layer decision path (identical logic on both hosts — on a YT page
// it covers the YT player instead of the twitch one).
async function probeKickLayer() {
  // Dead-url watchdog: the frame loaded a url but never reached Playing
  // within 15s. Kick's v2 API hands out a stale top-level playback_url for
  // offline channels; without this the layer would sit black over Twitch
  // (the user's nyro report). Playing-then-frozen is the stall watchdog's
  // job (reconnect with a FRESH url) — this one covers never-played.
  if (
    KO.activeUrl &&
    !KO.kickEverPlayed &&
    KO.kickState &&
    KO.kickState.state !== 'Playing' &&
    KO.kickUrlT &&
    Date.now() - KO.kickUrlT > 15000
  ) {
    console.log('[ko] kick url never played — teardown', KO.kickSlug, KO.kickState.state);
    diag('kick_stall', { slug: KO.kickSlug, state: KO.kickState.state, ct: KO.kickState.ct });
    KO.kickProbeAt = 0;
    teardown();
    if (KO.wrap) hideWrap();
    setBadge('KICK', '#6b7280');
    return;
  }
  // Already playing on a live url? Keep it — IVS playback_urls rotate on
  // every API call and a re-attach would reset the stream to the live edge.
  // The stall watchdog reconnects with a FRESH url when the current one
  // goes stale (8s frozen). This branch is network-free → the KICK button
  // switch is instant.
  if (KO.activeUrl && KO.kickState && KO.kickState.state === 'Playing') {
    KO.kickProbeAt = Date.now(); // keep-up clock re-anchored by playback
    showKickLayer();
    setBadge('KICK', '#059669');
    return;
  }
  // Transition grace: a url younger than 25s is still loading (fresh live
  // loads after a DVR replay take ~10s to first frames; the DVR→live
  // switch must NOT be interrupted by a mid-load url rotation — that was
  // the "reconnecting" loop: every 20s poll fetched a NEW playback_url
  // and restarted the load). Failure recovery is the watchdogs' job:
  // never-played (>15s) tears down, stuck-not-playing (>25s, below)
  // reconnects on budget, frozen-while-playing (>8s) reconnects on budget.
  if (KO.activeUrl && KO.kickUrlT && Date.now() - KO.kickUrlT < KICK_GRACE_MS) {
    showKickLayer();
    setBadge('KICK', '#d97706'); // url still loading — connecting phase
    return;
  }
  // Stuck not-playing watchdog: the url loaded but the player never left
  // Idle/Ready/Buffering (e.g. a live reload after the replay that IVS
  // won't start). Budgeted like any reconnect — a stable Playing resets
  // the budget, so real transient failures self-heal without looping.
  if (KO.activeUrl && KO.kickState && KO.kickState.state !== 'Playing' && KO.reconnectCount < MAX_RECONNECT) {
    console.log('[ko] kick not-playing for 25s — reconnecting', KO.kickState.state);
    diag('kick_stuck', { state: KO.kickState.state, ct: KO.kickState.ct });
    reconnect();
    return;
  }
  const k = await kickPlaybackUrl(KO.kickSlug);
  // The poll runs every 20 s, so an unchanged outcome is stable state, not
  // news: `kick_probe {at:"poll"}` + `kick_offline` repeated 114 times each in
  // the owner's 2026-11-16 ring and evicted the ad chronology. One row per
  // transition; a channel that goes offline -> live -> offline logs all three.
  const pollSig = `${KO.kickSlug}|${k.live ? 1 : 0}|${k.url ? 1 : 0}|${KO.kickMintSig || ''}`;
  const pollChanged = pollSig !== KO.kickPollSig;
  KO.kickPollSig = pollSig;
  if (pollChanged) kickLog('kick_probe', { slug: KO.kickSlug, live: k.live, url: k.url ? 'yes' : 'no', at: 'poll' });
  if (k.live && k.url) {
    KO.kickStreamId = k.streamId || null;
    // Live CONFIRMED: anchor the keep-up clock. A first frame slower than
    // the 25s url-grace (url rotation, DVR→live) must NOT make the 400ms
    // loop hide a genuinely-live layer — the next 20s poll re-anchors here.
    KO.kickProbeAt = Date.now();
    ensureKick(k.url);
    showKickLayer();
    setBadge('KICK', '#d97706'); // fresh url attached — frame still loading
    return;
  }
  // P8 (0.8.6): log only the slug + a short live/url status — the full
  // kickPlaybackUrl payload (playback_url) never hits the console.
  console.log('[ko] kick offline or unreachable', KO.kickSlug, 'live:', k.live, 'url:', k.url ? 'yes' : 'no');
  if (pollChanged) kickLog('kick_offline', { slug: KO.kickSlug, live: k.live, url: k.url ? 'yes' : 'no', why: KO.kickMintSig || null });
  // Honest offline badge: after a yt→kick fallback the layer the user
  // actually chose is the failed one — say so instead of a KICK that
  // implies their own kick choice.
  setBadge(KO.ytHlsFailed ? 'YT' : 'KICK', '#6b7280');
  // A conclusive offline is not a loading state — nothing will play behind
  // the wrap — so hideWrapForProbe()'s twDeleted keep-up would pin an empty
  // black box over the deleted player forever. Hide directly; a later live
  // probe re-shows through showKickLayer(). The keep-up clock stops here so
  // the rect loop does not pin what the poll just declared dead.
  KO.kickProbeAt = 0;
  if (KO.wrap) hideWrap();
}

// Last-resort handover when YouTube is selected but no usable YouTube source
// exists. Probe the Kick channel first: KO.kickSlug is either the mapped Kick
// channel or the Twitch name (same-handle). Never switch to an offline Kick
// channel - that was the old black-box path. The preference stays 'youtube'
// in storage; this is a session-only fallback, exactly like the hls failure.
async function tryKickFallback(reason) {
  if (KO.host === 'yt' || !KO.kickSlug) return false;
  const now = Date.now();
  if (now - (KO.ytKickFallbackAt || 0) < 5000) return false;
  KO.ytKickFallbackAt = now;
  const k = await kickPlaybackUrl(KO.kickSlug);
  if (!k.live || !k.url) return false;
  diag('yt_fallback', {
    kick: KO.kickSlug,
    reason,
    sameHandle: KO.kickSlug === KO.slug,
  });
  KO.player = 'kick';
  fire(apply);
  return true;
}

// YouTube layer decision path (identical logic on both hosts).
async function probeYtLayer() {
  KO.ytProbeAt = Date.now(); // probe in flight: pin the layer across the mint round-trip
  if (!KO.ytRaw) {
    KO.ytProbeAt = 0;
    if (await tryKickFallback('no-yt-mapping')) return;
    setBadge('YT', '#6b7280'); // no mapping - map the channel in the popup
    hideWrapForProbe();
    return;
  }
  await ensureYtId();
  if (!KO.ytId && !ytDirectVideoId(KO.ytRaw)) {
    KO.ytProbeAt = 0;
    if (await tryKickFallback('yt-unresolved')) return;
    setBadge('YT', '#6b7280'); // could not resolve handle → check the popup value
    hideWrapForProbe();
    return;
  }
  await ensureYtHls();
  ensureYtIframe();
  // A stalled embed is a CONCLUSIVE verdict, not a loading state: the frame
  // existed for longer than YT_EMBED_GRACE and never said 'ready'. Computed
  // once so the handover gate AND the keep-up clock agree on it (the handover
  // is disarmed on a yt host / same-handle mapping, where a never-resolving
  // mint used to pin the clock forever through the in-flight stamp).
  const embedStalled = !!(KO.ytEmbedAt && !KO.ytState.ready && Date.now() - KO.ytEmbedAt > YT_EMBED_GRACE);
  // The HLS layer never initialized: the manifest mint failed (ytHlsFailed -
  // also set by the frame's fatal error handler after its one reload) or the
  // frame never reached ready within YT_EMBED_GRACE. Hand over to Kick only
  // after proving that Kick is live. tryKickFallback() probes KO.kickSlug,
  // which may be a real mapping OR the same Twitch name; a same-handle probe
  // is safe now because it never switches to an offline channel. The handover
  // must NOT persist: the user's stored player choice stays 'youtube' (only
  // the in-memory layer switches).
  // Give the bridge's one automatic reload time to recover before treating a
  // fatal hls error as a dead URL (1.5s reload + manifest parse).
  const ytHardFail = !!(KO.ytHlsFailed && Date.now() - (KO.ytHlsFailedAt || 0) > 4000);
  if (KO.host !== 'yt' && (ytHardFail || embedStalled)) {
    if (await tryKickFallback(ytHardFail ? 'yt-failed' : 'yt-embed-stalled')) return;
  }
  // The mint refreshed (TTL or post-failure re-mint) while the frame was
  // alive: hand the NEW url to the frame — the old one is dead (stream
  // restart) and would otherwise sit black forever.
  if (KO.ytState.ready && KO.ytHlsUrl && KO.ytLoadedUrl !== KO.ytHlsUrl) {
    ytSend({ t: 'load', url: KO.ytHlsUrl });
    KO.ytLoadedUrl = KO.ytHlsUrl;
  }
  if (KO.ytState.live || (KO.ytState.ready && KO.ytHlsUrl && KO.ytLoadedUrl === KO.ytHlsUrl)) {
    // live, or ready with the current url handed over and starting to load
    // (kick-style transition grace: show now, hls.js goes live in a moment;
    // a dead url posts a fatal error that flips ytHlsFailed → fallback).
    // Deliberately NOT freshness-gated here (unlike ytLayerLive): the frame
    // posts 'st' every second and a throttled-but-live tab must still get
    // this positive confirmation. The fatal handler clears `live`, so a
    // proven-dead url can no longer reach this branch.
    KO.ytProbeAt = Date.now();
    KO.ytNoEvidence = 0;
    showYtLayer();
    setBadge('YT', '#ff0000');
    return;
  }
  // Not live yet: amber while minting/loading (retry after the 30s backoff),
  // gray when the mint failed and no real kick mapping exists to fall back to.
  // The keep-up clock follows the VERDICT, not the attempt: the in-flight
  // stamp at the top of this function only carries the layer across ONE cycle
  // (a real mint round-trip). A cycle that learns nothing positive AND proves
  // nothing (no live, no fatal, embed still inside its grace) is a mint that
  // never resolves — after two such cycles the clock stops, so the 20s poll
  // cannot re-anchor it forever. A conclusive failure or a stalled embed
  // stops it at once.
  if (ytHardFail || embedStalled) {
    KO.ytProbeAt = 0;
    KO.ytNoEvidence = 0;
  } else if (++KO.ytNoEvidence >= 2) {
    KO.ytProbeAt = 0;
  }
  setBadge('YT', ytHardFail ? '#6b7280' : '#d97706');
  hideWrapForProbe();
}

// ---- eager dual-mount (instant player switching) ----------------------------
// Both layers are mounted as soon as their source is known; switching is a
// pure CSS class flip on #ko-wrap (showKickLayer/showYtLayer) — never a
// teardown, never a network round-trip on the click path. The hidden layer
// is paused + muted (one rendering, same as always); only its MINT is
// pre-warmed, which is what actually cost seconds.
async function ensureYtEager() {
  if (KO.player !== 'kick' || !KO.enabled || !KO.ytRaw) return;
  await ensureYtId();
  if (!KO.ytId && !ytDirectVideoId(KO.ytRaw)) return;
  await ensureYtHls();
  if (!KO.ytHlsUrl) return;
  ensureYtIframe(); // mounts hidden by .ko-kick #ko-yt{display:none}
}

async function ensureKickEager() {
  if (KO.player !== 'youtube' || !KO.enabled || !KO.kickSlug || KO.activeUrl) return;
  const k = await kickPlaybackUrl(KO.kickSlug);
  if (!k.live || !k.url) return;
  if (KO.player !== 'youtube') return; // choice moved on — don't hijack the state
  KO.kickStreamId = k.streamId || null;
  ensureKick(k.url);
  kickSend({ t: 'pause' });
  // The muted state of a hidden kick layer is derived (visible !== 'kick').
}

// Entry point for everything that is NOT the 20s poll (storage.onChanged
// player/mapping/enable flips, SPA navigation, the kick-overlay:set hook).
// Identity binding lives in probe() ONLY — a second copy here would have to
// duplicate the host-aware inverse-mapping resolution (and on a YT page the
// page identity is deliberately != the resolved table row, so a naive
// 'slug !== KO.slug' test here would teardown the overlay on every flip).
async function apply() {
  await probe();
}

function toggleOverlayFullscreen() {
  if (!KO.wrap || KO.player === 'twitch' || KO.wrap.style.display === 'none') return;
  if (document.fullscreenElement === KO.wrap) document.exitFullscreen().catch(() => {});
  else KO.wrap.requestFullscreen().catch((err) => diag('fullscreen', { err: String(err).slice(0, 100) }));
}

// ---- the playing source's own timeline ---------------------------------------
// A rewind is expressed in TWO different clocks depending on the source, and
// mixing them was the "arrow jumps to the start of the live" bug:
//  - live url: getPosition() is relative to THIS playback session (the live
//    window), not to the broadcast start. `KO.kickDur` is the whole VOD
//    duration (hours), so a broadcast-timeline target built from pos+lat
//    lands near 0 on the replay url.
//  - replay url: pos IS the broadcast offset, so a direct seek is correct.
// `kickSrcOffset` is the number that converts one into the other: the position
// of the element's own clock zero on the broadcast timeline, ESTIMATED as
// `broadcast edge - element clock edge`. The live element's clock zero is the
// moment its playlist started (measured 2026-11-20: pos 1626.84 against a
// broadcast edge of 27863 -> offset 26236), and the broadcast edge is the
// wall-clock elapsed since `kickStreamStart`, which the bar already trusts for
// its max. It is used ONLY to place a rewind that the live element cannot hold
// in itself, where the alternative is losing the rewind entirely.
function kickBroadcastEdge() {
  const start = KO.kickStreamStart;
  const at = KO.kickDvrFetchedAt;
  if (start && at) {
    const edge = (at - start) / 1000 + (Date.now() - at) / 1000;
    if (isFinite(edge) && edge > 0) return edge;
  }
  const st = KO.kickState || {};
  return Math.max(0, (Number(st.pos) || 0) + (Number(st.lat) || 0));
}

function kickSrcOffset() {
  const st = KO.kickState || {};
  const pos = Number(st.pos) || 0;
  const lat = Number(st.lat) || 0;
  if (KO.kickOnDvr) return 0; // the replay's clock IS the broadcast offset
  return Math.max(0, kickBroadcastEdge() - (pos + lat));
}

// Arrow-left/right seek inside the live window. The absolute media time is
// the current playhead +/- the step; each engine clamps to what it actually
// holds (yt/hls: the liveBackBufferLength window; kick: the live element's
// own back-buffer, and the replay source beyond it).
// EVERY exit of seekOverlayStep goes through this: one row per press, naming
// the inputs the decision used and the branch that won. A refused press is a
// row too. Why this exists: the owner's "a setinha volta 1-2s / a live
// atrapalha / flica" report left NO trace in ko.adlog, because this function
// had silent returns (`if (lat >= 25) return;` swallowed the press entirely)
// and `live_seek` only fired from kickSeekTo - so the press could not be
// attributed from the ring at all (census 2026-11-20: guard-shaped silent
// exits, three of them in this function). `why` is mandatory on a refusal.
// Two decimals or 0: the ring stores JSON, and a raw float is unreadable in it.
function kStepNum(v) {
  const n = Number(v);
  return isFinite(n) ? +n.toFixed(2) : 0;
}

function arrowStepRow(act, d) {
  const o = d || {};
  const num = kStepNum;
  diag('arrow-step', {
    act,
    why: o.why || null,
    dir: o.delta < 0 ? 'back' : 'fwd',
    engine: o.engine || KO.player || null,
    from: num(o.from),
    to: num(o.to),
    pos: num(o.pos),
    pending: num(num(o.to) - num(o.pos)),
    lat: num(o.lat),
    hold: Math.round(Number(o.hold) || 0),
    win: Math.round(Number(o.win) || 0),
    onDvr: !!KO.kickOnDvr,
  });
}

function seekOverlayStep(delta) {
  if (!KO.wrap || KO.player === 'twitch') {
    arrowStepRow('refused', { delta, why: !KO.wrap ? 'no-wrap' : 'player-twitch' });
    return;
  }
  if (KO.player === 'youtube') {
    // yt HLS: the seekable range is the ~liveBackBufferLength window ending
    // at the live edge; a currentTime write past the edge would silently
    // snap back. Arrow-right at/over the edge must be "go live", not an
    // over-shoot that then snaps to whatever buffered head the player had.
    const ct = KO.ytState.ct || 0;
    const lat = isFinite(KO.ytState.lat) && KO.ytState.lat >= 0 ? KO.ytState.lat : 0;
    const edge = ct + lat;
    if (ct + delta >= edge) {
      ytCmd('seekToLive');
      arrowStepRow('go-live', { delta, engine: 'youtube', from: ct, to: edge, pos: ct, lat });
      return;
    }
    ytCmd('seek', ct + delta);
    arrowStepRow('seek', { delta, engine: 'youtube', from: ct, to: ct + delta, pos: ct, lat });
    return;
  }
  // kick: one press is ONE step, composed from the local burst (see below),
  // and the action is chosen by what THIS element can still hold. Measured on
  // the live source 2026-11-20: the element holds `pos - buffered.start(0)`
  // seconds behind the playhead (1.2s at the edge, growing to ~25s once the
  // back-buffer fills), and an in-place seek PAST that lands and STOPS
  // (paused=true, readyState 1 - the picture then has to be revived, which is
  // the flicker the owner reported). The old `if (lat >= 25) return;` used the
  // live LATENCY as a proxy for that window and swallowed the press with no log
  // row at all; latency is a different quantity (measured lat 30.3 against a
  // 25.4s buffer) and a press must never be silent.
  const st = KO.kickState || {};
  const pos = Number(st.pos) || 0;
  const lat = isFinite(st.lat) && st.lat >= 0 ? st.lat : 0;
  // The burst: presses that the last report cannot have answered yet. Their
  // targets are what the next press composes onto, so a burst inside one 1s
  // report still adds its own step (owner: "apertar varias vezes rapido nao
  // deveria bugar").
  const now = Date.now();
  const burst = KO.kickStep && KO.kickStep.onDvr === !!KO.kickOnDvr && now - KO.kickStep.at < KICK_STEP_ACCUM_MS
    ? KO.kickStep
    : null;
  const anchor = burst ? burst.target : pos;
  const target = Math.max(0, anchor + delta);
  // How far behind the anchor the current element still holds. `hold` is the
  // bridge's buffered back-buffer; 0 means the bridge has not measured it (an
  // older frame, or no back-buffer yet), and then the LATENCY is the honest
  // fallback: with only ~lat seconds of history there is nothing to hold.
  const held = isFinite(st.hold) && st.hold > 0 ? Number(st.hold) : 0;
  const room = Math.max(0, (held > 0 ? held : lat) - KICK_STEP_MARGIN_SEC);
  const back = Math.max(0, anchor - target);
  let act;
  if (delta > 0) {
    // ArrowRight mirrors: one step forward, and at/over the edge it is "go
    // live" - the existing contract, unchanged.
    const edge = KO.kickOnDvr ? (Number(st.dur) || 0) : pos + lat;
    act = KO.kickOnDvr
      ? (target >= edge - 1 ? 'go-live' : 'seek')
      : (pos + lat <= ARROW_SEEK_SEC + 1 ? 'go-live' : 'seek');
  } else {
    const bcastRoom = KO.kickOnDvr ? target : anchor + kickSrcOffset() - target;
    act = !KO.kickOnDvr && back > room
      ? (KO.kickDvrUrl && bcastRoom > 0 ? 'handoff-dvr' : 'blocked')
      : 'seek';
  }
  // A replay that has been loaded but has not reported Playing yet cannot take
  // a seek (the frame drops it before the media is seekable), so the press
  // reloads the replay AT THE DEEPER OFFSET instead - never the live edge.
  const replayLoading = KO.kickOnDvr && (now - (KO.kickDvrLoadedAt || 0) < KICK_STEP_ACCUM_MS * 20)
    && (!KO.kickState || KO.kickState.state !== 'Playing');
  const extra = { delta, from: anchor, to: target, pos, lat, hold: held, win: Number(st.win) || 0 };
  if (act === 'seek' && replayLoading && delta < 0) {
    // The depth is composed in the replay's own (broadcast) clock, which is
    // what the reload offset means.
    kickLoadReplayAt(Math.max(0, anchor + delta));
    KO.kickStep = { base: pos, target: Math.max(0, anchor + delta), at: now, onDvr: true };
    act = 'handoff-dvr';
  } else if (act === 'seek') {
    kickSend({ t: 'seek', s: target });
  } else if (act === 'go-live') {
    kickSend({ t: 'seekToLive' });
  } else if (act === 'handoff-dvr') {
    // The burst left what the live element holds: hand the SAME intent to the
    // replay source at the broadcast offset, so the rewind survives instead of
    // being re-based to the edge (owner's ring: pos 540.15 -> 0 -> 27375.85,
    // the whole rewind destroyed). kickStartDvr loads the replay and keeps
    // playing across the switch. The burst then continues in the BROADCAST
    // clock (the replay's own timeline), so a following press composes on it.
    const at = Math.round(Math.max(0, anchor + kickSrcOffset() + delta));
    kickStartDvr(at);
    KO.kickStep = { base: pos, target: at, at: now, onDvr: true };
  }
  // The burst lives only while a press is ANSWERABLE by the source that now
  // owns the player: an in-place seek keeps it (the next press composes onto
  // its target), the live->replay handoff starts one in the BROADCAST clock,
  // and go-live/refusal end it - the next press must start from a fresh report,
  // never from a target that was not reached.
  if (act === 'seek') KO.kickStep = { base: burst ? burst.base : pos, target, at: now, onDvr: !!KO.kickOnDvr };
  else if (act !== 'handoff-dvr') KO.kickStep = null;
  if (act === 'blocked') extra.why = KO.kickOnDvr ? 'past-replay-start' : 'no-replay-source';
  if (act === 'handoff-dvr' && KO.kickStep) extra.to = KO.kickStep.target; // the broadcast offset actually asked for
  // A rejected press is a row too: nothing here may exit without naming itself.
  arrowStepRow(act, extra);
}

// Shared dispatch for an overlay key, whether it arrived from the page
// (document keydown capture) or relayed from a focused iframe player (pain 2:
// the bridge posts {t:'key', k} when focus sits inside the extension frame).
// Assumes k is already lowercased and whitelisted by the caller.
function dispatchOverlayKey(key) {
  // Gate on "overlay selected", NOT on visible: a transient rect miss can
  // hide the wrap for up to 20s, and a hidden-yet-selected overlay must
  // still answer arrows (0.8.5: dead arrow keys while the wrap was hidden).
  if (!KO.wrap || KO.player === 'twitch') return;
  // 0.8.6 P2-4: a HIDDEN wrap means hideWrap() has PAUSED the layer and the
  // frame-death watchdog only runs while shown — dispatching a seek into a
  // paused/derendered frame is a no-op at best and manufactures a load on a
  // stale DVR url at worst. Re-arm first: a live layer gets shown AND unpaused
  // via the layer-correct show helper (showWrap alone never sends play, so the
  // judge's P2: a re-shown frame stayed frozen/black); an off/loading layer
  // just re-runs rectTick (which re-attaches if the host dropped the wrap).
  // The seek below then targets a real, visible, PLAYING frame.
  // The kick re-arm routes through showKickLayer, whose wasHidden semantics
  // already seek to the live edge — a following ArrowRight step would dispatch
  // a SECOND seekToLive (judge P2 follow-up: one press, one dispatch).
  let rearmedToEdge = false;
  if (KO.wrap.style.display === 'none') {
    if (KO.player === 'kick') {
      if (KO.kickState && KO.kickState.state === 'Playing') { showKickLayer(); rearmedToEdge = true; }
      else fire(rectTick);
    } else if (KO.player === 'youtube') {
      if (KO.ytState && KO.ytState.ready && (KO.ytState.live || KO.ytHlsUrl)) showYtLayer();
      else fire(rectTick);
    } else {
      fire(rectTick);
    }
  }
  if (key === 'f') toggleOverlayFullscreen();
  else if (key === 'arrowleft') seekOverlayStep(-ARROW_SEEK_SEC);
  else if (key === 'arrowright' && !rearmedToEdge) seekOverlayStep(ARROW_SEEK_SEC);
}

function onOverlayKeydown(e) {
  const key = String(e.key).toLowerCase();
  const want = key === 'f' || key === 'arrowleft' || key === 'arrowright';
  if (!want || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const target = e.target;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (!KO.wrap || KO.player === 'twitch') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  dispatchOverlayKey(key);
}

function startWatchers() {
  KO.spaTimer = setInterval(() => {
    const p = location.pathname + '@' + location.hostname;
    if (p !== KO.lastPath) {
      KO.lastPath = p;
      fire(apply);
    }
  }, SPA_MS);
  KO.pollTimer = setInterval(() => {
    if (KO.enabled) fire(probe);
  }, POLL_MS);
  // The surface he is watching, sampled every second. Independent of `KO.wrap`
  // on purpose: `rectTick()` returns early when there is no overlay (a channel
  // with no kick mirror, or `player=twitch`), which is exactly the case where
  // "is the display live" needs an answer.
  if (!KO.dispTimer) KO.dispTimer = setInterval(dispSample, 1000);
  // The input/pause stamps the native recovery reasons about: a pause a human
  // caused and a pause the page caused look identical on the element.
  installNativeStamp();
  // The boot probe can race the Twitch player's start — re-probe the
  // moment the player starts playing, throttled. Video events don't
  // bubble; capture catches them.
  let lastPlayingProbe = 0;
  document.addEventListener(
    'playing',
    () => {
      if (!KO.enabled) return;
      const now = Date.now();
      if (now - lastPlayingProbe < 3000) return;
      lastPlayingProbe = now;
      fire(probe);
    },
    true,
  );
  document.addEventListener('keydown', onOverlayKeydown, true);
}

// The 400ms geometry tick alone makes a position:fixed overlay lag behind
// scrolling (it visibly "sticks" for up to RECT_MS). Re-run the same rect
// pass on the next animation frame after any scroll/resize; passive capture
// also catches Twitch's nested scroll containers.
function bindRectScroll() {
  if (KO.rectScrollBound) return;
  KO.rectScrollBound = true;
  const kick = () => {
    if (KO.rectScrollRaf) return;
    KO.rectScrollRaf = requestAnimationFrame(() => {
      KO.rectScrollRaf = 0;
      if (!KO.wrap || KO.player === 'twitch') return;
      try {
        rectTick();
      } catch {
        /* passive listener must never throw */
      }
    });
  };
  window.addEventListener('scroll', kick, { passive: true, capture: true });
  window.addEventListener('resize', kick, { passive: true });
}

function startRectLoop() {
  stopRectLoop();
  bindRectScroll();
  KO.rectTimer = setInterval(() => {
    try {
      rectTick();
    } catch (err) {
      // A per-tick crash would leave the wrap frozen at a stale rect (the
      // "mini player" symptom) — log it once and keep the loop alive.
      if (!KO.rectErrShown) {
        KO.rectErrShown = true;
        diag('rect_err', { m: String((err && err.message) || err).slice(0, 120) });
      }
    }
  }, RECT_MS);
}

// The <video> element rect jitters during boot/ad transitions (Twitch
// renders it at a transient smaller height — observed 1340x401 while the
// player card stayed 1340x751). The player CARD (.video-ref / the
// video-player wrapper) is layout-stable, so anchor the overlay to it;
// fall back to the video rect when no card is found (e.g. the video is a
// sidebar hover-preview).
function twitchAnchorRect() {
  const tv = twitchVideo();
  if (!tv) return null;
  let el = tv;
  for (let i = 0; i < 5 && el; i++) {
    const cls = (el.className || '').toString();
    if (cls.includes('video-ref') || cls.includes('video-player')) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : tv.getBoundingClientRect();
    }
    el = el.parentElement;
  }
  return tv.getBoundingClientRect();
}

// The host element the overlay must cover: YouTube's own player slot (our
// extension runs on the page, so we may measure its DOM) or the Twitch
// player card. Never probe the other host's DOM — a YT page has no twitch
// player and vice versa.
function rectFromHost() {
  if (!onYtHost()) return twitchAnchorRect();
  const el =
    document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

function rectTick() {
  if (!KO.wrap) {
    stopRectLoop();
    return;
  }
    ensureAttached(KO.wrap); // the host may re-render its layout root — re-parent if dropped
    const tv = onYtHost() ? null : twitchVideo();
    if (!onYtHost()) updateTwLiveSticky(tv);
    const overlaySelected = KO.player !== 'twitch' && !!KO.wrap;
    const overlayShown = overlaySelected && KO.wrap.style.display !== 'none';
    if (overlayShown) {
      // The SPA path poll is 900ms; do not spend that window mirroring a ghost
      // player over a route that has no player of ours (clips/videos/directory,
      // a YouTube channel page). Hide NOW; probe() tears the layer down.
      if (!overlayTargetRoute()) {
        hideWrap();
        enforceOverlayRendering(false);
        resumeTwitchIfOurs();
        return;
      }
      const pr = rectFromHost();
      if (pr) {
        const prev = KO.lastRect;
        const r = pr;
        // Do NOT clamp left/top to the viewport. This is a position:fixed
        // layer that mirrors the player's viewport rect: when the user
        // scrolls the player off-screen, top/left MUST go negative so the
        // overlay scrolls away with it. Clamping to 0 pinned the overlay to
        // the top of the viewport ("sticky overlay" bug). Width/height also
        // stay the player's real size; the browser clips at the viewport.
        const left = r.left;
        const top = r.top;
        const width = r.width;
        const height = r.height;
        KO.lastRect = { left, top, width, height };
        const s = KO.wrap.style;
        s.left = `${left}px`;
        s.top = `${top}px`;
        s.width = `${width}px`;
        s.height = `${height}px`;
        KO.wrap.classList.add('ko-placed');
        // One-shot anomaly dump: the applied rect and the rendered box
        // disagree (the "mini player" symptom) — capture the constraint
        // source. Rate-limited 30s; renders fresh ground truth.
        if (Math.abs(KO.wrap.offsetHeight - Math.round(r.height)) > 2 && r.height > 40) {
          if (!KO.rectFitAt || Date.now() - KO.rectFitAt > 30000) {
            KO.rectFitAt = Date.now();
            const cs = getComputedStyle(KO.wrap);
            let chain = [];
            let pel = KO.wrap.parentElement;
            for (let i = 0; i < 4 && pel; i++, pel = pel.parentElement) {
              const cr = pel.getBoundingClientRect();
              chain.push(pel.tagName + '.' + String(pel.className || '').split(' ')[0] + ' h=' + Math.round(cr.height) + ' ' + getComputedStyle(pel).position);
            }
            diag('rect_fit', {
              applied: { w: Math.round(r.width), h: Math.round(r.height) },
              box: { w: KO.wrap.offsetWidth, h: KO.wrap.offsetHeight },
              styleAttr: (KO.wrap.getAttribute('style') || '').slice(0, 160),
              csHeight: cs.height,
              csMaxH: cs.maxHeight,
              csPos: cs.position,
              wrapCount: document.querySelectorAll('#ko-wrap').length,
              parentChain: chain,
            });
          }
        }
        // Ground truth when the page video population is unusual (a second
        // visible video — hover preview, clips card — or a large shrink):
        // the wrap should mirror the picked card rect exactly.
        if (!KO.rectDiagAt || Date.now() - KO.rectDiagAt > 10000) {
          const all = [...document.querySelectorAll('video')]
            .filter((v) => v.getClientRects().length)
            .map((v) => {
              const rr = v.getBoundingClientRect();
              return { w: Math.round(rr.width), h: Math.round(rr.height), rs: v.readyState, p: v.paused };
            });
          if (all.length > 1 || (prev && r.height < prev.height * 0.7)) {
            KO.rectDiagAt = Date.now();
            diag('rect_pop', {
              picked: { w: Math.round(r.width), h: Math.round(r.height) },
              all,
              wrap: { w: Math.round(KO.wrap.offsetWidth), h: Math.round(KO.wrap.offsetHeight) },
            });
          }
        }
      } else if (KO.twDeleted) {
        // User deleted the Twitch player from the popup: keep the overlay
        // pinned at its last rect (the whole point is seeing the overlay
        // WITHOUT the Twitch player underneath). Re-apply the rect every
        // tick — the delete handler primes lastRect with the viewport when
        // no player rect was ever measured, so the wrap covers the page.
        if (!activeLayerLive()) {
          // Invariant (0.8.4): never displayed without a playable source for
          // the ACTIVE player — the stream is dead and Twitch is gone, so
          // hide and let the gray badge carry the state (<=400ms).
          hideWrap();
        } else {
          KO.hideTicks = 0;
          const lr = KO.lastRect;
          if (lr) {
            const s = KO.wrap.style;
            s.left = `${lr.left}px`;
            s.top = `${lr.top}px`;
            s.width = `${lr.width}px`;
            s.height = `${lr.height}px`;
            KO.wrap.classList.add('ko-placed');
          }
          if (KO.wrap.style.display === 'none') showWrap();
        }
      } else {
        // Debounce the hide: ad transitions / player re-layouts can briefly
        // drop the video from the tree — hiding on a single frame would blink.
        KO.hideTicks++;
        if (KO.hideTicks >= HIDE_TICKS) hideWrap();
      }
      enforceOverlayRendering(true);
      syncMute();
      updateKickBar();
      // Stall watchdog: kick stream frozen >8s while shown, visible, and
      // playing — IVS tokens can go stale silently (no error event). Force
      // a fresh playback_url via the normal reconnect budget. Hidden tabs
      // throttle the frame's 1s state timer, so frozen pos there is NOT a
      // stall (the stream keeps playing under the muted-audio exemption).
      // A SOURCE SWITCH IN FLIGHT IS NOT A STALL. Measured 2026-11-13 (0.8.88):
      // the go-live mint landed 460 ms after the click, the frame took ~10 s to
      // apply it, and this watchdog fired at 9.8 s on the OLD state (pos frozen
      // at the replay offset) — three reconnects and a teardown for a load that
      // was already working. The same grace probe() honours (`kickUrlT`, 25 s).
      const urlFresh = !!(KO.kickUrlT && Date.now() - KO.kickUrlT < KICK_GRACE_MS);
      if (!document.hidden && !urlFresh && KO.player === 'kick' && KO.kickState && KO.kickState.state === 'Playing') {
        const t = KO.kickState.pos || 0;
        if (Math.abs(t - KO.lastTickT) < 0.05) {
          KO.stallTicks++;
        } else {
          KO.stallTicks = 0;
          KO.lastTickT = t;
        }
        if (KO.stallTicks > 20) {
          KO.stallTicks = 0;
          if (KO.reconnectCount < MAX_RECONNECT) {
            console.log('[ko] kick stalled (8s frozen) — reconnecting');
            diag('stall', { ct: Math.floor(t) });
            reconnect();
          }
        }
      }
      // Frame-death watchdog: the bridge went silent while shown. Rebuild
      // the frame (same url — IVS reloads it). Hidden tabs throttle the
      // frame's 1s state timer, so only run while the tab is visible.
      if (!document.hidden && KO.player === 'kick' && KO.kickFrame && KO.lastKickSt && Date.now() - KO.lastKickSt > 30000) {
        console.log('[ko] kick bridge silent — rebuilding frame');
        diag('kick-frame-rebuild', { why: 'silent', silentMs: Date.now() - KO.lastKickSt, player: KO.player });
        KO.kickFrame.remove();
        KO.kickFrame = null;
        KO.kickWin = null;
        KO.kickReady = false;
        KO.kickState = null;
        KO.kickOnDvr = false;
        if (KO.wrap) KO.wrap.classList.add('ko-offline');
        KO.pendingUrl = KO.activeUrl;
        kickFrame();
      }
      // yt frame-death watchdog (mirror of the kick one): the bridge went
      // silent while shown. Remove #ko-yt and reset the ready state — the
      // next probe recreates the frame. Hidden tabs throttle the frame's
      // 1s state timer, so only run while the tab is visible.
      if (!document.hidden && KO.player === 'youtube' && KO.ytState.ready && KO.lastYtSt && Date.now() - KO.lastYtSt > 30000) {
        console.log('[ko] yt bridge silent — rebuilding frame');
        diag('yt-frame-rebuild', { why: 'silent', silentMs: Date.now() - KO.lastYtSt, player: KO.player });
        const yf = document.getElementById('ko-yt');
        if (yf) yf.remove();
        KO.ytState = freshYtState();
        KO.ytWin = null;
        KO.lastYtSt = 0;
        fire(probe); // recreate now instead of waiting for the 20s poll
      }
    } else if (overlaySelected) {
      // The overlay player is selected but its bar is not painted. Hand the
      // picture back ONLY when the layer has no picture of its own (a failed or
      // offline layer must not leave the user staring at a frozen surface), never
      // because the native element blinked out: resuming every time the bar
      // hides is the exact loop the owner reported - "o player vem, fica em
      // tempo real, ai o player da twitch volta, e segundos depois o outro
      // player volta de novo, segundos atras ... e fica a 360p" (2026-11-11).
      enforceOverlayRendering(false);
      syncMute();
      // The SAME ownership predicate syncMute pauses with: resuming on the raw
      // picture while syncMute paused on the hysteresis made one tick pause and
      // resume the native, which is what "deixou pausado e desmutado" looks like
      // from the seat (2026-11-12).
      if (!KO.twDeleted && !document.hidden && !overlayOwnsPicture() && !coldHoldActive()) resumeTwitchIfOurs();
    } else {
      enforceOverlayRendering(false);
      if (!document.hidden) resumeTwitchIfOurs();
      syncMute();
    }
}

function stopRectLoop() {
  if (KO.rectTimer) {
    clearInterval(KO.rectTimer);
    KO.rectTimer = null;
  }
}

function injectStyles() {
  if (document.getElementById('ko-style')) return;
  const st = document.createElement('style');
  st.id = 'ko-style';
  st.textContent =
    '#ko-wrap{position:fixed;z-index:5;pointer-events:none;background:#000;overflow:hidden;visibility:hidden;}' +
    // Only a wrap that has been placed by the rect loop may paint: a mounted
    // wrap has no left/top/width/height yet and would otherwise render at the
    // top of its container (the "player fixed at the top of the page" look).
    '#ko-wrap.ko-placed{visibility:visible;}' +
    '#ko-wrap #ko-ivs{width:100%;height:100%;border:0;display:block;pointer-events:none;}' +
    '#ko-wrap.ko-kick #ko-yt{display:none;}' + // one rendering: the inactive player is hidden, not covered
    '#ko-wrap.ko-yt #ko-ivs{display:none;}' +
    '#ko-wrap.ko-yt iframe{width:100%;height:100%;border:0;display:block;pointer-events:auto;}' +
    '#ko-bar{position:absolute;left:0;right:0;bottom:0;pointer-events:auto;opacity:1;transition:opacity .18s ease;' +
    'display:flex;flex-direction:row;align-items:center;justify-content:space-between;padding:22px 10px 6px;color:#fff;' +
    'background:linear-gradient(0deg,rgba(0,0,0,.8),rgba(0,0,0,0));' +
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
    '#ko-wrap:not(.ko-hot):not(.ko-hot-lock) #ko-bar{opacity:0;pointer-events:none;}' +
    '#ko-wrap.ko-yt #ko-bar{display:flex;}' +
    '#ko-reconnecting{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,.82);color:#fff;font:700 15px system-ui,sans-serif;letter-spacing:.04em;pointer-events:none;}' +
    '.ko-g{display:flex;flex-direction:row;align-items:center;}' +
    '#ko-quality-wrap{position:relative;display:flex;align-items:center;}' +
    '#ko-quality-menu{display:none;position:absolute;right:0;bottom:42px;min-width:110px;padding:4px;' +
    'flex-direction:column;background:rgba(17,17,17,.96);border:1px solid rgba(255,255,255,.2);border-radius:6px;z-index:3;}' +
    '#ko-quality-wrap.ko-open #ko-quality-menu{display:flex;}' +
    '#ko-quality-menu button{display:block;width:100%;padding:7px 10px;border:0;background:transparent;color:#fff;' +
    'font:600 12px system-ui,sans-serif;text-align:left;cursor:pointer;border-radius:4px;}' +
    '#ko-quality-menu button:hover{background:rgba(255,255,255,.12);}' +
    '#ko-g1{gap:2px;}' +
    '.ko-icn{background:transparent;border:0;color:#fff;cursor:pointer;display:flex;align-items:center;' +
    'justify-content:center;width:40px;height:40px;border-radius:8px;padding:0;}' +
    '.ko-icn:hover{background:rgba(255,255,255,.1);}' +
    '.ko-icn svg{width:22px;height:22px;display:block;}' +
    '.ko-t{font-size:12px;font-weight:700;white-space:nowrap;color:#fff;font-variant-numeric:tabular-nums;}' +
    '#ko-g1 .ko-t{padding:0 6px;}' +
    '.ko-sep{opacity:.6;}' +
    '#ko-volwrap{position:relative;display:flex;align-items:center;height:40px;}' +
    '#ko-vols{display:none;position:absolute;left:100%;top:0;height:100%;align-items:center;' +
    'width:100px;padding:0 4px;cursor:pointer;}' +
    '#ko-volwrap:hover #ko-vols{display:flex;}' +
    '#ko-voltrack{position:relative;width:100%;height:3px;border-radius:999px;background:#24272c;}' +
    '#ko-volfill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:#fff;}' +
    '#ko-volthumb{position:absolute;top:50%;width:16px;height:16px;border-radius:10px;background:#fff;' +
    'transform:translate(-50%,-50%);box-shadow:0 1px 3px rgba(0,0,0,.4);}' +
    '#ko-seekbar{position:absolute;top:6px;left:10px;right:10px;height:14px;cursor:pointer;touch-action:none;}' +
    '#ko-track{position:absolute;left:0;right:0;bottom:0;height:4px;border-radius:2px;background:rgba(146,158,166,.5);}' +
    '#ko-seekbar:hover #ko-track{height:6px;bottom:-1px;}' +
    '#ko-fill{position:absolute;left:0;top:0;bottom:0;background:#53fc18;border-radius:2px;}' +
    '#ko-wrap.ko-yt #ko-fill{background:#ff0000;}' +
    '.ko-prog{position:absolute;left:0;right:0;bottom:0;height:4px;transform-origin:left;}' +
    '#ko-loaded{background:rgba(255,255,255,.5);}' +
    '#ko-loadind{background:rgba(255,255,255,.3);}' +
    '#ko-thumb{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;background:#53fc18;' +
    'transform:translate(-50%,-50%);display:none;}' +
    '#ko-wrap.ko-yt #ko-thumb{background:#ff0000;}' +
    '#ko-seekbar:hover #ko-thumb,#ko-seekbar.ko-drag #ko-thumb{display:block;}' +
    '#ko-hov{position:absolute;top:-20px;left:0;transform:translateX(-50%);background:rgba(0,0,0,.78);' +
    'border-radius:6px;padding:4px 6px;font-size:12px;font-weight:700;color:#fff;' +
    'font-variant-numeric:tabular-nums;white-space:nowrap;display:none;pointer-events:none;z-index:2;}' +
    '#ko-golive{display:none;position:absolute;right:54px;top:32px;background:#e60000;border:0;color:#fff;' +
    'font:700 12px system-ui,sans-serif;letter-spacing:.03em;padding:6px 12px;border-radius:999px;' +
    'cursor:pointer;z-index:6;pointer-events:auto;}' +
    '#ko-golive:hover{background:#f02222;}' +
    '#ko-golive.ko-show{display:block;}';
  (document.head || document.documentElement).appendChild(st);
}

// ---- popup actions ----------------------------------------------------------
// ko-delete-twitch: remove the native Twitch player element so the user can
// SEE that the visible video is the overlay's, not Twitch's. Restored on
// page reload (Twitch rebuilds its player). The overlay stays pinned at the
// last player rect. Twitch's SPA re-renders the player element, so while a
// non-twitch layer is active a MutationObserver re-applies the delete.
let twDeleteObserver = null;

function killTwitchVideo(v) {
  if (!v) return;
  try {
    v.pause();
  } catch {
    /* already gone */
  }
  try {
    v.remove();
  } catch {
    /* already gone */
  }
}

function ensureTwDeleteObserver() {
  if (twDeleteObserver) return;
  twDeleteObserver = new MutationObserver((muts) => {
    // Only re-apply while an overlay layer is active — in twitch mode the
    // user explicitly chose the native player (their problem if it is gone).
    if (!KO.twDeleted || KO.player === 'twitch') return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!n || n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO') {
          killTwitchVideo(n);
          continue;
        }
        // Re-renders may wrap the player — scan the added subtree shallowly.
        if (n.querySelectorAll) {
          for (const v of n.querySelectorAll('video')) killTwitchVideo(v);
        }
      }
    }
  });
  twDeleteObserver.observe(document.body, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'ko-delete-twitch') {
    KO.twDeleted = true;
    const v = twitchVideo();
    if (v) killTwitchVideo(v);
    // Twitch SPA re-renders the player element — re-apply the delete while a
    // non-twitch layer is active (the observer survives the element swap).
    ensureTwDeleteObserver();
    // Prime the pin: when no player rect was ever measured (deleted before
    // the first tick), the overlay covers the whole page instead of floating.
    if (!KO.lastRect) {
      const ar = twitchAnchorRect();
      if (ar && ar.width > 0 && ar.height > 0) {
        KO.lastRect = { left: ar.left, top: ar.top, width: ar.width, height: ar.height };
      }
    }
    // The point of the button is SEEING the overlay without the Twitch
    // player — if the current player is 'twitch' the overlay would stay
    // hidden and the click would look dead. Force an overlay player on.
    if (KO.player === 'twitch') {
      KO.player = 'kick';
      saveState(true);
    }
    // Youtube layer not shown (mint pending/failed)? Keep the wrap visible
    // in its loading state instead of hiding — the badge reports YT…/YT ✕
    // and the black layer covers the deleted player slot (probe()'s hide
    // sites respect twDeleted via hideWrapForProbe()).
    if (KO.player === 'youtube' && KO.wrap && KO.wrap.style.display === 'none') {
      if (KO.lastRect) {
        const s = KO.wrap.style;
        s.left = `${KO.lastRect.left}px`;
        s.top = `${KO.lastRect.top}px`;
        s.width = `${KO.lastRect.width}px`;
        s.height = `${KO.lastRect.height}px`;
      }
      showWrap();
    }
    apply();
    diag('tw_delete', {});
    sendResponse({ ok: true });
  }
});

// ---- test / automation hook -------------------------------------------------
// to flip the toggle or remap the current channel (used by smoke tests).
window.addEventListener('kick-overlay:set', (e) => {
  const d = e.detail || {};
  if (typeof d.enabled === 'boolean') {
    KO.enabled = d.enabled;
    saveState().then(() => fire(apply));
  }
  if (d.kickSlug && KO.slug) {
    const m = KO.mappings[KO.slug];
    KO.mappings[KO.slug] = typeof m === 'object' ? { ...m, kick: d.kickSlug } : { kick: d.kickSlug };
    KO.kickSlug = d.kickSlug;
    saveState().then(() => fire(apply));
  }
  if (d.ytChannel && KO.slug) {
    const m = KO.mappings[KO.slug];
    KO.mappings[KO.slug] = typeof m === 'object' ? { ...m, yt: d.ytChannel } : { yt: d.ytChannel };
    KO.ytRaw = d.ytChannel;
    KO.ytId = null;
    saveState().then(() => fire(apply));
  }
  if (d.player === 'kick' || d.player === 'youtube' || d.player === 'twitch') {
    // Round-trip through storage exactly like the popup does — the flip then
    // arrives via chrome.storage.onChanged, so this hook proves the real path.
    KO.player = d.player;
    if (d.player === 'youtube') { KO.ytHlsFailed = false; KO.ytHlsFailedAt = 0; }
    saveState(true).then(() => fire(apply));
  }
});
window.addEventListener('kick-overlay:status', () => {
  const v = twitchVideo();
  window.dispatchEvent(
    new CustomEvent('kick-overlay:status-reply', {
      detail: {
        enabled: KO.enabled,
        player: KO.player,
        slug: KO.slug,
        kickSlug: KO.kickSlug,
        ytRaw: KO.ytRaw,
        ytId: KO.ytId,
        mounted: !!KO.wrap,
        wrapShown: !!(KO.wrap && KO.wrap.style.display !== 'none'),
        kickPlaying: !!(KO.kickState && KO.kickState.state === 'Playing' && (KO.kickState.pos || 0) > 0),
        kickMuted: KO.kickMuted,
        yt: { ...KO.ytState },
        twitchLive: KO.twLive,
        twitchPlaying: twitchIsLive(v),
        twitchPausedByUs: KO.twWasPlaying,
        twitchMuted: [...document.querySelectorAll('video')].every((x) => x.muted),
        // --- additive (0.8.2): host routing + instant-switch identity ----
        host: KO.host,
        ytPageId: KO.ytPageId,
        ytPageVia: (KO.ytPageTarget && KO.ytPageTarget.via) || null,
        frameSeq: KO.frameSeq,
        wrapClasses: KO.wrap ? String(KO.wrap.className || '') : null,
        kickFrameConnected: !!(KO.kickFrame && KO.kickFrame.isConnected),
        ytFrameConnected: !!(KO.wrap && KO.wrap.querySelector('#ko-yt')),
        kickLevels: (KO.kickState && KO.kickState.qualities) || [],
        ytLevels: (KO.ytState && KO.ytState.qualities) || [],
      },
    }),
  );
});

// ---- boot -------------------------------------------------------------------

// document_start is what makes the cold-open swap fast (owner 2026-11-11:
// "anuncio ficou por uns 3 ou 4 segundos ate trocar de player. e pra ser
// instantaneo"). Measured with content.js at document_idle: the script began
// 1135 ms after navigation, the mint took 200 ms, and the first IVS picture
// arrived 2757 ms in - so 1.1 s of that 2.8 s was the browser simply not
// running us yet. Everything that needs the DOM waits here instead of the
// whole script waiting for the browser.
function domReady() {
  if (document.readyState !== 'loading' && document.body) return Promise.resolve();
  return new Promise((res) => {
    document.addEventListener('DOMContentLoaded', () => res(), { once: true });
  });
}

// Heartbeat: full overlay state every 8s. A HEADLESS RE-RUN OF IT IS THE ARM
// (`koHbTick`), because a `setInterval` inside `init()` is unreachable from the
// suite: the module is evaluated, never booted, so the one tick that has to ask
// "is this page still running the code that is installed" could not be driven.
const koHbTick = () => {
  const tv = twitchVideo();
  // A TAB THAT WAS ALREADY HIDDEN WHEN THE UPDATE LANDED NEVER SAW AN EDGE.
  // `recoverStale()` runs at boot and on `visibilitychange`, and a
  // visibilitychange only fires when visibility CHANGES - so the tab the owner
  // leaves in the background is exactly the one that never re-checks, which is
  // the opposite of the intent (hidden is the only state it may heal in).
  // Measured 2026-11-19: his `ko.adlog` carried `boot {version:"0.8.104"}` and
  // `hb {ver:"0.8.104"}` for 226 s while the installed manifest was 0.8.106,
  // every heartbeat `hidden:true`. The heartbeat is the tick that already runs
  // on the page's own clock, so it asks the same question - the same predicate,
  // not a second one - and `recoverStale` keeps both guards (one reload per
  // version, hidden tabs only).
  recoverStale();
  diag('hb', {
    ver: KO_VER,
    slug: KO.slug,
    player: KO.player,
    wrapShown: !!(KO.wrap && KO.wrap.style.display !== 'none'),
    hidden: document.hidden,
    focused: document.hasFocus(),
    tw: tv
      ? { rs: tv.readyState, paused: tv.paused, ct: Math.floor(tv.currentTime || 0), muted: tv.muted, err: tv.error ? tv.error.code : 0 }
      : null,
    kick: KO.kickState
      ? {
          state: KO.kickState.state,
          paused: KO.kickState.paused,
          ct: Math.floor(KO.kickState.pos || 0),
          muted: KO.kickState.muted,
          q: (KO.kickState.q && KO.kickState.q.name) || '',
          err: 0,
        }
      : null,
    yt: { ...KO.ytState },
    twLive: KO.twLive,
    bar: KO.wrap
      ? {
          mode: KO.kickOnDvr ? 'dvr' : 'live',
          cur: (KO.wrap.querySelector('#ko-cur') || {}).textContent || '',
          total: (KO.wrap.querySelector('#ko-total') || {}).textContent || '',
          fillPct: Math.round(parseFloat((KO.wrap.querySelector('#ko-fill') || {}).style?.width || '0')),
          vol: Math.round(((KO.kickMuted || KO.kickVol === 0) ? 0 : KO.kickVol) * 100),
          dur: Math.round(KO.kickDur || 0),
          hot: KO.wrap.classList.contains('ko-hot'),
        }
      : null,
    wr: KO.wrap ? { w: Math.round(KO.wrap.offsetWidth), h: Math.round(KO.wrap.offsetHeight) } : null,
    vr: tv ? { w: Math.round(tv.getBoundingClientRect().width), h: Math.round(tv.getBoundingClientRect().height) } : null,
  });
};

(async function init() {
  // Navigation -> this line is the floor of the cold-open swap: at
  // document_idle it is where the mint can first start (owner 2026-11-11).
  KO.bootAt = typeof performance !== 'undefined' ? Math.round(performance.now()) : 0;
  listenAudioLog();
  audioBoot(); // surfaces + intent store must exist before the first state load
  await loadState();
  // URL-param setup (?koyt=<yt channel>&kokick=<slug>&koplayer=<player>):
  // write this channel's mapping by opening a twitch URL — no popup clicks
  // needed (used to pre-configure channels, e.g. jb_sniper→JBSniperPRIME).
  const qp = new URLSearchParams(location.search);
  const qYt = qp.get('koyt');
  const qKick = qp.get('kokick');
  const qPlayer = qp.get('koplayer');
  const setupSlug = currentSlug(); // KO.slug is still null at init
  if (setupSlug && !onYtHost() && (qYt || qKick || qPlayer)) {
    const m = KO.mappings[setupSlug];
    // legacy mappings can be a plain string (mappings[slug] = 'foo'); keep it
    const base = typeof m === 'string' ? { kick: m } : m && typeof m === 'object' ? { ...m } : { kick: setupSlug };
    if (qKick) base.kick = qKick.toLowerCase();
    if (qYt) {
      base.yt = qYt;
      delete base.ytId;
    }
    if (qYt || qKick) {
      KO.mappings[setupSlug] = base;
      KO.kickSlug = (qKick || base.kick || setupSlug).toLowerCase();
      KO.ytRaw = qYt || base.yt || '';
      KO.ytId = null;
    }
    if (qPlayer && ['kick', 'youtube', 'twitch'].includes(qPlayer)) KO.player = qPlayer;
    saveState(Boolean(qPlayer)).then(() => fire(apply));
  }
  // Persist the resolved defaults (enabled: true) so the popup's toggle
  // always agrees with the content script.
  if (Object.keys(KO.mappings).length === 0) {
    await saveState();
  }
  // Storage is loaded (the player preference is known NOW); the mint and the
  // frame need the DOM, and the mint needs only the slug. Start it in parallel
  // with the parse so the 200 ms API round trip is already done when the body
  // appears.
  if (KO.player !== 'twitch' && !onYtHost()) {
    const preSlug = KO.kickSlug || currentSlug();
    if (preSlug) {
      KO.kickPrewarmSlug = preSlug;
      KO.kickPrewarm = kickPlaybackUrl(preSlug).catch(() => null);
    }
  }
  await domReady();
  injectStyles();
  startWatchers();
  diag('boot', { ver: KO_VER, url: location.href.slice(0, 70), slug: currentSlug(), enabled: KO.enabled, player: KO.player, kickSlug: KO.kickSlug, hidden: document.hidden });
  recoverStale();
  document.addEventListener('visibilitychange', () => recoverStale(), true);
  try {
    document.addEventListener('visibilitychange', () => visAudio('visibility'), true);
    // THE ALT-TAB BOUNDARY. Owner 2026-11-12: *"ta pausando ou parando quando to
    // alt tab. quando eu volto pra live do alt tab, ele tenta fazer algo no
    // player, o player trava, e tenho q reiniciar a pagina ou clicar em pause
    // despause"*. A hidden tab throttles the frame's 1 s state timer to about
    // once a minute, so on return EVERY timestamp is older than the watchdog's
    // 30 s: the first tick after the alt-tab tore the IVS player down and rebuilt
    // it, which is the freeze he then had to cure by hand. A gap spent HIDDEN is
    // not evidence of anything, so the clocks restart at the boundary and the
    // ownership decided before hiding survives until fresh samples arrive.
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) return;
        KO.lastKickSt = 0;
        KO.lastYtSt = 0;
        KO.stallTicks = 0;
        KO.hideTicks = 0;
        // A PAUSE STAMPED WHILE HIDDEN IS ABOUT THE OLD TAB, NOT THIS ELEMENT.
        // `nativeStallWatch` refuses a pause whose stamp says `hidden:true`, and
        // it is right to: a throttled tab pauses everything, so that pause is no
        // evidence of a stall. But the stamp is written once by the `pause`
        // listener and nothing cleared it, so ONE background pause disqualified
        // the element for the rest of the page load - the watchdog took the early
        // return on every later sample and the picture never came back without a
        // hand pause/play. His ring (0.8.101, twitch.tv/alanzoka):
        // `video-pause {..., "hidden":true}`, then 70+ s of `hb {ct:2511,
        // paused:true, rs:1}` with no recovery row of any kind.
        // Only the hidden FLAG is cleared, never the record: `at`/`ct`/`rs` are
        // what lets the watchdog judge this element at all, and `now - p.at <
        // NATIVE_STALL_MS` is what still gives the page its own beat before we
        // touch a picture the user is watching.
        if (KO.natPause) KO.natPause.hidden = false;
        if (KO.ownerAttr) {
          KO.picSeenAt = Date.now();
          KO.picLostAt = 0;
        }
        diag('visible', { player: KO.player, own: KO.ownerAttr || null, cold: coldHoldActive() });
        fire(rectTick);
      },
      true,
    );
  } catch {
    /* a diag listener must never break boot */
  }
  setInterval(koHbTick, 8000);
  fire(apply);
})().catch((e) => diag('guard', { err: String((e && e.message) || e).slice(0, 120) }));
