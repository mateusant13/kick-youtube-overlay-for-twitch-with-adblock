#!/usr/bin/env node
// ko-replica — a local, deterministic Twitch watch page plus the four HTTP
// surfaces the extension actually consumes:
//
//   gql.twitch.tv/gql ................ PlaybackAccessToken (value = JSON token)
//   usher.ttvnw.net/api/v2/channel/hls/<ch>.m3u8 ... master, one variant
//   video-edge-a.playlist.ttvnw.net/v1/playlist/<name>.m3u8 ... media playlist
//   video-edge-a.playlist.ttvnw.net/v1/segment/<file> ..... fMP4 bytes
//
// Chrome reaches all of them through --host-resolver-rules (see run.mjs), so
// the page URL stays https://www.twitch.tv/<channel> and the real content
// scripts, host permissions and Worker hook apply unchanged.
//
// What is faithful (measured Twitch behaviour recorded in AGENTS.md):
//   - content segments carry the ",live" suffix; stitched ad segments do not,
//     with EXT-X-DATERANGE CLASS="twitch-stitched-ad" + X-TV-TWITCH-AD-URL;
//   - autoplay/android tokens stay CLEAN during SSAI, web/popout tokens are
//     ad-bearing (that asymmetry is what the clean ladder relies on);
//   - the page's player fetches its playlists from a blob: Worker, so the
//     extension's patched self.fetch sees every playlist;
//   - the ad DOM shapes are the ones measured on the owner's page: a painted
//     stream-display-ad wrapper, a countdown label, and the slate sentence.
//
// What is deliberately simplified (named, not hidden): the ad is a solid blue
// program instead of Twitch's creative, and MSE runs in a dedicated Worker
// (MediaSourceHandle) rather than Twitch's exact player. Neither is a signal
// the extension consumes.
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureCerts } from './certs.mjs';
import { ensureMedia, RUNGS, PROGRAM_SECONDS } from './media.mjs';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
};

const PORT = Number(argOf('port', 8443));
const SCENARIO_PATH = argOf('scenario', '');
const MEDIA_DIR = process.env.KO_REPLICA_MEDIA || 'G:/Temp/ko-replica/media';
const CERT_DIR = process.env.KO_REPLICA_CERTS || 'G:/Temp/ko-replica/certs';
const PAGE_DIR = join(import.meta.dirname, 'page');

const scenario = SCENARIO_PATH ? JSON.parse(readFileSync(SCENARIO_PATH, 'utf8')) : {
  name: 'adhoc', channel: 'replicach', events: [], durationMs: 30000,
};
const CHANNEL = scenario.channel || 'replicach';

// ---- runtime state --------------------------------------------------------
const state = {
  t0: 0,                 // first page GET on www
  pod: 0,                // off -> on transitions, keys ad segment URIs
  lastPod: null,
  requests: [],          // route hits, bounded
  hits: {},              // event-at -> first hit time
};
const now = () => (state.t0 ? Date.now() - state.t0 : 0);
function note(hit) {
  if (state.requests.length < 400) state.requests.push({ ...hit, t: now() });
}

// The first scenario event keyed by its `at`, so a missing event is visible.
function activeEvent(t) {
  for (const ev of scenario.events || []) {
    if (t >= ev.at && t < ev.at + (ev.ms || 0)) return ev;
  }
  return null;
}

function pageLoaded() {
  // Every page GET starts a new episode: the scenario timeline is relative to
  // the load, and a second probe against a long-lived server must not inherit
  // the previous run's clock (measured: content index ran into the hundreds
  // and every segment landed at a scattered offset).
  state.t0 = Date.now();
  state.pod = 0;
  state.requests.length = 0;
  state.hits = {};
}

// ---- playlists ------------------------------------------------------------
const pad = (n) => String(n).padStart(3, '0');
const SEG = Number(process.env.KO_REPLICA_SEG || 2);
const CONTENT_SEGS = Math.round(PROGRAM_SECONDS.content / SEG);
const AD_SEGS = Math.round(PROGRAM_SECONDS.ad / SEG);
const EDGE = 'https://video-edge-a.playlist.ttvnw.net';

function tokenFor(playerType, platform) {
  return JSON.stringify({
    player_type: playerType || 'site',
    platform: platform || 'web',
    channel: CHANNEL,
    show_ads: true,
    server_ads: true,
    hide_ads: false,
    adblock: false,
    user_id: 1,
  });
}

// The measured asymmetry: autoplay/android is clean during SSAI.
function isCleanToken(playerType, platform) {
  const pt = String(playerType || '').toLowerCase();
  const pf = String(platform || '').toLowerCase();
  return pt === 'autoplay' || (pt === 'mobile' && pf === 'android');
}

// A CHANNEL THAT HAS BEEN LIVE FOR A WHILE, because that is the page the owner
// loads. This used to be 4, which made the first window an EVENT playlist so
// hls.js joined at its OLDEST segment and buffered the whole window -- a state
// real Twitch never has at a page load, kept because it was the only way the
// clean frame cleared the extension's 3 s health gate. That trade is the
// defect: a fixture arranged to pass a gate hides a product that cannot pass it
// (his own ring: reveal 11.0 s after the ad was detected, `q:"360p"`,
// `stall-stop hist:[4/3 4/1.01 4/0.99]`). The window now slides from the first
// request and the frame lives where Twitch's live player lives.
const PREROLL_SEGS = 40;
function contentIndex(t) {
  return PREROLL_SEGS + Math.floor(Math.max(0, t) / (SEG * 1000));
}

// Media lines carry no per-segment MAP: a live window is one continuous
// fragment stream with a single init at its head. The first measurement with a
// MAP + discontinuity before EVERY segment made hls.js anchor the live window
// at its first fragment (pos 0.1, 1.9 s of runway, never healthy), so the seam
// is declared only where a different program actually starts: the ad block.
function segLine(kind, k, query, dur, v = 720) {
  const idx = k % (kind === 'content' ? CONTENT_SEGS : AD_SEGS);
  const tag = kind === 'content' ? ',live' : ',';
  const d = Number.isFinite(dur) ? Number(dur).toFixed(3) : `${SEG}.000`;
  return `#EXTINF:${d}${tag}\n${EDGE}/v1/segment/${kind}_${v}_${pad(idx)}.m4s${query || ''}`;
}

// A live ad window slides like the content one: a static all-ad playlist never
// grows, so hls.js dedupes every refresh by URL and the native sits at ct 0
// (measured: `ad-tick {ct:0, rs:1}` for a 9 s pod, no dash ever appended).
// `base` is the pod's own segment clock; the window is the last few plus one
// published ahead, exactly like content.
const AD_WINDOW_BACK = 6;
function adBase(t, ev) {
  return Math.max(0, Math.floor(Math.max(0, t - ev.at) / (SEG * 1000)));
}
function adLines(pod, base, v = 720) {
  const last = Math.min(base, AD_SEGS - 1);
  const from = Math.max(0, last - AD_WINDOW_BACK);
  const count = last - from + 1;
  const out = [
    '#EXT-X-MEDIA-SEQUENCE:' + from,
    '#EXT-X-DATERANGE:ID="twitch-stitched-ad-' + pod + '",CLASS="twitch-stitched-ad",START-DATE="2026-11-25T00:00:00.000Z",DURATION=' + (count * SEG) + '.000,X-TV-TWITCH-AD-URL="https://ads.example/creative/' + pod + '"',
    '#EXT-X-TWITCH-PREFETCH:https://video-edge-a.playlist.ttvnw.net/v1/segment/ad_' + v + '_000.m4s',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-MAP:URI="/v1/segment/ad_' + v + '_init.mp4"',
  ];
  // The URI must identify the MEDIA, not the window slot: `&k=` made the same
  // file a new URL on every window step, so the player appended the ad block
  // twelve times over 4 s (measured 2026-11-25: `ct 1.43 -> 24.41` in two
  // seconds, ad blue then content while the pod was still live).
  for (let k = from; k <= last; k++) out.push(segLine('ad', k, `?pod=${pod}`, undefined, v));
  return { lines: out, from };
}

// A playlist is a pure function of (clean, token type, wall clock, pod). No
// per-client state: the native worker and the clean iframe fetch the same URL
// and each one appends what it has not seen.
function mediaPlaylist({ clean, t, pod, v = 720 }) {
  const ev = activeEvent(t);
  const adOn = !clean && !!ev;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-INDEPENDENT-SEGMENTS'];
  const i = contentIndex(t);

  if (adOn && ev.kind === 'preroll') {
    // A cold preroll is an ALL-AD playlist: no content segment exists yet.
    lines.push(...adLines(pod, adBase(t, ev), v).lines);
    return lines.join('\n') + '\n';
  }

  // Twitch's live window is minutes long. A 5-segment window left the clean
  // frame one segment ahead of its own playhead; 21 segments gives hls.js the
  // runway HEALTH_BUFFER_SEC measures.
  // The window must be SHORTER than the media program: a window that wraps
  // past CONTENT_SEGS repeats one file URI inside a single playlist, and
  // hls.js dedupes fragments by URL, which left the frame with a fragment list
  // it could not append ahead (measured: playhead drained to rs=2 while the
  // playlist kept refreshing).
  // NOTHING IS PUBLISHED AHEAD OF THE WALL CLOCK, and this is the correction
  // that makes the replica able to fail. It used to list `i + 2` with the
  // newest segment at 0.8x EXTINF, justified by "a real edge lists the segment
  // still being produced". That is not how a live origin behaves (a fragment
  // appears in the playlist when it is complete, with its full duration) and it
  // was there for one reason, in its own words: so the forward buffer cleared
  // the extension's 3 s gate. A fixture tuned to the gate cannot report the
  // gate's cost, and the cost is the owner's report: reveal 11.0 s after the ad
  // was detected, `q:"360p"`, `stall-stop hist:[4/3 4/1.01 4/0.99]`.
  // `KO_REPLICA_EDGE_AHEAD=N` re-adds the cheat as an explicitly labelled knob
  // for an A/B; measured runs keep it at 0.
  const ahead = Number(process.env.KO_REPLICA_EDGE_AHEAD || 0) || 0;
  const from = Math.max(0, i - 12);
  // A window that still starts at the first segment is an EVENT window (the
  // stream just began) and hls.js starts at its oldest fragment; once it slides
  // it is an ordinary live window.
  if (from === 0) lines.push('#EXT-X-PLAYLIST-TYPE:EVENT');
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${from}`);
  lines.push('#EXT-X-MAP:URI="/v1/segment/content_' + v + '_init.mp4"');
  for (let k = from; k <= i + ahead; k++) lines.push(segLine('content', k, null, undefined, v));
  if (adOn) {
    lines.push(...adLines(pod, adBase(t, ev), v).lines);
  }
  return lines.join('\n') + '\n';
}

// A LADDER, because one variant makes `q` a constant and every quality defect
// invisible: the owner's ring reveals the clean player at `q:"360p"` twice on a
// 1280x720 page, and a single-rung master could not represent that pick at all.
function masterFor(playerType, platform) {
  const clean = isCleanToken(playerType, platform) ? 1 : 0;
  const pt = encodeURIComponent(playerType || '');
  const out = ['#EXTM3U', '#EXT-X-VERSION:7'];
  for (const r of RUNGS) {
    out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bw},RESOLUTION=${r.w}x${r.h},CODECS="avc1.4d401f"`);
    out.push(`${EDGE}/v1/playlist/live.m3u8?clean=${clean}&pt=${pt}&v=${r.v}`);
  }
  return out.join('\n') + '\n';
}

// ---- page assets ----------------------------------------------------------
const readPage = (f) => readFileSync(join(PAGE_DIR, f), 'utf8');

function pageStatus() {
  const t = now();
  const ev = activeEvent(t) || {};
  const ui = ev.ui || 'none';
  let label = '';
  if (ui === 'countdown') label = `Anúncio (0:${String(Math.max(0, Math.ceil((ev.at + (ev.ms || 0) - t) / 1000))).padStart(2, '0')})`;
  if (ui === 'slate') label = `${CHANNEL} está fazendo um intervalo comercial…`;
  return {
    name: scenario.name,
    channel: CHANNEL,
    t,
    ad: !!activeEvent(t),
    kind: ev.kind || null,
    ui,
    label,
    mutedAtStart: !!scenario.mutedAtStart,
    nativeMuted: typeof ev.nativeMuted === 'boolean' ? ev.nativeMuted : null,
    durationMs: scenario.durationMs || 45000,
    pods: state.pod,
    // Evidence that the adverse arm fired: a run that declares `stall` and
    // reports 0 here measured a different stream than the one it described.
    stalls: state.stalls || 0,
    rungs: RUNGS.map((r) => r.v),
    // The last requests are the only way to tell "the player did not ask" from
    // "the server answered badly" when a clean frame starves.
    recent: state.requests.slice(-40).map((r) => `${Math.round(r.t - state.t0)}:${r.path}`),
  };
}

// ---- server ---------------------------------------------------------------
function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('cache-control', 'no-store');
}

function send(res, status, type, body) {
  cors(res);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const { cert, key } = ensureCerts();
ensureMedia();

const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const url = new URL(req.url || '/', `https://${host}`);
  const path = url.pathname;
  note({ host, path });

  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '');

  // ---- gql ---------------------------------------------------------------
  if (host.startsWith('gql.')) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let pt = 'site';
      let pf = 'web';
      try {
        const p = JSON.parse(body);
        const v = (p && (p.variables || (Array.isArray(p) && p[0] && p[0].variables))) || {};
        pt = v.playerType || 'site';
        pf = v.platform || 'web';
      } catch { /* token defaults are recorded in the response */ }
      send(res, 200, 'application/json', JSON.stringify({
        data: { streamPlaybackAccessToken: { value: tokenFor(pt, pf), signature: `replica-${pt}-${pf}` } },
      }));
    });
    return;
  }

  // ---- kick probe: the content script must not reach the real internet ----
  if (host === 'kick.com' || host.endsWith('.kick.com') || host === 'api.kick.com') {
    return send(res, 404, 'application/json', JSON.stringify({ error: 'replica: no kick mirror' }));
  }

  // ---- usher master -----------------------------------------------------
  if (host.startsWith('usher.')) {
    const m = /^\/api\/v2\/channel\/hls\/([^/]+)\.m3u8$/.exec(path);
    if (!m) return send(res, 404, 'text/plain', 'no route');
    let pt = 'site'; let pf = 'web';
    try {
      const tok = JSON.parse(url.searchParams.get('token') || '{}');
      pt = tok.player_type || pt;
      pf = tok.platform || pf;
    } catch { /* keep defaults */ }
    return send(res, 200, 'application/vnd.apple.mpegurl', masterFor(pt, pf));
  }

  // ---- edge playlists + segments ---------------------------------------
  if (host.startsWith('video-edge')) {
    if (path === '/v1/playlist/live.m3u8') {
      const clean = url.searchParams.get('clean') === '1';
      const v = Number(url.searchParams.get('v') || 720);
      return send(res, 200, 'application/vnd.apple.mpegurl', mediaPlaylist({ clean, t: now(), pod: state.pod, v }));
    }
    const seg = /^\/v1\/segment\/([\w.-]+)$/.exec(path);
    if (seg) {
      const file = join(MEDIA_DIR, seg[1]);
      if (!existsSync(file)) return send(res, 404, 'text/plain', 'no segment');
      const body = readFileSync(file);
      const serve = () => {
        cors(res);
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
        res.end(body);
      };
      // AN EDGE THAT STOPS ANSWERING, because a perfect local file never
      // starves: the clean frame lives at ~1 s of forward buffer on a real CDN
      // edge and the extension stall-stops it with `hist:[4/3 4/1.01 4/0.99]`.
      // A fixture that always answers in 2 ms cannot represent that, so a
      // scenario declares `stall:{atMs, ms, on}` and the edge withholds content
      // segments for that window. The delay is bounded by the window itself,
      // never by a fixed sleep.
      const st = scenario.stall;
      if (st && st.ms > 0) {
        const want = st.on || 'content';
        const isContent = /^content_/.test(seg[1]);
        const t = now();
        if ((want === 'all' || isContent) && t >= st.atMs && t < st.atMs + st.ms) {
          const wait = Math.max(0, st.atMs + st.ms - t);
          state.stalls = (state.stalls || 0) + 1;
          return setTimeout(serve, wait);
        }
      }
      return serve();
    }
    return send(res, 404, 'text/plain', 'no route');
  }

  // ---- www.twitch.tv ----------------------------------------------------
  if (!host.startsWith('www.')) return send(res, 404, 'text/plain', 'unknown host');

  if (path === '/__ko/state') return send(res, 200, 'application/json', JSON.stringify(pageStatus()));
  if (path === '/__ko/player-worker.js') return send(res, 200, 'text/javascript', readPage('player-worker.js'));
  if (path === '/__ko/page.js') return send(res, 200, 'text/javascript', readPage('page.js'));
  if (path === '/favicon.ico') return send(res, 204, 'image/x-icon', '');
  if (path === '/__ko/status') {
    return send(res, 200, 'application/json', JSON.stringify({
      scenario: scenario.name,
      pageT0: state.t0,
      now: now(),
      pod: state.pod,
      requests: state.requests.length,
      hits: state.hits,
      lastEvents: state.requests.slice(-12),
      recent: state.requests.slice(-40).map((r) => ({ m: r.ms, p: r.path })),
    }));
  }

  // Any single-segment path is the watch page: content.js's isChannelPath().
  if (/^\/[\w-]+\/?$/.test(path) || path === '/') {
    pageLoaded();
    state.hits.page = now();
    return send(res, 200, 'text/html; charset=utf-8', readPage('index.html'));
  }
  return send(res, 404, 'text/plain', 'no route');
});

// Pod index: edge when an ad event starts. Polled here rather than in the
// request path so two concurrent playlist fetches cannot mint two pods.
let lastAd = false;
setInterval(() => {
  const ad = !!activeEvent(now());
  if (ad && !lastAd) { state.pod++; state.hits.pod = now(); }
  lastAd = ad;
}, 100);

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port: PORT, scenario: scenario.name, channel: CHANNEL }));
});
