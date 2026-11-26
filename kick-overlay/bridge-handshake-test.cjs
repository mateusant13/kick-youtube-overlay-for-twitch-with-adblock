// Handshake regression harness for player-bridge.js (KO-20261026-02).
//
// Measured 2026-10-26 in the guest Chrome: on a youtube.com watch page with
// player=kick the frame posted `ready` with targetOrigin
// "https://www.twitch.tv" (the old hardcoded default). A post to the wrong
// targetOrigin is dropped silently by the browser, so the content script never
// saw `ready`, never handed over the pending playback_url, the IVS player
// stayed Idle, and the 15s never-played watchdog tore the layer down. The
// primitive was measured too: frame->page with twitch.tv on a youtube.com
// parent = 0 deliveries; page->frame with '*' or with the extension origin =
// delivered.
//
// This harness runs the REAL player-bridge.js in a stubbed frame whose parent
// enforces targetOrigin the way the browser does (a post addressed to another
// origin is dropped, never delivered). It asserts the handshake from the
// frame's side only; nothing here needs the network or a browser.
//
// Negative arm: the same scenario runs against a copy that restores the
// pre-fix targeting (default origin twitch.tv, no '*'). If that copy still
// delivered `ready`, this detector would be measuring nothing.
'use strict';
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'player-bridge.js'), 'utf8');
const YOUTUBE = 'https://www.youtube.com';
const TOKEN = 'testtoken1234567890';

// Pre-fix code, expressed as two exact mutations of the current file.
const PRE_FIX_MUTATIONS = [
  ['let PARENT_ORIGIN = null; // learned from the first token-valid message', [
    'let PARENT_ORIGIN = null;',
    "let PARENT_ORIGIN = 'https://www.twitch.tv';",
  ]],
  ['const target = PARENT_ORIGIN || \'*\';', [
    'const target = PARENT_ORIGIN || \'*\';',
    'const target = PARENT_ORIGIN;',
  ]],
];

function preFixSource() {
  let out = SOURCE;
  for (const [from, [expected, replacement]] of PRE_FIX_MUTATIONS) {
    if (!out.includes(from)) {
      throw new Error(`the pre-fix mutation no longer applies (looked for: ${expected})`);
    }
    out = out.replace(from, replacement);
  }
  return out;
}

function makePlayer() {
  return {
    version: 'test',
    loadedUrl: null,
    muted: true,
    state: 'Idle',
    getVersion() { return this.version; },
    attachHTMLVideoElement() {},
    setAutoplay() {},
    getQuality() { return { name: '720p', width: 1280, height: 720 }; },
    getQualities() { return [{ name: '720p', width: 1280, height: 720 }]; },
    getDuration() { return Infinity; },
    getPosition() { return 10; },
    getBuffered() { return { end: 12 }; },
    getLiveLatency() { return 2; },
    getState() { return this.state; },
    isPaused() { return false; },
    isMuted() { return this.muted; },
    getVolume() { return this.muted ? 0 : 1; },
    addEventListener() {},
    load(url) { this.loadedUrl = url; this.state = 'Playing'; },
    play() {},
    pause() {},
    setMuted(m) { this.muted = !!m; },
    setVolume() {},
    seekTo() {},
    setAutoQualityMode() {},
    setQuality() {},
  };
}

// A frame document as the browser would give it: posts are delivered only when
// targetOrigin is '*' or matches the parent's real origin.
function makeFrame({ source = SOURCE, parentOrigin = YOUTUBE, token = TOKEN } = {}) {
  const delivered = [];
  const dropped = [];
  const listeners = {};
  const intervals = [];
  const player = makePlayer();

  const parent = {
    postMessage(msg, targetOrigin) {
      if (targetOrigin === '*' || targetOrigin === parentOrigin) delivered.push({ msg, targetOrigin });
      else dropped.push({ msg, targetOrigin });
    },
  };

  const window = {
    parent,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    IVSPlayerModule: { create: () => player, PlayerEventType: { ERROR: 'PlayerError' } },
  };
  const document = { getElementById: (id) => (id === 'v' ? { addEventListener() {}, readyState: 0 } : null) };
  const location = { search: `?token=${token}`, href: `chrome-extension://test/player.html?token=${token}` };
  const chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: (_msg, cb) => { if (cb) cb(); },
      lastError: null,
    },
  };
  const performance = { now: () => (performance.t = (performance.t || 0) + 1) };

  const run = new Function(
    'window', 'document', 'chrome', 'location', 'performance', 'parent',
    'setInterval', 'setTimeout', 'URLSearchParams', 'Date',
    source,
  );
  run(
    window, document, chrome, location, performance, parent,
    (fn) => { intervals.push(fn); return intervals.length; },
    () => 1,
    URLSearchParams,
    Date,
  );

  return {
    delivered,
    dropped,
    player,
    diag: window.__koBridgeDiag,
    // a message from the parent page arriving in the frame
    receive(payload, { origin = parentOrigin, fromParent = true, token: tok = token } = {}) {
      const ev = { data: { __koKick: { ...payload, _koToken: tok } }, origin, source: fromParent ? parent : {} };
      for (const fn of listeners.message || []) fn(ev);
    },
    // the frame's 1/s heartbeat
    tick() { for (const fn of intervals) fn(); },
    posts() { return delivered.map((d) => d.msg && d.msg.__koKick); },
    firstPost(type) { return this.posts().find((m) => m && m.t === type) || null; },
  };
}

let checks = 0;
let failed = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- 1. new code: ready reaches a youtube.com parent before any inbound ----
{
  const f = makeFrame();
  const ready = f.firstPost('ready');
  ok('new code: ready is delivered to a youtube.com parent', !!ready, JSON.stringify(f.delivered.map((d) => d.targetOrigin)));
  ok('new code: the first ready was addressed with * (origin not learned yet)', ready && f.diag.firstPost.ready.to === '*', f.diag.firstPost.ready.to);
  ok('new code: ready carries the page token', ready && ready._koToken === TOKEN);
  ok('new code: the frame reported it had not learned the parent', f.diag.parentLearnedAt === 0);
}

// ---- 2. negative arm: the pre-fix code must NOT deliver ready ----
{
  let f = null;
  let threw = null;
  try {
    f = makeFrame({ source: preFixSource() });
  } catch (e) {
    threw = e;
  }
  ok('negative arm: the pre-fix mutation applied', !threw, threw && threw.message);
  if (f) {
    const ready = f.firstPost('ready');
    ok('negative arm: the pre-fix code IS caught dropping ready', !ready, ready ? 'ready was delivered' : '');
    ok(
      'negative arm: it was dropped because it targeted https://www.twitch.tv',
      f.dropped.some((d) => d.msg && d.msg.__koKick && d.msg.__koKick.t === 'ready' && d.targetOrigin === 'https://www.twitch.tv'),
      JSON.stringify(f.dropped.map((d) => d.targetOrigin)),
    );
  }
}

// ---- 3. after one valid command the frame replies on the exact origin ----
{
  const f = makeFrame();
  f.receive({ t: 'load', url: 'https://example.invalid/stream.m3u8' });
  ok('learning: the frame learned the parent origin', f.diag.parentLearnedAt > 0 && f.diag.learnedFrom.origin === YOUTUBE, JSON.stringify(f.diag.learnedFrom));
  ok('learning: the command reached the player', f.player.loadedUrl === 'https://example.invalid/stream.m3u8');
  const before = f.delivered.length;
  f.tick();
  const after = f.delivered.slice(before);
  ok('learning: the heartbeat after learning is delivered', after.length > 0);
  ok('learning: the heartbeat uses the exact parent origin, not *', after.every((d) => d.targetOrigin === YOUTUBE), JSON.stringify(after.map((d) => d.targetOrigin)));
  ok('learning: ready was still posted exactly once', f.posts().filter((m) => m && m.t === 'ready').length === 1);
}

// ---- 4. a foreign origin cannot teach the frame the parent origin ----
{
  const f = makeFrame();
  f.receive({ t: 'load', url: 'https://example.invalid/evil.m3u8' }, { origin: 'https://evil.example' });
  ok('guard: a foreign origin is rejected', f.diag.inbound.rejected === 1 && f.diag.parentLearnedAt === 0, JSON.stringify(f.diag.inbound));
  ok('guard: the rejected command never reached the player', f.player.loadedUrl === null);
  f.tick();
  ok('guard: posts keep * instead of a forged origin', f.diag.parentOrigin === null && f.delivered.every((d) => d.targetOrigin === '*'));
}

// ---- 5. a wrong token cannot teach the frame either ----
{
  const f = makeFrame();
  f.receive({ t: 'load', url: 'https://example.invalid/spoof.m3u8' }, { token: 'wrongtoken' });
  ok('guard: a wrong token is rejected', f.diag.inbound.rejected === 1 && f.diag.parentLearnedAt === 0, JSON.stringify(f.diag.inbound));
  ok('guard: the spoofed command never reached the player', f.player.loadedUrl === null);
  ok('guard: the right token then still works', (() => {
    f.receive({ t: 'load', url: 'https://example.invalid/ok.m3u8' });
    return f.player.loadedUrl === 'https://example.invalid/ok.m3u8';
  })());
}
// ---- 6. the standby's first rung fits the frame, not the lowest bitrate ----
// Owner ring 0.8.115: both reveals in one page load reported q:"360p" on a
// 1280x720 player. MANIFEST_PARSED used to set startLevel to the lowest
// bitrate rung; a ladder fixture makes that pick observable as `standby-level`.
const HLS_LEVELS = [
  { height: 720, width: 1280, bitrate: 1400000 },
  { height: 480, width: 854, bitrate: 800000 },
  { height: 360, width: 640, bitrate: 450000 },
  // The TOP rung is deliberately NOT the rung a 695px frame picks, so "no layout
  // -> top rung" is a different answer from "695px -> 720p".
  { height: 1080, width: 1920, bitrate: 6000000 },
];
function makeHlsFrame({ source = SOURCE, height = 695, seekableEnd = 0 } = {}) {
  const delivered = [];
  const listeners = {};
  const intervals = [];
  const video = {
    controls: false, muted: false, readyState: 4, currentTime: 10,
    addEventListener() {}, play() { return Promise.resolve(); }, pause() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1236, height }),
    buffered: { length: 0 }, seekable: seekableEnd ? { length: 1, start: () => 0, end: () => seekableEnd } : { length: 0 },
  };
  class Loader { load() {} }
  class Hls {
    constructor(config) {
      this.config = config;
      this.levels = [];
      this.currentLevel = -1;
      this.startLevel = -1;
      this.latency = 3;
      this.handlers = {};
      Hls.last = this;
    }
    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    emit(name, data) { for (const fn of this.handlers[name] || []) fn(name, data); }
    loadSource(url) { this.loadedUrl = url; }
    attachMedia(v) { this.media = v; }
  }
  Hls.DefaultConfig = { loader: Loader };
  Hls.Events = { MANIFEST_PARSED: 'manifestParsed', LEVEL_LOADED: 'levelLoaded', ERROR: 'error' };
  const parent = { postMessage(msg, targetOrigin) { delivered.push({ msg, targetOrigin }); } };
  const window = { parent, addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, Hls };
  const document = { getElementById: (id) => (id === 'v' ? video : null) };
  const location = { search: `?m=hls&tw=1&token=${TOKEN}`, href: `chrome-extension://test/player.html?m=hls&tw=1&token=${TOKEN}` };
  const diags = [];
  const chrome = { runtime: { getURL: (p) => `chrome-extension://test/${p}`, sendMessage: (m, cb) => { if (m && m.__koDiag) diags.push(m.__koDiag); if (cb) cb(); }, lastError: null } };
  const run = new Function('window', 'document', 'chrome', 'location', 'performance', 'parent', 'Hls',
    'setInterval', 'setTimeout', 'URLSearchParams', 'Date', source);
  run(window, document, chrome, location, { now: () => 1 }, parent, Hls,
    (fn) => { intervals.push(fn); return intervals.length; }, () => 1, URLSearchParams, Date);
  return {
    hls: Hls.last,
    levelRow() { return delivered.map((d) => d.msg && d.msg.__koKick).find((m) => m && m.e === 'standby-level'); },
    video, diags,
    receive(payload) {
      for (const fn of listeners.message || []) fn({
        data: { __koKick: { ...payload, _koToken: TOKEN } }, origin: YOUTUBE, source: parent,
      });
    },
  };
}
function startLevelArm(src, height) {
  const f = makeHlsFrame({ source: src, height });
  f.hls.emit('manifestParsed', { levels: HLS_LEVELS });
  const row = f.levelRow();
  if (!row) throw new Error('no standby-level row was posted');
  return { row, startLevel: f.hls.startLevel };
}
try {
  const green = startLevelArm(SOURCE, 695);
  ok('a 695px frame starts at the 720p rung, not the lowest bitrate', green.row.d.name === '720p' && green.startLevel === 0, JSON.stringify(green));
  const small = startLevelArm(SOURCE, 360);
  ok('a 360px frame still starts at 360p', small.row.d.name === '360p' && small.startLevel === 2, JSON.stringify(small));
  // A RECT OF ZERO IS NOT A SMALL PLAYER: a standby iframe that has not been laid
  // out reports height 0, and `lh >= 0` is true for the lowest rung - which is
  // how a 1236x695 player opened at 360p (`overlay-reveal {q:"360p"}`).
  const unlaid = startLevelArm(SOURCE, 0);
  ok('a frame with no layout yet starts at the top rung, not the lowest bitrate',
    unlaid.row.d.name === '1080p' && unlaid.startLevel === 3 && unlaid.row.d.why === 'no-rect'
    && unlaid.row.d.rectH === 0 && unlaid.row.d.count === 4, JSON.stringify(unlaid));
  // THE ROW MUST PRINT THE LADDER, not a count of it. A reader holding
  // `count:2, name:'360p'` cannot tell a geometry-correct pick from a mint that
  // only ever carried 360p (the seat's 2026-11-26 measurement came back
  // `count:2, rectH:325, why:'rect'` and could not answer which rungs existed).
  // `rungs` is the same measurement, printed instead of hidden.
  ok('the level row prints the ladder, so a 360p pick is readable without a reveal',
    Array.isArray(unlaid.row.d.rungs) && unlaid.row.d.rungs.length === 4
    && unlaid.row.d.rungs.includes(1080) && unlaid.row.d.rungs.includes(360)
    // The contract: `chosen` indexes the printed ladder, so `name` must be that
    // rung's height. An order-pinned assertion would test the fixture instead.
    && `${unlaid.row.d.rungs[unlaid.row.d.chosen]}p` === unlaid.row.d.name
    && `${green.row.d.rungs[green.row.d.chosen]}p` === green.row.d.name,
    JSON.stringify({ unlaid: unlaid.row.d, green: green.row.d }));
} catch (e) {
  ok('the start-rung arm ran', false, String(e && e.message));
}
{
  let red = null;
  try {
    red = startLevelArm(SOURCE.replace(
      'if (rectOk && lh >= height && lh < bestH) { bestH = lh; chosen = i; }',
      'if (Number((levels[i] || {}).bitrate) < bestH) { bestH = Number((levels[i] || {}).bitrate); chosen = i; }',
    ), 695);
  } catch (e) {
    ok('RED mutation applied', false, String(e && e.message));
  }
  ok('RED: the pre-fix lowest-bitrate pick is caught at 360p', red && red.row.d.name === '360p' && red.startLevel === 2, JSON.stringify(red));
}
{
  // RED: the layout floor removed -> a zero rect is read as a zero-height player
  // and the smallest rung wins. The arm asserts the CONTRACT (top rung), not the
  // mutant's own row.
  let red = null;
  try {
    red = startLevelArm(SOURCE.replace('const MIN_LAYOUT_H = 120;', 'const MIN_LAYOUT_H = 0;'), 0);
  } catch (e) {
    ok('RED mutation applied', false, String(e && e.message));
  }
  // Same shape as the RED above: the mutant must reproduce the defect the green
  // arm refuses (360p for a zero rect), which is what makes the arm a detector.
  ok('RED: without the layout floor a zero rect reproduces the 360p pick',
    red && red.row.d.name === '360p' && red.startLevel === 2 && red.row.d.why === 'rect', JSON.stringify(red));
}

// ---- Item 1: a user seek disarms the load's pending retry ------------------
{
  const f = makeFrame();
  const seeks = [];
  f.player.seekTo = (s) => { seeks.push(s); f.player.getPosition = () => s; };
  f.receive({ t: 'load', url: 'https://ivs.example/live', seekTo: 400 });
  f.tick();
  ok('item 1: the pending load seek is applied before the drag', seeks.includes(400), JSON.stringify(seeks));
  const before = seeks.length;
  f.receive({ t: 'seek', s: 42 });
  f.tick();
  ok('item 1: a user seek owns the playhead, no old load seek after it',
    seeks.slice(before).length === 1 && !seeks.slice(before).includes(400), JSON.stringify(seeks));
  const redFrame = makeFrame({ source: SOURCE.replace('          pendingSeek = null;\n          pendingTries = 0;\n', '') });
  const redSeeks = [];
  redFrame.player.seekTo = (s) => { redSeeks.push(s); redFrame.player.getPosition = () => s; };
  redFrame.receive({ t: 'load', url: 'https://ivs.example/live', seekTo: 400 });
  redFrame.tick();
  const redBefore = redSeeks.length;
  redFrame.receive({ t: 'seek', s: 42 });
  redFrame.tick();
  ok('RED item 1: without the clear, the next heartbeat drags back to the load offset',
    redSeeks.slice(redBefore).includes(400), JSON.stringify(redSeeks));
}

// ---- Item 4: the seekable sentinel is never used as a seek target ----------
{
  const f = makeHlsFrame({ seekableEnd: 1073741824 });
  f.receive({ t: 'seekToLive' });
  ok('item 4: a sentinel seekable end never moves the playhead', f.video.currentTime === 10, `ct=${f.video.currentTime}`);
  ok('item 4: the refusal row prints the sentinel and its limit',
    f.diags.some((d) => d && d.ev === 'seek-refused' && d.data.se === 1073741824 && d.data.limit === 1000000),
    JSON.stringify(f.diags));
  const red = makeHlsFrame({ seekableEnd: 1073741824, source: SOURCE.replace('            const seReal = isFinite(se) && se > 0 && se < 1e6;', '            const seReal = isFinite(se) && se > 0;') });
  red.receive({ t: 'seekToLive' });
  ok('RED item 4: restoring the pre-fix guard derives 1073741821', red.video.currentTime === 1073741821,
    `ct=${red.video.currentTime}`);
}

console.log(`\nRESULT ${failed ? 'FAIL' : 'PASS'} bridge-handshake checks=${checks} failed=${failed}`);
process.exit(failed ? 1 : 0);
