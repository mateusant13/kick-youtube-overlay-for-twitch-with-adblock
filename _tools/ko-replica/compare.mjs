#!/usr/bin/env node
// compare.mjs - pure offline comparator: REAL Twitch capture vs replica behaviour.
//
//   node _tools/ko-replica/compare.mjs --real capture.json --replica capture.json
//   node _tools/ko-replica/compare.mjs --real capture.json --replica report.json
//   node _tools/ko-replica/compare.mjs --selftest
// No network, no browser, no scratch files: JSON in, one verdict line per
// dimension, RESULT + NEXT, and an exit code. A dimension absent on either
// side is CANNOT-MEASURE naming that side, never a silent SAME.
//
// Exit: 0 all SAME, 1 any DIVERGE, 2 any CANNOT-MEASURE and no DIVERGE.
import { readFileSync } from 'node:fs';

const DIMS = [
  'adStyle', 'adDiscontinuity', 'ladder', 'masterVariants', 'mediaTags',
  'targetDuration', 'segments', 'adWindow', 'tokenKeys', 'fetchedBy', 'codecsPrefix', 'dom',
];

const USAGE = [
  'usage: node _tools/ko-replica/compare.mjs --real <capture.json> --replica <capture.json|report.json>',
  '       node _tools/ko-replica/compare.mjs --selftest',
  '       node _tools/ko-replica/compare.mjs --help',
  '',
  'capture.json: {url, playlists:[{url,tokenQuery,host,from,status,body}], samples:[{video:{...}}], dom:{...}}',
  'report.json:  {scenario, samples:[{probe:{video:{...}}}], rows:[{t,ev,d}], checks}',
  'exit 0 all SAME, 1 any DIVERGE, 2 CANNOT-MEASURE with no DIVERGE',
].join('\n');

const argOf = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
};

// ---- playlist parsing ------------------------------------------------------
const linesOf = (body) => String(body == null ? '' : body).split(/\r?\n/);

function attr(line, name) {
  const re = new RegExp('(?:^|[,;:])\\s*' + name + '\\s*=\\s*(?:"([^"]*)"|([^,]*))', 'i');
  const m = re.exec(line);
  if (!m) return null;
  return (m[1] === undefined ? m[2] : m[1]).trim();
}

function tagOf(line) {
  const m = /^#([A-Za-z0-9-]+)/.exec(line.trim());
  return m ? m[1].toUpperCase() : null;
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const v = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

// One media playlist: tags, segment kinds, and the discontinuity seam.
function analyseMedia(body) {
  const tags = new Set();
  const segAd = [];
  let pending = false;
  let adActive = false;
  let contentSeen = false;
  let adSeen = false;
  let sawAdDatarange = false;
  let sawPrefetch = false;
  let sawDiscontinuity = false;
  for (const raw of linesOf(body)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const tag = tagOf(line);
      if (tag) tags.add(tag);
      if (tag === 'EXTINF') pending = true;
      if (tag === 'EXT-X-DATERANGE' && /twitch-stitched-ad|CLASS\s*=\s*"[^"]*ad/i.test(line)) {
        sawAdDatarange = true;
        adActive = true;
      }
      if (tag === 'EXT-X-TWITCH-PREFETCH') {
        sawPrefetch = true;
        adActive = true;
      }
      if (tag === 'EXT-X-DISCONTINUITY') {
        sawDiscontinuity = true;
        // A seam AFTER ad segments closes the ad block; a seam after content
        // opens one. A seam at the window head before any segment says nothing.
        if (adSeen) adActive = false;
        else if (contentSeen || segAd.length) adActive = true;
      }
      continue;
    }
    if (!pending) continue;
    pending = false;
    // URI markers identify ad media (real Twitch and the replica both put
    // "ad" in the segment path); DATERANGE/PREFETCH/seam cover unmarked URIs.
    const marked = /(?:^|[\/_.?&=-])(?:ads?|advert|advertisement|stitched)(?:$|[\/_.?&=-])/i.test(line);
    const ad = marked || adActive;
    segAd.push(ad);
    if (ad) adSeen = true;
    else contentSeen = true;
  }
  return { tags, segAd, sawAdDatarange, sawPrefetch, sawDiscontinuity };
}

function adStyleOf(medias) {
  let stitched = false;
  let adOnly = false;
  let anyAd = false;
  for (const m of medias) {
    const ads = m.segAd.filter(Boolean).length;
    const content = m.segAd.length - ads;
    if (ads || m.sawAdDatarange || m.sawPrefetch) anyAd = true;
    if ((ads > 0 && content > 0) || (content > 0 && (m.sawAdDatarange || m.sawPrefetch))) stitched = true;
    if (ads > 0 && content === 0) adOnly = true;
  }
  if (stitched) return 'stitched';
  return anyAd || adOnly ? 'separate' : 'none';
}

// ---- token / origin / DOM helpers -----------------------------------------
function queryKeys(q) {
  if (q == null || q === false) return [];
  if (Array.isArray(q)) return q.flatMap(queryKeys);
  if (typeof q === 'string') {
    let s = q.trim();
    if (!s) return [];
    const qi = s.indexOf('?');
    if (qi >= 0) s = s.slice(qi + 1);
    const hi = s.indexOf('#');
    if (hi >= 0) s = s.slice(0, hi);
    return s.split(/[&;]/).map((part) => {
      const k = part.split('=')[0].trim();
      try { return decodeURIComponent(k); } catch { return k; }
    }).filter((k) => k.length > 0);
  }
  if (typeof q === 'object') {
    if (typeof q.searchParams?.forEach === 'function') {
      const out = [];
      q.searchParams.forEach((_v, k) => out.push(k));
      return out;
    }
    const out = Object.keys(q);
    if (typeof q.query === 'string') out.push(...queryKeys(q.query));
    return Array.from(new Set(out));
  }
  return [];
}

function originOf(from) {
  if (from == null) return null;
  if (Array.isArray(from)) {
    const set = new Set(from.map(originOf).filter(Boolean));
    return set.size ? (set.size > 1 ? 'both' : [...set][0]) : null;
  }
  if (typeof from === 'object') return originOf(from.where || from.kind || from.origin);
  const s = String(from).toLowerCase();
  if (s.includes('both')) return 'both';
  if (s.includes('worker') || s.includes('service')) return 'worker';
  if (s.includes('page') || s.includes('window') || s.includes('main')) return 'page';
  if (s.includes('none') || s === 'false' || s === '0') return 'none';
  return null;
}

function joinedOrigins(origins) {
  if (origins.has('both') || (origins.has('worker') && origins.has('page'))) return 'both';
  return [...origins][0];
}

function rectValue(r) {
  if (r == null) return null;
  let a = null;
  if (Array.isArray(r)) a = r.slice(0, 4).map((n) => Number(n));
  else if (typeof r === 'object') {
    a = [r.x ?? r.left ?? 0, r.y ?? r.top ?? 0, r.width ?? r.w ?? 0, r.height ?? r.h ?? 0].map(Number);
  }
  if (!a || a.length < 4 || a.some((n) => !Number.isFinite(n))) return null;
  return a.map((n) => String(Math.round(n))).join(',');
}

function classesValue(c) {
  if (c == null) return null;
  const parts = Array.isArray(c) ? c : String(c).split(/\s+/);
  const out = parts.map((s) => String(s).trim()).filter(Boolean).sort();
  return out.length ? out.join(',') : null;
}

// ---- normalise both accepted shapes into the same feature vector ----------
function normalize(input, side) {
  const doc = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const isReport = !Array.isArray(doc.playlists) &&
    (typeof doc.scenario === 'string' || Array.isArray(doc.rows));
  const playlists = Array.isArray(doc.playlists)
    ? doc.playlists.filter((p) => p && typeof p === 'object')
    : [];
  const rawSamples = Array.isArray(doc.samples) ? doc.samples : [];
  const absent = (why) => ({ present: false, why });
  const value = (v) => ({ present: true, value: v });
  const f = {};

  const masters = [];
  const medias = [];
  const variants = [];
  const tags = new Set();
  const tokenKeys = new Set();
  const origins = new Set();
  let ignoredRecords = 0;
  for (const p of playlists) {
    // A capture predating the playlist-only filter in ko-real-capture.mjs holds
    // `/v1/segment/...` bodies; their query strings polluted `tokenKeys` with a
    // whole signed URL. The reader filters them too, and names the count.
    const rawUrl = String((p && (p.url || p.host)) || '');
    if (rawUrl && !/\.m3u8|\/playlist\//i.test(rawUrl)) { ignoredRecords++; continue; }
    const body = String(p.body == null ? '' : p.body);
    if (/#EXT-X-STREAM-INF\b/i.test(body)) masters.push(body);
    if (/#EXTINF\b/i.test(body)) medias.push(analyseMedia(body));
    for (const line of linesOf(body)) {
      if (!/^#EXT-X-STREAM-INF\b/i.test(line.trim())) continue;
      const res = attr(line, 'RESOLUTION');
      const bw = attr(line, 'BANDWIDTH');
      if (res && bw) variants.push(`${res}x${bw}`);
    }
    // Keys come from a QUERY STRING only. Twitch's media playlists carry their
    // token in the PATH (`/v1/playlist/<opaque>`), so falling back to the url
    // made `queryKeys` return the whole URL as one "key" and the dimension read
    // `DIVERGE tokenKeys` for the same token model.
    const keys = queryKeys(p.tokenQuery);
    if (keys.length) keys.forEach((k) => tokenKeys.add(k));
    else if (String(p.url || '').includes('?')) queryKeys(p.url).forEach((k) => tokenKeys.add(k));
    // The replica serves the extension's clean standby from the same host with
    // `pt=autoplay`; a real capture labels its page player `page`, and the
    // extension's standby is indistinguishable from it through CDP. Compare the
    // surfaces at that granularity instead of inventing a third origin.
    const o = originOf(p.from);
    if (o) origins.add(o === 'clean-iframe' ? 'page' : o);
  }
  for (const m of medias) m.tags.forEach((t) => tags.add(t));

  // report.json carries no playlist capture. Its ring rows do prove that a
  // worker fetched playlists, but the extension has NO page-fetch event at all
  // (`grep -c 'page-playlist\|fetch-playlist' kick-overlay/*.js` -> 0), so a
  // report can never name the page side. MEASURED 2026-11-26: a real capture
  // says `fetchedBy: both` on every playlist while the same page's report says
  // `worker`, and comparing those two readers reported `DIVERGE fetchedBy` for
  // a page that fetched exactly what the capture showed. That is a divergence
  // of the OBSERVER, so the report side refuses the dimension with its reason
  // instead of inventing an absence it cannot prove.
  const reportFetchedNote = isReport
    ? "the extension's ring records worker playlist fetches only, so it cannot prove the page never fetched"
    : null;

  // master-derived dimensions
  const rungs = [];
  let codecsPrefix = null;
  for (const body of masters) {
    for (const line of linesOf(body)) {
      if (!/^#EXT-X-STREAM-INF\b/i.test(line.trim())) continue;
      const codecs = attr(line, 'CODECS');
      if (codecs && !codecsPrefix) codecsPrefix = codecs.split(',')[0].trim();
    }
  }
  for (const v of new Set(variants)) {
    const res = String(v).split('x');
    const h = Number(res[1]);
    if (Number.isFinite(h) && h > 0) rungs.push({ h, label: `${h}p` });
  }
  rungs.sort((a, b) => b.h - a.h || a.label.localeCompare(b.label));

  f.masterVariants = masters.length && variants.length
    ? value(Array.from(new Set(variants))) : absent('no master playlist captured');
  f.ladder = rungs.length ? value(rungs.map((r) => r.label)) : absent('no master playlist captured');
  f.codecsPrefix = codecsPrefix ? value(String(codecsPrefix).toLowerCase()) : absent('no master playlist captured');

  // media-derived dimensions
  // A live window and a growing ad pod are different populations: the replica
  // appends its pod one segment at a time (`1,2,3,…7`), so a median over every
  // captured playlist compared Twitch's steady 14 with the replica's pod ramp
  // and reported `segments 5` for a fixture that does list 14. The window length
  // is a CONTENT property; the pod's own length is its own dimension.
  const adCount = (m) => m.segAd.filter(Boolean).length;
  const contentWins = medias.filter((m) => !adCount(m));
  const adWins = medias.filter((m) => adCount(m) > 0);
  const windowCounts = contentWins.map((m) => m.segAd.length);
  const durations = [];
  for (const p of playlists) {
    const body = String(p.body == null ? '' : p.body);
    if (!/#EXTINF\b/i.test(body)) continue;
    for (const line of linesOf(body)) {
      const d = /^#EXT-X-TARGETDURATION\s*:\s*([\d.]+)/i.exec(line.trim());
      if (d) durations.push(Number(d[1]));
    }
  }
  f.mediaTags = medias.length ? value(Array.from(tags).sort()) : absent('no media playlist captured');
  f.adStyle = medias.length ? value(adStyleOf(medias)) : absent('no media playlist captured');
  // A dimension whose answer is "there is no ad in this capture" is not a
  // false: a real window that served no pod says nothing about whether Twitch
  // separates an ad with a discontinuity, and printing `real=false replica=true`
  // for it reads as a product defect. Name the missing population instead.
  // `EXT-X-TWITCH-PREFETCH` is not ad media: measured 2026-11-26 on a healthy
  // `rodil` page, the playlists the player worker fetches carry two prefetch
  // rows with no ad in the window, so counting the tag as an ad made this
  // dimension read `real=false replica=true` for a capture with zero ad
  // segments. Only an ad SEGMENT puts an ad in the window.
  const hasAdMedia = medias.some((m) => adCount(m) > 0);
  f.adDiscontinuity = !medias.length
    ? absent('no media playlist captured')
    : !hasAdMedia
      ? absent('no ad media in the captured window')
      : value(medias.some((m) => adCount(m) > 0 && m.sawDiscontinuity));
  f.targetDuration = durations.length ? value(median(durations)) : absent('no media playlist captured');
  f.segments = windowCounts.length
    ? value(median(windowCounts))
    : absent(medias.length ? 'no content-only playlist captured' : 'no media playlist captured');
  f.adWindow = adWins.length
    ? value(median(adWins.map(adCount)))
    : absent('no ad media in the captured window');

  f.tokenKeys = tokenKeys.size ? value(Array.from(tokenKeys).sort()) : absent(playlists.length ? 'no token query captured' : 'no playlist captured');
  // The replica server sees an HTTP request, not the CDP target that made it,
  // so it can label the clean standby (`pt=autoplay`) and nothing else. A real
  // capture is taken over CDP and does distinguish worker from page. Comparing
  // the two would report a divergence of the OBSERVER as a divergence of the
  // page, so the replica side refuses with that reason.
  const serverObserved = !!(doc.dom && doc.dom.source === 'replica-server');
  f.fetchedBy = reportFetchedNote
    ? absent(reportFetchedNote)
    : serverObserved
      ? absent('the replica server cannot attribute a fetch to a CDP target')
      : origins.size ? value(joinedOrigins(origins)) : absent(playlists.length ? 'no fetch origin recorded' : 'no playlist captured');

  // DOM: what the EXTENSION reads, not one snapshot. The ad wrapper is a
  // permanent shell that Twitch reveals by painting an inner node
  // (`stream-display-ad__wrapper-hidden` stays on the wrapper of a healthy
  // page), so a single sample taken mid-pod reports "no hidden class" for the
  // same markup that reports it a second later. The dimension is therefore
  // "does the page expose the shell, and does it ever paint it", collected
  // across every sample; the rects are geometry the replica page chooses, so
  // they are printed as notes and never decide a verdict.
  const dom = doc.dom && typeof doc.dom === 'object' ? doc.dom : {};
  const classSets = new Set();
  const addClasses = (c) => { const v = classesValue(c); if (v) classSets.add(v); };
  addClasses(dom.adWrapperClasses || dom.wrapperClasses || dom.wrapper?.cls);
  let playerRect = rectValue(dom.playerRect || dom.player?.rect);
  let videoRect = rectValue(dom.videoRect || dom.video?.rect);
  for (const s of rawSamples) {
    const p = s && (s.probe || s);
    if (!p || typeof p !== 'object') continue;
    addClasses(p.adWrapperClasses || p.wrapper?.cls || p.wrapper?.className || (p.ad && p.ad.wrapperClasses));
    if (!playerRect) playerRect = rectValue(p.playerRect || p.player?.rect || (p.ad && p.ad.playerRect));
    if (!videoRect) videoRect = rectValue((p.video && p.video.rect) || p.videoRect);
  }
  let hiddenShell = null;
  let paintedShell = null;
  for (const set of classSets) {
    const hasBase = /stream-display-ad__wrapper(?:[,_]|$)/.test(set);
    if (!hasBase) continue;
    // Both spellings are live Twitch markup: the real page uses the BEM modifier
    // `stream-display-ad__wrapper-hidden`, the replica fixture uses
    // `stream-display-ad__wrapper_hidden`.
    if (/stream-display-ad__wrapper(?:-|_)hidden(?:,|$)/.test(set)) hiddenShell = true;
    else paintedShell = true;
  }
  if (classSets.size) {
    // `painted` is only comparable when this side served an ad: a window with no
    // pod never reveals the shell, and comparing its `null` against a replica
    // that DID paint reads as a product defect. `hidden` is the half the
    // extension's detector reads and is always comparable.
    const shellSeen = hiddenShell || paintedShell ? 'stream-display-ad__wrapper' : 'none';
    f.dom = hasAdMedia
      ? value({ shell: shellSeen, hidden: hiddenShell === null ? null : hiddenShell, painted: paintedShell === null ? null : paintedShell })
      : value({ shell: shellSeen, hidden: hiddenShell === null ? null : hiddenShell });
  } else {
    f.dom = playerRect || videoRect
      ? value({ shell: 'none', hidden: null, painted: null })
      : absent('no DOM captured');
  }
  const notes = [];
  if (ignoredRecords) notes.push(`ignored ${ignoredRecords} non-playlist record(s): segment URLs are not playlists`);
  if (playerRect || videoRect || classSets.size) {
    notes.push(`geometry (scenario property, not a verdict): playerRect ${side}=${playerRect || 'null'}`);
    notes.push(`videoRect=${videoRect || 'null'} wrapperClassSets=${classSets.size}`);
  }
  if (notes.length) f.notes = notes;

  // Kept for the record: neither the report nor the capture exposes a url-keyed
  // dimension, but side labels are always attached to missing evidence.
  f.side = side;
  return f;
}

// ---- comparison / rendering ------------------------------------------------
const stable = (v) => JSON.stringify(v);
function render(v) {
  if (Array.isArray(v)) return v.join(',');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Tags the replica carries because it ships fMP4 into MediaSource while Twitch
// ships MPEG-TS. They are documented in _tools/ko-replica/README.md; a diff that
// prints them as DIVERGE every single run makes the one dimension that actually
// broke (a wrong ad style, a wrong window) unreadable.
const INTENTIONAL_MEDIA_TAGS = ['EXT-X-DISCONTINUITY', 'EXT-X-INDEPENDENT-SEGMENTS', 'EXT-X-MAP'];
const INTENTIONAL_WHY = 'fMP4 needs EXT-X-MAP and a discontinuity at the ad seam; Twitch sends MPEG-TS without them (README, intentional divergences)';

// Twitch's rungs are the broadcaster's own transcode output (measured
// 2026-11-26, `rodil`: 640x360/284x160/160k), so a fixed 720/480/360 replica
// ladder diverges on every channel that does not happen to use those three. The
// replica needs a ladder (the 360p-reveal defect is only observable with one),
// so the difference is a property of the SCENARIO, not a fidelity target, and
// it must not decide the exit code.
const SCENARIO_DIMS = new Set(['ladder', 'masterVariants', 'tokenKeys']);
const SCENARIO_WHY = "rungs are the broadcaster's transcode output and the replica mints unsigned tokens; both are scenario properties, not fidelity targets";

function scenarioDiff(dim, a, b) {
  if (!SCENARIO_DIMS.has(dim)) return null;
  return { dim, verdict: 'SCENARIO', detail: `real=${render(a)} replica=${render(b)} (${SCENARIO_WHY})` };
}

function intentional(dim, a, b) {
  if (dim !== 'mediaTags') return null;
  const left = new Set(String(a).split(','));
  const right = new Set(String(b).split(','));
  const diff = [];
  left.forEach((t) => { if (!right.has(t)) diff.push(t); });
  right.forEach((t) => { if (!left.has(t)) diff.push(t); });
  if (!diff.length || diff.some((t) => !INTENTIONAL_MEDIA_TAGS.includes(t))) return null;
  return { dim, verdict: 'INTENTIONAL', detail: `${diff.join(',')} (${INTENTIONAL_WHY})` };
}

function compare(real, replica) {
  return DIMS.map((dim) => {
    const a = real[dim];
    const b = replica[dim];
    if (!a.present || !b.present) {
      const reasons = [];
      if (!a.present) reasons.push(`real side: ${a.why}`);
      if (!b.present) reasons.push(`replica side: ${b.why}`);
      return { dim, verdict: 'CANNOT-MEASURE', detail: reasons.join('; ') };
    }
    // A `dom` value only carries `painted` on a side that served an ad. When
    // exactly one side has it, the two snapshots describe different populations
    // and the honest answer is CANNOT-MEASURE naming which side lacked an ad.
    if (dim === 'dom' && a.value && b.value && typeof a.value === 'object' && typeof b.value === 'object'
      && ('painted' in a.value) !== ('painted' in b.value)) {
      const lacked = 'painted' in a.value ? 'replica' : 'real';
      return {
        dim,
        verdict: 'CANNOT-MEASURE',
        detail: `${lacked} side: this window served no ad, so the shell's paint state is not comparable (real=${render(a.value)} replica=${render(b.value)})`,
      };
    }
    if (stable(a.value) === stable(b.value)) {
      return { dim, verdict: 'SAME', detail: render(a.value) };
    }
    const accepted = intentional(dim, a.value, b.value);
    if (accepted) return accepted;
    const scenario = scenarioDiff(dim, a.value, b.value);
    if (scenario) return scenario;
    return { dim, verdict: 'DIVERGE', detail: `real=${render(a.value)} replica=${render(b.value)}` };
  });
}

function formatRow(r) {
  if (r.verdict === 'SAME') return `SAME   ${r.dim} ${r.detail}`;
  if (r.verdict === 'DIVERGE') return `DIVERGE ${r.dim} ${r.detail}`;
  if (r.verdict === 'INTENTIONAL') return `ACCEPTED ${r.dim} ${r.detail}`;
  if (r.verdict === 'SCENARIO') return `SCENARIO ${r.dim} ${r.detail}`;
  return `CANNOT-MEASURE ${r.dim} (${r.detail})`;
}

// ---- selftest: fixtures only, no files, no network -------------------------
const RUNGS = [[1280, 720, 4800000], [854, 480, 2400000], [640, 360, 1200000]];
// The measured shape of a HEALTHY Twitch page (2026-11-26, `rodil`): the ad
// wrapper is present and hidden, which is exactly what makes a class-token
// detector blind. The fixture carries it so the `dom` dimension models the real
// page instead of a painted-ad page.
const DOM = {
  adWrapperClasses: ['stream-display-ad__wrapper', 'stream-display-ad__wrapper_hidden'],
  playerRect: [0, 0, 1280, 720],
  videoRect: [0, 0, 1280, 720],
};
const TOKEN = '?token=abc&sig=xyz&expires=123';

function masterBody(rungs) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:7'];
  for (const [w, h, bw] of rungs) {
    out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},CODECS="avc1.4d401f,mp4a.40.2"`);
    out.push(`https://usher.ttvnw.net/v1/playlist/${h}.m3u8`);
  }
  return out.join('\n') + '\n';
}
function segLines(kind, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('#EXTINF:2.000,', `${kind}_${String(i).padStart(3, '0')}.m4s`);
  return out;
}
function cleanBody(n = 4) {
  return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXT-X-MAP:URI="/v1/segment/content_init.mp4"', ...segLines('content', n)].join('\n') + '\n';
}
function stitchedBody({ disc = true, content = 2, ads = 2 } = {}) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXT-X-MAP:URI="/v1/segment/content_init.mp4"', ...segLines('content', content),
    '#EXT-X-DATERANGE:ID="pod1",CLASS="twitch-stitched-ad",START-DATE="2026-11-26T00:00:00.000Z",DURATION=4.000',
    '#EXT-X-TWITCH-PREFETCH:https://edge/ad_000.m4s'];
  if (disc) out.push('#EXT-X-DISCONTINUITY');
  out.push('#EXT-X-MAP:URI="/v1/segment/ad_init.mp4"', ...segLines('ad', ads));
  return out.join('\n') + '\n';
}
function adOnlyBody({ disc = true, ads = 4 } = {}) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-DATERANGE:ID="pod1",CLASS="twitch-stitched-ad",START-DATE="2026-11-26T00:00:00.000Z",DURATION=8.000',
    '#EXT-X-TWITCH-PREFETCH:https://edge/ad_000.m4s'];
  if (disc) out.push('#EXT-X-DISCONTINUITY');
  out.push('#EXT-X-MAP:URI="/v1/segment/ad_init.mp4"', ...segLines('ad', ads));
  return out.join('\n') + '\n';
}
function capture({ rungs = RUNGS, media = [cleanBody(14), stitchedBody()], from = 'worker', token = TOKEN, dom = DOM } = {}) {
  return {
    url: 'https://www.twitch.tv/replicach',
    playlists: [
      { url: `https://usher.ttvnw.net/master.m3u8${token}`, tokenQuery: token, host: 'usher.ttvnw.net', from, status: 200, body: masterBody(rungs) },
      ...media.map((body, i) => ({
        url: `https://video-edge-a.playlist.ttvnw.net/v1/playlist/${i}.m3u8${token}`,
        tokenQuery: token, host: 'video-edge-a.playlist.ttvnw.net', from, status: 200, body,
      })),
    ],
    samples: [{ video: { rs: 4, ct: 1.2, rect: [0, 0, 1280, 720] } }],
    dom,
  };
}
function reportOf() {
  return {
    scenario: 'dev-preroll-hold',
    samples: [{ probe: {
      video: { rs: 4, ct: 1.2, rect: [0, 0, 1280, 720] },
      wrapper: { cls: 'stream-display-ad__wrapper', w: 1280, h: 130 },
    } }],
    rows: [{ t: 1, ev: 'worker-playlist', d: {} }, { t: 2, ev: 'ad-hold', d: {} }],
    checks: [],
  };
}

function expected(overrides = {}) {
  const base = {};
  DIMS.forEach((d) => { base[d] = 'SAME'; });
  return Object.assign(base, overrides);
}

function selftest() {
  const cases = [
    ['identical', capture(), capture(), expected()],
    ['ladder', capture(), capture({ rungs: [[1280, 720, 4800000], [640, 360, 1200000]] }),
      expected({ ladder: 'SCENARIO', masterVariants: 'SCENARIO' })],
    ['adStyle', capture(), capture({ media: [cleanBody(14), adOnlyBody()] }),
      // Both sides keep a 14-segment content window, so the ONLY difference is
      // the pod shape; the pod's own length differs too (2 vs 4 ad segments).
      expected({ adStyle: 'DIVERGE', adWindow: 'DIVERGE' })],
    ['discontinuity', capture(), capture({ media: [cleanBody(14), stitchedBody({ disc: false })] }),
      // mediaTags accepts a missing EXT-X-DISCONTINUITY as the named fMP4
      // divergence; adDiscontinuity is the dimension that still diverges.
      expected({ adDiscontinuity: 'DIVERGE', mediaTags: 'INTENTIONAL' })],
    ['unexplained-tag', capture(),
      capture({ media: [cleanBody(14), stitchedBody().replace('#EXT-X-DISCONTINUITY', '#EXT-X-TWITCH-ELAPSED-SECS:1')] }),
      expected({ adDiscontinuity: 'DIVERGE', mediaTags: 'DIVERGE' })],
    ['missing-playlist', capture(), { ...capture(), playlists: [] },
      expected({
        masterVariants: 'CANNOT-MEASURE', ladder: 'CANNOT-MEASURE', mediaTags: 'CANNOT-MEASURE',
        adStyle: 'CANNOT-MEASURE', adDiscontinuity: 'CANNOT-MEASURE', targetDuration: 'CANNOT-MEASURE',
        segments: 'CANNOT-MEASURE', adWindow: 'CANNOT-MEASURE', tokenKeys: 'CANNOT-MEASURE',
        fetchedBy: 'CANNOT-MEASURE', codecsPrefix: 'CANNOT-MEASURE', dom: 'CANNOT-MEASURE',
      })],
    // The measured real shape: every playlist is fetched by BOTH the page and
    // the player worker (capture on `rodil`/`shygo`, 2026-11-26). The ring can
    // only ever say `worker`, so this dimension must refuse on the report side
    // instead of calling the page's own fetch a divergence.
    ['report-vs-capture', capture({ from: 'both' }), reportOf(),
      expected({
        masterVariants: 'CANNOT-MEASURE', ladder: 'CANNOT-MEASURE', mediaTags: 'CANNOT-MEASURE',
        adStyle: 'CANNOT-MEASURE', adDiscontinuity: 'CANNOT-MEASURE', targetDuration: 'CANNOT-MEASURE',
        segments: 'CANNOT-MEASURE', adWindow: 'CANNOT-MEASURE', tokenKeys: 'CANNOT-MEASURE',
        codecsPrefix: 'CANNOT-MEASURE', fetchedBy: 'CANNOT-MEASURE',
        // The report side has no ad media, so its shell's paint state cannot be
        // compared with a capture that served one.
        dom: 'CANNOT-MEASURE',
      })],
    // A growing pod is its own dimension: the replica appends 1..7 ad segments
    // while a real capture with no pod cannot answer, and two real pods of
    // different length must DIVERGE rather than average into the window length.
    ['adWindow-real-none', capture({ media: [cleanBody(14)] }), capture(),
      expected({ mediaTags: 'DIVERGE', adStyle: 'DIVERGE', adDiscontinuity: 'CANNOT-MEASURE',
        adWindow: 'CANNOT-MEASURE', dom: 'CANNOT-MEASURE' })],
    ['adWindow-len', capture({ media: [stitchedBody({ ads: 2 })] }),
      capture({ media: [stitchedBody({ ads: 4 })] }),
      // With no content-only window on either side, the window length has no
      // population to compare: it is CANNOT-MEASURE, not the pod's length.
      expected({ adWindow: 'DIVERGE', segments: 'CANNOT-MEASURE' })],
    ['tokenKeys', capture(), capture({ token: '?token=abc&sig=xyz' }),
      // A different token query is a scenario property (the replica is unsigned),
      // so it must not decide the exit code; the dimension still reports it.
      expected({ tokenKeys: 'SCENARIO' })],
    ['fetchedBy', capture(), capture({ from: 'page' }),
      expected({ fetchedBy: 'DIVERGE' })],
  ];
  let passed = 0;
  for (const [name, real, replica, want] of cases) {
    const rows = compare(normalize(real, 'real'), normalize(replica, 'replica'));
    const got = {};
    rows.forEach((r) => { got[r.dim] = r.verdict; });
    const problems = [];
    DIMS.forEach((d) => {
      if (got[d] !== want[d]) problems.push(`${d}: want ${want[d]}, got ${got[d]}`);
    });
    rows.forEach((r) => {
      if (r.verdict === 'CANNOT-MEASURE' && !/\b(?:real|replica) side:/.test(r.detail)) {
        problems.push(`${r.dim}: CANNOT-MEASURE does not name a side`);
      }
    });
    if (name === 'missing-playlist') {
      const tk = rows.find((r) => r.dim === 'tokenKeys');
      if (!tk || tk.detail !== 'replica side: no playlist captured') {
        problems.push(`tokenKeys detail: want "replica side: no playlist captured", got ${tk && tk.detail}`);
      }
    }
    if (problems.length) {
      console.error(`SELFTEST FAIL ${name}: ${problems.join('; ')}`);
      return 1;
    }
    passed++;
  }
  console.log(`SELFTEST PASS ${passed}/${cases.length}`);
  return 0;
}

// ---- CLI ------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes('--selftest')) return selftest();
  const realPath = argOf(argv, 'real');
  const replicaPath = argOf(argv, 'replica');
  if (!realPath || !replicaPath) {
    console.error(USAGE);
    return 2;
  }
  let real;
  let replica;
  try {
    real = JSON.parse(readFileSync(realPath, 'utf8'));
  } catch (e) {
    console.error(`ERROR real (${realPath}): ${e.message}`);
    return 2;
  }
  try {
    replica = JSON.parse(readFileSync(replicaPath, 'utf8'));
  } catch (e) {
    console.error(`ERROR replica (${replicaPath}): ${e.message}`);
    return 2;
  }
  const rn = normalize(real, 'real');
  const rep = normalize(replica, 'replica');
  const rows = compare(rn, rep);
  rows.forEach((r) => console.log(formatRow(r)));
  for (const n of (rn.notes || [])) console.log(`NOTE   ${n}`);
  for (const n of (rep.notes || [])) console.log(`NOTE   ${n}`);
  const diverged = rows.filter((r) => r.verdict === 'DIVERGE');
  const cannot = rows.filter((r) => r.verdict === 'CANNOT-MEASURE');
  const accepted = rows.filter((r) => r.verdict === 'INTENTIONAL');
  const scenario = rows.filter((r) => r.verdict === 'SCENARIO');
  const tag = ` (intentional ${accepted.length}, scenario ${scenario.length})`;
  if (diverged.length) console.log(`RESULT DIVERGE ${diverged.length}/${rows.length}${tag}`);
  else if (cannot.length) console.log(`RESULT CANNOT-MEASURE ${cannot.length}/${rows.length}${tag}`);
  else if (accepted.length || scenario.length) console.log(`RESULT FIDELITY ${rows.length - accepted.length - scenario.length}/${rows.length}${tag}`);
  else console.log(`RESULT SAME ${rows.length}/${rows.length}`);
  // Order is by how visible the difference is to a viewer: a wrong ad style
  // is seen before a wrong ladder, which is seen before a missing DOM wrapper.
  const next = diverged[0] || cannot[0];
  if (!next) console.log('NEXT none');
  else if (next.verdict === 'DIVERGE') console.log(`NEXT ${next.dim} ${next.detail}`);
  else console.log(`NEXT ${next.dim} (${next.detail})`);
  return diverged.length ? 1 : cannot.length ? 2 : 0;
}

process.exit(main());
