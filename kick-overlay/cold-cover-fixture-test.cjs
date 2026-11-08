// Cold-preroll fixture: a real ad-only live playlist, served locally, driven
// through the real worker and the real page module.
//
// Why this exists: KO-20261023-01 ("cold preroll native ad stays visible too
// long") could not be measured in the owner Chrome on 2026-10-26 — Twitch served
// 5 ad-net requests and painted no ad in 150 s, so there was no preroll window to
// time. A live pod cannot be manufactured. This fixture manufactures the *input*
// instead: the m3u8 bytes Twitch would serve, with the markers the extension
// keys on, plus the real worker consuming them and the real page module acting
// on the resulting message.
//
// Chain proved here:
//   fixtures/cold-preroll/*.m3u8  (real bytes, real HTTP, 127.0.0.1)
//     -> workerMain()  (real code, stubbed transport) -> digest + `ad-hold` on
//        the real BroadcastChannel contract
//     -> twitch-adblock.js page module (real code, stubbed DOM) -> cold-cover,
//        then overlay-reveal once the clean frame is healthy.
//
// Arms:
//   GREEN  real source: cold-cover fires ON the ad-hold tick, the native player
//          is NOT hidden and the frame is NOT painted (a hold, not a black
//          screen), and overlay-reveal lands well inside the bound, at which
//          point the native IS hidden and the frame IS opaque.
//   RED    pre-fix mutation (`if (overlay.frame && ...)` -> `if (false)`,
//          i.e. no cold cover): no cold-cover event. The detector must catch
//          this or it measures nothing.
//   RED-2  the 2026-11-07 defect mutation: paint the frame and hide the native
//          on the hold tick again. The GREEN assertion must fail on it, or the
//          "no black screen" property is not being measured.
//
// `node cold-cover-fixture-test.cjs` (no frameworks, no browser).
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { makePage, settle, healthySt } = require('./mute-decision-test.cjs');

const SOURCE = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8');
const FIXTURES = path.join(__dirname, 'fixtures', 'cold-preroll');
const PRE_FIX_MUTATION = [
  'if (overlay.frame && !overlay.revealed && !overlay.playing) {',
  'if (false) { // pre-fix: no cold cover',
];
// Re-instates the 0.8.46 behaviour the owner reported on 2026-11-08: the hold
// painted nothing, so the ad itself stayed on screen for the whole pod. The
// mutant removes the cover block (hide + panel) and keeps the cold-cover event.
const PAINT_MUTATION = [
  // both halves of the cover: hiding the ad and showing the panel
  ['try { hideNativeVideos(); } catch { /* ignore */ }', '/* mutant: native left visible */'],
  ["overlay.cover.style.display = 'flex';", '/* mutant: no panel */'],
];
const LIVE_HOST = 'https://video-edge-a.playlist.ttvnw.net';
const CHANNEL = 'rodil';

// ---- 1. serve the fixture playlists over real HTTP -------------------------
const ROUTES = {
  '/channel/hls/rodil.m3u8': 'master.m3u8',
  '/v1/playlist/ad.m3u8': 'media-ad.m3u8',
  '/v1/playlist/clean.m3u8': 'media-clean.m3u8',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = ROUTES[(req.url || '').split('?')[0]];
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const body = fs.readFileSync(path.join(FIXTURES, file));
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Twitch-shaped URL -> the local file that stands in for it. Anything else (GQL,
// ad creatives) gets a fast 404 so the real code takes its failure path instead
// of hanging.
function makeTransport(base) {
  return async function transport(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let pathname = null;
    if (url.startsWith(LIVE_HOST)) pathname = url.slice(LIVE_HOST.length);
    if (pathname && ROUTES[pathname.split('?')[0]]) {
      const r = await fetch(base + pathname);
      const text = await r.text();
      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

// ---- 2. run the real workerMain against that transport ---------------------
function runWorker(source, transport) {
  const debug = [];
  const bypass = [];
  class BroadcastChannelStub {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      this.sink = name === 'ko-adblock-bypass' ? bypass : debug;
    }
    postMessage(msg) { this.sink.push(msg); }
  }
  const self = {
    fetch: transport,
    addEventListener(type, fn) { if (type === 'message') self._onMessage = fn; },
    postMessage() {},
    location: { href: 'https://www.twitch.tv/rodil' },
  };

  // The module's own prelude, verbatim in shape (see twitch-adblock.js:2628).
  const prelude = [
    'const __KO_CLIENT_ID="fixture";',
    'const __KO_GQL_HASH="fixture";',
    'const __KO_GQL_URL="https://gql.example/gql";',
    'const __KO_PLAYER_TYPE="popout";',
    'const __KO_PLATFORM="web";',
    'const __KO_PAGE_ID="fixture-page";',
  ].join('');

  const workerMainSrc = locateWorkerMain(source);
  const factory = new Function(
    'self', 'BroadcastChannel', 'performance', 'console',
    `${prelude}(${workerMainSrc})();`,
  );
  factory(self, BroadcastChannelStub, { now: () => Date.now() }, console);
  return { self, debug, bypass };
}

// ---- 3. text extraction of workerMain (brace-matched, string aware) --------
function locateWorkerMain(source) {
  const start = source.indexOf('function workerMain()');
  if (start < 0) throw new Error('workerMain not found in the module source');
  let i = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let prev = '';
  for (; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i); if (i < 0) break; i++; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
    prev += ch;
  }
  throw new Error('workerMain braces did not balance');
}

async function main() {
  const { server, base } = await startServer();
  const transport = makeTransport(base);
  const worker = runWorker(SOURCE, transport);

  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push({ name, status: 'PASS' });
      console.log(`PASS ${name}`);
    } catch (error) {
      checks.push({ name, status: 'FAIL', detail: error.message });
      console.log(`FAIL ${name}  ${error.message}`);
    }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  // The worker learns the channel from the master URL, exactly as on Twitch.
  await worker.self.fetch(`${LIVE_HOST}/channel/hls/${CHANNEL}.m3u8`);
  await settle(30);

  // The cold preroll: every segment is an ad, wrapped in the stitched-ad
  // DATERANGE the extension keys on.
  const adRes = await worker.self.fetch(`${LIVE_HOST}/v1/playlist/ad.m3u8`);
  const adText = await adRes.text();
  await settle(80);

  check('fixture served: ad-only playlist carries stitched-ad markers', () => {
    assert(/twitch-stitched-ad/.test(adText), 'no twitch-stitched-ad marker in the served bytes');
    assert(/X-TV-TWITCH-AD-URL/.test(adText), 'no X-TV-TWITCH-AD-URL marker in the served bytes');
    assert(!/#EXTINF:\d+\.\d+,live/.test(adText), 'the ad playlist contains live-suffixed content segments');
  });

  const adDigest = worker.debug.filter((m) => m.type === 'playlist' && /ad\.m3u8/.test(m.url || '')).pop();
  check('worker digest: the ad playlist reads as ad-only + stitched', () => {
    assert(adDigest, `no playlist digest for the ad url; got ${JSON.stringify(worker.debug.map((m) => m.type))}`);
    assert(adDigest.adOnly === true, `adOnly=${adDigest.adOnly}`);
    assert(adDigest.adExtinf === adDigest.extinf, `adExtinf=${adDigest.adExtinf} extinf=${adDigest.extinf}`);
    assert(adDigest.hasStitched === true, `hasStitched=${adDigest.hasStitched}`);
  });

  const cleanRes = await worker.self.fetch(`${LIVE_HOST}/v1/playlist/clean.m3u8`);
  await cleanRes.text();
  await settle(80);
  const cleanDigest = worker.debug.filter((m) => m.type === 'playlist' && /clean\.m3u8/.test(m.url || '')).pop();
  check('worker digest: a clean playlist is NOT an ad (negative control)', () => {
    assert(cleanDigest, 'no digest for the clean url');
    assert(cleanDigest.adOnly === false, `adOnly=${cleanDigest.adOnly}`);
    assert(cleanDigest.adExtinf === 0, `adExtinf=${cleanDigest.adExtinf}`);
  });

  const adHold = worker.bypass.filter((m) => m.type === 'ad-hold').pop();
  check('worker posts a real ad-hold on the bypass channel', () => {
    assert(adHold, `no ad-hold; bypass types=${JSON.stringify(worker.bypass.map((m) => m.type))}`);
    assert(adHold.channel === CHANNEL, `channel=${adHold.channel}`);
  });

  // ---- page arms -----------------------------------------------------------
  // A prewarmed standby frame exists before the pod, which is what the cold
  // cover path needs (twitch-adblock.js:1468).
  async function arm(source, label) {
    const page = makePage(source);
    const events = [];
    page.document.dispatchEvent = (e) => {
      if (e && e.type === 'ko-adlog') {
        try { events.push(JSON.parse(e.detail)); } catch { /* ignore */ }
      }
    };
    const at = (name) => events.filter((e) => e.ev === name);
    page.video.style = {};
    page.video.muted = true;
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: CHANNEL });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    page.frameMsg(healthySt()); // standby healthy but still hidden (not adopted)
    await settle(20);

    const t0 = Date.now();
    // In production the worker's prelude carries the page's own id
    // (__KO_PAGE_ID), and the bypass handler drops anything else. Re-stamp it
    // here so the message is the one the real page would accept.
    const pageId = page.stats() && page.stats().pageId;
    page.bypass({ ...adHold, page: pageId });
    await settle(30);
    const coverEvents = at('cold-cover');
    const coveredAt = coverEvents.length ? Date.now() - t0 : null;
    const nativeHiddenAtHold = page.video.style.visibility === 'hidden';
    const frameOpacityAtHold = page.frame ? page.frame.style.opacity : null;
    const coverAtHold = page.cover ? page.cover.style.display : null;
    const coverText = page.cover ? page.cover.textContent : null;

    for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
    await settle(30);
    const revealEvents = at('overlay-reveal');
    const revealedAt = revealEvents.length ? Date.now() - t0 : null;
    const nativeHiddenAfterReveal = page.video.style.visibility === 'hidden';
    const frameOpacityAfterReveal = page.frame ? page.frame.style.opacity : null;
    const coverAfterReveal = page.cover ? page.cover.style.display : null;

    return {
      label,
      coveredAt,
      revealedAt,
      nativeHiddenAtHold,
      frameOpacityAtHold,
      coverAtHold,
      coverText,
      coverAfterReveal,
      nativeHiddenAfterReveal,
      frameOpacityAfterReveal,
      coverEvents,
      revealEvents,
      events,
    };
  }

  const green = await arm(SOURCE, 'green');
  check('GREEN: cold-cover fires on the ad-hold tick', () => {
    assert(green.coverEvents.length >= 1, `no cold-cover; adlog=${JSON.stringify(green.events.map((e) => e.ev))}`);
    assert(green.coveredAt !== null && green.coveredAt <= 2000, `cover took ${green.coveredAt} ms, bound is 2000`);
    assert(green.coverEvents[0].d.reason === 'ad-hold', `reason=${green.coverEvents[0].d.reason}`);
  });
  check('GREEN: the hold covers the AD, and raises the frame only after the clean picture exists', () => {
    assert(green.nativeHiddenAtHold === true, 'the ad stayed visible on the hold tick — that is the whole-30s-ad report');
    assert(green.coverAtHold === 'flex', `cover panel display=${green.coverAtHold}`);
    assert(/carregando/.test(String(green.coverText)), `cover says: ${green.coverText}`);
    assert(green.frameOpacityAtHold !== '1', `frame was raised to opacity ${green.frameOpacityAtHold} before the source played — that is the black screen`);
  });
  check('GREEN: overlay-reveal lands inside the 12 s cold-cover window and swaps the surfaces', () => {
    assert(green.revealEvents.length >= 1, `no overlay-reveal; adlog=${JSON.stringify(green.events.map((e) => e.ev))}`);
    assert(green.revealedAt !== null && green.revealedAt < 12000, `reveal at ${green.revealedAt} ms`);
    assert(green.revealedAt > green.coveredAt, 'reveal happened before the cover');
    assert(green.nativeHiddenAfterReveal === true, 'the native player stayed visible after the reveal');
    assert(green.frameOpacityAfterReveal === '1', `frame opacity after reveal = ${green.frameOpacityAfterReveal}`);
    assert(green.coverAfterReveal === 'none', `the cover panel stayed up over the clean picture: ${green.coverAfterReveal}`);
  });

  const mutated = SOURCE.split(PRE_FIX_MUTATION[0]).join(PRE_FIX_MUTATION[1]);
  check('pre-fix mutation applied', () => {
    assert(mutated !== SOURCE, 'the cold-cover mutation did not apply — the negative arm would be vacuous');
  });
  const red = await arm(mutated, 'red');
  check('RED (pre-fix): no cold-cover event at all', () => {
    assert(red.coverEvents.length === 0, `pre-fix arm still emitted cold-cover: ${JSON.stringify(red.coverEvents)}`);
  });

  let painted = SOURCE;
  for (const [from, to] of PAINT_MUTATION) painted = painted.split(from).join(to);
  check('the paint mutation applied', () => {
    assert(painted !== SOURCE, 'the black-screen mutation did not apply — the guard would be vacuous');
  });
  const black = await arm(painted, 'black');
  check('RED-2 (2026-11-08 defect): a hold that paints nothing shows the ad, so the GREEN arm catches it', () => {
    assert(black.coverEvents.length >= 1, 'the mutant did not reach the hold branch');
    assert(black.nativeHiddenAtHold === false, 'the mutant hid the native — it is not the reported defect');
    assert(black.coverAtHold !== 'flex', `the mutant still showed the cover panel (${black.coverAtHold})`);
  });

  server.close();
  const failed = checks.filter((c) => c.status === 'FAIL');
  console.log('');
  console.log(`RESULT ${failed.length ? 'FAIL' : 'PASS'} cold-cover-fixture checks=${checks.length} failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\nRESULT FAIL', error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
