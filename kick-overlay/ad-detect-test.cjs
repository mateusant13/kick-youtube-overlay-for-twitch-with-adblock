// Ad-DETECTION regression harness for twitch-adblock.js.
//
// Owner report (2026-11-15, verbatim): "eu tomei anuncio INTEIRO" and, in the
// same session, the slate pasted from his own screen: "Continue com FredTheFinch
// logo após esse anúncio comercial. Fique por aqui para apoiar a transmissão! …
// Anúncio (0:15)". Measured in his ring: ZERO `ad-ui-on`, ZERO `ad-hold`, ZERO
// `worker-playlist` rows for a whole page load while that pod played. Two
// independent blindnesses, and the suite below is the pair of them:
//
//  1. `adUiDetail()` tested the CLASS TOKEN. Twitch's squeezeback wrapper
//     carries `stream-display-ad__wrapper-hidden` as a PERMANENT class and
//     reveals itself by painting its inner container, so a real ad wrapper
//     failed `!/hidden/i.test(cls)` while measuring 1236x695. And when there
//     was no wrapper at all, the countdown/slate TEXT in the player was never
//     read: that path did not exist.
//  2. `window.SharedWorker` was never patched, so the player that feeds
//     `video.srcObject = MediaSourceHandle` fetched its playlists outside every
//     hook we own. The playlist swap could not fire on that page at all.
//
// Each fix carries a mutation that restores the pre-fix behaviour and must turn
// its arm red, so a green here cannot mean "the guard never ran".
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8');
let failures = 0;
const arms = [];
function check(label, ok, detail) {
  arms.push(label);
  if (ok) {
    console.log(`  - OK   ${label}`);
  } else {
    failures++;
    console.log(`  - FAIL ${label}${detail ? ` (${detail})` : ''}`);
  }
}

// Pull one top-level `function name(` body out of the shipped file by brace
// matching, so the suite always executes the code the browser gets.
function grab(name, src = SRC) {
  const start = src.indexOf(`  function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}()`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) break;
    }
  }
  return src.slice(start, i + 1);
}
const core = () => [grab('adSurfaceRect'), grab('adUiDetail'), grab('adHoldWorthy')].join('\n');

// ---- DOM stubs ------------------------------------------------------------
// `paint` is what getComputedStyle answers: a node that paints has
// display:block/visibility:visible/opacity:1 and a non-zero rect.
const style = (el) => el._style || { display: 'block', visibility: 'visible', opacity: '1' };
function node({ cls = '', rect = [0, 0], style: s, children = [], attrs = {} } = {}) {
  const el = {
    tagName: 'DIV',
    className: cls,
    children,
    _style: s,
    parentElement: null,
    getBoundingClientRect: () => ({ width: rect[0], height: rect[1] }),
    getAttribute: (k) => attrs[k] ?? null,
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          out.push(c);
          walk(c);
        }
      };
      walk(el);
      if (sel === '*') return out;
      return out;
    },
  };
  for (const c of children) c.parentElement = el;
  return el;
}

// Builds an `adUiDetail` runner over a page description. `texts` are text nodes
// inside the player subtree, which is where Twitch writes its slate/countdown.
function runner({ wrappers = [], texts = [], player = true } = {}) {
  const playerEl = node({ cls: 'video-player', rect: [1236, 695] });
  const doc = {
    querySelectorAll(sel) {
      if (sel.includes('sda-wrapper')) return wrappers;
      if (sel.includes('aria-label')) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (c.getAttribute('aria-label')) out.push(c);
            walk(c);
          }
        };
        wrappers.forEach(walk);
        return out;
      }
      return [];
    },
    querySelector(sel) {
      if (!player) return null;
      if (sel.includes('video-player')) return playerEl;
      return null;
    },
    createTreeWalker() {
      let idx = 0;
      return {
        nextNode() {
          if (idx >= texts.length) return null;
          return { nodeValue: texts[idx++], parentElement: node({ rect: [400, 20] }) };
        },
      };
    },
  };
  const fn = new Function('document', 'NodeFilter', 'getComputedStyle', `${core()}\nreturn adUiDetail();`);
  return () =>
    fn(doc, { SHOW_TEXT: 4 }, (el) => (el && style(el)) || { display: 'block', visibility: 'visible', opacity: '1' });
}

function holdWorthy(detail, videoEl) {
  const fn = new Function('getComputedStyle', `${core()}\nreturn adHoldWorthy;`)(
    (el) => (el && style(el)) || { display: 'block', visibility: 'visible', opacity: '1' },
  );
  return fn(detail, videoEl);
}

console.log('ad-detect: the DOM detector must see the ad Twitch actually paints');

// ---- 1. the exact shape measured on his Chrome 2026-11-15 ---------------
// wrapper 0x0 carrying `__wrapper-hidden` permanently; the paint lives in the
// inner container. The pre-fix class-token test answered null here.
const frame = node({ rect: [1236, 695] });
const transform = node({ rect: [1236, 695], children: [frame] });
const container = node({ rect: [1236, 695], children: [transform] });
const realWrapper = node({
  cls: 'stream-display-ad__wrapper stream-display-ad__wrapper_squeezeback stream-display-ad__wrapper-hidden',
  rect: [0, 0],
  children: [container],
});
const seenReal = runner({ wrappers: [realWrapper] })();
check(
  'a wrapper that is 0x0 with a permanent __wrapper-hidden class is still an ad when its container paints',
  !!seenReal && seenReal.kind === 'wrapper' && seenReal.w === 1236 && seenReal.h === 695,
  JSON.stringify(seenReal),
);
check(
  'the measured real ad is hold-worthy (it covers the player)',
  holdWorthy(seenReal, node({ rect: [1236, 695] })) === true,
);

// ---- 2. the pre-fix class-token branch is the mutation ------------------
// Restore `!/hidden/i.test(className)` and require the arm above to go RED.
const mutated = SRC.replace(
  'const r = adSurfaceRect(sda);\n        if (r.width > 20 && r.height > 20) {',
  "const r = sda.getBoundingClientRect();\n        if (!/hidden/i.test(String(sda.className || '')) && r.width > 20 && r.height > 20) {",
);
check('the class-token mutation applied to the shipped file', mutated !== SRC);
if (mutated !== SRC) {
  const fn = new Function(
    'document',
    'NodeFilter',
    'getComputedStyle',
    `${[grab('adSurfaceRect', mutated), grab('adUiDetail', mutated), grab('adHoldWorthy', mutated)].join('\n')}
     return adUiDetail();`,
  );
  const doc = {
    querySelectorAll: (sel) => (sel.includes('sda-wrapper') ? [realWrapper] : []),
    querySelector: () => null,
    createTreeWalker: () => ({ nextNode: () => null }),
  };
  const pre = fn(doc, { SHOW_TEXT: 4 }, () => ({ display: 'block', visibility: 'visible', opacity: '1' }));
  check('RED: the pre-fix class-token test cannot see the measured ad', pre === null, JSON.stringify(pre));
}

// ---- 3. the slate / countdown text, which needed no wrapper at all ------
const cases = [
  ['countdown "Anúncio (0:15)" in the player is an ad', ['Anúncio (0:15)'], true, 'countdown'],
  [
    'the slate he pasted ("Continue com FredTheFinch logo após esse anúncio comercial") is an ad',
    ['Continue com FredTheFinch logo após esse anúncio comercial. Fique por aqui para apoiar a transmissão!'],
    true,
    'slate',
  ],
  ['the promo button text is NOT an ad', ['Teste 1 mês sem anúncios'], false, null],
  ['chat text mentioning anúncio is NOT an ad', ['esse anuncio foi engracado'], false, null],
  ['a bare countdown with no ad word is NOT an ad', ['(0:15)'], false, null],
];
for (const [label, texts, wantAd, wantKind] of cases) {
  const got = runner({ wrappers: [], texts })();
  const ok = wantAd ? !!got && got.kind === wantKind : !got;
  check(label, ok, JSON.stringify(got));
}
check('the slate/countdown kinds are hold-worthy (no size to measure)', holdWorthy(runner({ texts: ['Anúncio (0:15)'] })(), null) === true);

// ---- 4. a banner must never cost the user his picture -------------------
// Twitch's squeezeback shell is 160x90 in the DOM permanently. It is an ad
// surface, and pausing a 1236x695 player over it is the "friend's black page"
// defect that already cost one wave.
const banner = node({ rect: [160, 90] });
const seenBanner = runner({ wrappers: [banner] })();
check('a 160x90 banner is detected as an ad surface', !!seenBanner && seenBanner.w === 160, JSON.stringify(seenBanner));
check(
  'a 160x90 banner is NOT worth pausing a 1236x695 player for',
  holdWorthy(seenBanner, node({ rect: [1236, 695] })) === false,
);

// ---- 5. the worker hooks -------------------------------------------------
// `SharedWorker` is what Twitch's current player uses: wrapping only
// `window.Worker` left the media fetcher unpatched and the ring with zero
// `worker-playlist` rows for a full page load.
check(
  'the shipped file patches window.Worker',
  /window\.Worker = makePatchedWorker\(window\.Worker/.test(SRC),
);
check(
  'the shipped file patches window.SharedWorker (the media fetcher)',
  /window\.SharedWorker = makePatchedWorker\(window\.SharedWorker/.test(SRC),
);
check(
  'the hook logs itself, so "no worker-playlist rows" is never ambiguous',
  /adLog\('worker-hook'/.test(SRC) && /adLog\('worker-hook-fail'/.test(SRC),
);
// Behavioural half: a wrapped SharedWorker still constructs, still receives the
// prelude, and its counter/kind log are attributed correctly.
{
  class FakeNative {
    constructor(url, options) {
      this.url = String(url);
      this.options = options;
      FakeNative.last = this;
    }
  }
  const logs = [];
  const hook = new Function(
    'window',
    'stats',
    'isOn',
    'adLog',
    'CLIENT_ID',
    'GQL_HASH',
    'GQL_URL',
    'PLAYER_TYPE',
    'CLEAN_PLATFORM',
    'pageId',
    'workerMain',
    'Blob',
    'URL',
    'XMLHttpRequest',
    `${grab('makePatchedWorker')}
     window.Worker = makePatchedWorker(window.Worker, false);
     window.SharedWorker = makePatchedWorker(window.SharedWorker, true);`,
  );
  const w = { Worker: FakeNative, SharedWorker: FakeNative };
  const stats = { workerHooks: 0, workerFailures: 0 };
  hook(
    w,
    stats,
    () => true,
    (ev, d) => logs.push({ ev, d }),
    'cid',
    'hash',
    'https://gql',
    'site',
    'web',
    'page-1',
    () => {},
    class Blob {
      constructor(parts) {
        this.parts = parts;
      }
    },
    { createObjectURL: () => 'blob:https://www.twitch.tv/rewritten' },
    class XHR {
      open() {}
      overrideMimeType() {}
      send() {
        this.responseText = '/* twitch player */';
      }
    },
  );
  new w.Worker('blob:https://www.twitch.tv/aaaa');
  new w.SharedWorker('blob:https://www.twitch.tv/bbbb');
  check(
    'a SharedWorker blob is rewritten through the same prelude as a Worker',
    FakeNative.last.url === 'blob:https://www.twitch.tv/rewritten',
    FakeNative.last.url,
  );
  check('the worker counter counts one of each constructor', stats.workerHooks === 1 && stats.workerHooksShared === 1, JSON.stringify(stats));
  check(
    'the hook log names WHICH constructor it wrapped',
    logs.some((l) => l.ev === 'worker-hook' && l.d.kind === 'worker') &&
      logs.some((l) => l.ev === 'worker-hook' && l.d.kind === 'shared'),
    JSON.stringify(logs.map((l) => l.d && l.d.kind)),
  );
  // RED: the pre-fix file, which wrapped only Worker.
  const prefixed = SRC.replace(
    /  try \{\n    if \(typeof window\.SharedWorker === 'function'\) \{[\s\S]*?\} catch \{\n    \/\* shared-worker hook is optional \*\/\n  \}\n/,
    '',
  );
  check('the SharedWorker mutation applied to the shipped file', prefixed !== SRC);
  if (prefixed !== SRC) {
    const hook2 = new Function(
      'window',
      'stats',
      'isOn',
      'adLog',
      'CLIENT_ID',
      'GQL_HASH',
      'GQL_URL',
      'PLAYER_TYPE',
      'CLEAN_PLATFORM',
      'pageId',
      'workerMain',
      'Blob',
      'URL',
      'XMLHttpRequest',
      `${grab('makePatchedWorker', prefixed)}
       window.Worker = makePatchedWorker(window.Worker, false);`,
    );
    const w2 = { Worker: FakeNative, SharedWorker: FakeNative };
    const stats2 = { workerHooks: 0, workerFailures: 0 };
    hook2(
      w2,
      stats2,
      () => true,
      () => {},
      'cid',
      'hash',
      'https://gql',
      'site',
      'web',
      'page-1',
      () => {},
      class Blob {
        constructor(parts) {
          this.parts = parts;
        }
      },
      { createObjectURL: () => 'blob:https://www.twitch.tv/rewritten' },
      class XHR {
        open() {}
        overrideMimeType() {}
        send() {
          this.responseText = 'x';
        }
      },
    );
    const before = w2.SharedWorker;
    new w2.SharedWorker('blob:https://www.twitch.tv/bbbb');
    check(
      'RED: without the SharedWorker hook the media fetcher is unpatched (raw blob, no prelude)',
      w2.SharedWorker === before && stats2.workerHooks === 0 && FakeNative.last.url === 'blob:https://www.twitch.tv/bbbb',
      `${FakeNative.last.url} ${JSON.stringify(stats2)}`,
    );
  }
}

// ---- 6. the tick asks the same question the hold asks --------------------
// `ad-ui-on` used to fire on mere presence, so a permanent squeezeback shell
// would log an ad and try a hold on every page.
check(
  'the tick gates the log with adHoldWorthy, not with presence',
  /const ad = adHoldWorthy\(adDetail, mainVideo\(\)\);/.test(SRC) && !/const ad = !!adDetail;/.test(SRC),
);

// ---- 7. a detected ad must START the defence, not just pause ------------
// Pausing alone leaves the ad frame on screen until the worker's playlist probe
// sees the next segment refresh: that gap is the owner's "ad toca por uns 4
// segundos até finalmente ser defendido" (2026-11-15). Measured behaviour: the
// hold must post a standby request in the same tick it pauses.
{
  const holdFn = new Function(
    'requestStandby',
    'stub',
    `let adUiHeldAt = 0;
     let adUiReasserts = 0;
     const AD_OVERLAY_ENABLED = true;
     const AD_UI_HOLD_MAX_MS = 12000;
     const overlay = { adActive: false, standby: false, frame: null, selfPausedAt: 0 };
     const overlayOwnsPlayback = () => false;
     const adHoldWorthy = () => true;
     const adLog = () => {};
     const adLogState = () => {};
     const mainVideo = () => stub.video;
     const document = { visibilityState: 'visible' };
     ${grab('adUiHold')}
     return () => { adUiHold({ kind: 'wrapper' }); return adUiHeldAt; };`,
  );
  const calls = [];
  const stub = { video: { isConnected: true, paused: false, pausedTimes: 0, pause() { this.paused = true; this.pausedTimes++; }, currentTime: 12.3, readyState: 4 } };
  const held = holdFn((d, f) => calls.push([d, f]), stub)();
  check('a DOM-detected ad pauses the native player', stub.video.pausedTimes === 1 && held > 0);
  check(
    'a DOM-detected ad asks for a clean source in the SAME tick (immediate=true, no delay)',
    calls.length === 1 && calls[0][0] === 0 && calls[0][1] === true,
    JSON.stringify(calls),
  );
  // RED: drop the request and the pause happens with nothing warming behind it.
  const mutatedHold = SRC.replace('    requestStandby(0, true);\n    adLogState(', '    adLogState(');
  check('the standby-request mutation applied to the shipped file', mutatedHold !== SRC);
  if (mutatedHold !== SRC) {
    const mutFn = new Function(
      'requestStandby',
      'stub',
      `let adUiHeldAt = 0;
       let adUiReasserts = 0;
       const AD_OVERLAY_ENABLED = true;
       const AD_UI_HOLD_MAX_MS = 12000;
       const overlay = { adActive: false, standby: false, frame: null, selfPausedAt: 0 };
       const overlayOwnsPlayback = () => false;
       const adHoldWorthy = () => true;
       const adLog = () => {};
       const adLogState = () => {};
       const mainVideo = () => stub.video;
       const document = { visibilityState: 'visible' };
       ${grab('adUiHold', mutatedHold)}
       return () => { adUiHold({ kind: 'wrapper' }); return adUiHeldAt; };`,
    );
    const calls2 = [];
    const stub2 = { video: { isConnected: true, paused: false, pause() { this.paused = true; }, currentTime: 5, readyState: 4 } };
    mutFn((d, f) => calls2.push([d, f]), stub2)();
    check(
      'RED: the pre-fix hold pauses the ad and warms nothing, which IS the 4 s of ad',
      calls2.length === 0,
      JSON.stringify(calls2),
    );
  }
}

// ---- 8. the hold is RETRIED while the episode runs -----------------------
// Owner report 2026-11-19, verbatim: "tomou um anuncio INTEIRO de 30s". His
// 0.8.100 ring, twitch.tv/alanzoka: `ad-ui-on` at 188911 with `hidden:true` on
// the very next row, `ad-ui-off {adSec:29.7}` at 218566, and `ad-ui-hold` was
// NEVER written. Detection reads the DOM (a background tab keeps updating it);
// the hold refuses a page the user is not looking at. So the pod's whole UI
// appeared while the tab was hidden, the ONE transition that could pause it was
// the one moment it could not, and nothing asked again.
//
// THE ARMS RUN THE REAL TICK, not a regex over source text: this repo already
// paid for source-text assertions that stayed green while the handler was
// never called (the 0.8.88 freeze). The tick body is extracted by brace
// matching and executed against a document whose visibility we control.
{
  const tickSrc = (() => {
    const marker = 'setInterval(() => {';
    // The tick that owns the ad is the one whose body reads the DOM. Exactly one
    // interval may, so a second reader appearing is a failure and not a guess.
    const hits = [...SRC.matchAll(/setInterval\(\(\) => \{/g)].map((m) => m.index);
    const owning = hits.filter((at) => {
      let depth = 0;
      for (let i = at + marker.length - 1; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') {
          depth--;
          if (!depth) return /adUiDetail\(\)/.test(SRC.slice(at, i));
        }
      }
      return false;
    });
    if (owning.length !== 1) return null;
    const open = owning[0] + marker.length - 1;
    let depth = 0;
    for (let i = open; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') {
        depth--;
        if (!depth) return SRC.slice(open, i + 1);
      }
    }
    return null;
  })();
  check('the ad tick body is extractable', !!tickSrc);

  // One world. The REAL `adUiHold` runs here, not a stub: the refusal this arm
  // is about lives in that function, and a stand-in would prove the stand-in.
  const freshRec = () => ({ ad: false, adSince: 0, playing: false, lastTick: 0 });
  const makeVideo = () => ({ paused: false, isConnected: true, currentTime: 100, readyState: 4, w: 2560, rs: 4, pause() { this.paused = true; } });
  const HOLD = grab('adUiHold');
  const makeTick = (src) => new Function(
    'ctx',
    `const { rec, page, video, log } = ctx;
     let adUiHeldAt = 0;
     let adUiReasserts = 0;
     let adUiHiddenLogged = false;
     const AD_OVERLAY_ENABLED = true;
     const AD_UI_HOLD_MAX_MS = 12000;
     const overlay = { adActive: false, standby: false, frame: null, selfPausedAt: 0 };
     const overlayOwnsPlayback = () => false;
     const adUiDetail = () => ({ kind: 'slate' });
     const adHoldWorthy = () => true;
     const mainVideo = () => video;
     const sampleVideo = () => video;
     const requestStandby = () => log.push('standby');
     const resumeNative = () => log.push('resume');
     const recLog = (n) => log.push(n);
     const adLog = (n, f) => log.push(n + ':' + (f && f.reason ? f.reason : ''));
     const adLogState = (n) => log.push(n);
     const adUiRelease = () => log.push('ad-ui-release');
     const adUiHoldTick = () => {};
     const document = { get visibilityState() { return page.visible ? 'visible' : 'hidden'; } };
     ${HOLD}
     ${src}`,
  );
  // (a) the pod is detected while the tab is hidden: the hold is refused and
  //     SAID, not silent. One world, three ticks: hidden, visible, visible.
  const rec = freshRec();
  const video = makeVideo();
  const log = [];
  const ctx = { rec, page: { visible: false }, video, log, hiddenLogged: false };
  const tick = makeTick(tickSrc);
  tick(ctx);
  check(
    'a pod detected in a HIDDEN tab is refused AND named',
    ctx.log.includes('ad-skip:hidden-tab') && !ctx.video.paused,
    JSON.stringify(ctx.log),
  );
  // (b) the tab comes back inside the same pod: the retry takes the hold.
  ctx.page.visible = true;
  tick(ctx);
  check(
    'the tab coming back inside the pod still takes the hold (his 30.0 s of ad)',
    ctx.video.paused && ctx.log.includes('ad-ui-hold'),
    JSON.stringify(ctx.log),
  );
  // (c) and the adopted hold is not re-paused on every later tick.
  const held = ctx.log.filter((l) => l === 'ad-ui-hold').length;
  tick(ctx);
  check('an adopted hold is not re-paused on the next tick', ctx.log.filter((l) => l === 'ad-ui-hold').length === held);

  // (c2) a SECOND pod logs its own refusal: the flag is per episode.
  const rec3 = freshRec();
  const video3 = makeVideo();
  const ctx3 = { rec: rec3, page: { visible: false }, video: video3, log: [], hiddenLogged: false };
  const tick3 = makeTick(tickSrc);
  tick3(ctx3); // pod 1, taken once the tab comes back
  ctx3.page.visible = true;
  tick3(ctx3);
  // pod ends, pod 2 begins while hidden again
  ctx3.rec.ad = false;
  ctx3.video.paused = false;
  ctx3.page.visible = false;
  tick3(ctx3);
  check(
    'a SECOND pod logs its own hidden refusal (the flag is per episode)',
    ctx3.log.filter((l) => l === 'ad-skip:hidden-tab').length === 2,
    JSON.stringify(ctx3.log),
  );

  // (d) RED: the pre-fix tick asked once and stopped asking.
  const mutantTick = tickSrc.replace(/\} else if \(ad\) \{[\s\S]*?adUiHold\(adDetail\);\n      \}/, '}');
  check('the retry mutation applied to the shipped tick', mutantTick !== tickSrc);
  if (mutantTick !== tickSrc) {
    const rec2 = freshRec();
    const video2 = makeVideo();
    const ctx2 = { rec: rec2, page: { visible: false }, video: video2, log: [], hiddenLogged: false };
    const tick2 = makeTick(mutantTick);
    tick2(ctx2);
    ctx2.page.visible = true;
    tick2(ctx2);
    check(
      'RED: without the retry the pod runs its whole length unheld (his 30.0 s)',
      ctx2.log.includes('ad-skip:hidden-tab') && !video2.paused && !ctx2.log.includes('ad-ui-hold'),
      JSON.stringify(ctx2.log),
    );
  }
}

// ---- anti-vacuity --------------------------------------------------------
const expected = [
  'a wrapper that is 0x0 with a permanent __wrapper-hidden class is still an ad when its container paints',
  'the measured real ad is hold-worthy (it covers the player)',
  'the class-token mutation applied to the shipped file',
  'RED: the pre-fix class-token test cannot see the measured ad',
  'countdown "Anúncio (0:15)" in the player is an ad',
  'the slate he pasted ("Continue com FredTheFinch logo após esse anúncio comercial") is an ad',
  'the promo button text is NOT an ad',
  'chat text mentioning anúncio is NOT an ad',
  'a bare countdown with no ad word is NOT an ad',
  'the slate/countdown kinds are hold-worthy (no size to measure)',
  'a 160x90 banner is detected as an ad surface',
  'a 160x90 banner is NOT worth pausing a 1236x695 player for',
  'the shipped file patches window.Worker',
  'the shipped file patches window.SharedWorker (the media fetcher)',
  'the hook logs itself, so "no worker-playlist rows" is never ambiguous',
  'a SharedWorker blob is rewritten through the same prelude as a Worker',
  'the worker counter counts one of each constructor',
  'the hook log names WHICH constructor it wrapped',
  'the SharedWorker mutation applied to the shipped file',
  'RED: without the SharedWorker hook the media fetcher is unpatched (raw blob, no prelude)',
  'the tick gates the log with adHoldWorthy, not with presence',
  'a DOM-detected ad pauses the native player',
  'a DOM-detected ad asks for a clean source in the SAME tick (immediate=true, no delay)',
  'the standby-request mutation applied to the shipped file',
  'RED: the pre-fix hold pauses the ad and warms nothing, which IS the 4 s of ad',
  'the ad tick body is extractable',
  'a pod detected in a HIDDEN tab is refused AND named',
  'the tab coming back inside the pod still takes the hold (his 30.0 s of ad)',
  'an adopted hold is not re-paused on the next tick',
  'a SECOND pod logs its own hidden refusal (the flag is per episode)',
  'the retry mutation applied to the shipped tick',
  'RED: without the retry the pod runs its whole length unheld (his 30.0 s)',
];
const missing = expected.filter((l) => !arms.includes(l));
if (missing.length) {
  failures += missing.length;
  console.log(`  - FAIL arms that never printed: ${missing.join(' | ')}`);
}
console.log(`\nARMS ${arms.length}/${expected.length}`);

if (failures) {
  console.log(`\nRESULT FAIL ad-detect: ${failures} arm(s) failed`);
  process.exit(1);
}
console.log('RESULT PASS ad-detect: the DOM detector sees the ad Twitch paints, and the media worker is hooked');
