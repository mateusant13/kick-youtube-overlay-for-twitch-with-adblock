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
//          is PAUSED and NOT hidden (a hold freezes the last live frame instead
//          of replacing the screen with black), the notice is a small panel and
//          not a full-screen rectangle, and overlay-reveal lands inside the
//          bound, at which point the native IS hidden and the frame IS opaque.
//   SPARSE a throttled tab (one healthy sample after a >1.5s gap) still
//          reveals: a background tab's heartbeat cannot starve the health gate.
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
// The hold no longer waits for the frame (0.8.93: `ad-hold` is posted BEFORE the
// clean source is minted, and waiting for the frame is what let the ad play for
// four seconds), so the pre-fix mutation targets the branch that still exists.
const PRE_FIX_MUTATION = [
  'if (!overlay.revealed && !overlay.playing) {',
  'if (false) { // pre-fix: no cold cover',
];
// The black-screen defect the owner photographed on 2026-11-08: the hold hid
// the native video, so with the clean frame still hidden there was nothing on
// screen but the panel. The mutant restores the hide and the GREEN assertion on
// "the native is not hidden" must catch it.
const PAINT_MUTATION = [
  ['try { pauseNativeForHold(v); } catch { /* ignore */ }', 'try { hideNativeVideos(); } catch { /* ignore */ }'],
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
  async function arm(source, label, opts) {
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
    const pausedAtHold = page.video.paused === true;
    const frameOpacityAtHold = page.frame ? page.frame.style.opacity : null;
    const coverAtHold = page.cover ? page.cover.style.display : null;
    const coverText = page.cover ? page.cover.textContent : null;
    const coverCss = page.cover ? page.cover.style.cssText : '';

    if (opts && opts.sparse) {
      // A background tab: the frame's timer is throttled to one sample every
      // 10-30s. The gate must reveal on that single healthy sample instead of
      // counting to three and letting the bound stop a healthy player.
      await settle(1700);
      // A real throttled frame keeps DECODING between the two reports it gets:
      // its playhead advances by the wall-clock gap. A sample that repeats the
      // same `pos` after >2 s is exactly what the product's pos-frozen guard
      // refuses (`playing-not-healthy {why:'pos-frozen'}`), so a fixture that
      // held pos at 30 measured the guard instead of the sparse gate whenever
      // this settle overshot 2 s on a loaded box (measured 2026-11-24, gate run
      // under load: `no overlay-reveal after one healthy sample`).
      page.frameMsg(healthySt({ pos: 31.7 }));
      await settle(60);
    } else {
      for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
      await settle(30);
    }
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
      pausedAtHold,
      frameOpacityAtHold,
      coverAtHold,
      coverText,
      coverCss,
      coverAfterReveal,
      nativeHiddenAfterReveal,
      frameOpacityAfterReveal,
      coverEvents,
      revealEvents,
      events,
    };
  }

  // ---- the panel must never outlive the hold (owner report 2026-11-09) -----
  // "sem anuncio carregando a live" stayed on the NORMAL stream for the whole
  // session and only fullscreen hid it: a painted node with no owner. Two
  // invariants answer it, and both are checked here.
  //   (1) the paint is DERIVED from state by syncCover(), never set by a flag;
  //   (2) one node per id, so a rebuild cannot orphan a painted panel.
  const syncCoverSource = (() => {
    const grab = (name) => {
      const at = SOURCE.indexOf(`function ${name}(`);
      if (at < 0) throw new Error(`${name}() is missing from the shipped source`);
      let depth = 0;
      for (let i = SOURCE.indexOf('{', at); i < SOURCE.length; i++) {
        if (SOURCE[i] === '{') depth++;
        else if (SOURCE[i] === '}') {
          depth--;
          if (depth === 0) return SOURCE.slice(at, i + 1);
        }
      }
      throw new Error(`unbalanced ${name}()`);
    };
    // The shipped pair: the sizing helper and the state-driven painter.
    return [grab('sizeCover'), grab('syncCover')].join('\n');
  })();
  check('the panel paint follows state (shipped syncCover, driven directly)', () => {
    const run = (state) => {
      const cover = { isConnected: true, style: { display: 'flex' } };
      const overlay = Object.assign({ cover, video: null }, state);
      // eslint-disable-next-line no-new-func
      const mainVideo = () => null;
      // eslint-disable-next-line no-new-func
      new Function('overlay', 'mainVideo', `${syncCoverSource}; syncCover();`)(overlay, mainVideo);
      return cover.style.display;
    };
    assert(run({ coldCover: true, revealed: false, adActive: true }) === 'flex', 'a live hold must paint');
    assert(run({ coldCover: false, revealed: false, adActive: true }) === 'none', 'a cleared hold must un-paint');
    assert(run({ coldCover: true, revealed: true, adActive: true }) === 'none', 'a revealed player must win over a stale hold');
    assert(run({ coldCover: true, revealed: false, adActive: false }) === 'none', 'a pod that ended must un-paint');
    const hidden = { isConnected: true, style: { display: 'none' } };
    // eslint-disable-next-line no-new-func
    new Function('overlay', 'mainVideo', `${syncCoverSource}; syncCover();`)({ cover: hidden, video: null, coldCover: true, revealed: false, adActive: true }, () => null);
    assert(hidden.style.display === 'flex', 'and it re-paints a fresh hold');
  });
  check('the paint is enforced on the position tick, and the panel is deduped', () => {
    const tick = SOURCE.slice(SOURCE.indexOf('function positionOverlay()'), SOURCE.indexOf('function positionOverlay()') + 200);
    assert(/syncCover\(\);/.test(tick), 'positionOverlay no longer enforces the panel state');
    assert(SOURCE.includes("for (const staleId of ['ko-adfix-badge', 'ko-adfix-cover'])"), 'a rebuild can orphan a painted panel');
    const mutated = SOURCE.replace('  function positionOverlay() {\n    syncCover();', '  function positionOverlay() {\n    void 0;');
    assert(mutated !== SOURCE && !/syncCover\(\);/.test(mutated.slice(mutated.indexOf('function positionOverlay()'), mutated.indexOf('function positionOverlay()') + 200)), 'the enforcement mutation did not apply');
  });
  // The pod-end path must leave nothing painted either (it removes the node).
  const cleared = await (async () => {
    const page = makePage(SOURCE);
    page.video.style = {};
    page.video.muted = true;
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: CHANNEL });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    page.frameMsg(healthySt());
    await settle(20);
    const pageId = page.stats() && page.stats().pageId;
    page.bypass({ type: 'ad-hold', channel: CHANNEL, page: pageId });
    await settle(30);
    const shownAtHold = page.cover ? page.cover.style.display : null;
    page.bypass({ type: 'ad-end', page: pageId });
    await settle(200);
    const after = page.cover && page.cover.isConnected !== false ? page.cover.style.display : 'removed';
    return { shownAtHold, after };
  })();
  check('a pod that ends leaves no panel painted', () => {
    assert(cleared.shownAtHold === 'flex', `cover at hold=${cleared.shownAtHold}`);
    assert(cleared.after === 'none' || cleared.after === 'removed', `panel still painted: ${cleared.after}`);
  });

  const green = await arm(SOURCE, 'green');
  check('GREEN: cold-cover fires on the ad-hold tick', () => {
    assert(green.coverEvents.length >= 1, `no cold-cover; adlog=${JSON.stringify(green.events.map((e) => e.ev))}`);
    assert(green.coveredAt !== null && green.coveredAt <= 2000, `cover took ${green.coveredAt} ms, bound is 2000`);
    assert(green.coverEvents[0].d.reason === 'ad-hold', `reason=${green.coverEvents[0].d.reason}`);
  });
  check('GREEN: the hold freezes the picture instead of hiding it (no black screen)', () => {
    assert(green.nativeHiddenAtHold !== true, 'the native video was hidden on the hold tick — with the frame still hidden that is the black screen the owner photographed');
    assert(green.pausedAtHold === true, 'the native was not paused on the hold tick — the ad keeps playing under the notice');
    assert(green.frameOpacityAtHold !== '1', `frame was raised to opacity ${green.frameOpacityAtHold} before the source played — that is the second half of the black screen`);
  });
  check('GREEN: the hold paints black over the player, never a full-viewport rectangle', () => {
    assert(green.coverAtHold === 'flex', `cover panel display=${green.coverAtHold}`);
    assert(/carregando/.test(String(green.coverText)), `cover says: ${green.coverText}`);
    // Owner order 2026-11-11: the ad's first frames reach the screen GREEN, so
    // the hold paints them black - but only the player's own rect. `inset:0`
    // (the whole viewport) is still the defect this arm exists for.
    assert(!/inset:\s*0/.test(green.coverCss), `the cover is painted full-viewport (inset:0): ${green.coverCss}`);
    assert(/background:\s*#000/.test(green.coverCss) || /background-color:\s*#000/.test(green.coverCss),
      `the cover is not opaque black, so an ad's green frame shows through: ${green.coverCss}`);
  });
  check('GREEN: overlay-reveal lands inside the cold-cover window and swaps the surfaces', () => {
    assert(green.revealEvents.length >= 1, `no overlay-reveal; adlog=${JSON.stringify(green.events.map((e) => e.ev))}`);
    assert(green.revealedAt !== null && green.revealedAt < 3000, `reveal at ${green.revealedAt} ms, the hold bound is 3000`);
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
  check('RED-2 (2026-11-08 defect): a hold that hides the native is caught by the GREEN arm', () => {
    assert(black.coverEvents.length >= 1, 'the mutant did not reach the hold branch');
    assert(black.nativeHiddenAtHold === true, 'the mutant did not hide the native — it is not the reported defect');
    assert(black.coverAtHold === 'flex', `the mutant also lost the panel (${black.coverAtHold}); it must differ ONLY in hiding the native`);
  });

  // A background tab throttles the frame's heartbeat to one sample every
  // 10-30s (measured: `playing-not-healthy` 32s apart in the owner's
  // ko.adlog). The gate used to count three consecutive samples, so a healthy
  // clean player could never qualify there and the bound stopped it — the
  // black panel he photographed with the tab in the background.
  const sparse = await arm(SOURCE, 'sparse', { sparse: true });
  check('SPARSE: a throttled tab reveals on the single healthy sample it gets', () => {
    assert(sparse.revealEvents.length >= 1, `no overlay-reveal after one healthy sample; adlog=${JSON.stringify(sparse.events.map((e) => e.ev))}`);
    assert(sparse.frameOpacityAfterReveal === '1', `frame opacity after the sparse reveal = ${sparse.frameOpacityAfterReveal}`);
    assert(sparse.nativeHiddenAfterReveal === true, 'the native stayed over the revealed clean player');
  });

  // The sparse arm must FAIL with the old count-based gate, or it measures
  // nothing: put the three-tick requirement back and re-run it. The anchor is
  // the whole `need = …;` line, not its old text: the gate gained a term
  // (`|| progressed`, 0.8.117) and a literal-string anchor then silently stopped
  // applying, which is a vacuous arm rather than a red one.
  const needLine = 'const need = [^;\n]*;';
  const counted = new RegExp(needLine).test(SOURCE)
    ? SOURCE.replace(new RegExp(needLine), 'const need = 3; // pre-fix: count ticks')
    : SOURCE;
  check('the count-based mutation applied', () => {
    assert(counted !== SOURCE, 'the tick-count mutation did not apply');
  });
  const sparseRed = await arm(counted, 'sparse-red', { sparse: true });
  check('SPARSE-RED (pre-fix): a count-based gate never reveals on a throttled tab', () => {
    assert(sparseRed.revealEvents.length === 0, `the count-based gate still revealed: ${JSON.stringify(sparseRed.revealEvents)}`);
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
