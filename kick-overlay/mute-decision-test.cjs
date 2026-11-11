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

const AD = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8');
const AUDIO = fs.readFileSync(path.join(__dirname, 'ko-audio.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(__dirname, 'adblock-bridge.js'), 'utf8');

const PRE_FIX_MUTATION = [
  'muted: !!(it.muted || policy.has(surface) || visibleNow() !== surface),',
  'muted: !!(policy.has(surface) || visibleNow() !== surface),',
];

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
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    });
    return n;
  };

  const docEl = node('html');
  docEl.setAttribute('data-ko-adblock', '1');
  docEl.setAttribute('data-ko-ext-id', 'test');

  const body = node('body');
  const frameWindow = {
    postMessage: (payload) => sent.push(payload && payload.__koKick),
  };
  let createdFrame = null;
  const createdDivs = [];

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
        setTimeout(() => {
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
    querySelectorAll: (sel) => (sel === 'video' ? [video] : []),
    getElementById: () => null,
    dispatchEvent(ev) {
      if (ev && ev.type === 'ko-adlog') {
        try {
          adLogs.push(JSON.parse(ev.detail));
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
    postMessage() {}
  }
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
    const factory = new Function(
      'window', 'document', 'location', 'navigator', 'performance', 'BroadcastChannel',
      'CustomEvent', 'MutationObserver', 'XMLHttpRequest', 'Blob', 'URL', 'btoa', 'chrome',
      'console', 'setTimeout', 'clearTimeout',
      `${source}\n//# sourceURL=${name}`,
    );
    factory(
      window, document, location, { userAgent: 'node' }, { now: () => Date.now() },
      BroadcastChannel, CustomEvent, MutationObserver, XMLHttpRequest, class Blob {}, URLStub,
      (s) => Buffer.from(String(s)).toString('base64'), chromeStub, console, setTimeout, clearTimeout,
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
  audio.registerNative('twitch', { elements: () => [video], main: () => video });
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
      const ch = bcInstances.find((c) => c.name === 'ko-adblock-bypass');
      // The real handler refuses a message that is not addressed to this page.
      const pageId = (window.__koTwitchAdblockStats && window.__koTwitchAdblockStats.pageId) || '';
      if (ch && ch.onmessage) ch.onmessage({ data: { page: pageId, ...msg } });
    },
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
    // The MACHINE muting the page video while a click is still fresh (owner
    // report 2026-11-11: he clicks to recover the delay, Twitch mutes its own
    // element as the pod takes over). No pointerdown is fired here: the click
    // the test sent a moment ago is what makes the event look attributable.
    machineMutesNative() {
      video.muted = true;
      document.fire({ type: 'volumechange', target: video });
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
    logs: () => adLogs,
  };
  return api;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // ---- 1: the report. A muted user, an ad swaps the player. --------------
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: true });
    check('a muted user is not unmuted at reveal', () => {
      assert(page.frame && page.frame.removed === false, 'clean frame was removed instead of revealed');
      assert(page.attrMuted() === '1', `authority published muted=${page.attrMuted()} for a muted user`);
      assert(!page.muteSent().includes(false), `sent mute:false -> ${JSON.stringify(page.muteSent())}`);
    });
    check('a muted user sees the click-to-sound badge', () => {
      assert(/clique para som/.test(page.badge.textContent), `badge text: ${page.badge.textContent}`);
    });
    check('a click elsewhere on the page does not unmute a muted user', () => {
      page.clickDocument();
      assert(!page.muteSent().includes(false), 'a generic page click restored the audio');
    });
    check('an explicit badge click unmutes the player and persists the choice', () => {
      page.clickBadge();
      assert(page.muteSent().includes(false), 'the badge click did not unmute');
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

  // ---- 2c: positive control — the SAME event well after the window IS his. -
  {
    const page = makeWorld();
    await runPod(page, { mutedBeforeAd: false });
    page.bypass({ type: 'ad-end' });
    await new Promise((r) => setTimeout(r, 2800));
    page.clickDocument();
    page.machineMutesNative();
    check('a mute 3 s after the hand-back is recorded as intent', () => {
      assert(page.audio.intent('twitch').muted === true,
        'a real mute outside the machine window was discarded (detector measures nothing)');
    });
  }

  // ---- 2d: RED control — the pre-fix authority records the hand-back mute. -
  {
    const mutated = fs.readFileSync('G:/Temp/ko-audio-nopreclaim.js', 'utf8');
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
    const mutated = AD.replace('    audioClaim(false);\n    if (!overlay.frame) {', '    if (!overlay.frame) {');
    check('mutation: dropping the claim release on the frame-less exit is caught', () => {
      assert(mutated !== AD, 'the release site was not found');
    });
    const red = await drive(mutated);
    check('mutation: the pre-fix frame-less teardown leaves the page silent (RED)', () => {
      assert(red.visible === 'ad', `the pre-fix teardown released the claim (visible=${red.visible}): the arm is not live`);
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
  console.log(`RESULT ${failed.length ? 'FAIL' : 'PASS'} mute-decision checks=${checks.length} failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\nRESULT FAIL', error && error.message ? error.message : error);
    process.exit(1);
  });
} else {
  // makePage is the historical name used by ad-time-continuity-test.cjs.
  module.exports = { makeWorld, makePage: makeWorld, runPod, settle, healthySt };
}
