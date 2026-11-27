// Behavioral harness for the kick-overlay content.js fixes (injectStyles,
// ensureYtHls TTL/backoff, yt fallback GATE + non-persisting handover, URL
// reload, #ko-status chip + <=4-char badge tokens, sticky tw_delete via
// MutationObserver, yt frame-death watchdog). Runs the real content.js source
// with a stubbed DOM/chrome environment and asserts on observable behavior.
// `node content-fix-test.cjs` (no frameworks).
'use strict';
const fs = require('fs');
const assert = require('assert');

// The timer-heavy arms run on the virtual clock (see _tools/test-clock.cjs):
// content.js resolves setTimeout/setInterval/Date from the host global, so the
// host exposes the clock and every wait ADVANCES the timeline instead of
// sleeping on it. KO_REAL_CLOCK=1 restores the old wall-clock timeline so any
// arm suspected of depending on virtual time is re-measured as before.
const realSetTimeout = global.setTimeout.bind(global);
const realSetImmediate = global.setImmediate.bind(global);
const clock = require('../_tools/test-clock.cjs');
global.setTimeout = clock.setTimeout;
global.clearTimeout = clock.clearTimeout;
global.setInterval = clock.setInterval;
global.clearInterval = clock.clearInterval;
global.Date = clock.Date;
if (global.performance) global.performance.now = clock.performance.now;
const drain = () => new Promise((resolve) => realSetImmediate(resolve));

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
assert.ok(manifest.host_permissions.includes('https://kick.com/*'), 'manifest permits Kick API fetches');
const CS_ENTRY = (manifest.content_scripts || []).find((c) => (c.js || []).includes('content.js'));
assert.ok(CS_ENTRY, 'manifest registers content.js as a content script');
const CS_MATCHES = CS_ENTRY.matches;
assert.ok(Array.isArray(CS_MATCHES), 'manifest has content_scripts[0].matches');
assert.ok(CS_MATCHES.includes('https://www.twitch.tv/*'), 'content script runs on www.twitch.tv');
assert.ok(CS_MATCHES.includes('https://www.youtube.com/*'), 'content script runs on www.youtube.com');
assert.ok(CS_MATCHES.includes('https://m.youtube.com/*'), 'content script runs on m.youtube.com');
assert.ok(CS_MATCHES.includes('https://youtu.be/*'), 'content script runs on youtu.be');
const WAR = manifest.web_accessible_resources && manifest.web_accessible_resources[0] && manifest.web_accessible_resources[0].matches;
assert.ok(Array.isArray(WAR), 'manifest has web_accessible_resources[0].matches');
assert.ok(WAR.includes('https://www.youtube.com/*'), 'player.html is web-accessible from www.youtube.com');
assert.ok(WAR.includes('https://m.youtube.com/*'), 'player.html is web-accessible from m.youtube.com');
assert.ok(WAR.includes('https://youtu.be/*'), 'player.html is web-accessible from youtu.be');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'manifest version is semver');
const swCalls = []; // chrome.runtime.sendMessage recorder
const badgeTexts = []; // chrome.action.setBadgeText recorder (clipping check)
const badge = []; // paired {text,color} records — the 0.8.2 status contract
let lastBadgeColor = null;
const runtimeMsgListeners = []; // chrome.runtime.onMessage recorders
const moInstances = []; // MutationObserver instances (tw-delete re-apply)
const fakeVideos = []; // page-world <video> population (twitch player)
let fakeFrame = null;
const storage = { ko: undefined }; // the single 'ko.v2' record
let storageChangedListener = null; // chrome.storage.onChanged listener
const framePosts = []; // postMessage sent to the fake yt frame
const appends = []; // elements appended to document.head

// Live id registry. content.js re-finds the YouTube frame with
// document.getElementById('ko-yt') and the Twitch player via querySelector, so
// a mounted frame must be findable — and forgetable on remove(). The eager
// dual-mount and the no-teardown class-flip contracts both hinge on this.

const byId = new Map();
const unregister = (n) => {
  if (n && n.id && byId.get(n.id) === n) byId.delete(n.id);
  (n.children || []).forEach(unregister);
};

// Set-backed classList: 0.8.2 reports state through classes (ko-kick/ko-yt/
const mkClassList = (owner) => {
  const set = new Set();
  const sync = () => { owner.className = [...set].join(' '); };
  return {
    _set: set,
    add(...c) { c.forEach((x) => set.add(x)); sync(); },
    remove(...c) { c.forEach((x) => set.delete(x)); sync(); },
    contains: (c) => set.has(c),
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      sync();
      return on;
    },
  };
};

const el = (tag) => {
  let id = '';
  const node = {
    tag,
    tagName: (tag || 'div').toUpperCase(),
    nodeType: 1,
    innerHTML: '',
    style: {},
    dataset: {},
    className: '',
    attrs: {},
    isConnected: true,
    removed: 0,
    contentWindow: null,
    children: [],
    listeners: {},
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      unregister(c);
      return c;
    },
    remove() { this.removed = (this.removed || 0) + 1; this.isConnected = false; unregister(this); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 60 }),
    getClientRects: () => [],
    querySelector: () => el('div'), // mount() wires buttons from inner queries
    querySelectorAll: () => [],
    click() { (this.listeners.click || []).forEach((f) => f({ target: this, preventDefault() {}, stopPropagation() {} })); },
  };
  node.classList = mkClassList(node);
  Object.defineProperty(node, 'id', {
    get: () => id,
    set: (v) => { id = String(v); if (id) byId.set(id, node); },
    enumerable: true,
  });
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); node.children.length = 0; }, // rebuild-from-empty
    enumerable: true,
  });
  return node;
};

// A page <video> (the Twitch player). remove() also drops it from the DOM
// population, mirroring reality (twitchVideo() must stop seeing it).
const videoEl = (id) => ({
  ...el('video'),
  id,
  paused: true,
  readyState: 4,
  currentTime: 10,
  muted: false,
  getClientRects: () => [{}],
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 60 }),
  pause() { this.paused = true; },
  play() { this.paused = false; return Promise.resolve(); },
  remove() {
    this.removed = (this.removed || 0) + 1;
    this.isConnected = false;
    const i = fakeVideos.indexOf(this);
    if (i >= 0) fakeVideos.splice(i, 1);
  },
});

// Page-level selectors the content script queries on the HOST page (YouTube's
// player element, the watch-page channel-identity metadata). Driven per test.
const pageSel = new Map();
const setPageSel = (sel, node) => { if (node === null) pageSel.delete(sel); else pageSel.set(sel, node); };
const clearPageSel = () => pageSel.clear();

const doc = {
  head: { appendChild: (x) => appends.push(x) },
  documentElement: el('html'),
  body: el('body'),
  hidden: false,
  hasFocus: () => true,
  fullscreenElement: null,
  createElement: (t) => el(t),
  getElementById: (id) => (id === 'ko-yt' && fakeFrame ? fakeFrame : byId.get(id) || null),
  querySelector: (sel) => pageSel.get(sel) || null,
  querySelectorAll: (sel) => (sel === 'video' ? fakeVideos : []),
  // Document listeners are RECORDED, not dropped: an arm that must prove a
  // boundary (visibilitychange, keydown) has to dispatch the real event into
  // the real handler, or it can only assert against source text — the shape
  // that let the 2026-11-13 freeze pass a green suite.
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  removeEventListener(t, fn) {
    const l = docListeners[t];
    if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  },
};
const docListeners = Object.create(null);
const fireDoc = (t, ev) => (docListeners[t] || []).forEach((fn) => fn(ev || { type: t, target: doc }));

let manifestVersion = require('./manifest.json').version;
const reloads = [];
const chromeStub = {
  runtime: {
    getManifest: () => ({ version: manifestVersion }),
    sendMessage: (m, cb) => {
      swCalls.push(m);
      if (m && m.type === 'ko-yt-play') {
        const rr = { url: 'https://hls.example/u1' };
        realSetTimeout(() => cb && cb(rr), 0);
      } else {
        cb && cb({ ok: true });
      }
    },
    lastError: null,
    onMessage: { addListener: (l) => runtimeMsgListeners.push(l) },
    getURL: (p) => 'chrome-extension://test/' + p,
  },
  storage: {
    local: {
      // Single mutable object: tests write it to simulate another tab or the
      // popup pushing a new settings table.
      get: (k, cb) => realSetTimeout(() => cb && cb(storage.ko === undefined ? {} : { [k]: storage.ko }), 0),
      set: (o, cb) => { storage.ko = o['ko.v2']; cb && cb(); },
    },
    // FIRST-WINS: the harness loads content.js twice (main api + mountApi at
    // section K). Tests that fire the listener drive the MAIN module's state
    // (KO from line ~220) — the second load must not hijack the handle.
    onChanged: { addListener: (l) => { if (!storageChangedListener) storageChangedListener = l; } },
  },
  action: {
    // setBadge() always sets the colour BEFORE the text, so pairing the last
    // colour with the emitted text records the exact call.
    setBadgeText(o) { badgeTexts.push(o && o.text); badge.push({ text: o && o.text, color: lastBadgeColor }); },
    setBadgeBackgroundColor({ color }) { lastBadgeColor = color; },
  },
  tabs: { query: () => Promise.resolve([]) },
};
global.chrome = chromeStub;
const sessionStore = new Map();
global.sessionStorage = { getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null), setItem: (k, v) => sessionStore.set(k, String(v)) };
global.window = global; // content.js binds window listeners — alias to global
global.document = doc;
global.innerWidth = 1280;
global.innerHeight = 720;
global.location = { pathname: '/rodil', search: '', href: 'https://www.twitch.tv/rodil', hash: '', reload: () => reloads.push(Date.now()) };
const msgListeners = [];
global.addEventListener = (t, l) => { if (t === 'message') msgListeners.push(l); };
global.removeEventListener = () => {};
global.MutationObserver = class {
  constructor(cb) { this.cb = cb; moInstances.push(this); }
  observe(target, opts) { this.target = target; this.opts = opts; }
  disconnect() {}
};
// rectTick's one-shot anomaly dump reads computed styles; the harness never
// gives the wrap an offsetHeight, so the dump stays cold — the stub exists so a
// future fixture that does set one cannot throw.
global.getComputedStyle = () => ({ height: '', maxHeight: '', position: 'static' });
// kick.com is 403-gated from this IP; the content script catches fetch
// failures internally, so a rejecting stub keeps the boot probe deterministic.
global.fetch = () => Promise.reject(new Error('stub-fetch'));

const src = fs.readFileSync('content.js', 'utf8').replace(/\r\n/g, '\n'); // RED mutations are LF literals
assert.ok(
  src.includes(`const KO_VER = '${manifest.version}'`),
  `content KO_VER is aligned with the manifest version (${manifest.version}); a half-bump would drift green`,
);
const bridgeSrc = fs.readFileSync('player-bridge.js', 'utf8');
// Run in a Function scope so top-level consts/functions are accessible.
const scope = {};
const fn = new Function('window', 'document', 'location', 'navigator', src + '\n;return {KO, probe, apply, ensureYtHls, injectStyles, teardown, setPlayer, saveState, ' +
  'loadState, rectTick, rectFromHost, currentSlug, resolveYtPageKick, ensureYtIframe, ensureKick, showKickLayer, showYtLayer, hideWrap, hideWrapForProbe, ' +
  'renderQualityMenu, mount, updateKickBar, seekOverlayStep, onOverlayKeydown, syncMute, overlayOwnsPicture, visibleSurface, dispSample};');
const api = fn(global, doc, global.location, global.navigator);
const KO = api.KO;

// One real macrotask turn: the chrome stub answers on the REAL clock (as Chrome
// does), so the virtual advance alone cannot see its reply.
const flushReal = async () => {
  await new Promise((resolve) => realSetTimeout(resolve, 0));
  await drain();
};
// Advance the timeline, then let the real turns and the newly-due virtual
// timers converge. Four rounds is the depth a mint -> reply -> follow-up chain
// needs (measured: one round left the re-mint's url unset).
const settle = async (ms) => {
  await clock.advance(Number(ms) || 0);  // REAL mode: this is a real sleep
  for (let i = 0; i < 4; i += 1) { await flushReal(); clock.advance(0); }
};
// Every console.log is recorded: the anti-vacuity check at the end of the run
// proves each expected arm actually executed.
const armLog = [];
const realLog = console.log.bind(console);
console.log = (...a) => { armLog.push(a.join(' ')); realLog(...a); };
// The last badge emission. setBadge() ALWAYS sets the colour first, so the
// pair is the exact call (0.8.2 carries the phase in the colour, not in text).
const lastBadge = () => badge[badge.length - 1] || { text: null, color: null };

(async () => {
  await settle(400); // let init() + first fire(apply) settle

  // ---- A: injectStyles actually injects the <style> -------------------------
  const styleEl = appends.find((e) => e.id === 'ko-style');
  assert.ok(styleEl, 'ko-style must be appended to document.head');
  assert.ok(!styleEl.textContent.includes('appendChild(st)'), 'CSS must not contain the stray appendChild text');
  assert.ok(styleEl.textContent.includes('#ko-wrap{position:fixed'), 'CSS body present');
  // 0.8.1 lineage deliberately removed the persistent top-left LIVE chip (#ko-top);
  // 0.8.2 hides the bar on inactivity. Assertions ported from the 0.8.0 chip/always-visible era.
  assert.ok(!src.includes('ensureStatusChip') && !src.includes("'#ko-top{"), 'no status chip in 0.8.1+ lineage');
  // 0.8.6 (owner pain 3): the modern return-to-live control is NOT the dead
  // #ko-top chip — the shipped clickable LIVE pill is the #ko-golive button
  // created in mount() (markup asserts its own presence/click later in P3).
  assert.ok(src.includes("<button id=\"ko-golive\""), 'mount ships the clickable #ko-golive LIVE pill');
  assert.ok(styleEl.textContent.includes('#ko-golive{'), 'LIVE pill has visible styling');
  assert.ok(styleEl.textContent.includes('#ko-bar{position:absolute;left:0;right:0;bottom:0;pointer-events:auto;opacity:1;'), 'control bar defaults visible');
  assert.ok(styleEl.textContent.includes('#ko-wrap:not(.ko-hot):not(.ko-hot-lock) #ko-bar{opacity:0;pointer-events:none;}'), 'bar auto-hides after inactivity (2.6s hot timer) and stays up while the pointer is on it (ko-hot-lock)');
  assert.ok(!styleEl.textContent.includes('#ko-wrap:not(.ko-hot) #ko-bar{opacity:1;}'), 'stale always-visible bar rule purged');
  assert.ok(styleEl.textContent.includes('#ko-quality-menu{display:none;'), 'quality menu CSS present');
  assert.ok(styleEl.textContent.includes('flex-direction:column;'), 'quality menu is vertical (column)');
  assert.ok(styleEl.textContent.includes('#ko-quality-wrap.ko-open #ko-quality-menu{display:flex;}'), 'quality menu opens via ko-on class');
  assert.ok(styleEl.textContent.includes('#ko-seekbar{position:absolute;top:6px;'), 'seek bar contained inside bar');
  assert.ok(!styleEl.textContent.includes('top:-28px'), 'seek bar no longer extends above bar');
  assert.ok(src.includes("document.addEventListener('keydown', onOverlayKeydown, true)"), 'F key capture listener present');
  assert.ok(src.includes('e.stopImmediatePropagation()'), 'overlay F handler wins over Twitch fullscreen');

  // A source substring can survive a dead handler. Dispatch the real capture
  // listener: when the overlay is selected, F must stop Twitch's handler.
  const keyWrap = el('div');
  keyWrap.requestFullscreen = () => Promise.resolve();
  const savedWrap = KO.wrap;
  const savedPlayer = KO.player;
  KO.wrap = keyWrap;
  KO.player = 'kick';
  let stopped = 0;
  (docListeners.keydown || []).forEach((fn) => fn({
    key: 'f', target: doc,
    preventDefault() {},
    stopImmediatePropagation() { stopped++; },
  }));
  assert.strictEqual(stopped, 1, 'the live keydown handler stops immediate propagation');
  KO.wrap = savedWrap;
  KO.player = savedPlayer;
  // 0.8.47: the property is GONE from every builder. With an `allow` attribute
  // present Chrome logs "Allow attribute will take precedence over
  // 'allowfullscreen'" on each frame, and the attribute already carries
  // fullscreen (owner console 2026-11-07).
  assert.ok(!src.includes('allowFullscreen = true'), 'no builder sets the redundant allowFullscreen property');
  assert.ok(src.includes("allow', 'autoplay; fullscreen; encrypted-media'") || src.includes("allow', 'autoplay; fullscreen"), 'the allow attribute carries fullscreen');
  // 0.8.50: the tick pauses ONLY a playing native and records ownership per
  // element (a video the user parked is not ours to resume).
  assert.ok(src.includes('if (v.paused) continue;') && src.includes('KO.twPaused.add(v);'), 'native Twitch video is paused under overlay (only the ones actually playing, ownership recorded)');
  assert.ok(bridgeSrc.includes("case 'quality':") && bridgeSrc.includes('setAutoQualityMode'), 'quality command reaches both player engines');
  console.log('A injectStyles: style appended, bar/seek/offline CSS — OK');

  // ---- C: ensureYtHls TTL + backoff -----------------------------------------
  KO.slug = 'rodil';
  KO.ytRaw = '@x';
  KO.ytId = 'UCxxxxxxxxxxxxxxxxxxxxxx';
  KO.ytHlsUrl = null;
  KO.ytHlsAt = 0;
  KO.ytHlsFailed = false;
  KO.ytHlsFailedAt = 0;
  const before = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  await api.ensureYtHls();
  assert.strictEqual(KO.ytHlsUrl, 'https://hls.example/u1', 'mint sets the url');
  assert.strictEqual(KO.ytHlsFailed, false, 'mint clears the failed flag');
  await api.ensureYtHls(); // immediate second call
  let after = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  assert.strictEqual(after - before, 1, 'fresh mint must not re-hit the background (TTL)');
  // failure backoff: failed 5s ago -> no retry
  KO.ytHlsFailed = true; KO.ytHlsFailedAt = Date.now() - 5000; KO.ytHlsUrl = null;
  await api.ensureYtHls();
  after = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  assert.strictEqual(after - before, 1, 'hard-fail backoff must not re-hit the background');
  // backoff expired -> retry clears the flag
  KO.ytHlsFailedAt = Date.now() - 31000;
  await api.ensureYtHls();
  after = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  assert.strictEqual(after - before, 2, 'expired backoff must re-mint');
  assert.strictEqual(KO.ytHlsFailed, false, 'successful retry clears the failed flag');
  console.log('C ensureYtHls: TTL dedupe + failure backoff + retry — OK');

  // ---- B/D: probe youtube branch — fallback gate + URL reload ---------------
  const wrap = {
    style: { display: 'none' },
    // Real set-backed classList: showKickLayer/showYtLayer report the active
    // layer through ko-kick/ko-yt, and the class-flip contract asserts on it.
    classList: null,
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 60 }),
    isConnected: true,
    offsetWidth: 100, offsetHeight: 60,
  };
  wrap.classList = mkClassList(wrap);
  wrap.classList.add('ko-kick');
  fakeFrame = { ...el('iframe'), contentWindow: { postMessage: (m) => framePosts.push(m) } };
  fakeFrame.dataset.koToken = 'test-token';
  KO.wrap = wrap;
  KO.player = 'youtube';
  KO.kickSlug = 'rodil';
  KO.ytState.ready = true;
  KO.ytState.live = false;
  KO.ytEmbedAt = Date.now();
  KO.ytHlsUrl = 'https://hls.example/u1';
  KO.ytHlsAt = Date.now();
  KO.ytHlsFailed = false;
  KO.ytHlsFailedAt = 0;
  KO.ytLoadedUrl = 'https://hls.example/u0'; // frame holds a STALE url

  badge.length = 0;
  // A real frame reports in with a token-valid message (and Chrome fires its
  // `load`); that is the ready gate ytSend() queues behind (0.8.47). Deliver it
  // the way the page receives it, or every command stays held and this arm
  // measures the stub instead of the product.
  const ytf = document.getElementById('ko-yt');
  msgListeners.forEach((listener) => listener({
    source: ytf.contentWindow,
    origin: new URL(chromeStub.runtime.getURL('player.html')).origin,
    data: { __koKick: { t: 'ready', _koToken: ytf.dataset.koToken } },
  }));
  await api.probe();
  const bD = lastBadge();
  assert.strictEqual(bD.text, 'YT', 'the running yt layer badges YT');
  assert.strictEqual(bD.color, '#ff0000', 'red = the layer is live/loaded and showing');
  const loadMsg = framePosts.find((m) => m.__koKick && m.__koKick.t === 'load');
  assert.ok(loadMsg, 'probe must hand the refreshed url to the frame');
  assert.strictEqual(loadMsg.__koKick._koToken, 'test-token', 'player commands must carry the frame token');
  assert.strictEqual(loadMsg.__koKick.url, 'https://hls.example/u1', 'load carries the NEW url');
  assert.strictEqual(KO.ytLoadedUrl, 'https://hls.example/u1', 'ytLoadedUrl tracks the handed url');
  assert.strictEqual(wrap.style.display, 'block', 'ready+loaded layer must be shown (transition grace)');
  assert.strictEqual(KO.player, 'youtube', 'no fallback while the layer is recoverable');
  console.log('D probe: refreshed url reloaded into the live frame, layer shown — OK');

  // fatal error after the frame's one reload — same-handle kickSlug: the
  // fallback gate must KEEP youtube mode (a same-handle kick is no real
  // kick mapping — its probe would find the same offline channel).
  framePosts.length = 0;
  KO.ytHlsFailed = true;
  // The bridge gets one automatic reload first: a fatal error is only a dead
  // url after the 4s reload grace (content.js ytHardFail).
  KO.ytHlsFailedAt = Date.now() - 5000;
  KO.ytLoadedUrl = 'https://hls.example/u1';
  KO.ytState = { ready: false, playing: false, muted: true, live: false, dur: 0, ct: 0, error: 0 };
  KO.ytEmbedAt = Date.now() - 10000; // embed grace expired too
  badge.length = 0;
  await api.probe();
  const bFail = lastBadge();
  assert.strictEqual(bFail.text, 'YT', 'a failed yt layer badges YT (0.8.1+ has no in-page chip)');
  assert.strictEqual(bFail.color, '#6b7280', 'gray = the mint/embed failed, not merely connecting');
  assert.strictEqual(KO.player, 'youtube', 'same-handle kickSlug must NOT hand over to kick');
  assert.ok(!framePosts.some((m) => m.__koKick && m.__koKick.t === 'load'), 'no load sent after fatal error');
  assert.strictEqual(wrap.style.display, 'none', 'failed yt layer hides the wrap (the badge carries the state)');
  // A REAL kick mapping (kickSlug != slug) DOES hand over — in memory only.
  storage.ko = undefined;
  KO.kickSlug = 'realkick';
  // tryKickFallback is debounced to one attempt per 5s; the same-handle arm
  // above just spent it.
  KO.ytKickFallbackAt = 0;
  global.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({ livestream: { playback_url: 'https://ivs.example/live', id: 's1' } }),
  });
  await api.probe();
  await settle(50); // the fire(apply) handover probe settles
  assert.strictEqual(KO.player, 'kick', 'real kick mapping hands over to kick');
  assert.ok(!(storage.ko && storage.ko.player === 'kick'), 'handover must not persist to storage');
  assert.strictEqual(wrap.style.display, 'block', 'kick layer shown after the handover');
  global.fetch = () => Promise.reject(new Error('stub-fetch'));
  KO.kickSlug = 'rodil';
  KO.kickFrame = null;
  KO.kickWin = null;
  KO.activeUrl = null;
  console.log('B probe: fallback gate — same-handle stays youtube, real mapping hands over w/o persisting — OK');

  // ---- G: kick frame ready only from the actual frame -----------------------
  // A source substring can survive a dead guard. Deliver a spoofed ready with
  // the right origin but the WRONG window through the registered listener.
  const gFrame = el('iframe');
  gFrame.contentWindow = { postMessage() {} };
  KO.kickFrame = gFrame;
  KO.kickReady = false;
  KO.kickWin = null;
  const gOrigin = new URL(chromeStub.runtime.getURL('player.html')).origin;
  msgListeners.forEach((listener) => listener({
    data: { __koKick: { t: 'ready' } },
    origin: gOrigin,
    source: { postMessage() {} }, // a page-world spoofer, not KO.kickFrame.contentWindow
  }));
  assert.strictEqual(KO.kickReady, false, 'a spoofed ready from another window cannot declare the kick frame ready');
  assert.strictEqual(KO.kickWin, null, 'and cannot capture kickSend');
  console.log('G kick ready: source-guarded against non-frame windows — OK (spoofed message refused)');

  // ---- teardown resets the new fields ---------------------------------------
  KO.ytHlsUrl = 'u'; KO.ytHlsAt = 1; KO.ytHlsFailed = true; KO.ytHlsFailedAt = 2; KO.ytLoadedUrl = 'u';
  KO.lastYtSt = 123;
  // The wrap/frames are 0.8.2's only in-page state surface; teardown must drop
  // them while leaving the iframe-identity counter alone (frameSeq only ever
  // moves forward — the status hook compares it across a flip).
  KO.wrap = el('div');
  KO.kickFrame = el('iframe');
  const seqBeforeTeardown = KO.frameSeq;
  api.teardown();
  assert.strictEqual(KO.ytHlsUrl, null);
  assert.strictEqual(KO.ytHlsAt, 0);
  assert.strictEqual(KO.ytHlsFailed, false);
  assert.strictEqual(KO.ytHlsFailedAt, 0);
  assert.strictEqual(KO.ytLoadedUrl, null);
  assert.strictEqual(KO.lastYtSt, 0, 'teardown resets the yt silence clock');
  assert.strictEqual(KO.wrap, null, 'teardown drops the wrap — state now reports through the badge');
  assert.strictEqual(KO.kickFrame, null, 'teardown drops the IVS frame');
  assert.strictEqual(KO.frameSeq, seqBeforeTeardown, 'teardown never rewinds the frame-identity counter');
  console.log('teardown: yt mint bookkeeping + yt watchdog clock + wrap/frame reset — OK');

  // ---- H: yt→kick fallback gate ---------------------------------------------
  KO.slug = 'rodil';
  KO.player = 'youtube';
  KO.kickSlug = 'rodil';            // same-handle fallback — no real kick mapping
  KO.ytRaw = '@x';
  KO.ytId = 'UCxxxxxxxxxxxxxxxxxxxxxx';
  KO.mappings['rodil'] = { yt: '@x' };
  KO.ytHlsFailed = true;
  // Past the 4s bridge-reload grace (ytHardFail) and still inside the 30s
  // mint backoff: the verdict is "dead url", which is the gray badge.
  KO.ytHlsFailedAt = Date.now() - 5000;
  KO.ytHlsUrl = null;
  KO.ytHlsAt = 0;
  KO.ytEmbedAt = Date.now() - 10000; // embed grace expired too
  KO.ytState = { ready: false, playing: false, muted: true, live: false, dur: 0, ct: 0, error: 0 };
  KO.ytLoadedUrl = null;
  KO.twDeleted = false;
  KO.wrap = null;                   // youtube-only path mounts the wrap on demand
  storage.ko = undefined;
  fakeFrame = null;
  fakeVideos.length = 0;
  const playsBefore = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  badge.length = 0;
  await api.probe();
  assert.strictEqual(KO.player, 'youtube', 'no real kick mapping -> stay in youtube mode (no kick bounce)');
  assert.ok(KO.wrap, 'youtube branch mounts the wrap');
  assert.strictEqual(KO.wrap.style.display, 'none', 'failed mint hides the wrap');
  assert.ok(!(storage.ko && storage.ko.player === 'kick'), 'no persisted handover');
  KO.playerPreference = 'youtube';
  KO.player = 'kick';
  await api.saveState();
  assert.strictEqual(storage.ko.player, 'youtube', 'session fallback must not leak into persisted player choice');
  KO.player = 'kick';
  KO.playerPreference = 'youtube';
  const currentMappings = KO.mappings;
  assert.ok(storageChangedListener, 'storage listener must be registered');
  storageChangedListener({
    'ko.v2': {
      oldValue: { enabled: true, player: 'youtube', mappings: currentMappings },
      newValue: { enabled: true, player: 'youtube', mappings: currentMappings },
    },
  }, 'local');
  assert.strictEqual(KO.player, 'kick', 'preferred-player self-writes must not undo a session fallback');
  KO.player = 'youtube';
  const playsAfterFail = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  assert.strictEqual(playsAfterFail, playsBefore, 'backoff must prevent a mint hit during the gate probe');
  // The reported failure case: the wrap is hidden, but the badge still
  // reports WHICH layer failed (0.8.1+ has no in-page chip — the state
  // surface is chrome.action, so a hidden wrap is never a silent failure).
  const bH = lastBadge();
  assert.strictEqual(bH.text, 'YT', 'the failed yt layer badges YT, not KICK');
  assert.strictEqual(bH.color, '#6b7280', 'gray = failed, distinct from amber connecting');
  assert.strictEqual(KO.wrap.style.display, 'none', 'wrap stays hidden while the layer is dead');
  // 30s backoff expires -> the probe loop re-enters the youtube branch and re-mints.
  // The mint needs a channel to mint FOR: with no ref at all ensureYtHls()
  // records a failure without ever calling the background (its refs list is
  // empty), which is a fixture gap, not the behaviour under test.
  // ...and a RESOLVED channel: the probe bails at 'yt-unresolved' before it ever
  // reaches the mint when ytId is null and ytRaw is not a bare video id.
  KO.ytRaw = '@x';
  KO.slug = 'rodil';
  KO.ytId = 'UCxxxxxxxxxxxxxxxxxxxxxx';
  KO.ytHlsFailedAt = Date.now() - 31000;
  badge.length = 0;
  await api.probe();
  assert.strictEqual(KO.player, 'youtube', 're-mint keeps youtube mode');
  assert.strictEqual(KO.ytHlsUrl, 'https://hls.example/u1', 'backoff-expired re-mint succeeded');
  assert.strictEqual(KO.ytHlsFailed, false, 'successful re-mint clears the failed flag');
  const bH2 = lastBadge();
  assert.strictEqual(bH2.text, 'YT', 'the badge keeps the YT token across the re-mint');
  assert.strictEqual(bH2.color, '#d97706', 'amber = minted and connecting (never red/failed again)');
  console.log('H fallback gate: same-handle stays youtube, no persist, backoff re-mint, badge YT gray->amber — OK');

  // ---- H4: P4 — re-picking youtube (same stored value) after a session-only
  // yt->kick fallback with an EXPIRED backoff is a genuine retry (owner pain
  // 4: "Troquei para YouTube e continuou mostrando a Twitch"). storage keeps
  // player:'youtube' (the fallback never persists) and the popup re-writes the
  // SAME value, so neither the stored-value gate nor :366 fires. The retry
  // arm must clear the stale mint evidence and push KO.player back to youtube
  // so fire(apply) mints instead of re-probing kick. Real kick mapping.
  KO.slug = 'rodil';
  KO.player = 'kick';
  KO.playerPreference = 'youtube';     // stored pref is youtube; fallback is in-memory
  KO.kickSlug = 'realkick';            // real mapping — the fallback gate was armed
  // The mapping row carries the resolved ytId: the storage handler mirrors it
  // into KO.ytId on every write, so a row WITHOUT it nulls the id the arm just
  // set and probeYtLayer bails at 'yt-unresolved' before the mint.
  KO.mappings['rodil'] = { kick: 'realkick', yt: '@x', ytId: 'UCxxxxxxxxxxxxxxxxxxxxxx' };
  KO.ytRaw = '@x';
  KO.ytId = 'UCxxxxxxxxxxxxxxxxxxxxxx';
  KO.ytHlsFailed = true;
  KO.ytHlsFailedAt = Date.now() - 31000; // EXPIRED backoff — same window ensureYtHls honours
  KO.ytHlsUrl = null;
  KO.ytHlsAt = 0;
  KO.ytEmbedAt = 0;                    // disarm embed-stalled so no handover re-fires
  KO.ytState = { ready: false, playing: false, muted: true, live: false, dur: 0, ct: 0, error: 0 };
  KO.ytLoadedUrl = null;
  KO.wrap = null;
  fakeFrame = null;
  fakeVideos.length = 0;
  storage.ko = undefined;
  const pH4Before = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  const h4Mappings = KO.mappings;
  assert.ok(storageChangedListener, 'storage listener must be registered');
  // popup re-pick: popup.js stamps fresh.playerAt=Date.now() on every player
  // change, so a same-value write arrives with a NEW playerAt vs the stored
  // one — that delta is the retry intent (0.8.6 replaced the 30s backoff
  // window with this immediate marker).
  storageChangedListener({
    'ko.v2': {
      oldValue: { enabled: true, player: 'youtube', playerAt: 1000, mappings: h4Mappings },
      newValue: { enabled: true, player: 'youtube', playerAt: 2000, mappings: h4Mappings },
    },
  }, 'local');
  // Async fire(apply) -> probe() -> probeYtLayer -> ensureYtHls mint. The probe
  // is throttled by ytProbeAt, and the H arm above just spent that throttle, so
  // the re-pick is measured from a clean probe clock (the popup click is a later
  // user action, not the same tick).
  KO.ytProbeAt = 0;
  KO.ytNoEvidence = 0;
  await settle(120);
  const pH4After = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  assert.strictEqual(KO.ytHlsFailed, false, 'retry intent with expired backoff must clear the stale mint failure');
  assert.strictEqual(KO.player, 'youtube', 'retry intent must return the active layer to youtube (not keep kicking)');
  assert.strictEqual(pH4After - pH4Before, 1, 'the re-pick re-mints exactly once (fresh mint, not the old pendings)');
  assert.ok(KO.ytHlsUrl, 'the re-mint produced a fresh url');
  KO.player = 'kick';
  KO.playerPreference = 'kick';
  storage.ko = undefined;
  console.log('H4 P4 retry: same-value youtube re-pick after expired-backoff fallback clears evidence + re-mints — OK');

  // ---- H5: (a) an erase-echo (a write WITHOUT playerAt while a fallback is
  // live) must NOT re-mint — it is a content/volume echo, not a retry; the
  // `typeof s.playerAt === 'number'` guard is what keeps
  // undefined-undefined or a dropped marker from false-positive. (b) the
  // same-value re-pick must ALSO clear an EMBED-STALL (embedStalled hands
  // KO.player to kick with ytHlsFailed still false) — the 0.8.6 gate keys on
  // KO.player==='kick' + the playerAt delta, not on ytHlsFailed.
  KO.slug = 'rodil';
  KO.player = 'kick';
  KO.playerPreference = 'youtube';
  KO.kickSlug = 'realkick';
  KO.mappings['rodil'] = { kick: 'realkick', yt: '@x', ytId: 'UCxxxxxxxxxxxxxxxxxxxxxx' }; // row carries the resolved id (the mirror nulls KO.ytId otherwise)
  KO.ytRaw = '@x';
  KO.ytId = 'UCxxxxxxxxxxxxxxxxxxxxxx';
  KO.ytHlsFailed = true;
  KO.ytHlsFailedAt = Date.now();
  KO.ytHlsUrl = null;
  KO.ytHlsAt = 0;
  KO.ytEmbedAt = 0;
  KO.ytState = { ready: false, playing: false, muted: true, live: false, dur: 0, ct: 0, error: 0 };
  KO.ytLoadedUrl = null;
  KO.wrap = null;
  fakeFrame = null;
  fakeVideos.length = 0;
  storage.ko = undefined;
  // (a) erase-echo: same stored player AND playerAt all the way through.
  const h5Before = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  // note: the erase-echo newValue carries NO playerAt key at all.
  storageChangedListener({
    'ko.v2': {
      oldValue: { enabled: true, player: 'youtube', playerAt: 3000, mappings: KO.mappings },
      newValue: { enabled: true, player: 'youtube', mappings: KO.mappings },
    },
  }, 'local');
  await settle(80);
  const h5After = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  assert.strictEqual(KO.ytHlsFailed, true, 'an erase-echo (no playerAt) must NOT clear the stale failure');
  assert.strictEqual(KO.player, 'kick', 'an erase-echo is not a retry — layer stays on kick (fallback intact)');
  assert.strictEqual(h5After - h5Before, 0, 'an erase-echo must NOT mint');
  // (b) embed-stall same-value re-pick MUST re-mint (ytHlsFailed=false but
  // KO.player===kick from embedStalled). The 0.8.6 retry arm keys on
  // KO.player==='kick' + the playerAt delta — NOT on ytHlsFailed — so a
  // pathologically stalled embed that never set ytHlsFailed still gets its
  // fresh mint attempt on an explicit popup re-pick. Note the embed stays
  // "not ready" in the harness, so the post-fire probe legitimately
  // re-evaluates embedStalled and re-handovers; the pin is that a FRESH mint
  // was attempted (the gate fired), which is what the fix must guarantee.
  KO.player = 'kick';
  KO.ytHlsFailed = false; // embed-stall trigger, NOT a failed mint
  KO.ytEmbedAt = Date.now() - 200000; // embed dead > YT_EMBED_GRACE → embedStalled
  // directly arm the live state so probe() lands the fallback as embed-stalled
  storage.ko = { enabled: true, player: 'youtube', playerAt: 4000, mappings: KO.mappings };
  await api.probe();
  assert.strictEqual(KO.player, 'kick', 'embed-stall hands the layer to kick');
  const h5bBefore = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  storageChangedListener({
    'ko.v2': {
      oldValue: { enabled: true, player: 'youtube', playerAt: 4000, mappings: KO.mappings },
      newValue: { enabled: true, player: 'youtube', playerAt: 5000, mappings: KO.mappings },
    },
  }, 'local');
  await settle(80);
  const h5bAfter = swCalls.filter((m) => m && m.type === 'ko-yt-play').length;
  assert.strictEqual(h5bAfter - h5bBefore, 1, 'the embed-stall re-pick fires a fresh mint (the 0.8.6 gate fires without ytHlsFailed)');
  KO.player = 'kick';
  KO.playerPreference = 'kick';
  storage.ko = undefined;
  console.log('H5 P4 retry: erase-echo no-mint (playerAt guard) + embed-stall same-value re-mint — OK');

  // ---- I: badge state transitions (the 0.8.2 status surface) ---------------
  KO.mappings['rodil'] = { kick: 'realkick', yt: '@x', ytId: 'UCxxxxxxxxxxxxxxxxxxxxxx' }; // row carries the resolved id (the mirror nulls KO.ytId otherwise)
  KO.ytHlsFailed = false;
  KO.ytHlsFailedAt = 0;
  // KICK Playing -> green KICK
  KO.player = 'kick';
  KO.kickSlug = 'realkick';
  KO.activeUrl = 'https://ivs.example/live';
  KO.kickUrlT = Date.now();
  KO.kickEverPlayed = true;
  KO.kickState = { state: 'Playing', paused: false, muted: false, pos: 10, lat: 2, dur: 120, ts: Date.now() };
  badge.length = 0;
  await api.probe();
  const bKick = lastBadge();
  assert.strictEqual(bKick.text, 'KICK', 'KICK badge while kick Playing');
  assert.strictEqual(bKick.color, '#059669', 'green = kick playback confirmed Playing');
  assert.strictEqual(KO.wrap.style.display, 'block', 'kick layer shown');
  assert.ok(KO.wrap.classList.contains('ko-kick') && !KO.wrap.classList.contains('ko-yt'), 'kick layer is the rendering one');
  // KICK connecting (url/ready pending) -> amber KICK
  KO.kickState = { state: 'Idle', paused: true, muted: true, pos: 0, lat: 0, dur: 0, ts: Date.now() };
  KO.kickUrlT = Date.now(); // fresh url inside the transition grace
  badge.length = 0;
  await api.probe();
  const bConn = lastBadge();
  assert.strictEqual(bConn.text, 'KICK', 'connecting keeps the KICK token (the phase is the color)');
  assert.strictEqual(bConn.color, '#d97706', 'amber = url attached but IVS not Playing yet');
  // KICK failed/offline -> gray, on the layer the user actually chose
  KO.activeUrl = null;
  // A wrong-origin message must be dropped even when it names the real frame.
  const originSavedFrame = KO.kickFrame;
  KO.kickFrame = gFrame;
  KO.kickState = KO.kickState || {};
  delete KO.kickState.qualities;
  msgListeners.forEach((listener) => listener({
    data: { __koKick: { t: 'levels', levels: ['2160p'] } },
    origin: 'https://evil.example',
    source: gFrame.contentWindow,
  }));
  assert.strictEqual(KO.kickState.qualities, undefined, 'a wrong-origin spoof cannot write kick state');
  KO.kickFrame = originSavedFrame;
  KO.kickUrlT = 0;
  KO.kickState = null;
  KO.kickEverPlayed = false;
  badge.length = 0;
  await api.probe();
  const bOff = lastBadge();
  assert.strictEqual(bOff.text, 'KICK', 'offline kick badges KICK while the yt mint is healthy');
  assert.strictEqual(bOff.color, '#6b7280', 'gray = offline/failed');
  assert.strictEqual(KO.wrap.style.display, 'none', 'wrap hidden when kick offline');
  // The same offline probe with a FAILED yt mint must blame YT, not KICK.
  KO.ytHlsFailed = true;
  badge.length = 0;
  await api.probe();
  const bBlame = lastBadge();
  assert.strictEqual(bBlame.text, 'YT', 'after a yt→kick fallback the offline badge names the failed layer');
  assert.strictEqual(bBlame.color, '#6b7280', 'still gray (offline/failed)');
  KO.ytHlsFailed = false;
  // YT live -> red YT
  KO.player = 'youtube';
  KO.ytRaw = '@x';
  KO.ytId = 'UCxxxxxxxxxxxxxxxxxxxxxx';
  KO.ytHlsUrl = 'https://hls.example/u1';
  KO.ytHlsAt = Date.now();
  KO.ytHlsFailed = false;
  KO.ytState = { ready: true, playing: true, muted: false, live: true, dur: 0, ct: 0, error: 0 };
  KO.ytLoadedUrl = 'https://hls.example/u1';
  badge.length = 0;
  await api.probe();
  const bYt = lastBadge();
  assert.strictEqual(bYt.text, 'YT', 'YT badge while yt live');
  assert.strictEqual(bYt.color, '#ff0000', 'red = the live YouTube layer (kick green vs yt red)');
  assert.strictEqual(KO.wrap.style.display, 'block', 'yt layer shown');
  assert.ok(KO.wrap.classList.contains('ko-yt') && !KO.wrap.classList.contains('ko-kick'), 'yt layer is the rendering one');
  // YT minting/loading (not live yet) -> amber YT
  KO.ytState = { ready: false, playing: false, muted: true, live: false, dur: 0, ct: 0, error: 0 };
  KO.ytEmbedAt = Date.now(); // embed grace not expired
  badge.length = 0;
  await api.probe();
  const bYt2 = lastBadge();
  assert.strictEqual(bYt2.text, 'YT', 'YT token while minting/loading');
  assert.strictEqual(bYt2.color, '#d97706', 'amber = loading, gray would mean failed');
  // twitch mode -> overlay hidden, badge peeks which fallback is available
  KO.player = 'twitch';
  badge.length = 0;
  await api.probe();
  const bTw = lastBadge();
  assert.strictEqual(bTw.text, 'TW', 'twitch mode badges TW when neither kick nor yt is live');
  assert.strictEqual(bTw.color, '#6b7280', 'gray = nothing to hand over to');
  assert.strictEqual(KO.wrap.style.display, 'none', 'wrap hidden in twitch mode');
  KO.player = 'youtube';
  console.log('I badge states: KICK green/amber/gray (blame-aware) + YT red/amber + TW peek — OK');

  // ---- J: badge texts all fit Chrome's 4-char clip --------------------------
  const seen = new Set(badgeTexts);
  assert.ok(seen.size > 0, 'no badge was emitted');
  for (const t of seen) {
    assert.ok(typeof t === 'string' && t.length <= 4, `badge text '${t}' must fit the 4-char clip`);
    assert.ok(['', 'KICK', 'YT', 'TW', 'OFF'].includes(t), `badge '${t}' must be a normalized token`);
  }
  assert.ok(!seen.has('KICK OFF') && !seen.has('RECONNECT') && !seen.has('YT OFF') && !seen.has('YT?'), 'no legacy clipped badge tokens');
  console.log('J badge clipping: every emitted badge <=4 chars, normalized tokens only — OK');

  // ---- K: ko-delete-twitch stickiness ----------------------------------------
  KO.slug = 'rodil';
  KO.player = 'youtube';
  KO.kickSlug = 'rodil';            // same-handle — gate keeps youtube mode
  KO.ytRaw = '@x';
  KO.ytId = 'UCxxxxxxxxxxxxxxxxxxxxxx';
  KO.mappings['rodil'] = { yt: '@x' };
  KO.ytHlsFailed = true;
  // A failure older than the 4s grace but inside the 30s backoff: conclusive
  // (gray) AND the mint will not retry mid-test. Set at `now` the verdict is
  // still AMBER — the 0.8.49 hard-fail needs >4s since the failure.
  KO.ytHlsFailedAt = Date.now() - 10000;
  KO.ytHlsUrl = null;
  KO.ytHlsAt = 0;
  KO.ytEmbedAt = Date.now() - 10000;
  KO.ytState = { ready: false, playing: false, muted: true, live: false, dur: 0, ct: 0, error: 0 };
  KO.ytLoadedUrl = null;
  KO.twDeleted = false;
  KO.lastRect = null;
  KO.kickFrame = null;
  KO.kickWin = null;
  fakeFrame = null;
  fakeVideos.length = 0;
  const delVideo = videoEl('tw-main-video');
  fakeVideos.push(delVideo);
  await api.probe(); // youtube branch mounts the wrap; failed mint + not deleted -> hidden
  assert.ok(KO.wrap, 'wrap mounted in youtube mode');
  assert.strictEqual(KO.wrap.style.display, 'none', 'failed mint hides the wrap before the delete');
  assert.strictEqual(delVideo.removed, 0, 'probe alone never touches the twitch video');

  const delListener = runtimeMsgListeners[0];
  assert.ok(delListener, 'popup action listener registered');
  badge.length = 0;
  await new Promise((res) => delListener({ type: 'ko-delete-twitch' }, {}, () => res()));
  await settle(50); // let the handler's apply() settle
  assert.strictEqual(KO.twDeleted, true);
  assert.strictEqual(delVideo.removed, 1, 'delete removes the current twitch video');
  assert.ok(!KO.lastRect || KO.lastRect.width !== 1280 || KO.lastRect.height !== 720, 'tw-delete must not prime full viewport lastRect');
  assert.strictEqual(KO.wrap.style.display, 'block', 'wrap kept visible in the loading state');
  assert.ok(!KO.wrap.style.width || KO.wrap.style.width !== '1280px', 'wrap not forced to viewport width without a measured rect');
  // hideWrapForProbe() respects twDeleted (hiding would reveal a blank page),
  // so the badge — not the wrap — is what tells the user the layer is dead.
  const bK = lastBadge();
  assert.strictEqual(bK.text, 'YT', 'the yt failure is still reported with the wrap up');
  assert.strictEqual(bK.color, '#6b7280', 'gray = failed mint, not the amber loading state');

  // SPA re-render: a NEW video element appears -> the observer re-applies the delete.
  assert.ok(moInstances.length >= 1, 'tw-delete MutationObserver registered');
  const mo = moInstances[moInstances.length - 1];
  const reVideo = videoEl('tw-main-video-rendered');
  fakeVideos.push(reVideo);
  mo.cb([{ addedNodes: [reVideo] }]);
  assert.strictEqual(reVideo.removed, 1, 'observer re-applies the delete on SPA re-render');

  // Observer is idle while the user is in twitch mode.
  KO.player = 'twitch';
  const twVideo = videoEl('tw-main-video-2');
  fakeVideos.push(twVideo);
  mo.cb([{ addedNodes: [twVideo] }]);
  assert.strictEqual(twVideo.removed, 0, "observer no-ops while player === 'twitch'");
  KO.player = 'youtube';
  console.log('K tw_delete: video removed, wrap kept up without viewport priming, observer re-applies — OK');

  // ---- L: yt frame-death watchdog -------------------------------------------
  KO.player = 'youtube';
  KO.ytState = { ready: true, playing: true, muted: false, live: true, dur: 0, ct: 0, error: 0 };
  KO.lastYtSt = Date.now() - 31000; // bridge silent > 30s
  KO.ytWin = { postMessage() {} };
  KO.ytHlsUrl = 'https://hls.example/u1';
  KO.ytHlsAt = Date.now();
  KO.ytHlsFailed = false;
  KO.kickSlug = 'rodil'; // same-handle — gate keeps youtube
  KO.wrap = KO.wrap || wrap;
  KO.wrap.style.display = 'block'; // watchdog only runs while the layer is shown
  fakeFrame = { ...el('iframe'), id: 'ko-yt' };
  api.rectTick();
  assert.strictEqual(fakeFrame.removed, 1, 'watchdog removes the dead yt frame');
  assert.strictEqual(KO.ytState.ready, false, 'watchdog resets ready');
  assert.strictEqual(KO.ytWin, null, 'watchdog clears ytWin');
  assert.strictEqual(KO.lastYtSt, 0, 'watchdog resets the silence clock');
  // A recent st heartbeat keeps the frame alive.
  KO.ytState = { ready: true, playing: true, muted: false, live: true, dur: 0, ct: 0, error: 0 };
  KO.ytWin = { postMessage() {} };
  KO.lastYtSt = Date.now();
  fakeFrame = { ...el('iframe'), id: 'ko-yt' };
  api.rectTick();
  assert.strictEqual(fakeFrame.removed, 0, 'recent st heartbeat keeps the frame');
  console.log('L yt watchdog: 30s silence removes the frame, resets ready/ytWin — OK');

  // ---- M/N/O/P: kick overlay UI fixes (fs icon, bar hot, badge offline, no viewport prime) ----
  const makeNode = (tag) => {
    const node = {
      tagName: (tag || 'div').toUpperCase(),
      nodeType: 1,
      id: '',
      innerHTML: '',
      textContent: '',
      style: { display: '' },
      dataset: {},
      children: [],
      attrs: {},
      _text: '',
      classList: {
        _s: new Set(),
        add(...a) { a.forEach((x) => this._s.add(x)); },
        remove(...a) { a.forEach((x) => this._s.delete(x)); },
        contains(x) { return this._s.has(x); },
        toggle(x, force) { const want = force === undefined ? !this._s.has(x) : !!force; if (want) this._s.add(x); else this._s.delete(x); return want; },
      },
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      remove() { this.removed = (this.removed || 0) + 1; },
      _ev: {},
      addEventListener(type, fn) { this._ev[type] = fn; },
      removeEventListener(type, fn) { if (this._ev[type] === fn) delete this._ev[type]; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      querySelector(sel) {
        if (!sel || sel[0] !== '#') return null;
        const want = sel.slice(1);
        const all = [];
        const walk = (n) => { all.push(n); n.children.forEach(walk); };
        walk(this);
        return all.find((n) => n.id === want) || null;
      },
      querySelectorAll() { return []; },
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }),
      isConnected: true,
      offsetWidth: 400,
      offsetHeight: 300,
    };
    Object.defineProperty(node, 'innerHTML', {
      set(html) {
        node._html = html;
        node.children = [];
        const re = /<(button|div|span)[^>]*id="([^"]+)"/g;
        let m;
        while ((m = re.exec(html))) {
          const child = makeNode(m[1]);
          child.id = m[2];
          node.appendChild(child);
        }
      },
      get() { return node._html || ''; },
    });
    // textContent is DOM-faithful: assigning '' (renderQualityMenu's
    // re-render reset) drops children; reads aggregate the subtree.
    Object.defineProperty(node, 'textContent', {
      set(v) { node._text = String(v); node.children.length = 0; },
      get() {
        if (node.children.length) return node.children.map((c) => c.textContent).join('');
        return node._text;
      },
    });
    return node;
  };

  const mountDoc = {
    head: doc.head,
    body: makeNode('body'),
    documentElement: doc.documentElement,
    hidden: false,
    hasFocus: () => true,
    fullscreenElement: null,
    createElement: (t) => makeNode(t),
    getElementById: () => null,
    querySelector: (sel) => (sel === 'main' ? mountDoc.body : null),
    querySelectorAll: (sel) => (sel === 'video' ? fakeVideos : []),
    addEventListener() {},
    removeEventListener() {},
  };
  const mountApi = new Function('window', 'document', 'location', 'navigator', src + '\n;return {KO, mount, updateKickBar, teardown, injectStyles, rectTick, syncMute, setupHotBar, teardownHotBar, renderQualityMenu, overlayOwnsPicture, overlayHasPicture, visibleSurface, syncOwner, recoverStale, koHbTick, kickSeekTo, kickBackToLive};')(
    global, mountDoc, global.location, global.navigator,
  );
  const mKO = mountApi.KO;
  mountApi.injectStyles();
  mountApi.mount();
  assert.ok(mKO.wrap, 'mount creates wrap');
  const fsNode = mKO.wrap.querySelector('#ko-fs');
  assert.ok(fsNode && fsNode.innerHTML.includes('viewBox'), 'fullscreen button receives the fs SVG icon');
  assert.ok(mKO.wrap.classList.contains('ko-hot'), 'wrap starts hot so the control bar is visible');
  fakeFrame = { contentWindow: { postMessage() {} }, dataset: { koToken: 'message-token' } };
  mountDoc.getElementById = (id) => (id === 'ko-yt' ? fakeFrame : null);
  msgListeners.forEach((listener) => listener({
    source: fakeFrame.contentWindow,
    origin: new URL(chromeStub.runtime.getURL('player.html')).origin,
    data: { __koKick: { t: 'ready', _koToken: 'message-token' } },
  }));
  fakeVideos.length = 0;
  const nativeVideo = { ...videoEl('native'), play() { this.paused = false; return Promise.resolve(); } };
  fakeVideos.push(nativeVideo);
  nativeVideo.paused = false;
  nativeVideo.muted = false;
  mKO.player = 'youtube';
  // The layer must HAVE a picture for the native to be handed over (P2e: the
  // ownership term is the picture, not the preference - a selected layer with
  // nothing to show leaves the user's player alone).
  mKO.ytState = { ready: true, playing: true, live: true, muted: false, dur: 0, ct: 0, error: 0 };
  mKO.wrap.style.display = 'block';
  mountApi.syncMute();
  assert.strictEqual(nativeVideo.paused, true, 'overlay pauses Twitch playback');
  // 0.8.50: content.js is NOT allowed to write a mute or a volume — ko-audio.js
  // is the single authority, and the two writers this used to be are exactly
  // what reverted the owner's unmute within 400 ms.
  assert.strictEqual(nativeVideo.muted, false, 'content.js leaves the native mute alone (ko-audio.js owns it)');
  const elementAudioWrites = src.split('\n').filter((l) => !l.trim().startsWith('//')
    && /\b(v|el|video|native|hidden|vid)\.(muted|volume)\s*=[^=]/.test(l));
  assert.strictEqual(elementAudioWrites.length, 0, 'no element.muted/.volume write anywhere in content.js');
  mKO.wrap.style.display = 'none';
  // ...and the resume half is about a layer that FAILED (no picture), which is
  // why the fixture drops its report here.
  mKO.ytState = { ready: false, playing: false, live: false, muted: true, dur: 0, ct: 0, error: 1 };
  mountApi.rectTick();
  assert.strictEqual(nativeVideo.paused, false, 'hidden failed overlay resumes Twitch playback');
  assert.strictEqual(nativeVideo.muted, false, 'still no mute write on the way out');
  fakeVideos.length = 0;
  console.log('M fs icon: mount assigns KO_SVG.fs to #ko-fs — OK');

  // ---- P3: the LIVE return-to-live pill (owner pain 3 — "no clickable LIVE
  // button"). A <button id="ko-golive"> lives in #ko-bar and is shown by
  // updateKickBar() only when the playhead sits behind the edge (lat ≥ 1
  // arrow step) or on the DVR url; clicking jumps to live via the bridge.
  const p3posts = [];
  // koReady models a COMMITTED navigation: 0.8.47 queues commands until the
  // frame reports in, and a frame object re-created without its `load` event
  // would sit in that queue forever (harness artifact, not a code path).
  const fakeFrameKick = { ...el('iframe'), id: 'ko-ivs', dataset: { koToken: 'p3kick', koReady: '1' }, contentWindow: { postMessage: (m) => p3posts.push(m) } };
  fakeFrame = { ...el('iframe'), id: 'ko-yt', dataset: { koToken: 'p3yt', koReady: '1' }, contentWindow: { postMessage: (m) => p3posts.push(m) } };
  mountApi.mount();
  assert.ok(mKO.wrap, 'mountApi exposed for the pill test');
  const goliveP3 = mKO.wrap.querySelector('#ko-golive');
  assert.ok(goliveP3, 'mount creates the #ko-golive pill');
  mountDoc.getElementById = (id) => (id === 'ko-yt' ? fakeFrame : id === 'ko-ivs' ? fakeFrameKick : null);
  mKO.player = 'youtube';
  mKO.ytState = { ready: true, live: true, playing: true, muted: false, ct: 40, dur: 60, lat: 7 };
  mKO.wrap.style.display = 'block';
  mKO.ytHlsUrl = 'https://hls.example/p3';
  mountApi.updateKickBar();
  assert.ok(goliveP3.classList.contains('ko-show'), 'kt leg: pill shows while lat ≥ ARROW_SEEK_SEC');
  assert.ok(goliveP3.textContent.match(/LIVE\s*−\s*7s/), 'kt leg: pill labelled with the live throttle (LIVE −7s at lat=7)');
  // click → ytCmd('seekToLive') → post {t:'seekToLive'}
  goliveP3._ev.click();
  const p3ytPosts = p3posts.filter((m) => m && m.__koKick && m.__koKick.t === 'seekToLive');
  assert.strictEqual(p3ytPosts.length, 1, 'yt leg: pill click posts seekToLive to the yt frame');
  assert.strictEqual(p3ytPosts[0].__koKick._koToken, 'p3yt', 'yt leg: seekToLive carries the yt frame token');
  // at the edge (lat < 1 step) the pill hides for yt
  mKO.ytState.lat = 0;
  mountApi.updateKickBar();
  assert.ok(!goliveP3.classList.contains('ko-show'), 'yt leg: pill hides at the live edge');
  // kick leg on DVR → clicking reloads the live url (kickBackToLive loads activeUrl)
  mKO.player = 'kick';
mKO.kickState = { state: 'Playing', pos: 10, lat: 18, dur: 3600, qualities: [], ts: Date.now() };
  mKO.kickOnDvr = true;
  mKO.activeUrl = 'https://ivs.example/live-p3';
  mKO.kickFrame = fakeFrameKick;
  mKO.kickWin = fakeFrameKick.contentWindow;
  mKO.wrap.style.display = 'block';
  mountApi.updateKickBar();
  assert.ok(goliveP3.classList.contains('ko-show'), 'kick leg: pill shows while lat ≥ ARROW_SEEK_SEC (and on DVR)');
  assert.ok(goliveP3.textContent.match(/LIVE\s*−\s*18s/), 'kick leg: pill labelled with the live throttle (LIVE −18s at lat=18)');
  p3posts.length = 0;
  // Go live MINTS a fresh token instead of reloading the one this page minted at
  // mount: measured 2026-11-13 in two live runs, the stale url loaded as a dead
  // element that reported `Playing` over a frozen clock (`stall {ct:10529}` x3,
  // then `owner-regress {from:10529, to:46}`).
  mKO.kickSlug = 'p3channel'; // the mint needs a plausible slug, exactly like a real page
  mKO.enabled = true; // and the overlay has to be the enabled layer
  const realFetchP3 = global.fetch;
  global.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ livestream: { playback_url: 'https://ivs.example/live-p3-fresh', id: 'p3' } }),
  });
  goliveP3._ev.click();
  await settle(40);
  global.fetch = realFetchP3;
  const p3kickPosts = p3posts.filter((m) => m && m.__koKick && m.__koKick.t === 'load');
  assert.strictEqual(p3kickPosts.length, 1, 'kick leg DVR: pill click loads a live url to go live (kickGoLive)');
  assert.strictEqual(p3kickPosts[0].__koKick.url, 'https://ivs.example/live-p3-fresh', 'kick leg: go live targets a FRESH mint, never the stale activeUrl');
  assert.strictEqual(mKO.kickOnDvr, false, 'kick leg: leaving the DVR clears the flag');
  assert.strictEqual(mKO.activeUrl, 'https://ivs.example/live-p3-fresh', 'kick leg: the fresh url becomes the live source');
  // kick leg at edge (not DVR, lat 0) hides the pill
  mKO.kickOnDvr = false;
  mKO.kickState = { state: 'Playing', pos: 100, lat: 0, dur: 3600, qualities: [] , ts: Date.now() };
  mountApi.updateKickBar();
  assert.ok(!goliveP3.classList.contains('ko-show'), 'kick leg: pill hides when actually live');
  fakeFrame = null;
  p3posts.length = 0;
  console.log('P3: LIVE pill shows behind live / on DVR, hides at the edge, click jumps to live on both legs — OK');

  const styleEl2 = appends.find((e) => e.id === 'ko-style');
  assert.ok(styleEl2.textContent.includes('#ko-wrap:not(.ko-hot):not(.ko-hot-lock) #ko-bar{opacity:0;pointer-events:none;}'), 'bar auto-hides once the wrap goes cold (and stays up while the pointer is on it)');
  assert.ok(!styleEl2.textContent.includes('#ko-wrap:not(.ko-hot) #ko-bar{opacity:1;}'), 'stale always-visible bar rule purged');
  // The CSS keys on a class, so the contract only holds if the class cycles:
  // mount starts the wrap hot, and pointer activity re-arms it after it cools.
  assert.ok(mKO.wrap.classList.contains('ko-hot'), 'a fresh mount is hot (bar visible)');
  mKO.wrap.classList.remove('ko-hot');
  assert.ok(!mKO.wrap.classList.contains('ko-hot'), 'the wrap cools on the 2.6s timer');
  assert.ok(typeof mKO.wrap._ev.pointermove === 'function', 'pointer activity is wired on the wrap');
  mKO.wrap._ev.pointermove();
  assert.ok(mKO.wrap.classList.contains('ko-hot'), 'pointermove re-arms the hot class');
  mKO.wrap._ev.pointerdown();
  mKO.wrap._ev.mouseenter();
  assert.ok(mKO.wrap.classList.contains('ko-hot'), 'pointerdown/mouseenter keep it hot');
  mountApi.teardownHotBar();
  mKO.wrap.classList.remove('ko-hot');
  assert.ok(!mKO.wrap.classList.contains('ko-hot'), 'after teardown nothing re-arms the bar');
  console.log('N bar autohide: :not(.ko-hot) rule + hot class cycles on pointer activity — OK');

  const badgeWrap = {
    style: { display: 'block' },
    classList: null,
    querySelector: (sel) => {
      // 0.8.1+ has no LIVE badge element: the live/offline signal is a class
      // on the wrap. #ko-play is the only control updateKickBar still touches
      // through updatePlayUI/updateKickVolUI.
      if (sel === '#ko-play') return { dataset: {}, innerHTML: '' };
      return null;
    },
  };
  badgeWrap.classList = mkClassList(badgeWrap);
  badgeWrap.classList.add('ko-kick');
  KO.wrap = badgeWrap;
  KO.player = 'kick';
  KO.kickOnDvr = false;
  KO.kickState = null;
  api.updateKickBar();
  assert.ok(badgeWrap.classList.contains('ko-offline'), 'offline kickState hides LIVE badge via ko-offline');
  KO.kickState = { state: 'Playing', pos: 1, lat: 1, dur: 10 , ts: Date.now() };
  api.updateKickBar();
  assert.ok(!badgeWrap.classList.contains('ko-offline'), 'playing kickState shows LIVE badge');
  KO.kickOnDvr = true;
  KO.kickState = { state: 'Paused', pos: 1, lat: 1, dur: 10 , ts: Date.now() };
  api.updateKickBar();
  assert.ok(!badgeWrap.classList.contains('ko-offline'), 'DVR mode keeps badge visible');
  console.log('O badge offline: ko-offline toggles with kick playback state — OK');

  KO.lastRect = null;
  const delListener2 = runtimeMsgListeners[0];
  await new Promise((res) => delListener2({ type: 'ko-delete-twitch' }, {}, () => res()));
  assert.ok(!KO.lastRect || KO.lastRect.width !== global.innerWidth || KO.lastRect.height !== global.innerHeight, 'tw-delete without video does not prime viewport lastRect');
  console.log('P tw-delete: no viewport lastRect priming — OK');

  mountApi.teardown();

  // ---- Q: rectFromHost resolves the host player rect (twitch vs YT) --------
  const qRectFn = api.rectFromHost;
  const savedLoc = { ...global.location };
  try {
    Object.assign(global.location, { hostname: 'www.youtube.com', pathname: '/watch', search: '?v=Pu7xsoh-K6k' });
    setPageSel('#movie_player', el('div'));
    // setPageSel stores raw nodes, so reach into the pageSel map.
    const mp = pageSel.get('#movie_player');
    mp.getBoundingClientRect = () => ({ left: 8, top: 9, width: 640, height: 360 });
    const r1 = qRectFn();
    assert.strictEqual(r1.left, 8, 'rectFromHost uses #movie_player first on www.youtube.com');
    assert.strictEqual(r1.width, 640, '#movie_player width used');
    // Fallback player (embed players expose .html5-video-player, not #movie_player).
    pageSel.delete('#movie_player');
    setPageSel('.html5-video-player', el('div'));
    const hvp = pageSel.get('.html5-video-player');
    hvp.getBoundingClientRect = () => ({ left: 100, top: 200, width: 1280, height: 720 });
    const r2 = qRectFn();
    assert.strictEqual(r2.width, 1280, 'falls back to .html5-video-player');
    // No player -> null; zero-size rect -> null.
    pageSel.delete('.html5-video-player');
    assert.strictEqual(qRectFn(), null, 'no YT player -> null');
    setPageSel('#movie_player', el('div'));
    const z = pageSel.get('#movie_player');
    z.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
    assert.strictEqual(qRectFn(), null, 'zero-size rect -> null');
  } finally {
    Object.assign(global.location, savedLoc);
    pageSel.clear();
  }
  // Twitch branch: rect comes from the twitch video element.
  Object.assign(global.location, { hostname: 'www.twitch.tv', pathname: '/rodil', search: '' });
  fakeVideos.length = 0;
  const twV = videoEl('tw-main-video');
  fakeVideos.push(twV);
  assert.deepStrictEqual(qRectFn(), { left: 0, top: 0, width: 100, height: 60 }, 'twitch anchor rect = video rect (no anchor class)');
  fakeVideos.length = 0;
  console.log('Q rectFromHost: #movie_player -> .html5-video-player -> null/zero-size -> twitch video rect — OK');

  // ---- R: resolveYtPageKick tier order + host-aware currentSlug ------------
  // The YT-page identity helpers read <meta itemprop=channelId>, <link
  // itemprop=url>, <meta itemprop=name> and /watch?v= via pageSel + location.
  const R = api.resolveYtPageKick;
  const R_setYt = (opts) => {
    pageSel.clear();
    Object.assign(global.location, {
      hostname: 'www.youtube.com', pathname: '/watch', search: '?v=zzzzzz',
    });
    if (opts.cid) {
      const m = el('meta'); m.getAttribute = (k) => (k === 'content' ? opts.cid : null);
      setPageSel('meta[itemprop="channelId"]', m);
    }
    if (opts.handle) {
      const lk = el('link'); lk.getAttribute = (k) => (k === 'href' ? '/@' + opts.handle : null);
      setPageSel('link[itemprop="url"]', lk);
    }
    if (opts.name) {
      const nm = el('meta'); nm.getAttribute = (k) => (k === 'content' ? opts.name : null);
      setPageSel('meta[itemprop="name"]', nm);
    }
  };
  // Tier 1: ytId exact match (case-insensitive).
  KO.mappings = { gaules: { yt: 'Gaules', ytId: 'UCgXYe0X202GT0lxXH6pGXZg' } };
  R_setYt({ cid: 'UCGXYE0X202GT0LXXH6PGXZG' });
  assert.strictEqual(R().via, 'ytId', 'tier 1: cid matches ytId (case-insensitive)');
  assert.strictEqual(R().slug, 'gaules', 'tier 1 resolves the owning table row');
  // Tier 2: yt handle/name match on the page.
  KO.mappings = { jb: { yt: '@JBSniperPRIME', ytId: 'UCother' } };
  R_setYt({ cid: 'UCJJJJJJJJJJJJJJJJJJJJJJ', handle: 'jbsniperprime' });
  assert.strictEqual(R().via, 'yt', 'tier 2: page handle matches a stored yt value');
  assert.strictEqual(R().slug, 'jb', 'tier 2 resolves the row');
  // Tier 3a: stored kick slug matches the page handle.
  KO.mappings = { sp: { kick: 'spreen', yt: 'SpreenDMC' } };
  R_setYt({ cid: 'UCAAAAAAAAAAAAAAAAAAAAAA', handle: 'spreen' });
  assert.strictEqual(R().via, 'handle', 'tier 3a: stored kick slug === page handle');
  assert.strictEqual(R().slug, 'sp', 'tier 3a resolves the row');
  // Tier 3b: no stored row, same-handle doctrine.
  KO.mappings = {};
  R_setYt({ cid: 'UCAAAAAAAAAAAAAAAAAAAAAA', handle: 'spreen' });
  const t3b = R();
  assert.strictEqual(t3b.via, 'handle', 'tier 3b: synthetic same-handle');
  assert.strictEqual(t3b.slug, 'host:yt:@spreen', 'tier 3b synthetic host-scoped slug');
  // Tiers 4 and 5 do NOT exist (0.8.47). A YouTube video id or a UC channel id
  // is not a kick handle: deriving one invented a channel and made the page
  // request kick.com/api/v{1,2}/channels/<guessed> from the youtube.com origin,
  // which Chrome blocked twice per video (owner console 2026-11-07). No match,
  // no overlay — the assertion is the ABSENCE of a guess.
  KO.mappings = {};
  R_setYt({});
  assert.strictEqual(R(), null, 'no videoId-derived kick channel');
  KO.mappings = {};
  R_setYt({ cid: 'UCDDDDDDDDDDDDDDDDDDDDDD' });
  Object.assign(global.location, { hostname: 'www.youtube.com', pathname: '/channel/UCDDDDDDDDDDDDDDDDDDDDDD', search: '' });
  assert.strictEqual(R(), null, 'no UC-derived kick channel');
  // Unknown /@handle page -> synthetic same-handle (still a valid identity).
  R_setYt({ handle: 'xyz' });
  Object.assign(global.location, { pathname: '/@xyz', search: '' });
  pageSel.delete('meta[itemprop="channelId"]');
  assert.strictEqual(R().via, 'handle', '@handle page resolves same-handle even for an unmapped handle');
  assert.strictEqual(R().slug, 'host:yt:@xyz', '@handle synthetic slug');
  // YouTube HOME page: no cid, no handle, no video -> no overlay identity.
  pageSel.clear();
  Object.assign(global.location, { hostname: 'www.youtube.com', pathname: '/', search: '' });
  assert.strictEqual(R(), null, 'youtube home: no cid/handle/videoId -> null');
  // host-aware currentSlug.
  R_setYt({ handle: 'gaules' });
  Object.assign(global.location, { pathname: '/@gaules', search: '' });
  assert.strictEqual(api.currentSlug(), 'host:yt:@gaules', 'YT handle page -> host-scoped slug');
  Object.assign(global.location, { pathname: '/watch', search: '?v=Pu7xsoh-K6k' });
  pageSel.clear();
  assert.strictEqual(api.currentSlug(), 'host:yt:pu7xsoh-k6k', 'YT watch page -> host:yt:videoId slug');
  Object.assign(global.location, savedLoc);
  pageSel.clear();
  setPageSel('main', el('div'));
  Object.assign(global.location, { hostname: 'www.twitch.tv', pathname: '/Gaules', search: '' });
  assert.strictEqual(api.currentSlug(), 'gaules', 'twitch channel path -> plain slug');
  Object.assign(global.location, { pathname: '/' });
  assert.strictEqual(api.currentSlug(), null, 'twitch root -> null');
  Object.assign(global.location, savedLoc);
  pageSel.clear();
  console.log('R resolveYtPageKick: ytId>yt>handle>videoId>ytId-fallback tiers + host-aware currentSlug — OK');

  // ---- S: probe binds the table row; a fresh mappings object re-resolves --
  KO.mappings = { srow: { yt: '@s', ytId: 'UCSSSSSSSSSSSSSSSSSSSSSS' } };
  KO.enabled = true;
  KO.player = 'youtube';
  KO.slug = 'srow';
  KO.ytPageId = null;
  KO.ytBoundMappings = null;
  KO.activeUrl = null;
  KO.ytHlsUrl = null;
  KO.ytHlsFailed = false;
  KO.wrap = null;
  KO.kickFrame = null;
  KO.kickWin = null;
  fakeVideos.length = 0;
  Object.assign(global.location, { hostname: 'www.youtube.com', pathname: '/watch', search: '?v=abcdef' });
  pageSel.clear();
  const sMeta = el('meta'); sMeta.getAttribute = (k) => (k === 'content' ? 'UCSSSSSSSSSSSSSSSSSSSSSS' : null);
  setPageSel('meta[itemprop="channelId"]', sMeta);
  const sRowBind = KO.mappings;
  await api.probe();
  assert.strictEqual(KO.slug, 'srow', 'probe binds the table row key as slug');
  assert.strictEqual(KO.ytPageTarget && KO.ytPageTarget.slug, 'srow', 'ytPageTarget records the resolved row');
  assert.ok(KO.ytBoundMappings === sRowBind, 'ytBoundMappings === the table identity the row was bound from');
  // A fresh mappings object (storage.onChanged replaces it) must force a re-resolve.
  KO.mappings = { srow: { yt: '@s', ytId: 'UCSSSSSSSSSSSSSSSSSSSSSS' }, alt: { yt: '@alt' } };
  assert.notStrictEqual(KO.mappings, sRowBind, 'fresh mappings object changes identity');
  Object.assign(global.location, { pathname: '/watch', search: '?v=abcdef' });
  await api.probe();
  assert.ok(KO.ytBoundMappings === KO.mappings, 're-probe re-binds to the new table identity');
  assert.strictEqual(KO.slug, 'srow', 're-resolve still lands on the ytId row');
  Object.assign(global.location, savedLoc);
  pageSel.clear();
  console.log('S probe binding: row key + ytBoundMappings identity re-resolution — OK');

// ---- T: eager dual-mount class-flip preserves iframe identity -----------
  // Drive the real storage.onChanged path: a player switch (youtube<->kick)
  // must swap ko-yt/ko-kick on the SAME wrap and the SAME iframe objects,
  // with no teardown (the eager dual mount keeps both players ready).
  await api.teardown();
  KO.wrap = null;
  fakeFrame = null;
  fakeVideos.length = 0;
  Object.assign(global.location, { hostname: 'www.twitch.tv', pathname: '/rodil', search: '' });
  KO.enabled = true;
  KO.player = 'kick';
  KO.slug = 'rodil';
  KO.kickSlug = 'realkick';
  // The row carries a STORED ytId: the storage listener mirrors the row into
  // the live state on every change (`KO.ytId = m.ytId || null`), and with no
  // stored id the flip would go through the background resolver — out of
  // scope here and stubbed to "unresolved" in this harness.
  KO.mappings = { rodil: { kick: 'realkick', yt: '@x', ytId: 'UCRRRRRRRRRRRRRRRRRRRRRR' } };
  KO.ytRaw = '@x';
  KO.ytId = 'UCRRRRRRRRRRRRRRRRRRRRRR';
  const T_VIDEO = videoEl('tw-main-video');
  fakeVideos.push(T_VIDEO);
  // A LIVE kick (fetch resolves a playback_url) so the layer actually mounts
  // a frame whose identity we can assert survives a flip.
  const realFetch = global.fetch;
  global.fetch = () => Promise.resolve({
    ok: true, json: () => Promise.resolve({
      livestream: { playback_url: 'https://ivs.example/live-flip', id: 's1' },
    }),
  });
  KO.ytHlsUrl = 'https://hls.example/live-flip';
  KO.ytHlsAt = Date.now();
  KO.ytState = { ready: true, live: true, playing: true, muted: false, ct: 5, dur: 60, lat: 2 };
  fakeFrame = { ...el('iframe'), id: 'ko-yt', dataset: { koToken: 't', koReady: '1' }, contentWindow: { postMessage() {} } };
  // Mount a kick layer, then flip to youtube via a storage player change.
  await api.probe();
  assert.ok(KO.wrap, 'flip: wrap is mounted after the kick probe');
  assert.ok(KO.kickFrame, 'flip: kick frame is mounted (live url)');
  assert.ok(KO.wrap.classList.contains('ko-kick') && !KO.wrap.classList.contains('ko-yt'), 'flip: starts on the kick layer');
  const tWrap = KO.wrap;
  const tKickFrame = KO.kickFrame;
  const tSeq = KO.frameSeq;
  const fireFlip = (player) => {
    // Mirror the popup's write timing: the listener's session-fallback guard
    // compares the incoming player against the CURRENT preference, so the
    // preference must still hold the pre-flip player when the event lands.
    KO.playerPreference = KO.player;
    // Mirror chrome.storage.onChanged: enabled+player+mappings drive apply().
    const _r = storageChangedListener(
      { 'ko.v2': {
        newValue: { enabled: true, player, mappings: KO.mappings, vols: undefined },
        oldValue: { enabled: true, player: KO.player, mappings: KO.mappings, vols: undefined },
      } },
      'local',
    );
    void _r;
  };
  fireFlip('youtube'); // pChanged (player differs) -> fire(apply)
  await settle(50);
  assert.strictEqual(KO.wrap, tWrap, 'flip to youtube keeps the SAME wrap (no teardown)');
  assert.ok(KO.wrap.classList.contains('ko-yt') && !KO.wrap.classList.contains('ko-kick'), 'flip: class swapped to ko-yt');
  if (tKickFrame) assert.strictEqual(KO.kickFrame, tKickFrame, 'flip keeps the SAME kick iframe object');
  assert.strictEqual(tKickFrame.removed, 0, 'kick iframe never removed across a flip');
  const ytYf = document.getElementById('ko-yt');
  // Flip back to kick.
  fireFlip('kick');
  await settle(50);
  assert.strictEqual(KO.wrap, tWrap, 'flip back to kick keeps the SAME wrap');
  assert.ok(KO.wrap.classList.contains('ko-kick') && !KO.wrap.classList.contains('ko-yt'), 'flip back: class swapped back to ko-kick');
  assert.strictEqual(tKickFrame.removed, 0, 'second flip still does not remove the kick iframe');
  if (ytYf) assert.strictEqual(ytYf.removed, 0, 'yt iframe never removed across flips');
  assert.strictEqual(KO.frameSeq, tSeq, 'frameSeq unchanged across class flips (no rebuild)');
  fakeVideos.length = 0;
  await api.teardown();
  global.fetch = realFetch; // restore the rejecting stub for the offline cases
  Object.assign(global.location, savedLoc);
  pageSel.clear();
  console.log('T class-flip: eager dual mount flips ko-kick/ko-yt on SAME wrap + iframe identity, no teardown — OK');

  // ---- U: first-run kickMuted:true + no-clobber of a stored choice ---------
  KO.kickMuted = false;
  storage.ko = undefined;
  await api.loadState();
  // CONTRACT CHANGE (0.8.54, owner 2026-11-09: "se antes tava desmutado > vai pra
  // desmutado no player"): the fresh-profile mute seed is GONE, so a first run
  // starts AUDIBLE and `inheritState` copies the real decision across a swap.
  // This assertion used to pin the old default and was red at HEAD.
  assert.strictEqual(KO.kickMuted, false, 'first run starts audible (0.8.54: no mute nobody chose)');
  KO.kickMuted = true;
  // Audio intent is TAB-LOCAL (ko-audio.js, sessionStorage). The shared record
  // must carry no audio: a row here is what made one tab's mute reach every
  // other tab through storage.onChanged (owner report 2026-11-08).
  storage.ko = { vols: { kick: { v: 0.4, m: false }, twitch: { v: 0.2, m: true } } };
  await api.loadState();
  assert.strictEqual(KO.kickMuted, true, "another tab's stored volumes do NOT reach this tab's intent");
  assert.strictEqual(KO.kickVol, 1, 'and do not change this tab volume');
  storage.ko = { enabled: true, player: 'kick', mappings: {} };
  const savedRec = await new Promise((res) => api.saveState(false).then(() => res(storage.ko)));
  assert.ok(savedRec && !('vols' in savedRec), 'the shared record carries NO vols field');
  storage.ko = undefined;
  console.log('U mute: first run starts audible; shared record carries no audio - OK');

  // ---- V: levels -> vertical quality menu -> setLevel ----------------------
  // Reuse the mountApi's real id-tree: renderQualityMenu reads #ko-quality-menu.
  // K's mountApi.teardown() nulled mKO.wrap — re-mount to rebuild the id tree.
  mountApi.mount();
  const vWrap = mKO.wrap; // makeNode-based, querySelector resolves real ids
  mKO.player = 'kick';
  mKO.kickState = { state: 'Playing', pos: 10, qualities: [{ name: '1080p', id: 0 , ts: Date.now() }, { h: 720, id: 1 }] };
  // The quality menu only renders when the bar is open; drive renderQualityMenu directly.
  mountApi.renderQualityMenu();
  const qMenu = vWrap.querySelector('#ko-quality-menu');
  assert.ok(qMenu, 'quality menu node exists after render');
  const labels = qMenu.children.map((c) => (c.textContent || c.innerHTML || '').trim());
  assert.ok(labels.includes('Auto'), 'Auto entry present');
  assert.ok(labels.includes('1080p'), '1080p entry present');
  assert.ok(labels.includes('720p'), '720p (h-based label) present');
  assert.strictEqual(qMenu.children.length, 3, 'three entries, no stacking after one render');
  // Re-render must not stack.
  mountApi.renderQualityMenu();
  mountApi.renderQualityMenu();
  assert.strictEqual(qMenu.children.length, 3, 're-render does not stack entries');
  // Only Auto is aria-checked initially.
  const checked = qMenu.children.filter((c) => c.getAttribute('aria-checked') === 'true').length;
  assert.strictEqual(checked, 1, 'exactly one aria-checked (Auto) initially');
  console.log('V quality: vertical menu Auto/1080p/720p, no re-render stacking, single check — OK');

  // ---- W: black-box regression — kick offline + twDeleted -------------------
  // Repro shape: kick is live over a deleted Twitch player (twDeleted pins
  // the wrap at the last rect), then the kick stream ENDS. The probe's
  // offline branch is terminal — nothing is loading — so the wrap's #000
  // background must not stay up: that is the empty black box over the page.
  await api.teardown();
  Object.assign(global.location, { hostname: 'www.twitch.tv', pathname: '/rodil', search: '' });
  pageSel.clear();
  fakeVideos.length = 0;
  KO.mappings = { rodil: { kick: 'realkick', yt: '@x' } };
  KO.enabled = true;
  KO.player = 'kick';
  KO.slug = 'rodil';
  KO.kickSlug = 'realkick';
  KO.ytRaw = '@x';
  KO.ytId = 'UCWKKKKKKKKKKKKKKKKKKKKK';
  KO.twDeleted = true;
  KO.lastRect = { left: 10, top: 20, width: 400, height: 300 };
  KO.activeUrl = null;
  KO.kickUrlT = 0;
  KO.kickState = null;
  KO.kickOnDvr = false;
  KO.reconnectCount = 0;
  KO.kickEverPlayed = false;
  KO.ytHlsFailed = false;
  KO.hideTicks = 0;
  const realFetchW = global.fetch;
  global.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ livestream: { playback_url: 'https://ivs.example/dying', id: 'w1' } }),
  });
  api.mount();
  await api.probe(); // kick LIVE: the layer mounts and the wrap covers the deleted-player slot
  assert.strictEqual(KO.wrap.style.display, 'block', 'a live kick keeps the wrap up under twDeleted');
  global.fetch = realFetchW; // the broadcast ended: the API now answers offline
  KO.kickUrlT = Date.now() - 30000; // load grace expired — the loading branches no longer apply
  badge.length = 0;
  await api.probe();
  const bW = lastBadge();
  assert.strictEqual(bW.text, 'KICK', 'the offline badge still reports the chosen layer');
  assert.strictEqual(bW.color, '#6b7280', 'gray = offline');
  assert.strictEqual(KO.wrap.style.display, 'none', 'kick offline + twDeleted HIDES the wrap — no display without a playable source');
  api.rectTick();
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'none', 'the rect loop must not hold/re-show the wrap over a dead kick stream');
  // Controls — the pin stays intact for states that DO have a source:
  KO.wrap.style.display = 'block';
  KO.kickUrlT = Date.now(); // url inside the load grace is still loading
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'block', 'a loading kick keeps its pinned wrap');
  assert.strictEqual(KO.wrap.style.width, '400px', 'the last rect is still re-applied while pinned');
  KO.kickUrlT = 0;
  // 0.8.5 contract: the transient arms are only display-worthy while the poll
  // loop still confirms the source. A genuine reconnect-in-flight has that —
  // the last confirming probe stamped the clock (the confirming branch re-
  // anchors it every 20s). The stopped-clock case is pinned in Y2 below.
  KO.kickProbeAt = Date.now();
  KO.reconnectCount = 1; // a reconnect in flight shows the RECONNECTING chip
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'block', 'a reconnect in flight keeps the wrap up');
  KO.reconnectCount = 0;
  KO.player = 'youtube'; // K's contract: the yt loading placeholder pin is untouched
  KO.ytProbeAt = Date.now(); // the last youtube probe found it loading (0.8.4 clock)
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'block', 'the youtube twDeleted placeholder pin is unchanged');
  KO.player = 'kick';
  KO.twDeleted = false;
  KO.lastRect = null;
  fakeVideos.length = 0;
  console.log('W black box: kick offline + twDeleted hides the wrap, no re-show across rectTick, live/loading pins intact — OK');

  // ---- X: the twDeleted keep-up gate is PER-PLAYER (owner 0.8.3: youtube
  // "dead" + players bugged on switching). 0.8.3 asked kickLayerLive() even
  // while KO.player === 'youtube': a dead yt mint under a deleted Twitch
  // player kept the black wrap pinned forever (the keep-up branch re-shows /
  // holds whatever the gate does not hide). Invariant: never displayed
  // without a playable source FOR THE ACTIVE PLAYER.
  await api.teardown();
  Object.assign(global.location, { hostname: 'www.twitch.tv', pathname: '/rodil', search: '' });
  pageSel.clear();
  fakeVideos.length = 0;
  KO.mappings = { rodil: { kick: 'rodil', yt: '@x' } }; // same-handle kick: no handover
  KO.enabled = true;
  KO.player = 'youtube';
  KO.slug = 'rodil';
  KO.kickSlug = 'rodil';
  KO.ytRaw = '@x';
  KO.ytId = 'UCXXXXXXXXXXXXXXXXXXXXXX';
  KO.twDeleted = true;
  KO.lastRect = { left: 10, top: 20, width: 400, height: 300 };
  KO.ytHlsFailed = true;
  KO.ytHlsFailedAt = Date.now();
  KO.ytEmbedAt = Date.now() - 10000;
  KO.ytProbeAt = 0;
  KO.ytState = { ready: false, playing: false, muted: true, live: false, dur: 0, ct: 0, lat: 0, error: 0 };
  api.mount();
  KO.wrap.style.display = 'block'; // the loading-state keep-up left it up
  api.rectTick();
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'none', '0.8.3 defect: a DEAD youtube layer under twDeleted kept the blank wrap pinned — the keep-up gate asked only about kick');
  // A youtube layer still probing (mint healthy) keeps its placeholder pin.
  KO.ytHlsFailed = false;
  KO.ytProbeAt = Date.now();
  KO.wrap.style.display = 'block';
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'block', 'a minting/loading yt layer keeps the pinned placeholder (probe-grace)');
  // A live youtube layer pins too (the placeholder becomes the player) — with
  // the evidence a live layer actually has: a bridge that is still talking.
  KO.ytProbeAt = 0;
  KO.ytState.live = true;
  KO.lastYtSt = Date.now();
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'block', 'a live yt layer with a fresh bridge is pinned under twDeleted');
  console.log('X per-player keep-up: dead yt hides, loading/live yt pins — OK');

  // ---- X3: the owner's 0.8.4 black box (symptom 1). The bridge posts its
  // state every second, so KO.ytState.live is a STICKY last-known value that
  // outlives the source: a drained/ended element, a killed page, or a frame
  // whose tab was hidden all keep reporting the last transient state. 0.8.4
  // trusted it, so a dead yt layer under twDeleted stayed a pinned black box
  // forever — nothing ever cleared it. 0.8.5 requires the bridge to be FRESH
  // (within 3 polls, the window the frame-death watchdog uses for hidden-tab
  // throttling) or the probe clock to still be running.
  KO.ytProbeAt = 0;
  KO.ytState.live = true;
  KO.lastYtSt = Date.now() - 61000; // 3 * POLL_MS + 1s: the bridge went silent
  KO.wrap.style.display = 'block';
  api.rectTick();
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'none', '0.8.4 defect: a stale live flag with a silent bridge pinned the black wrap forever');
  // Inside the freshness window the same flag still pins (throttled tab).
  KO.lastYtSt = Date.now() - 55000;
  KO.wrap.style.display = 'block';
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'block', 'a throttled-but-fresh bridge (window = 3 polls, not 30s) still pins the layer');
  console.log('X3 stale live flag: silent bridge stops pinning a dead yt layer — OK');

  // ---- X2: a MANUAL switch to youtube is a retry request (owner 0.8.3
  // symptom 2: "switching players leaves players bugged"). 0.8.3 carried the
  // stale ytHlsFailed evidence across the flip, so the probe re-entered the
  // youtube branch, hit the 30s mint backoff with the flag still set, and
  // silently handed the user straight back to kick. User intent on an
  // explicit switch is "try again": the switch sites clear the evidence so
  // this probe re-mints, and only a FRESH failure may hand over.
  await api.teardown();
  Object.assign(global.location, { hostname: 'www.twitch.tv', pathname: '/rodil', search: '' });
  fakeVideos.length = 0;
  KO.enabled = true;
  KO.player = 'kick';
  KO.playerPreference = 'kick';
  KO.slug = 'rodil';
  KO.kickSlug = 'realkick'; // a REAL kick mapping: the handover gate is armed
  // The row carries the UC id: the storage listener mirrors the row into the
  // live state on every change, so a row without it would erase KO.ytId and
  // route the flip through the (unstubbed) background resolver.
  KO.mappings = { rodil: { kick: 'realkick', yt: '@x', ytId: 'UCXXXXXXXXXXXXXXXXXXXXXX' } };
  KO.ytRaw = '@x';
  KO.ytId = 'UCXXXXXXXXXXXXXXXXXXXXXX';
  KO.twDeleted = false;
  KO.ytHlsFailed = true;
  KO.ytHlsFailedAt = Date.now(); // inside the 30s backoff window
  KO.ytHlsUrl = null;
  KO.ytHlsAt = 0;
  storage.ko = undefined;
  storageChangedListener(
    { 'ko.v2': {
      newValue: { enabled: true, player: 'youtube', mappings: KO.mappings },
      oldValue: { enabled: true, player: 'kick', mappings: KO.mappings },
    } },
    'local',
  );
  assert.strictEqual(KO.player, 'youtube', 'the popup flip sets youtube mode');
  assert.strictEqual(KO.ytHlsFailed, false, 'a manual switch to youtube must drop the stale mint failure');
  await settle(60); // the flip's apply() -> probe() -> re-mint round-trip
  assert.strictEqual(KO.player, 'youtube', '0.8.3 defect: the flip back to youtube handed straight back to kick on stale failure evidence');
  assert.strictEqual(KO.ytHlsUrl, 'https://hls.example/u1', 'the switch retried the mint and got a fresh url');
  KO.player = 'kick';
  KO.playerPreference = 'kick';
  storage.ko = undefined;
  console.log('X2 manual switch: youtube flip re-mints instead of handing back to kick — OK');

  // ---- Y: a kick stream the 20s poll confirmed LIVE is never hidden by the
  // 400ms loop (owner 0.8.3: "kick UI gone while the channel IS live").
  // 0.8.3 anchored keep-up to kickUrlT (a single url-attach timestamp): a
  // first frame slower than 25s — normal on IVS url rotations — made the
  // gate hide a genuinely-live layer, fighting every showKickLayer.
  KO.twDeleted = true; // the keep-up gate under test only runs on this path
  KO.lastRect = { left: 10, top: 20, width: 400, height: 300 };
  api.mount();
  KO.player = 'kick';
  KO.ytState.live = false;
  KO.activeUrl = 'https://ivs.example/slow';
  KO.kickUrlT = Date.now() - 30000;   // the 25s url grace is spent
  KO.kickProbeAt = Date.now() - 2000; // last poll confirmed the channel LIVE
  KO.kickState = { state: 'Buffering', pos: 0, lat: 0 , ts: Date.now() };
  KO.kickEverPlayed = false;
  KO.reconnectCount = 0;
  KO.kickOnDvr = false;
  KO.wrap.style.display = 'block';
  api.rectTick();
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'block', '0.8.3 defect: a live-confirmed kick still loading its first frame was hidden by the 400ms loop mid-stream');
  // Invariant stands: a url the poll loop stopped re-confirming (offline
  // answer zeroes kickProbeAt; two missed polls hide) is not display-worthy.
  KO.kickProbeAt = Date.now() - 60000;
  api.rectTick();
  assert.strictEqual(KO.wrap.style.display, 'none', 'a kick not reconfirmed live within the poll loop is not displayed');
  // Back to Playing: the next probe re-shows WITHOUT a page reload.
  KO.kickState = { state: 'Playing', pos: 5, lat: 2 , ts: Date.now() };
  badge.length = 0;
  await api.probe();
  assert.strictEqual(KO.wrap.style.display, 'block', 'a kick back to Playing re-shows the wrap without a reload');
  assert.strictEqual(lastBadge().color, '#059669', 'green KICK badge after the recovery');
  assert.ok(KO.kickProbeAt > 0, 'a Playing probe re-anchors the keep-up clock');
  console.log('Y kick keep-up: live-confirmed load pinned, unreconfirmed hidden, Playing re-shows — OK');

  // ---- Z: mouse activity re-arms the control bar over the SHOWN wrap
  // (owner 0.8.3 symptom 4: "the UI never comes back once the mouse moves
  // off"). The wrap is pointer-events:none (page UI stays clickable under
  // it), so pointer events can NEVER reach the wrap's own listeners —
  // 0.8.2/0.8.3 armed the hot bar only at mount time. The arm must live at
  // document level with a hit-test on the wrap rect.
  mountApi.teardown();
  const docEvents = {};
  mountDoc.addEventListener = (t, f) => { (docEvents[t] = docEvents[t] || []).push(f); };
  mountDoc.removeEventListener = (t, f) => { if (docEvents[t]) docEvents[t] = docEvents[t].filter((x) => x !== f); };
  mountApi.mount();
  mKO.wrap.style.display = 'block';
  mKO.wrap.classList.remove('ko-hot');
  // Wrap rect in this stub world: left 10, top 20, 400x300.
  (docEvents.pointermove || []).forEach((f) => f({ clientX: 200, clientY: 150 }));
  assert.ok(mKO.wrap.classList.contains('ko-hot'), '0.8.3 defect: a mouse move over the visible overlay never re-armed the hot bar — the wrap listens for events it cannot receive');
  mKO.wrap.classList.remove('ko-hot');
  (docEvents.pointermove || []).forEach((f) => f({ clientX: 900, clientY: 500 }));
  assert.ok(!mKO.wrap.classList.contains('ko-hot'), 'a pointer move OUTSIDE the wrap rect does not re-arm (hit-test, not blanket)');
  mKO.wrap.style.display = 'none';
  mKO.wrap.classList.remove('ko-hot');
  (docEvents.pointermove || []).forEach((f) => f({ clientX: 200, clientY: 150 }));
  assert.ok(!mKO.wrap.classList.contains('ko-hot'), 'a hidden wrap does not re-arm');
  mountApi.teardownHotBar();
  (docEvents.pointermove || []).forEach((f) => f({ clientX: 200, clientY: 150 }));
  assert.ok(!mKO.wrap.classList.contains('ko-hot'), 'a pointermove after teardownHotBar never re-arms the bar');
  console.log('Z hover re-arm: document-level pointermove over the wrap rect re-arms the bar; outside/hidden do not — OK');

  // ---- P1a: yt HLS — arrow-right at/over the live edge sends seekToLive,
  // not an over-shoot seek that snaps back (owner pain 1: arrows don't
  // return to live). seekOverlayStep(+ARROW_SEEK_SEC) from within the window
  // seeks; once the next step would cross ct+lat it goes seekToLive.
  KO.wrap = wrap;
  KO.player = 'youtube';
  KO.kickFrame = null; KO.kickWin = null;
  fakeFrame = { ...el('iframe'), contentWindow: { postMessage: (m) => framePosts.push(m) } };
  fakeFrame.dataset.koToken = 'p1yt';
  fakeFrame.dataset.koReady = '1'; // committed navigation (see the 0.8.47 ready gate)
  doc.getElementById = (id) => (id === 'ko-yt' ? fakeFrame : null);
  KO.ytState = { ready: true, live: true, playing: true, muted: false, ct: 40, dur: 60, lat: 7 }; // edge = 47
  framePosts.length = 0;
  // within window: 40+5=45 < 47 -> plain seek
  api.seekOverlayStep(5);
  let p1ytSeek = framePosts.map((m) => m && m.__koKick && m.__koKick.t === 'seek' && m.__koKick.s);
  assert.strictEqual(p1ytSeek.length, 1, 'yt: arrow-right from inside the window seeks');
  assert.strictEqual(p1ytSeek[0], 45, 'yt: seeks to ct+delta while still inside the window');
  // next step: with lat < step (lat=2, edge=42) a 5s arrow over-shoots the
  // edge (40+5=45 >= 42) -> seekToLive, not an over-shoot seek.
  KO.ytState = { ready: true, live: true, playing: true, muted: false, ct: 40, dur: 60, lat: 2 };
  framePosts.length = 0;
  api.seekOverlayStep(5);
  const p1ytLive = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seekToLive').length;
  assert.strictEqual(p1ytLive, 1, 'yt: arrow-right at/over the live edge sends seekToLive (no over-shoot seek)');
  console.log('P1a yt edge: arrow-right to the live edge becomes seekToLive, inside window seeks — OK');

  // ---- P1b: kick — on the LIVE url an edge-ward (forward) press sends the
  // cheap seekToLive directly, never the full live-url reload; only a real
  // DVR rewind may reload the live url. Owner pain 1 (kick kick).
  KO.player = 'kick';
  KO.kickOnDvr = false;              // on the live url
  KO.activeUrl = 'https://ivs.example/live-p1b';
  KO.kickState = { state: 'Playing', pos: 100, lat: 1, dur: 200 , ts: Date.now() };
  KO.kickFrame = fakeFrame; KO.kickWin = fakeFrame.contentWindow; // kickSend target
  framePosts.length = 0;
  api.seekOverlayStep(5);
  const p1bSeekLive = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seekToLive').length;
  const p1bReload = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'load').length;
  assert.strictEqual(p1bSeekLive, 1, 'kick: forward press on the live url sends seekToLive');
  assert.strictEqual(p1bReload, 0, 'kick: forward press on the live url must NOT reload (0.8.5: it hit kickBackToLive->load)');
  // same at the edge (already live, lat tiny): still cheap seekToLive, no reload
  KO.kickState = { state: 'Playing', pos: 199, lat: 0, dur: 200 , ts: Date.now() };
  framePosts.length = 0;
  api.seekOverlayStep(5);
  const p1bEdge = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seekToLive').length;
  const p1bEdgeReload = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'load').length;
  assert.strictEqual(p1bEdge, 1, 'kick: already at the live edge, forward press still only seekToLive');
  assert.strictEqual(p1bEdgeReload, 0, 'kick: already live, forward press never reloads');
  // On the DVR url a deep rewind stays a DVR seek; the returning forward
  // press near the DVR tail reloads live (kick semantics, acceptable) — the
  // clamp is not lost.
  KO.kickOnDvr = true; KO.kickDvrUrl = 'https://dvr.example/p1b';
  KO.kickState = { state: 'Playing', pos: 10, lat: 2, dur: 200 , ts: Date.now() };
  framePosts.length = 0;
  api.seekOverlayStep(-5); // 10-5=5, far from edge -> DVR load/seeks
  const p1bDvr = framePosts.filter((m) => m && m.__koKick && (m.__koKick.t === 'load' || m.__koKick.t === 'seek')).length;
  assert.strictEqual(p1bDvr, 1, 'kick DVR: back-seek routes to the DVR path (load/seek), not seekToLive');
  console.log('P1b kick edge: live-url forward press = seekToLive only (no reload); DVR rewind preserved — OK');

  // P1b2: a back-seek INSIDE the live element's own window is done in place.
  // Owner 2026-11-11: "quando eu clico pra dar seek no player da kick nao e pra
  // ele pausar e despausar. e pra continuar rodando" — the reload of the DVR url
  // is the stop, so it may only happen when the window cannot reach the target.
  // The shipped module's own send counters are the observable (kickDiag), reset
  // per call so the arm measures exactly one decision.
  // The functions being measured are mountApi's, so their state object is
  // mountApi.KO (content.js is evaluated twice by this harness: `api` and
  // `mountApi` each own a KO; the ones that matter here are mKO's).
  const K2 = mKO;
  K2.kickOnDvr = false;
  K2.kickDvrUrl = 'https://dvr.example/p1b2';
  K2.activeUrl = 'https://ivs.example/live-p1b2';
  K2.kickDur = 0; // the bar's max comes from pos+lat, so the edge is 1000
  K2.kickState = { state: 'Playing', pos: 1000, lat: 2, dur: 0, win: 40, ts: Date.now() };
  fakeFrame = { ...el('iframe'), dataset: { koToken: 'p1b2' }, contentWindow: { postMessage: (m) => framePosts.push(m) } };
  K2.kickFrame = fakeFrame; K2.kickWin = fakeFrame.contentWindow;
  const sendCounts = () => {
    const d = K2.kickDiag || {};
    const b = d.sentByType || {};
    return { seek: b.seek || 0, load: b.load || 0, live: b.seekToLive || 0 };
  };
  K2.kickDiag = null;
  mountApi.kickSeekTo(970); // 30 s behind the edge, inside a 40 s window
  const inPlace = sendCounts();
  assert.strictEqual(inPlace.seek, 1, `live window: back-seek must send exactly one in-place seek (got ${JSON.stringify(inPlace)})`);
  assert.strictEqual(inPlace.load, 0, 'live window: back-seek must NOT reload the source (that is the visible stop)');
  K2.kickDiag = null;
  mountApi.kickSeekTo(800); // 200 s back, OUTSIDE the 40 s window
  const deep = sendCounts();
  assert.strictEqual(deep.load, 1, `outside the live window the DVR url is still loaded (got ${JSON.stringify(deep)})`);
  assert.strictEqual(deep.seek, 0, 'outside the live window an in-place seek cannot reach the target');
  // RED for the same decision: with NO window published (the pre-fix state,
  // where `st.win` did not exist at all) the same 30 s back-seek reloads the
  // source. If this ever stops reloading, the arm above proves nothing.
  // Sentinel guard: `seekable.end` is 1073741824 when the window is unknown
  // (measured on a live IVS url). A 30 s back-seek must NOT be treated as
  // reachable in place on that number - a live timeline cannot hold it and the
  // frame bounces back to the edge.
  K2.kickOnDvr = false;
  K2.kickState = { state: 'Playing', pos: 1000, lat: 2, dur: 0, win: 1073741824, ts: Date.now() };
  K2.kickDiag = null;
  mountApi.kickSeekTo(970);
  const sentinel = sendCounts();
  assert.strictEqual(sentinel.load, 1, `sentinel win must not authorise an in-place seek (got ${JSON.stringify(sentinel)})`);
  K2.kickOnDvr = false; // the deep seek above switched the frame to the replay
  K2.kickState = { state: 'Playing', pos: 1000, lat: 2, dur: 0, ts: Date.now() };
  K2.kickDiag = null;
  mountApi.kickSeekTo(970);
  const noWindow = sendCounts();
  assert.strictEqual(noWindow.load, 1, `pre-fix (no window): the same seek must reload (got ${JSON.stringify(noWindow)})`);
  console.log('P1b2 live-window seek: in place inside st.win, reload only outside it — OK');

  // P1b clean-room variant: self-contained (explicit kickOnDvr=false +
  // activeUrl + kickState with a fresh st.ts, NO reliance on clobbered state
  // from earlier sections) and proves the 0.8.5 reload cliff is gone even
  // with kickDur UNSET — a clean long-running stream fixture (pos+lat riding
  // the edge). On 0.8.5, kickSeekTo computed max = Math.ceil(pos+lat) = the
  // edge, so a forward press past edge−30 fell into kickBackToLive → live-url
  // 'load'; post-fix the live-url forward branch short-circuits to seekToLive.
  // Also an erase-echo remains inert here because this path never enters the
  // retry arm (no playerAt involved).
  KO.kickOnDvr = false;
  KO.activeUrl = 'https://ivs.example/live-p1b-clean';
  KO.kickState = { state: 'Playing', pos: 100, lat: 1, ts: Date.now() }; // no dur → kickDur unset (=0)
  KO.kickFrame = fakeFrame; KO.kickWin = fakeFrame.contentWindow;
  framePosts.length = 0;
  api.seekOverlayStep(5);
  const p1bCleanLive = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seekToLive').length;
  const p1bCleanReload = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'load').length;
  assert.strictEqual(p1bCleanLive, 1, 'clean-room (kickDur unset): forward live-url press sends exactly one seekToLive');
  assert.strictEqual(p1bCleanReload, 0, 'clean-room (kickDur unset): NO live-url reload (0.8.5 cliff path is dead)');

  // ---- P1c: display-agnostic keydown gate — a HIDDEN wrap (transient rect
  // miss hides it up to 20s) must still answer arrows. 0.8.5 gate bailed on
  // display:none = dead arrows. Drive onOverlayKeydown directly with the
  // wrap hidden; a kick seek/seekToLive must be issued.
  KO.player = 'kick';
  KO.kickOnDvr = false;
  KO.activeUrl = 'https://ivs.example/live-p1c';
  KO.kickState = { state: 'Playing', pos: 100, lat: 1, dur: 120 , ts: Date.now() };
  KO.kickFrame = fakeFrame; KO.kickWin = fakeFrame.contentWindow;
  KO.wrap.style.display = 'none';    // hidden, yet selected
  framePosts.length = 0;
  api.onOverlayKeydown({
    key: 'ArrowRight', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: wrap, preventDefault() {}, stopImmediatePropagation() {},
  });
  const p1cLive = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seekToLive').length;
  assert.strictEqual(p1cLive, 1, 'hidden-but-selected wrap still answers ArrowRight (seekToLive), not dead');
  // judge P2: the re-arm must be layer-correct — showKickLayer sends play, so
  // the re-shown frame is NOT frozen black. p1cLive === 1 is the dedupe pin:
  // without it showKickLayer's wasHidden seekToLive + the ArrowRight step
  // would put TWO seekToLive on the queue.
  const p1cPlay = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'play').length;
  assert.strictEqual(p1cPlay, 1, 'hidden kick re-arm sends play (showKickLayer, not bare showWrap)');
  // Left arrow on a hidden yt wrap must also seek.
  KO.player = 'youtube';
  KO.ytState = { ready: true, live: true, playing: true, muted: false, ct: 40, dur: 60, lat: 7 };
  KO.kickFrame = null; KO.kickWin = null;
  fakeFrame = { ...el('iframe'), contentWindow: { postMessage: (m) => framePosts.push(m) } };
  fakeFrame.dataset.koToken = 'p1cy';
  fakeFrame.dataset.koReady = '1';
  doc.getElementById = (id) => (id === 'ko-yt' ? fakeFrame : null);
  framePosts.length = 0;
  api.onOverlayKeydown({
    key: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: wrap, preventDefault() {}, stopImmediatePropagation() {},
  });
  const p1cSeek = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seek' && m.__koKick.s === 35).length;
  assert.strictEqual(p1cSeek, 1, 'hidden yt wrap still seeks back (ArrowLeft -> seek 35), not dead');
  KO.wrap.style.display = 'block';
  fakeFrame = null;
  framePosts.length = 0;
  console.log('P1c hidden gate: overlay answers arrows while the wrap is hidden (display-agnostic) — OK');

  // ---- A3: the arrow contract, driven through the REAL seekOverlayStep and
  // onOverlayKeydown. Owner 2026-11-20: "ta HORRIVEL de usar a setinha pros
  // lados, no player da kick... deveria acontecer igual no youtube, que volta 5
  // segundos, mas o play continua" + "apertar varias vezes rapido nao deveria
  // bugar". His ring showed each press moving ~5s back with `playing:true`, and
  // then the IVS element re-basing to pos 0 and reloading at the live edge -
  // the whole rewind destroyed - while one press emitted NO row at all (the old
  // `if (lat >= 25) return;` swallowed it). Each limb below runs a mutation that
  // restores the pre-fix line and turns it RED.
  {
    const kickRows = (from) => swCalls.slice(from).filter((m) => m && m.__koDiag && m.__koDiag.ev === 'arrow-step').map((m) => m.__koDiag.data);
    const sentSince = (from, t) => framePosts.slice(from).filter((m) => m && m.__koKick && m.__koKick.t === t).map((m) => m.__koKick);
    // A live kick player that reports the element's own back-buffer (`hold`),
    // which is the number that decides an in-place rewind.
    const liveKick = (over) => {
      KO.player = 'kick';
      KO.wrap = wrap;
      KO.kickOnDvr = false;
      KO.kickDvrUrl = 'https://dvr.example/a3';
      KO.activeUrl = 'https://ivs.example/live-a3';
      KO.kickDur = 0;
      KO.kickDurClock = 'element-session-clock';
      KO.kickStep = null;
      KO.kickStreamStart = null;
      KO.kickDvrFetchedAt = 0;
      KO.kickDvrDur = 1000; // published replay edge (replay-published-clock)
      KO.kickDvrDurAt = Date.now();
      Object.assign(KO, { kickState: { state: 'Playing', paused: false, pos: 1000, lat: 3, dur: 0, win: 0, hold: 40, ts: Date.now() } }, over || {});
      fakeFrame = { ...el('iframe'), dataset: { koToken: 'a3' }, contentWindow: { postMessage: (m) => framePosts.push(m) } };
      KO.kickFrame = fakeFrame; KO.kickWin = fakeFrame.contentWindow;
    };
    const press = (key) => api.onOverlayKeydown({
      key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      target: wrap, preventDefault() {}, stopImmediatePropagation() {},
    });
    const mkA3 = (from, to) => {
      assert.ok(src.includes(from), `A3 RED: the mutation target is gone: ${from.slice(0, 60)}`);
      const realSetInterval = global.setInterval;
      global.setInterval = () => 0;
      try {
        return new Function('window', 'document', 'location', 'navigator', src.replace(from, to)
          + '\n;return {KO, seekOverlayStep, onOverlayKeydown};')(global, doc, global.location, global.navigator);
      } finally { global.setInterval = realSetInterval; }
    };
    const prepA3 = (mod, over) => {
      const K = mod.KO;
      K.player = 'kick';
      K.wrap = wrap;
      K.kickOnDvr = false;
      K.kickDvrUrl = 'https://dvr.example/a3';
      K.activeUrl = 'https://ivs.example/live-a3';
      K.kickDur = 0;
      K.kickDurClock = 'element-session-clock';
      K.kickStep = null;
      K.kickStreamStart = null;
      K.kickDvrFetchedAt = 0;
      K.kickDvrDur = 1000; // published replay edge, so a handoff has a usable clock
      K.kickDvrDurAt = Date.now();
      Object.assign(K, { kickState: { state: 'Playing', paused: false, pos: 1000, lat: 3, dur: 0, win: 0, hold: 40, ts: Date.now() } }, over || {});
      const posts = [];
      K.kickFrame = { dataset: { koToken: 'a3red' } };
      K.kickWin = { postMessage: (m) => posts.push(m) };
      return posts;
    };

    // A3a: ONE press is exactly one step, in place, with no reload of the
    // source (the reload is the visible stop the owner hears as "flica").
    liveKick();
    let b = swCalls.length;
    let p = framePosts.length;
    press('ArrowLeft');
    let rows1 = kickRows(b);
    let seeks1 = sentSince(p, 'seek');
    assert.strictEqual(rows1.length, 1, `A3a: one press must emit exactly one row (got ${JSON.stringify(rows1)})`);
    assert.strictEqual(rows1[0].act, 'seek', `A3a: a rewind inside the hold must seek in place (got ${rows1[0].act})`);
    assert.strictEqual(rows1[0].dir, 'back', 'A3a: the row names the direction');
    assert.strictEqual(rows1[0].engine, 'kick', 'A3a: the row names the engine');
    assert.strictEqual(seeks1.length, 1, `A3a: exactly one seek (got ${seeks1.length})`);
    assert.strictEqual(seeks1[0].s, 995, `A3a: one press is 5s back from 1000 (got ${seeks1[0].s})`);
    assert.strictEqual(sentSince(p, 'load').length, 0, 'A3a: a 5s step inside the hold must not reload the source');
    assert.strictEqual(rows1[0].hold, 40, 'A3a: the row carries the back-buffer it compared against');
    assert.strictEqual(rows1[0].lat, 3, 'A3a: the row carries the latency it compared against');
    {
      const red = mkA3('  const room = Math.max(0, (held > 0 ? held : lat) - KICK_STEP_MARGIN_SEC);', '  const room = 0; // RED: hold ignored');
      const posts = prepA3(red);
      red.seekOverlayStep(-5);
      assert.strictEqual(posts.filter((m) => m.__koKick && m.__koKick.t === 'load').length, 1, 'A3a RED: without the hold budget a 5s step reloads the source');
    }
    console.log('A3a arrow hold: one press = 5s back, seek in place, no reload, row names hold/lat - OK');

    // A3b: THREE presses inside one 1s report are 3 x 5s, composed from local
    // pending state - never from a `st` report the player has not answered yet.
    liveKick();
    b = swCalls.length;
    p = framePosts.length;
    press('ArrowLeft'); press('ArrowLeft'); press('ArrowLeft');
    const rows3 = kickRows(b);
    const seeks3 = sentSince(p, 'seek').map((m) => m.s);
    assert.strictEqual(rows3.length, 3, `A3b: three presses, three rows (got ${rows3.length})`);
    assert.deepStrictEqual(seeks3, [995, 990, 985], `A3b: rapid presses compose 5s each (got ${JSON.stringify(seeks3)})`);
    assert.strictEqual(rows3[2].from, 990, 'A3b: the third press starts from the pending target, not the stale report');
    assert.strictEqual(sentSince(p, 'load').length, 0, 'A3b: three presses inside the hold never reload');
    {
      const red = mkA3("  const anchor = !burst ? pos : (delta < 0 ? Math.min(pos, burst.target) : Math.max(pos, burst.target));", '  const anchor = pos; // RED: no local pending state');
      const posts = prepA3(red);
      red.seekOverlayStep(-5); red.seekOverlayStep(-5); red.seekOverlayStep(-5);
      const got = posts.map((m) => m.__koKick && m.__koKick.s);
      assert.deepStrictEqual(got, [995, 995, 995], `A3b RED: composing from the stale report collapses the burst (got ${JSON.stringify(got)})`);
    }
    console.log('A3b arrow burst: 3 rapid presses = 15s from local pending, never from a stale report - OK');

    // A3c: a burst that leaves what the element holds is HANDED OFF to the
    // replay at the broadcast offset and keeps playing - it is never reloaded
    // to the live edge (his ring: pos 540.15 -> 0 -> 27375.85, rewind lost).
    liveKick({ kickState: { state: 'Playing', paused: false, pos: 1000, lat: 3, dur: 0, win: 0, hold: 12, ts: Date.now() } });
    b = swCalls.length;
    p = framePosts.length;
    press('ArrowLeft'); press('ArrowLeft'); press('ArrowLeft');
    const rowsH = kickRows(b);
    const loads = sentSince(p, 'load');
    assert.strictEqual(rowsH[2].act, 'handoff-dvr', `A3c: the press past the hold hands off (got ${rowsH[2].act})`);
    assert.strictEqual(loads.length, 1, `A3c: the handoff loads the replay once (got ${loads.length})`);
    assert.strictEqual(sentSince(p, 'seekToLive').length, 0, 'A3c: a rewind past the hold never reloads to the live edge');
    assert.strictEqual(KO.kickOnDvr, true, 'A3c: the source is now the replay');
    assert.ok(KO.kickStep && KO.kickStep.onDvr === true, 'A3c: the burst continues on the replay clock, so the next press composes');
    {
      const red = mkA3("(KO.kickDvrUrl && handoffRoom > 0 ? 'handoff-dvr' : 'blocked')", "('blocked' /* RED: no handoff */)");
      const posts = prepA3(red, { kickState: { state: 'Playing', paused: false, pos: 1000, lat: 3, dur: 0, win: 0, hold: 12, ts: Date.now() } });
      red.seekOverlayStep(-5); red.seekOverlayStep(-5); red.seekOverlayStep(-5);
      assert.strictEqual(posts.filter((m) => m.__koKick && m.__koKick.t === 'load').length, 0, 'A3c RED: without the handoff the rewind past the hold never reaches the replay');
    }
    console.log('A3c arrow handoff: past the live hold the rewind continues on the replay source, never the live edge - OK');

    // A3d: every refused press names itself - a guard that returns without a
    // row is the class that made his report unanswerable. No replay source and
    // no hold room means the press cannot be honoured; it must say so.
    liveKick({ kickState: { state: 'Playing', paused: false, pos: 1000, lat: 3, dur: 0, win: 0, hold: 12, ts: Date.now() }, kickDvrUrl: null });
    b = swCalls.length;
    press('ArrowLeft'); press('ArrowLeft'); press('ArrowLeft');
    const rowsB = kickRows(b);
    assert.strictEqual(rowsB.length, 3, 'A3d: a refused press still emits its row');
    assert.strictEqual(rowsB[2].act, 'blocked', `A3d: the press past the hold with no replay is blocked (got ${rowsB[2].act})`);
    assert.strictEqual(rowsB[2].why, 'no-replay-source', `A3d: the refusal names the reason (got ${JSON.stringify(rowsB[2].why)})`);
    assert.strictEqual(sentSince(p = framePosts.length, 'seekToLive').length, 0, 'A3d: a blocked rewind never becomes an implicit go-live');
    // no wrap at all: the pre-fix silent return, now a row with a reason
    KO.wrap = null;
    b = swCalls.length;
    api.seekOverlayStep(-5);
    const rowsNW = kickRows(b);
    assert.strictEqual(rowsNW.length, 1, 'A3d: no-wrap press still emits a row');
    assert.strictEqual(rowsNW[0].why, 'no-wrap', 'A3d: the no-wrap refusal names its reason');
    {
      const red = mkA3("    arrowStepRow('refused', { delta, why: !KO.wrap ? 'no-wrap' : 'player-twitch' });\n    return;", '    return; // RED: silent refusal');
      const posts = prepA3(red);
      red.KO.wrap = null;
      red.seekOverlayStep(-5);
      assert.strictEqual(posts.length, 0, 'A3d RED: a silent refusal sends nothing AND logs nothing');
    }
    console.log('A3d arrow refusals: a refused press names itself, never a silent return - OK');

    // A3e: ArrowRight stays the mirror - one step forward behind the edge, and
    // go-live within a step of it (the distance is the LATENCY domain, not the
    // broadcast clock that `pos` carries).
    liveKick({ kickState: { state: 'Playing', paused: false, pos: 1000, lat: 20, dur: 0, win: 0, hold: 40, ts: Date.now() } });
    p = framePosts.length;
    press('ArrowRight');
    assert.deepStrictEqual(sentSince(p, 'seek').map((m) => m.s), [1005], 'A3e: behind the edge ArrowRight advances one step');
    assert.strictEqual(sentSince(p, 'seekToLive').length, 0, 'A3e: a step forward from 20s behind is not a go-live');
    liveKick({ kickState: { state: 'Playing', paused: false, pos: 1000, lat: 2, dur: 0, win: 0, hold: 40, ts: Date.now() } });
    p = framePosts.length;
    press('ArrowRight');
    assert.strictEqual(sentSince(p, 'seekToLive').length, 1, 'A3e: at the edge ArrowRight means go live');
    {
      const red = mkA3("    const edgeDist = KO.kickOnDvr ? Infinity : lat + (pos - anchor);", "    const edgeDist = KO.kickOnDvr ? Infinity : pos + lat; // RED: broadcast clock read as latency");
      const posts = prepA3(red);
      red.seekOverlayStep(5);
      assert.strictEqual(posts.filter((m) => m.__koKick && m.__koKick.t === 'seekToLive').length, 0, 'A3e RED: reading pos+lat as the edge distance sends a seek where the edge means go-live');
    }
    KO.wrap = wrap;
    framePosts.length = 0;
    console.log('A3e arrow mirror: ArrowRight steps forward behind the edge and goes live at it - OK');

    // A3f: THE REPORT IN THE MIDDLE. The frame posts `st` between two rapid
    // presses (it does: every seek flushes one), and that report still
    // describes the PRE-seek playhead - the seek takes a frame or two to
    // land. The burst must therefore compose onto the deepest INTENT, not
    // onto whatever the report says: measured 0.8.108 on the replay source,
    // three presses inside 1s all composed to the SAME target and the owner
    // lost 10 of the 15 seconds ("volta 1-2s e a live atrapalha").
    liveKick({ kickState: { state: 'Playing', paused: false, pos: 1000, lat: 1, dur: 5000, win: 5000, hold: 3, ts: Date.now() } });
    KO.kickOnDvr = true; // the replay source: `pos` is the broadcast clock
    b = swCalls.length;
    p = framePosts.length;
    press('ArrowLeft');
    // The report the player emits while the seek is still travelling: it
    // landed 4s short of the target the burst asked for.
    KO.kickState = { state: 'Playing', paused: false, pos: 999, lat: 1, dur: 5000, win: 5000, hold: 3, ts: Date.now() };
    press('ArrowLeft');
    KO.kickState = { state: 'Playing', paused: false, pos: 999, lat: 1, dur: 5000, win: 5000, hold: 3, ts: Date.now() };
    press('ArrowLeft');
    const rowsF = kickRows(b);
    assert.strictEqual(rowsF.length, 3, `A3f: three presses, three rows (got ${rowsF.length})`);
    assert.deepStrictEqual(
      sentSince(p, 'seek').map((m) => m.s),
      [995, 990, 985],
      `A3f: a stale report between presses must not re-compose to the same target (got ${JSON.stringify(sentSince(p, 'seek').map((m) => m.s))})`,
    );
    // `pending` is measured against the report the press was judged on, so it
    // deepens only as far as the report lags the intent - and the INTENT is
    // the sum: 1000 - 985 = 15s over three presses.
    assert.deepStrictEqual(rowsF.map((r) => r.pending), [-5, -9, -14], `A3f: each row states how deep its own intent sits behind the report it saw (got ${JSON.stringify(rowsF.map((r) => r.pending))})`);
    assert.strictEqual(rowsF[0].to - rowsF[2].to, 10, 'A3f: three presses advance the intent 10s past the first target');
    assert.strictEqual(rowsF[0].from - rowsF[2].to, 15, 'A3f: the burst walks the full 15s from the playhead the first press saw');
    assert.strictEqual(sentSince(p, 'load').length, 0, 'A3f: a rewind the replay can hold never reloads it');
    {
      // RED: the pre-fix report handler, which cleared the burst as soon as a
      // report was within the absorb window of its target (0.8.108's rule).
      // RED: the pre-fix anchor, which composed onto a report the seek had not
      // reached yet instead of onto the intent the burst already holds.
      const redClear = mkA3(
        "  const anchor = !burst ? pos : (delta < 0 ? Math.min(pos, burst.target) : Math.max(pos, burst.target));",
        "  const anchor = (burst && Math.abs(pos - burst.target) > KICK_STEP_ABSORB_SEC) ? burst.target : pos; // RED: a report near the intent retires the burst (0.8.108)",
      );
      const posts = prepA3(redClear, { kickState: { state: 'Playing', paused: false, pos: 1000, lat: 1, dur: 5000, win: 5000, hold: 3, ts: Date.now() } });
      const R = redClear.KO;
      R.kickOnDvr = true;
      redClear.seekOverlayStep(-5);
      // The seek landed 1s short of its target (IVS lands on a segment
      // boundary); the next press must still add a full step to the INTENT.
      R.kickState = { state: 'Playing', paused: false, pos: 996, lat: 1, dur: 5000, win: 5000, hold: 3, ts: Date.now() };
      redClear.seekOverlayStep(-5);
      const got = posts.map((m) => m.__koKick && m.__koKick.s).filter((v) => v !== undefined);
      assert.deepStrictEqual(got, [995, 991], `A3f RED: an intent the player has not reached yet collapses the next step onto it (got ${JSON.stringify(got)})`);
    }
    console.log('A3f arrow coalesced report: a stale st between presses never swallows a step - OK');

    // A3g: A BURST MAY ONLY CLAIM WHAT THE ELEMENT DELIVERED. The frame drops
    // a seek issued while another is still travelling (measured live 2026-11-20
    // on the replay: three presses 124/130 ms apart reached `pending` -15 while
    // the element moved 9.43 s). The element's own report is the only evidence
    // of delivery, so the burst verifies against it: one re-issue of the SAME
    // target, then - if the element still has not arrived - the claim is
    // withdrawn and the loss named instead of carried into the next press.
    const relaySt = (frame, st) => msgListeners.forEach((listener) => listener({
      source: frame.contentWindow,
      origin: new URL(chromeStub.runtime.getURL('player.html')).origin,
      data: { __koKick: { t: 'st', st, _koToken: frame.dataset.koToken } },
    }));
    const replaySt = (pos) => ({ state: 'Playing', paused: false, pos, lat: 0, dur: 5000, win: 5000, hold: 3 });
    // The page's yt-element lookup must not claim this frame (an earlier arm
    // leaves `getElementById('ko-yt')` pointing at the shared fakeFrame).
    doc.getElementById = () => null;
    liveKick({ kickState: replaySt(1000) });
    KO.kickOnDvr = true; // the replay: `pos` is the broadcast clock, `win` its seekable span
    b = swCalls.length;
    p = framePosts.length;
    press('ArrowLeft'); press('ArrowLeft'); press('ArrowLeft');
    let rowsG = kickRows(b);
    assert.strictEqual(rowsG.length, 3, `A3g: three presses, three rows (got ${rowsG.length})`);
    assert.deepStrictEqual(sentSince(p, 'seek').map((m) => m.s), [995, 990, 985], 'A3g: three composed seeks leave the page, one per press');
    assert.strictEqual(rowsG[2].room, 1000, `A3g: the replay row carries the seekability it compared against (got ${rowsG[2].room})`);
    assert.strictEqual(rowsG[2].roomSrc, 'replay-window', `A3g: ... and NAMES the quantity (got ${rowsG[2].roomSrc})`);
    // The frame answered only the FIRST seek: its report says 991 - nine of the
    // fifteen seconds the burst asked for.
    KO.kickStep.sentAt = Date.now() - 5000; // the settle window has elapsed
    p = framePosts.length;
    relaySt(KO.kickFrame, replaySt(991));
    rowsG = kickRows(b);
    assert.strictEqual(rowsG.length, 4, `A3g: the undelivered step gets its own row (got ${rowsG.length})`);
    assert.strictEqual(rowsG[3].act, 'catch-up', `A3g: the lost step is re-asked once (got ${rowsG[3].act})`);
    assert.strictEqual(rowsG[3].why, 'pending-dropped', `A3g: ... and the row names why (got ${rowsG[3].why})`);
    assert.deepStrictEqual(sentSince(p, 'seek').map((m) => m.s), [985], 'A3g: the re-issue asks for the burst OWN target, never a new intent');
    // The element still does not take it: the claim is withdrawn rather than
    // reported as if the picture had moved.
    KO.kickStep.sentAt = Date.now() - 5000;
    p = framePosts.length;
    relaySt(KO.kickFrame, replaySt(991));
    rowsG = kickRows(b);
    assert.strictEqual(rowsG.length, 5, `A3g: the dropped claim emits its own row (got ${rowsG.length})`);
    assert.strictEqual(rowsG[4].act, 'blocked', `A3g: a step the element will not deliver is refused (got ${rowsG[4].act})`);
    assert.strictEqual(rowsG[4].why, 'pending-dropped', `A3g: ... named (got ${rowsG[4].why})`);
    assert.strictEqual(rowsG[4].pending, 0, `A3g: a refused row claims no depth (got ${rowsG[4].pending})`);
    assert.strictEqual(KO.kickStep, null, 'A3g: the burst is spent; the next press starts from the report, not the lost intent');
    {
      // RED: the pre-fix code verified nothing - a report proving the steps
      // were dropped left the burst claiming 15s and never re-asked them.
      const red = mkA3('} else if (age >= KICK_STEP_SETTLE_MS) {', '} else if (false) { // RED: delivery never verified');
      const posts = prepA3(red, { kickState: replaySt(1000) });
      const R = red.KO;
      R.kickOnDvr = true;
      R.kickFrame.contentWindow = R.kickWin;
      red.seekOverlayStep(-5); red.seekOverlayStep(-5); red.seekOverlayStep(-5);
      R.kickStep.sentAt = Date.now() - 5000;
      relaySt(R.kickFrame, replaySt(991));
      assert.ok(R.kickStep, 'A3g RED: without the delivery check the burst survives a report that proves nothing landed');
      assert.strictEqual(R.kickStep.target, 985, 'A3g RED: ... and keeps claiming the full 15s the element never delivered');
      assert.strictEqual(posts.filter((m) => m.__koKick && m.__koKick.t === 'seek').length, 3, 'A3g RED: no catch-up seek is ever issued');
    }
    console.log('A3g arrow delivery: an undelivered step is re-asked once, then the claim is withdrawn - OK');
  }

  // ---- P2a: bridge relays iframe-focus overlay keys (pain 2 — "player not
  // keyboard-controllable"). The extension-page bridge (both HLS and IVS
  // branches) addEventListener('keydown') for f/arrows, preventDefaults, and
  // posts {t:'key',k} up; native YT keys like space are untouched.
  assert.ok(bridgeSrc.includes("const RELAY_KEYS = new Set(['f', 'arrowleft', 'arrowright']);"), 'bridge declares the f/arrow relay whitelist');
  assert.ok(bridgeSrc.includes('window.addEventListener(\'keydown\', (ev) => {'), 'bridge has ONE shared keydown relay (both engines)');
  assert.ok(bridgeSrc.includes('post({ t: \'key\', k });'), 'bridge forwards the key upward as {t:key,k}');
  assert.ok(bridgeSrc.includes('try { ev.preventDefault(); } catch'), 'bridge preventDefaults the relayed key');
  // It must NOT blanket-preventDefault (native space play/pause stays intact).
  assert.ok(!bridgeSrc.includes("new Set(['f', 'arrowleft', 'arrowright', ' '])"), 'relay leaves space (native play/pause) alone');
  console.log('P2a bridge relay: bridge posts {t:key} for f/arrows via one shared listener, keeps native space — OK');

  // ---- P2b: yt host listener routes a relayed {t:'key'} to the same
  // dispatch. Focus sits in the yt frame -> bridge sends {t:'key',k:'arrowleft'}
  // -> host dispatchOverlayKey seeks back (ko-yt frame post).
  KO.player = 'youtube';
  KO.wrap = wrap;
  KO.ytState = { ready: true, live: true, playing: true, muted: false, ct: 40, dur: 60, lat: 7 };
  KO.kickFrame = null; KO.kickWin = null;
  fakeFrame = { ...el('iframe'), id: 'ko-yt', dataset: { koToken: 'p2yt', koReady: '1' }, contentWindow: { postMessage: (m) => framePosts.push(m) } };
  doc.getElementById = (id) => (id === 'ko-yt' ? fakeFrame : null);
  framePosts.length = 0;
  msgListeners.forEach((listener) => listener({
    source: fakeFrame.contentWindow,
    origin: new URL(chromeStub.runtime.getURL('player.html')).origin,
    data: { __koKick: { t: 'key', k: 'arrowleft', _koToken: 'p2yt' } },
  }));
  const p2bSeek = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seek' && m.__koKick.s === 35).length;
  assert.strictEqual(p2bSeek, 1, 'yt host: relayed arrowleft seeks back (seek 35) — iframe-focus arrows now work');
  fakeFrame = null;
  framePosts.length = 0;

  // ---- P2c: kick host routes a relayed {t:'key'} on the live url to the
  // cheap seekToLive (arrowright pressed while focus sits in the IVS frame).
  KO.player = 'kick';
  KO.kickOnDvr = false;
  KO.activeUrl = 'https://ivs.example/live-p2c';
  KO.kickState = { state: 'Playing', pos: 100, lat: 1, dur: 200 , ts: Date.now() };
  fakeFrame = { ...el('iframe'), id: 'ko-ivs', dataset: { koToken: 'p2ck', koReady: '1' }, contentWindow: { postMessage: (m) => framePosts.push(m) } };
  KO.kickFrame = fakeFrame; KO.kickWin = fakeFrame.contentWindow;
  doc.getElementById = () => null; // no ko-yt in this world -> kick listener owns it
  framePosts.length = 0;
  msgListeners.forEach((listener) => listener({
    source: fakeFrame.contentWindow,
    origin: new URL(chromeStub.runtime.getURL('player.html')).origin,
    data: { __koKick: { t: 'key', k: 'arrowright', _koToken: 'p2ck' } },
  }));
  const p2cLive = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seekToLive').length;
  assert.strictEqual(p2cLive, 1, 'kick host: relayed arrowright on the live url seeks to live — iframe-focus arrows now work');
  fakeFrame = null;
  framePosts.length = 0;

  // ---- P2d: the overlay wrap is keyboard-focusable (Tab) and a single
  // overlay key press dispatches EXACTLY ONE seek (pain 2 / P3a). Key
  // handling is unified in the document capture (onOverlayKeydown) + the
  // iframe relay — there is no dead bubble-phase wrap listener (0.8.6 P3a
  // removed it); the pin is a dispatch-count: one synthetic ArrowLeft through
  // the real capture handler yields one {t:'seek'} on the frame queue.
  mountApi.teardown();
  mountApi.mount();
  assert.ok(mKO.wrap, 'remount for the focus test');
  assert.strictEqual(mKO.wrap.tabIndex, 0, 'wrap is Tab-focusable (tabIndex 0), not untabbable -1');
  assert.ok(typeof mKO.wrap._ev.keydown === 'undefined', 'no bubble-phase keydown listener (P3a: unified capture dispatch)');
  // Dispatch-count: one press via the document capture handler (what a
  // page-focus ArrowLeft hits) must enqueue exactly one seek, not two.
  KO.player = 'youtube';
  KO.wrap = wrap;
  KO.ytState = { ready: true, live: true, playing: true, muted: false, ct: 40, dur: 60, lat: 7 };
  KO.kickFrame = null; KO.kickWin = null;
  fakeFrame = { ...el('iframe'), id: 'ko-yt', dataset: { koToken: 'p2dyt', koReady: '1' }, contentWindow: { postMessage: (m) => framePosts.push(m) } };
  doc.getElementById = (id) => (id === 'ko-yt' ? fakeFrame : null);
  framePosts.length = 0;
  api.onOverlayKeydown({
    key: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: wrap, preventDefault() {}, stopImmediatePropagation() {},
  });
  const p2dSeek = framePosts.filter((m) => m && m.__koKick && m.__koKick.t === 'seek' && m.__koKick.s === 35).length;
  assert.strictEqual(p2dSeek, 1, 'one ArrowLeft press -> EXACTLY ONE seek post (single dispatch per press)');
  assert.strictEqual(framePosts.filter((m) => m && m.__koKick && (m.__koKick.t === 'seek' || m.__koKick.t === 'seekToLive')).length, 1, 'no duplicate seek dispatch on one press');
  fakeFrame = null;
  framePosts.length = 0;
  mountApi.teardown();
  console.log('P2d wrap focus: tabIndex=0 + single dispatch per press (no dead bubble listener) — OK');

  // ---- P2e: playback ownership is the PICTURE, not the preference -----------
  // Measured 2026-11-11 in the owner's Chrome: the kick layer was SELECTED with
  // no picture (frame at state `Ready`, its media element at readyState 0).
  // The old term (`player !== 'twitch' && wrap`) paused the native on every
  // 400 ms tick and published `data-ko-owner` anyway, so the native got a
  // pause/resume churn AND `twitch-adblock.js` (which only asks whether the
  // attribute is non-empty) stood down for a layer that was not on screen.
  const ownershipVideo = videoEl('tw-owner');
  ownershipVideo.paused = false;
  fakeVideos.length = 0;
  fakeVideos.push(ownershipVideo);
  KO.player = 'kick';
  KO.wrap = el('div');
  // A fresh page: no picture has ever been seen here, so the hysteresis clock
  // is empty and the grace window does not apply yet.
  KO.picSeenAt = 0;
  KO.picLostAt = 0;
  // Past the cold-open window: the bound below only covers the first seconds of
  // a page, so this arm models a page whose layer never painted.
  KO.bootAt = performance.now() - 10000;
  const prefOnly = KO.player !== 'twitch' && !!KO.wrap; // the term that shipped before
  // (a) selected, no picture (the Idle / rs=0 shape): native keeps playing, owner empty
  KO.kickState = { state: 'Idle', paused: true, muted: true, pos: 0, lat: 0, dur: 0, ts: Date.now() };
  KO.ownerAttr = undefined;
  api.syncMute();
  assert.strictEqual(ownershipVideo.paused, false, 'no picture: the native player is NOT paused');
  assert.strictEqual(doc.documentElement.attrs['data-ko-owner'] || '', '', 'no picture: data-ko-owner is empty (the ad path still owns the page)');
  // (c) the mutation proof for (a): the preference-only term was TRUE in this
  // exact state, so the shipped behaviour above is only reachable by the
  // picture term. Reverting the term makes (a) fail on both asserts.
  assert.ok(prefOnly, 'mutant check: the preference-only term was true here and would have paused the native');
  // No frame report yet is the same answer (a mount attempt has this gap).
  KO.kickState = null;
  KO.ownerAttr = undefined;
  api.syncMute();
  assert.strictEqual(ownershipVideo.paused, false, 'no frame report: the native is NOT paused either');
  assert.strictEqual(doc.documentElement.attrs['data-ko-owner'] || '', '', 'no frame report: data-ko-owner is empty');
  // (b) playing: the layer owns the screen, so the native is paused and published
  KO.kickState = { state: 'Playing', paused: false, muted: false, pos: 10, lat: 2, dur: 120, ts: Date.now() };
  KO.ownerAttr = undefined;
  api.syncMute();
  assert.strictEqual(ownershipVideo.paused, true, 'a playing layer pauses the native');
  assert.strictEqual(doc.documentElement.attrs['data-ko-owner'], 'kick', 'a playing layer publishes data-ko-owner=kick');
  // (d) the yt branch reads ITS OWN report: the eagerly mounted kick frame is
  // paused there, and reading kickState (the old code) said "no picture" while
  // youtube played - exactly the state that would hand the screen back.
  KO.player = 'youtube';
  KO.picSeenAt = 0;
  KO.picLostAt = 0;
  KO.kickState = { state: 'Playing', paused: false, muted: false, pos: 10, lat: 2, dur: 0, ts: Date.now() };
  KO.ytState = { ready: true, playing: false, muted: true, live: true, dur: 0, ct: 0, error: 0 };
  ownershipVideo.paused = false;
  KO.ownerAttr = undefined;
  api.syncMute();
  assert.strictEqual(ownershipVideo.paused, false, 'yt loading: the native is not paused (kickState is not the yt report)');
  assert.strictEqual(doc.documentElement.attrs['data-ko-owner'] || '', '', 'yt loading: data-ko-owner is empty');
  // the report carries its own clock: `lastYtSt` is stamped by the real st handler
  KO.lastYtSt = Date.now();
  KO.ytState = { ready: true, playing: true, muted: false, live: true, dur: 0, ct: 0, error: 0 };
  KO.ownerAttr = undefined;
  api.syncMute();
  assert.strictEqual(ownershipVideo.paused, true, 'yt playing pauses the native');
  assert.strictEqual(doc.documentElement.attrs['data-ko-owner'], 'youtube', 'yt playing publishes its own owner');
  // (e) the bar being hidden is not "no picture": the hidden wrap is still a
  // picture, and the pause loop must keep treating the layer as on screen.
  KO.player = 'kick';
  KO.kickState = { state: 'Playing', paused: false, muted: false, pos: 10, lat: 2, dur: 120, ts: Date.now() };
  KO.wrap.style.display = 'none';
  KO.ownerAttr = undefined;
  ownershipVideo.paused = false;
  api.syncMute();
  assert.strictEqual(ownershipVideo.paused, true, 'hidden wrap with a picture still owns the native');
  assert.strictEqual(doc.documentElement.attrs['data-ko-owner'], 'kick', 'hidden wrap with a picture still publishes');
  KO.wrap.style.display = '';
  // twitch mode publishes nothing (unchanged)
  KO.player = 'twitch';
  KO.kickState = null;
  KO.ownerAttr = undefined;
  ownershipVideo.paused = false;
  api.syncMute();
  assert.strictEqual(doc.documentElement.attrs['data-ko-owner'] || '', '', 'twitch mode publishes no owner');
  fakeVideos.length = 0;
  // P2g: the COLD OPEN belongs to the layer, bounded. Owner 2026-11-11: "ainda to
  // vendo um anuncio tocar quando entro numa live por uns 5 segundos". A paused
  // native plays no preroll; the bound guarantees a black screen cannot outlive
  // the window if the layer never paints.
  {
    const cold = videoEl('tw-cold');
    cold.paused = false;
    fakeVideos.length = 0;
    fakeVideos.push(cold);
    KO.player = 'kick';
    KO.wrap = el('div');
    KO.kickState = { state: 'Idle', paused: true, muted: true, pos: 0, lat: 0, dur: 0, ts: Date.now() };
    KO.picSeenAt = 0;
    KO.picLostAt = 0;
    KO.bootAt = performance.now();
    KO.kickPrewarm = Promise.resolve(null); // the layer is on its way
    KO.ownerAttr = undefined;
    api.syncMute();
    assert.strictEqual(cold.paused, true, 'cold open: the native is paused (no preroll while the layer mounts)');
    assert.strictEqual(doc.documentElement.attrs['data-ko-owner'] || '', '', 'cold open publishes no owner (the ad path keeps its normal handling)');
    cold.paused = false;
    KO.bootAt = performance.now() - 5000; // still inside the window
    api.syncMute();
    assert.strictEqual(cold.paused, true, 'the hold outlasts the layer\'s own first signal (no ad flash before it paints)');
    cold.paused = false;
    KO.bootAt = performance.now() - 9000; // past COLD_HOLD_MS
    api.syncMute();
    assert.strictEqual(cold.paused, false, 'past the window a layer that never painted releases the native');
    // And a channel with NO layer coming is never held at all: the native is the
    // only picture there, so a black screen would be pure damage.
    cold.paused = false;
    KO.kickPrewarm = null;
    KO.kickFrame = null;
    KO.kickState = null;
    KO.ytState = null;
    KO.ytFrame = null;
    KO.kickMountPending = false;
    KO.picSeenAt = 0;
    KO.picLostAt = 0;
    KO.bootAt = performance.now();
    api.syncMute();
    assert.strictEqual(cold.paused, false, 'a channel with no layer on the way is never held');
    console.log('P2g cold open: the preroll window is held, then released - OK');
  }
  // P2h: SOUND follows the same ownership predicate as the picture. Owner
  // 2026-11-12: "saiu do player, foi pro player da twitch, e deixou pausado e
  // desmutado". The surface used to be read off the bar's CSS: a hidden bar
  // declared the native audible in the same tick that ownership paused it.
  {
    KO.player = 'kick';
    KO.wrap = el('div');
    KO.kickState = { state: 'Playing', paused: false, muted: true, pos: 10, lat: 1, dur: 0, ts: Date.now() };
    KO.ytState = null;
    KO.picSeenAt = Date.now();
    KO.picLostAt = 0;
    KO.kickPrewarm = null;
    KO.twDeleted = false;
    KO.wrap.style.display = 'none';
    assert.strictEqual(api.visibleSurface(), 'kick', 'a hidden bar does not hand the sound to the native while the layer owns the picture');
    KO.kickState = { state: 'Idle', paused: true, muted: true, pos: 0, lat: 0, dur: 0, ts: Date.now() };
    KO.picSeenAt = 0; // never painted, past the cold window
    KO.bootAt = performance.now() - 30000;
    assert.strictEqual(api.visibleSurface(), 'twitch', 'with no picture at all the native is the surface that is heard');
    console.log('P2h surface: ownership decides the sound, not the bar CSS - OK');
  }
  // P2i: one tick cannot pause and resume the native. In the state below the
  // hysteresis says OWNED while the raw picture test says nothing (a `Ready`
  // report between segments), and the rect loop used to resume on the raw test
  // in the same tick that syncMute paused on ownership. Guarded structurally
  // because the resume path needs a real player to drive.
  {
    mKO.player = 'kick';
    mKO.wrap = el('div');
    mKO.wrap.style.display = 'none';
    mKO.twDeleted = false;
    mKO.kickState = { state: 'Ready', paused: false, muted: false, pos: 10, lat: 1, dur: 0, ts: Date.now() };
    mKO.kickPrewarm = null;
    mKO.ytState = null;
    mKO.picSeenAt = Date.now() - 500;
    mKO.picLostAt = Date.now() - 500;
    assert.strictEqual(mountApi.overlayHasPicture(), false, 'precondition: the raw picture test says no picture');
    assert.strictEqual(mountApi.overlayOwnsPicture(), true, 'precondition: ownership is held by the hysteresis');
    const resumeLines = src.split('\n').filter((l) => /resumeTwitchIfOurs\(\)/.test(l) && !l.trim().startsWith('//'));
    const raw = resumeLines.filter((l) => /overlayHasPicture\(\)/.test(l));
    assert.strictEqual(raw.length, 0, `a resume still asks the raw picture test: ${raw.join(' | ')}`);
    const guarded = resumeLines.filter((l) => /overlayOwnsPicture\(\)/.test(l));
    assert.ok(guarded.length >= 1, 'no resume is guarded by the ownership predicate');
    console.log('P2i tick: one predicate for pause and resume (no churn inside a tick) - OK');
  }
  // P2n: a frame report has an AGE. The bridge publishes once a second, so a
  // `Playing` state from ten seconds ago is not evidence about the picture now;
  // the old test held the screen on it and the owner saw a frozen player he had
  // to reload the page to fix. RED arm: pass the same state with a fresh `ts`.
  {
    mKO.player = 'kick';
    mKO.wrap = el('div');
    mKO.wrap.style.display = 'none';
    mKO.twDeleted = false;
    mKO.kickPrewarm = null;
    mKO.ytState = null;
    mKO.kickState = { state: 'Playing', paused: false, muted: true, pos: 10, lat: 1, dur: 0, ts: Date.now() - 10000 };
    mKO.picSeenAt = Date.now();
    mKO.picLostAt = 0;
    assert.strictEqual(mountApi.overlayHasPicture(), false, 'a 10 s old Playing report is still read as a picture');
    const fresh = { ...mKO.kickState, ts: Date.now() };
    mKO.kickState = fresh;
    assert.strictEqual(mountApi.overlayHasPicture(), true, 'RED arm: a fresh Playing report must still count');
    // and youtube answers the same way through its own stamp
    mKO.player = 'youtube';
    mKO.ytState = { ready: true, playing: true, ended: false, pos: 5, ts: Date.now() - 10000 };
    mKO.lastYtSt = Date.now() - 10000;
    assert.strictEqual(mountApi.overlayHasPicture(), false, 'a stale youtube report is still read as a picture');
    mKO.ytState = { ready: true, playing: true, ended: false, pos: 5, ts: Date.now() };
    mKO.lastYtSt = Date.now();
    assert.strictEqual(mountApi.overlayHasPicture(), true, 'RED arm: a fresh youtube report must count');
    console.log('P2n staleness: a frame report has an age - OK');
  }
  // P2o: a position that goes BACKWARDS hands the screen back. A seek or a
  // re-show can leave the frame reporting `Playing` without advancing; the
  // regression is the cheap proof the element did not follow the command.
  {
    mKO.player = 'kick';
    mKO.wrap = el('div');
    mKO.wrap.style.display = 'none';
    mKO.twDeleted = false;
    mKO.kickPrewarm = null;
    mKO.ytState = null;
    mKO.kickState = { state: 'Playing', paused: false, muted: true, pos: 500, lat: 1, dur: 0, ts: Date.now() };
    mKO.picSeenAt = Date.now();
    mKO.picLostAt = 0;
    mKO.ownerAttr = '';
    mKO.ownerPos = 0;
    mountApi.syncOwner();
    assert.strictEqual(mKO.ownerAttr, 'kick', 'precondition: the layer with a picture owns the screen');
    mKO.kickState = { ...mKO.kickState, pos: 480, ts: Date.now() };
    mountApi.syncOwner();
    assert.strictEqual(mKO.ownerAttr, '', 'a 20 s position regression must hand the screen back');
    console.log('P2o regression: a backwards position releases ownership - OK');
  }
  // P2p: a tab opened before an update must stop lying about which code it runs.
  // Owner 2026-11-12: his `ko.adlog` carried `boot {ver:'0.8.79'}` while the
  // installed manifest was 0.8.81 - three waves of fixes he never ran, and every
  // symptom he reported came from the old file. One reload per version, only
  // while the tab is in the background, recorded so it cannot loop.
  {
    // Same timing shape as P2q below: the product schedules the reload 800 ms
    // out, so a fixed 900 ms sleep has 100 ms of margin and can assert before
    // the timer fires on a loaded box. Poll to a deadline (and settle for the
    // "must NOT reload" halves) instead of racing one sleep.
    const run = async () => {
      const reloadCount = async (want) => {
        // 80 x 50 ms = the same 4 s deadline, on whichever clock is running.
        for (let i = 0; i < 80; i += 1) {
          if (reloads.length === want) return reloads.length;
          await settle(50);
        }
        return reloads.length;
      };
      const settleReloads = async () => { await settle(250); return reloads.length; };
      manifestVersion = '0.8.82'; // same as KO_VER: nothing to do
      reloads.length = 0;
      mountApi.recoverStale();
      assert.strictEqual(reloads.length, 0, 'an up-to-date tab was reloaded');
      manifestVersion = '0.9.0';
      mountDoc.hidden = false;
      mountApi.recoverStale();
      assert.strictEqual(await settleReloads(), 0, 'a VISIBLE page was reloaded under the user');
      mountDoc.hidden = true;
      mountApi.recoverStale();
      assert.strictEqual(await reloadCount(1), 1, 'a stale tab in the background did not reload once');
      mountApi.recoverStale();
      assert.strictEqual(await settleReloads(), 1, 'the same version reloaded twice (a loop)');
      mountDoc.hidden = false;
      manifestVersion = '0.8.82';
      console.log('P2p stale-tab: a background tab heals once per version - OK');
    };
    await run();
  }
  // P2q: THE EDGE IS NOT THE ONLY CLOCK. `recoverStale()` ran at boot and on
  // `visibilitychange`, and a visibilitychange only fires when visibility
  // CHANGES - so the tab that sat in the background across the update was
  // exactly the one that never asked again, which is the opposite of the intent
  // (hidden is the only state it may heal in). Measured 2026-11-19 in his own
  // ring: `boot {version:"0.8.104"}` and `hb {ver:"0.8.104"}` for 226 s against
  // an installed 0.8.106, every heartbeat `hidden:true`. The heartbeat asks the
  // same question, and the RED removes that one call.
  {
    // A fixed 900 ms sleep against the product's 800 ms reload delay left 100 ms
    // of margin, and on a loaded box (gate wall 382.9 s) the timer landed after
    // the assertion: `actual: 0, expected: 1` with the reload still pending. Poll
    // for the count with a deadline instead of racing one sleep, so the arm still
    // fails when nothing is ever scheduled (0 reloads after 4 s) and cannot fail
    // for being early.
    const run = async () => {
      const reloadCount = async (want) => {
        // 80 x 50 ms = the same 4 s deadline, on whichever clock is running.
        for (let i = 0; i < 80; i += 1) {
          if (reloads.length === want) return reloads.length;
          await settle(50);
        }
        return reloads.length;
      };
      const settleReloads = async () => { await settle(250); return reloads.length; };
      manifestVersion = '0.9.1';
      reloads.length = 0;
      mountDoc.hidden = true;
      mountApi.koHbTick(); // a tick on a tab hidden BEFORE the update landed
      assert.strictEqual(await reloadCount(1), 1, 'a tab hidden across the update never healed: the heartbeat did not ask');
      mountApi.koHbTick();
      mountApi.koHbTick();
      assert.strictEqual(await settleReloads(), 1, 'the heartbeat reloaded the same version again (a loop)');
      manifestVersion = '0.9.2';
      mountDoc.hidden = false;
      mountApi.koHbTick();
      assert.strictEqual(await settleReloads(), 1, 'a VISIBLE page was reloaded under the user by the heartbeat');
      // RED: the same driver against a module without the heartbeat's question.
      // The mutant's own `init()` boots as well, so the BOOT call is neutralized
      // too - otherwise the mutation would be "proved" by a path the arm is not
      // about, and the arm would pass on a file that never asks at the heartbeat.
      const hb = "    recoverStale();\n    diag('hb', {";
      const from = "  recoverStale();\n  diag('hb', {";
      const bootFrom = "  recoverStale();\n  document.addEventListener('visibilitychange', () => recoverStale(), true);";
      assert.ok(src.includes(from) || src.includes(hb), 'P2q RED: the heartbeat no longer asks where the arm expects it');
      assert.ok(src.includes(bootFrom), 'P2q RED: the boot call the mutant must silence is not in the source');
      const mutated = src
        .replace(from, "  diag('hb', {")
        .replace(bootFrom, "  document.addEventListener('visibilitychange', () => {}, true);");
      assert.notStrictEqual(mutated, src, 'P2q RED: the mutation (drop the heartbeat call) did not apply');
      const noAsk = new Function('window', 'document', 'location', 'navigator', mutated + '\n;return {koHbTick};')(
        global,
        mountDoc,
        global.location,
        global.navigator,
      );
      const before = reloads.length;
      manifestVersion = '0.9.3';
      mountDoc.hidden = true;
      noAsk.koHbTick();
      await settle(1500); // absence: past the product's 800 ms delay with margin
      assert.strictEqual(reloads.length, before, 'the RED mutant healed the tab anyway, so the arm proves nothing');
      mountDoc.hidden = false;
      manifestVersion = '0.8.82';
      console.log('P2q stale-tab: the heartbeat heals a tab hidden across the update - OK');
    };
    await run();
  }
  // P2r: NEVER RELOAD UNDER A POD, AND SAY WHOSE RELOAD IT WAS.
  // Owner 2026-11-24, verbatim: "as vezes a live para e a pagina recarrega
  // sozinha ... nao sei se é necessario isso ou se da pra ter o mesmo efeito com
  // menos INTERRUPCAO notavel pelo usuario". A reload that lands on a pod tears
  // down the clean frame, its claim and every timer that owns it; the heartbeat
  // re-asks in 8 s, so waiting costs nothing. And "did OUR code reload this
  // page" was unanswerable from the ring: `pagehide`+`boot` with one version on
  // both sides reads the same whether it was the heal, his F5 or Twitch's own
  // player recovery - so the boot now stamps the navigation type and the marker
  // this file writes 800 ms earlier.
  {
    const run = async () => {
      const bootRows = () => swCalls.filter((m) => m && m.__koDiag && m.__koDiag.ev === 'boot-nav').map((m) => m.__koDiag.data);
      const tabRows = () => swCalls.filter((m) => m && m.__koDiag && m.__koDiag.ev === 'stale-tab').map((m) => m.__koDiag.data);
      // A reload timer a previous arm left in flight fires 800 ms later and
      // lands inside THIS block under a loaded gate run (measured 2026-11-24:
      // content-fix FAIL only inside ko-verify, green alone). Drain it before
      // the count starts so the arm measures its own decisions; a real reload
      // under the pod is scheduled by the call below, well after this mark.
      await settle(1000); // drain a timer a previous arm left in flight
      // The product schedules its reload 800 ms out; a fixed 900 ms sleep has
      // 100 ms of margin and asserts BEFORE the timer on a loaded box, which is
      // how this block went red inside ko-verify while green alone. Every
      // positive count below polls to a deadline; the negative ones settle.
      const reloadCount = async (want) => {
        // 80 x 50 ms = the same 4 s deadline, on whichever clock is running.
        for (let i = 0; i < 80; i += 1) {
          if (reloads.length === want) return reloads.length;
          await settle(50);
        }
        return reloads.length;
      };
      const settleReloads = async () => { await settle(250); return reloads.length; };
      manifestVersion = '0.9.4';
      mountDoc.hidden = true;
      sessionStore.clear();
      mountDoc.documentElement.setAttribute('data-ko-adpark', '1');
      reloads.length = 0;
      const mark = swCalls.length;
      mountApi.recoverStale();
      await settleReloads();
      const waited = tabRows().filter((d) => d && d.act === 'wait-pod');
      assert.strictEqual(reloads.length, 0, 'a stale tab was reloaded UNDER A POD (the interruption he asked to remove)');
      assert.strictEqual(waited.length, 1, `the deferral was silent: ${JSON.stringify(tabRows())}`);
      assert.strictEqual(sessionStore.has('ko.staleReload'), false, 'a deferred reload still marked itself as done');
      // A PARK THAT OUTLIVES EVERY CEILING IS A LEAK, NOT AN AD: a marker nobody
      // clears must not block the heal for the life of the page - 300 s is past
      // the 180 s pod ceiling and the 12 s hold, so nothing of ours is waiting.
      mountApi.KO.staleParkSince = Date.now() - 400000;
      mountApi.KO.stalePark = 'wait-pod';
      sessionStore.clear();
      reloads.length = 0;
      const leakMark = swCalls.length;
      mountApi.recoverStale();
      assert.strictEqual(await reloadCount(1), 1, 'a leaked park blocked the heal forever (the tab would run old code for the life of the page)');
      const leakRows = swCalls.slice(leakMark).filter((m) => m && m.__koDiag && m.__koDiag.ev === 'stale-tab' && m.__koDiag.data && m.__koDiag.data.act === 'wait-pod-stale');
      assert.strictEqual(leakRows.length, 1, `the leaked park was healed silently: ${JSON.stringify(swCalls.slice(leakMark).filter((m) => m && m.__koDiag))}`);
      assert.strictEqual(sessionStore.get('ko.staleReload'), manifestVersion, 'the leak-healed reload was not marked as ours');
      mountApi.KO.staleParkSince = 0;
      mountApi.KO.stalePark = '';
      // The same ask, once the pod is over: it heals, and the marker names it.
      mountDoc.documentElement.setAttribute('data-ko-adpark', '0');
      mountApi.recoverStale();
      assert.strictEqual(await reloadCount(1), 1, 'the tab never healed after the pod ended');
      assert.strictEqual(sessionStore.get('ko.staleReload'), manifestVersion, 'the reload was not marked as ours');
      // A boot that follows OUR reload says so; a boot with no marker does not.
      const KO_VER = (src.match(/const KO_VER = '([^']+)'/) || [])[1];
      assert.ok(KO_VER, 'P2r: the script version literal is not in the source');
      sessionStore.clear();
      sessionStore.set('ko.staleReload', KO_VER);
      const prov = () => new Function('window', 'document', 'location', 'navigator', src + '\n;return {bootProvenance};')(
        global, mountDoc, global.location, global.navigator,
      ).bootProvenance();
      const ours = prov();
      sessionStore.clear();
      const theirs = prov();
      assert.strictEqual(ours.heal, 'stale-reload', `a reload of ours was not attributed at boot: ${JSON.stringify(ours)}`);
      assert.strictEqual(theirs.heal, null, `a navigation we did not make was claimed as ours: ${JSON.stringify(theirs)}`);
      assert.ok(theirs.nav === null || typeof theirs.nav === 'string', `the navigation type is not a string or null: ${JSON.stringify(theirs)}`);
      // RED: without the deferral the same ask reloads under the pod.
      const podGuard = "  if (parked) {";
      assert.ok(src.includes(podGuard), 'P2r RED: the pod guard is not where the arm expects it');
      const red = new Function('window', 'document', 'location', 'navigator', src.replace(
        podGuard,
        '  if (false && parked) { // RED: pre-fix, the heal never asks whether a pod is up',
      ) + '\n;return {recoverStale};')(global, mountDoc, global.location, global.navigator);
      mountDoc.documentElement.setAttribute('data-ko-adpark', '1');
      sessionStore.clear();
      reloads.length = 0;
      red.recoverStale();
      assert.strictEqual(await reloadCount(1), 1, 'P2r RED: the pre-fix heal reloaded a page the pod owned (proves the deferral is load-bearing)');
      mountDoc.documentElement.setAttribute('data-ko-adpark', '0');
      mountDoc.hidden = false;
      manifestVersion = '0.8.82';
      sessionStore.clear();
      void bootRows;
      console.log('P2r stale-tab: a pod is never reloaded under, and a reload names its author - OK');
    };
    await run();
  }
  // P2j: the LOG must answer the owner's questions. Every report of 2026-11-11/12
  // (an ad/player fight, a switch that lost the mute, a native left paused) asked
  // "who had the screen, what changed, and why" - and content.js sent those
  // decisions to the extension console only, never to `ko.adlog`.
  {
    const events = () => swCalls.filter((m) => m && m.__koDiag).map((m) => m.__koDiag.ev);
    swCalls.length = 0;
    const logVid = videoEl('tw-log');
    logVid.paused = false;
    fakeVideos.length = 0;
    fakeVideos.push(logVid);
    KO.player = 'kick';
    KO.wrap = el('div');
    KO.kickState = { state: 'Playing', paused: false, muted: false, pos: 10, lat: 1, dur: 0, ts: Date.now() };
    KO.ytState = null;
    KO.kickPrewarm = null;
    KO.picSeenAt = 0;
    KO.picLostAt = 0;
    KO.ownerAttr = undefined;
    api.syncMute();
    assert.ok(logVid.paused, 'precondition: the layer paused the native');
    assert.ok(events().includes('owner'), 'no owner transition in the log: the screen changing hands is unanswerable');
    const own = swCalls.filter((m) => m && m.__koDiag && m.__koDiag.ev === 'owner').pop().__koDiag.data;
    assert.strictEqual(own.to, 'kick', 'the owner line does not say who took the screen');
    assert.strictEqual(typeof own.pic, 'boolean', 'the owner line does not say WHY (picture/failed/cold)');
    assert.ok(events().includes('native-pause'), 'no native-pause line: a paused player with no reason in the log');
    api.setPlayer('twitch');
    const sw = swCalls.filter((m) => m && m.__koDiag && m.__koDiag.ev === 'player-switch').pop();
    assert.ok(sw, 'no player-switch line: a switch that loses the mute leaves no trace');
    // The arbiter is absent in this harness world, so the field is null here and
    // populated in the extension; the contract is that the LINE carries it.
    assert.ok('intent' in sw.__koDiag.data, 'the switch line carries no intent field');
    // and the sink: diag() must ALSO reach the ring adblock-bridge.js persists.
    assert.ok(/ko-adlog/.test(src.slice(src.indexOf('function diag('), src.indexOf('function diag(') + 900)), 'diag() does not persist to ko.adlog');
    console.log('P2j log: ownership, pause and switch decisions persist with their reason - OK');
  }
  // P2k: a HIDDEN tab decides nothing. Owner 2026-11-12: "ta pausando ou parando
  // quando to alt tab. quando eu volto ... ele tenta fazer algo no player, o
  // player trava". Every timer a hidden tab reasons about is throttled, so an
  // ownership decision taken there is a decision about a stale sample.
  {
    const hid = videoEl('tw-hidden');
    hid.paused = false;
    fakeVideos.length = 0;
    fakeVideos.push(hid);
    KO.player = 'kick';
    KO.wrap = el('div');
    KO.kickState = { state: 'Playing', paused: false, muted: false, pos: 10, lat: 1, dur: 0, ts: Date.now() };
    KO.ytState = null;
    KO.kickPrewarm = null;
    KO.picSeenAt = Date.now();
    KO.picLostAt = 0;
    KO.ownerAttr = 'kick';
    doc.hidden = true;
    api.syncMute();
    assert.strictEqual(hid.paused, false, 'a hidden tab paused the native player');
    // Back to visible: the pre-hide decision is untouched and the tick works.
    doc.hidden = false;
    api.syncMute();
    assert.strictEqual(hid.paused, true, 'a visible tab no longer pauses the native (the ownership path broke)');
    assert.strictEqual(doc.documentElement.attrs['data-ko-owner'], 'kick', 'ownership is not published when visible again');
    // The alt-tab boundary restarts the watchdog clocks: a gap spent hidden is
    // not evidence that the bridge died. Driven through the REAL listener the
    // page installed (source-text matching cannot notice a handler that is
    // never called at all).
    const vK = KO;
    vK.lastKickSt = Date.now() - 120000;
    vK.lastYtSt = Date.now() - 120000;
    vK.stallTicks = 40;
    vK.ownerAttr = 'kick';
    vK.picSeenAt = 0;
    vK.picLostAt = 0;
    doc.hidden = false;
    assert.ok((docListeners.visibilitychange || []).length > 0, 'the page never installed a visibilitychange listener');
    fireDoc('visibilitychange');
    assert.strictEqual(vK.lastKickSt, 0, 'the visibility boundary must reset the kick watchdog clock');
    assert.strictEqual(vK.lastYtSt, 0, 'the visibility boundary must reset the yt watchdog clock');
    assert.strictEqual(vK.stallTicks, 0, 'the visibility boundary must reset the stall counter');
    assert.ok(vK.picSeenAt > 0, 'the visibility boundary must preserve the pre-hide ownership');
    vK.ownerAttr = '';
    console.log('P2k alt-tab: a hidden tab changes nothing, and the boundary resets the clocks - OK');
  }
  // P2f: HYSTERESIS. A re-buffer reports Buffering/Ready between segments; a raw
  // picture test dropped ownership there, the native resumed, the ad path took a
  // pod, and the owner saw an ad and the player fighting each other
  // ("ficam brigando, sendo que isso nao ocorria antes", 2026-11-11).
  K2.player = 'kick';
  K2.wrap = K2.wrap || el('div');
  K2.picSeenAt = 0;
  K2.picLostAt = 0;
  K2.kickState = { state: 'Playing', pos: 10, lat: 1, dur: 0, ts: Date.now() };
  assert.strictEqual(mountApi.overlayOwnsPicture(), true, 'playing: the layer owns the picture');
  K2.kickState = { state: 'Ready', pos: 10, lat: 1, dur: 0, ts: Date.now() };
  assert.strictEqual(mountApi.overlayOwnsPicture(), true, 'a lost picture inside the grace window keeps ownership (no ad/player fight)');
  K2.picSeenAt = Date.now();
  K2.picLostAt = Date.now() - 7000; // past OWNER_GRACE_MS
  assert.strictEqual(mountApi.overlayOwnsPicture(), false, 'after the grace the native may reclaim the screen');
  K2.kickState = { state: 'Playing', pos: 10, lat: 1, dur: 0, ts: Date.now() };
  assert.strictEqual(mountApi.overlayOwnsPicture(), true, 'a returned picture restores ownership');
  assert.strictEqual(K2.picLostAt, 0, 'a returned picture clears the loss clock');
  console.log('P2f ownership hysteresis: a re-buffer does not hand the screen back - OK');
  console.log('P2e ownership: the PICTURE owns the native (Idle/absent -> keeps playing, attr empty; Playing -> paused + attr) - OK');

  // Stall recovery: a frozen picture that still reports `Playing` must be
  // reloaded, not skipped. Owner report 2026-11-13 (two live runs): after a DVR
  // seek the go-live click left the player at `state:"Playing"` over a FROZEN
  // broadcast clock, and `stall {ct:10262}` fired five times over 80 s while the
  // picture never moved. `ensureKick()` saw the same url + `Playing` and
  // returned, so the reconnect repaired nothing; and the budget refilled because
  // "Playing" was read as a stable run.
  {
    const S = new Function('window', 'document', 'location', 'navigator', src + '\n;return {KO, ensureKick};')(
      global,
      doc,
      global.location,
      global.navigator,
    );
    const sent = [];
    S.KO.wrap = el('div');
    S.KO.kickFrame = el('iframe');
    S.KO.kickReady = true;
    S.KO.player = 'kick';
    S.KO.activeUrl = 'https://ivs.example/frozen';
    S.KO.kickState = { state: 'Playing', pos: 10262.7, lat: 1.3, dur: 0 };
    S.KO.kickSend = (m) => sent.push(m);
    const realKickSend = S.KO.kickSend;
    // The module's own kickSend is the only writer we care about; patch the
    // channel it uses (`postMessage` on the frame's window) instead of guessing.
    // kickSend refuses without a frame token, so the frame carries one exactly
    // like a mounted overlay's does.
    S.KO.kickFrame.dataset = { koToken: 'tok-stall' };
    S.KO.kickFrame.contentWindow = { postMessage: (p) => sent.push(p && p.__koKick) };
    S.KO.kickWin = S.KO.kickFrame.contentWindow;
    void realKickSend;

    // 1. the OLD contract: same url + Playing -> nothing is sent.
    S.ensureKick('https://ivs.example/frozen');
    assert.strictEqual(sent.length, 0, 'a healthy same-url attach must stay a no-op');

    // 2. the stall door: the same url is RELOADED.
    S.ensureKick('https://ivs.example/frozen', { force: true });
    const loads = sent.filter((m) => m && m.t === 'load');
    assert.strictEqual(loads.length, 1, `a forced attach must reload the url once (sent ${JSON.stringify(sent.map((m) => m && m.t))})`);
    assert.strictEqual(loads[0].url, 'https://ivs.example/frozen', 'the forced reload must target the same url');
    console.log('W1 stall recovery: a frozen Playing player is reloaded, a healthy one is not - OK');
  }
  // The reconnect BUDGET and the DVR source, driven through the REAL handlers.
  // Both were source-text assertions before (matching a regex against
  // content.js), which cannot fail when the handler stops being called at all —
  // exactly how the 2026-11-13 freeze survived a green suite.
  {
    const S = new Function('window', 'document', 'location', 'navigator', src
      + '\n;return {KO, ensureKick, reconnect, kickGoLive, updateKickBar};')(
      global, doc, global.location, global.navigator,
    );
    const K = S.KO;
    const posted = [];
    const frame = { ...el('iframe'), dataset: { koToken: 'tok-w2' }, contentWindow: { postMessage: (p) => posted.push(p && p.__koKick) } };
    doc.getElementById = () => null;
    K.wrap = el('div');
    K.wrap.style.display = 'block';
    K.kickFrame = frame;
    K.kickWin = frame.contentWindow;
    K.kickReady = true;
    K.enabled = true;
    K.player = 'kick';
    K.kickSlug = 'w2channel';
    K.activeUrl = 'https://ivs.example/live-w2';
    K.kickOnDvr = false;
    K.reconnectCount = 3;
    K.stableSince = Date.now() - 60000;
    K.stablePos = 10262.7;
    // The bridge's own message shape, delivered to the listener the page
    // installed (identical envelope to the frame's `sendSt`).
    const sendSt = (st) => {
      const before = msgListeners.length;
      void before;
      msgListeners.forEach((listener) => listener({
        source: frame.contentWindow,
        origin: new URL(chromeStub.runtime.getURL('player.html')).origin,
        data: { __koKick: { t: 'st', st, _koToken: 'tok-w2' } },
      }));
    };
    // A FROZEN clock: same pos, repeated. The budget must not refill.
    sendSt({ state: 'Playing', pos: 10262.7, lat: 1.3, dur: 0 });
    // Prime the run: the first sample always starts a stretch, so one more
    // frozen sample is needed before the "advancing" test can be judged.
    K.stableSince = Date.now() - 60000;
    sendSt({ state: 'Playing', pos: 10262.7, lat: 1.3, dur: 0 });
    assert.strictEqual(K.reconnectCount, 3, 'a frozen clock must NOT replenish the reconnect budget');
    // An ADVANCING clock is progress.
    sendSt({ state: 'Playing', pos: 10262.7 + 0.5, lat: 1.3, dur: 0 });
    K.stableSince = Date.now() - 60000;
    sendSt({ state: 'Playing', pos: 10262.7 + 1.0, lat: 1.3, dur: 0 });
    assert.strictEqual(K.reconnectCount, 0, 'an advancing clock past 15 s must replenish the budget');
    console.log('W2 stall budget: a frozen clock never replenishes the reconnect budget, an advancing one does - OK');
  }
  {
    // A stall ON THE REPLAY must reload the REPLAY at the same offset. Measured
    // 2026-11-13: the forced reload used the live url, so a DVR freeze
    // teleported him to the edge (`owner-regress {from:10529.4, to:46.2}`).
    const S = new Function('window', 'document', 'location', 'navigator', src
      + '\n;return {KO, ensureKick, kickStallRecover};')(
      global, doc, global.location, global.navigator,
    );
    const K = S.KO;
    const posted = [];
    const frame = { ...el('iframe'), dataset: { koToken: 'tok-w3' }, contentWindow: { postMessage: (p) => posted.push(p && p.__koKick) } };
    doc.getElementById = () => null;
    K.wrap = el('div');
    K.kickFrame = frame;
    K.kickWin = frame.contentWindow;
    K.kickReady = true;
    K.enabled = true;
    K.player = 'kick';
    K.kickSlug = 'w3channel';
    K.activeUrl = 'https://ivs.example/live-w3';
    K.kickDvrUrl = 'https://ivs.example/replay-w3';
    K.kickOnDvr = true;
    K.kickDvrTarget = 900;
    K.kickState = { state: 'Playing', pos: 10529.42, lat: 1.5, dur: 21523 };
    const which = S.kickStallRecover('https://ivs.example/live-w3-FRESH');
    const loads = posted.filter((m) => m && m.t === 'load');
    assert.strictEqual(which, 'dvr', 'a DVR stall is a DVR recovery');
    assert.strictEqual(loads.length, 1, `a DVR stall reloads exactly once (posted ${JSON.stringify(posted.map((m) => m && m.t))})`);
    assert.strictEqual(loads[0].url, 'https://ivs.example/replay-w3', 'a DVR stall reloads the REPLAY source, never the live one');
    assert.strictEqual(loads[0].seekTo, 10529.42, 'a DVR stall resumes at the offset he was watching');
    assert.strictEqual(K.kickOnDvr, true, 'a DVR stall stays on the DVR');
    // The live half: the same door reloads the LIVE source.
    posted.length = 0;
    K.kickOnDvr = false;
    K.activeUrl = 'https://ivs.example/live-w3-FRESH';
    assert.strictEqual(S.kickStallRecover('https://ivs.example/live-w3-FRESH'), 'live', 'a live stall is a live recovery');
    assert.strictEqual(posted.filter((m) => m && m.t === 'load').length, 1, 'a live stall reloads once');
    assert.strictEqual(posted.find((m) => m && m.t === 'load').url, 'https://ivs.example/live-w3-FRESH', 'a live stall reloads the LIVE source');
    assert.strictEqual(posted.find((m) => m && m.t === 'load').seekTo, undefined, 'a live stall seeks nowhere: the live url starts at the edge');
    console.log('W3 stall source: the replay reloads itself at the same offset, the live reloads live - OK');
  }
  {
    // An EXHAUSTED DVR budget goes to the live edge instead of tearing the
    // layer down: a replay that will not reload is not a dead channel. The
    // reconnect's own 2 s backoff races the page's poll timer, so this arm
    // drives the DECISION (`kickGoLive` mints through `kickPlaybackUrl`) and
    // not the reconnect wrapper.
    const S = new Function('window', 'document', 'location', 'navigator', src
      + '\n;return {KO, kickGoLive};')(
      global, doc, global.location, global.navigator,
    );
    const K = S.KO;
    const posted = [];
    const frame = { ...el('iframe'), dataset: { koToken: 'tok-w4' }, contentWindow: { postMessage: (p) => posted.push(p && p.__koKick) } };
    doc.getElementById = () => null;
    K.wrap = el('div');
    K.wrap.style.display = 'block';
    K.kickFrame = frame;
    K.kickWin = frame.contentWindow;
    K.kickReady = true;
    K.enabled = true;
    K.player = 'kick';
    K.kickSlug = 'w4channel';
    K.activeUrl = 'https://ivs.example/live-w4';
    K.kickDvrUrl = 'https://ivs.example/replay-w4';
    K.kickOnDvr = true;
    K.kickState = { state: 'Playing', pos: 500, lat: 2, dur: 2000 };
    K.ytState = { ready: false, playing: false, live: false, muted: true, dur: 0, ct: 0, error: 0 };
    const realFetch = global.fetch;
    global.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ livestream: { playback_url: 'https://ivs.example/live-w4-FRESH', id: 'w4' } }),
    });
    await S.kickGoLive();
    global.fetch = realFetch;
    const loads = posted.filter((m) => m && m.t === 'load');
    assert.strictEqual(K.kickOnDvr, false, 'go live leaves the DVR');
    assert.strictEqual(loads.length, 1, `go live loads exactly once (posted ${JSON.stringify(posted.map((m) => m && m.t))})`);
    assert.strictEqual(loads[0].url, 'https://ivs.example/live-w4-FRESH', 'go live loads a FRESH mint, never the stale activeUrl');
    assert.strictEqual(loads[0].seekTo, undefined, 'go live seeks nowhere: the live url starts at the edge');
    assert.ok(!K.kickState || K.kickState.dur === 0, 'the replay clock is not carried onto the live url');
    console.log('W4 go live: a fresh token, one load, and no replay clock left behind - OK');
  }

  {
    // A POLL THAT LEARNED NOTHING IS NOT NEWS. Measured in the owner's own ring
    // on 2026-11-16 (0.8.94, 1200 entries): `kick_probe {at:"poll"}` 114 times
    // and `kick_offline` 114 times for one channel, plus 20 `{api:"v2/…",404}`
    // and 20 `{api:"v1/…",404}` — 268 of 1200 rows for a single unchanging
    // fact. That is the class that buried the ad chronology he asked the log to
    // answer ("TUDO ISSO deveria estar nos logs"). The single `kickMintSig` slot
    // could not dedupe the mint probes either: a channel that 404s on BOTH
    // endpoints makes v2 and v1 alternate the value, so each poll looked new.
    const S = new Function('window', 'document', 'location', 'navigator', src
      + '\n;return {KO, probeKickLayer};')(
      global, doc, global.location, global.navigator,
    );
    const K = S.KO;
    doc.getElementById = () => null;
    K.enabled = true;
    K.player = 'kick';
    K.kickSlug = 'w6channel';
    K.activeUrl = '';
    K.kickState = null;
    K.kickUrlT = 0;
    K.kickEverPlayed = false;
    K.kickWrap = null;
    K.wrap = null;
    K.kickFrame = null;

    const rows = () => swCalls.filter((m) => m && m.__koDiag).map((m) => m.__koDiag);
    let mode = 'both404';
    const realFetch = global.fetch;
    global.fetch = (url) => {
      if (mode === 'both404') return Promise.resolve({ ok: false, status: 404 });
      // v2 answers with no livestream (channel offline), v1 never asked.
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ livestream: null }) });
    };
    try {
      swCalls.length = 0;
      await S.probeKickLayer();
      const first = rows();
      assert.strictEqual(first.filter((r) => r.ev === 'kick_probe' && r.data.at === 'poll').length, 1, 'the first poll must log its outcome');
      assert.strictEqual(first.filter((r) => r.ev === 'kick_offline').length, 1, 'the first offline poll must log once');

      swCalls.length = 0;
      await S.probeKickLayer();
      assert.deepStrictEqual(rows(), [], `an identical poll logged ${rows().length} row(s); a sample is not a transition`);

      swCalls.length = 0;
      mode = 'noLs'; // same channel, DIFFERENT outcome: this is news
      await S.probeKickLayer();
      const changed = rows();
      assert.ok(changed.some((r) => r.ev === 'kick_probe' && r.data.at === 'poll'), 'a changed outcome must log its poll row');
      assert.ok(changed.some((r) => r.ev === 'kick_offline'), 'a changed outcome must log its offline row');

      swCalls.length = 0;
      await S.probeKickLayer();
      assert.deepStrictEqual(rows(), [], 'the same NEW outcome logged twice; the guard only suppressed the first state');
    } finally {
      global.fetch = realFetch;
    }
    console.log('W6 kick log: an unchanged poll is silent, a changed outcome is news - OK');
  }

  {
    // A SOURCE SWITCH IN FLIGHT IS NOT A STALL. Measured 2026-11-13 (0.8.88): the
    // go-live mint landed 460 ms after the click, the frame took ~10 s to apply
    // it, and the stall watchdog fired at 9.8 s on the OLD state — three
    // reconnects and a teardown for a load that was already working. The
    // watchdog and the grace must agree, or one undoes the other.
    const S = new Function('window', 'document', 'location', 'navigator', src
      + '\n;return {KO, rectTick};')(
      global, doc, global.location, global.navigator,
    );
    const K = S.KO;
    const posted = [];
    const frame = { ...el('iframe'), dataset: { koToken: 'tok-w5' }, contentWindow: { postMessage: (p) => posted.push(p && p.__koKick) } };
    doc.getElementById = () => null;
    K.wrap = el('div');
    K.wrap.style.display = 'block';
    K.kickFrame = frame;
    K.kickWin = frame.contentWindow;
    K.kickReady = true;
    K.enabled = true;
    K.player = 'kick';
    K.kickSlug = 'w5channel';
    K.activeUrl = 'https://ivs.example/live-w5';
    K.kickOnDvr = false;
    K.kickState = { state: 'Playing', pos: 900, lat: 1, dur: 0, ts: Date.now() };
    K.ytState = { ready: false, playing: false, live: false, muted: true, dur: 0, ct: 0, error: 0 };
    K.reconnectCount = 0;
    // A load was just issued: the OLD state is still frozen at the replay offset.
    K.kickUrlT = Date.now();
    K.stallTicks = 0;
    K.lastTickT = 900;
    // Drive the rect loop enough times that a 21-tick stall would have fired.
    for (let i = 0; i < 26; i++) {
      K.kickState = { state: 'Playing', pos: 900, lat: 1, dur: 0, ts: Date.now() };
      S.rectTick();
    }
    assert.strictEqual(K.reconnectCount, 0, 'a stall watchdog fired inside a source switch that was still loading');
    // Past the grace, the SAME frozen state is a real stall.
    K.kickUrlT = Date.now() - 30000;
    for (let i = 0; i < 26; i++) {
      K.kickState = { state: 'Playing', pos: 900, lat: 1, dur: 0, ts: Date.now() };
      S.rectTick();
    }
    assert.ok(K.reconnectCount > 0, 'past the load grace a frozen Playing element must still be recovered');
    console.log('W5 stall grace: a source switch in flight is not a stall, a frozen element past it still is - OK');
  }

  // ---- D1: the clock the owner can SEE -------------------------------------
  // Owner 2026-11-16: "tu entende literalmente tudo que acontece? quando o
  // player volta, quando o player lag behind, quando a live ta em x tempo em
  // tempo real mas o display ta y tempo atras? e quando repeticoes acontecem".
  // The ring could name the clean player's own `lat` and the native element's
  // `ct`, and nothing compared them or named a repeat. These four verdicts are
  // the answer, and each one is driven through the real sampler.
  {
    const rows = () => swCalls.filter((m) => m && m.__koDiag && m.__koDiag.ev === 'display-clock').map((m) => m.__koDiag.data);
    const reps = () => swCalls.filter((m) => m && m.__koDiag && m.__koDiag.ev === 'display-repeat').map((m) => m.__koDiag.data);
    KO.player = 'kick';
    KO.disp = null;
    const base = rows().length;
    // The sampler keeps its own clock in KO.disp; the arm drives it the way a
    // fake clock would instead of spending seconds of real time, so the suite
    // still finishes in the window its other arms were tuned for.
    KO.kickState = { state: 'Playing', pos: 100, lat: 3 };
    api.dispSample();
    KO.kickState = { state: 'Playing', pos: 101.2, lat: 3 };
    api.dispSample();
    const live = KO.disp.last; // two identical LIVE samples emit no row by design
    assert.strictEqual(live.verdict, 'LIVE', `a playing surface at lat 3 is not LIVE: ${JSON.stringify(live)}`);
    assert.ok(live.delta > 0.5, `the sample did not measure the advance: ${JSON.stringify(live)}`);
    assert.strictEqual(live.latSrc, 'frame', `latSrc=${live.latSrc} (the frame reports its own edge)`);
    assert.ok(rows().slice(base).some((r) => r.verdict === 'LIVE'), 'the surface change did not emit a clock row');
    // the picture steps BACK 11 s: those seconds are shown again
    KO.kickState = { state: 'Playing', pos: 90, lat: 3 };
    api.dispSample();
    const back = KO.disp.last;
    assert.strictEqual(back.verdict, 'REPEAT', `an 11 s backwards step is not named REPEAT: ${JSON.stringify(back)}`);
    assert.ok(reps().some((r) => r.back >= 11), `no display-repeat row carrying the size: ${JSON.stringify(reps())}`);
    // still claims Playing, has not moved for longer than the freeze floor
    KO.disp.movedAt = Date.now() - 3000;
    api.dispSample();
    assert.strictEqual(KO.disp.last.verdict, 'FROZEN', 'a Playing surface that has not moved is not named FROZEN');
    assert.ok(rows().slice(base).some((r) => r.verdict === 'FROZEN'), 'the freeze did not emit a clock row');
    // a paused surface is not a frozen one
    KO.kickState = { state: 'Paused', pos: 90, lat: 3 };
    api.dispSample();
    assert.strictEqual(KO.disp.last.verdict, 'PAUSED', 'a paused surface must not read FROZEN');
    // and the floor has to DECIDE: a step smaller than DISP_REPEAT_SEC is not a
    // repeat, or every frame-time jitter would be reported as one.
    KO.disp.movedAt = Date.now();
    KO.kickState = { state: 'Playing', pos: 89.6, lat: 3 };
    api.dispSample();
    const jitter = KO.disp.last;
    assert.notStrictEqual(jitter.verdict, 'REPEAT', `a ${Math.abs(jitter.delta)} s step is below the floor and must not be REPEAT: ${JSON.stringify(jitter)}`);
    console.log('D1 display clock: LIVE, REPEAT, FROZEN and PAUSED are named per sample - OK');
  }

  // ---- N1: the page's own player gets a bounded recovery --------------------
  // Owner 2026-11-18: *"travou do nada e nao quer destravar. com certeza destrava
  // se eu clicar pause despause."* His ring shows the page pausing its own
  // starved element and the extension doing nothing (0.8.101). These limbs drive
  // the REAL sampler and the REAL recovery over a fake page element, one
  // boundary each: healthy, frozen, page-pause-starved, user pause, hidden tab,
  // overlay ownership, ad-path ownership, and a DVR it must never reload.
  {
    const mkVideo = () => {
      const v = videoEl('nativeStall');
      v.paused = false;
      v.readyState = 4;
      v.currentTime = 100;
      v.duration = Infinity;
      v.playCount = 0;
      v.loadCount = 0;
      v.buffered = { length: 1, start: () => 90, end: (i) => (i === 0 ? 103 : 0) };
      v.play = function () { this.playCount += 1; this.paused = false; return Promise.resolve(); };
      v.load = function () { this.loadCount += 1; this.readyState = 1; this.currentTime = 0; };
      fakeVideos.length = 0;
      fakeVideos.push(v);
      return v;
    };
    let armBase = 0;
    const rows = (ev) => swCalls.slice(armBase).filter((m) => m && m.__koDiag && m.__koDiag.ev === ev).map((m) => m.__koDiag.data);
    const reset = () => {
      armBase = swCalls.length;
      KO.nat = null;
      KO.disp = null;
      KO.natPause = null;
      KO.lastInputAt = 0;
      KO.ownerAttr = null;
      KO.wrap = null;
      KO.enabled = true;
      doc.hidden = false;
      KO.player = 'kick';
    };
    const frozen = (v, ms) => {
      KO.disp = { srf: 'twitch', pos: v.currentTime, movedAt: Date.now() - ms, verdict: 'LIVE', loggedAt: 0, last: null };
    };
    // The episode object is created by the first sample, and a pre-fix copy of
    // the file may never create it at all - then the arm would crash on a null
    // fixture instead of failing on the assertion it guards.
    const seedNat = () => {
      KO.nat = Object.assign({ since: 0, tries: 0, lastAt: 0, why: '', logged: false, failed: false, from: null, refuse: '' }, KO.nat || {});
      return KO.nat;
    };

    // (a) healthy: nothing to say and nothing to touch
    reset();
    let v = mkVideo();
    api.dispSample();
    assert.strictEqual(rows('native-stall').length, 0, 'a healthy playing element was named a stall');
    assert.strictEqual(v.playCount, 0, 'a healthy playing element was played again');

    // (a2) HIS MEASURED HEALTHY ROW, which the fixture above did not reproduce.
    // hls.js keeps the playhead 3 s behind the edge, so a live Twitch element
    // runs at 1.3-1.6 s of forward runway while advancing 1.00 s per second.
    // 0.8.102 read that thin buffer as a stall: `display-clock {delta:5.99,
    // verdict:LIVE}` then `native-stall {why:"clock-frozen", rs:4, buf:1.43}` in
    // the same millisecond, `play()` on a playing element, and a source reload
    // on the second step. The buffer alone may never be the trigger.
    reset();
    v = mkVideo();
    v.currentTime = 77.15;
    v.buffered = { length: 1, start: () => 77.15, end: () => 78.58 }; // 1.43 s, exactly his reading
    frozen(v, 0); // the clock JUST advanced: this is the picture he is watching
    // Seed an OLD episode, as the (h) limb does: `nativeStallWatch` legitimately
    // declines to act on a stall that started this millisecond, and an arm that
    // cannot reach the decision would pass with the defect restored. `KO.nat` is
    // created by the first sample, so the episode is backdated on the second.
    api.dispSample();
    seedNat();
    KO.nat.since = Date.now() - 60000;
    KO.nat.tries = 0;
    KO.nat.lastAt = Date.now() - 60000;
    api.dispSample();
    const a2Rows = rows('native-stall');
    assert.strictEqual(a2Rows.length, 0, `a THIN BUFFER on an advancing live element was named a stall: ${JSON.stringify(a2Rows)}`);
    assert.strictEqual(v.playCount, 0, 'a healthy live element was play()ed again because its buffer was thin');
    v.buffered = { length: 1, start: () => 0, end: () => 100.1 };
    for (let i = 0; i < 3; i++) {
      v.currentTime += 1;
      KO.disp.movedAt = Date.now();
      seedNat().lastAt = Date.now() - 60000; // past the recovery gap: a re-trigger would act now
      api.dispSample();
    }
    assert.strictEqual(rows('native-stall-reload').length, 0, 'a healthy live element had its source reloaded');
    assert.strictEqual(v.loadCount, 0, 'the source of a healthy live element was reloaded');

    // (b) the freeze he reports: claims to play, the clock has not moved, and the
    //     forward runway is gone. This is 42.8s of his ring.
    reset();
    v = mkVideo();
    v.readyState = 2;
    v.buffered = { length: 1, start: () => 90, end: () => 100.15 };
    frozen(v, 5000);
    api.dispSample();
    const bRows = rows('native-stall');
    assert.strictEqual(bRows.length, 1, `a starved frozen element did not name itself: ${JSON.stringify(bRows)}`);
    assert.strictEqual(bRows[0].why, 'no-future-data', `the stall row named the wrong cause: ${JSON.stringify(bRows[0])}`);
    assert.ok(bRows[0].rs < 3 && bRows[0].buf < 1.5, `the stall row did not carry rs/buf: ${JSON.stringify(bRows[0])}`);
    const bResume = rows('native-stall-resume');
    assert.strictEqual(bResume.length, 1, `the first recovery step did not run: ${JSON.stringify(bResume)}`);
    assert.strictEqual(v.playCount, 1, 'the recovery did not attempt play()');
    // the clock comes back: one transition row, and the episode closes
    v.currentTime = 104;
    v.readyState = 4;
    v.buffered = { length: 1, start: () => 90, end: () => 106 };
    api.dispSample();
    assert.strictEqual(rows('native-stall-recovered').length, 1, 'the recovery did not say the picture came back');

    // (c) his exact state at 45.6s: the PAGE parked a starved element, no input
    reset();
    v = mkVideo();
    v.paused = true;
    v.readyState = 1;
    v.currentTime = 29.98;
    v.buffered = { length: 1, start: () => 29.9, end: () => 30.03 };
    KO.natPause = { el: v, at: Date.now() - 6000, ct: 30, rs: 1, hidden: false, inputAgeMs: null, input: null, ours: false };
    frozen(v, 11000);
    api.dispSample();
    const cRows = rows('native-stall');
    assert.strictEqual(cRows.length, 1, `a page-parked starved element was not recovered: ${JSON.stringify(cRows)}`);
    assert.strictEqual(cRows[0].why, 'page-pause-starved', `the row did not name the PAGE as the parker: ${JSON.stringify(cRows[0])}`);
    assert.strictEqual(v.playCount, 1, 'the stalled element was never resumed');

    // (d) a USER pause: a trusted key just before it, even on a starved element
    reset();
    v = mkVideo();
    v.paused = true;
    v.readyState = 4;
    v.buffered = { length: 1, start: () => 0, end: () => 100.1 };
    KO.lastInputAt = Date.now() - 200;
    KO.lastInputWhat = 'keydown';
    KO.natPause = { el: v, at: Date.now() - 6000, ct: 100, rs: 4, hidden: false, inputAgeMs: 200, input: 'keydown', ours: false };
    frozen(v, 12000);
    api.dispSample();
    assert.strictEqual(rows('native-stall').length, 0, 'a pause the owner made was treated as a stall');
    assert.strictEqual(v.playCount, 0, 'the owner\'s own pause was overridden');

    // (e) hidden tab: the sampler must not even run
    reset();
    v = mkVideo();
    v.paused = true;
    v.readyState = 1;
    v.buffered = { length: 1, start: () => 0, end: () => 100.1 };
    KO.natPause = { el: v, at: Date.now() - 9000, ct: 1, rs: 1, hidden: false, inputAgeMs: null, ours: false };
    doc.hidden = true;
    frozen(v, 12000);
    api.dispSample();
    doc.hidden = false;
    assert.strictEqual(rows('native-stall').length, 0, 'a hidden tab was recovered (that is the alt-tab sound he reported)');
    assert.strictEqual(v.playCount, 0, 'a hidden tab had play() called on it');

    // (f) an overlay owns the picture
    reset();
    v = mkVideo();
    v.paused = true;
    v.readyState = 1;
    KO.wrap = { style: {} };
    KO.kickState = { state: 'Playing', pos: 500, lat: 3, ts: Date.now() };
    KO.natPause = { el: v, at: Date.now() - 9000, ct: 1, rs: 1, hidden: false, inputAgeMs: null, ours: false };
    api.dispSample();
    assert.strictEqual(rows('native-stall').length, 0, 'the native was recovered while our layer owned the picture');
    assert.strictEqual(v.playCount, 0, 'the native was played while our layer owned the picture');

    // (g) the ad path owns the screen only when it SHOWS it. Measured on the
    //     guest 2026-11-18: both nodes stay mounted with no pod (standby preload
    //     at 1% opacity, cover `display:none`), so presence must not block.
    const parkStarved = () => {
      reset();
      v = mkVideo();
      v.paused = true;
      v.readyState = 1;
      v.buffered = { length: 1, start: () => 0, end: () => 100.1 };
      KO.natPause = { el: v, at: Date.now() - 9000, ct: 1, rs: 1, hidden: false, inputAgeMs: null, ours: false };
      frozen(v, 12000);
    };
    const withDom = (nodes, vis, fn) => {
      const prevGet = doc.getElementById;
      const prevGcs = global.getComputedStyle;
      doc.getElementById = (id) => nodes[id] || null;
      global.getComputedStyle = (n) => ({ display: (n && n.__disp) || 'block', opacity: (n && n.__op) || '0.01', height: '', maxHeight: '', position: 'static' });
      const prevVis = doc.documentElement.getAttribute('data-ko-audio-vis');
      if (vis == null) doc.documentElement.attrs['data-ko-audio-vis'] = '';
      else doc.documentElement.attrs['data-ko-audio-vis'] = vis;
      try {
        fn();
      } finally {
        doc.getElementById = prevGet;
        global.getComputedStyle = prevGcs;
        if (prevVis == null) delete doc.documentElement.attrs['data-ko-audio-vis'];
        else doc.documentElement.attrs['data-ko-audio-vis'] = prevVis;
      }
    };
    // g1: the standby preload exists but nothing is shown: recover.
    parkStarved();
    {
      const frame = el('iframe');
      frame.__op = '0.01';
      const cover = el('div');
      cover.__disp = 'none';
      withDom({ 'ko-adfix': frame, 'ko-adfix-cover': cover }, '', () => api.dispSample());
    }
    assert.strictEqual(rows('native-stall').length, 1, 'a mounted standby frame blocked the recovery (measured guest defect)');
    assert.strictEqual(v.playCount, 1, 'the native was left parked because a hidden frame existed');
    // g2: the ad frame is revealed: do not touch the native.
    parkStarved();
    {
      const frame = el('iframe');
      frame.__op = '1';
      withDom({ 'ko-adfix': frame }, '', () => api.dispSample());
    }
    assert.strictEqual(rows('native-stall').length, 0, 'the native was recovered while the clean player was on screen');
    assert.strictEqual(v.playCount, 0, 'the native was played under the clean player');
    // g3: the cover is painted: a pod must not be watched, so no recovery.
    parkStarved();
    {
      const cover = el('div');
      cover.__disp = 'flex';
      withDom({ 'ko-adfix-cover': cover }, '', () => api.dispSample());
    }
    assert.strictEqual(rows('native-stall').length, 0, 'the native was recovered under a painted ad cover');
    // g4: the authority says the clean player is the visible surface.
    parkStarved();
    withDom({}, 'ad', () => api.dispSample());
    assert.strictEqual(rows('native-stall').length, 0, 'the native was recovered while the audio authority had the ad surface visible');
    assert.strictEqual(v.playCount, 0, 'the native was played while ad was the visible surface');

    // (h) a DVR position is never reloaded: the rebuild lands at the start of the
    //     timeline, not at the edge, so the second step must refuse and say why.
    reset();
    v = mkVideo();
    v.paused = true;
    v.readyState = 1;
    v.duration = 3600;
    v.buffered = { length: 1, start: () => 0, end: () => 100.1 };
    KO.natPause = { el: v, at: Date.now() - 9000, ct: 1, rs: 1, hidden: false, inputAgeMs: null, ours: false };
    frozen(v, 12000);
    api.dispSample();
    seedNat().lastAt = Date.now() - 60000; // the resume is spent and its gap has passed
    KO.nat.tries = 1;
    KO.nat.since = Date.now() - 60000;
    api.dispSample();
    const hSkip = rows('native-stall-skipped');
    assert.strictEqual(hSkip.length, 1, `a DVR position was not refused with a reason: ${JSON.stringify(hSkip)}`);
    assert.strictEqual(hSkip[0].why, 'not-live', 'the refusal did not name the reason');
    assert.strictEqual(v.loadCount, 0, 'a DVR position was reloaded to the live edge (that is the jump he reports)');

    // (i) a pause stamped while HIDDEN must not disqualify the element for the
    //     rest of the page load. His 0.8.101 ring: `video-pause {..., "hidden":
    //     true}` at ms 938668, then 70+ s of `hb {ct:2511, paused:true, rs:1}`
    //     and NOT ONE recovery row, cured by hand ("destrava se eu clicar pause
    //     despause"). The stamp is written once by the `pause` listener and used
    //     to be permanent, so the watchdog took its early return forever.
    reset();
    v = mkVideo();
    v.paused = true;
    v.readyState = 1;
    v.buffered = { length: 1, start: () => 0, end: () => 100.1 };
    KO.natPause = { el: v, at: Date.now() - 9000, ct: 1, rs: 1, hidden: true, inputAgeMs: null, ours: false };
    doc.hidden = false;
    fireDoc('visibilitychange');
    frozen(v, 12000);
    api.dispSample();
    const iRows = rows('native-stall');
    assert.strictEqual(iRows.length, 1, `a pause from a hidden tab was never recovered after the tab came back: ${JSON.stringify(iRows)}`);
    assert.strictEqual(v.playCount, 1, 'the element stayed parked for the rest of the page load');
    // ...and the STAMP survives: clearing it whole would drop the `at` that still
    // owes the page its own beat before we touch a picture he is watching.
    assert.ok(KO.natPause && KO.natPause.el === v, 'the pause record was destroyed instead of its hidden flag');

    reset();
    console.log('N1 native stall: page pause, freeze, user pause, hidden tab, ownership and DVR - OK');
  }

  // ---- N2: the DECISION is in the log, and the budget is a number -----------
  // The watchdog refuses far more often than it acts (his pause, a hidden tab, a
  // layer that owns the picture, a spent budget). Every one of those returns used
  // to be silent, so a ring could read as "the extension did nothing" when it had
  // chosen not to - and the report could only be answered by reading this file.
  // These limbs drive the REAL sampler and a REAL mutated copy of the file, one
  // boundary each, and each mutation restores the pre-fix behaviour it guards.
  {
    const mkVideo = () => {
      const v = videoEl('nativeStall2');
      v.paused = false;
      v.readyState = 4;
      v.currentTime = 100;
      v.duration = Infinity;
      v.playCount = 0;
      v.loadCount = 0;
      v.buffered = { length: 1, start: () => 90, end: (i) => (i === 0 ? 103 : 0) };
      v.play = function () { this.playCount += 1; this.paused = false; return Promise.resolve(); };
      v.load = function () { this.loadCount += 1; this.readyState = 1; this.currentTime = 0; };
      fakeVideos.length = 0;
      fakeVideos.push(v);
      return v;
    };
    let base = 0;
    const rows = (ev) => swCalls.slice(base).filter((m) => m && m.__koDiag && m.__koDiag.ev === ev).map((m) => m.__koDiag.data);
    const refuses = () => rows('native-stall-refused');
    const seedKo = (K) => {
      K.nat = null;
      K.disp = null;
      K.natPause = null;
      K.lastInputAt = 0;
      K.lastInputWhat = '';
      K.ownerAttr = null;
      K.wrap = null;
      K.enabled = true;
      K.player = 'kick';
      K.kickState = null;
      K.twPaused.clear();
    };
    const reset = () => {
      base = swCalls.length;
      seedKo(KO);
      doc.hidden = false;
    };
    // The measured state, one field from his ring each: `{ct:30, rs:1,
    // paused:true}`, 0.05 s of forward media, and a pause nobody claimed. `K` is
    // the module's OWN `KO`: a mutated copy of the file has its own state, and
    // seeding the outer one would test a module that was never driven.
    const parkStarvedMeasured = (v, K = KO) => {
      v.paused = true;
      v.readyState = 1;
      v.currentTime = 29.98;
      v.buffered = { length: 1, start: () => 29.9, end: () => 30.03 };
      K.natPause = { el: v, at: Date.now() - 9000, ct: 30, rs: 1, hidden: false, inputAgeMs: null, input: null, ours: false };
      K.disp = { srf: 'twitch', pos: v.currentTime, movedAt: Date.now() - 12000, verdict: 'LIVE', loggedAt: 0, last: null };
    };
    // A REAL mutated copy of the file: the same harness globals, one string
    // replaced. Behaviour is then observed by driving its own sampler. Its
    // timers are disabled: a mutated module must not sample this suite's page
    // on its own thousandth millisecond and turn a later arm's numbers into
    // someone else's.
    const mk = (source) => {
      const realSetInterval = global.setInterval;
      global.setInterval = () => 0;
      try {
        return new Function('window', 'document', 'location', 'navigator', source
          + '\n;return {KO, dispSample, twitchVideo};')(global, doc, global.location, global.navigator);
      } finally {
        global.setInterval = realSetInterval;
      }
    };
    const red = (from, to) => {
      assert.ok(src.includes(from), `N2 RED: the mutation target is not in the source any more: ${from.slice(0, 60)}`);
      return mk(src.replace(from, to));
    };
    const redSample = (mod) => {
      const b = swCalls.length;
      mod.dispSample();
      return swCalls.slice(b).filter((m) => m && m.__koDiag).map((m) => m.__koDiag);
    };
    const evOf = (calls, ev) => calls.filter((c) => c.ev === ev).map((c) => c.data);
    // Red limbs run a mutated copy: seed ITS state, park the measured element and
    // sample it, with the population swapped so only that element is visible.
    const prep = (mod, over) => {
      const mv = mkVideo();
      seedKo(mod.KO);
      if (over) over(mv, mod.KO);
      fakeVideos.length = 0;
      fakeVideos.push(mv);
      return { v: mv, calls: redSample(mod) };
    };

    // N2a: the measured case - the PLAYER parked its own element after a buffer
    //      drain, and the cheapest action that can work is `play()`.
    reset();
    let v = mkVideo();
    parkStarvedMeasured(v);
    api.dispSample();
    const aStall = rows('native-stall');
    assert.strictEqual(aStall.length, 1, `the measured park was not named: ${JSON.stringify(aStall)}`);
    assert.strictEqual(aStall[0].why, 'page-pause-starved', `wrong cause: ${JSON.stringify(aStall[0])}`);
    assert.ok(aStall[0].rs === 1 && aStall[0].buf < 0.1, `the decision row lost the numbers that justified it: ${JSON.stringify(aStall[0])}`);
    const aAct = rows('native-stall-resume');
    assert.strictEqual(aAct.length, 1, `the measured park was not recovered: ${JSON.stringify(aAct)}`);
    assert.strictEqual(aAct[0].action, 'play', `a merely parked element got the heavier action: ${JSON.stringify(aAct[0])}`);
    assert.strictEqual(aAct[0].from, aAct[0].to, 'a paused element had its playhead moved (not the cheapest action)');
    assert.strictEqual(v.playCount, 1, 'the measured park was never resumed');
    assert.strictEqual(v.loadCount, 0, 'the measured park had its source reloaded (the preroll/jump risk)');
    {
      // Pre-fix: the sampler never handed the page's element to any recovery.
      const m = red(
        "        nativeStallWatch(pageVideo, now, { frozen: verdict === 'FROZEN', movedMs: d.movedAt ? now - d.movedAt : 0 });",
        '        /* RED: no recovery of the page element */',
      );
      const r = prep(m, (mv, K) => parkStarvedMeasured(mv, K));
      assert.strictEqual(evOf(r.calls, 'native-stall').length, 0, 'N2a RED: the pre-fix sampler named no stall at all');
      assert.strictEqual(r.v.playCount, 0, 'N2a RED: without the watchdog the parked element stays parked (pre-fix)');
    }

    // N2b: HIS pause is not a stall, and the refusal says which of the two it
    //      was - the same distinction `resumeRefusedByUser` makes on the pod path.
    reset();
    v = mkVideo();
    v.paused = true;
    v.readyState = 4;
    v.buffered = { length: 1, start: () => 0, end: () => 100.1 };
    KO.natPause = { el: v, at: Date.now() - 30000, ct: 100, rs: 4, hidden: false, inputAgeMs: 300, input: 'pointerdown', ours: false };
    KO.disp = { srf: 'twitch', pos: 100, movedAt: Date.now() - 30000, verdict: 'LIVE', loggedAt: 0, last: null };
    api.dispSample();
    assert.strictEqual(v.playCount, 0, "the owner's own 30 s pause was overridden");
    let bRef = refuses();
    assert.strictEqual(bRef.length, 1, `the user-pause refusal is not in the log: ${JSON.stringify(bRef)}`);
    assert.strictEqual(bRef[0].why, 'user-paused', `the refusal named the wrong reason: ${JSON.stringify(bRef[0])}`);
    assert.strictEqual(bRef[0].inputAgeMs, 300, `the refusal did not carry the input distance: ${JSON.stringify(bRef[0])}`);
    api.dispSample();
    api.dispSample();
    assert.strictEqual(refuses().length, 1, 'the refusal was written once per tick (a site that fires on unchanged state)');
    {
      const m = red('    const fresh = p.inputAgeMs != null && p.inputAgeMs <= NATIVE_USER_PAUSE_MS;', '    const fresh = false; // RED: pre-fix');
      const r = prep(m, (mv, K) => {
        mv.paused = true;
        mv.readyState = 4;
        mv.buffered = { length: 1, start: () => 0, end: () => 100.1 };
        K.natPause = { el: mv, at: Date.now() - 30000, ct: 100, rs: 4, hidden: false, inputAgeMs: 300, input: 'pointerdown', ours: false };
        K.disp = { srf: 'twitch', pos: 100, movedAt: Date.now() - 30000, verdict: 'LIVE', loggedAt: 0, last: null };
      });
      assert.strictEqual(r.v.playCount, 1, "N2b RED: ignoring the input distance resumes the owner's own pause (pre-fix)");
      assert.strictEqual(evOf(r.calls, 'native-stall-refused').length, 0, 'N2b RED: no refusal row when the guard is gone');
    }

    // N2c: a hidden tab resumes nothing - and says so. The sampler returns before
    //      it MEASURES anything there, so the row has to come from its own guard;
    //      a pause stamped while hidden is refused by the watchdog.
    reset();
    v = mkVideo();
    parkStarvedMeasured(v);
    v.paused = true;
    KO.natPause.hidden = false;
    doc.hidden = true;
    api.dispSample();
    doc.hidden = false;
    assert.strictEqual(v.playCount, 0, 'a hidden tab had play() called on it');
    let cRef = refuses();
    assert.strictEqual(cRef.length, 1, `the hidden-tab refusal is not in the log: ${JSON.stringify(cRef)}`);
    assert.strictEqual(cRef[0].why, 'hidden', `the refusal named the wrong reason: ${JSON.stringify(cRef[0])}`);
    {
      const m = red('      nativeStallHiddenRefuse();\n      return;', '      return; // RED: pre-fix');
      doc.hidden = true;
      let calls;
      let mv;
      try {
        const r = prep(m, (x, K) => parkStarvedMeasured(x, K));
        mv = r.v;
        calls = r.calls;
      } finally {
        doc.hidden = false;
      }
      assert.strictEqual(mv.playCount, 0, 'N2c RED: a hidden tab still resumes nothing (the guard is the row)');
      assert.strictEqual(evOf(calls, 'native-stall-refused').length, 0, 'N2c RED: a hidden tab decides silently again (pre-fix)');
    }
    // ...and the SAME stamp with the tab BACK is no longer a refusal: the flag is
    // cleared on the visibility edge (0.8.104), and a pause that outlives the
    // return is exactly what parked his picture for 71 s (2026-11-19). The
    // pre-fix line refused it while the tab was visible, which is the RED.
    reset();
    v = mkVideo();
    parkStarvedMeasured(v);
    KO.natPause.hidden = true;
    api.dispSample();
    assert.strictEqual(v.playCount, 1, 'a pause stamped while hidden was left parked after the tab came back');
    assert.strictEqual(rows('native-stall').length, 1, `the recovered hidden-stamp pause was not named: ${JSON.stringify(rows('native-stall'))}`);
    {
      const from = "    if (p.hidden && document.hidden) return nativeStallRefuse('hidden', { ct, rs, buf: runway });";
      assert.ok(src.includes(from), 'N2c RED: the hidden-tab condition is gone from the source');
      const m = red(from, "    if (p.hidden) return nativeStallRefuse('hidden', { ct, rs, buf: runway }); // RED: pre-fix");
      const r = prep(m, (mv, K) => {
        parkStarvedMeasured(mv, K);
        K.natPause.hidden = true;
      });
      assert.strictEqual(r.v.playCount, 0, 'N2c RED: the pre-fix line refuses the pause the tab brought back (his 71 s)');
    }

    // N2d: a layer owns the picture - the layer's own watchdog owns the native.
    reset();
    v = mkVideo();
    parkStarvedMeasured(v);
    KO.natPause = { el: v, at: Date.now() - 9000, ct: 30, rs: 1, hidden: false, inputAgeMs: null, input: null, ours: false };
    KO.wrap = { style: {} };
    KO.kickState = { state: 'Playing', pos: 500, lat: 3, ts: Date.now() };
    api.dispSample();
    assert.strictEqual(v.playCount, 0, 'the native was played while our layer owned the picture');
    assert.strictEqual(v.loadCount, 0, 'the native source was reloaded while our layer owned the picture');
    const dRef = refuses();
    assert.strictEqual(dRef.length, 1, `the overlay-owned refusal is not in the log: ${JSON.stringify(dRef)}`);
    assert.strictEqual(dRef[0].why, 'overlay-owned', `the refusal named the wrong reason: ${JSON.stringify(dRef[0])}`);
    api.dispSample();
    assert.strictEqual(refuses().length, 1, 'the overlay-owned refusal repeats on every tick');
    {
      // Two guards hold this case: the surface predicate, and the watchdog's own
      // ownership check. Removing both is what restores the pre-fix recovery.
      const src2 = src
        .replace("  if (overlayOwnsPicture()) return KO.player === 'youtube' ? 'youtube' : 'kick';", "  if (false && overlayOwnsPicture()) return KO.player === 'youtube' ? 'youtube' : 'kick'; // RED")
        .replace("  const screenOwner = coldHoldActive() ? 'cold-hold' : overlayOwnsPicture() ? 'overlay-owned' : adPathOwnsScreen() ? 'ad-owned' : '';", "  const screenOwner = ''; // RED: surface guards removed")
        .replace("  if (KO.twPaused.has(v)) {\n    // We parked it ourselves for a layer: by design, no episode, no row.\n    return nativeStallIdle();\n  }", '')
        .replace("      nativeStallOwnedRefuse();", '      nativeStallIdle(); // RED');
      assert.notStrictEqual(src2, src, 'N2d RED: the ownership guards are not in the source any more');
      assert.ok(!src2.includes('We parked it ourselves'), 'N2d RED: the twPaused guard is still in the source');
      const m2 = mk(src2);
      const r = prep(m2, (mv, K) => {
        parkStarvedMeasured(mv, K);
        K.wrap = { style: {} };
        K.kickState = { state: 'Playing', pos: 500, lat: 3, ts: Date.now() };
        // The layer has painted (the ticket's page: the picture is the layer's),
        // so the cold hold is closed and ownership is the only guard left.
        K.picSeenAt = Date.now();
        K.picLostAt = 0;
      });
      assert.strictEqual(r.v.playCount, 1, 'N2d RED: without the ownership guards the native is recovered under our layer');
      assert.strictEqual(evOf(r.calls, 'native-stall-refused').length, 0, 'N2d RED: no refusal row under an owned picture');
    }

    // N2e: THE CEILING. Two actions per episode, then a row that names the
    //      number it stopped at - and no further attempt, ever, for that episode.
    reset();
    v = mkVideo();
    parkStarvedMeasured(v);
    const ladder = () => {
      KO.nat.lastAt = Date.now() - 60000; // the 10 s gap has passed
      KO.disp.movedAt = Date.now() - 12000;
      api.dispSample();
    };
    api.dispSample();
    assert.strictEqual(v.playCount, 1, 'the first step did not run');
    ladder();
    assert.strictEqual(v.loadCount, 1, 'the second step did not refresh the source');
    const eReload = rows('native-stall-reload');
    assert.strictEqual(eReload.length, 1, `the reload step was not named: ${JSON.stringify(eReload)}`);
    assert.strictEqual(eReload[0].step, 2, `the reload row named the wrong step: ${JSON.stringify(eReload[0])}`);
    // The reload step also calls play() on the fresh source; from here on NOTHING
    // may act again.
    const acted = { play: v.playCount, load: v.loadCount };
    ladder();
    ladder();
    ladder();
    const eFail = rows('native-stall-failed');
    assert.strictEqual(eFail.length, 1, `the spent budget is not in the log, once: ${JSON.stringify(eFail)}`);
    assert.strictEqual(eFail[0].tries, 2, `the ceiling row carried the wrong count: ${JSON.stringify(eFail[0])}`);
    assert.strictEqual(eFail[0].max, 2, `the ceiling row must NAME the ceiling it stopped at: ${JSON.stringify(eFail[0])}`);
    assert.strictEqual(v.playCount, acted.play, 'an attempt ran after the budget was spent');
    assert.strictEqual(v.loadCount, acted.load, 'the source was reloaded after the budget was spent');
    {
      const m = red('const NATIVE_RECOVER_MAX = 2; // resume inside held media, then ONE source refresh', 'const NATIVE_RECOVER_MAX = 99; // RED: unbounded');
      const b = swCalls.length;
      const mv = mkVideo();
      seedKo(m.KO);
      parkStarvedMeasured(mv, m.KO);
      fakeVideos.length = 0;
      fakeVideos.push(mv);
      m.dispSample();
      for (let i = 0; i < 3; i++) {
        m.KO.nat.lastAt = Date.now() - 60000;
        m.KO.disp.movedAt = Date.now() - 12000;
        m.dispSample();
      }
      assert.ok(mv.playCount > 1, 'N2e RED: without the ceiling the episode keeps acting (pre-fix retry loop)');
      assert.strictEqual(swCalls.slice(b).filter((x) => x && x.__koDiag && x.__koDiag.ev === 'native-stall-failed').length, 0, 'N2e RED: an unbounded budget never spends anything, so no failed row');
    }

    reset();
    console.log('N2 native decisions: resumed/refused rows, hidden tab, owned picture and the ceiling - OK');
  }

  // ---- N3: the pause the AD PATH made is attributed, budgeted and then cured --
  // Measured 2026-11-24 in the owner's own ring (twitch.tv/cellbit, 0.8.112):
  // `ad-ui-hold {act:"skip", why:"hold-expired", heldMs:12498}` and then
  // `hb {paused:true, ct:1023.3, rs:4}` at ONE position for 71 s, until the page
  // reloaded itself. Two holes, both here: the ad path's pause looked like a page
  // park ("a healthy parked player stays parked"), and nothing in this file could
  // tell it apart from his own pause.
  {
    const mkVideo3 = (bfr) => {
      const v = videoEl('nativeStall3');
      v.paused = true;
      v.readyState = 4;
      v.currentTime = 100;
      v.duration = Infinity;
      v.playCount = 0;
      v.loadCount = 0;
      v.buffered = bfr;
      v.play = function () { this.playCount += 1; this.paused = false; return Promise.resolve(); };
      v.load = function () { this.loadCount += 1; this.readyState = 1; this.currentTime = 0; };
      fakeVideos.length = 0;
      fakeVideos.push(v);
      return v;
    };
    // A parked element with plenty of media in front of it: the shape that used
    // to be "healthy parked, leave it" no matter who parked it.
    const roomy = () => ({ length: 1, start: () => 90, end: () => 130 });
    // A mutated copy of the file with its own state, timers disabled: the same
    // shape N2 uses, kept local so this section owns its own REDs.
    const mk = (source) => {
      const realSetInterval = global.setInterval;
      global.setInterval = () => 0;
      try {
        return new Function('window', 'document', 'location', 'navigator', source
          + '\n;return {KO, dispSample, twitchVideo, installNativeStamp};')(global, doc, global.location, global.navigator);
      } finally {
        global.setInterval = realSetInterval;
      }
    };
    let b0 = 0;
    const rowsN3 = (ev) => swCalls.slice(b0).filter((m) => m && m.__koDiag && m.__koDiag.ev === ev).map((m) => m.__koDiag.data);
    const parkSeed = (v, at, adpark, K = KO) => {
      K.nat = null;
      K.disp = { srf: 'twitch', pos: v.currentTime, movedAt: Date.now() - 12000, verdict: 'PAUSED', loggedAt: 0, last: null };
      K.natPause = { el: v, at, ct: v.currentTime, rs: 4, hidden: false, inputAgeMs: null, input: null, ours: false, adpark };
      K.lastInputAt = 0;
      K.lastInputWhat = '';
      K.ownerAttr = null;
      K.wrap = null;
      K.enabled = true;
      K.player = 'twitch';
      K.kickState = null;
      K.twPaused.clear();
    };
    // (a) INSIDE the budget the park is ours and nothing is touched - a hold may
    //     still hand the picture back, and resuming under it is the pause/resume
    //     fight of 0.8.9x.
    b0 = swCalls.length;
    doc.hidden = false;
    let v3 = mkVideo3(roomy());
    parkSeed(v3, Date.now() - 5000, true);
    api.dispSample();
    assert.strictEqual(v3.playCount, 0, 'an ad park inside its budget was resumed (the hold may still hand it back)');
    assert.strictEqual(rowsN3('native-stall').length, 0, 'an ad park inside its budget was named a stall');
    const inRef = rowsN3('native-stall-refused');
    assert.strictEqual(inRef.length, 1, `the in-budget park did not name itself once: ${JSON.stringify(inRef)}`);
    assert.strictEqual(inRef[0].why, 'ad-park', `the in-budget row blamed the wrong reason: ${JSON.stringify(inRef[0])}`);
    api.dispSample();
    api.dispSample();
    assert.strictEqual(rowsN3('native-stall-refused').length, 1, 'the in-budget row was written once per sample (a site that fires on unchanged state)');
    // (b) PAST the budget it is a freeze, and the row names the author and the
    //     number: "the ad path parked this and stopped waiting".
    b0 = swCalls.length;
    v3 = mkVideo3(roomy());
    parkSeed(v3, Date.now() - 20000, true);
    api.dispSample();
    const bStall = rowsN3('native-stall');
    assert.strictEqual(bStall.length, 1, `the expired ad park was not named: ${JSON.stringify(bStall)}`);
    assert.strictEqual(bStall[0].why, 'ad-park-expired', `the row blamed the wrong cause: ${JSON.stringify(bStall[0])}`);
    const bRes = rowsN3('native-stall-resume');
    assert.strictEqual(bRes.length, 1, `the expired ad park was not recovered: ${JSON.stringify(bRes)}`);
    assert.strictEqual(bRes[0].action, 'play', `the cheapest action was not used: ${JSON.stringify(bRes[0])}`);
    assert.strictEqual(v3.playCount, 1, "his frozen picture was never resumed");
    assert.strictEqual(v3.loadCount, 0, 'the element was reloaded instead of resumed (the preroll risk)');
    {
      // Pre-fix: the park was never stale, so the picture stayed frozen.
      const gate = "    if (p.adpark && now - p.at < AD_PARK_BUDGET_MS) {";
      assert.ok(src.includes(gate), 'N3 RED: the budget gate is gone from the source');
      const m = mk(src.replace(
        gate + "\n      return nativeStallRefuse('ad-park', { ct, rs, buf: runway, heldMs: Math.round(now - p.at), budgetMs: AD_PARK_BUDGET_MS });\n    }",
        "    if (p.adpark) return nativeStallIdle(); // RED: pre-fix, any ad park is left alone",
      ));
      const mv = mkVideo3(roomy());
      parkSeed(mv, Date.now() - 20000, true, m.KO);
      fakeVideos.length = 0;
      fakeVideos.push(mv);
      const bb = swCalls.length;
      m.dispSample();
      assert.strictEqual(mv.playCount, 0, 'N3 RED: without the budget the expired park is still left alone (his 71 s)');
      assert.strictEqual(swCalls.slice(bb).filter((x) => x && x.__koDiag && x.__koDiag.ev === 'native-stall').length, 0, 'N3 RED: the pre-fix watchdog never named the parked element');
    }
    // (c) THE STAMP ITSELF: the ad path declares `data-ko-adpark` before it
    //     pauses, and the isolated world can only read it at the pause event.
    //     Driven through the REAL listener, not a regex.
    {
      const v4 = mkVideo3(roomy());
      KO.natPause = null;
      assert.ok((docListeners.pause || []).length > 0, 'the pause stamp listener is not installed');
      doc.documentElement.setAttribute('data-ko-adpark', '1');
      fireDoc('pause', { type: 'pause', target: v4 });
      const stampedAd = KO.natPause && KO.natPause.adpark === true && KO.natPause.el === v4;
      doc.documentElement.setAttribute('data-ko-adpark', '0');
      fireDoc('pause', { type: 'pause', target: v4 });
      const stampedPage = KO.natPause && KO.natPause.adpark === false;
      assert.ok(stampedAd, `a pause with the park declared was not attributed to the ad path: ${JSON.stringify(KO.natPause && KO.natPause.adpark)}`);
      assert.ok(stampedPage, `a page pause was attributed to the ad path: ${JSON.stringify(KO.natPause && KO.natPause.adpark)}`);
      KO.natPause = null;
      // RED: drop the attribute read and the two pauses become indistinguishable.
      const m = mk(src.replace(
        "              return String((document.documentElement && document.documentElement.getAttribute('data-ko-adpark')) || '') === '1';",
        '              return false; // RED: pre-fix, every pause is the page\'s',
      ));
      m.installNativeStamp(); // the mutated module's own listener; the real one is already installed
      m.KO.natPause = null;
      doc.documentElement.setAttribute('data-ko-adpark', '1');
      fireDoc('pause', { type: 'pause', target: v4 });
      assert.ok(m.KO.natPause && m.KO.natPause.el === v4, 'N3(c) RED: the mutated stamp never saw the pause');
      assert.strictEqual(m.KO.natPause.adpark, false, 'N3(c) RED: without the read an ad park still reads as the page\'s pause');
      doc.documentElement.setAttribute('data-ko-adpark', '0');
      KO.natPause = null;
    }
    // (d) A PAUSE STAMPED WHILE THE TAB WAS HIDDEN IS NOT HIS, AND IT IS NOT
    //     DURABLE EITHER. Measured in the owner's ring 2026-11-26 (0.8.116,
    //     twitch.tv/buzzyi_): alt-tabbed, the page paused its own element inside
    //     a playlist pod, the pod ended while the tab was hidden, and the element
    //     sat at `ct 12.65, buf 17.2, paused:true` for 5m11 with ZERO
    //     `native-stall` rows - 17.2 s of runway read as "he parked it". Nobody
    //     did: the stamp was written in a hidden tab. The pre-fix early return
    //     (`!starved -> idle`) is the RED below.
    b0 = swCalls.length;
    doc.hidden = false;
    v3 = mkVideo3({ length: 1, start: () => 11, end: () => 29.85 }); // buf 17.2, exactly his row
    v3.currentTime = 12.65;
    parkSeed(v3, Date.now() - 9000, false);
    KO.natPause.hiddenAt = Date.now() - 9000; // stamped in the hidden stretch
    KO.natPause.hidden = false; // the visibility edge cleared the flag, not the record
    api.dispSample();
    const dStall = rowsN3('native-stall');
    assert.strictEqual(dStall.length, 1, `the pause from the hidden stretch was never named: ${JSON.stringify(dStall)}`);
    assert.strictEqual(dStall[0].why, 'hidden-pause', `the row blamed the wrong cause: ${JSON.stringify(dStall[0])}`);
    assert.strictEqual(v3.playCount, 1, 'the picture stayed parked for the rest of the page load (his 5m11)');
    assert.strictEqual(v3.loadCount, 0, 'the element was reloaded instead of resumed (the preroll risk)');
    // ...and the SAME pause stamped while the tab was VISIBLE is his, and stays
    // parked: the origin is the discriminator, not the runway.
    b0 = swCalls.length;
    v3 = mkVideo3({ length: 1, start: () => 11, end: () => 29.85 });
    v3.currentTime = 12.65;
    parkSeed(v3, Date.now() - 9000, false);
    api.dispSample();
    assert.strictEqual(v3.playCount, 0, 'a pause HE made with media in hand was resumed (the watchdog undid his park)');
    assert.strictEqual(rowsN3('native-stall').length, 0, `his own park was named a stall: ${JSON.stringify(rowsN3('native-stall'))}`);
    {
      const gate = '    } else if (!starved && !hidPause) {';
      assert.ok(src.includes(gate), 'N3(d) RED: the parked-player gate is gone from the source');
      const m = mk(src.replace(gate, '    } else if (!starved) { // RED: pre-fix, any roomy park stays parked'));
      const mv = mkVideo3({ length: 1, start: () => 11, end: () => 29.85 });
      mv.currentTime = 12.65;
      parkSeed(mv, Date.now() - 9000, false, m.KO);
      m.KO.natPause.hiddenAt = Date.now() - 9000;
      fakeVideos.length = 0;
      fakeVideos.push(mv);
      const bb = swCalls.length;
      m.dispSample();
      assert.strictEqual(mv.playCount, 0, 'N3(d) RED: without the hidden-origin gate the parked element is still left alone (his 5m11)');
      assert.strictEqual(swCalls.slice(bb).filter((x) => x && x.__koDiag && x.__koDiag.ev === 'native-stall').length, 0,
        'N3(d) RED: the pre-fix watchdog never named the parked element');
    }
    console.log('N3 ad park: attributed at the pause, budgeted, then cured - OK');
    console.log('N3d hidden pause: a pause from the hidden stretch is cured, his visible pause is not - OK');
  }

  // ---- O1: the DEATH PATH publishes the loss of the picture ----------------
  // Measured 2026-11-19 in the owner's own Chrome, twitch.tv/alanzoka (a
  // channel with NO kick counterpart, so the layer dies on the first offline
  // probe): his ring holds ONE `owner` row for the whole 1200-entry window -
  // `{pick:"kick", pic:true, to:"kick"}` - and `ad-ui-on` fires 29.7 s later
  // with `ad-ui-hold` nowhere. The live page still reads
  // `data-ko-owner="kick"` while `#ko-wrap` is absent. `syncOwner()` publishes
  // from `syncMute()`, which the rect loop only reaches below `if (!KO.wrap)`,
  // so nulling the wrap here froze the attribute at `kick` forever: the MAIN
  // world's `overlayOwnsPlayback()` (twitch-adblock.js:1301) read "the native
  // is covered" on a page whose picture was Twitch's, and `adUiHold` returned
  // at line 1297 before it ever looked at the ad.
  {
    const owner = (D) => D.documentElement.attrs['data-ko-owner'] || '';
    const mk = (source) => new Function('window', 'document', 'location', 'navigator', source
      + '\n;return {KO, teardown, syncMute, overlayOwnsPicture};')(global, doc, global.location, global.navigator);
    // The state the layer is in when it dies: selected, playing, published.
    const seed = (K) => {
      K.player = 'kick';
      K.wrap = el('div');
      K.wrap.style.display = 'block';
      K.kickState = { state: 'Playing', paused: false, muted: false, pos: 10, lat: 2, dur: 120, ts: Date.now() };
      K.picSeenAt = Date.now();
      K.picLostAt = 0;
      K.bootAt = performance.now() - 10000;
      K.ownerAttr = undefined;
    };
    const shipped = mk(src);
    seed(shipped.KO);
    fakeVideos.length = 0;
    shipped.syncMute();
    assert.strictEqual(owner(doc), 'kick', 'O1 setup: a playing layer publishes data-ko-owner=kick');
    assert.strictEqual(shipped.overlayOwnsPicture(), true, 'O1 setup: the layer owns the picture before it dies');
    shipped.teardown();
    assert.strictEqual(shipped.KO.wrap, null, 'O1: teardown drops the wrap');
    assert.strictEqual(owner(doc), '', 'O1: the death path publishes data-ko-owner="" (a dead layer must not keep claiming the screen)');
    assert.strictEqual(shipped.overlayOwnsPicture(), false, 'O1: no wrap means no ownership, so the ad path may hold again');
    // The reachability half, in the shape the ring recorded: the attribute was
    // published and the wrap vanished, and the ONLY writer must still be able
    // to clear it with no wrap and no rect loop running.
    doc.documentElement.attrs['data-ko-owner'] = 'kick'; // the frozen state measured live
    shipped.KO.ownerAttr = 'kick';
    shipped.syncMute();
    assert.strictEqual(owner(doc), '', 'O1: syncMute with no wrap republishes the loss (this is what the rect loop never reached)');
    // RED: the pre-fix file, with the death-path call removed. The attribute
    // must stay `kick` - that IS the defect the ring measured.
    const pre = src.replace(
      `  syncOwner();\n  // the frame dies with the removed iframe; no ytCmd('destroy') exists\n`,
      `  // the frame dies with the removed iframe; no ytCmd('destroy') exists\n`,
    );
    assert.notStrictEqual(pre, src, 'O1 RED: the mutation (drop the death-path syncOwner call) applied to the shipped file');
    const before = mk(pre);
    seed(before.KO);
    fakeVideos.length = 0;
    before.syncMute();
    assert.strictEqual(owner(doc), 'kick', 'O1 RED setup: the pre-fix layer publishes kick too');
    before.teardown();
    assert.strictEqual(before.KO.wrap, null, 'O1 RED: the pre-fix teardown also drops the wrap');
    assert.strictEqual(
      owner(doc),
      'kick',
      'O1 RED: without the death-path call the attribute is frozen at kick with no layer (the measured defect)',
    );
    fakeVideos.length = 0;
    // O1b: the writer's BASELINE is the published value, so a cold page that
    // tears down before any picture publishes nothing and logs nothing. With
    // `undefined` here the new unconditional publish reads as a transition and
    // every cold teardown writes `owner {from:null, to:null}` into his ring.
    const cold = mk(src);
    doc.documentElement.attrs['data-ko-owner'] = ''; // a cold page: nothing was ever published
    assert.strictEqual(cold.KO.ownerAttr, '', 'O1b: the attribute writer starts at the value a page actually publishes');
    cold.teardown();
    assert.strictEqual(owner(doc), '', 'O1b: a cold teardown publishes nothing (the page already said "")');
    const coldPre = mk(src.replace("  ownerAttr: '', // last value published to data-ko-owner\n", ''));
    assert.strictEqual(
      coldPre.KO.ownerAttr,
      undefined,
      'O1b RED: without the declared baseline the first publish is a phantom transition',
    );
    console.log('O1 owner death: teardown publishes the loss (RED: the attribute stays kick with no wrap) - OK');
  }

  // ---- S: the seekbar obeys the user, not the live edge ---------------------
  // Owner 2026-11-24: "voltando a live pra ver o replay ... ta brigando comigo
  // no controle do seek". These arms drive the REAL #ko-seekbar pointerup and
  // the REAL frame `st` listener; every changed decision gets a RED mutation
  // restoring the pre-fix line, and the same arm must then fail.
  {
    const mkSeek = (from, to) => {
      if (from) assert.ok(src.includes(from), `S RED: mutation target missing: ${from.slice(0, 70)}`);
      const code = from ? src.replace(from, to) : src;
      const realSetInterval = global.setInterval;
      global.setInterval = () => 0;
      try {
        return new Function('window', 'document', 'location', 'navigator', code
          + '\n;return {KO, mount, updateKickBar, kickSeekTo, kickBackToLive};')(
          global, mountDoc, global.location, global.navigator,
        );
      } finally {
        global.setInterval = realSetInterval;
      }
    };
    const rows = (ev, from) => swCalls.slice(from)
      .filter((m) => m && m.__koDiag && m.__koDiag.ev === ev)
      .map((m) => m.__koDiag.data);
    const install = (M, over) => {
      const realSetInterval = global.setInterval;
      global.setInterval = () => 0; // mount() starts the rect loop
      try {
        M.mount();
      } finally {
        global.setInterval = realSetInterval;
      }
      const posts = [];
      const K = M.KO;
      K.player = 'kick';
      K.enabled = true;
      K.kickSlug = 's-channel';
      K.activeUrl = 'https://ivs.example/live-s';
      K.kickDvrUrl = 'https://dvr.example/s';
      K.kickDur = over.dur || 0;
      K.kickOnDvr = !!over.onDvr;
      K.kickState = {
        state: over.state || 'Playing', pos: over.pos || 0, lat: over.lat || 0,
        dur: over.stDur || 0, win: over.win || 0, ts: Date.now(),
      };
      K.kickFrame = { dataset: { koToken: 's' } };
      K._testFrame = K.kickFrame;
      K.kickWin = { postMessage: (m) => posts.push(m) };
      K.wrap.style.display = 'block';
      M.updateKickBar();
      // updateKickBar derives KO.kickDur from st.dur; pin the intended bar
      // duration AFTER it so a stale-duration fixture stays stale.
      K.kickDur = over.dur || 0;
      return { K, posts, sb: K.wrap.querySelector('#ko-seekbar'), chip: K.wrap.querySelector('#ko-golive') };
    };
    const drag = (sb, seconds, dur) => {
      // mountDoc's stub rect is {left:10, width:400}; bar geometry is unchanged.
      const x = 10 + (seconds / dur) * 400;
      sb._ev.pointerdown({ clientX: x, buttons: 1, pointerId: 1, preventDefault() {} });
      sb._ev.pointerup({ clientX: x, buttons: 0, pointerId: 1 });
    };
    const sent = (posts, t) => posts.filter((m) => m && m.__koKick && m.__koKick.t === t);
    const liveFetch = () => {
      const calls = [];
      const real = global.fetch;
      global.fetch = (url) => {
        calls.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ livestream: { playback_url: 'https://ivs.example/fresh-s', id: 's' } }),
        });
      };
      return { calls, restore: () => { global.fetch = real; } };
    };
    // Other module instances installed earlier in this file keep their own
    // poll timers; count only THIS channel's mint attempts.
    const mints = (net) => net.calls.filter((u) => u.includes('/s-channel'));
    const relay = (K, st) => {
      // Other installed instances share the timer loop and may tear this
      // instance's stub frame down between awaits; re-arm the same stub.
      if (!K.kickFrame) {
        K.kickFrame = K._testFrame;
        K.kickWin = K.kickFrame.contentWindow;
      }
      msgListeners.forEach((l) => l({
        source: K.kickFrame.contentWindow,
        origin: new URL(chromeStub.runtime.getURL('player.html')).origin,
        data: { __koKick: { t: 'st', st, _koToken: 's' } },
      }));
    };

    // S1: a drag 30 s behind the edge starts the replay; no mint / seekToLive.
    {
      const M = mkSeek();
      const { K, posts, sb } = install(M, { dur: 3000, pos: 2998, lat: 2, stDur: 2998 });
      const net = liveFetch();
      const r0 = swCalls.length;
      drag(sb, 2968, 3000); // exactly 30 s behind edge=2998
      net.restore();
      const loads = sent(posts, 'load');
      assert.strictEqual(loads.length, 1, `S1: a 30 s bar rewind loads the replay once (got ${JSON.stringify(posts)})`);
      assert.strictEqual(loads[0].__koKick.url, K.kickDvrUrl, 'S1: the rewind targets the replay');
      assert.strictEqual(sent(posts, 'seekToLive').length, 0, 'S1: a deep drag never goes live');
      assert.strictEqual(mints(net).length, 0, `S1: no live mint (got ${JSON.stringify(net.calls)})`);
      assert.strictEqual(K.activeUrl, K.kickDvrUrl, 'S1: the single source writer records the replay it just loaded');
      const decision = rows('seek-decision', r0);
      assert.strictEqual(decision.length, 1, 'S1: exactly one decision row from kickSeekTo');
      const d1 = decision[0];
      assert.ok(d1 && d1.why === 'dvr' && d1.edge === 2998 && Math.abs(d1.t - 2968) < 1
        && d1.lat === 2 && d1.onDvr === false, `S1: row carries its inputs (got ${JSON.stringify(d1)})`);
      // RED: restore the old 30 s go-live threshold and its kickBackToLive
      // body. 31 covers the float rounding of the bar's 2968/3000 fraction.
      const red = mkSeek(
        "  if (d.edge - d.t <= KICK_EDGE_GO_LIVE_SEC) {\n    // A release at the edge lands there and keeps playing. No mint, no reload:\n    // the live element can hold this position, and a source switch here is the\n    // fight the owner reported over his own seekbar.\n    kickSend({ t: 'seek', s: d.t });\n",
        "  if (d.edge - d.t <= 31) {\n    kickBackToLive();\n    return;\n    kickSend({ t: 'seek', s: d.t });\n",
      );
      const rFix = install(red, { dur: 3000, pos: 2998, lat: 2, stDur: 2998 });
      drag(rFix.sb, 2968, 3000);
      await settle(40);
      assert.strictEqual(sent(rFix.posts, 'seekToLive').length, 1, 'S1 RED: the old 30 s threshold goes live instead of rewinding');
      assert.strictEqual(sent(rFix.posts, 'load').length, 0, 'S1 RED: the replay is never loaded under the old threshold');
      console.log('S1 drag-deep: a 30 s bar rewind loads the replay, never go-live (RED: old threshold goes live) - OK');
    }

    // S2: a drag into the last second seeks in place; no mint and no reload.
    {
      const M = mkSeek();
      const { K, posts, sb } = install(M, { dur: 3000, pos: 2999, lat: 2, stDur: 2998 });
      const net = liveFetch();
      const r0 = swCalls.length;
      drag(sb, 2997.5, 3000);
      net.restore();
      const seeks = sent(posts, 'seek');
      assert.strictEqual(seeks.length, 1, `S2: last-second drag sends one in-place seek (got ${JSON.stringify(posts)})`);
      assert.ok(Math.abs(seeks[0].__koKick.s - 2997.5) < 1, 'S2: the seek keeps the dragged time');
      assert.strictEqual(sent(posts, 'load').length, 0, 'S2: no replay reload at the edge');
      assert.strictEqual(sent(posts, 'seekToLive').length, 0, 'S2: no go-live command at the edge');
      assert.strictEqual(mints(net).length, 0, 'S2: no mint at the edge');
      assert.strictEqual(K.activeUrl, 'https://ivs.example/live-s', 'S2: the live url is untouched');
      const liveRows = rows('live_seek', r0);
      assert.strictEqual(liveRows.length, 1, 'S2: exactly one live_seek row');
      assert.strictEqual(liveRows[0].why, 'drag-edge', `S2: the row names the drag edge (got ${JSON.stringify(liveRows[0])})`);
      // RED: restore the pre-fix branch body (kickBackToLive at the edge).
      const red = mkSeek(
        "    kickSend({ t: 'seek', s: d.t });\n    kickSeekRow('live_seek', d, intent === 'drag' ? 'drag-edge' : 'edge');\n",
        '    kickBackToLive();\n    return;\n',
      );
      const rFix = install(red, { dur: 3000, pos: 2999, lat: 2, stDur: 2998 });
      drag(rFix.sb, 2997.5, 3000);
      await settle(40);
      assert.strictEqual(sent(rFix.posts, 'seekToLive').length, 1, 'S2 RED: the pre-fix branch goes live instead of seeking');
      assert.strictEqual(sent(rFix.posts, 'seek').length, 0, 'S2 RED: no in-place seek under the pre-fix branch');
      console.log('S2 drag-edge: last-second drag seeks in place with no mint (RED: pre-fix branch goes live) - OK');
    }

    // S3: the first replay Ended at the user's offset re-loads the replay;
    // only a bounded number of failures inside 15 s may re-load it.
    {
      const M = mkSeek();
      const { K, posts } = install(M, { dur: 4000, pos: 1000, lat: 0, stDur: 4000, onDvr: true, state: 'Ended' });
      K.kickDvrTarget = 1000;
      K.kickDvrLoadedAt = Date.now();
      K.kickDvrClamped = false;
      const net = liveFetch();
      const r0 = swCalls.length;
      const p0 = posts.length;
      relay(K, { state: 'Ended', pos: 1000, lat: 0, dur: 4000 });
      const loads = sent(posts.slice(p0), 'load');
      assert.strictEqual(loads.length, 1, `S3: one Ended re-loads the replay once (got ${JSON.stringify(posts.slice(p0))})`);
      assert.strictEqual(loads[0].__koKick.url, K.kickDvrUrl, 'S3: the first rescue stays on the replay');
      assert.strictEqual(loads[0].__koKick.seekTo, 1000, 'S3: the user offset survives the rescue');
      assert.strictEqual(mints(net).length, 0, 'S3: no mint on the first failure');
      const rescue = rows('dvr-ended-rescue', r0);
      assert.strictEqual(rescue.length, 1, 'S3: exactly one rescue row for the first failure');
      assert.strictEqual(rescue[0].wentLive, false, 'S3: the row says the user stayed on the replay');
      assert.strictEqual(rescue[0].target, 1000, 'S3: the row names the offset');
      assert.strictEqual(rescue[0].dur, 4000, 'S3: the row names the published duration');
      // A second failure inside the window re-loads once more at the offset;
      // neither it nor the third failure may become an implicit live mint.
      const p1 = posts.length;
      relay(K, { state: 'Ended', pos: 1000, lat: 0, dur: 4000 });
      await settle(40);
      assert.strictEqual(mints(net).length, 0, 'S3: a second failure inside 15 s never mints');
      const again = sent(posts.slice(p1), 'load');
      assert.strictEqual(again.length, 1, 'S3: the second failure re-loads the replay once');
      assert.strictEqual(again[0].__koKick.seekTo, 1000, 'S3: the second rescue keeps the user offset');
      const p2 = posts.length;
      // Stale poll timers from earlier installed modules may have torn this
      // fixture down while awaiting; restore the exact rescue state under test.
      K.kickOnDvr = true;
      K.kickDvrRescues = 2;
      K.kickDvrLoadedAt = Date.now();
      K.kickDvrTarget = 1000;
      K.kickDvrDur = 4000;
      K.kickDvrDurAt = Date.now();
      relay(K, { state: 'Ended', pos: 1000, lat: 0, dur: 4000 });
      await settle(40);
      assert.strictEqual(sent(posts.slice(p2), 'load').length, 0, 'S3: the third failure does not reload');
      assert.strictEqual(mints(net).length, 0, 'S3: a third failure never mints either');
      const refused = rows('dvr-ended-rescue').filter((r) => r.refused === 'rescue-budget');
      assert.ok(refused.length === 1 && refused[0].rescues === 2 && refused[0].budget === 0
        && refused[0].rescueMs === 15000 && refused[0].clock === 'replay-published-clock',
      `S3: the refusal row prints the numbers that refused it (got ${JSON.stringify(refused)})`);
      net.restore();
      // RED: restore the pre-fix Ended handler (every Ended -> kickBackToLive).
      const red = mkSeek(
        "      kickDvrRescue('ended', m.st.dur);",
        '      kickBackToLive(); // RED: pre-fix — every Ended goes live',
      );
      const rFix = install(red, { dur: 4000, pos: 1000, lat: 0, stDur: 4000, onDvr: true, state: 'Ended' });
      rFix.K.kickDvrTarget = 1000;
      rFix.K.kickDvrLoadedAt = Date.now();
      const redNet = liveFetch();
      relay(rFix.K, { state: 'Ended', pos: 1000, lat: 0, dur: 4000 });
      await settle(40);
      redNet.restore();
      assert.ok(mints(redNet).length > 0, 'S3 RED: the pre-fix Ended handler mints on the first failure');
      assert.strictEqual(sent(rFix.posts, 'load').filter((m) => m.__koKick.url === rFix.K.kickDvrUrl).length, 0, 'S3 RED: no replay re-load under the pre-fix handler');
      console.log('S3 dvr-ended: first failure re-loads the replay at the user offset (RED: pre-fix goes live) - OK');
    }

    // S5: an Ended/error before ANY duration is published still carries the
    // user's replay intent. Rescue at the target with no clamp (there is no
    // edge to clamp against), spend the same bounded budget, and refuse with
    // a row rather than mint.
    {
      const M = mkSeek();
      const { K, posts } = install(M, { dur: 0, pos: 1000, lat: 0, stDur: 0, onDvr: true, state: 'Ended' });
      K.kickDvrTarget = 1234;
      K.kickDvrLoadedAt = Date.now();
      K.kickDvrClamped = false;
      const net = liveFetch();
      const r0 = swCalls.length;
      const p0 = posts.length;
      relay(K, { state: 'Ended', pos: 1000, lat: 0, dur: 0 });
      const loads = sent(posts.slice(p0), 'load');
      assert.strictEqual(loads.length, 1, `S5: an Ended with no duration re-loads the replay once (got ${JSON.stringify(posts.slice(p0))})`);
      assert.strictEqual(loads[0].__koKick.url, K.kickDvrUrl, 'S5: the no-duration rescue stays on the replay');
      assert.strictEqual(loads[0].__koKick.seekTo, 1234, 'S5: the target is honoured verbatim, with no clamp against an unknown edge');
      assert.strictEqual(mints(net).length, 0, 'S5: no mint on the first failure with unknown duration');
      const rescue = rows('dvr-ended-rescue', r0).filter((r) => r.want === 1234 && r.dur === 0);
      assert.strictEqual(rescue[0].wentLive, false, 'S5: the row says the user stayed on the replay');
      assert.strictEqual(rescue[0].dur, 0, 'S5: the row names the unknown duration as 0');
      assert.strictEqual(rescue[0].target, 1234, 'S5: the row names the unclamped offset');
      // The budget is honest: the third failure is refused with a row, not minted.
      const p1 = posts.length;
      relay(K, { state: 'Ended', pos: 1000, lat: 0, dur: 0 });
      await settle(40);
      assert.strictEqual(mints(net).length, 0, 'S5: a second failure inside 15 s never mints');
      assert.strictEqual(sent(posts.slice(p1), 'load').filter((m) => m.__koKick.url === K.kickDvrUrl).length, 1,
        'S5: the second failure re-loads the replay at the user offset');
      K.kickOnDvr = true;
      K.kickDvrRescues = 2;
      K.kickDvrLoadedAt = Date.now();
      K.kickDvrTarget = 1234;
      K.kickDvrDur = 0;
      const p2 = posts.length;
      relay(K, { state: 'Ended', pos: 1000, lat: 0, dur: 0 });
      await settle(40);
      assert.strictEqual(mints(net).length, 0, 'S5: a third failure never mints');
      assert.strictEqual(sent(posts.slice(p2), 'load').length, 0, 'S5: a third failure does not reload');
      assert.ok(rows('dvr-ended-rescue').some((r) => r.refused === 'rescue-budget' && r.target === 1234 && r.dur === 0),
        `S5: the refusal row names the user's offset and the unknown duration (got ${JSON.stringify(rows('dvr-ended-rescue'))})`);
      net.restore();
      // RED: restore the pre-fix predicate. With dur === 0 it is false, so
      // the first failure mints instead of rescuing the replay.
      const red = mkSeek(
        '  const inside = unknownDur || (dur > 12 && target > 0 && target < dur);',
        '  const inside = dur > 12 && target > 0 && target < dur; // RED: unknown duration mints',
      );
      const rFix = install(red, { dur: 0, pos: 1000, lat: 0, stDur: 0, onDvr: true, state: 'Ended' });
      rFix.K.kickDvrTarget = 1234;
      rFix.K.kickDvrLoadedAt = Date.now();
      rFix.K.kickDvrClamped = false;
      const redNet = liveFetch();
      relay(rFix.K, { state: 'Ended', pos: 1000, lat: 0, dur: 0 });
      await settle(40);
      redNet.restore();
      assert.ok(redNet.calls.length > 0, 'S5 RED: the pre-fix predicate mints on the first unknown-duration failure');
      assert.strictEqual(sent(rFix.posts, 'load').filter((m) => m.__koKick.url === rFix.K.kickDvrUrl).length, 0, 'S5 RED: no replay re-load under the pre-fix predicate');
      console.log('S5 dvr-ended-no-duration: unknown duration re-loads the replay unclamped (RED: pre-fix mints) - OK');
    }

    // S4: the explicit chip still mints and names itself in the diag row.
    {
      const M = mkSeek();
      const { K, posts, chip } = install(M, { dur: 4000, pos: 1000, lat: 10, stDur: 4000, onDvr: true });
      assert.ok(chip && typeof chip._ev.click === 'function', 'S4: mount ships a clickable #ko-golive');
      const net = liveFetch();
      const r0 = swCalls.length;
      chip._ev.click();
      await settle(40);
      net.restore();
      const loads = sent(posts, 'load');
      assert.strictEqual(loads.length, 1, 'S4: the chip mints exactly one live load');
      assert.strictEqual(loads[0].__koKick.url, 'https://ivs.example/fresh-s', 'S4: the chip targets the fresh mint');
      assert.strictEqual(K.kickOnDvr, false, 'S4: the chip leaves the replay');
      const gl = rows('go-live', r0);
      assert.strictEqual(gl.length, 1, 'S4: exactly one go-live row');
      assert.strictEqual(gl[0].why, 'chip', 'S4: the row names the chip as the intent');
      assert.ok(['target', 't', 'edge', 'max', 'lat', 'dur', 'onDvr', 'win', 'why']
        .every((key) => Object.prototype.hasOwnProperty.call(gl[0], key)), `S4: the row carries every decision field (got ${JSON.stringify(gl[0])})`);
      // RED: a chip that no longer calls the explicit go-live path cannot mint.
      const red = mkSeek("    else kickBackToLive('chip');", '    else kickSeekTo(KO.kickDur);');
      const rFix = install(red, { dur: 4000, pos: 1000, lat: 10, stDur: 4000, onDvr: true });
      const redNet = liveFetch();
      rFix.chip._ev.click();
      await settle(40);
      // Scope the RED check to THIS module's bridge posts: a late apply() from
      // an earlier arm may still be minting on the global fetch stub.
      assert.strictEqual(sent(rFix.posts, 'load').filter((m) => m.__koKick.url === 'https://ivs.example/fresh-s').length, 0, 'S4 RED: without the explicit call the chip cannot mint');
      assert.strictEqual(sent(rFix.posts, 'seekToLive').length, 0, 'S4 RED: no live command without the explicit call');
      assert.strictEqual(sent(rFix.posts, 'load').length, 0, 'S4 RED: no live load without the explicit call');
      console.log('S4 chip-live: the explicit chip mints and names itself (RED: no explicit call, no mint) - OK');
    }
  }

  // U2: a partial `ko.v2` write that omits `enabled` (tool / older build)
  // must not silently disable the overlay for the rest of the page — that
  // also makes the native-stall watchdog report idle on a frozen picture.
  // An explicit false from the popup still applies.
  {
    const mkStorage = (from, to) => {
      if (from) assert.ok(src.includes(from), `U2 RED: mutation target missing: ${from.slice(0, 70)}`);
      const code = from ? src.replace(from, to) : src;
      let listener = null;
      const realAdd = chromeStub.storage.onChanged.addListener;
      chromeStub.storage.onChanged.addListener = (l) => { listener = l; };
      const realSetInterval = global.setInterval;
      global.setInterval = () => 0;
      try {
        const M = new Function('window', 'document', 'location', 'navigator', code
          + '\n;return {KO};')(global, mountDoc, global.location, global.navigator);
        assert.ok(listener, 'U2: the module under test registers the storage listener');
        return {
          KO: M.KO,
          fire: (newValue, oldValue) => listener({ 'ko.v2': { newValue, oldValue } }, 'local'),
        };
      } finally {
        chromeStub.storage.onChanged.addListener = realAdd;
        global.setInterval = realSetInterval;
      }
    };
    const M = mkStorage();
    M.KO.enabled = true;
    M.fire({ player: 'kick', mappings: {} }, { enabled: true, player: 'kick', mappings: {} });
    assert.strictEqual(M.KO.enabled, true, 'U2: a write without `enabled` keeps the overlay on');
    M.fire({ enabled: false, player: 'kick', mappings: {} }, { enabled: true, player: 'kick', mappings: {} });
    assert.strictEqual(M.KO.enabled, false, 'U2: an explicit false still disables the overlay');
    // RED: restore `KO.enabled = !!s.enabled`; the same partial write flips off.
    const red = mkStorage(
      '  KO.enabled = s.enabled === undefined ? KO.enabled : !!s.enabled;',
      '  KO.enabled = !!s.enabled; // RED: a partial write disables',
    );
    red.KO.enabled = true;
    red.fire({ player: 'kick', mappings: {} }, { enabled: true, player: 'kick', mappings: {} });
    assert.strictEqual(red.KO.enabled, false, 'U2 RED: restoring `!!s.enabled` disables on a partial write');
    console.log('U2 storage partial-enable: omitted enabled keeps the current value (RED: pre-fix disables) - OK');
  }

  // ---- Numbered source-truth arms (items 2,3,5,6,7,8,9,10,11,12) ---------
  // Items 1 and 4 are owned by bridge-handshake-test.cjs. Every arm here
  // executes the REAL content.js and includes a RED mutation that restores
  // the pre-fix line; the mutant must reproduce the reported defect.
  const mkArm = (from, to) => {
    if (from) assert.ok(src.includes(from), `FIX RED: mutation target missing: ${from.slice(0, 60)}`);
    const code = from ? src.replace(from, to) : src;
    const realSetInterval = global.setInterval;
    global.setInterval = () => 0;
    try {
      const M = new Function('window', 'document', 'location', 'navigator', code
        + '\n;return { KO, mount, kickSeekTo, kickSeekInputs, kickStartDvr, kickLoadReplayAt,'
        + ' kickGoLive, kickSetSource, ensureKick, showKickLayer, kickDvrRescue,'
        + ' rectTick, probeKickLayer, updateKickBar };')(
        global, mountDoc, global.location, global.navigator,
      );
      M.mount();
      const K = M.KO;
      const posts = [];
      K.player = 'kick'; K.enabled = true; K.kickSlug = 's-channel';
      K.kickReady = true;
      K.kickFrame = { dataset: { koToken: 'fix' }, remove() {} };
      K.kickWin = { postMessage: (m) => posts.push(m && m.__koKick) };
      return { M, K, posts, rows: (ev) => swCalls.filter((m) => m && m.__koDiag && m.__koDiag.ev === ev).map((m) => m.__koDiag.data) };
    } finally {
      global.setInterval = realSetInterval;
    }
  };

  // 2. A drag inside a replay writes the target a later failure reloads.
  {
    const setup = (A) => {
      const K = A.K;
      K.kickOnDvr = true; K.kickDvrUrl = 'https://dvr.example/fix';
      K.kickDvrDur = 600; K.kickDvrDurAt = Date.now();
      K.kickState = { state: 'Playing', pos: 300, lat: 0, dur: 600 };
    };
    const A = mkArm(); setup(A);
    A.M.kickStartDvr(200, 'replay-published-clock');
    assert.strictEqual(A.K.kickDvrTarget, 200, 'item 2: the drag target is recorded for the next failure');
    assert.strictEqual(A.posts.filter((m) => m && m.t === 'seek' && m.s === 200).length, 1, 'item 2: the in-place seek is sent');
    const red = mkArm('    KO.kickDvrTarget = at;\n', '    // RED: pre-drag target never recorded\n');
    setup(red); red.M.kickStartDvr(200, 'replay-published-clock');
    assert.strictEqual(red.K.kickDvrTarget, 0, 'RED item 2: without the writer the failure reloads the pre-drag position');
    console.log('item 2 dvr target: a replay drag owns the later reload offset - OK');
  }

  // 3. A re-show never pulls a user-owned playhead to the edge.
  {
    const setup = (A) => {
      A.K.wrap.style.display = 'none';
      A.K.kickOnDvr = false;
      A.K.kickState = { state: 'Playing', pos: 100, lat: 2, dur: 1000 };
      A.K.kickUserSeekAt = Date.now();
    };
    const A = mkArm(); setup(A);
    assert.strictEqual(A.M.showKickLayer(), false, 'item 3: the re-show refuses to seek after a user seek');
    assert.strictEqual(A.posts.filter((m) => m && m.t === 'seekToLive').length, 0, 'item 3: no edge command on re-show');
    const refused = A.rows('kick-reshow-refused');
    assert.ok(refused.some((r) => r.why === 'user-seek' && r.userSeekAgeMs >= 0 && r.target >= 0), `item 3: the refusal row prints numbers (got ${JSON.stringify(refused)})`);
    const red = mkArm('    if (wasHidden && !KO.kickOnDvr && !userOwns) {', '    if (wasHidden && !KO.kickOnDvr) {');
    setup(red); red.M.showKickLayer();
    assert.strictEqual(red.posts.filter((m) => m && m.t === 'seekToLive').length, 1, 'RED item 3: the pre-fix re-show drags a user seek to the edge');
    console.log('item 3 re-show: a user seek survives every re-show - OK');
  }

  // 5/6. A subtraction may only use clocks of the same origin; refusal prints them.
  {
    const setup = (A) => {
      const K = A.K;
      K.kickDur = 3600; K.kickDurClock = 'broadcast-wall-clock'; // bar max, wall-clock origin
      K.kickStreamStart = Date.now() - 3600000;
      K.kickState = { state: 'Playing', pos: 100, lat: 2, dur: 100 }; // session clock
    };
    const A = mkArm(); setup(A);
    const d = A.M.kickSeekInputs(3000);
    assert.strictEqual(d.usable, false, 'item 5: a wall-clock max minus an element latency is refused');
    assert.strictEqual(d.clock, 'broadcast-wall-clock', 'item 5: the row names the rejected clock');
    assert.strictEqual(d.posClock, 'element-session-clock', 'item 6: the row names the other clock origin');
    const r0 = swCalls.length;
    A.M.kickSeekTo(3000, 'drag');
    const ref = swCalls.slice(r0).filter((m) => m && m.__koDiag && m.__koDiag.ev === 'seek-refused').map((m) => m.__koDiag.data);
    assert.ok(ref.length === 1 && ref[0].barMax === 3600 && ref[0].sessionEdge === 102 && ref[0].barClock === 'broadcast-wall-clock'
      && ref[0].sessionClock === 'element-session-clock', `item 6: the refusal prints both origins and the numbers (got ${JSON.stringify(ref)})`);
    const red = mkArm("  if (clock === 'element-session-clock' && !KO.kickOnDvr) {", "  if (clock !== 'replay-published-clock') {");
    setup(red);
    assert.strictEqual(red.M.kickSeekInputs(3000).usable, true, 'RED item 5/6: the pre-fix branch mixes the two clocks');
    console.log('item 5/6 clocks: mixed-origin subtraction refused with numbers - OK');
  }

  // 7. A forced reload has ONE writer for all source fields.
  {
    const setup = (A) => {
      const K = A.K;
      K.activeUrl = 'https://dvr.example/fix'; K.kickDvrUrl = K.activeUrl;
      K.kickOnDvr = true; K.kickDvrTarget = 333; K.kickDvrDur = 900;
      K.kickDvrDurAt = Date.now(); K.kickDvrLoadedAt = 0;
    };
    const A = mkArm(); setup(A);
    A.M.ensureKick(A.K.activeUrl, { force: true });
    assert.ok(A.K.kickDvrLoadedAt > 0, 'item 7: the force path stamps the source through the single writer');
    assert.strictEqual(A.K.kickDvrTarget, 333, 'item 7: the user offset survives the force');
    assert.strictEqual(A.K.kickDvrDur, 900, 'item 7: the replay clock survives the force');
    const red = mkArm('  kickSetSource(url, {\n    onDvr,\n    target: onDvr ? (seekTo || KO.kickDvrTarget) : 0,\n    dvrDur: KO.kickDvrDur,\n    dvrDurAt: KO.kickDvrDurAt,\n    clearUserSeek: !force, // a channel switch is a new source, not the user\'s seek\n  });',
      '  KO.kickUrlT = Date.now(); // RED: a second writer stamps only the url');
    setup(red); red.M.ensureKick(red.K.activeUrl, { force: true });
    assert.strictEqual(red.K.kickDvrLoadedAt, 0, 'RED item 7: the old stamp leaves DVR state contradictory');
    console.log('item 7 force: one writer owns url, clock and DVR state - OK');
  }

  // 8. Loading a replay records the loaded source in activeUrl.
  {
    const setup = (A) => {
      A.K.activeUrl = 'https://ivs.example/live-fix';
      A.K.kickDvrUrl = 'https://dvr.example/fix';
      A.K.kickDvrDur = 600; A.K.kickDvrDurAt = Date.now();
    };
    const A = mkArm(); setup(A);
    A.M.kickLoadReplayAt(400);
    assert.strictEqual(A.K.activeUrl, A.K.kickDvrUrl, 'item 8: the replay becomes the active source');
    const red = mkArm('  kickSetSource(KO.kickDvrUrl, {', '  if (false) kickSetSource(KO.kickDvrUrl, {');
    setup(red); red.M.kickLoadReplayAt(400);
    assert.strictEqual(red.K.activeUrl, 'https://ivs.example/live-fix', 'RED item 8: without the writer a live url still claims a replay');
    console.log('item 8 replay load: activeUrl follows the source that was loaded - OK');
  }

  // 9. Going live clears the replay's clock fields in the same write.
  {
    const setup = (A) => {
      const K = A.K;
      K.activeUrl = 'https://dvr.example/fix'; K.kickOnDvr = true;
      K.kickDvrDur = 900; K.kickDvrDurAt = Date.now();
      K.kickDvrLoadedAt = Date.now(); K.kickDvrTarget = 333;
    };
    const net = () => {
      const calls = [];
      const real = global.fetch;
      global.fetch = (u) => { calls.push(u); return Promise.resolve({ ok: true, json: () => Promise.resolve({ livestream: { playback_url: 'https://ivs.example/fresh-fix', id: 'f' } }) }); };
      return { calls, restore: () => { global.fetch = real; } };
    };
    const A = mkArm(); setup(A);
    const f = net(); await A.M.kickGoLive('chip'); f.restore();
    assert.strictEqual(A.K.activeUrl, 'https://ivs.example/fresh-fix', 'item 9: the fresh mint is the active source');
    assert.strictEqual(A.K.kickOnDvr, false, 'item 9: the replay flags are cleared');
    assert.strictEqual(A.K.kickDvrDur + A.K.kickDvrDurAt + A.K.kickDvrLoadedAt + A.K.kickDvrTarget, 0, 'item 9: no replay clock survives the live url');
    const red = mkArm('    kickSetSource(k.url, { onDvr: false }); // clears DVR dur/loaded/target with the url',
      '    KO.activeUrl = k.url; KO.kickUrlT = Date.now(); // RED: second writer leaves replay state');
    setup(red); const rf = net(); await red.M.kickGoLive('chip'); rf.restore();
    assert.ok(red.K.kickDvrTarget > 0 && red.K.kickDvrDur > 0, 'RED item 9: the old stamp keeps replay state on a live url');
    console.log('item 9 go-live: mint clears replay state in one write - OK');
  }

  // 10. The frame-death watchdog honours the same 25 s loading grace.
  {
    const setup = (A) => {
      const K = A.K;
      K.activeUrl = 'https://dvr.example/fix'; K.kickOnDvr = true;
      K.kickDvrTarget = 222; K.kickUrlT = Date.now() - 1000;
      K.lastKickSt = Date.now() - 40000;
      K.kickState = { state: 'Playing', pos: 100, lat: 1, dur: 600 };
      K.wrap.style.display = 'block';
      mountDoc.hidden = false;
    };
    const A = mkArm(); setup(A);
    A.M.rectTick();
    assert.ok(A.K.kickFrame, 'item 10: a fresh load is not rebuilt');
    assert.strictEqual(A.K.kickDvrTarget, 222, 'item 10: the user offset is untouched');
    assert.ok(A.rows('kick-frame-rebuild').some((r) => r.why === 'loading-grace' && r.rebuilt === false && r.graceMs === 25000),
      'item 10: the refusal row prints the grace that protected the load');
    const red = mkArm('        if (sourceFresh) {', '        if (false) { // RED: grace ignored');
    setup(red); red.M.rectTick();
    assert.ok(red.rows('kick-frame-rebuild').some((r) => r.why === 'silent' && r.rebuilt === true), 'RED item 10: the old watchdog rebuilds mid-load');
    console.log('item 10 frame watchdog: fresh load keeps its source and offset - OK');
  }

  // 11. The never-played watchdog uses ONE 25 s window, not a second 15 s one.
  {
    const setup = (A) => {
      const K = A.K;
      K.activeUrl = 'https://ivs.example/fix'; K.kickEverPlayed = false;
      K.kickState = { state: 'Idle', ct: 0 }; K.kickUrlT = Date.now() - 20000;
    };
    const A = mkArm(); setup(A);
    await A.M.probeKickLayer();
    assert.ok(A.K.kickUrlT > 0, 'item 11: a 20 s load is still inside the single grace');
    assert.strictEqual(A.rows('kick_stall').length, 0, 'item 11: no premature teardown row');
    const red = mkArm('    loadAgeMs > KICK_GRACE_MS', '    loadAgeMs > 15000 // RED: second loading window');
    setup(red); await red.M.probeKickLayer();
    assert.strictEqual(red.K.activeUrl, null, 'RED item 11: the 15 s watchdog tears the layer down');
    console.log('item 11 load grace: one 25 s window, no second watchdog - OK');
  }

  // 12. A refused rescue prints its numbers; it never mints a live url.
  {
    const setup = (A) => {
      const K = A.K;
      K.kickOnDvr = true; K.kickDvrUrl = 'https://dvr.example/fix';
      K.kickDvrTarget = 400; K.kickDvrDur = 1000; K.kickDvrDurAt = Date.now();
      K.kickDvrLoadedAt = Date.now(); K.kickDvrRescues = 2;
      K.kickState = { state: 'Ended', pos: 400, lat: 0, dur: 1000 };
    };
    const net = () => {
      const calls = [];
      const real = global.fetch;
      global.fetch = (u) => { calls.push(u); return Promise.resolve({ ok: true, json: () => Promise.resolve({ livestream: { playback_url: 'https://ivs.example/fresh-fix', id: 'f' } }) }); };
      return { calls, restore: () => { global.fetch = real; } };
    };
    const A = mkArm(); setup(A);
    const f = net(); A.M.kickDvrRescue('ended', 1000); await settle(30); f.restore();
    assert.strictEqual(A.posts.filter((m) => m && m.t === 'load').length, 0, 'item 12: a spent rescue does not reload');
    const ref = A.rows('dvr-ended-rescue').filter((r) => r.want === 400 && r.refused === 'rescue-budget');
    assert.ok(ref.length === 1 && ref[0].rescues === 2 && ref[0].budget === 0 && ref[0].rescueMs === 15000 && ref[0].clock === 'replay-published-clock',
      `item 12: the refusal prints the numbers that refused it (got ${JSON.stringify(ref)})`);
    const red = mkArm("  diag('dvr-ended-rescue', {\n    why, want:", "  kickBackToLive(); // RED: every refusal mints\n  diag('dvr-ended-rescue', {\n    why, want:");
    setup(red); const rf = net(); red.M.kickDvrRescue('ended', 1000); await settle(30); rf.restore();
    assert.ok(rf.calls.length > 0, 'RED item 12: the pre-fix refusal mints a live url');
    console.log('item 12 rescue: budget refusal prints numbers, never an implicit mint - OK');
  }

  // ANTI-VACUITY. Every arm above prints one "<label> - OK" line, and a suite
  // whose arms silently stopped running still exits 0 today (that is how a
  // regression gets a green receipt). The expected labels are listed HERE, in
  // the same file, so an arm deleted or skipped without its label is a FAILURE
  // rather than a quieter green. Appending an arm means appending its label.
  const ARMS = [
    'P1b2', 'P2e', 'P2f', 'P2g', 'P2h', 'P2i', 'P2k', 'P2n', 'P2o', 'P2p', 'P2q', 'P3', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6',
    'U mute', 'V quality', 'X per-player', 'X2 manual sw', 'X3 stale liv', 'Z hover', 'D1', 'N1', 'N2', 'O1 owner death',
    'A3a arrow hold', 'A3b arrow burst', 'A3c arrow handoff', 'A3d arrow refusals', 'A3e arrow mirror',
    'A3f arrow coalesced report', 'A3g arrow delivery',
    'S1 drag-deep', 'S2 drag-edge', 'S3 dvr-ended', 'S4 chip-live', 'S5 dvr-ended-no-duration', 'U2 storage partial-enable',
    'N3 ad park', 'N3d hidden pause',
    'item 2 dvr target', 'item 3 re-show', 'item 5/6 clocks', 'item 7 force', 'item 8 replay load',
    'item 9 go-live', 'item 10 frame watchdog', 'item 11 load grace', 'item 12 rescue',
  ];
  const printed = armLog.map((l) => String(l).trim());
  const missing = ARMS.filter((a) => !printed.some((l) => l.startsWith(a)));
  assert.deepStrictEqual(missing, [], `arms that never printed their OK line: ${missing.join(', ')}`);
  console.log(`ARMS ${ARMS.length}/${ARMS.length} present`);
  console.log('\nALL CONTENT.JS FIX CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });

// A pending await whose only resolver was a virtual timer leaves NODE with an
// empty event loop: the process exits 0 having printed half the arms, which is
// the silent-green class this suite exists to refuse. Name it.
process.on('beforeExit', (code) => {
  if (code !== 0) return;
  const last = armLog.filter((l) => / OK$/.test(String(l).trim())).pop() || '(none)';
  console.error(`HARNESS FAIL: the run ended before ALL CONTENT.JS FIX CHECKS PASSED (last arm: ${String(last).trim()}); an await never settled.`);
  process.exitCode = 1;
});
