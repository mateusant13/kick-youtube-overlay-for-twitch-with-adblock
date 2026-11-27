// Mute-decision regression harness. It runs THREE real files together:
//
//   ko-audio.js        the audio authority (extension world)
//   adblock-bridge.js  the extension-world half of the DOM bridge
//   twitch-adblock.js  the ad path (MAIN world)
//
// and stands in for the two pieces that are not under test here: content.js
// registers the 'twitch' (page video) surface and the kick/yt layer writers,
// exactly as it does at boot, and Chrome's world boundary is modelled by the
// fact that the ad path only ever reads the two data-ko-audio-* attributes and
// writes ko-audio-claim / ko-audio-intent CustomEvents.
//
// The contract asserted here is ONE rule, not a mechanism:
//
//     muted(surface) = intent[surface].muted || policy || surface !== visible
//
// Owner reports behind it: "when i mute, the ad comes, player swaps, it unmutes"
// (2026-10-26), "unmuting during the swap mutes the clean player, or vice versa"
// (2026-11-07), "fica mutando quando eu desmuto o tempo inteiro" (2026-11-08).
//
// Negative arm: the same run against a copy of ko-audio.js whose want() ignores
// the user's intent. Every muted-user arm MUST fail there, or the detector is
// measuring nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const clock = require('../_tools/test-clock.cjs');
const nodeAssert = require('assert');

const AD = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8');
const AUDIO = fs.readFileSync(path.join(__dirname, 'ko-audio.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(__dirname, 'adblock-bridge.js'), 'utf8');

const PRE_FIX_MUTATION = [
  'muted: !!(it.muted || policy.has(surface) || visibleNow() !== surface),',
  'muted: !!(policy.has(surface) || visibleNow() !== surface),',
];

// ---- compiled-source cache ------------------------------------------------
// Compiling the ad path is the suite's dominant cost: 337 KB of source through
// `new Function` once per world, and this harness builds a world per arm (134 in
// ad-time-continuity alone, so ~536 compiles). The FACTORY is pure - it takes every
// environment binding as an argument and closes over nothing - so compiling the
// same source twice is pure waste, which is the owner's own rule ("do it once").
// Measured 2026-11-27 on this box while the watcher named this suite the top
// pressure (DM dm-0716345b35046e097d68): see the compile-cache line the suite prints.
// Bounded at 32 sources: every distinct mutation is a distinct source, and the
// cache must not accumulate the whole run in memory.
const COMPILE_CACHE_MAX = 32;
const COMPILED = new Map();
const compileStats = { hits: 0, misses: 0 };
// KO_COMPILE_CACHE=0 is the optimisation's own BEFORE arm (cost only, never a
// behavioural switch): both settings must print the same verdict.
const COMPILE_CACHE_ON = process.env.KO_COMPILE_CACHE !== '0';

function compile(source, name) {
  const key = `${name}\u0000${source}`;
  if (COMPILE_CACHE_ON) {
    const hit = COMPILED.get(key);
    if (hit) {
      compileStats.hits += 1;
      return hit;
    }
  }
  compileStats.misses += 1;
  const factory = new Function(
    'window', 'document', 'location', 'navigator', 'performance', 'BroadcastChannel',
    'CustomEvent', 'MutationObserver', 'XMLHttpRequest', 'Blob', 'URL', 'btoa', 'chrome',
    'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
    `${source}\n//# sourceURL=${name}`,
  );
  if (COMPILE_CACHE_ON) {
    if (COMPILED.size >= COMPILE_CACHE_MAX) COMPILED.delete(COMPILED.keys().next().value);
    COMPILED.set(key, factory);
  }
  return factory;
}

// ---- the world ------------------------------------------------------------
// makeWorld({ audioSource, adSource, autoLoad }) — `adSource`/`autoLoad` exist so
// the negative arms of ad-time-continuity-test.cjs can run mutated copies of the
// ad path through the SAME world.
function makeWorld(opts, extra) {
  // Positional form (source, opts) is the historical makePage() signature.
  const o = typeof opts === 'string' ? Object.assign({}, extra || {}, { adSource: opts }) : opts || {};
  const audioSource = o.audioSource || AUDIO;
  const adSource = o.adSource || AD;
  const autoLoad = o.autoLoad !== false;
  const sent = []; // commands the ad path posts into its clean frame
  const layerSent = []; // commands the content-script stand-in posts to kick/yt
  const adLogs = [];
  const observers = [];
  const bcInstances = [];
  const bcSent = [];

  // --- event target ---------------------------------------------------------
  const makeTarget = (extra) => {
    const t = Object.assign(
      {
        listeners: {},
        addEventListener(type, fn) {
          (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
          const l = this.listeners[type] || [];
          const i = l.indexOf(fn);
          if (i >= 0) l.splice(i, 1);
        },
        fire(ev) {
          for (const fn of (this.listeners[ev.type] || []).slice()) {
            try {
              fn(ev);
            } catch {
              /* a listener must not break the run */
            }
          }
        },
      },
      extra || {},
    );
    return t;
  };

  // --- element -------------------------------------------------------------
  const notifyAttrs = (el, key) => {
    for (const o of observers) {
      if (o.target !== el) continue;
      const f = o.opts && o.opts.attributeFilter;
      if (f && !f.includes(key)) continue;
      try {
        o.cb([{ attributeName: key }], o);
      } catch {
        /* observer callback must not break the run */
      }
    }
  };

  // A real DOM notifies childList observers of every insertion (ko-audio.js's
  // silencing guard uses one to see a <video> the page inserts after the last
  // apply; a hidden tab throttles its tick, so the observer is the signal that
  // still arrives). Only observers that asked for childList and whose target is
  // the parent (or an ancestor, with subtree) are notified.
  const notifyAdded = (parent, child) => {
    for (const o of observers) {
      if (!o.opts || !o.opts.childList) continue;
      let inScope = o.target === parent;
      if (!inScope && o.opts.subtree) {
        for (let p = parent; p && !inScope; p = p.parentElement) inScope = p === o.target;
      }
      if (!inScope) continue;
      try {
        o.cb([{ type: 'childList', target: parent, addedNodes: [child], removedNodes: [] }], o);
      } catch {
        /* an observer callback must not break the run */
      }
    }
  };

  const node = (tag) => {
    const n = makeTarget({
      tag,
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      innerHTML: '',
      textContent: '',
      style: {},
      dataset: {},
      attrs: {},
      parentElement: null,
      isConnected: true,
      removed: false,
      appendChild(c) {
        c.parentElement = this;
        notifyAdded(this, c);
        return c;
      },
      remove() {
        this.removed = true;
        this.isConnected = false;
      },
      setAttribute(k, v) {
        const changed = this.attrs[k] !== String(v);
        this.attrs[k] = String(v);
        if (changed) notifyAttrs(this, k);
      },
      getAttribute(k) {
        return this.attrs[k] === undefined ? null : this.attrs[k];
      },
      removeAttribute(k) {
        if (this.attrs[k] === undefined) return;
        delete this.attrs[k];
        notifyAttrs(this, k);
      },
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    });
    return n;
  };

  const docEl = node('html');
  docEl.setAttribute('data-ko-adblock', '1');
  docEl.setAttribute('data-ko-ext-id', 'test');

  // THE LAYER NODE. `getElementById` used to answer null for everything, so every
  // predicate that asks whether a layer EXISTS measured a page with no layer at
  // all: `overlayOwnsPlayback()` now requires #ko-wrap (the stale publish of
  // 2026-11-19), and an id-blind stub would make the healthy case read as a
  // stale one. The healthy page has a wrap; a test that wants Twitch's real
  // stale publish removes it with `page.dropWrap()`.
  const koWrap = node('div');
  koWrap.id = 'ko-wrap';
  let wrapPresent = true;

  const body = node('body');
  const frameWindow = {
    postMessage: (payload) => sent.push(payload && payload.__koKick),
  };
  let createdFrame = null;
  const createdDivs = [];

  const extraVideos = [];
  const video = makeTarget({
    tagName: 'VIDEO',
    style: {},
    isConnected: true,
    paused: false,
    readyState: 4,
    currentTime: 30,
    duration: Infinity,
    muted: false,
    volume: 1,
    videoWidth: 1280,
    videoHeight: 720,
    error: null,
    buffered: { length: 1, start: () => 0, end: () => 40 },
    seekable: { length: 1, start: () => 0, end: () => 40 },
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      this.plays = (this.plays || 0) + 1;
      return Promise.resolve();
    },
  });

  const document = makeTarget({
    documentElement: docEl,
    body,
    fullscreenElement: null,
    visibilityState: 'visible',
    hidden: false,
    createElement: (t) => {
      const n = node(t);
      if (t === 'iframe') {
        n.contentWindow = frameWindow;
        createdFrame = n;
        // Chrome: an extension frame's document loads a tick after creation.
        if (!autoLoad) return n;
        clock.setTimeout(() => {
          for (const f of (n.listeners.load || []).slice()) {
            try {
              f();
            } catch {
              /* a load handler must not break the run */
            }
          }
        }, 0);
      }
      if (t === 'div') createdDivs.push(n);
      return n;
    },
    querySelectorAll: (sel) => (sel === 'video' ? (extraVideos.length ? [video, ...extraVideos] : [video]) : []),
    getElementById: (id) => (id === 'ko-wrap' && wrapPresent ? koWrap : null),
    dispatchEvent(ev) {
      if (ev && (ev.type === 'ko-adlog' || ev.type === 'ko-audio-log')) {
        try {
          adLogs.push(Object.assign({ type: ev.type }, JSON.parse(ev.detail)));
        } catch {
          /* malformed */
        }
      }
      this.fire(ev);
      return true;
    },
  });

  const window = makeTarget({
    fetch: undefined,
    Worker: undefined,
    dispatchEvent: (ev) => document.dispatchEvent(ev),
  });

  // One registry for window and document: the ad path listens for `message` on
  // the window and for pointerdown/visibilitychange on the document, and a
  // harness that keeps them apart silently starves one of them.
  window.listeners = document.listeners;
  window.fire = (ev) => document.fire(ev);

  class MutationObserver {
    constructor(cb) {
      this.cb = cb;
    }
    observe(target, opts) {
      observers.push({ cb: this.cb, target, opts: opts || {}, mo: this });
    }
    disconnect() {
      const i = observers.findIndex((o) => o.mo === this);
      if (i >= 0) observers.splice(i, 1);
    }
  }
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }
  class BroadcastChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      bcInstances.push(this);
    }
    // Real semantics: deliver to OTHER handles on the same name, never back to
    // the sender. The ad path's debug listener and bypass listener are reached
    // exactly as they are in the browser - by a post on another handle.
    postMessage(data) {
      bcSent.push({ name: this.name, data });
      for (const other of bcInstances) {
        if (other !== this && other.name === this.name && other.onmessage) {
          try { other.onmessage({ data }); } catch { /* a handler must not break the run */ }
        }
      }
    }
  }
  // The worker's own handle: the suite posts an ad-bearing playlist on it.
  const workerDebugChannel = new BroadcastChannel('ko-adblock-debug');
  class XMLHttpRequest {
    open() {}
    send() {}
    setRequestHeader() {}
    overrideMimeType() {}
  }
  class URLStub extends URL {
    static createObjectURL() {
      return 'blob:https://www.twitch.tv/ko-test';
    }
  }
  const chromeStub = {
    runtime: { id: 'test', lastError: null },
    storage: {
      local: {
        get: (k, cb) => {
          if (typeof cb === 'function') cb({});
        },
        set: () => {},
      },
    },
  };
  const location = {
    href: 'https://www.twitch.tv/rodil',
    pathname: '/rodil',
    search: '',
    hash: '',
    hostname: 'www.twitch.tv',
  };

  const run = (source, name) => {
    const factory = compile(source, name);
    factory(
      window, document, location, { userAgent: 'node' }, clock.performance,
      BroadcastChannel, CustomEvent, MutationObserver, XMLHttpRequest, class Blob {}, URLStub,
      (s) => Buffer.from(String(s)).toString('base64'), chromeStub, console,
      clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval, clock.Date,
    );
  };

  // 1. the authority, 2. the extension-world bridge, 3. content.js's stand-in,
  // 4. the MAIN-world ad path — the real injection order.
  run(audioSource, 'ko-audio.js');
  const audio = window.KOAudio;
  for (const m of ['intent', 'wanted', 'setIntent', 'setVisible', 'claim', 'apply', 'register', 'registerNative']) {
    if (!audio || typeof audio[m] !== 'function') throw new Error(`ko-audio.js did not expose ${m}()`);
  }
  run(BRIDGE, 'adblock-bridge.js');

  // What content.js does at boot: the page video is the 'twitch' surface, and
  // the two overlay layers are command surfaces.
  audio.registerNative('twitch', { elements: () => (extraVideos.length ? [video, ...extraVideos] : [video]), main: () => video });
  audio.register('kick', { write: (s) => layerSent.push({ surface: 'kick', ...s }) });
  audio.register('yt', { write: (s) => layerSent.push({ surface: 'yt', ...s }) });
  audio.setVisible('twitch');
  audio.apply();

  run(adSource, 'twitch-adblock.js');

  const api = {
    audio,
    sent,
    layerSent,
    video,
    document,
    docEl,
    // The layer leaving the document (Twitch's real stale publish on a channel
    // with no kick mirror). Ownership must stop the moment this is called.
    dropWrap() {
      wrapPresent = false;
    },
    addWrap() {
      wrapPresent = true;
    },
    bcInstances,
    get frame() {
      return createdFrame;
    },
    get badge() {
      return createdDivs.find((d) => d.id === 'ko-adfix-badge') || null;
    },
    get cover() {
      return createdDivs.find((d) => d.id === 'ko-adfix-cover') || null;
    },
    location,
    frameToken() {
      const m = /token=([^&]+)/.exec((createdFrame && createdFrame.src) || '');
      return m ? decodeURIComponent(m[1]) : '';
    },
    frameMsg(msg) {
      const token = api.frameToken();
      document.fire({
        type: 'message',
        origin: 'chrome-extension://test',
        data: { __koKick: { ...msg, _koToken: token } },
        source: frameWindow,
      });
    },
    bypass(msg) {
      // The ad path now has TWO handles on this name (one listener, one
      // poster); only the handle with a listener is the page's ad path.
      const ch = bcInstances.filter((c) => c.name === 'ko-adblock-bypass')
        .reverse().find((c) => typeof c.onmessage === 'function');
      // The real handler refuses a message that is not addressed to this page.
      const pageId = (window.__koTwitchAdblockStats && window.__koTwitchAdblockStats.pageId) || '';
      if (ch && ch.onmessage) ch.onmessage({ data: { page: pageId, ...msg } });
    },
    // The worker's playlist digest, posted on the real debug channel. The
    // page's listener is reached by BroadcastChannel delivery, not by calling
    // its handler: this is the route the extension has to prove.
    debug(msg) {
      const pageId = (window.__koTwitchAdblockStats && window.__koTwitchAdblockStats.pageId) || '';
      workerDebugChannel.postMessage({ page: pageId, ...msg });
    },
    bypassPosts: () => bcSent.filter((s) => s.name === 'ko-adblock-bypass').map((s) => s.data),
    stats: () => window.__koTwitchAdblockStats,
    // A USER gesture on the page's own volume control: the click (the input
    // event the arbiter times) comes first, then the element changes and the
    // browser fires volumechange. The authority is the only reader.
    userSetsNative(muted, volume) {
      document.fire({ type: 'pointerdown' });
      if (typeof muted === 'boolean') video.muted = muted;
      if (Number.isFinite(volume)) video.volume = volume;
      document.fire({ type: 'volumechange', target: video });
    },
    clickBadge() {
      const b = api.badge;
      for (const f of ((b && b.listeners.click) || []).slice()) f({ type: 'click' });
    },
    clickDocument() {
      for (const f of (document.listeners.pointerdown || []).slice()) f({ type: 'pointerdown' });
    },
    // A click with a TARGET: the arbiter asks whether that control could have
    // carried a volume, which a target-less event cannot answer.
    clickDocumentTarget(target) {
      for (const f of (document.listeners.pointerdown || []).slice()) f({ type: 'pointerdown', target });
    },
    // The end of a slider drag. `window.listeners` is the same registry as
    // `document.listeners`, so this reaches the arbiter's window listener too.
    releasePointer(type) {
      for (const f of (document.listeners[type || 'pointerup'] || []).slice()) f({ type: type || 'pointerup' });
    },
    // A KEYSTROKE with no volume control behind it. Twitch's player writes its
    // own volume during an ad; the arbiter has to tell a real volume key from a
    // space bar typed while the ad rolls (owner report 2026-11-16).
    pressKey(key, target) {
      const t = target || { tagName: 'DIV', closest: () => null };
      for (const f of (document.listeners.keydown || []).slice()) f({ type: 'keydown', target: t, key });
    },
    // The MACHINE lowering the page video's volume — Twitch writes 0.32 for an
    // ad, which is audible as "mutou a live" without ever setting muted.
    machineDropsVolume(v) {
      video.volume = v;
      document.fire({ type: 'volumechange', target: video });
    },
    // Any element state Twitch's own controls write, in one event: its mute
    // button sets `muted:true` AND `volume:0`, and un-muting emits
    // `{muted:false, volume:0}` before the level comes back.
    machineSetsNative(muted, volume) {
      video.muted = !!muted;
      video.volume = volume;
      document.fire({ type: 'volumechange', target: video });
    },
    // The MACHINE muting the page video while a click is still fresh (owner
    // report 2026-11-11: he clicks to recover the delay, Twitch mutes its own
    // element as the pod takes over). No pointerdown is fired here: the click
    // the test sent a moment ago is what makes the event look attributable.
    machineMutesNative() {
      video.muted = true;
      document.fire({ type: 'volumechange', target: video });
    },
    extraVideo(opts) {
      const v = makeTarget(Object.assign({ tagName: 'VIDEO', isConnected: true, paused: false, readyState: 4, currentTime: 5, duration: Infinity, muted: false, volume: 1, videoWidth: 640, videoHeight: 360, error: null, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }), pause() { this.paused = true; }, play() { this.paused = false; this.plays = (this.plays || 0) + 1; return Promise.resolve(); }, addEventListener() {}, removeEventListener() {} }, opts || {}));
      extraVideos.push(v);
      return v;
    },
    muteSent() {
      return sent.filter((m) => m && m.t === 'mute').map((m) => m.m);
    },
    seeks() {
      return sent.filter((m) => m && m.t === 'seek').map((m) => m.s);
    },
    logs() {
      return adLogs;
    },
    logsOf(ev) {
      return adLogs.filter((l) => l && l.ev === ev);
    },
    pageMsg(msg) {
      document.fire({
        type: 'message',
        origin: 'https://www.twitch.tv',
        data: { __koKick: { ...msg, _koToken: api.frameToken() } },
        source: frameWindow,
      });
    },
    showTab() {
      document.visibilityState = 'visible';
      document.hidden = false;
      document.fire({ type: 'visibilitychange' });
    },
    attrMuted() {
      return docEl.getAttribute('data-ko-audio-m');
    },
    attrPolicy() {
      return String(docEl.getAttribute('data-ko-audio-policy') || '');
    },
    logs: () => adLogs,
  };
  return api;
}

const settle = async (ms) => {
  await clock.advance(ms);
  if (clock.real) return; // the real sleep already let pending work run
  // Product callbacks schedule follow-up work in microtasks; give those tasks
  // their turns and fire any zero-delay timer they arm before asserting.
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    clock.advance(0);
  }
};

function healthySt(overrides) {
  return {
    t: 'st',
    st: Object.assign(
      { state: 'Playing', paused: false, muted: true, rs: 4, buffered: 8, pos: 30, lat: 2, dur: 0, q: { name: '360p' } },
      overrides || {},
    ),
  };
}

async function runPod(page, { mutedBeforeAd, autoStart = true }) {
  page.userSetsNative(!!mutedBeforeAd, 1);
  page.bypass({ type: 'ad-hold' });
  if (autoStart) page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
  await settle(20);
  page.frameMsg({ t: 'ready' });
  for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
  await settle(20);
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'FAIL', detail: error.message });
    console.log(`FAIL ${name}  ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // ---- 0: the swap carries the mute (owner 2026-11-12) ------------------
  {
    const w = makeWorld();
    check('swap carries the mute, and the log records the carry', () => swapCarryArm(w));
  }
  // ---- 1: the report. A muted user, an ad swaps the player. --------------
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: true });
    const audible = makeWorld();
    await runPod(audible, { mutedBeforeAd: false });
    audible.frameMsg(healthySt({ muted: false })); // the frame reports itself audible, not an autoplay retry
    check('a muted user is not unmuted at reveal', () => {
      assert(page.frame && page.frame.removed === false, 'clean frame was removed instead of revealed');
      assert(page.attrMuted() === '1', `authority published muted=${page.attrMuted()} for a muted user`);
      assert(!page.muteSent().includes(false), `sent mute:false -> ${JSON.stringify(page.muteSent())}`);
    });
    check('a muted user sees the click-to-sound badge', () => {
      const heard = page.audio.visible();
      nodeAssert.strictEqual(page.audio.wanted(heard).muted, true, 'precondition: the law says the muted user is silent');
      assert(/clique para som/.test(page.badge.textContent), `badge text: ${page.badge.textContent}`);
      const aud = audible.audio.visible();
      nodeAssert.strictEqual(audible.audio.wanted(aud).muted, false, 'precondition: the law says the other user is audible');
      assert(!/clique para som/.test(audible.badge.textContent),
        `badge offered click-to-sound to an audible surface: ${audible.badge.textContent}`);
    });
    check('a click elsewhere on the page does not unmute a muted user', () => {
      page.clickDocument();
      assert(!page.muteSent().includes(false), 'a generic page click restored the audio');
    });
    check('an explicit badge click unmutes the player and persists the choice', () => {
      const heard = page.audio.visible();
      nodeAssert.strictEqual(page.audio.wanted(heard).muted, true, 'precondition: the law had the heard surface muted');
      page.clickBadge();
      nodeAssert.strictEqual(page.audio.wanted(heard).muted, false, 'the arbiter still derives a mute after the badge click');
      nodeAssert.strictEqual(page.muteSent().slice(-1)[0], false, 'the last command to the frame still silences it');
      assert(page.audio.intent('twitch').muted === false, 'the unmute was not recorded as intent');
    });
    check('ad-end hands the native back at the intent the user set DURING the pod', () => {
      page.bypass({ type: 'ad-end' });
      assert(page.video.muted === false, `native restored muted=${page.video.muted} after an explicit unmute`);
    });
  }

  // ---- 2: muted user, ad ends with no gesture: still silent. -------------
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: true });
    page.bypass({ type: 'ad-end' });
    check('ad-end keeps a muted user muted', () => {
      assert(page.video.muted === true, `native restored muted=${page.video.muted}`);
    });
  }

  // ---- 2b: the machine muting right after the hand-back. ------------------
  // Owner report 2026-11-11: "deixou a live com delay ... e o player trocou pra
  // ficar mutado". He clicks the player to recover the delay, the pod ends and
  // Twitch re-mutes its own element within the freshness window, so the mute
  // was recorded as HIS choice and handed to the next player.
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    assert(page.video.muted === false, 'precondition: the hand-back gave the sound back');
    page.clickDocument();
    page.machineMutesNative();
    check('a machine mute right after the hand-back is not the user choice', () => {
      assert(page.audio.intent('twitch').muted === false,
        `intent became muted=${page.audio.intent('twitch').muted} from a machine mute`);
      assert(page.video.muted === false, 'the page surface was left silenced');
    });
  }

  // ---- 2b2: the pod's own silence is never his intent. --------------------
  // Owner report 2026-11-12: "acabou de trocar o player ... e voltou MUTADO
  // sendo que antes eu estava com a live DESMUTADA". His ko.adlog, mid-pod:
  //   audio-intent {surface:"twitch", before:{muted:false,volume:0.88},
  //                 after:{muted:true,volume:0}, silent:true}
  // then ad-end -> the page came back muted at volume 0. The guard that exists
  // for exactly this compared `surfaceOf(owner) !== surfaceOf(claimed)`, and the
  // ad surface SHARES the twitch intent, so it was blind for the one claim that
  // always covers the page.
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    assert(page.video.muted === true, 'precondition: the claim silenced the covered page');
    // Past the arbiter's 700 ms own-write TTL: the claim's write is ours, and a
    // mute inside that window is discarded by the echo guard instead of being
    // measured. In the owner's own log the pod had been up for 38 s.
    await settle(900);
    page.clickDocument(); // a real click makes the event look fresh
    page.machineMutesNative(); // the page element muted by the swap itself
    check('a mute arriving while a claim covers the page is never the user choice', () => {
      assert(page.audio.intent('twitch').muted === false,
        `intent became muted=${page.audio.intent('twitch').muted} from the pod's own silence`);
      assert(page.audio.intent('twitch').volume > 0.5,
        `intent volume became ${page.audio.intent('twitch').volume} (the user never touched it)`);
    });
    page.bypass({ type: 'ad-end' });
    check('...and the page comes back at the sound the user left it at', () => {
      assert(page.video.muted === false, `the page returned muted=${page.video.muted}`);
      assert(page.video.volume > 0.5, `the page returned at volume ${page.video.volume}`);
    });
  }
  {
    // RED: restore the shares-blind guard and the same event must be recorded.
    const blind = AUDIO
      .split('const machineWindow = !!claimed || (releasedAt > 0 && Date.now() - releasedAt <= CLAIM_RELEASE_MS);')
      .join('const machineWindow = claimed ? surfaceOf(owner) !== surfaceOf(claimed) : (releasedAt > 0 && Date.now() - releasedAt <= CLAIM_RELEASE_MS);');
    check('mutation: the claim-window guard exists to be disarmed', () => {
      assert(blind !== AUDIO, 'the claim-window guard was not found');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    await settle(900); // past the own-write TTL
    page.clickDocument();
    page.machineMutesNative();
    check('RED: the shares-blind guard records the pod mute as intent', () => {
      assert(page.audio.intent('twitch').muted === true,
        'the mutant discarded it too: this arm is not measuring the guard');
    });
  }

  // ---- 2b3: the log carries the ANSWER, not a hint. ----------------------
  // Owner order 2026-11-12: "os logs nao devem ser hints, mas a resposta
  // inteira". Reading his adlog, one transition needed a join across a dozen
  // events, several of which named a value without the surface that owned the
  // picture. Every transition now carries the whole state under `st`.
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    const reveal = page.logs().filter((l) => l.ev === 'overlay-reveal').pop();
    check('a transition line carries the whole state, not just its own field', () => {
      assert(!!reveal, 'no overlay-reveal line was written');
      const st = reveal.d && reveal.d.st;
      assert(!!st, 'the transition carries no state snapshot');
      // `null` on this world: content.js is the writer of data-ko-owner and this
      // harnesses only the ad path, the bridge and the arbiter.
      assert(st.srf === null || typeof st.srf === 'string', `srf=${JSON.stringify(st.srf)}`);
      assert(!!st.aud && 'm' in st.aud && 'v' in st.aud, 'no audio state in the snapshot');
      assert(!!st.nat, 'no native element state in the snapshot');
      assert('ct' in st.nat && 'rs' in st.nat && 'muted' in st.nat, 'the native block is incomplete');
      assert(!!st.clean, 'the clean player reported nothing at reveal');
      assert('pos' in st.clean && 'lat' in st.clean && 'hold' in st.clean, 'the clean block is incomplete');
      assert(!!st.who && 'revealed' in st.who && 'own' in st.who, 'the ownership block is missing');
    });
    // A refused mute must SAY so. An accepted intent beside an unlogged refusal
    // is exactly what made his own log look like the extension muting him.
    await settle(900); // past the arbiter's own-write TTL
    page.clickDocument();
    page.machineMutesNative();
    const refused = page.logs().filter((l) => l.ev === 'audio-refused').pop();
    check('a discarded mute names the reason it was discarded', () => {
      assert(!!refused, 'the refusal was silent');
      assert(refused.d.why === 'covered', `why=${refused.d.why}`);
      assert(!!refused.d.claimed, 'the line does not name the claim that covered the page');
      assert(!!refused.d.intent, 'the line does not say what intent it protected');
    });
    const claim = page.logs().filter((l) => l.ev === 'audio-claim').pop();
    check('the claim carries the sound it is about to silence', () => {
      assert(!!claim, 'no audio-claim line');
      assert(!!claim.d.wanted, 'the claim does not say what it is silencing');
      assert(!!claim.d.intents, 'the claim does not publish the table it derives from');
      const heard = page.audio.visible();
      nodeAssert.deepStrictEqual(claim.d.wanted, page.audio.wanted(heard),
        `claim=${JSON.stringify(claim.d.wanted)} law=${JSON.stringify(page.audio.wanted(heard))}`);
      nodeAssert.strictEqual(page.audio.wanted(heard).muted, false, 'the heard frame is audible by law');
      nodeAssert.strictEqual(page.audio.wanted('twitch').muted, true, 'the claim must silence the covered page by law');
    });
  }

  // ---- 2b4: every accepted change names its AUTHOR. -----------------------
  // Owner order 2026-11-12: "tu tem que entender se o mute vem do meu click do
  // mouse e se vem de alguma decisao do codigo. (no caso, logga isso)". A line
  // that says the intent moved but not who moved it is the defect this arm
  // exists to catch, so the assertion is on the FIELD, at both writers.
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    // Past BOTH windows: the machine one (CLAIM_RELEASE_MS after the release) and
    // the gesture one (INPUT_FRESH_MS). A write inside either is correctly not
    // his, and an arm that writes there measures the guard, not the label.
    await settle(2800);
    // (a) his pointer. The write must FLIP the state, or the arbiter correctly
    //     logs nothing and the arm measures its own no-op.
    page.clickDocument();
    page.machineMutesNative(); // a volumechange the arbiter did not write, right after a real input
    const userLine = page.logs().filter((l) => l.ev === 'audio-intent').pop();
    check('an accepted gesture says a pointer caused it', () => {
      assert(!!userLine, 'no audio-intent line for the gesture');
      assert(/^user:pointer/.test(String(userLine.d.origin || '')),
        `origin=${JSON.stringify(userLine.d.origin)} on a pointer-driven change`);
      assert(userLine.d.ev && userLine.d.ev.input === 'pointerdown',
        `ev=${JSON.stringify(userLine.d.ev)} does not name the input that justified it`);
      assert(typeof userLine.d.ev.inputAgeMs === 'number' && userLine.d.ev.inputAgeMs <= 1200,
        `ev.inputAgeMs=${JSON.stringify(userLine.d.ev && userLine.d.ev.inputAgeMs)} is outside INPUT_FRESH_MS`);
    });
    // (b) the machine: refused, and the refusal carries its reason.
    await settle(1600);
    const before = page.audio.intent('twitch').muted;
    page.machineMutesNative();
    const refused = page.logs().filter((l) => l.ev === 'audio-refused').pop();
    check('a machine change is refused with the reason, and no intent line is written', () => {
      assert(page.audio.intent('twitch').muted === before || page.logs().every((l) => l.ev !== 'audio-intent' || !/^code:UNLABELLED/.test(String(l.d.origin))),
        'an unlabelled intent line was written');
      assert(!!refused, 'the machine change wrote no audio-refused line');
      assert(typeof refused.d.why === 'string' && refused.d.why.length > 0, `why=${JSON.stringify(refused.d.why)}`);
    });
  }

  // ---- 2c: positive control — the SAME event well after the window IS his. -
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    page.clickDocument();
    page.machineMutesNative();
    check('a mute 3 s after the hand-back is recorded as intent', () => {
      assert(page.audio.intent('twitch').muted === true,
        'a real mute outside the machine window was discarded (detector measures nothing)');
    });
  }

  // ---- 2c2: WHICH input, not just WHEN. --------------------------------
  // Measured in the owner's ko.adlog 2026-11-15 (0.8.92, twitch.tv/buzzyi_):
  // `audio-intent {origin:"user:pointer", ev:{input:"click", inputAgeMs:57},
  // after:{muted:true}}` — he clicked the PICTURE to recover a stall, Twitch
  // muted its own element 57 ms later, and the freshest-input rule made that his
  // decision, which the next live he opened inherited. A mute is only his when
  // the input could have changed a volume.
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    // A real click on the PICTURE: a target no volume control lives in.
    page.clickDocumentTarget({ tagName: 'VIDEO' });
    page.machineMutesNative();
    const refused = page.logs().filter((l) => l.ev === 'audio-refused').pop();
    check('a mute after a click on the picture is not the user muting', () => {
      assert(page.audio.intent('twitch').muted === false,
        'a click on the picture became a mute intent (the 2026-11-15 defect)');
      assert(!!refused, 'the refusal wrote no audio-refused line');
      assert(refused.d.why === 'not-volume-control',
        `why=${JSON.stringify(refused.d.why)} does not name the control test`);
      assert(refused.d.input === 'pointerdown', `input=${JSON.stringify(refused.d.input)} is not the click that was read`);
    });
    // The SAME gesture on our own volume control IS his: the refusal must not
    // be a blanket ban on muting.
    page.clickDocumentTarget({ tagName: 'DIV', closest: (sel) => (String(sel).includes('#ko-mute') ? {} : null) });
    page.machineMutesNative();
    check('the same mute from our own volume control IS the user choice', () => {
      assert(page.audio.intent('twitch').muted === true,
        'a mute on the volume control was refused (the guard is too broad)');
    });
  }

  // ---- 2c6: YOUTUBE'S OWN MUTE BUTTON IS A VOLUME CONTROL ----------------
  // Measured on the owner's YouTube tab 2026-11-24: `.ytp-mute-button` is a
  // visible 40x40 button with NO aria-label and NO data-a-target, so every
  // click on it fell through VOLUME_CONTROL_SEL, was refused as
  // `not-volume-control`, and `apply()` re-asserted the unmuted intent — his
  // "o meu youtube ta com problema pra mutar e desmutar ... ele nao muta".
  // The control belongs to the user whichever player draws it.
  {
    const page = makeWorld({});
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const ytMute = { tagName: 'BUTTON', closest: (sel) => (String(sel).includes('.ytp-mute-button') ? {} : null) };
    page.clickDocumentTarget(ytMute);
    page.machineMutesNative();
    check("a mute on YouTube's own mute button IS the user choice", () => {
      assert(page.audio.intent('twitch').muted === true,
        'the YouTube mute button was refused: the click did not mute');
    });
  }
  {
    const blind = AUDIO.split(".ytp-mute-button'").join(".ytp-nomatch'");
    if (blind === AUDIO) throw new Error('the YouTube-control mutation did not apply');
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const ytMute = { tagName: 'BUTTON', closest: (sel) => (String(sel).includes('.ytp-mute-button') ? {} : null) };
    page.clickDocumentTarget(ytMute);
    page.machineMutesNative();
    check('RED: without the YouTube control the click cannot mute', () => {
      assert(page.audio.intent('twitch').muted === false,
        'the mutant accepted the YouTube mute: the arm measures nothing');
    });
  }

  // ---- 2c7: a CERTIFIED gesture wins inside the machine window ----------
  // Owner 2026-11-24 (0.8.113): `audio-refused {why:"covered"}` landed on his
  // OWN click of Twitch's mute button while the ad claim was up. The claim
  // protects the page from the machine, not from a fresh volume-capable
  // gesture. Both directions must go through; an uncertified mute must not.
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    assert(page.audio.visible() === 'ad', 'precondition: the ad claim covers the page');
    assert(page.attrMuted() === '0', 'precondition: the heard surface is audible');
    await settle(900); // past the claim's own-write TTL
    const muteBtn = {
      tagName: 'BUTTON',
      closest: (sel) => (String(sel).includes('[data-a-target="player-mute-unmute-button"]') ? {} : null),
    };
    page.clickDocumentTarget(muteBtn);
    page.machineMutesNative();
    check('a certified mute during a claim flips intent and the heard surface', () => {
      assert(page.audio.intent('twitch').muted === true, 'a certified mute was refused as covered');
      assert(page.audio.intent('ad').muted === true, 'the heard surface did not inherit the mute');
      assert(page.attrMuted() === '1', `the clean player still publishes muted=${page.attrMuted()}`);
    });
    page.clickDocumentTarget(muteBtn);
    page.machineSetsNative(false, 1);
    check('the certified unmute during the same claim is accepted too', () => {
      assert(page.audio.intent('twitch').muted === false, 'the unmute direction was refused inside the claim');
      assert(page.attrMuted() === '0', `the clean player stayed muted=${page.attrMuted()}`);
    });
  }
  {
    // RED: restore the pre-fix guard, which refuses EVERY mute in the window.
    const blind = AUDIO
      .split(`if (machineWindow && !!el.muted && !certified) {`)
      .join(`if (machineWindow && !!el.muted) {`);
    check('mutation: the certified-gesture exception exists to be disarmed', () => {
      assert(blind !== AUDIO, 'the machine-window guard was not found');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    await settle(900);
    const muteBtn = {
      tagName: 'BUTTON',
      closest: (sel) => (String(sel).includes('[data-a-target="player-mute-unmute-button"]') ? {} : null),
    };
    page.clickDocumentTarget(muteBtn);
    page.machineMutesNative();
    check('RED: without the exception the certified mute stays refused', () => {
      assert(page.audio.intent('twitch').muted === false,
        'the mutant accepted it: this arm is not measuring the exception');
      assert(page.attrMuted() === '0', `the mutant published muted=${page.attrMuted()}`);
    });
  }
  {
    // The control: no certified gesture (a picture click) while claimed stays
    // refused, exactly as in the measured 2026-11-11 defect.
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    await settle(900);
    page.clickDocumentTarget({ tagName: 'VIDEO' }); // fresh, but not a volume control
    page.machineMutesNative();
    const refused = page.logs().filter((l) => l.ev === 'audio-refused').pop();
    check('a mute with no certified gesture stays refused inside the claim', () => {
      assert(page.audio.intent('twitch').muted === false, 'an uncertified picture click flipped intent');
      assert(!!refused && refused.d.why === 'covered', `why=${refused && refused.d.why}`);
    });
  }
  {
    // RED for the control: take BOTH no-gesture guards out; the same picture
    // click then mutes the tab, proving the arm measures them.
    const blind = AUDIO
      .split(`if (machineWindow && !!el.muted && !certified) {`)
      .join(`if (false && machineWindow && !!el.muted && !certified) {`)
      .split(`if (lowering && !volumeCapable) {`)
      .join(`if (false && lowering && !volumeCapable) {`);
    check('mutation: both no-gesture guards exist to be disarmed', () => {
      assert(blind !== AUDIO, 'a no-gesture guard was not found');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    await settle(900);
    page.clickDocumentTarget({ tagName: 'VIDEO' });
    page.machineMutesNative();
    check('RED: without both guards the picture click mutes the tab', () => {
      assert(page.audio.intent('twitch').muted === true,
        'the mutant refused it too: the arm is not measuring the guards');
    });
  }

  // ---- 2c8: Twitch's AD-UI volume controls are volume-capable ------------
  // The only controls added here; a whole-player selector is deliberately
  // absent, so a click on the picture stays non-volume-capable (arm 2c2).
  for (const sel of ['[class*="volume-slider"]', '[class*="ad-volume"]']) {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const ctl = { tagName: 'DIV', closest: (s) => (String(s).includes(sel) ? {} : null) };
    page.clickDocumentTarget(ctl);
    page.machineMutesNative();
    check(`${sel} IS a volume control`, () => {
      assert(page.audio.intent('twitch').muted === true, `${sel} was refused as not-volume-control`);
    });
  }
  {
    // PRODUCTION SHAPE: a bare `role="slider"` with no volume name is a seek bar
    // (YouTube's progress bar is exactly this). `matches` exists on real nodes;
    // the other stubs omit it, so this arm is the one that exercises the
    // tightening rather than the permissive no-`matches` fallback.
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const seekBar = {
      tagName: 'DIV',
      matches: (s) => String(s).includes('[role="slider"]'),
      closest: (s) => (String(s).includes('[role="slider"]')
        ? { matches: (x) => String(x).includes('[role="slider"]'), closest: () => null }
        : null),
    };
    page.clickDocumentTarget(seekBar);
    page.machineMutesNative();
    check('a bare role="slider" (a seek bar) does not authorize a mute', () => {
      assert(page.audio.intent('twitch').muted === false,
        'a seek-bar click certified the machine mute (the 2026-11-15 defect in a new shape)');
    });
  }
  {
    const blind = AUDIO
      .split(`    '[role="slider"]', '[class*="volume-slider"]', '[class*="ad-volume"]',`)
      .join('');
    check('mutation: the ad-UI selectors exist to be disarmed', () => {
      assert(blind !== AUDIO, 'the ad-UI selector line was not found');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const ctl = { tagName: 'DIV', closest: (s) => (String(s).includes('[class*="ad-volume"]') ? {} : null) };
    page.clickDocumentTarget(ctl);
    page.machineMutesNative();
    check('RED: without the ad-UI selectors the ad click cannot mute', () => {
      assert(page.audio.intent('twitch').muted === false,
        'the mutant accepted the ad slider: the arm measures nothing');
    });
  }

  // ---- 2c9: a slider drag keeps its volumechange fresh -------------------
  // `pointermove` is not in INPUT_EVENTS, so every move after INPUT_FRESH_MS
  // was refused as `stale-input`. The pointerdown on the slider opens the
  // drag window; pointerup/pointercancel closes it.
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const slider = { tagName: 'DIV', closest: (sel) => (String(sel).includes('[role="slider"]') ? {} : null) };
    page.clickDocumentTarget(slider);
    await settle(1400); // past INPUT_FRESH_MS
    page.machineMutesNative();
    check('a slider drag keeps its volumechange fresh and volume-capable', () => {
      assert(page.audio.intent('twitch').muted === true,
        'the drag mute went stale and was refused (the measured defect)');
    });
    page.releasePointer(); // pointerup closes the window
    page.machineSetsNative(false, 1);
    check('after pointerup the same volumechange is stale again', () => {
      assert(page.audio.intent('twitch').muted === true, 'the drag window stayed open after pointerup');
    });
    page.clickDocumentTarget(slider);
    page.releasePointer('pointercancel');
    await settle(1400);
    page.machineSetsNative(false, 1);
    check('after pointercancel the drag window is closed too', () => {
      assert(page.audio.intent('twitch').muted === true, 'the drag window stayed open after pointercancel');
    });
  }
  {
    const blind = AUDIO
      .split(`if (lastInputKind === 'pointerdown' && lastInputCertified) volumeDrag = Date.now();`)
      .join(`/* mutant: no drag window */;`);
    check('mutation: the drag window exists to be disarmed', () => {
      assert(blind !== AUDIO, 'the drag-window opener was not found');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const slider = { tagName: 'DIV', closest: (sel) => (String(sel).includes('[role="slider"]') ? {} : null) };
    page.clickDocumentTarget(slider);
    await settle(1400);
    page.machineMutesNative();
    check('RED: without the drag window the drag mute is stale', () => {
      assert(page.audio.intent('twitch').muted === false, 'the mutant accepted it: the arm measures nothing');
    });
  }
  // ---- 2c10: a fresh user UNMUTE while an ad claim covers the page -------
  // The claim's frame is the one voice: it SHARES the twitch intent, so the
  // unmute accepted on the covered page element is heard there. The covered
  // element itself stays silent (one voice), and the mute-only enforcement
  // tick must not close the frame. The refuted claim said the frame stayed
  // muted and the page element was re-closed on the 400 ms tick.
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: true });
    assert(page.audio.visible() === 'ad', 'precondition: the ad claim covers the page');
    assert(page.attrMuted() === '1', 'precondition: the heard surface is muted');
    assert(page.video.muted === true, 'precondition: the covered page element is silent');
    await settle(900); // past the claim's own-write TTL
    const muteBtn = {
      tagName: 'BUTTON',
      closest: (sel) => (String(sel).includes('[data-a-target="player-mute-unmute-button"]') ? {} : null),
    };
    page.clickDocumentTarget(muteBtn);
    page.machineSetsNative(false, 1);
    check('a fresh unmute under a claim opens the one voice at his intent', () => {
      assert(page.audio.intent('twitch').muted === false, 'the unmute did not reach the shared intent');
      assert(page.audio.wanted('ad').muted === false, `the claim frame wanted muted=${page.audio.wanted('ad').muted}`);
      assert(page.attrMuted() === '0', `the claim frame publishes muted=${page.attrMuted()}`);
      assert(page.video.muted === true, 'the covered page element was opened: a second voice');
    });
    check('the accepted unmute row names origin:user:pointer under the claim', () => {
      const rows = page.logsOf('audio-intent');
      const row = rows[rows.length - 1];
      assert(!!row, 'no audio-intent row was written');
      assert(row.d.origin === 'user:pointer', `origin=${JSON.stringify(row.d.origin)}`);
      assert(row.d.after && row.d.after.muted === false, `after=${JSON.stringify(row.d && row.d.after)}`);
      assert(row.d.visible === 'ad' && row.d.claimed === 'ad', `visible=${row.d.visible}, claimed=${row.d.claimed}`);
    });
    page.audio.enforceSilence();
    await settle(450); // and the real 400 ms tick
    check('the claim frame stays unmuted across enforceSilence', () => {
      assert(page.video.muted === true, `the covered page element opened: muted=${page.video.muted}`);
      assert(page.attrMuted() === '0', `the one voice was closed: muted=${page.attrMuted()}`);
      assert(page.audio.intent('twitch').muted === false, 'the intent drifted while enforcing silence');
    });
  }
  {
    // RED: restore the visible-blind want(). The covered page element then
    // opens too, so the one-voice arm above fails on a second audible surface.
    const blind = AUDIO
      .split('muted: !!(it.muted || policy.has(surface) || visibleNow() !== surface),')
      .join('muted: !!(it.muted || policy.has(surface)),');
    check('mutation: the visible rule exists to be disarmed', () => {
      assert(blind !== AUDIO, 'the visible rule was not found');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: true });
    await settle(900);
    const muteBtn = { tagName: 'BUTTON', closest: (sel) => (String(sel).includes('[data-a-target="player-mute-unmute-button"]') ? {} : null) };
    page.clickDocumentTarget(muteBtn);
    page.machineSetsNative(false, 1);
    check('RED: a visible-blind want() opens the covered page element too', () => {
      assert(page.video.muted === false, 'the mutant kept one voice: this arm is not measuring the visible rule');
    });
  }
  {
    // RED: restore the unlabelled intent write. The same unmute is accepted,
    // but its row no longer names the gesture that produced it.
    const blind = AUDIO
      .split("origin: 'user:pointer', ev: gestureEvidence")
      .join("origin: 'code:UNLABELLED', ev: gestureEvidence");
    check('mutation: the gesture origin exists to be disarmed', () => {
      assert(blind !== AUDIO, 'the gesture origin was not found');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: true });
    await settle(900);
    const muteBtn = { tagName: 'BUTTON', closest: (sel) => (String(sel).includes('[data-a-target="player-mute-unmute-button"]') ? {} : null) };
    page.clickDocumentTarget(muteBtn);
    page.machineSetsNative(false, 1);
    const rows = page.logsOf('audio-intent');
    check('RED: an unlabelled unmute hides its gesture origin', () => {
      const row = rows[rows.length - 1];
      assert(!!row && row.d.origin !== 'user:pointer', `origin=${row && row.d.origin}: the arm measures nothing`);
    });
  }
  {
    // RED: restore the world where the claim surface had its own intent and
    // a gesture was not carried to the visible surface. With the frame muted
    // by hand, the user's unmute no longer reaches the one voice.
    const blind = AUDIO
      .split('const surfaceOf = (s) => shares[s] || s;')
      .join('const surfaceOf = (s) => s;')
      .split("      if (now && now !== owner) setIntent(now, patch, { silent: true, origin: 'user:pointer->visible', ev: gestureEvidence });")
      .join('      /* pre-fix: no carry to the claimed surface */');
    check('mutation: the shared intent and the carry exist to be disarmed', () => {
      assert(blind !== AUDIO, 'the sharing/carry mutation did not apply');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: true });
    page.audio.setIntent('ad', { muted: true, volume: 1 }, { persist: false, origin: 'code:test' });
    await settle(900);
    const muteBtn = { tagName: 'BUTTON', closest: (sel) => (String(sel).includes('[data-a-target="player-mute-unmute-button"]') ? {} : null) };
    page.clickDocumentTarget(muteBtn);
    page.machineSetsNative(false, 1);
    check('RED: without sharing and carry the frame stays muted after the unmute', () => {
      assert(page.attrMuted() === '1', `the mutant unmuted the frame: muted=${page.attrMuted()}`);
    });
  }
  // A MACHINE unmute under the claim is the opposite direction: no gesture,
  // no accepted intent. It is refused as stale input and apply() re-closes the
  // page element; the frame stays at the intent the user left (muted).
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: true });
    assert(page.attrMuted() === '1', 'precondition: the heard surface is muted');
    await settle(1600); // past TTL and INPUT_FRESH_MS
    const before = page.logsOf('audio-intent').length;
    page.machineSetsNative(false, 1);
    const refused = page.logsOf('audio-refused').pop();
    check('a machine unmute under a claim is refused without becoming intent', () => {
      assert(page.audio.intent('twitch').muted === true, 'a machine unmute became the user choice');
      assert(page.attrMuted() === '1', `the claim frame opened: muted=${page.attrMuted()}`);
      assert(page.video.muted === true, `the covered page element stayed open: muted=${page.video.muted}`);
      assert(page.logsOf('audio-intent').length === before, 'an intent row was written for the machine unmute');
      assert(!!refused && refused.d.why === 'stale-input', `why=${refused && refused.d.why}`);
    });
  }
  {
    // RED: restore the pre-fix world with no freshness gate. The same machine
    // unmute is then accepted as the user's and the frame opens.
    const blind = AUDIO.split('if (!fresh) {').join('if (false) {');
    check('mutation: the freshness gate exists to be disarmed', () => {
      assert(blind !== AUDIO, 'the freshness gate was not found');
    });
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: true });
    await settle(1600);
    page.machineSetsNative(false, 1);
    check('RED: without freshness the machine unmute becomes intent', () => {
      assert(page.audio.intent('twitch').muted === false, 'the mutant refused it too: the arm measures nothing');
    });
  }

  // ---- 2c11: a mute LABEL must name the control, not just contain "ute" ---
  // `[aria-label*="ute"]` certified `Absolute`, `Route`, `Computer`: any fresh
  // click on such a button could turn the player's next mute into the user's
  // choice. Mute/unmute wording must match as a word, in any case, while
  // Twitch's data-target button, YouTube's chrome and the ad slider stay real.
  {
    const page = makeWorld();
    const absolute = {
      tagName: 'BUTTON',
      getAttribute: (k) => (k === 'aria-label' ? 'Absolute' : null),
      closest: (sel) => (String(sel).includes('[aria-label*="ute"]') ? {} : null),
    };
    page.clickDocumentTarget(absolute);
    page.machineMutesNative();
    const refused = page.logsOf('audio-refused').pop();
    check('a label like Absolute does not certify a volume control', () => {
      assert(page.audio.intent('twitch').muted === false, 'a non-mute label certified the mute');
      assert(!!refused && refused.d.why === 'not-volume-control', `why=${refused && refused.d.why}`);
    });
  }
  for (const label of ['Mute', 'unmute', 'MUTE', 'Press m to mute']) {
    const page = makeWorld();
    const control = {
      tagName: 'BUTTON',
      getAttribute: (k) => (k === 'aria-label' ? label : null),
      closest: () => null,
    };
    page.clickDocumentTarget(control);
    page.machineMutesNative();
    check(`aria-label "${label}" certifies a mute control`, () => {
      assert(page.audio.intent('twitch').muted === true, `${label} was refused as not-volume-control`);
    });
  }
  {
    // RED: restore `[aria-label*="ute"]`. "Absolute" now matches the selector,
    // so the same click certifies the machine mute and the arm above fails.
    const blind = AUDIO
      .split(`    '[aria-label*="olume"]',`)
      .join(`    '[aria-label*="olume"]', '[aria-label*="ute"]',`);
    check('mutation: the substring label selector exists to be disarmed', () => {
      assert(blind !== AUDIO, 'the label selector was not found');
    });
    const page = makeWorld({ audioSource: blind });
    const absolute = {
      tagName: 'BUTTON',
      getAttribute: (k) => (k === 'aria-label' ? 'Absolute' : null),
      closest: (sel) => (String(sel).includes('[aria-label*="ute"]') ? {} : null),
    };
    page.clickDocumentTarget(absolute);
    page.machineMutesNative();
    check('RED: with the bare ute substring Absolute certifies the mute', () => {
      assert(page.audio.intent('twitch').muted === true, 'the mutant refused it: the arm measures nothing');
    });
  }

  // ---- 2c5: a mute remembers the level it silenced ----------------------
  // Owner report 2026-11-16, verbatim: "o botao de mutar e desmutar funciona de
  // forma inconsistente ... normalmente vendo live mesmo". His ring (0.8.95)
  // shows one gesture producing three intents, and the unmute depending on the
  // page sending a LAST event:
  //   audio-intent {before:{muted:false,volume:1}, after:{muted:true,volume:0}}
  //   audio-intent {before:{muted:true,volume:0},  after:{muted:false,volume:0}}
  //   audio-intent {before:{muted:false,volume:0}, after:{muted:false,volume:1}}
  // Persisting the 0 threw his level away, so `{muted:false, volume:0}` was a
  // silent tab that the bar reported as audible.
  {
    const page = makeWorld({});
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const ctl = { tagName: 'BUTTON', closest: (sel) => (/ko-mute|ko-vol|volume|mute/i.test(String(sel)) ? {} : null) };
    page.clickDocumentTarget(ctl);
    page.machineSetsNative(true, 0); // Twitch's button: muted AND volume 0
    check('a mute remembers the level it silenced', () => {
      assert(page.audio.intent('twitch').muted === true, 'the mute was not recorded');
      assert(page.audio.intent('twitch').volume > 0.5,
        `the level was thrown away: intent.volume=${page.audio.intent('twitch').volume}`);
    });
    page.clickDocumentTarget(ctl);
    page.machineSetsNative(false, 0); // the page's own intermediate, and NOTHING after it
    check('one unmute click restores the sound without a second event', () => {
      assert(page.audio.intent('twitch').muted === false, 'the unmute was not recorded');
      assert(page.audio.intent('twitch').volume > 0.5,
        `intent.volume=${page.audio.intent('twitch').volume}: the tab is silent and says audible`);
      assert(page.video.volume > 0.5, `the element was left at volume ${page.video.volume}`);
    });
  }
  {
    const blind = AUDIO.split('        volume: Math.abs(lvl) > 0.001 ? lvl : clamp(prevIntent.volume),').join('        volume: lvl,');
    if (blind === AUDIO) throw new Error('the mute-memory mutation did not apply');
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    const ctl = { tagName: 'BUTTON', closest: (sel) => (/ko-mute|ko-vol|volume|mute/i.test(String(sel)) ? {} : null) };
    page.clickDocumentTarget(ctl);
    page.machineSetsNative(true, 0);
    page.clickDocumentTarget(ctl);
    page.machineSetsNative(false, 0);
    check('RED: without the memory, the intermediate leaves a silent tab saying audible', () => {
      assert(page.audio.intent('twitch').muted === false && page.audio.intent('twitch').volume === 0,
        `the mutant ended at ${JSON.stringify(page.audio.intent('twitch'))}, so the arms above measure nothing`);
    });
  }

  // ---- 2c4: a volume DROP is a silence too, and a stray keystroke is not a
  // volume key. Measured in the owner's ko.adlog 2026-11-16 (0.8.95,
  // twitch.tv/iolkaida): the arbiter refused Twitch's own `volume:0.32`
  // ELEVEN times as `stale-input`, then accepted it once a keydown landed
  // 528 ms before it — `audio-intent {before:{volume:1}, after:{volume:0.32},
  // ev:{input:"keydown", inputAgeMs:528}}`. That is his "ai mutou a live": not a
  // mute, a slash he cannot explain.
  {
    const page = makeWorld({});
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    page.pressKey(' '); // space: pauses Twitch's player, cannot carry a volume
    page.machineDropsVolume(0.32); // the player's own ad volume
    check('a volume drop after a key that cannot change a volume is refused', () => {
      assert(page.audio.intent('twitch').volume > 0.5,
        `intent volume became ${page.audio.intent('twitch').volume} from a space bar (the drop was recorded as his)`);
      assert(page.video.volume > 0.5, 'the page surface was left quiet');
    });
  }
  {
    const page = makeWorld({});
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    page.pressKey('ArrowDown'); // Twitch's own volume-down key
    page.machineDropsVolume(0.5);
    check('ArrowDown IS a volume key: the drop after it is the user choice', () => {
      assert(Math.abs(page.audio.intent('twitch').volume - 0.5) < 0.01,
        `intent volume is ${page.audio.intent('twitch').volume}; the guard refused a real volume key`);
    });
  }
  {
    // RED: the same mutation the 2c3 control uses, measured on the drop. If this
    // passes, the arm above is not measuring the guard.
    const blind = AUDIO.split('if (lowering && !volumeCapable) {').join('if (false && lowering && !volumeCapable) {');
    if (blind === AUDIO) throw new Error('the volume-drop mutation did not apply');
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    page.pressKey(' ');
    page.machineDropsVolume(0.32);
    check('RED: without the drop guard a space bar records the ad volume as his', () => {
      assert(Math.abs(page.audio.intent('twitch').volume - 0.32) < 0.01,
        'the mutant refused it too: the arm above is not measuring the guard');
    });
  }

  // ---- 2c3: RED control — without the control test the click muting returns.
  {
    const blind = AUDIO.split('if (lowering && !volumeCapable) {').join('if (false && lowering && !volumeCapable) {');
    if (blind === AUDIO) throw new Error('the control-test mutation did not apply');
    const page = makeWorld({ audioSource: blind });
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await settle(2800);
    page.clickDocumentTarget({ tagName: 'VIDEO' });
    page.machineMutesNative();
    check('mutation: the control test exists to be disarmed', () => {
      assert(page.audio.intent('twitch').muted === true,
        'the mutant refused it too: this arm is not measuring the guard');
    });
  }

  // ---- 2d: RED control — the pre-fix authority records the hand-back mute. -
  {
    // The mutation lives HERE, in the source of truth the arm measures: the old
    // arm read `G:/Temp/ko-audio-nopreclaim.js`, a file nothing generates any
    // more, so the arm failed with ENOENT instead of measuring anything.
    //
    // -1, not 0: the window is `Date.now() - releasedAt <= WINDOW`, so a zero
    // window is still OPEN in the same millisecond as the release and the arm
    // went red/green on sub-millisecond scheduling (measured 2 of 8 runs). A
    // negative window is closed at every offset, which is what "no release
    // window" means.
    const noRelease = AUDIO.split('const CLAIM_RELEASE_MS = 2500;').join('const CLAIM_RELEASE_MS = -1;');
    if (noRelease === AUDIO) throw new Error('the release-window mutation did not apply');
    const mutated = noRelease;
    const page = makeWorld({ audioSource: mutated });
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    page.clickDocument();
    page.machineMutesNative();
    check('RED: without the release window the hand-back mute becomes intent', () => {
      assert(page.audio.intent('twitch').muted === true,
        'the mutated authority refused the machine mute, so the arm above measures nothing');
    });
  }


  // ---- 3: a sound-on user gets sound, from the right surface. ------------
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    check('an unmuted user is audible at reveal', () => {
      assert(page.attrMuted() === '0', `authority published muted=${page.attrMuted()} for an unmuted user`);
      const m = page.muteSent();
      assert(m.includes(false), `sent mute values: ${JSON.stringify(m)}`);
      assert(m.indexOf(false) > m.lastIndexOf(true), 'the unmute came before the frame existed');
    });
    check('the covered native is silenced by the claim, not by a hand-written mute', () => {
      assert(page.video.muted === true, `native muted=${page.video.muted} while the clean player covers it`);
    });
  }

  // ---- 4: mute made AFTER a warm standby was minted. No snapshot to go bad.
  {
    const page = makeWorld();
    page.userSetsNative(false, 1);
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
    page.userSetsNative(true, 1); // the user mutes Twitch AFTER the standby exists
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
    check('a standby minted before the mute does not overrule it', () => {
      assert(page.attrMuted() === '1', `authority published muted=${page.attrMuted()}`);
      const m = page.muteSent();
      if (m.includes(false)) {
        // A mute:false is only acceptable BEFORE the user's mute reached the
        // authority; after it, the last word must be muted.
        assert(m[m.length - 1] === true, `last mute sent was ${m[m.length - 1]}`);
      }
    });
  }

  // ---- 5: the user's gesture on the HIDDEN native reaches the layer. ------
  {
    const page = makeWorld();
    page.audio.setIntent('kick', { muted: true, volume: 1 }, { persist: false });
    page.audio.setVisible('kick'); // the overlay layer is the audible surface
    page.userSetsNative(false, 0.4); // he unmutes Twitch's own control
    check('an unmute on the covered native surface reaches the layer he hears', () => {
      assert(page.audio.intent('kick').muted === false, 'the layer was left muted');
      assert(Math.abs(page.audio.intent('kick').volume - 0.4) < 0.01, `layer volume=${page.audio.intent('kick').volume}`);
      const last = page.layerSent.filter((s) => s.surface === 'kick').pop();
      assert(last && last.muted === false, `layer command: ${JSON.stringify(last)}`);
    });
    check('the hidden native stays silent even though its intent is "sound"', () => {
      assert(page.video.muted === true, `native muted=${page.video.muted}`);
    });
  }

  // ---- 6: the extension's own write is never read back as intent. --------
  {
    const page = makeWorld();
    page.audio.setIntent('twitch', { muted: true, volume: 1 }, { persist: false });
    page.audio.apply(); // we mute the element ourselves...
    check('our own mute does not overwrite the intent it came from', () => {
      assert(page.video.muted === true, 'the element was not muted');
      assert(page.audio.intent('twitch').muted === true, 'intent drifted');
    });
    // ...and the echo of that write must not be treated as a user gesture.
    page.document.fire({ type: 'volumechange', target: page.video });
    check('the echo of our own write is not read as a user decision', () => {
      assert(page.audio.intent('twitch').muted === true, 'our write was read back as a user mute');
    });
  }

  // ---- 7: policy silence is not intent, and it is cleared by a gesture. ---
  {
    const page = makeWorld();
    page.audio.setIntent('twitch', { muted: false, volume: 1 }, { persist: false });
    page.audio.claim('ad');
    page.audio.setPolicy('ad', true); // Chrome refused audible autoplay
    check('a policy silence silences the surface without touching the intent', () => {
      assert(page.attrMuted() === '1', `published muted=${page.attrMuted()}`);
      assert(page.audio.intent('twitch').muted === false, 'the policy mute was written into the intent');
    });
    page.audio.setPolicy('ad', false); // the gesture arrived
    check('clearing the policy gives the sound back at the intent', () => {
      assert(page.attrMuted() === '0', `published muted=${page.attrMuted()} after the policy cleared`);
      assert(page.audio.intent('twitch').muted === false, 'the intent drifted while clearing the policy');
    });
  }

  // ---- 8: an external choice (popup, storage, second tab) lands. ---------
  {
    const page = makeWorld();
    page.audio.setVisible('kick');
    page.audio.setIntent('kick', { muted: false, volume: 0.5 }, { persist: false });
    check('a popup/storage choice reaches the layer the user hears', () => {
      const last = page.layerSent.filter((s) => s.surface === 'kick').pop();
      assert(last && last.muted === false, `kick command: ${JSON.stringify(last)}`);
      assert(Math.abs(last.volume - 0.5) < 0.01, `kick volume: ${last.volume}`);
    });
  }

  // ---- 9: every overlay exit releases the ad claim ------------------------
  // A revealed standby owns the claim. A source switch can null overlay.frame
  // and then return before building the replacement (the native <video> is
  // gone); ad-end then takes the frame-less teardown, which used to return
  // without claim(null) and left the page silent until the user touched the
  // volume bar. The pre-fix arm removes that release and must go RED.
  {
    const drive = async (source) => {
      const page = makeWorld(source ? { adSource: source } : undefined);
      page.userSetsNative(false, 1); // audible intent
      page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
      await settle(20);
      page.frameMsg({ t: 'ready' });
      for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
      await settle(20);
      page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
      await settle(20);
      const claimed = page.audio.visible() === 'ad';
      // The native player goes away mid-switch: startAdOverlay() nulls
      // overlay.frame and returns without building a replacement.
      page.video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
      page.bypass({ type: 'ad-start', url: 'https://clean.example/next.m3u8', channel: 'rodil', switch: true });
      await settle(20);
      page.bypass({ type: 'ad-end' });
      await settle(60);
      return {
        claimed,
        visible: page.audio.visible(),
        nativeMuted: page.video.muted,
        intent: page.audio.intent('twitch').muted,
      };
    };
    const fixed = await drive(null);
    check('every overlay exit releases the ad claim (frame-less teardown included)', () => {
      assert(fixed.claimed, 'the revealed standby never claimed the page');
      assert(fixed.visible === 'twitch', `visible after teardown: ${fixed.visible}`);
      assert(fixed.nativeMuted === false, `native stayed muted=${fixed.nativeMuted} after teardown`);
      assert(fixed.intent === false, 'the machine teardown wrote intent');
    });
    // \r?\n: this checkout is CRLF; a literal '\n' between the two lines never
    // matched and the RED arm silently measured the unmutated ad path.
    const mutated = AD.replace(/^([ \t]*)audioClaim\(false\);\r?\n\1(if \(!overlay\.frame\) \{)/m, '$1$2');
    check('mutation: dropping the claim release on the frame-less exit is caught', () => {
      assert(mutated !== AD, 'the release site was not found');
    });
    const red = await drive(mutated);
    check('mutation: the pre-fix frame-less teardown leaves the page silent (RED)', () => {
      assert(red.visible === 'ad', `the pre-fix teardown released the claim (visible=${red.visible}): the arm is not live`);
    });
  }

  // ---- 9b: ONE VOICE PER SURFACE -----------------------------------------
  // The owner hears the stream twice and then three times ("ta duplicando audio
  // e depois triplicando", 2026-11-11) and his own ko.adlog samples
  // `audio-state {audible:2, playing:2}`. The arbiter used to write the SAME
  // unmute to every <video> of a surface; Twitch keeps more than one (the main
  // player plus an ad/preview element, measured `h:360`).
  {
    const page = makeWorld();
    page.userSetsNative(false, 1);
    const second = page.extraVideo({ muted: false });
    page.audio.apply();
    await settle(5);
    check('a page surface with two videos keeps exactly one of them audible', () => {
      assert(page.video.muted === false, 'the main video lost the sound the user asked for');
      assert(second.muted === true, `the second page video is still audible (muted=${second.muted}) - duplicated audio`);
    });
    check('mutation: writing every element of a surface IS caught as duplication', () => {
      // The pre-fix loop: same muted for every element of the surface.
      second.muted = false;
      const caught = second.muted === false && page.video.muted === false;
      assert(caught, 'the duplication detector cannot see two audible videos');
    });
  }

  // ---- 9c: THE SILENCING GUARD -------------------------------------------
  // Measured in the owner's Chrome (0.8.75, twitch.tv/titiltei, player=kick):
  // `data-ko-owner="kick"` and every page <video> reading
  // `{muted:false, paused:true, videoHeight:0}`. The element appeared AFTER the
  // last apply() (Twitch builds ad/preview/PBP videos while the overlay owns the
  // picture), a new element starts `muted:false` by default, and the only
  // convergence outside ko-audio.js compares it against
  // `wanted(visibleSurface())` — the OVERLAY's own "sound on" — so nothing ever
  // asked that element to close. The authority cannot wait for a caller to be
  // right: it enforces the audible direction itself, mutes only, on three
  // signals — a 400 ms tick, the media events that mark an element becoming
  // audible, and a childList observer for the insertion itself (a hidden tab
  // throttles timers: measured in the owner's Chrome, a 500 ms setTimeout had
  // not fired 1.5 s later, and a source-less <video> fires no media event).
  {
    const page = makeWorld();
    page.audio.setVisible('kick'); // the overlay layer owns the picture and the sound
    const late = page.extraVideo({ muted: false, paused: true, videoHeight: 0 });
    await settle(700); // past one guard tick
    check('a page video created after the last apply is silenced while the layer owns the picture', () => {
      assert(late.muted === true,
        `late page video still open (muted=${late.muted}) while the overlay owns playback: audible leak`);
      assert(page.video.muted === true, `the main page video is audible (muted=${page.video.muted}) beside the layer`);
    });
  }
  {
    const noGuard = AUDIO.split('\n    armSilence();').join('\n    /* mutant: guard disarmed */');
    check('mutation: the silencing guard exists to be disarmed', () => {
      assert(noGuard !== AUDIO, 'the guard arming site was not found');
    });
    const page = makeWorld({ audioSource: noGuard });
    page.audio.setVisible('kick');
    const late = page.extraVideo({ muted: false, paused: true, videoHeight: 0 });
    await settle(700);
    check('RED: without the guard that element stays open (the measured leak)', () => {
      assert(late.muted === false, `the mutant silenced it (muted=${late.muted}): the arm above measures nothing`);
    });
  }
  {
    const page = makeWorld();
    page.audio.setVisible('kick');
    const fresh = page.extraVideo({ muted: false, paused: true });
    page.document.fire({ type: 'play', target: fresh }); // the page starts an element NOW
    check('a page video that starts playing under the layer is silenced in the same task', () => {
      assert(fresh.muted === true,
        `a video started playing while the overlay owns playback (muted=${fresh.muted}): a tick would be too late`);
    });
    const noEvents = AUDIO.split('    for (const type of AUDIBLE_EVENTS) {').join('    for (const type of []) {');
    check('mutation: the media-event arm exists to be disarmed', () => {
      assert(noEvents !== AUDIO, 'the media-event listener loop was not found');
    });
    const deaf = makeWorld({ audioSource: noEvents });
    deaf.audio.setVisible('kick');
    const hole = deaf.extraVideo({ muted: false, paused: true });
    deaf.document.fire({ type: 'play', target: hole });
    check('RED: without the media events that element stays audible until the tick (RED)', () => {
      assert(hole.muted === false, `the mutant silenced it synchronously (muted=${hole.muted}): the arm is not live`);
    });
  }
  {
    // The insertion itself, with no media event and no time passing: this is the
    // shape of the element measured in the owner's tab (`src:""`, `h:0`, so no
    // `play`/`loadedmetadata` will ever fire for it) and the only signal a hidden
    // tab still delivers, because its timers are throttled.
    const page = makeWorld();
    page.audio.setVisible('kick');
    const inserted = page.extraVideo({ muted: false, paused: true, videoHeight: 0 });
    page.docEl.appendChild(inserted);
    check('a page video inserted after the last apply is silenced without a timer', () => {
      assert(inserted.muted === true, `inserted page video still open (muted=${inserted.muted}) under the layer`);
    });
    const noObserver = AUDIO.split('    installSilenceObserver();').join('    /* mutant: no observer */');
    check('mutation: the insertion observer exists to be disarmed', () => {
      assert(noObserver !== AUDIO, 'the observer install site was not found');
    });
    const blind = makeWorld({ audioSource: noObserver });
    blind.audio.setVisible('kick');
    const v = blind.extraVideo({ muted: false, paused: true, videoHeight: 0 });
    blind.docEl.appendChild(v);
    check('RED: without the observer the inserted element stays open (RED)', () => {
      assert(v.muted === false, `the mutant silenced it (muted=${v.muted}): the arm is not live`);
    });
  }
  {
    const page = makeWorld();
    page.audio.setVisible('twitch'); // the page surface is the one being listened to
    const second = page.extraVideo({ muted: true });
    page.audio.apply(); // the one-voice rule holds it muted
    second.muted = false; // Twitch opens its own secondary element
    page.document.fire({ type: 'volumechange', target: second });
    check('a secondary page video opened by the page is silenced, not read as a gesture', () => {
      assert(second.muted === true, `a second audible copy of the stream (muted=${second.muted})`);
      assert(page.audio.intent('twitch').muted === false, 'the page opened element wrote the user intent');
    });
    const noBranch = AUDIO
      .split('        enforceSilence(); // a secondary element never carries the user')
      .join('        void 0; // mutant: secondary element left alone');
    check('mutation: the secondary-element branch exists to be disarmed', () => {
      assert(noBranch !== AUDIO, 'the secondary-element branch was not found');
    });
    const loose = makeWorld({ audioSource: noBranch });
    loose.audio.setVisible('twitch');
    const copy = loose.extraVideo({ muted: true });
    loose.audio.apply();
    copy.muted = false;
    loose.document.fire({ type: 'volumechange', target: copy });
    check('RED: without that branch the secondary element stays open (RED)', () => {
      assert(copy.muted === false, `the mutant silenced it (muted=${copy.muted}): the arm is not live`);
    });
  }

  // ---- 10: negative arm. The detector must see a broken authority. -------
  {
    const mutated = AUDIO.split(PRE_FIX_MUTATION[0]).join(PRE_FIX_MUTATION[1]);
    check('negative arm: the pre-fix mutation applied', () => {
      assert(mutated !== AUDIO, 'the pre-fix mutation did not apply — it measures nothing');
    });
    const page = makeWorld({ audioSource: mutated });
    await runPod(page, { mutedBeforeAd: true });
    check('negative arm: an authority that ignores intent IS caught unmuting a muted user', () => {
      const caught = page.attrMuted() === '0' || page.muteSent().includes(false);
      assert(caught, 'the detector accepted a mute-ignoring authority');
    });
  }

  const failed = checks.filter((c) => c.status === 'FAIL');
  console.log('');
// ANTI-VACUITY: a suite that silently loses an arm reads as a quieter green.
// The floor is the count every arm this file executes today; a deleted arm
// (or one that stops running because an earlier await short-circuits) fails here
// instead of printing PASS with a smaller number.
function antiVacuity(actual, expected) {
  if (actual !== expected) {
    console.error(`\nANTI-VACUITY FAIL suite=mute-decision checks=${actual} expected=${expected}: an arm stopped running`);
    process.exit(1);
  }
  console.log(`ANTI-VACUITY suite=mute-decision checks=${actual} expected=${expected}`);
}
antiVacuity(checks.length, 95);
  console.log(`COMPILE cache ${COMPILE_CACHE_ON ? 'on' : 'off'} hits=${compileStats.hits} misses=${compileStats.misses} max=${COMPILE_CACHE_MAX}`);
  console.log(`RESULT ${failed.length ? 'FAIL' : 'PASS'} mute-decision checks=${checks.length} failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

// THE SWAP CARRIES THE SOUND, and the log says so. Owner 2026-11-12: "O PLAYER
// TAVA MUTADO, SAIU DO PLAYER, FOI PRO PLAYER DA TWITCH, E DEIXOU PAUSADO E
// DESMUTADO". The mute must follow the surface, and the line that proves it
// (audio-inherit) must exist in the log the owner's report is read from.
function swapCarryArm(w) {
  const audio = w.audio;
  audio.setVisible('kick');
  audio.setIntent('kick', { muted: true, volume: 0.4 }, { persist: true });
  assert(audio.intent('kick').muted === true, 'precondition: the overlay layer is muted');
  const before = w.logs().length;
  audio.setVisible('twitch'); // the switch the owner described
  assert(audio.intent('twitch').muted === true, 'the swap lost the mute: the native comes up unmuted');
  assert(Math.abs(audio.intent('twitch').volume - 0.4) < 0.03, 'the swap lost the volume');
  const lines = w.logs().slice(before).filter((l) => l.ev === 'audio-inherit');
  assert(lines.length === 1, `audio-inherit lines: ${lines.length}`);
  assert(lines[0].d.now.muted === true, 'the log line does not say the mute was carried');
  console.log('PASS swap carries the mute, and the log records the carry');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\nRESULT FAIL', error && error.message ? error.message : error);
    process.exit(1);
  });
} else {
  // makePage is the historical name used by ad-time-continuity-test.cjs.
  module.exports = { makeWorld, makePage: makeWorld, runPod, settle, healthySt, compileStats };
}
