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

const SRC = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8').replace(/\r\n/g, '\n');
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

// Runs the same predicate against a source that restores the pre-fix line.
// It MUST fail there; the failure is printed as a RED line and is not counted
// as a suite failure, so one run shows the red mutation and the green arm.
function redArm(label, mutantSrc, run) {
  arms.push(label);
  let detail = null;
  const ok = run(mutantSrc, (d) => { detail = d; });
  if (ok) {
    failures++;
    console.log(`  - FAIL ${label} (the mutation did not break the arm)`);
  } else {
    console.log(`  - FAIL RED ${label}${detail ? ` (${detail})` : ''}`);
  }
}

// Async twin of redArm for arms that must await the shipped async functions.
async function redArmAsync(label, mutantSrc, run) {
  arms.push(label);
  let detail = null;
  const ok = await run(mutantSrc, (d) => { detail = d; });
  if (ok) {
    failures++;
    console.log(`  - FAIL ${label} (the mutation did not break the arm)`);
  } else {
    console.log(`  - FAIL RED ${label}${detail ? ` (${detail})` : ''}`);
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
// Same brace-matching contract for `async function name(`, which the existing
// grab() does not match (the token `async` sits between the indent and `function`).
function grabAsync(name, src = SRC) {
  const start = src.indexOf(`  async function ${name}(`);
  if (start < 0) throw new Error(`missing async function ${name}()`);
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
// Same contract for a `const`: the marker regex has one owner in the shipped
// file, and the arm must execute that owner rather than a copy of it.
function grabConst(name, src = SRC) {
  const m = new RegExp(`^\\s*const ${name} = (.+);$`, 'm').exec(src);
  if (!m) throw new Error(`missing const ${name}`);
  return `const ${name} = ${m[1]};`;
}
const core = (src = SRC) => [
  'let adUiDetailOverride = null;',
  'const AD_SURFACE_MAX_NODES = 256;',
  'const mainVideo = () => null;',
  'const adLog = () => {}, overlay = { layoutSaved: null };',
  grab('adSurfaceRect', src), grab('isOurOwnVideo', src), grab('adWrapperPaint', src),
  grab('adLayoutNodes', src), grab('adLayoutRelease', src), grab('adLayoutRestore', src), grab('adLayoutWrite', src),
  grab('adUiDetail', src), grab('adHoldWorthy', src),
].join('\n');

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
      if (sel.includes('sda-wrapper') || sel.includes('stream-display-ad')) return wrappers;
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
  '        const r = adWrapperPaint(sda);\n        if (!r || !widthBase || r.width < 0.5 * widthBase) continue;',
  "        const r = sda.getBoundingClientRect();\n        if (!/hidden/i.test(String(sda.className || '')) && r.width > 20 && r.height > 20) {} else continue;",
);
check('the class-token mutation applied to the shipped file', mutated !== SRC);
if (mutated !== SRC) {
  const fn = new Function(
    'document',
    'NodeFilter',
    'getComputedStyle',
    `${core(mutated)}
     return adUiDetail();`,
  );
  const doc = {
    querySelectorAll: (sel) => ((sel.includes('stream-display-ad') || sel.includes('sda-wrapper')) ? [realWrapper] : []),
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
check('a bare 160x90 banner is not painted wide enough to squeeze', seenBanner === null, JSON.stringify(seenBanner));
// A BARE 160x90 banner on an unshrunk 1236x695 player is the control: too
// narrow to be the squeeze, and never worth costing the user his stream.
check(
  'a bare banner on an unshrunk player is NOT worth pausing for',
  holdWorthy({ kind: 'wrapper', w: 160, h: 90 }, node({ rect: [1236, 695] })) === false,
);

// ---- 4b. the BANNER SQUEEZE paints a WIDE ad over the shrunk picture ----
// Measured in the isolated guest on 2026-11-24: a HEALTHY player has the video
// at 714x325 inside a 714x402 player box (the viewport cap), so a video-vs-
// player ratio gate fires on a healthy player and is not an ad signal. The
// signal is a PAINTED wrapper whose biggest painted surface spans at least
// half the player's WIDTH. The permanent hidden shell is not an ad.
function squeezeNode({ rect, style: s = {}, cls = '', attrs = {} } = {}) {
  return {
    tagName: 'DIV', className: cls, style: s, children: [], parentElement: null,
    isConnected: true, closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: rect[0], height: rect[1] }),
    getAttribute: (k) => attrs[k] ?? null,
    querySelectorAll: () => [],
  };
}
function squeezeRun(src, o = {}) {
  const {
    cw = 1340, ch = 751, vw = 1340, vh = 605,
    bw = 1340, bh = 90,
    fullscreen = false, ownFrame = false, shellHidden = false,
    noWrapper = false, noNodes = false, persistentH = 751, wrapperW = cw,
    logoFirst = false, logoW = 40, logoH = 24, replaceMidPod = false,
  } = o;
  const logs = [];
  const box = { display: 'block', visibility: 'visible', opacity: '1', position: 'relative' };
  const container = squeezeNode({ rect: [cw, ch], style: { ...box, height: '', width: '', 'max-height': '' } });
  const videoRef = squeezeNode({ rect: [cw, ch], style: { height: '', width: '', 'max-height': '' } });
  const videoStyle = { width: '960px', height: '540px', 'max-height': '540px' };
  const persistent = squeezeNode({ rect: [cw, persistentH] });
  const wrapper = squeezeNode({
    rect: [wrapperW, bh], cls: 'stream-display-ad__wrapper',
    style: shellHidden ? { visibility: 'hidden', opacity: '0' } : { visibility: '' },
  });
  const painted = squeezeNode({ rect: [bw, bh] });
  const logo = squeezeNode({ rect: [logoW, logoH] });
  wrapper.children = logoFirst ? [logo, painted] : [painted];
  wrapper.querySelectorAll = () => wrapper.children;
  const video = squeezeNode({ rect: [vw, vh], style: { ...videoStyle } });
  video.tagName = 'VIDEO';
  if (ownFrame) video.closest = () => ({});
  const playerEl = squeezeNode({ rect: [cw, ch] });
  const doc = {
    fullscreenElement: fullscreen ? {} : null,
    querySelector: (sel) => {
      if (sel.includes('video-player__container')) return noNodes ? null : container;
      if (sel.includes('video-ref')) return noNodes ? null : videoRef;
      if (sel.includes('persistent-player')) return noNodes ? null : persistent;
      if (sel.includes('video-player')) return playerEl;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.includes('stream-display-ad')) return noWrapper ? [] : [wrapper];
      if (sel === 'video') return [video];
      return [];
    },
    createTreeWalker: () => ({ nextNode: () => null }),
  };
  const names = [
    'adSurfaceRect', 'adUiDetail', 'adHoldWorthy',
    'isOurOwnVideo', 'adWrapperPaint', 'adLayoutNodes', 'adLayoutRelease', 'adLayoutRestore', 'adLayoutWrite',
  ];
  const fn = new Function(
    'document', 'NodeFilter', 'getComputedStyle', 'overlay', 'adLog', 'mainVideo', 'video', 'wrapper', 'container', 'videoRef', 'logs',
    `const AD_SURFACE_MAX_NODES = 256;\nlet adUiDetailOverride = null;\n${names.map((n) => grab(n, src)).join('\n')}
     return { detail: adUiDetail(), release: adLayoutRelease, holdWorthy: adHoldWorthy, video, wrapper, container, videoRef, logs };`,
  );
  const result = fn(
    doc, { SHOW_TEXT: 4 }, (el) => (el === wrapper && shellHidden
      ? { ...box, visibility: 'hidden', opacity: '0' } : box),
    { layoutSaved: null }, (ev, d) => logs.push({ ev, d }), () => video, video, wrapper, container, videoRef, logs,
  );
  if (replaceMidPod) {
    // Twitch swaps the player nodes mid-pod. The new wrapper is a clone of the
    // one we hid, so a release that writes into the DETACHED saved wrapper
    // leaves the visible page hidden.
    const repContainer = squeezeNode({ rect: [cw, ch], style: { ...container.style } });
    const repVideoRef = squeezeNode({ rect: [cw, ch], style: { ...videoRef.style } });
    const repVideo = squeezeNode({ rect: [vw, vh], style: { ...video.style } });
    repVideo.tagName = 'VIDEO';
    const repWrapper = squeezeNode({
      rect: [wrapperW, bh], cls: wrapper.className, style: { visibility: 'hidden' },
    });
    const repPainted = squeezeNode({ rect: [bw, bh] });
    repWrapper.children = [repPainted];
    repWrapper.querySelectorAll = () => [repPainted];
    for (const n of [container, videoRef, video, wrapper]) n.isConnected = false;
    doc.querySelector = (sel) => {
      if (sel.includes('video-player__container')) return repContainer;
      if (sel.includes('video-ref')) return repVideoRef;
      if (sel.includes('persistent-player')) return persistent;
      if (sel.includes('video-player')) return playerEl;
      return null;
    };
    doc.querySelectorAll = (sel) => {
      if (sel.includes('stream-display-ad')) return [repWrapper];
      if (sel === 'video') return [repVideo];
      return [];
    };
    Object.assign(result, { repWrapper, repContainer, repVideoRef, repVideo });
  }
  return result;
}
check(
  'a healthy 714x325 video in a 714x402 player is NOT a squeeze',
  squeezeRun(SRC, { cw: 714, ch: 325, vw: 714, vh: 325, noWrapper: true }).detail === null,
);
const sq = squeezeRun(SRC);
check(
  'a painted wide banner is a banner squeeze with both box pairs',
  !!sq.detail && sq.detail.kind === 'banner-squeeze' && sq.detail.cw === 1340 && sq.detail.vh === 605
    && sq.detail.dw === 1340 && sq.detail.dh === 90 && !!sq.detail.wrapper,
  JSON.stringify(sq.detail),
);
check(
  'a wide lower third at 12% of the area is worth holding',
  sq.holdWorthy(sq.detail, sq.video) === true,
  `area ratio ${(1340 * 90 / (1340 * 751)).toFixed(3)}`,
);
check(
  'the picture is kept full-size and the ad wrapper is hidden',
  sq.container.style.height === `${751 + 90}px` && sq.videoRef.style.height === `${751 + 90}px`
    && sq.video.style.height === '100%' && sq.wrapper.style.visibility === 'hidden',
  JSON.stringify({ c: sq.container.style, r: sq.videoRef.style, v: sq.video.style, w: sq.wrapper.style }),
);
check(
  'ad-layout restore logs before, after and the banner',
  sq.logs.some((l) => l.ev === 'ad-layout' && l.d.act === 'restore' && l.d.before && l.d.after
    && l.d.banner.w === 1340 && l.d.banner.h === 90),
  JSON.stringify(sq.logs),
);
sq.release();
check(
  'ad-layout release restores the EXACT original inline styles',
  sq.container.style.height === '' && sq.videoRef.style.height === '' && sq.video.style.height === '540px'
    && sq.wrapper.style.visibility === '',
  JSON.stringify({ c: sq.container.style, r: sq.videoRef.style, v: sq.video.style, w: sq.wrapper.style }),
);
check(
  'ad-layout release is logged once',
  sq.logs.filter((l) => l.ev === 'ad-layout' && l.d.act === 'release').length === 1,
  JSON.stringify(sq.logs),
);
for (const [label, opts] of [
  ['the permanent hidden shell is NOT an ad', { shellHidden: true }],
  ['a wrapper below half the player width is NOT a squeeze', { bw: 600, wrapperW: 600 }],
  ['a fullscreen player is never squeezed', { fullscreen: true }],
  ['our own clean frame is never squeezed', { ownFrame: true }],
]) {
  const r = squeezeRun(SRC, opts);
  check(label, r.detail === null, JSON.stringify(r.detail));
}
const fullAd = squeezeRun(SRC, { bh: 500 });
check(
  'a full-height painted ad is a wrapper, never a layout change',
  !!fullAd.detail && fullAd.detail.kind === 'wrapper' && fullAd.container.style.height === '',
  JSON.stringify(fullAd.detail),
);
const missingNodeRun = squeezeRun(SRC, { noNodes: true });
check(
  'a missing layout node is reported, not guessed',
  missingNodeRun.logs.some((l) => l.ev === 'ad-layout' && l.d.act === 'restore' && l.d.skipped === 'missing-node'
    && Array.isArray(l.d.missing) && l.d.missing.length > 0),
  JSON.stringify(missingNodeRun.logs),
);
const squeezeBlind = SRC.replace(
  '        if (!r || !widthBase || r.width < 0.5 * widthBase) continue;',
  '        if (true) continue;',
);
check('the painted-wrapper mutation applied to the shipped file', squeezeBlind !== SRC);
if (squeezeBlind !== SRC) {
  const blind = squeezeRun(squeezeBlind);
  check('RED: without the painted wrapper the banner squeeze is invisible', blind.detail === null, JSON.stringify(blind.detail));
}
const restoreBlind = SRC.replace("    nodes.video.style.height = '100%';", '    void 0;');
check('the layout-restore mutation applied to the shipped file', restoreBlind !== SRC);
if (restoreBlind !== SRC) {
  const blind = squeezeRun(restoreBlind);
  check('RED: without the layout restore the picture stays shrunk', blind.video.style.height !== '100%', blind.video.style.height);
}
const areaBlind = SRC.replace(
  '      return detail.w >= 0.5 * r.width; // a wide lower third is a played ad',
  '      return detail.w * detail.h >= 0.5 * r.width * r.height;',
);
check('the width-gate mutation applied to the shipped file', areaBlind !== SRC);
if (areaBlind !== SRC) {
  const blind = squeezeRun(areaBlind);
  check(
    'RED: the old area gate refuses the wide lower third',
    blind.holdWorthy({ kind: 'wrapper', w: 1340, h: 90 }, blind.video) === false,
  );
}

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
     let adUiFailedAt = 0;
     let adUiFailedLogged = false;
     const userResumedHeld = () => false;
     const AD_OVERLAY_ENABLED = true;
     const AD_UI_HOLD_MAX_MS = 12000;
     const overlay = { adActive: false, standby: false, frame: null, selfPausedAt: 0 };
     const overlayOwnsPlayback = () => false;
     const adHoldWorthy = () => true;
     const adLog = () => {};
     const adLogState = () => {};
     const markAdPark = () => {};
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
  const mutatedHold = SRC.replace("    requestStandby(0, true, 'ad-ui-hold');\n    adLogState(", '    adLogState(');
  check('the standby-request mutation applied to the shipped file', mutatedHold !== SRC);
  if (mutatedHold !== SRC) {
    const mutFn = new Function(
      'requestStandby',
      'stub',
      `let adUiHeldAt = 0;
       let adUiReasserts = 0;
       let adUiFailedAt = 0;
       let adUiFailedLogged = false;
       const userResumedHeld = () => false;
       const AD_OVERLAY_ENABLED = true;
       const AD_UI_HOLD_MAX_MS = 12000;
       const overlay = { adActive: false, standby: false, frame: null, selfPausedAt: 0 };
       const overlayOwnsPlayback = () => false;
       const adHoldWorthy = () => true;
       const adLog = () => {};
       const adLogState = () => {};
       const markAdPark = () => {};
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
  const FREEZE = grab('freezeNativeForPod');
  const makeTick = (src) => new Function(
    'ctx',
    `const { rec, page, video, log } = ctx;
     // The three episode flags are MODULE state in the shipped file, so they are
     // carried on ctx here: a harness that re-initialised them per call would let
     // a per-episode row fire on every tick and then report that as correct.
     const state = ctx.state || (ctx.state = { heldAt: 0, reasserts: 0, hiddenLogged: false, ownerLogged: false, failedAt: 0, failedLogged: false });
     const AD_OVERLAY_ENABLED = true;
     const AD_UI_HOLD_MAX_MS = 12000;
     const userResumedHeld = () => false;
     const adLayoutRelease = () => {};
     const overlay = ctx.overlay || (ctx.overlay = { adActive: false, standby: false, frame: null, selfPausedAt: 0, revealed: false });
     const ownerAttr = () => page.owner || '';
     const overlayOwnsPlayback = () => !!page.owns;
     const resumeRefusedByUser = () => !!page.parked;
     ${FREEZE}
     const adUiDetail = () => ({ kind: 'slate' });
     // Controllable: an episode ENDS when this goes false, which is the only
     // way adUiRelease() runs (and the only way a second pod is a second pod).
     const adHoldWorthy = () => page.ad !== false;
     const mainVideo = () => video;
     const sampleVideo = () => video;
     const requestStandby = () => log.push('standby');
     const resumeNative = () => log.push('resume');
     const recLog = (n) => log.push(n + '@ad=' + rec.ad);
     const adLog = (n, f) => log.push(n + ':' + (f && f.reason ? f.reason : ''));
     const adLogState = (n) => log.push(n);
     // The shipped release clears the hold stamp (that is how a pod ending frees
     // the next one); the stub must do the same or a second pod early-returns.
     const adUiRelease = () => { state.heldAt = 0; state.reasserts = 0; log.push('ad-ui-release'); };
     const adUiHoldTick = () => {};
     // The park attribute is one DOM write in the ad path; this world has no
     // documentElement, and its own behaviour is proved by a dedicated arm that
     // extracts the real pair.
     const markAdPark = (on) => { page.park = on ? '1' : '0'; };
     const publishAdPark = () => {};
     // The hold now names its refusals through the same per-episode channel as
     // the tick (adUiTickSkip), so the world must define it or the refusal
     // would be a ReferenceError caught by the tick's own try/catch - a green
     // that proves nothing.
     const adUiTickSkip = (why) => log.push('skip:' + why);
     const document = {
       get visibilityState() { return page.visible ? 'visible' : 'hidden'; },
       getElementById: (id) => (id === 'ko-wrap' && page.wrap !== false ? {} : null),
     };
     ${HOLD.replace(/\badUiHeldAt\b/g, 'state.heldAt').replace(/\badUiReasserts\b/g, 'state.reasserts').replace(/\badUiHiddenLogged\b/g, 'state.hiddenLogged').replace(/\badUiOwnerLogged\b/g, 'state.ownerLogged').replace(/\badUiFailedAt\b/g, 'state.failedAt').replace(/\badUiFailedLogged\b/g, 'state.failedLogged')}
     ${src.replace(/\badUiHeldAt\b/g, 'state.heldAt').replace(/\badUiReasserts\b/g, 'state.reasserts').replace(/\badUiTickWhy\b/g, 'state.tickWhy').replace(/\badUiHiddenLogged\b/g, 'state.hiddenLogged').replace(/\badUiOwnerLogged\b/g, 'state.ownerLogged').replace(/\badUiFailedAt\b/g, 'state.failedAt').replace(/\badUiFailedLogged\b/g, 'state.failedLogged')}`,
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
  ctx3.page.ad = false; // the slate clears: `ad-ui-off` + `adUiRelease()`
  ctx3.page.visible = false;
  tick3(ctx3);
  ctx3.page.ad = true; // pod 2 begins while the tab is hidden again
  tick3(ctx3);
  check(
    'a SECOND pod logs its own hidden refusal (the flag is per episode)',
    ctx3.log.filter((l) => l === 'ad-skip:hidden-tab').length === 2,
    JSON.stringify(ctx3.log),
  );

  // (c3) THE SILENT RETURN THAT COST A POD. A page the overlay really owns must
  //      abstain, and now says so once; a page whose attribute is stale (no
  //      layer node) must not abstain at all - that is the 30 s slate.
  const recOwn = freshRec();
  const videoOwn = makeVideo();
  const ctxOwn = { rec: recOwn, page: { visible: true, owns: true, owner: 'kick', wrap: false }, video: videoOwn, log: [] };
  const tickOwn = makeTick(tickSrc);

  tickOwn(ctxOwn);
  tickOwn(ctxOwn);
  check(
    'an owned page refuses the hold and NAMES it (once per episode)',
    ctxOwn.log.filter((l) => l === 'ad-skip:overlay-owns').length === 1 && !ctxOwn.video.paused,
    JSON.stringify(ctxOwn.log),
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

// ---- a surviving pod object must not disarm the NEXT pod -----------------
// Owner report 2026-11-20, verbatim: "eu peguei anuncio por varios segundos".
// Measured on his own Chrome (0.8.109, twitch.tv/buzzyi_, player=kick, adblock
// on): pod 1 `ad-ui-on` 943633 -> `ad-ui-hold {act:"paused"}` 947616 ->
// `ad-ui-off {adSec:31}` with `ad-ui-release {act:"pod-owns"}`; pod 2
// `ad-ui-on` 030620 while a standby reported clean/playing at 129899, then 28
// `ad-tick` rows ALL `paused:false` (ct 4.7 -> 34.6) to `ad-ui-off {adSec:36.6}`
// - and not one `ad-ui-hold` row. The whole 1200-event ring held exactly ONE
// such row, pod 1's.
//
// TWO NAMED CAUSES, both fixed in the shipped file this arm executes:
//  1. `adUiHold` returned at `if (overlay.adActive || overlay.standby ||
//     overlay.frame) return;` writing NOTHING. A warm standby is not a cover:
//     a live `snap().who` on the same page read `{standby:true, revealed:false,
//     adActive:false, playing:true}` with no ad on screen, so the guard was
//     armed in STEADY STATE and refused every DOM hold.
//  2. `adUiTickWhy` (the one-row-per-reason dedupe) was cleared only inside
//     `adUiRelease` AFTER `if (!adUiHeldAt) return;`, so a single refused pod
//     silenced every later pod on the same reason for the whole page load.
//
// RUNS THE REAL functions - hold, tick, skip, release and the shipped tick
// body - over ONE page load with four pods.
{
  const HOLD = grab('adUiHold');
  const HOLD_TICK = grab('adUiHoldTick');
  const SKIP = grab('adUiTickSkip');
  const RELEASE = grab('adUiRelease');
  const tickBody = (() => {
    const marker = 'setInterval(() => {';
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
  check('the two-pod arm can extract the ad tick body', !!tickBody);
  // Module state becomes `S.*` so two pods share it, exactly as the page does.
  const ren = (s) => s
    .replace(/\badUiHeldAt\b/g, 'S.heldAt')
    .replace(/\badUiReasserts\b/g, 'S.reasserts')
    .replace(/\badUiHiddenLogged\b/g, 'S.hiddenLogged')
    .replace(/\badUiOwnerLogged\b/g, 'S.ownerLogged')
    .replace(/\badUiFailedAt\b/g, 'S.failedAt')
    .replace(/\badUiFailedLogged\b/g, 'S.failedLogged')
    .replace(/\badUiTickWhy\b/g, 'S.why');
  const makeWorld = (holdSrc, holdTickSrc, tickSrc) => new Function(
    'ctx',
    `const { rec, page, video, log, overlay } = ctx;
     const S = ctx.state || (ctx.state = { heldAt: 0, reasserts: 0, hiddenLogged: false, ownerLogged: false, why: '', failedAt: 0, failedLogged: false });
     const AD_OVERLAY_ENABLED = true;
     const AD_UI_HOLD_MAX_MS = 12000;
     const userResumedHeld = () => false;
     const adLayoutRelease = () => {};
     const ownerAttr = () => '';
     const overlayOwnsPlayback = () => false;
     const standbyStale = () => false;
     const stopAdOverlay = (why) => log.push('stop:' + why);
     const endPod = () => {};
     const requestStandby = () => log.push('standby');
     const resumeNative = () => { video.paused = false; log.push('resume'); };
     const adUiDetail = () => ({ kind: 'slate' });
     const adHoldWorthy = () => page.ad !== false;
     const mainVideo = () => video;
     const sampleVideo = () => video;
     const resumeRefusedByUser = () => !!page.parked;
     // This world has no mounted clean frame; the shipped predicate's answer is
     // false, so a failed hold hands the native back instead of revealing one.
     const cleanFrameCanCover = () => false;
     // markAdPark writes one attribute on the page the ad path owns; here the
     // fact lands on page.park so an arm can read it. publishAdPark is the
     // derived clear, and it is the real pair that ships (proved by its own arm).
     const markAdPark = (on) => { page.park = on ? '1' : '0'; };
     const publishAdPark = () => { page.park = (overlay.adActive || overlay.revealed || !!S.heldAt) ? '1' : '0'; };
     ${grab('freezeNativeForPod')}
     const recLog = (n, d) => log.push(n + (d && d.hold ? ':hold=' + JSON.stringify(d.hold) : ''));
     const adLog = (n, f) => log.push(n + ':' + ((f && (f.why || f.act || f.reason)) || ''));
     const adLogState = (n, f) => log.push(n + ':' + ((f && (f.act || f.reason)) || 'state'));
     const document = { visibilityState: 'visible', getElementById: () => null };
     ${ren(SKIP)}
     ${ren(holdTickSrc)}
     ${ren(RELEASE)}
     ${ren(holdSrc)}
     const tick = () => ${ren(tickSrc)};
     return { tick, S };`,
  );
  const build = (holdSrc, holdTickSrc, tickSrc) => {
    const video = {
      paused: false, isConnected: true, currentTime: 100, readyState: 4, w: 1920, rs: 4,
      pause() { this.paused = true; },
    };
    const overlay = { adActive: false, standby: false, frame: null, revealed: false, playing: false, selfPausedAt: 0 };
    const ctx = {
      rec: { ad: false, adSince: 0, playing: false, lastTick: 0 },
      page: { ad: false }, video, log: [], overlay,
    };
    const w = makeWorld(holdSrc, holdTickSrc, tickSrc)(ctx);
    const count = (label) => ctx.log.filter((l) => l === label).length;
    return { video, overlay, ctx, w, log: ctx.log, count };
  };
  const a = build(HOLD, HOLD_TICK, tickBody);
  // POD A - no overlay at all: the baseline that must stay green.
  a.ctx.page.ad = true;
  a.w.tick();
  check(
    'pod A: a detected ad pauses the native and names the hold',
    a.video.paused === true && a.count('ad-ui-hold:paused') === 1,
    JSON.stringify(a.log),
  );
  // POD A ends. The hand-back leaves a WARM STANDBY + a minted frame behind -
  // the pod object his ring shows outliving the episode (`ad-ui-release
  // {act:"pod-owns"}`).
  a.overlay.standby = true;
  a.overlay.frame = {};
  a.overlay.revealed = false;
  a.overlay.adActive = false;
  a.ctx.page.ad = false;
  a.w.tick();
  check(
    'pod A releases (native resumed) and its verdict rides on ad-ui-off',
    a.video.paused === false && a.log.some((l) => l.startsWith('ad-ui-off:hold=')),
    JSON.stringify(a.log),
  );
  // POD B - THE MEASURED POD 2: detected while that standby/frame survives.
  a.ctx.page.ad = true;
  a.w.tick();
  check(
    'pod B: a surviving standby/frame does NOT disarm the hold (native PAUSED)',
    a.video.paused === true && a.count('ad-ui-hold:paused') === 2,
    JSON.stringify(a.log),
  );
  // POD C - the overlay actually paints: the HOLD abstains (our picture is up),
  // and the native is FROZEN under it. The abstention was the whole point of the
  // `pod-owns` row; the freeze is the missing half (measured in the owner's
  // 0.8.111 ring: 30 s of `ad-tick {video:{paused:false, rs:4}}` while the clean
  // frame was revealed, and a hand-back with 1.9 s of runway).
  a.ctx.page.ad = false;
  a.w.tick();
  a.overlay.adActive = true;
  a.overlay.revealed = true;
  a.overlay.standby = false;
  a.ctx.page.ad = true;
  a.w.tick();
  check(
    'pod C: a painted pod freezes the native and names the reason',
    a.video.paused === true && a.count('ad-ui-hold:pod-owns') === 1,
    JSON.stringify(a.log),
  );
  // POD C2 - Twitch's own ad renderer calls play() again. The next tick must
  // take the pause back; one pause is not a freeze (the 0.8.51 contract).
  a.video.paused = false;
  a.w.tick();
  check(
    'pod C2: a page that resumed its own element is frozen again on the next tick',
    a.video.paused === true,
    JSON.stringify(a.log),
  );
  // POD C3 - a player the USER parked is never resumed or re-paused by us.
  a.ctx.page.parked = true;
  a.video.paused = false; // the page's own player took it back
  a.w.tick();
  check(
    'pod C3: a user-parked player is left alone (the freeze refuses)',
    a.video.paused === false,
    JSON.stringify(a.log),
  );
  a.ctx.page.parked = false;
  // The painted pod ENDS: stopAdOverlay() hands the picture back and resumes
  // the native. Without this the release below defers to a pod that owns the
  // screen (correctly) and the next pod starts from a frozen element.
  a.overlay.adActive = false;
  a.overlay.revealed = false;
  a.video.paused = false;
  // POD D - back to a warm standby: the SAME reason must be able to speak
  // again, which is what a dedupe surviving its episode forbids.
  a.ctx.page.ad = false;
  a.w.tick();
  a.overlay.adActive = false;
  a.overlay.revealed = false;
  a.overlay.standby = true;
  a.ctx.page.ad = true;
  a.w.tick();
  check(
    'pod D: a later pod on the same shape is held and logged again (dedupe is per episode)',
    a.video.paused === true && a.count('ad-ui-hold:paused') === 3,
    JSON.stringify(a.log),
  );

  // POD E - THE HOLD'S BUDGET RUNS OUT WITH NO PICTURE. This is the freeze the
  // owner reported on 0.8.112 (`ad-ui-hold {why:"hold-expired", heldMs:12498}`
  // and then `hb {paused:true, ct:1023.3, rs:4}` at one position for 71 s).
  // Three things must happen, and each of them was missing:
  //   1. the element is handed back (a pause with no picture is a freeze),
  //   2. the stamp is CLEARED, or every later tick returns `hold-expired` again,
  //   3. the park is withdrawn, so content.js's stall watchdog may recover it.
  a.ctx.page.ad = false;
  a.overlay.adActive = false;
  a.overlay.revealed = false;
  a.overlay.standby = false;
  a.w.tick(); // pod D ends; the hand-back resumes
  a.ctx.page.ad = true;
  a.w.tick(); // pod E takes its hold
  const ePausedAtHold = a.video.paused;
  // The ad is STILL on screen (`page.ad` stays true) and no clean source ever
  // became healthy; the stamp is aged past AD_UI_HOLD_MAX_MS (12 s).
  a.w.S.heldAt = Date.now() - 13000;
  a.w.tick();
  check(
    'pod E: an expired hold hands the picture back, clears the stamp and withdraws the park',
    ePausedAtHold === true && a.video.paused === false
      && a.w.S.heldAt === 0
      && a.count('ad-ui-hold:release') === 1
      && a.count('ad-ui-hold:hold-failed') === 1
      && a.ctx.page.park === '0',
    JSON.stringify({ ePausedAtHold, paused: a.video.paused, heldAt: a.w.S.heldAt, park: a.ctx.page.park, failed: a.count('ad-ui-hold:hold-failed'), release: a.count('ad-ui-hold:release') }),
  );
  // ...and the SAME episode must not take the hold again: Twitch's own renderer
  // resumes the element, and a hold that re-pauses it every 500 ms is a stutter
  // on an ad the user is watching (the 12 s hold would restart, fail, restart).
  a.video.paused = false; // the page resumed its own element after our release
  const beforeRehold = a.count('ad-ui-hold:paused');
  a.w.tick();
  a.w.tick();
  check(
    'pod E2: the failed episode is not re-held (the picture stays his)',
    a.video.paused === false && a.count('ad-ui-hold:paused') === beforeRehold,
    JSON.stringify({ paused: a.video.paused, failedAt: a.w.S.failedAt, heldAt: a.w.S.heldAt, n: a.count('ad-ui-hold:paused'), beforeRehold }),
  );
  // POD F - the NEXT pod starts clean: the failure is per episode, not per load.
  a.ctx.page.ad = false;
  a.w.tick();
  a.ctx.page.ad = true;
  a.w.tick();
  check(
    'pod F: a later pod takes its hold again after the failed one (episode reset)',
    a.video.paused === true && a.count('ad-ui-hold:paused') === beforeRehold + 1,
    JSON.stringify(a.log),
  );
  a.ctx.page.ad = false;
  a.w.tick();

  // THE PARK ATTRIBUTE ITSELF. `content.js` lives in the isolated world and can
  // only see the page through its DOM, so the ad path's own pause has to be
  // declared there; a reader that finds nothing reads "a healthy parked player
  // stays parked" (the 71 s). These two functions are the whole contract, run
  // here rather than through a stub.
  {
    const MARK = grab('markAdPark');
    const PUB = grab('publishAdPark');
    const make = (pubSrc) => new Function(
      'overlay',
      `let adUiHeldAt = 0;
       let adParkShown = false;
       const document = { documentElement: { a: {}, setAttribute(k, v) { this.a[k] = v; }, getAttribute(k) { return this.a[k] === undefined ? null : this.a[k]; } } };
       ${MARK}
       ${pubSrc}
       return { markAdPark, publishAdPark, doc: document, hold(v) { adUiHeldAt = v; } };`,
    );
    const w = make(PUB)({ adActive: false, revealed: false });
    w.markAdPark(true);
    const setOnPause = w.doc.documentElement.getAttribute('data-ko-adpark');
    w.markAdPark(false);
    const cleared = w.doc.documentElement.getAttribute('data-ko-adpark');
    // A hold with no overlay is still a park, and the tick's derivation must say
    // so; a pod is a park; neither is a park once the episode ends.
    w.hold(Date.now());
    w.publishAdPark();
    const onHold = w.doc.documentElement.getAttribute('data-ko-adpark');
    w.hold(0);
    w.publishAdPark();
    const offHold = w.doc.documentElement.getAttribute('data-ko-adpark');
    w.publishAdPark(); // an unchanged derivation writes nothing
    const stillOff = w.doc.documentElement.getAttribute('data-ko-adpark');
    check(
      'the park attribute is written before the pause and derived clear by the tick',
      setOnPause === '1' && cleared === '0' && onHold === '1' && offHold === '0' && stillOff === '0',
      JSON.stringify({ setOnPause, cleared, onHold, offHold, stillOff }),
    );
    // RED: derive it from the overlay alone and a HOLD with no frame is
    // invisible to content.js - exactly his expired hold.
    const redPub = PUB.replace(' || adUiHeldAt)', ')');
    check('the park-derivation mutation applied to the shipped publisher', redPub !== PUB);
    if (redPub !== PUB) {
      const r2 = make(redPub)({ adActive: false, revealed: false });
      r2.hold(Date.now());
      r2.publishAdPark();
      check(
        'RED: a hold with no overlay is invisible to the page (his expired hold)',
        r2.doc.documentElement.getAttribute('data-ko-adpark') === null,
        String(r2.doc.documentElement.getAttribute('data-ko-adpark')),
      );
    }
  }

  // RED: restore the shipped guard (`adActive || standby || frame`) and the
  // same pod B leaves the ad PLAYING - the pod the owner took.
  const revert = (s) => s.split('if (overlay.adActive || overlay.revealed) {').join('if (overlay.adActive || overlay.standby || overlay.frame) {');
  // The pre-fix branch had no freeze inside it either: stripping the guard
  // alone would leave the freeze behind and the RED would prove the stop of
  // the wrong defect.
  const stripFreeze0 = (s) => s
    .split('      const pv = freezeNativeForPod();\n').join('      const pv = null;\n')
    .split('if (overlay.adActive || overlay.revealed) freezeNativeForPod();').join('');
  const redHold = stripFreeze0(revert(HOLD));
  const redTick = stripFreeze0(revert(HOLD_TICK));
  check('the leftover-standby mutation applied to the shipped hold', redHold !== HOLD);
  check('the leftover-standby mutation applied to the shipped tick', redTick !== HOLD_TICK);
  if (redHold !== HOLD && redTick !== HOLD_TICK) {
    const r = build(redHold, redTick, tickBody);
    r.ctx.page.ad = true;
    r.w.tick();
    r.overlay.standby = true;
    r.overlay.frame = {};
    r.overlay.revealed = false;
    r.overlay.adActive = false;
    r.ctx.page.ad = false;
    r.w.tick();
    // The pod's own hand-back resumes the native (the pre-fix release defers to
    // the standby, so without this the red would show the frozen picture
    // instead of the ad that actually played).
    r.video.paused = false;
    r.ctx.page.ad = true;
    r.w.tick();
    check(
      'RED: with the leftover standby the pre-fix guard leaves the ad PLAYING (his pod 2)',
      r.video.paused === false && r.count('ad-ui-hold:paused') === 1,
      JSON.stringify(r.log),
    );
  }

  // RED: THE MISSING FREEZE ITSELF. Strip it from all three sites (the hold
  // edge, the tick and the other 500 ms tick) and a painted pod leaves the
  // native playing behind its own picture - the 30 s of `ad-tick
  // {video:{paused:false, rs:4}}` that produced the 1.9 s hand-back.
  const noFreezeHold = stripFreeze0(HOLD);
  const noFreezeTick = stripFreeze0(HOLD_TICK);
  const noFreezeBody = stripFreeze0(tickBody);
  check('the freeze mutation applied to the hold and the tick', noFreezeHold !== HOLD && noFreezeTick !== HOLD_TICK);
  if (noFreezeHold !== HOLD && noFreezeTick !== HOLD_TICK) {
    const f = build(noFreezeHold, noFreezeTick, noFreezeBody);
    f.overlay.adActive = true;
    f.overlay.revealed = true;
    f.ctx.page.ad = true;
    f.w.tick();
    check(
      'RED: without the freeze a revealed pod leaves the ad playing behind it',
      f.video.paused === false,
      JSON.stringify(f.log),
    );
  }

  // RED: THE PRE-FIX HOLD-EXPIRED LINE ITSELF. `return adUiTickSkip('hold-expired')`
  // kept the stamp (so the tick re-judged the same expired hold forever) and
  // resumed nothing - his 71 s at `ct:1023.3`. The mutant restores exactly that
  // line, so the arm above would read a paused element and a set stamp.
  const oldExpiry = (s) => {
    const live = /if \(Date\.now\(\) - adUiHeldAt > AD_UI_HOLD_MAX_MS\) \{[\s\S]*?\n    \}\n    const v = mainVideo\(\);/;
    if (!live.test(s)) return s;
    return s.replace(live, "if (Date.now() - adUiHeldAt > AD_UI_HOLD_MAX_MS) return adUiTickSkip('hold-expired');\n    const v = mainVideo();");
  };
  const redExpiryTick = oldExpiry(HOLD_TICK);
  check('the hold-expiry mutation applied to the shipped tick', redExpiryTick !== HOLD_TICK && /adUiTickSkip\('hold-expired'\)/.test(redExpiryTick));
  if (redExpiryTick !== HOLD_TICK) {
    const x = build(HOLD, redExpiryTick, tickBody);
    x.ctx.page.ad = true;
    x.w.tick();
    x.w.S.heldAt = Date.now() - 13000;
    x.w.tick();
    x.w.tick();
    check(
      'RED: the pre-fix expiry leaves the element parked and keeps re-judging it (his 71 s)',
      x.video.paused === true && x.w.S.heldAt > 0 && x.count('ad-ui-hold:release') === 0,
      JSON.stringify({ paused: x.video.paused, heldAt: x.w.S.heldAt, log: x.log }),
    );
  }
}

// ---- the ownership READER (the stale publish that cost a whole pod) ------
// Measured 2026-11-19 on twitch.tv/alanzoka (no kick channel): `ad-ui-on` at
// 188911 and `ad-ui-off {adSec:29.7}` at 218566 with `visible {own:"kick"}` in
// between, while every heartbeat said `kick:null wrapShown:false` and a live
// probe read `#ko-wrap` absent. The ad path abstained for the whole slate on an
// attribute no layer backed. These arms run the REAL `overlayOwnsPlayback()`.
{
  const OWNER = grab('overlayOwnsPlayback');
  const makeOwn = (attr, wrapNode, opts = {}) => new Function(
    'document',
    `const OWNER_CLEAR_MS = ${opts.clearMs ?? 4000};
     const overlay = { ownerSeenAt: ${opts.seenAt ?? 0}, ownerClearAt: 0 };
     function ownerAttr() { return String(document.documentElement.getAttribute('data-ko-owner') || ''); }
     ${OWNER}
     return () => ({ owns: overlayOwnsPlayback(), seenAt: overlay.ownerSeenAt });`,
  );
  const docWith = (attr, wrapNode) => ({
    documentElement: { getAttribute: (k) => (k === 'data-ko-owner' ? attr : null) },
    getElementById: (id) => (id === 'ko-wrap' ? wrapNode : null),
  });
  // makeOwn builds the world; calling the result with the document runs the
  // predicate and calling THAT returns the observation.
  const run = (world, doc) => world(doc)();
  const WRAP = { id: 'ko-wrap' };

  // (1) the shipped file requires the node at all.
  check('the ownership reader consults #ko-wrap, not the attribute alone', /getElementById\('ko-wrap'\)/.test(OWNER));

  // (2) THE MEASURED CASE: attribute says kick, no layer in the document.
  const stale = run(makeOwn('kick', null, { seenAt: Date.now() }), docWith('kick', null));
  check(
    'an attribute with NO layer node does not own playback (the 30 s pod)',
    stale.owns === false && stale.seenAt === 0,
    JSON.stringify(stale),
  );

  // (3) A real layer with the attribute still owns: the guard cannot cost the
  //     ad protection on the pages the overlay is actually serving.
  const live = run(makeOwn('kick', WRAP), docWith('kick', WRAP));
  check('an attribute WITH a live layer node still owns playback', live.owns === true, JSON.stringify(live));

  // (4) The latch still covers a re-buffer: attribute empty, node present,
  //     the page owned once already.
  const latched = run(makeOwn('', WRAP, { seenAt: Date.now() }), docWith('', WRAP));
  check('the latch still holds a re-buffer after the attribute empties', latched.owns === true, JSON.stringify(latched));

  // (4b) ...and it RELEASES the moment the node is gone, because on that page
  //      there is no screen left to protect. Keeping the latch for a layer that
  //      no longer exists would abstain for OWNER_CLEAR_MS on the very page the
  //      guard was added for: his alanzoka tab published "kick" with no layer.
  const released = run(makeOwn('kick', null, { seenAt: Date.now() }), docWith('kick', null));
  check(
    'a stale publish with no node clears the latch instead of holding it',
    released.owns === false && released.seenAt === 0,
    JSON.stringify(released),
  );

  // (5) RED: the pre-fix reader (attribute alone) abstains on the measured page.
  const preFix = new Function(
    'document',
    `const OWNER_CLEAR_MS = 4000;
     const overlay = { ownerSeenAt: 0, ownerClearAt: 0 };
     function ownerAttr() { return String(document.documentElement.getAttribute('data-ko-owner') || ''); }
     function overlayOwnsPlayback() { const o = ownerAttr(); if (o) { overlay.ownerSeenAt = overlay.ownerSeenAt || 1; return true; } return false; }
     return () => overlayOwnsPlayback();`,
  );
  check(
    'RED: the attribute alone reports ownership on a page with no layer (his pod)',
    preFix(docWith('kick', null))() === true,
  );
}


// ---- Defect B: playlist-opened pod ends on DOM ad-ui-off -----------------
// adUiRelease(fromUiOff) on a playlist-opened revealed pod must end via
// finishAdOverlay() (chrome-linger grace owned there), emit one pod-end row,
// and reach stopAdOverlay('ad-end'). A flap (ad-ui-on) inside the linger must
// cancel overlay.adEndTimer and reset overlay.adEndTries so the pod survives.
{
  const RELEASE = grab('adUiRelease');
  const FINISH = grab('finishAdOverlay');

  // Playlist-opened pod, ad-ui-off while revealed -> ends once, one row.
  {
    const ctx = {
      log: [],
      stopCalls: [],
      overlay: { frame: {}, revealed: true, adActive: true, playlistPodAt: Date.now() - 5000, adEndTimer: 0, adEndTries: 0, standby: false },
      adUiHeldAt: 0, adUiReasserts: 0, adUiTickWhy: 'held', present: false, standbyReq: 0,
    };
    const adLog = (name, data) => ctx.log.push({ name, data });
    const stopAdOverlay = (reason) => { ctx.stopCalls.push(reason); ctx.overlay.frame = null; ctx.overlay.adActive = false; ctx.overlay.revealed = false; ctx.overlay.playlistPodAt = 0; };
    const requestStandby = () => { ctx.standbyReq++; };
    const real = new Function(
      'ctx', 'adLog', 'stopAdOverlay', 'requestStandby', 'setTimeout', 'clearTimeout',
      [
        'let adUiHeldAt = ctx.adUiHeldAt;',
        'let adUiReasserts = ctx.adUiReasserts;',
        'let adUiTickWhy = ctx.adUiTickWhy;',
        'const overlay = ctx.overlay;',
        'const adUiPresent = () => ctx.present;',
        'const document = { visibilityState: "visible" };',
        'const mainVideo = () => null;',
        'const resumeNative = () => {};',
        'const adLayoutRelease = () => {};',
        'const adUiHoldTarget = () => null;',
        'const endPod = () => {};',
        FINISH,
        RELEASE,
        'return { adUiRelease, finishAdOverlay };',
      ].join('\n')
    )(ctx, adLog, stopAdOverlay, requestStandby, setTimeout, clearTimeout);
    real.adUiRelease(true);
    const rows = ctx.log.filter((r) => r && r.name === 'ad-ui-release' && r.data && r.data.act === 'pod-end');
    check(
      'B: playlist-opened pod ends on ad-ui-off via finishAdOverlay with one pod-end row',
      rows.length === 1 && ctx.stopCalls.length === 1 && ctx.stopCalls[0] === 'ad-end'
        && typeof rows[0].data.heldMs === 'number' && typeof rows[0].data.podAgeMs === 'number' && rows[0].data.revealed === true,
      JSON.stringify({ rows, stopCalls: ctx.stopCalls, log: ctx.log })
    );
  }

  // Flap: ad-ui-off starts linger, ad-ui-on cancels pending finish.
  {
    const ctx = {
      log: [], stopCalls: [],
      overlay: { frame: {}, revealed: true, adActive: true, playlistPodAt: Date.now() - 3000, adEndTimer: 0, adEndTries: 0, standby: false },
      adUiHeldAt: 0, adUiReasserts: 0, adUiTickWhy: '', present: true,
    };
    const timers = [];
    const fakeSet = (fn, ms) => { const id = { fn, ms, cleared: false }; timers.push(id); return id; };
    const fakeClear = (id) => { if (id) id.cleared = true; };
    const adLog = (name, data) => ctx.log.push({ name, data });
    const stopAdOverlay = (reason) => { ctx.stopCalls.push(reason); ctx.overlay.frame = null; };
    const requestStandby = () => {};
    const real = new Function(
      'ctx', 'adLog', 'stopAdOverlay', 'requestStandby', 'setTimeout', 'clearTimeout',
      [
        'let adUiHeldAt = ctx.adUiHeldAt;',
        'let adUiReasserts = ctx.adUiReasserts;',
        'let adUiTickWhy = ctx.adUiTickWhy;',
        'const overlay = ctx.overlay;',
        'const adUiPresent = () => ctx.present;',
        'const document = { visibilityState: "visible" };',
        'const mainVideo = () => null;',
        'const resumeNative = () => {};',
        'const adLayoutRelease = () => {};',
        'const adUiHoldTarget = () => null;',
        'const endPod = () => {};',
        FINISH,
        RELEASE,
        'return { adUiRelease, finishAdOverlay };',
      ].join('\n')
    )(ctx, adLog, stopAdOverlay, requestStandby, fakeSet, fakeClear);
    real.adUiRelease(true);
    const pending = ctx.overlay.adEndTimer && !ctx.overlay.adEndTimer.cleared;
    fakeClear(ctx.overlay.adEndTimer);
    ctx.overlay.adEndTimer = 0;
    ctx.overlay.adEndTries = 0;
    for (const tmr of timers) { if (!tmr.cleared) tmr.fn(); }
    check(
      'B: ad-ui-on flap inside linger cancels finish and pod survives',
      pending && ctx.stopCalls.length === 0 && ctx.overlay.frame && ctx.overlay.adActive && ctx.overlay.adEndTries === 0,
      JSON.stringify({ pending, stopCalls: ctx.stopCalls, frame: !!ctx.overlay.frame, adActive: ctx.overlay.adActive, tries: ctx.overlay.adEndTries })
    );
  }

  // RED: pre-fix adUiRelease keeps pod-owns on ad-ui-off.
  {
    const shipped = grab('adUiRelease');
    const oldRelease = `  function adUiRelease() {
    // THE REASON IS CLEARED ON EVERY EPISODE END, HELD OR NOT. It used to sit
    // after \`if (!adUiHeldAt) return;\`, so the first pod that was refused
    // poisoned the per-episode dedupe for the rest of the page load: the ring
    // got its one row, and every later pod on the same reason was silent.
    adUiTickWhy = '';
    if (!adUiHeldAt) return;
    const heldMs = Date.now() - adUiHeldAt;
    adUiHeldAt = 0;
    const reasserts = adUiReasserts;
    adUiReasserts = 0;
    // ONLY A CLAIMED / PAINTED POD OWNS THE RESUME. Two resumers on one element
    // was the pause/resume churn the 2026-11-09 wave removed, but a warm
    // standby does not resume anything (a standby shutdown never touches the
    // native), so deferring to it left this hold's pause in place - the frozen
    // picture. \`resumeNative\` only acts on a paused element, so a pod that has
    // already resumed is a no-op.
    if (overlay.adActive || overlay.revealed) {
      adLog('ad-ui-release', { heldMs, act: 'pod-owns', reasserts });
      return;
    }
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    const v = mainVideo();
    if (!v || !v.isConnected) return;
    adLog('ad-ui-release', { heldMs, act: v.paused ? 'resume' : 'playing', reasserts });
    if (v.paused) resumeNative(v, 'ad-ui-release');
  }`;
    const preFixSrc = SRC.replace(shipped, oldRelease);
    check('B: the pod-end mutation applied to the shipped file', preFixSrc !== SRC && /function adUiRelease\(\)/.test(preFixSrc));
    if (preFixSrc !== SRC) {
      const RELEASE_OLD = grab('adUiRelease', preFixSrc);
      const FINISH_REAL = grab('finishAdOverlay');
      const ctx = {
        log: [], stopCalls: [],
        overlay: { frame: {}, revealed: true, adActive: true, playlistPodAt: Date.now() - 3000, adEndTimer: 0, adEndTries: 0, standby: false },
        adUiHeldAt: 0, adUiReasserts: 0, adUiTickWhy: '', present: false,
      };
      const adLog = (name, data) => ctx.log.push({ name, data });
      const stopAdOverlay = (reason) => { ctx.stopCalls.push(reason); ctx.overlay.frame = null; ctx.overlay.adActive = false; ctx.overlay.revealed = false; };
      const requestStandby = () => {};
      const real = new Function(
        'ctx', 'adLog', 'stopAdOverlay', 'requestStandby', 'setTimeout', 'clearTimeout',
        [
          'let adUiHeldAt = ctx.adUiHeldAt;',
          'let adUiReasserts = ctx.adUiReasserts;',
          'let adUiTickWhy = ctx.adUiTickWhy;',
          'const overlay = ctx.overlay;',
          'const adUiPresent = () => ctx.present;',
          'const document = { visibilityState: "visible" };',
          'const mainVideo = () => null;',
          'const resumeNative = () => {};',
          'const adUiHoldTarget = () => null;',
          FINISH_REAL,
          RELEASE_OLD,
          'return { adUiRelease };',
        ].join('\n')
      )(ctx, adLog, stopAdOverlay, requestStandby, setTimeout, clearTimeout);
      real.adUiRelease(true);
      const podEnd = ctx.log.filter((r) => r && r.name === 'ad-ui-release' && r.data && r.data.act === 'pod-end');
      check(
        'B RED: pre-fix ad-ui-off leaves playlist pod owned (no pod-end, no stopAdOverlay)',
        podEnd.length === 0 && ctx.stopCalls.length === 0 && ctx.overlay.frame && ctx.overlay.adActive,
        JSON.stringify({ podEnd, stopCalls: ctx.stopCalls, frame: !!ctx.overlay.frame, adActive: ctx.overlay.adActive, log: ctx.log })
      );
    }
  }
}


// ---- 4c. A SMALL LOGO BEFORE THE BANNER MUST NOT HIDE THE BANNER ----------
// The shipped walk stopped at the first painted descendant that was bigger
// than 20x20. A 40x24 logo before a 900x120 banner left `best` below the
// half-player-width gate and the squeeze was ignored.
function logoFirstArm(src, note) {
  const r = squeezeRun(src, {
    logoFirst: true, cw: 1000, ch: 751, vw: 1000, vh: 605,
    wrapperW: 40, bw: 900, bh: 120,
  });
  const ok = !!r.detail && r.detail.kind === 'banner-squeeze' && r.detail.dw === 900
    && r.holdWorthy(r.detail, r.video) === true;
  if (note) note(JSON.stringify(r.detail));
  return ok;
}
const earlyBreakSrc = SRC.replace(
  '        for (let i = kids.length - 1; i >= 0 && stack.length < AD_SURFACE_MAX_NODES - 1; i--) {\n          if (kids[i]) stack.push(kids[i]);\n        }',
  '        for (let i = kids.length - 1; i >= 0; i--) {\n          if (kids[i]) stack.push(kids[i]);\n        }\n        if (best.width > 20 && best.height > 20) break;',
);
check('the early-break mutation applied to the shipped walk', earlyBreakSrc !== SRC);
redArm('the old first-paint break hides a banner behind a logo', earlyBreakSrc, logoFirstArm);
check(
  'a logo before a wide banner still yields the banner and a hold-worthy squeeze',
  logoFirstArm(SRC),
);

// ---- 4d. A MID-POD NODE SWAP MUST NOT LEAVE THE NEW WRAPPER HIDDEN --------
function replacedNodesArm(src, note) {
  const r = squeezeRun(src, { replaceMidPod: true });
  r.release();
  const row = r.logs.find((l) => l.ev === 'ad-layout' && l.d.act === 'release');
  const ok = !!r.detail && !!row && Number(row.d.stale) >= 1
    && r.repWrapper.style.visibility === ''
    && r.repVideo.style.height === '540px' && r.repVideo.style.width === '960px';
  if (note) note(JSON.stringify({ visibility: r.repWrapper.style.visibility, row: row && row.d }));
  return ok;
}
const staleBlindSrc = SRC.replace(
  '      const detached = !s.el || s.el.isConnected === false;',
  '      const detached = false;',
);
check('the stale-node mutation applied to the shipped release', staleBlindSrc !== SRC);
redArm('the pre-fix release leaves a replaced wrapper hidden', staleBlindSrc, replacedNodesArm);
check('a mid-pod node swap is released onto the connected wrapper', replacedNodesArm(SRC));

const props = squeezeRun(SRC);
props.release();
const restoreRow = props.logs.find((l) => l.ev === 'ad-layout' && l.d.act === 'restore' && !l.d.skipped);
check(
  'layout save/restore covers height, width and max-height on all three elements',
  !!restoreRow && ['container', 'videoRef', 'video'].every((n) =>
    `${n}W` in restoreRow.d.before && `${n}MaxH` in restoreRow.d.before)
    && props.container.style.width === '' && props.container.style['max-height'] === ''
    && props.videoRef.style.width === '' && props.videoRef.style['max-height'] === ''
    && props.video.style.width === '960px' && props.video.style['max-height'] === '540px',
  JSON.stringify(restoreRow && restoreRow.d),
);
check(
  'a missing persistent player is named and never throws',
  missingNodeRun.logs.some((l) => l.ev === 'ad-layout' && l.d.skipped === 'missing-node'
    && Array.isArray(l.d.missing) && l.d.missing.includes('persistent')),
  JSON.stringify(missingNodeRun.logs),
);

// ---- anti-vacuity --------------------------------------------------------

// ---- POD BOUNDARY: eight fixes, each with a pre-fix RED mutation ----------
const podMutate = (from, to, src = SRC) => {
  if (!src.includes(from)) throw new Error(`pod mutation target missing: ${from.slice(0, 70)}`);
  return src.split(from).join(to);
};

// 1. The evidence predicate is the single owner of "is there an ad?".
function evidenceArm(src) {
  const E = grab('podEvidence', src);
  const R = grab('podEvidenceRefuse', src);
  const ctx = { kind: null, rows: [] };
  const w = new Function('ctx', [
    'const adLog = (ev, d) => ctx.rows.push({ ev, d });',
    'const adUiDetail = () => ctx.kind ? { kind: ctx.kind, w: 1280, h: 720 } : null;',
    'const mainVideo = () => ({ getBoundingClientRect: () => ({ width: 1280, height: 720 }) });',
    'const adHoldWorthy = (d, v) => !!d && (d.kind === "aria" || d.kind === "slate" || d.w >= 0.5 * v.getBoundingClientRect().width);',
    E, R,
    'return { podEvidence, podEvidenceRefuse };',
  ].join('\n'))(ctx);
  const stale = w.podEvidence({ from: 'playlist', adExtinf: 16, extinf: 17, adOnly: false, hasStitched: true, at: Date.now() - 4000 });
  w.podEvidenceRefuse('playlist', stale);
  const allAd = w.podEvidence({ from: 'playlist', adExtinf: 3, extinf: 3, adOnly: true });
  ctx.kind = 'slate';
  const domAd = w.podEvidence({ from: 'playlist', adExtinf: 16, extinf: 17, adOnly: false });
  return { ctx, stale, allAd, domAd };
}
check('E1: stale adExtinf alone is refused with a row; DOM and all-ad evidence pass', () => {
  const { ctx, stale, allAd, domAd } = evidenceArm(SRC);
  const row = ctx.rows.find((r) => r.ev === 'ad-skip');
  return stale.worthy === false && allAd.worthy === true && domAd.worthy === true
    && !!row && row.d.reason === 'no-ad-evidence' && row.d.adExtinf === 16
    && row.d.adUi === null && Number.isFinite(row.d.markerAgeMs);
});
redArm('E1 RED: the pre-fix gate accepts a stale marker with no ad painted',
  podMutate('worthy: !!(dom || adOnly),', 'worthy: Number(msg && msg.adExtinf) > 0,'),
  (src) => { const { stale } = evidenceArm(src); return stale.worthy === false; });

// 2. The page ceiling is a TIMER, and the worker has its own.
function podTimerArm(src) {
  const PM = grab('podMaxEnd', src);
  const EM = grab('emitPodMax', src);
  const ctx = { rows: [], ends: [], overlay: { playlistPodAt: Date.now() - 30000 }, ev: { adExtinf: 16, extinf: 17, adOnly: false, markerAgeMs: 4000 } };
  new Function('ctx', [
    'const overlay = ctx.overlay;',
    'let podMaxLogged = false;',
    'const lastPodEvidence = ctx.ev;',
    'const adLog = (ev, d) => ctx.rows.push({ ev, d });',
    'const endPlaylistPod = (reason, d) => ctx.ends.push({ reason, d });',
    'const requestStandby = () => {};',
    EM, PM,
    'return { podMaxEnd };',
  ].join('\n'))(ctx).podMaxEnd();
  return ctx;
}
check('E2: an own AD_POD_MAX_MS timer ends the pod with a named ad-pod-max row', () => {
  const c = podTimerArm(SRC);
  const row = c.rows.find((r) => r.ev === 'ad-pod-max');
  return c.ends.length === 1 && c.ends[0].reason === 'pod-max' && !!row
    && row.d.podAgeMs >= 30000 && row.d.adExtinf === 16 && row.d.adOnly === false;
});
redArm('E2 RED: without the timer branch no pod end is reachable at the ceiling',
  podMutate("    endPlaylistPod('pod-max', { podAgeMs });", '    void 0;'),
  (src) => { const c = podTimerArm(src); return !(c.ends.length === 0); });

function workerTimerArm(src) {
  const WM = grab('workerPodMax', src);
  const WE = grab('workerEndPod', src);
  const ctx = { posts: [], active: true, streak: 0, startedAt: Date.now() - 61000, marker: { at: Date.now() - 1000, adExtinf: 16, extinf: 17, adOnly: false } };
  const w = new Function('ctx', [
    'let adBypassActive = ctx.active;',
    'let cleanPlaylistStreak = ctx.streak;',
    'let noEvidenceSkipLogged = false;',
    'let bypassStartedAt = ctx.startedAt;',
    'let podMaxTimer = 123;',
    'const AD_POD_MAX_MS = 60000;',
    'const lastAdMarker = ctx.marker;',
    'const lastChannel = "rodil";',
    'const clearTimeout = () => {};',
    'const postBypass = (m) => ctx.posts.push(m);',
    WE, WM,
    'return { workerPodMax, state: () => ({ active: adBypassActive, startedAt: bypassStartedAt, timer: podMaxTimer }) };',
  ].join('\n'))(ctx);
  w.workerPodMax();
  return { ctx, state: w.state() };
}
check('E2b: the worker ceiling clears its own flags and posts an ad-end with evidence', () => {
  const { ctx, state } = workerTimerArm(SRC);
  const p = ctx.posts[0];
  return ctx.posts.length === 1 && p.type === 'ad-end' && p.reason === 'pod-max'
    && p.podAgeMs > 60000 && p.adExtinf === 16 && Number.isFinite(p.markerAgeMs)
    && state.active === false && state.startedAt === 0 && state.timer === 0;
});
redArm('E2b RED: a stopped fetch left the worker pod open with no ad-end',
  podMutate('if (!adBypassActive || !bypassStartedAt || Date.now() - bypassStartedAt <= AD_POD_MAX_MS) return;', 'if (true) return;'),
  (src) => { const { ctx } = workerTimerArm(src); return !(ctx.posts.length === 0); });
// EVERY POD END DOOR MUST DISARM THE BYPASS, NOT JUST THE FIRST ONE. The worker
// has two end doors (`pod-max` here and `clean-playlists` below), and both go
// through `workerEndPod`; `adBypassActive` is what the page's `need-source`
// door, the prewarm gate and this loader's hand-back all read as "a pod owns
// the picture". An armed flag after the pod ended means the NEXT ad playlist
// opens no pod at all and the page's 180 s timeout is the only thing that can
// end it - the measured shape of an ad that plays uncovered to its last second.
check('E2c: a pod end truly clears the bypass, not only this pod\'s own timer', () => {
  const { state } = workerTimerArm(SRC);
  return state.active === false && state.startedAt === 0;
});
redArm('E2c RED: a pod end that leaves the bypass armed refuses every later pod',
  podMutate('      adBypassActive = false;\n      noEvidenceSkipLogged = false;', '      noEvidenceSkipLogged = false;'),
  (src) => { const { state } = workerTimerArm(src); return state.active === false; });

// 3. A playlist pod reaches ad-ui-release pod-end without a DOM ad signal.
function playlistEndArm(src) {
  const EP = grab('endPlaylistPod', src);
  const ctx = { releases: [], ends: [] };
  new Function('ctx', [
    'const adUiRelease = (from, reason) => ctx.releases.push({ from, reason });',
    'const endPod = (reason, d) => ctx.ends.push({ reason, d });',
    EP, 'return { endPlaylistPod };',
  ].join('\n'))(ctx).endPlaylistPod('pod-max', { podAgeMs: 59000 });
  return ctx;
}
check('E3: a playlist pod reaches ad-ui-release pod-end at its ceiling', () => {
  const c = playlistEndArm(SRC);
  return c.releases.length === 1 && c.releases[0].from === true && c.releases[0].reason === 'pod-max'
    && c.ends.length === 1 && c.ends[0].reason === 'pod-max';
});
redArm('E3 RED: pre-fix ad-ui-release was unreachable for a playlist-only pod',
  podMutate('    adUiRelease(true, reason);', '    void 0;'),
  (src) => { const c = playlistEndArm(src); return !(c.releases.length === 0); });

function domLeaveArm(src) {
  const PL = grab('playlistPodDomLeave', src);
  const ctx = { calls: [], overlay: { playlistPodAt: Date.now() - 5000, adActive: true, revealed: false, handbackWait: null } };
  new Function('ctx', [
    'const overlay = ctx.overlay;',
    'let playlistSawDomAd = true;',
    'const adUiHeldAt = 0;',
    'const endPlaylistPod = (reason, d) => ctx.calls.push({ reason, d });',
    PL, 'return { playlistPodDomLeave };',
  ].join('\n'))(ctx).playlistPodDomLeave();
  return ctx;
}
check('E3b: a DOM ad leaving during a playlist pod is an independent end door', () => {
  const c = domLeaveArm(SRC);
  return c.calls.length === 1 && c.calls[0].reason === 'dom-ad-left';
});
redArm('E3b RED: the marker kept the pod open after the ad left',
  podMutate('    if (!open || !playlistSawDomAd || adUiHeldAt || overlay.handbackWait) return;', '    if (true) return;'),
  (src) => { const c = domLeaveArm(src); return !(c.calls.length === 0); });

// 4. Every end clears workerRoutePodAt, not just the clean-streak one.
function endPodArm(src) {
  const EP = grab('endPod', src);
  const ctx = { rows: [], releases: [], route: 12345, overlay: { playlistPodAt: 1, adActive: true, podMaxTimer: {} } };
  const w = new Function('ctx', [
    'let workerRoutePodAt = ctx.route;',
    'let workerRouteClean = 2;',
    'let playlistSawDomAd = true;',
    'let podEnded = false;',
    'let lastPodEvidence = null;',
    'const overlay = ctx.overlay;',
    'const adUiHeldAt = 0;',
    'const adLog = (ev, d) => ctx.rows.push({ ev, d });',
    'const clearTimeout = () => {};',
    'const releasePodFreeze = (r) => ctx.releases.push(r);',
    EP,
    'return { endPod, route: () => workerRoutePodAt };',
  ].join('\n'))(ctx);
  w.endPod('timeout', { from: 'test' }, false);
  return { ctx, route: w.route() };
}
check('E4: any pod end clears the route flag and writes one named row', () => {
  const { ctx, route } = endPodArm(SRC);
  const row = ctx.rows.find((r) => r.ev === 'ad-pod-end');
  return route === 0 && ctx.rows.length === 1 && !!row && row.d.reason === 'timeout';
});
redArm('E4 RED: only the clean-streak end cleared the route flag',
  podMutate('    workerRoutePodAt = 0;', '    void 0;'),
  (src) => { const { route } = endPodArm(src); return !(route !== 0); });

// 5. A playlist pod ending on a still-truthy detector releases its own freeze.
function freezeReleaseArm(src) {
  const R = grab('releasePodFreeze', src);
  const ctx = { rows: [], resumes: [], video: { paused: true, isConnected: true, currentTime: 42 } };
  new Function('ctx', [
    'const mainVideo = () => ctx.video;',
    'const userResumedHeld = () => false;',
    'const resumeRefusedByUser = () => false;',
    'const selfPausedRecently = () => true;',
    'const AD_POD_MAX_MS = 60000;',
    'const adLog = (ev, d) => ctx.rows.push({ ev, d });',
    'const resumeNative = (v, tag) => ctx.resumes.push(tag);',
    R, 'return { releasePodFreeze };',
  ].join('\n'))(ctx).releasePodFreeze('pod-max');
  return ctx;
}
check('E5: the pod releases the element it froze and names the reason', () => {
  const c = freezeReleaseArm(SRC);
  const row = c.rows.find((r) => r.ev === 'pod-freeze-release');
  return c.resumes.length === 1 && c.resumes[0] === 'pod-freeze-release' && !!row
    && row.d.released === true && row.d.reason === 'pod-max';
});
redArm('E5 RED: a pod ending on a still-detected ad never resumed its element',
  podMutate("    resumeNative(v, 'pod-freeze-release');", '    void 0;'),
  (src) => { const c = freezeReleaseArm(src); return !(c.resumes.length === 0); });

// 6. A pause stamp is trusted for the hold's budget, not ten minutes.
function pauseTrustArm(src) {
  const fn = grab('selfPausedRecently', src);
  const m = /const SELF_PAUSE_TRUST_MS = ([^;]+);/.exec(src);
  if (!m) throw new Error('missing SELF_PAUSE_TRUST_MS');
  return new Function(`const SELF_PAUSE_TRUST_MS = ${m[1]}; ${fn}; return selfPausedRecently;`)(
    { selfPausedAt: Date.now() - 20000 }
  );
}
check('E6: a pause older than the 12 s hold is not called ours', () => pauseTrustArm(SRC) === false);
redArm('E6 RED: a 10-minute trust window reads an expired hold pause as ours',
  podMutate('const SELF_PAUSE_TRUST_MS = 12 * 1000;', 'const SELF_PAUSE_TRUST_MS = 10 * 60 * 1000;'),
  (src) => pauseTrustArm(src) === false);

// 7. Every direct adpark writer keeps the derived cache in step.
function adParkArm(src) {
  const M = grab('markAdPark', src);
  const P = grab('publishAdPark', src);
  const ctx = { writes: [], root: { setAttribute: (k, v) => ctx.writes.push(v) } };
  const w = new Function('ctx', [
    'let adParkShown = false;',
    'const document = { documentElement: ctx.root };',
    'const overlay = { adActive: false, revealed: false };',
    'const adUiHeldAt = 1;',
    M, P,
    'return { markAdPark, publishAdPark, shown: () => adParkShown };',
  ].join('\n'))(ctx);
  w.markAdPark(true);
  w.publishAdPark();
  return { ctx, shown: w.shown() };
}
check('E7: a direct adpark writer and the derivation never disagree', () => {
  const { ctx, shown } = adParkArm(SRC);
  return ctx.writes.length === 1 && ctx.writes[0] === '1' && shown === true;
});
redArm('E7 RED: the stale cache rewrites an attribute a direct writer set',
  podMutate('      adParkShown = !!on;', '      void 0;'),
  (src) => { const { ctx } = adParkArm(src); return !(ctx.writes.length === 2); });

// 8. The rows the docs promise have a producer with the promised fields.
function promisedRowsArm(src) {
  const S = grab('emitPodStart', src);
  const M = grab('emitPodMax', src);
  const ctx = { rows: [] };
  const ev = { adExtinf: 16, extinf: 17, adOnly: false, hasStitched: true, changed: true };
  const w = new Function('ctx', [
    'const adLog = (ev, d) => ctx.rows.push({ ev, d });',
    'const pageChannel = () => "rodil";',
    'let podMaxLogged = false;',
    S, M,
    'return { emitPodStart, emitPodMax };',
  ].join('\n'))(ctx);
  w.emitPodStart({ channel: 'rodil', from: 'playlist', ...ev }, ev);
  w.emitPodMax({ podAgeMs: 59000, adExtinf: 16, extinf: 17, adOnly: false, markerAgeMs: 4000 });
  return ctx.rows;
}
check('E8: ad-bypass-start and ad-pod-max carry the fields the verdict reads', () => {
  const rows = promisedRowsArm(SRC);
  const s = rows.find((r) => r.ev === 'ad-bypass-start');
  const m = rows.find((r) => r.ev === 'ad-pod-max');
  return !!s && ['channel', 'from', 'adExtinf', 'extinf', 'adOnly', 'hasStitched', 'changed']
    .every((k) => k in s.d)
    && !!m && ['podAgeMs', 'adExtinf', 'extinf', 'adOnly', 'markerAgeMs'].every((k) => k in m.d);
});
redArm('E8 RED: the pre-fix code wrote only bypass-msg and no promised row',
  podMutate("adLog('ad-bypass-start', {", "adLog('bypass-msg', {"),
  (src) => promisedRowsArm(src).some((r) => r.ev === 'ad-bypass-start'));
// ---- THE SUFFIX IS A MEASUREMENT, NEVER THE DECISION (measured live 2026-11-27) ----------
// Our own token rewrite makes Twitch serve the page's player a cloudfront `index-muted-*.m3u8`
// whose segments carry no ",live" (KO-20261127-08). `playlistInfo()` called that whole live
// stream `adOnly` with 1789 segments, while `stripAds()` - acting on the same bytes - refuses to
// look for ads without Twitch's own stitched-ad marker. One question, two predicates, and the
// suffix one false-positived 100%.
const UNMARKED_LIVE = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  ...Array.from({ length: 6 }, (_, i) => `#EXTINF:2.000,\nhttps://d2vi6trrdongqn.cloudfront.net/x_kaicenat_1/index-muted-AAA/${i}.ts`),
].join('\n');
const MARKED_AD = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-DATERANGE:ID="twitch-stitched-ad-2001",CLASS="twitch-stitched-ad",START-DATE="2026-10-27T00:00:00.000Z",DURATION=4.000,X-TV-TWITCH-AD-URL="https://ads.example/creative/2001"',
  '#EXTINF:2.000,\nhttps://video-edge-a.playlist.ttvnw.net/v1/segment/4200.ts',
  '#EXTINF:2.000,\nhttps://video-edge-a.playlist.ttvnw.net/v1/segment/4201.ts',
].join('\n');
const MARKED_CLEAN = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXTINF:2.000,live\nhttps://video-edge-a.playlist.ttvnw.net/v1/segment/9000.ts',
  '#EXTINF:2.000,live\nhttps://video-edge-a.playlist.ttvnw.net/v1/segment/9001.ts',
].join('\n');
function playlistInfoArm(src) {
  const P = grab('playlistInfo', src);
  const M = grabConst('TWITCH_AD_MARKER', src);
  const info = (text) => new Function(`${M};\n${P};\nreturn playlistInfo(${JSON.stringify(text)});`)();
  return { unmarked: info(UNMARKED_LIVE), ad: info(MARKED_AD), clean: info(MARKED_CLEAN) };
}
check('E9: a suffix-only playlist is unmarked, not an ad; the marker decides and the count stays raw', () => {
  const { unmarked, ad, clean } = playlistInfoArm(SRC);
  return unmarked.adOnly === false && unmarked.hasStitched === false
    // The measurement is kept: 6 of 6 segments lack ",live" and the ring can still see that.
    && unmarked.adExtinf === unmarked.extinf && unmarked.extinf === 6
    && ad.adOnly === true && ad.hasStitched === true && ad.adExtinf === ad.extinf
    && clean.adOnly === false && clean.adExtinf === 0 && clean.extinf === 2;
});
redArm('E9 RED: the pre-fix suffix-only decision calls a whole live stream an ad',
  podMutate('adOnly: hasStitched && extinf.length > 0 && adExtinf.length === extinf.length,',
    'adOnly: extinf.length > 0 && adExtinf.length === extinf.length,'),
  (src) => playlistInfoArm(src).unmarked.adOnly === false);

// ---- THE PLAYER'S LOADER IS NOT ALWAYS `fetch` (measured live 2026-11-27) ----------------
// The player's worker was the patched one (stack: `new KoAdblockWorker` -> `new Wrapped` from
// `player-core-variant-a-...`), the page video had a `MediaSourceHandle`, and 13 live minutes produced
// zero playlists of the player's own in `stats.workerPlaylistLog`. The worker wrapped `self.fetch`
// only; an XHR loader carried the stream, so the playlist-level defence had no transport. These arms
// run the SHIPPED `workerMain` and drive a real XMLHttpRequest shape through it.
function workerWorld(src, fetchImpl) {
  const posts = [];
  class FakeBC {
    constructor(name) { this.name = name; }
    postMessage(m) { posts.push({ ch: this.name, m }); }
    addEventListener() {}
  }
  class FakeXHR {
    constructor() {
      this._load = [];
      this.responseType = '';
      this.responseText = '';
    }
    open(method, url) { this._url = url; }
    addEventListener(type, fn) { if (type === 'load') this._load.push(fn); }
    send() {}
    fire(text) { this.responseText = text; for (const f of this._load) f(); }
  }
  const self = {
    fetch: fetchImpl || (async () => new Response('')),
    XMLHttpRequest: FakeXHR,
    addEventListener() {},
    postMessage() {},
    location: { href: 'https://www.twitch.tv/rodil' },
  };
  const fn = new Function(
    'self', 'BroadcastChannel', 'Response', 'URL', 'TextDecoder', 'atob', 'btoa', 'performance',
    'setTimeout', 'clearTimeout', 'fetch',
    'const __KO_CLIENT_ID="cid",__KO_GQL_HASH="h",__KO_GQL_URL="https://gql",__KO_PLAYER_TYPE="site",' +
      '__KO_PLATFORM="web",__KO_PAGE_ID="p1";' + grab('workerMain', src) + '\nworkerMain();',
  );
  fn(self, FakeBC, Response, URL, TextDecoder, atob, btoa, performance, setTimeout, clearTimeout, fetch);
  return { self, posts, FakeXHR };
}
const LIVE_PLAYLIST = '#EXTM3U\n#EXTINF:2.000,live\na.ts\n#EXTINF:2.000,\nb.ts\n';
function xhrDigestArm(src) {
  const w = workerWorld(src);
  const x = new w.self.XMLHttpRequest();
  x.open('GET', 'https://video-edge-a.playlist.ttvnw.net/v1/playlist/live.m3u8?token=abc');
  x.send();
  x.fire(LIVE_PLAYLIST);
  return w.posts.filter((p) => p.m.type === 'playlist');
}
check('the player\'s XHR playlist reaches the digest and names its transport', () => {
  const d = xhrDigestArm(SRC);
  return d.length === 1 && d[0].m.transport === 'xhr' && d[0].m.extinf === 2 && d[0].m.adExtinf === 1;
});
check('a non-playlist XHR body writes no digest', () => {
  const w = workerWorld(SRC);
  const x = new w.self.XMLHttpRequest();
  x.open('GET', 'https://gql.twitch.tv/gql');
  x.send();
  x.fire('{"data":null}');
  const y = new w.self.XMLHttpRequest();
  y.open('GET', 'https://video-edge-a.playlist.ttvnw.net/v1/playlist/live.m3u8');
  y.send();
  y.fire('#EXTM3U\n');
  return w.posts.filter((p) => p.m.type === 'playlist').length === 0;
});
function transportHitArm(src) {
  const w = workerWorld(src);
  const a = new w.self.XMLHttpRequest();
  a.open('GET', 'https://video-edge-a.playlist.ttvnw.net/v1/playlist/live1.m3u8');
  const b = new w.self.XMLHttpRequest();
  b.open('GET', 'https://video-edge-a.playlist.ttvnw.net/v1/playlist/live2.m3u8');
  return w.posts.filter((p) => p.m.type === 'transport').map((p) => p.m);
}
check('the first XHR request says which transport the player uses, once', () => {
  const hits = transportHitArm(SRC);
  // The page's consumer refuses any message whose `page` is not its own: a row without it is dropped
  // on the floor, which is exactly how the first version of this transport row shipped silent.
  return hits.length === 1 && hits[0].transport === 'xhr' && /live1\.m3u8/.test(hits[0].url) && hits[0].page === 'p1';
});
check('a transport hit is not a playlist digest and cannot open a pod', () => {
  const w = workerWorld(SRC);
  const x = new w.self.XMLHttpRequest();
  x.open('GET', 'https://video-edge-a.playlist.ttvnw.net/v1/playlist/live.m3u8');
  return w.posts.every((p) => p.m.type !== 'playlist');
});
redArm('RED: without the transport row the loader is invisible again',
  SRC.replace("    function noteTransport(transport, url) {\n      try {\n        if (!debugChannel || transportSeen[transport]) return;", "    function noteTransport(transport, url) {\n      try {\n        return;\n        if (!debugChannel || transportSeen[transport]) return;"),
  (src) => transportHitArm(src).length > 0);

redArm('RED: without the XHR transport the player\'s playlist never reaches the digest',
  (() => {
    const start = SRC.indexOf('    // THE PLAYER\'S LOADER IS NOT ALWAYS `fetch`.');
    const end = SRC.indexOf('  }\n\n  // Twitch moved its player to a SHARED worker');
    return start > 0 && end > start ? SRC.slice(0, start) + SRC.slice(end + 4) : SRC;
  })(),
  (src) => xhrDigestArm(src).length > 0);

// ---- THE WORKER'S OWN AD DECISIONS MUST READ THE MARKER (measured 2026-11-27) ----------
// The page refuses a suffix-only playlist at its ad-start door, but the worker still opened a pod
// from `info.adExtinf > 0`: our token rewrite earns cloudfront `index-muted-*` variants with no
// ",live" on any segment, so the clean-streak close could never fire and only the 60 s ceiling
// ended the cover. These arms run the SHIPPED workerMain(), findCleanHlsUrl(), stripAds() and
// prewarm branch, not a copy of their predicates.
async function workerPlaylistArm(src, text) {
  const fetchImpl = async (input) => {
    const u = String((input && input.url) || input || '');
    if (/\/channel\/hls\//.test(u)) return new Response('');
    if (u.includes('gql.twitch.tv')) return new Response(JSON.stringify({ data: null }));
    if (/\.m3u8/.test(u)) return new Response(text);
    return new Response('', { status: 500 });
  };
  const w = workerWorld(src, fetchImpl);
  const token = encodeURIComponent(JSON.stringify({ player_type: 'site', platform: 'web' }));
  // A BOUND ON EVERY FETCH CALL SITE, even the stub's: `fail_fast_audit` reads a
  // call with no `signal`/`timeout` on the line or in the six after it as a hang,
  // and it cannot know this implementation is local. 2 s is the ceiling this
  // arm's stub would ever need, and the bound stays true if the stub is replaced.
  await w.self.fetch(`https://usher.ttvnw.net/api/v2/channel/hls/rodil.m3u8?token=${token}`, { signal: AbortSignal.timeout(2000) });
  await new Promise((r) => setTimeout(r, 0));
  await w.self.fetch('https://video-edge-a.playlist.ttvnw.net/v1/playlist/live.m3u8?token=abc', { signal: AbortSignal.timeout(2000) });
  await new Promise((r) => setTimeout(r, 0));
  return {
    holds: w.posts.filter((p) => p.m.type === 'ad-hold'),
    starts: w.posts.filter((p) => p.m.type === 'ad-start'),
    skips: w.posts.filter((p) => p.ch === 'ko-adblock-debug' && p.m.step === 'bypass.skip-no-ad-evidence'),
  };
}
async function triggerArm(src, note) {
  const r = await workerPlaylistArm(src, UNMARKED_LIVE);
  const row = r.skips[0] && r.skips[0].m.detail;
  if (note) note(JSON.stringify({ holds: r.holds.length, starts: r.starts.length, skips: r.skips.length, row }));
  return r.holds.length === 0 && r.starts.length === 0 && r.skips.length === 1
    && !!row && row.reason === 'no-ad-evidence' && row.from === 'worker-playlist'
    && row.adExtinf === 6 && row.extinf === 6 && row.hasStitched === false && row.adOnly === false;
}
async function cleanVariantArm(src, note) {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n'
    + 'https://video-edge-a.playlist.ttvnw.net/v1/playlist/variant.m3u8\n';
  const realFetch = async (input) => {
    const u = String((input && input.url) || input || '');
    if (u.includes('gql.twitch.tv')) {
      return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } }));
    }
    if (u.includes('/channel/hls/')) return new Response(master);
    if (/\.m3u8/.test(u)) return new Response(UNMARKED_LIVE);
    return new Response('', { status: 500 });
  };
  const url = await new Function(
    'realFetch', 'debugLog',
    "const __KO_GQL_URL='https://gql.twitch.tv/gql',__KO_CLIENT_ID='cid',__KO_GQL_HASH='h',"
      + "__KO_PLAYER_TYPE='site',__KO_PLATFORM='web';\n"
      + [grabConst('TWITCH_AD_MARKER', src), grab('playlistInfo', src), grab('parseVariants', src),
        grabAsync('mintMasterUrl', src), grabAsync('findCleanHlsUrl', src), 'return findCleanHlsUrl("rodil");'].join('\n'),
  )(realFetch, () => {});
  if (note) note(String(url));
  return url;
}
const GENERIC_STITCHED = [
  '#EXTM3U',
  '#EXT-X-DATERANGE:ID="ad-1",CLASS="stitched,ad",START-DATE="2026-11-27T00:00:00.000Z",DURATION=4.000',
  '#EXTINF:2.000,live\na.ts',
  '#EXTINF:2.000,live\nb.ts',
].join('\n');
function stripDatarangeArm(src, text = GENERIC_STITCHED) {
  return new Function([
    grabConst('TWITCH_AD_MARKER', src), grab('stripAds', src),
    `return stripAds(${JSON.stringify(text)});`,
  ].join('\n'))();
}
function prewarmBranchArm(src, note) {
  const anchor = 'if (liveMedia && info.extinf > 0 && ';
  const start = src.lastIndexOf(anchor, src.lastIndexOf('prewarmCleanSource(lastChannel)'));
  if (start < 0) throw new Error('prewarm branch missing');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  const ctx = { called: 0 };
  new Function('liveMedia', 'info', 'adBypassActive', 'prewarmCleanSource', 'lastChannel', 'ctx',
    `${src.slice(start, i + 1)}\nreturn ctx.called;`)(
    true, { extinf: 6, adExtinf: 6, hasStitched: false, adOnly: false }, false,
    () => { ctx.called++; }, 'rodil', ctx,
  );
  const kept = /postStandbyStart\(channel, fastUrl\)/.test(src);
  if (note) note(JSON.stringify({ called: ctx.called, kept }));
  return ctx.called === 1 && kept;
}
async function runAdPathArms() {
  await redArmAsync('E10 RED: the old adExtinf trigger opens a pod on an unmarked live playlist',
    podMutate('if (liveMedia && info.adExtinf > 0 && (info.hasStitched || info.adOnly)) {', 'if (liveMedia && info.adExtinf > 0) {'),
    triggerArm);
  check('E10: an unmarked live playlist opens no worker pod and its refusal is named in the ring', await triggerArm(SRC));
  const marked = await workerPlaylistArm(SRC, MARKED_AD);
  check('E10b: a marker-bearing live playlist still opens the worker pod',
    marked.holds.length === 1 && marked.skips.length === 0,
    JSON.stringify({ holds: marked.holds.length, skips: marked.skips.length }));
  await redArmAsync('E11 RED: the old adExtinf===0 probe rejects an unmarked live variant',
    podMutate('if (info.extinf > 0 && !info.hasStitched) return url;', 'if (info.extinf > 0 && info.adExtinf === 0) return url;'),
    cleanVariantArm);
  check('E11: findCleanHlsUrl accepts an unmarked live variant', (await cleanVariantArm(SRC)) !== null);
  const dataRangeArm = (src, note) => {
    const out = stripDatarangeArm(src);
    if (note) note(out);
    return !out.includes('#EXT-X-DATERANGE') && out.includes('#EXTINF:2.000,live');
  };
  await redArmAsync('E12 RED: the old duplicated DATARANGE regex leaves a generic stitched marker in the playlist',
    podMutate("if (line.startsWith('#EXT-X-DATERANGE') && TWITCH_AD_MARKER.test(line)) {",
      "if (line.startsWith('#EXT-X-DATERANGE') && /twitch-stitched-ad|X-TV-TWITCH-AD-URL/i.test(line)) {"),
    dataRangeArm);
  check('E12: stripAds strips a DATARANGE matching the owned marker under a generic stitched spelling', dataRangeArm(SRC));
  check('E12b: stripAds leaves an unmarked playlist unchanged', stripDatarangeArm(SRC, MARKED_CLEAN) === MARKED_CLEAN);
  await redArmAsync('E13 RED: the old prewarm predicate misses the unmarked live grace window',
    podMutate('if (liveMedia && info.extinf > 0 && !info.hasStitched && !adBypassActive) {',
      'if (liveMedia && info.extinf > 0 && info.adExtinf === 0 && !adBypassActive) {'), prewarmBranchArm);
  check('E13: prewarm keys on the marker and keeps postStandbyStart', prewarmBranchArm(SRC));
}

// ---- A REWRITE THAT THREW IS NOT A BODY THAT NEEDED NO REWRITE (measured 2026-11-27) ----
// `rewriteTokenBody` had `catch { return body; }`: a GQL body it could not parse was served
// UNREWRITTEN, which is the site player's own ad-bearing token, and the ring could not tell that
// from a clean body because both exits returned `body` in silence. The arms below run the SHIPPED
// function text with its real collaborators injected, not a copy of its predicates.
function rewriteTokenArm(src, body) {
  const start = src.indexOf('  function rewriteTokenBody(body) {');
  if (start < 0) throw new Error('rewriteTokenBody is gone');
  let i = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const text = src.slice(start, end);
  const rows = [];
  const stats = { rewrites: 0 };
  const fn = new Function('PLAYER_TYPE', 'CLEAN_PLATFORM', 'stats', 'adLog',
    `return (${text.trim()});`)('popout', 'web', stats, (ev, d) => rows.push({ ev, d }));
  return { out: fn(body), rows, stats };
}
check('E14: a token body the rewrite cannot parse is served unchanged and named', () => {
  const broken = '{"variables":{"playerType":"site"} PlaybackAccessToken';
  const r = rewriteTokenArm(SRC, broken);
  return r.out === broken
    && r.rows.length === 1 && r.rows[0].ev === 'token-rewrite-failed'
    && /JSON|Unexpected/i.test(String(r.rows[0].d && r.rows[0].d.error))
    && r.rows[0].d.len === broken.length;
});
check('E14b: a body that needed no rewrite writes no failure row', () => {
  const body = JSON.stringify({ variables: { playerType: 'site', platform: 'web' } });
  const r = rewriteTokenArm(SRC, body);
  return r.out !== body && r.rows.length === 0 && r.stats.rewrites === 1;
});
redArm('RED: without the row a failed rewrite is indistinguishable from a clean body',
  SRC.replace("    } catch (e) {\n      // A body we could not parse is served UNREWRITTEN", "    } catch (e) {\n      return body;\n      // A body we could not parse is served UNREWRITTEN"),
  (src) => rewriteTokenArm(src, '{"variables":{"playerType":"site"} PlaybackAccessToken').rows.length > 0);

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
  'a bare 160x90 banner is not painted wide enough to squeeze',
  'a bare banner on an unshrunk player is NOT worth pausing for',
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
  'an owned page refuses the hold and NAMES it (once per episode)',
  'the retry mutation applied to the shipped tick',
  'RED: without the retry the pod runs its whole length unheld (his 30.0 s)',
  'the two-pod arm can extract the ad tick body',
  'pod A: a detected ad pauses the native and names the hold',
  'pod A releases (native resumed) and its verdict rides on ad-ui-off',
  'pod B: a surviving standby/frame does NOT disarm the hold (native PAUSED)',
  'pod D: a later pod on the same shape is held and logged again (dedupe is per episode)',
  'pod E: an expired hold hands the picture back, clears the stamp and withdraws the park',
  'pod E2: the failed episode is not re-held (the picture stays his)',
  'pod F: a later pod takes its hold again after the failed one (episode reset)',
  'the hold-expiry mutation applied to the shipped tick',
  'the park attribute is written before the pause and derived clear by the tick',
  'the park-derivation mutation applied to the shipped publisher',
  'RED: a hold with no overlay is invisible to the page (his expired hold)',
  'RED: the pre-fix expiry leaves the element parked and keeps re-judging it (his 71 s)',
  'the leftover-standby mutation applied to the shipped hold',
  'the leftover-standby mutation applied to the shipped tick',
  'pod C: a painted pod freezes the native and names the reason',
  'pod C2: a page that resumed its own element is frozen again on the next tick',
  'pod C3: a user-parked player is left alone (the freeze refuses)',
  'RED: with the leftover standby the pre-fix guard leaves the ad PLAYING (his pod 2)',
  'the freeze mutation applied to the hold and the tick',
  'RED: without the freeze a revealed pod leaves the ad playing behind it',
  'the ownership reader consults #ko-wrap, not the attribute alone',
  'an attribute with NO layer node does not own playback (the 30 s pod)',
  'an attribute WITH a live layer node still owns playback',
  'the latch still holds a re-buffer after the attribute empties',
  'a stale publish with no node clears the latch instead of holding it',
  'RED: the attribute alone reports ownership on a page with no layer (his pod)',
  'B: playlist-opened pod ends on ad-ui-off via finishAdOverlay with one pod-end row',
  'B: ad-ui-on flap inside linger cancels finish and pod survives',
  'B: the pod-end mutation applied to the shipped file',
  'B RED: pre-fix ad-ui-off leaves playlist pod owned (no pod-end, no stopAdOverlay)',
  'a healthy 714x325 video in a 714x402 player is NOT a squeeze',
  'a painted wide banner is a banner squeeze with both box pairs',
  'a wide lower third at 12% of the area is worth holding',
  'the picture is kept full-size and the ad wrapper is hidden',
  'ad-layout restore logs before, after and the banner',
  'ad-layout release restores the EXACT original inline styles',
  'ad-layout release is logged once',
  'the permanent hidden shell is NOT an ad',
  'a wrapper below half the player width is NOT a squeeze',
  'a fullscreen player is never squeezed',
  'our own clean frame is never squeezed',
  'a full-height painted ad is a wrapper, never a layout change',
  'a missing layout node is reported, not guessed',
  'the painted-wrapper mutation applied to the shipped file',
  'RED: without the painted wrapper the banner squeeze is invisible',
  'the layout-restore mutation applied to the shipped file',
  'RED: without the layout restore the picture stays shrunk',
  'the width-gate mutation applied to the shipped file',
  'RED: the old area gate refuses the wide lower third',
  'the early-break mutation applied to the shipped walk',
  'the old first-paint break hides a banner behind a logo',
  'a logo before a wide banner still yields the banner and a hold-worthy squeeze',
  'the stale-node mutation applied to the shipped release',
  'the pre-fix release leaves a replaced wrapper hidden',
  'a mid-pod node swap is released onto the connected wrapper',
  'layout save/restore covers height, width and max-height on all three elements',
  'a missing persistent player is named and never throws',
  'E1: stale adExtinf alone is refused with a row; DOM and all-ad evidence pass',
  'E1 RED: the pre-fix gate accepts a stale marker with no ad painted',
  'E2: an own AD_POD_MAX_MS timer ends the pod with a named ad-pod-max row',
  'E2 RED: without the timer branch no pod end is reachable at the ceiling',
  'E2b: the worker ceiling clears its own flags and posts an ad-end with evidence',
  'E2b RED: a stopped fetch left the worker pod open with no ad-end',
  "E2c: a pod end truly clears the bypass, not only this pod's own timer",
  'E2c RED: a pod end that leaves the bypass armed refuses every later pod',
  'E3: a playlist pod reaches ad-ui-release pod-end at its ceiling',
  'E3 RED: pre-fix ad-ui-release was unreachable for a playlist-only pod',
  'E3b: a DOM ad leaving during a playlist pod is an independent end door',
  'E3b RED: the marker kept the pod open after the ad left',
  'E4: any pod end clears the route flag and writes one named row',
  'E4 RED: only the clean-streak end cleared the route flag',
  'E5: the pod releases the element it froze and names the reason',
  'E5 RED: a pod ending on a still-detected ad never resumed its element',
  'E6: a pause older than the 12 s hold is not called ours',
  'E6 RED: a 10-minute trust window reads an expired hold pause as ours',
  'E7: a direct adpark writer and the derivation never disagree',
  'E7 RED: the stale cache rewrites an attribute a direct writer set',
  'E8: ad-bypass-start and ad-pod-max carry the fields the verdict reads',
  'E8 RED: the pre-fix code wrote only bypass-msg and no promised row',
  'E9: a suffix-only playlist is unmarked, not an ad; the marker decides and the count stays raw',
  'E9 RED: the pre-fix suffix-only decision calls a whole live stream an ad',
  "the player's XHR playlist reaches the digest and names its transport",
  'a non-playlist XHR body writes no digest',
  "RED: without the XHR transport the player's playlist never reaches the digest",
  'the first XHR request says which transport the player uses, once',
  'a transport hit is not a playlist digest and cannot open a pod',
  'RED: without the transport row the loader is invisible again',
  'E10 RED: the old adExtinf trigger opens a pod on an unmarked live playlist',
  'E10: an unmarked live playlist opens no worker pod and its refusal is named in the ring',
  'E10b: a marker-bearing live playlist still opens the worker pod',
  'E11 RED: the old adExtinf===0 probe rejects an unmarked live variant',
  'E11: findCleanHlsUrl accepts an unmarked live variant',
  'E12 RED: the old duplicated DATARANGE regex leaves a generic stitched marker in the playlist',
  'E12: stripAds strips a DATARANGE matching the owned marker under a generic stitched spelling',
  'E12b: stripAds leaves an unmarked playlist unchanged',
  'E13 RED: the old prewarm predicate misses the unmarked live grace window',
  'E13: prewarm keys on the marker and keeps postStandbyStart',
  'E14: a token body the rewrite cannot parse is served unchanged and named',
  'E14b: a body that needed no rewrite writes no failure row',
  'RED: without the row a failed rewrite is indistinguishable from a clean body',
];
(async () => {
  await runAdPathArms();
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
  console.log(`RESULT PASS ad-detect: the DOM detector sees the ad Twitch paints, and the media worker is hooked (failed=${failures})`);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
