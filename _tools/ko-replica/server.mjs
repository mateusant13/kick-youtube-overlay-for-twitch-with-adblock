#!/usr/bin/env node
// ko-replica - a local, deterministic Twitch watch page plus the four HTTP
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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
// Twitch's live window, measured 2026-11-26 on twitch.tv/buzzyi_ (13 media
// playlists captured with _tools/ko-real-capture.mjs):
//   #EXT-X-VERSION:3, #EXT-X-TARGETDURATION:6, segments of 2.000 s titled
//   `,live` (14 per playlist), one #EXT-X-PROGRAM-DATE-TIME before EVERY
//   #EXTINF (182 for 182 segments), #EXT-X-TWITCH-LIVE-SEQUENCE /
//   -ELAPSED-SECS / -TOTAL-SECS, three #EXT-X-DATERANGE rows (timestamp,
//   twitch-session, twitch-stream-source) and two #EXT-X-TWITCH-PREFETCH rows.
// The target duration is SIX while the segments are TWO: hls.js derives its
// live edge, its latency and its stall margins from TARGETDURATION, so a
// replica that advertises 2 makes `lat` a different quantity from the one the
// extension measures live. PROGRAM-DATE-TIME is the other half of that number.
// `KO_REPLICA_TARGET` exists to A/B that number against the fixture, because it
// is not free on our side: hls.js holds `liveSyncDuration: 3` and treats a
// target duration longer than its sync target as a slower refresh, which a
// 26 s window then has to cover.
const TARGET_SEC = Number(process.env.KO_REPLICA_TARGET || 6);
const SESSION_ID = String(Date.now());
const iso = (ms) => new Date(ms).toISOString();
function segLine(kind, k, query, dur, v = 720, pdMs = null) {
  const idx = k % (kind === 'content' ? CONTENT_SEGS : AD_SEGS);
  const tag = kind === 'content' ? ',live' : ',';
  const d = Number.isFinite(dur) ? Number(dur).toFixed(3) : `${SEG}.000`;
  const pd = Number.isFinite(pdMs) ? `#EXT-X-PROGRAM-DATE-TIME:${iso(pdMs)}\n` : '';
  return `${pd}#EXTINF:${d}${tag}\n${EDGE}/v1/segment/${kind}_${v}_${pad(idx)}.m4s${query || ''}`;
}

// The three DATERANGE rows Twitch puts at the head of every live playlist. Our
// player ignores them; they are here because a fixture that omits what the real
// page sends cannot be used to argue that nothing on the page reads it.
function dateRangeHead(wallMs) {
  const secs = Math.floor(wallMs / 1000);
  const at = iso(wallMs);
  return [
    `#EXT-X-DATERANGE:ID="playlist-creation-${secs}",CLASS="timestamp",START-DATE="${at}",END-ON-NEXT=YES,X-SERVER-TIME="${(wallMs / 1000).toFixed(2)}"`,
    `#EXT-X-DATERANGE:ID="playlist-session-${secs}",CLASS="twitch-session",START-DATE="${at}",END-ON-NEXT=YES,X-TV-TWITCH-SESSIONID="${SESSION_ID}"`,
    `#EXT-X-DATERANGE:ID="source-${secs}",CLASS="twitch-stream-source",START-DATE="${at}",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="live"`,
  ];
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
  const wall = Date.now();
  for (let k = from; k <= last; k++) out.push(segLine('ad', k, `?pod=${pod}`, undefined, v, wall - (last - k) * SEG * 1000));
  return { lines: out, from };
}

// A playlist is a pure function of (clean, token type, wall clock, pod). No
// per-client state: the native worker and the clean iframe fetch the same URL
// and each one appends what it has not seen.
function mediaPlaylist({ clean, t, pod, v = 720 }) {
  const ev = activeEvent(t);
  const adOn = !clean && !!ev;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${TARGET_SEC}`, '#EXT-X-INDEPENDENT-SEGMENTS'];
  const i = contentIndex(t);
  const wall = Date.now();
  lines.push(...dateRangeHead(wall));

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
  // Real Twitch lists FOURTEEN segments per live playlist (measured 2026-11-26:
  // 14 x `#EXTINF:2.000,live` in every one of the 13 media playlists captured).
  // The window length is not cosmetic: hls.js refreshes a live playlist on a
  // cadence derived from TARGETDURATION (6 s real, so up to 3 s between
  // refreshes) while the window advances one 2 s segment per 2 s, so the player
  // reaches the published end whenever the buffer is shorter than the window.
  // A 13-segment (26 s) window stalled the clean frame there, `hold` 0.04 and
  // `rs` 2 for two samples, on the way to a 360p reveal. Keep the measured 14.
  const WINDOW_SEGS = Number(process.env.KO_REPLICA_WINDOW || 14) || 14;
  const from = Math.max(0, i - (WINDOW_SEGS - 1));
  // A window that still starts at the first segment is an EVENT window (the
  // stream just began) and hls.js starts at its oldest fragment; once it slides
  // it is an ordinary live window.
  if (from === 0) lines.push('#EXT-X-PLAYLIST-TYPE:EVENT');
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${from}`);
  lines.push(`#EXT-X-TWITCH-LIVE-SEQUENCE:${from}`);
  lines.push(`#EXT-X-TWITCH-ELAPSED-SECS:${(from * SEG).toFixed(3)}`);
  lines.push(`#EXT-X-TWITCH-TOTAL-SECS:${((i + 1) * SEG).toFixed(3)}`);
  lines.push('#EXT-X-MAP:URI="/v1/segment/content_' + v + '_init.mp4"');
  for (let k = from; k <= i + ahead; k++) lines.push(segLine('content', k, null, undefined, v, wall - (i - k) * SEG * 1000));
  // Twitch lists the two fragments still being produced (26 PREFETCH rows over
  // 13 playlists) so a player can warm them before the window steps. Ours are
  // the next two content indices; nothing on our side fetches them, and the
  // extension never reads this tag.
  for (let k = i + ahead + 1; k <= i + ahead + 2; k++) {
    lines.push(`#EXT-X-TWITCH-PREFETCH:${EDGE}/v1/segment/content_${v}_${pad(k % CONTENT_SEGS)}.m4s`);
  }
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
  // Real master (measured 2026-11-26): NO #EXT-X-VERSION line, a block of
  // #EXT-X-SESSION-DATA rows, and variants named the way Twitch names them -
  // `1080p60`/`720p60`/`360p30` with FRAME-RATE, SCORE and STABLE-VARIANT-ID.
  // Twitch's own player keys a quality pick on those attributes, so a replica
  // that only sends BANDWIDTH/RESOLUTION cannot represent a wrong pick at all.
  const wall = Date.now();
  const out = [
    '#EXTM3U',
    `#EXT-X-SESSION-DATA:DATA-ID="NODE",VALUE="${EDGE.replace('https://', '')}"`,
    `#EXT-X-SESSION-DATA:DATA-ID="MANIFEST-NODE-TYPE",VALUE="weaver_cluster"`,
    `#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="${(wall / 1000).toFixed(2)}"`,
    `#EXT-X-SESSION-DATA:DATA-ID="CLUSTER",VALUE="cloudfront_prod_replica"`,
    `#EXT-X-SESSION-DATA:DATA-ID="VIDEO-SESSION-ID",VALUE="${SESSION_ID}"`,
    '#EXT-X-SESSION-DATA:DATA-ID="USER-COUNTRY",VALUE="BR"',
  ];
  for (const r of RUNGS) {
    const fps = r.h >= 720 ? 60 : 30;
    const score = r.h >= 720 ? (r.h >= 1080 ? 5 : 4) : 3;
    const name = `${r.h}p${fps}`;
    out.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bw},RESOLUTION=${r.w}x${r.h},CODECS="avc1.4d401f",FRAME-RATE=${fps.toFixed(3)},SCORE=${score}.00,STABLE-VARIANT-ID="${name}",IVS-NAME="${name}",IVS-VARIANT-SOURCE="source"`,
    );
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
  capturePlaylist(res.req, body, status);
  cors(res);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// ---- capture --------------------------------------------------------------
// `KO_REPLICA_CAPTURE_OUT` writes the playlist bodies this replica served in the
// same shape `_tools/ko-real-capture.mjs` emits, so `compare.mjs` can diff the
// offline page against a real one with no hand-editing:
//
//   node _tools/ko-replica/run.mjs --scenario … --capture-out G:/Temp/…/replica.json
//   node _tools/ko-replica/compare.mjs --real <capture.json> --replica G:/Temp/…/replica.json
//
// It costs nothing on the request path: only bodies that begin with `#EXTM3U`
// are kept, each `host+path+query` is stored once (a live playlist is fetched
// dozens of times and the tag set is what a diff reads), the list is capped, and
// the file is rewritten at most twice a second and once at exit. Segment bytes
// are never captured.
const CAPTURE_OUT = process.env.KO_REPLICA_CAPTURE_OUT || '';
const CAPTURE_MAX = Number(process.env.KO_REPLICA_CAPTURE_MAX || 80) || 80;
const capture = { url: '', playlists: [], samples: [], dom: { source: 'replica-server' } };
const captureT0 = Date.now();
const captureSeen = new Map();
let captureDirty = false;
let captureTimer = null;
// A capture that writes nothing is the silent-green class this repo forbids, and
// the first pilot proved how easy it is: the parent directory did not exist,
// writeFileSync threw ENOENT and a bare catch swallowed it, so a full scenario
// ran to PASS with no capture file. The directory is created here and a write
// failure is printed once, on the stream run.mjs forwards into the report notes.
if (CAPTURE_OUT) {
  try { mkdirSync(dirname(CAPTURE_OUT), { recursive: true }); } catch (err) {
    console.error(`capture-dir-failed ${CAPTURE_OUT}: ${err && err.message}`);
  }
}
let captureWarned = false;
function captureFlush() {
  if (!CAPTURE_OUT || !captureDirty) return;
  captureDirty = false;
  try {
    writeFileSync(CAPTURE_OUT, `${JSON.stringify(capture, null, 1)}\n`);
  } catch (err) {
    if (!captureWarned) {
      captureWarned = true;
      console.error(`capture-write-failed ${CAPTURE_OUT}: ${err && err.message}`);
    }
  }
}
function capturePlaylist(req, body, status) {
  if (!CAPTURE_OUT || capture.playlists.length >= CAPTURE_MAX) return;
  if (typeof body !== 'string' || !body.startsWith('#EXTM3U')) return;
  if (!req) return;
  const host = String(req.headers.host || '').toLowerCase();
  // A live playlist keeps its URL while its BODY changes from content to a
  // stitched pod and back. Deduping on the URL alone therefore captured the
  // pre-pod content playlist and threw the ad program away, which is the one
  // shape `compare.mjs` cannot reconstruct: the first pilot stored four
  // playlists and not one of them carried an ad block. The key carries the ad
  // signature, so a content body and an in-pod body of the same URL are both
  // kept, and hundreds of refreshes of each still collapse to one.
  const adSegs = (body.match(/^#EXTINF:[^,\n]*,?(?!live\s*$).*$/gm) || []).length;
  const key = `${host}${req.url || ''}|ads:${adSegs}`;
  const seen = captureSeen.get(key);
  if (seen) {
    // The LAST body of a key is the steady-state window. Keeping the first one
    // stored the replica's start-up playlist (`#EXT-X-PLAYLIST-TYPE:EVENT`, one
    // or two segments) instead of the 14-segment live window the same URL
    // serves a moment later, and `compare.mjs` reported `segments 5` against
    // Twitch's 14 for a fixture that does list 14.
    seen.body = body;
    seen.status = status;
    captureDirty = true;
    if (!captureTimer) {
      captureTimer = setTimeout(() => { captureTimer = null; captureFlush(); }, 500);
      captureTimer.unref?.();
    }
    return;
  }
  const rec = {
    // `atMs` and the leading `?` match the real capture's record shape, so one
    // diff tool reads both files without a per-side special case.
    atMs: Date.now() - captureT0,
    url: String(req.url || '/'),
    host,
    tokenQuery: String(req.url || '').includes('?') ? String(req.url).slice(String(req.url).indexOf('?') + 1) : '',
    from: /(?:^|[?&])pt=autoplay(?:&|$)/.test(String(req.url || '')) ? 'clean-iframe' : 'page',
    adSegs,
    status,
    body,
  };
  captureSeen.set(key, rec);
  capture.url = capture.url || `https://${host}/`;
  capture.playlists.push(rec);
  captureDirty = true;
  if (!captureTimer) {
    captureTimer = setTimeout(() => { captureTimer = null; captureFlush(); }, 500);
    captureTimer.unref?.();
  }
}
process.on('exit', captureFlush);

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
