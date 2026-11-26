// ko-real-capture.mjs — record what a REAL Twitch page does at the HLS/DOM level,
// from a guest Chrome that the caller already started and owns. This tool never
// starts or stops a browser, and has no npm dependencies.
//
//   node _tools/ko-real-capture.mjs --port 9446 \
//     --url https://www.twitch.tv/<channel> --seconds 90 \
//     --out G:/Temp/ko-replica/real/<stamp>/capture.json
//
// Target discovery uses http://127.0.0.1:<port>/json/list. CDP control uses the
// browser WebSocket from /json/version so the page and its workers share one
// connection with flattened per-session commands.
// With --navigate, Network is enabled on the page target BEFORE Page.navigate
// sends the tab to --url once, so load-time and preroll playlists are recorded
// from the first byte. The tool waits up to 30 s for Page.loadEventFired (then
// continues with a loud note on timeout) and tags requests seen before that
// point phase:'nav', so a load-window-only capture is not read as steady state.
// --selftest analyses two fixture playlist bodies without a browser and exits
// nonzero on a mismatch.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const USAGE = [
  'Usage: node _tools/ko-real-capture.mjs [options]',
  '',
  '  --port <n>      guest Chrome debugging port (e.g. 9446); 9222 and 9333 are refused',
  '  --url <url>     Twitch page URL to observe (host must match an open page target)',
  '  --navigate      enable Network first, then Page.navigate to --url once;',
  '                  wait up to 30 s for load before sampling (captures preroll)',
  '  --seconds <n>   sampling duration in seconds (default 90)',
  '  --out <path>    JSON output path (parent directories are created)',
  '  --page-only     do not attach to worker / service_worker targets',
  '  --selftest      analyse two fixture playlists (no Chrome), exit nonzero on mismatch',
  '  --help          print this usage and exit 0',
  '',
  'Attaches to an ALREADY-RUNNING guest Chrome; no browser start/stop is performed.',
  'Without --navigate the tab is left as-is; with it, this tool performs the one navigation.',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { port: null, url: '', seconds: 90, out: '', pageOnly: false, navigate: false, selftest: false, help: false };
  const names = { '--port': 'port', '--url': 'url', '--seconds': 'seconds', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--page-only') { o.pageOnly = true; continue; }
    if (a === '--navigate') { o.navigate = true; continue; }
    if (a === '--selftest') { o.selftest = true; continue; }
    let key = a;
    let val;
    const eq = a.indexOf('=');
    if (eq > 0) { key = a.slice(0, eq); val = a.slice(eq + 1); }
    if (Object.prototype.hasOwnProperty.call(names, key)) {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith('--')) {
          process.stderr.write(`BAD-ARGS missing value for ${key}\n`);
          process.exit(2);
        }
      }
      o[names[key]] = val;
      continue;
    }
    process.stderr.write(`BAD-ARGS unknown option ${a}\n`);
    process.exit(2);
  }
  return o;
}

function hostOf(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ''; }
}

// CDP client: one browser WebSocket, many flattened sessions. The event callback
// receives (params, sessionId) so every request can be attributed to page/worker.
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        for (const cb of this.handlers.get(m.method)) cb(m.params, m.sessionId);
      }
    };
  }
  async send(method, params = {}, sessionId, timeout = 30000) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ': timeout')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// One Runtime.evaluate per second: video state, ad DOM geometry, visibility and
// KO overlay markers. No template interpolation here; the page expression is opaque.
const SAMPLE_EXPR = `(() => {
  const vids = [...document.querySelectorAll('video')].map(v => ({
    ct: v.currentTime,
    paused: v.paused,
    rs: v.readyState,
    dur: v.duration,
    bufferedEnd: v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : null,
    seekableEnd: v.seekable && v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null,
    vw: v.videoWidth,
    vh: v.videoHeight,
    src: String(v.src || v.currentSrc || '').slice(0, 120),
    srcObjectType: v.srcObject ? String((v.srcObject.constructor && v.srcObject.constructor.name) || '') : null
  }));
  const rect = e => { if (!e) return null; const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const wrapper = document.querySelector('.stream-display-ad__wrapper')
    || document.querySelector('[class*="stream-display-ad__wrapper"]');
  const player = document.querySelector('[data-a-target="video-player"]')
    || document.querySelector('.video-player');
  let innerRects = [];
  if (wrapper) {
    innerRects = [...wrapper.querySelectorAll('*')].map(e => {
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      return { tag: e.tagName, cls: String(e.className || '').slice(0, 80),
        w: r.width, h: r.height, visibility: cs.visibility, display: cs.display,
        opacity: cs.opacity, area: r.width * r.height };
    }).filter(x => x.area > 0 && x.visibility !== 'hidden' && x.display !== 'none'
        && Number(x.opacity) > 0)
      .sort((a, b) => b.area - a.area).slice(0, 5);
  }
  return {
    videos: vids,
    ad: {
      wrapperClasses: wrapper ? [...wrapper.classList] : [],
      wrapperRect: rect(wrapper),
      innerRects: innerRects,
      playerRect: rect(player)
    },
    visibilityState: document.visibilityState,
    koWrap: !!document.querySelector('#ko-wrap'),
    koOwner: !!document.querySelector('[data-ko-owner]'),
    koAdpark: !!document.querySelector('[data-ko-adpark]')
  };
})()`;

const EMPTY_AD = { wrapperClasses: [], wrapperRect: null, innerRects: [], playerRect: null };

function analyze(body) {
  const text = String(body || '');
  const lines = text.split(/\r?\n/);
  const tags = [...new Set(text.match(/#EXT-X-[A-Z0-9-]+/g) || [])];
  const extinf = [];
  const adExtinf = [];
  const titles = [];
  const adTitles = [];
  const nonLiveTitles = [];
  const variants = [];
  let inAd = false;
  let adRangePending = false;
  let discontinuities = 0;
  let before = 0;
  let after = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bandwidth = (line.match(/BANDWIDTH=(\d+)/) || [])[1] || '';
      const resolution = (line.match(/RESOLUTION=(\d+x\d+)/) || [])[1] || '';
      const uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#')) variants.push({ bandwidth, resolution, uri });
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const value = line.slice('#EXTINF:'.length).split(',')[0];
      const title = line.slice('#EXTINF:'.length).split(',').slice(1).join(',');
      extinf.push(value);
      titles.push(title);
      if (title.toLowerCase() !== 'live') nonLiveTitles.push(title);
      if (inAd) { adExtinf.push(value); adTitles.push(title); }
      else if (discontinuities) after++;
      else before++;
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuities++;
      // A stitched-ad DATERANGE is followed by a discontinuity at the ad seam;
      // that seam opens the pod rather than closing it. Without a DATERANGE the
      // seam toggles (ad in, then content back).
      inAd = adRangePending ? true : !inAd;
      adRangePending = false;
      continue;
    }
    if (line.startsWith('#EXT-X-DATERANGE') && /ad|preroll|midroll|postroll|stitch/i.test(line)) {
      inAd = true;
      adRangePending = true;
    }
  }
  return {
    tags, extinf, adExtinf, titles, adTitles, nonLiveTitles, variants,
    discontinuity: discontinuities > 0,
    separatesAd: discontinuities > 0 && before > 0 && (adExtinf.length > 0 || after > 0),
  };
}

// Two fixture bodies: a steady content window and a stitched ad pod. Kept here
// (not in a scratch file) so --selftest needs no browser, network or filesystem.
const SELFTEST_CONTENT = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:2',
  '#EXTINF:2.000,live',
  'content_000.ts',
  '#EXTINF:2.000,live',
  'content_001.ts',
].join('\n') + '\n';

const SELFTEST_STITCHED = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:2',
  '#EXTINF:2.000,live',
  'content_000.ts',
  '#EXT-X-DATERANGE:ID="pod1",CLASS="twitch-stitched-ad",START-DATE="2026-11-26T00:00:00.000Z",DURATION=4.000',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:2.000,ad_000',
  'ad_000.ts',
  '#EXTINF:2.000,ad_001',
  'ad_001.ts',
].join('\n') + '\n';

// The same counters back the capture summary and the selftest assertions.
function adSummary(playlists) {
  let nonLiveTitles = 0;
  let adPlaylists = 0;
  let adSegments = 0;
  for (const p of playlists) {
    const a = analyze(String((p && p.body) || ''));
    nonLiveTitles += a.nonLiveTitles.length;
    adSegments += a.adExtinf.length;
    if (a.adExtinf.length) adPlaylists++;
  }
  return { nonLiveTitles, adPlaylists, adSegments };
}

function selftest() {
  const cases = [
    ['steady', SELFTEST_CONTENT, { extinf: 2, adSegments: 0, adTitles: [], nonLiveTitles: [], separatesAd: false }],
    ['stitched', SELFTEST_STITCHED, { extinf: 3, adSegments: 2, adTitles: ['ad_000', 'ad_001'], nonLiveTitles: ['ad_000', 'ad_001'], separatesAd: true }],
  ];
  let passed = 0;
  for (const [name, body, want] of cases) {
    const a = analyze(body);
    const got = {
      extinf: a.extinf.length,
      adSegments: a.adExtinf.length,
      adTitles: a.adTitles,
      nonLiveTitles: a.nonLiveTitles,
      separatesAd: a.separatesAd,
    };
    const problems = [];
    for (const key of Object.keys(want)) {
      if (JSON.stringify(got[key]) !== JSON.stringify(want[key])) {
        problems.push(`${key}: want ${JSON.stringify(want[key])}, got ${JSON.stringify(got[key])}`);
      }
    }
    if (a.discontinuity !== (name === 'stitched')) {
      problems.push(`discontinuity: want ${name === 'stitched'}, got ${a.discontinuity}`);
    }
    if (problems.length) {
      process.stderr.write(`SELFTEST FAIL ${name}: ${problems.join('; ')}\n`);
      return 1;
    }
    process.stdout.write(`SELFTEST ${name} extinf=${got.extinf} ad-segments=${got.adSegments} non-live-titles=${got.nonLiveTitles.length} titles=${a.titles.join(',') || '-'}\n`);
    passed++;
  }
  const both = adSummary([{ body: SELFTEST_CONTENT }, { body: SELFTEST_STITCHED }]);
  if (both.nonLiveTitles !== 2 || both.adPlaylists !== 1 || both.adSegments !== 2) {
    process.stderr.write(`SELFTEST FAIL summary: want non-live-titles=2 ad-playlists=1 ad-segments=2, got ${JSON.stringify(both)}\n`);
    return 1;
  }
  process.stdout.write(`SELFTEST summary non-live-titles=${both.nonLiveTitles} ad-playlists=${both.adPlaylists} ad-segments=${both.adSegments}\n`);
  process.stdout.write(`SELFTEST PASS ${passed}/${cases.length}\n`);
  return 0;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(USAGE + '\n'); return; }
  if (o.selftest) { process.exitCode = selftest(); return; }
  const port = Number(o.port);
  // Guard the owner's browser and the relay BEFORE any CDP/network call,
  // even when other required options are missing.
  if (port === 9222) {
    process.stderr.write("REFUSED port 9222 is the owner's browser\n");
    process.exit(2);
  }
  if (port === 9333) {
    process.stderr.write('REFUSED port 9333 is the relay\n');
    process.exit(2);
  }
  if (!o.port || !o.url || !o.out) {
    process.stderr.write('BAD-ARGS --port, --url and --out are required (see --help)\n');
    process.exit(2);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`BAD-ARGS invalid --port ${o.port}\n`);
    process.exit(2);
  }
  const seconds = Number(o.seconds);
  if (!Number.isInteger(seconds) || seconds < 1) {
    process.stderr.write(`BAD-ARGS invalid --seconds ${o.seconds}\n`);
    process.exit(2);
  }
  const requestedHost = hostOf(o.url);
  if (!requestedHost) {
    process.stderr.write(`BAD-ARGS --url has no host: ${o.url}\n`);
    process.exit(2);
  }

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t && t.type === 'page' && hostOf(t.url) === requestedHost);
  if (!page) {
    process.stderr.write(`CANNOT-MEASURE no page target for ${requestedHost}\n`);
    process.exit(3);
  }

  const t0 = Date.now();
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = new CDP(version.webSocketDebuggerUrl);

  const sessionFrom = new Map();
  const attachedTargets = new Set();
  const playlists = [];
  const requests = new Map();
  let bodyCount = 0;
  let workerCount = 0;
  let navLoad = null;
  let navComplete = false;

  cdp.on('Target.attachedToTarget', async (p) => {
    const ti = p.targetInfo || {};
    const sid = p.sessionId;
    if (!sid) return;
    attachedTargets.add(ti.targetId);
    const isWorker = ti.type === 'worker' || ti.type === 'service_worker';
    sessionFrom.set(sid, isWorker ? 'worker' : 'page');
    if (isWorker) workerCount++;
    try { await cdp.send('Network.enable', {}, sid); } catch { /* target may be gone */ }
  });

  // A capture stores PLAYLISTS. The old test accepted any URL on a Twitch media
  // host, so `/v1/segment/...` bodies landed in `playlists` and their query keys
  // polluted the token comparison (measured 2026-11-26: one `live-video.net`
  // segment among 114 rows, reported as `DIVERGE tokenKeys`). Playlist truth is
  // in the path: Twitch serves `/v1/playlist/<token>.m3u8` and
  // `usher.ttvnw.net/api/channel/hls/<name>.m3u8`.
  const isMediaUrl = (u) => {
    let path = u;
    try { path = new URL(u).pathname; } catch { /* keep raw */ }
    const bare = path.split(/[?#]/)[0];
    if (!/\.m3u8$/i.test(bare) && !/\/playlist\//i.test(bare)) return false;
    return /usher\.ttvnw\.net|playlist\.ttvnw\.net|live-video\.net|ttvnw\.net/i.test(u);
  };

  cdp.on('Network.requestWillBeSent', (p, sid) => {
    const u = p.request && p.request.url || '';
    if (!isMediaUrl(u)) return;
    const q = u.indexOf('?');
    const phase = o.navigate ? (navComplete ? 'sample' : 'nav') : undefined;
    const rec = {
      atMs: Date.now() - t0,
      url: u,
      tokenQuery: q < 0 ? '' : u.slice(q),
      host: hostOf(u),
      from: sessionFrom.get(sid) === 'worker' ? 'worker' : 'page',
      status: 0,
      body: '',
      ...(phase ? { phase } : {}),
    };
    requests.set(p.requestId, rec);
    playlists.push(rec);
  });

  cdp.on('Network.responseReceived', (p) => {
    const rec = requests.get(p.requestId);
    if (rec && p.response) rec.status = p.response.status || 0;
  });

  cdp.on('Network.loadingFinished', async (p, sid) => {
    const rec = requests.get(p.requestId);
    if (!rec || rec.body || bodyCount >= 200) return;
    bodyCount++;
    try {
      // CDP has no base64 option: request the plain body and only decode if Chrome
      // reports base64Encoded. Cap each body at 1 MiB.
      const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, sid);
      const text = b && b.base64Encoded
        ? Buffer.from(b.body || '', 'base64').toString('utf8')
        : String((b && b.body) || '');
      rec.body = text.slice(0, 1024 * 1024);
    } catch {
      rec.body = '';
    } finally {
      requests.delete(p.requestId);
    }
  });

  const { sessionId: pageSid } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  sessionFrom.set(pageSid, 'page');
  await cdp.send('Network.enable', {}, pageSid);
  await cdp.send('Runtime.enable', {}, pageSid);
  if (!o.pageOnly) await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSid);

  if (!o.pageOnly) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos || []) {
      const isWorker = t.type === 'worker' || t.type === 'service_worker';
      if (!isWorker || attachedTargets.has(t.targetId)) continue;
      // Dedicated workers belong to this page via openerId; service workers are shared.
      if (t.type === 'worker' && t.openerId && t.openerId !== page.id) continue;
      try {
        await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      } catch { /* target vanished between discovery and attach */ }
    }
  }

  // --navigate: recording was armed on the page (and auto-attached workers)
  // before this point, so the first navigation byte is already observable.
  // Navigate exactly once; do not fight the extension with a second load.
  if (o.navigate) {
    await cdp.send('Page.enable', {}, pageSid);
    const loadEvent = new Promise((resolve) => {
      let done = false;
      const finish = (timedOut) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(timedOut);
      };
      const timer = setTimeout(() => finish(true), 30000);
      cdp.on('Page.loadEventFired', () => finish(false));
    });
    await cdp.send('Page.navigate', { url: o.url }, pageSid);
    const timedOut = await loadEvent;
    navComplete = true;
    navLoad = { atMs: Date.now() - t0, timedOut };
    if (timedOut) {
      process.stdout.write('NAV load-event timeout after 30000ms; continuing sampling\n');
    } else {
      process.stdout.write(`NAV load-event fired at ${navLoad.atMs}ms; continuing sampling\n`);
    }
  }

  const samples = [];
  for (let i = 0; i < seconds; i++) {
    let sample = null;
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: SAMPLE_EXPR,
        returnByValue: true,
        awaitPromise: false,
      }, pageSid);
      if (r && r.result && r.result.value) sample = r.result.value;
    } catch { /* keep a minimal sample rather than losing the tick */ }
    samples.push({
      atMs: Date.now() - t0,
      videos: (sample && sample.videos) || [],
      ad: (sample && sample.ad) || EMPTY_AD,
      visibilityState: sample ? sample.visibilityState : null,
      koWrap: !!(sample && sample.koWrap),
      koOwner: !!(sample && sample.koOwner),
      koAdpark: !!(sample && sample.koAdpark),
    });
    await sleep(1000);
  }
  await sleep(200); // let final loadingFinished bodies land

  const last = samples.length ? samples[samples.length - 1] : null;
  const dom = {
    ...(last ? last.ad : EMPTY_AD),
    visibilityState: last ? last.visibilityState : null,
    koWrap: !!(last && last.koWrap),
    koOwner: !!(last && last.koOwner),
    koAdpark: !!(last && last.koAdpark),
  };
  const navPlaylists = o.navigate ? playlists.filter((p) => p.phase === 'nav').length : 0;
  const out = {
    stamp: new Date(t0).toISOString(),
    url: o.url,
    port,
    seconds,
    navigate: !!o.navigate,
    ...(navLoad ? { nav: { ...navLoad, playlists: navPlaylists } } : {}),
    playlists,
    samples,
    dom,
  };

  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, JSON.stringify(out, null, 2) + '\n');
  cdp.close();

  const analyses = playlists.map((p) => analyze(p.body));
  const media = playlists.filter((p) => /#EXTINF/.test(String(p.body || ''))).length;
  const adExtinf = [];
  const variants = [];
  let separatesAd = false;
  for (const a of analyses) {
    adExtinf.push(...a.adExtinf);
    variants.push(...a.variants);
    if (a.separatesAd) separatesAd = true;
  }
  const ads = adSummary(playlists);
  const keys = new Set();
  for (const p of playlists) {
    for (const [k] of new URLSearchParams(p.tokenQuery.replace(/^\?/, ''))) keys.add(k);
  }
  process.stdout.write(`SUMMARY playlists=${playlists.length} media=${media}\n`);
  playlists.forEach((p, i) => {
    process.stdout.write(`PLAYLIST ${i} host=${p.host} status=${p.status} from=${p.from} tags=${analyses[i].tags.join(',') || '-'}\n`);
  });
  process.stdout.write(`AD-EXTINF ${adExtinf.join(', ') || '-'}\n`);
  process.stdout.write(`AD-MEDIA non-live-titles=${ads.nonLiveTitles} ad-playlists=${ads.adPlaylists} ad-segments=${ads.adSegments}\n`);
  if (!ads.nonLiveTitles && !ads.adPlaylists) {
    process.stdout.write('ad-media none: no pod in this window\n');
  }
  if (o.navigate) {
    process.stdout.write(`PHASE nav=${navPlaylists} sample=${playlists.length - navPlaylists} load=${navLoad && navLoad.timedOut ? 'timeout' : 'ok'}\n`);
  }
  process.stdout.write(`DISCONTINUITY separates-ad=${separatesAd}\n`);
  process.stdout.write(`VARIANTS ${variants.map((v) => v.bandwidth + '/' + v.resolution).join(' ') || '-'}\n`);
  process.stdout.write(`TOKEN-KEYS ${[...keys].sort().join(',') || '-'}\n`);
  process.stdout.write(`CAPTURE ${o.out} playlists=${playlists.length} workers=${workerCount} samples=${samples.length}\n`);
  if (playlists.length === 0) {
    process.stderr.write('CAPTURE-FAIL no playlist was captured; file holds no measurements (check --url/--port or use --navigate)\n');
    process.exitCode = 3;
  } else if (media === 0) {
    process.stderr.write('CAPTURE-FAIL no #EXTINF media body was captured; ad media cannot be measured (check --url/--port or use --navigate)\n');
    process.exitCode = 3;
  }
}

main().catch((e) => {
  process.stderr.write(`CANNOT-MEASURE ${e && e.message ? e.message : String(e)}\n`);
  process.exit(1);
});
