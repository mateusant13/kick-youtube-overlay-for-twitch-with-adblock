// Per-TAB audio scope.
//
// Owner report 2026-11-08: "tua implementacao de MERDA na extensao faz eu mutar
// uma aba e todas mutarem. e vice versa."
//
// Measured cause: the mute/volume intent lived in the shared `ko.v2` record, and
// every tab's `chrome.storage.onChanged` fed it back into that tab's arbiter —
// so one tab's gesture muted every other tab. The contract now is: the intent is
// TAB-LOCAL (ko-audio.js, sessionStorage) and the shared record carries no audio
// at all.
//
// This harness runs the REAL ko-audio.js in one world per simulated tab and
// checks: (1) a gesture in tab A never reaches tab B, (2) a reload of tab A
// restores A's own choice, (3) a fresh tab starts clean, (4) the instrument CAN
// see coupling when a shared row is applied (positive control for the arm above),
// (5) the source fence that keeps content.js from re-introducing the shared row,
// with a mutation proving the fence fires.
//
// `node tab-audio-scope-test.cjs`
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const AUDIO = fs.readFileSync(path.join(__dirname, 'ko-audio.js'), 'utf8').replace(/\r\n/g, '\n');
const CONTENT = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const TAB_KEY = 'ko.audio.v2';
// content.js keeps its shared record under its own row (`ko.v2`), and its
// chrome.storage.onChanged listener returns immediately when `changes[KEY]` is
// absent. Compiling that listener into a tab world therefore needs content.js's
// key, not the arbiter's per-tab one.
const CONTENT_KEY = 'ko.v2';

let checks = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    checks++;
    console.log('PASS ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ' :: ' + e.message);
  }
};

// One browser tab: its own window, its own sessionStorage, its own arbiter.
const makeTab = (seedSource, opts) => {
  const active = !(opts && opts.active === false);
  const source = (opts && opts.source) || AUDIO;
  const store = new Map(seedSource ? seedSource : []);
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const listeners = Object.create(null);
  const on = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
  const document = {
    addEventListener: on,
    documentElement: { setAttribute() {} },
    querySelectorAll: () => [],
  };
  // `navigator.userActivation` is the SECOND, non-decisive signal; freshness of
  // a real input is what decides (see the arm below).
  const win = {
    sessionStorage,
    navigator: { userActivation: { hasBeenActive: active } },
    addEventListener: on,
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'console', `${source}\n//# sourceURL=ko-audio-tab`)(win, document, console);
  if (!win.KOAudio) throw new Error('ko-audio.js did not expose KOAudio');
  const fireAll = (type, ev) => (listeners[type] || []).slice().forEach((f) => f(ev));
  const input = (type) => fireAll(type || 'pointerdown', { type: type || 'pointerdown' });
  return {
    audio: win.KOAudio,
    store,
    snapshot: () => new Map(store),
    input,
    gesture: (el) => {
      input('pointerdown'); // a real gesture precedes the volumechange
      el.muted = !el.muted;
      fireAll('volumechange', { target: el });
    },
    // Fire the reader without flipping the value: how a browser-initiated
    // (autoplay) mute arrives.
    fire: (el) => fireAll('volumechange', { target: el }),
  };
};

// Move the wall clock the arbiter reads, without a real sleep: the freshness
// gate compares Date.now() with the last input, so this is how an event that
// lands seconds after the gesture is modelled.
const withClock = (delta, fn) => {
  const real = Date.now;
  Date.now = () => real() + delta;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
};

const videoEl = () => ({ tagName: 'VIDEO', isConnected: true, muted: false, volume: 1 });

// The cross-tab writer SHIPPED before ca471a4 (content.js applyVols), kept
// verbatim. It applied one shared `vols` row in EVERY tab via KOAudio.setIntent.
// The positive control below fires a real storage row through this function.
const PREFIX_APPLY_VOLS = `function applyVols(vols) {
  vols = vols || {};
  const audio = window.KOAudio;
  const kv = vols.kick || {};
  const yv = vols.yt || {};
  const tv = vols.twitch || {};
  const pv = vols.page || {};
  const norm = (v) => Math.max(0, Math.min(1, v > 1 ? v / 100 : v));
  if (audio) {
    audio.setIntent('kick', {
      muted: typeof kv.m === 'boolean' ? kv.m : undefined,
      volume: typeof kv.v === 'number' ? norm(kv.v) : undefined,
    });
    audio.setIntent('yt', {
      muted: typeof yv.m === 'boolean' ? yv.m : undefined,
      volume: typeof yv.v === 'number' ? norm(yv.v) : undefined,
    });
    audio.setIntent('twitch', {
      muted: typeof tv.m === 'boolean' ? tv.m : undefined,
      volume: typeof tv.v === 'number' ? norm(tv.v) : undefined,
    });
    audio.setIntent('page', {
      muted: typeof pv.m === 'boolean' ? pv.m : undefined,
      volume: typeof pv.v === 'number' ? norm(pv.v) : undefined,
    });
  }
  if (typeof kv.v === 'number') KO.kickVol = norm(kv.v);
  if (typeof kv.m === 'boolean') KO.kickMuted = kv.m;
  if (typeof yv.v === 'number') KO.ytVol = norm(yv.v);
  if (typeof yv.m === 'boolean') KO.ytMuted = yv.m;
}`;

const sharedVolsRow = () => ({ 'ko.v2': {
  oldValue: { enabled: true, player: 'kick', mappings: {} },
  newValue: { enabled: true, player: 'kick', mappings: {}, vols: { twitch: { v: 0.3, m: true } } },
} });

// Compile the SHIPPED chrome.storage.onChanged registration into a tab world.
// The pre-fix writer is in scope, but only the mutation calls it; the shipped
// listener never references it. The row travels through the registered chrome
// stub, not through a test-authored predicate.
const storageWorld = (tab, source) => {
  const marker = 'chrome.storage.onChanged.addListener(';
  const start = source.indexOf(marker);
  assert.ok(start > 0, 'content.js registers chrome.storage.onChanged');
  const end = source.indexOf('// ---- helpers ----', start);
  assert.ok(end > start, 'the listener ends before helpers');
  const close = source.lastIndexOf('\n});', end);
  assert.ok(close > start, 'the listener closing brace was found');
  const registration = source.slice(start, close + 4);
  let listener = null;
  const chrome = { storage: { onChanged: { addListener: (f) => { listener = f; } } } };
  const KO = {
    enabled: true, adblock: true, player: 'kick', playerPreference: 'kick',
    mappings: {}, slug: null,
  };
  const fireFn = (f) => f();
  const apply = () => {};
  const onYtHost = () => false;
  const mirrorAudio = () => {
    KO.kickMuted = tab.audio.intent('kick').muted;
    KO.kickVol = tab.audio.intent('kick').volume;
    KO.ytMuted = tab.audio.intent('yt').muted;
    KO.ytVol = tab.audio.intent('yt').volume;
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'chrome', 'KEY', 'KO', 'mirrorAudio', 'fire', 'apply', 'onYtHost',
    `${PREFIX_APPLY_VOLS}\n${registration}`)(
    { KOAudio: tab.audio }, chrome, CONTENT_KEY, KO, mirrorAudio, fireFn, apply, onYtHost,
  );
  assert.ok(typeof listener === 'function', 'the real storage listener was registered');
  return { KO, fire: (changes) => listener(changes, 'local') };
};

const withSharedVolsWrite = (source) => {
  const anchor = '  if (pChanged) fire(apply); // hot toggle / remap / player switch — no page reload';
  const mutated = source.replace(anchor, `  applyVols(s.vols); // pre-fix cross-tab write\n${anchor}`);
  assert.notStrictEqual(mutated, source, 'the pre-fix call site was found');
  return mutated;
};

const victimTab = () => {
  const tab = makeTab();
  const v = videoEl();
  tab.audio.registerNative('twitch', { elements: () => [v], main: () => v });
  tab.audio.setVisible('twitch');
  return { tab, v };
};

// ---- 1. a gesture in tab A is invisible to tab B ---------------------------
const tabA = makeTab();
const tabB = makeTab();
const vA = videoEl();
const vB = videoEl();
for (const [tab, v] of [[tabA, vA], [tabB, vB]]) {
  tab.audio.registerNative('twitch', { elements: () => [v], main: () => v });
  tab.audio.setVisible('twitch');
  tab.audio.apply();
}

check('baseline: both tabs start unmuted and audible', () => {
  assert.strictEqual(tabA.audio.intent('twitch').muted, false);
  assert.strictEqual(tabB.audio.intent('twitch').muted, false);
  assert.strictEqual(vA.muted, false, 'tab A native follows its own intent');
  assert.strictEqual(vB.muted, false, 'tab B native follows its own intent');
});

tabA.gesture(vA); // the user mutes tab A

check('a mute gesture in tab A mutes A only (the owner report)', () => {
  assert.strictEqual(tabA.audio.intent('twitch').muted, true, 'tab A is muted');
  assert.strictEqual(vA.muted, true, 'tab A native is muted');
  assert.strictEqual(tabB.audio.intent('twitch').muted, false, 'tab B intent untouched');
  assert.strictEqual(vB.muted, false, 'tab B native still audible');
});

check('unmuting in tab A does not unmute tab B (and vice versa)', () => {
  tabA.gesture(vA); // unmute A
  assert.strictEqual(tabA.audio.intent('twitch').muted, false);
  tabB.gesture(vB); // mute B
  assert.strictEqual(tabB.audio.intent('twitch').muted, true);
  assert.strictEqual(tabA.audio.intent('twitch').muted, false, 'B mute never reaches A');
  assert.strictEqual(vA.muted, false, 'A native stays audible');
});

// ---- 2. a reload of the SAME tab restores that tab's choice ----------------
const tabC = makeTab();
tabC.audio.setIntent('twitch', { muted: true, volume: 0.35 });
const reloaded = makeTab(tabC.snapshot());
check('a reload of tab A restores tab A own choice', () => {
  assert.ok(tabC.store.has(TAB_KEY), 'the choice was persisted for this tab');
  assert.strictEqual(reloaded.audio.intent('twitch').muted, true, 'reload restores the mute');
  assert.strictEqual(reloaded.audio.intent('twitch').volume, 0.35, 'and its volume');
  const fresh = makeTab();
  assert.strictEqual(fresh.audio.intent('twitch').muted, false, 'a different tab starts at the default');
  assert.strictEqual(fresh.audio.intent('kick').muted, false, 'every surface starts audible (no default mute); "one at a time" is the visibility rule');
});

// ---- 3. positive control: a shared storage row CAN cross into a tab --------
// The real pre-fix applyVols(s.vols) writer is compiled into the tab world and
// the row is delivered through chrome.storage.onChanged. If this cannot flip
// the victim, the fence arm below is not measuring anything.
check('positive control: the pre-fix shared vols row DOES mute the victim', () => {
  const { tab, v } = victimTab();
  assert.strictEqual(tab.audio.intent('twitch').muted, false, 'the victim starts audible');
  storageWorld(tab, withSharedVolsWrite(CONTENT)).fire(sharedVolsRow());
  assert.strictEqual(tab.audio.intent('twitch').muted, true, 'the shared row flips the victim under the pre-fix writer');
  assert.strictEqual(v.muted, true, 'and its native element is muted');
});

// ---- 3b. the UI mirror reads the arbiter, never a stored copy -------------
// content.js keeps KO.kickMuted/kickVol/ytMuted/ytVol only as the bar's mirror;
// mirrorAudio() derives them from the arbiter's intent and runs at boot and on
// every intent change. Extract the shipped function and drive it.
const mirrorSource = (() => {
  const start = CONTENT.indexOf('function mirrorAudio() {');
  assert.ok(start > 0, 'mirrorAudio() exists in content.js');
  let depth = 0;
  for (let i = CONTENT.indexOf('{', start); i < CONTENT.length; i++) {
    if (CONTENT[i] === '{') depth++;
    else if (CONTENT[i] === '}') {
      depth--;
      if (depth === 0) return CONTENT.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced mirrorAudio()');
})();

check('mirrorAudio copies the arbiter intent into the UI mirror', () => {
  const KO = { audioNative: 'twitch' };
  const intents = {
    kick: { muted: true, volume: 0.4 },
    yt: { muted: false, volume: 0.8 },
    page: { muted: true, volume: 0.2 },
  };
  const audio = { intent: (s) => intents[s] || { muted: false, volume: 1 } };
  let ui = 0;
  // eslint-disable-next-line no-new-func
  new Function('KO', 'window', 'updateKickVolUI', `${mirrorSource}; mirrorAudio();`)(KO, { KOAudio: audio }, () => { ui++; });
  assert.deepStrictEqual(
    { kickMuted: KO.kickMuted, kickVol: KO.kickVol, ytMuted: KO.ytMuted, ytVol: KO.ytVol },
    { kickMuted: true, kickVol: 0.4, ytMuted: false, ytVol: 0.8 },
    'mirror follows the arbiter',
  );
  assert.strictEqual(KO.pageMuted, undefined, 'the page row is not touched on a twitch page');
  assert.strictEqual(ui, 1, 'the bar redraws exactly once');
  KO.audioNative = 'page';
  // eslint-disable-next-line no-new-func
  new Function('KO', 'window', 'updateKickVolUI', `${mirrorSource}; mirrorAudio();`)(KO, { KOAudio: audio }, () => {});
  assert.strictEqual(KO.pageMuted, true, 'the page surface mirrors its own row on a youtube host');
  assert.strictEqual(KO.pageVol, 0.2);
});

// ---- 3c. a swap carries the user's sound (owner rule 2026-11-09) ----------
// "se antes tava desmutado > vai pra desmutado no player. e vice versa."
const swapWorld = () => {
  const tab = makeTab();
  const els = { twitch: videoEl(), kick: videoEl(), yt: videoEl() };
  const written = [];
  tab.audio.registerNative('twitch', { elements: () => [els.twitch], main: () => els.twitch });
  tab.audio.register('kick', { write: (s2) => written.push(['kick', s2.muted, +s2.volume.toFixed(2)]) });
  tab.audio.register('yt', { write: (s2) => written.push(['yt', s2.muted, +s2.volume.toFixed(2)]) });
  tab.audio.setVisible('twitch');
  tab.audio.apply();
  return { tab, els, written };
};

check('swap to the kick player keeps an UNMUTED live unmuted', () => {
  const { tab, written } = swapWorld();
  tab.audio.setIntent('twitch', { muted: false, volume: 0.6 });
  tab.audio.setVisible('kick');
  assert.strictEqual(tab.audio.intent('kick').muted, false, 'the incoming player is not muted by the swap');
  assert.strictEqual(tab.audio.intent('kick').volume, 0.6, 'and it takes the same volume');
  assert.deepStrictEqual(written.filter((w) => w[0] === 'kick').pop(), ['kick', false, 0.6], 'the frame was commanded audible');
  tab.audio.setVisible('yt');
  assert.strictEqual(tab.audio.intent('yt').muted, false, 'a second hop in the same direction is still audible');
});

check('swap carries a MUTED live as muted, and back again', () => {
  const { tab, els, written } = swapWorld();
  tab.audio.setIntent('twitch', { muted: true, volume: 0.2 });
  tab.audio.setVisible('kick');
  assert.strictEqual(tab.audio.intent('kick').muted, true, 'a muted live stays muted on the new player');
  assert.strictEqual(tab.audio.intent('kick').volume, 0.2);
  assert.deepStrictEqual(written.filter((w) => w[0] === 'kick').pop(), ['kick', true, 0.2], 'the new player was commanded muted, not audible');
  tab.audio.setVisible('twitch');
  assert.strictEqual(tab.audio.intent('twitch').muted, true, 'coming back stays muted');
  assert.strictEqual(els.twitch.muted, true, 'the native was commanded muted on the return trip');
});

check('swap does not invent sound for a surface the user muted itself', () => {
  const { tab, els, written } = swapWorld();
  tab.audio.setIntent('twitch', { muted: true, volume: 0.5 });
  tab.audio.setVisible('kick');
  assert.strictEqual(tab.audio.intent('kick').muted, true, 'kick inherited the mute');
  assert.deepStrictEqual(written.filter((w) => w[0] === 'kick').pop(), ['kick', true, 0.5], 'the inherited mute reached the frame as a command');
  tab.audio.setIntent('kick', { muted: false, volume: 0.5 }); // the user unmutes the overlay
  tab.audio.setVisible('twitch');
  assert.strictEqual(tab.audio.intent('twitch').muted, false, 'and the return trip carries the unmute');
  assert.strictEqual(els.twitch.muted, false, 'the native was commanded audible by the return trip');
});

// ---- 3d. a machine mute is not the user's decision -----------------------
// Owner report 2026-11-09: "ta mutando de forma aleatoria essa merda. tentei
// falar com um streamer e mutou sozinho". `hasBeenActive` is STICKY: one click
// anywhere (chat) makes it true for the life of the page, so it cannot
// separate his gesture from Twitch's player muting itself on an ad later. The
// gate is FRESHNESS of a real input.
check('a volumechange with NO user activation is policy, not intent', () => {
  const tab = makeTab(null, { active: false });
  const v = videoEl();
  tab.audio.registerNative('twitch', { elements: () => [v], main: () => v });
  tab.audio.setVisible('twitch');
  v.muted = true; // Chrome silencing an autoplay
  tab.fire(v);
  assert.strictEqual(tab.audio.intent('twitch').muted, false, 'the user never asked for a mute');
  assert.strictEqual(tab.audio.wanted('twitch').muted, false, 'the surface is not silenced by a machine mute');
  assert.strictEqual(v.muted, false, 'and the intent is re-asserted on the element (sound comes back)');
  assert.ok(!tab.store.has(TAB_KEY) || JSON.parse(tab.store.get(TAB_KEY)).twitch.m === false, 'nothing muted was persisted');
  // The first real gesture (a fresh input + the element change) is the intent.
  const t2 = makeTab(null, { active: true });
  const v2 = videoEl();
  t2.audio.registerNative('twitch', { elements: () => [v2], main: () => v2 });
  t2.audio.setVisible('twitch');
  t2.gesture(v2);
  assert.strictEqual(t2.audio.intent('twitch').muted, true, 'an active tab still records the user mute');
});

check('(a) a volumechange 3 s after the last real input is NOT intent, and is re-asserted', () => {
  // The owner clicked once, to talk in chat; hasBeenActive is now true forever.
  const tab = makeTab(null, { active: true });
  const v = videoEl();
  tab.audio.registerNative('twitch', { elements: () => [v], main: () => v });
  tab.audio.setVisible('twitch');
  tab.input('pointerdown');
  withClock(3000, () => {
    v.muted = true; // Twitch's player muting itself on an ad
    tab.fire(v);
  });
  assert.strictEqual(tab.audio.intent('twitch').muted, false, 'a stale volumechange never becomes intent');
  assert.strictEqual(tab.audio.wanted('twitch').muted, false, 'the derived state is still audible');
  assert.strictEqual(v.muted, false, 'the derived state is re-asserted on the element');
  assert.ok(!tab.store.has(TAB_KEY) || JSON.parse(tab.store.get(TAB_KEY)).twitch.m === false, 'nothing muted was persisted');
});

check('(b) a volumechange 100 ms after a real pointerdown IS intent', () => {
  const tab = makeTab();
  const v = videoEl();
  tab.audio.registerNative('twitch', { elements: () => [v], main: () => v });
  tab.audio.setVisible('twitch');
  tab.input('pointerdown'); // the click on Twitch's volume button
  withClock(100, () => {
    v.muted = true; // the write that click makes
    tab.fire(v);
  });
  assert.strictEqual(tab.audio.intent('twitch').muted, true, 'a fresh gesture is the user decision');
  assert.strictEqual(tab.audio.wanted('twitch').muted, true);
  assert.strictEqual(JSON.parse(tab.store.get(TAB_KEY)).twitch.m, true, 'and it is persisted for this tab');
});

check('mutation: restoring the sticky hasBeenActive gate turns arm (a) RED', () => {
  const mutated = AUDIO.replace('      if (!fresh) {', '      if (!userActive()) {');
  assert.notStrictEqual(mutated, AUDIO, 'the freshness gate was found');
  const tab = makeTab(null, { active: true, source: mutated });
  const v = videoEl();
  tab.audio.registerNative('twitch', { elements: () => [v], main: () => v });
  tab.audio.setVisible('twitch');
  tab.input('pointerdown');
  withClock(3000, () => {
    v.muted = true;
    tab.fire(v);
  });
  assert.strictEqual(tab.audio.intent('twitch').muted, true, 'the sticky mutant records a stale machine mute as intent: the arm is live');
});

check('mutation: dropping the activation gate re-introduces the self-mute', () => {
  const mutated = AUDIO.replace('      if (!userActive()) {', '      if (false) {');
  assert.notStrictEqual(mutated, AUDIO, 'the gate was found');
  // A fresh input so the freshness gate lets the event through: this arm is
  // about the second signal, which is the activation gate.
  const tab = makeTab(null, { active: false, source: mutated });
  const v = videoEl();
  tab.audio.registerNative('twitch', { elements: () => [v], main: () => v });
  tab.audio.setVisible('twitch');
  tab.input('pointerdown');
  v.muted = true;
  tab.fire(v);
  assert.strictEqual(tab.audio.intent('twitch').muted, true, 'the mutant DOES mute itself: the arm is live');
});

// ---- 4. source fence ------------------------------------------------------
const storageListenerBody = (() => {
  const start = CONTENT.indexOf('chrome.storage.onChanged.addListener');
  const end = CONTENT.indexOf('// ---- helpers ----', start);
  return start >= 0 && end > start ? CONTENT.slice(start, end) : '';
})();

check('content.js shared record carries no audio field', () => {
  const row = CONTENT.split('\n').filter((l) => /[{,]\s*vols\s*:/.test(l) || /^\s*vols\s*:/.test(l));
  assert.strictEqual(row.length, 0, 'no `vols:` field in the ko.v2 record');
});

check('the storage listener never writes audio intent', () => {
  assert.ok(storageListenerBody.length > 500, 'the listener body was found');
  assert.ok(!/setIntent|KOAudio/.test(storageListenerBody), 'no intent write from storage.onChanged');
  assert.ok(!/kickMuted\s*=|ytMuted\s*=/.test(storageListenerBody), 'no audio mirror write from storage.onChanged');
});

check('ko-audio.js does not touch chrome.storage', () => {
  assert.ok(!AUDIO.includes('chrome.storage'), 'the arbiter is tab-local');
  assert.ok(AUDIO.includes('sessionStorage'), 'and persists in sessionStorage');
});

// ---- 5. the fence fires on the pre-fix shape ------------------------------
check('mutation: re-inserting the shared audio row is caught', () => {
  const mutated = CONTENT.replace('      player: KO.playerPreference,', '      player: KO.playerPreference,\n      vols: { kick: { v: 0.2, m: true } },');
  assert.notStrictEqual(mutated, CONTENT, 'mutation applied');
  const row = mutated.split('\n').filter((l) => /[{,]\s*vols\s*:/.test(l) || /^\s*vols\s*:/.test(l));
  assert.strictEqual(row.length, 1, 'the fence sees the re-inserted shared row');
});

check('mutation: applying a shared row from storage.onChanged is caught', () => {
  const mutated = CONTENT.replace(
    '  if (pChanged) fire(apply); // hot toggle / remap / player switch — no page reload',
    '  window.KOAudio && window.KOAudio.setIntent("twitch", { muted: true });\n  if (pChanged) fire(apply); // hot toggle / remap / player switch — no page reload',
  );
  assert.notStrictEqual(mutated, CONTENT, 'mutation applied');
  const s0 = mutated.indexOf('chrome.storage.onChanged.addListener');
  const s1 = mutated.indexOf('// ---- helpers ----', s0);
  const body = mutated.slice(s0, s1);
  assert.ok(/setIntent/.test(body), 'the fence sees the intent write');
});

// ANTI-VACUITY: a suite that silently loses an arm reads as a quieter green.
// The floor is the count every arm this file executes today; a deleted arm
// (or one that stops running because an earlier await short-circuits) fails here
// instead of printing PASS with a smaller number.
function antiVacuity(actual, expected) {
  if (actual !== expected) {
    console.error(`\nANTI-VACUITY FAIL suite=tab-audio-scope checks=${actual} expected=${expected}: an arm stopped running`);
    process.exit(1);
  }
  console.log(`ANTI-VACUITY suite=tab-audio-scope checks=${actual} expected=${expected}`);
}
antiVacuity(checks, 19);
console.log(`\nRESULT ${failed ? 'FAIL' : 'PASS'} tab-audio-scope checks=${checks} failed=${failed}`);
process.exit(failed ? 1 : 0);
