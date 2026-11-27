// Property/differential oracle over the SHIPPED decision functions, no browser.
//
// Layer 3 of the 5-Layer Agentic Test Protocol, added because the quality audit
// measured `property_tests 0` over 177 tests (score 90, not 100). This suite
// does not author copies of the decisions: it extracts the real functions from
// the real product files with a string/comment/REGEX-aware brace scanner, then
// the deterministic engine in ../_tools/property-harness.mjs generates cases.
//
// Properties:
//   1. playlistInfo(): Twitch's marker is decisive for `adOnly`; `adExtinf`
//      stays the raw ,live measurement under both marker arms.
//   2. currentSlug() accepts exactly the valid generated channel keys and
//      rejects the invalid ones; overlayTargetRoute() AGREES with it (the two
//      shipped readers of one predicate, i.e. a differential arm).
//   3. want(surface).muted = intent || policy || surface !== visible, for every
//      boolean combination (also enumerated exhaustively, not just sampled).
//
// Each property has a RED arm: one exact pre-fix mutation of the extracted
// source must make it fail. `node kick-overlay/property-invariants-test.cjs`
// from either the repo root or kick-overlay/ (paths use __dirname).
'use strict';
const fs = require('fs');
const path = require('path');

const AD = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8').replace(/\r\n/g, '\n');
const CONTENT = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const AUDIO = fs.readFileSync(path.join(__dirname, 'ko-audio.js'), 'utf8').replace(/\r\n/g, '\n');

const RUNS = Number(process.env.KO_PROP_RUNS || 128);
const SEED = Number(process.env.KO_PROP_SEED || 1337);

// Extract `function name(...) {...}` by brace matching that skips strings,
// templates, comments and REGEX literals. A naive brace counter breaks on
// overlayTargetRoute()'s `/^\/[A-Za-z0-9_-]{6,20}(?:\/|$)/`: its `{6,20}` is
// not a block. (Same technique as cold-cover-fixture-test.cjs, regex-aware.)
function regexAllowed(src, slash) {
  let j = slash - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  const prev = src[j];
  if (prev && /[=([,:!&|?{};]/.test(prev)) return true;
  const word = /([A-Za-z_$]+)$/.exec(src.slice(0, j + 1));
  return !!word && /^(?:return|case|throw|typeof|instanceof|in|of|new|delete|void|yield|else|do)$/.test(word[1]);
}

function extractFunction(src, name) {
  const header = `function ${name}(`;
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`function ${name}() not found in source`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      for (; i < src.length; i += 1) {
        if (src[i] === '\\') { i += 1; continue; }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === '/' && regexAllowed(src, i)) {
      i += 1;
      let inClass = false;
      for (; i < src.length; i += 1) {
        const c = src[i];
        if (c === '\\') { i += 1; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      while (/[A-Za-z]/.test(src[i + 1] || '')) i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}()`);
}

function mutate(src, from, to) {
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error(`mutation anchor has ${hits} hits, expected 1: ${from.slice(0, 60)}`);
  return src.replace(from, to);
}

const MUTATIONS = {
  playlist: [
    'adOnly: hasStitched && extinf.length > 0 && adExtinf.length === extinf.length,',
    'adOnly: extinf.length > 0 && adExtinf.length === extinf.length,',
  ],
  channel: [
    'if (!/^[a-z0-9_]{2,25}$/.test(s) || NOT_CHANNEL.has(s)) return null;',
    'if (!/^[a-z0-9_]{1,26}$/.test(s) || NOT_CHANNEL.has(s)) return null;',
  ],
  mute: [
    'muted: !!(it.muted || policy.has(surface) || visibleNow() !== surface),',
    'muted: !!(policy.has(surface) || visibleNow() !== surface),',
  ],
};

// ---- shipped function builders --------------------------------------------
const markerDecl = AD.match(/const TWITCH_AD_MARKER = [^\n]+/);
const reservedDecl = CONTENT.match(/const NOT_CHANNEL = new Set\(\[[\s\S]*?\]\);/);
if (!markerDecl || !reservedDecl) throw new Error('marker/reserved declarations not found');
const NOT_CHANNEL = new Function(`${reservedDecl[0]}\nreturn NOT_CHANNEL;`)();

function buildPlaylistInfo(src) {
  const body = extractFunction(src, 'playlistInfo');
  const decl = src.match(/const TWITCH_AD_MARKER = [^\n]+/);
  if (!decl) throw new Error('TWITCH_AD_MARKER not found');
  return new Function(`${decl[0]}\n${body}\nreturn playlistInfo;`)();
}

function buildChannelFns(src, getSegment) {
  const slug = extractFunction(src, 'currentSlug');
  const route = extractFunction(src, 'overlayTargetRoute');
  return new Function(
    'NOT_CHANNEL', 'onYtHost', 'location', 'decodeURIComponent', 'URLSearchParams',
    `${slug}\n${route}\nreturn { currentSlug, overlayTargetRoute };`,
  )(
    NOT_CHANNEL, () => false,
    { get pathname() { return `/${encodeURIComponent(getSegment())}`; } },
    decodeURIComponent, URLSearchParams,
  );
}

const SURFACE = 'twitch';
function buildWant(src, getState) {
  const body = extractFunction(src, 'want');
  return new Function(
    'intentOf', 'policy', 'visibleNow', 'clamp',
    `${body}\nreturn want;`,
  )(
    () => ({ muted: !!getState().intent, volume: 1 }),
    { has: (s) => s === SURFACE && !!getState().policy },
    () => (getState().visible ? SURFACE : 'other'),
    (x) => x,
  );
}

// ---- generated domains -----------------------------------------------------
const MARKER_CASES = [
  { text: '', flagged: false },
  { text: '#EXT-X-DATERANGE:ID="ad-break",CLASS="promo"', flagged: false },
  { text: '#EXT-X-DATERANGE:ID="stitched-ad",DURATION=10', flagged: true },
  { text: '#EXT-X-TV-TWITCH-AD-URL:https://ad.example/creative', flagged: true },
  { text: '# plain comment: a twitch-stitched-ad boundary', flagged: true },
];

function renderPlaylist({ marker, n, mode }) {
  const lines = ['#EXTM3U'];
  if (marker.text) lines.push(marker.text);
  let adExtinf = 0;
  for (let i = 0; i < n; i += 1) {
    const live = mode === 'all' || (mode === 'mixed' && i % 2 === 0);
    if (!live) adExtinf += 1;
    lines.push(`#EXTINF:${i + 1}.000,${live ? 'live' : 'seg'}`);
    lines.push(`${i + 1}.ts`);
  }
  return { text: `${lines.join('\n')}\n`, marker, n, mode, adExtinf };
}

const playlistGen = {
  generate(rng) {
    const marker = MARKER_CASES[Math.floor(rng() * MARKER_CASES.length)];
    const n = Math.floor(rng() * 6);
    const mode = ['none', 'all', 'mixed'][Math.floor(rng() * 3)];
    return renderPlaylist({ marker, n, mode });
  },
  shrink(value) {
    // Shorter playlists are smaller witnesses; rebuild text so `n`,
    // `adExtinf` and the bytes stay consistent in the shrunk case.
    const out = [];
    if (value.n > 0) out.push(renderPlaylist({ ...value, n: 0 }));
    if (value.n > 1) out.push(renderPlaylist({ ...value, n: 1 }));
    return out;
  },
};

const CHANNEL_ALPHABETS = ['abz', 'abz09_', 'abz09_-', 'abz09-', 'abz09 ', 'abz09.'];
const RESERVED = [...NOT_CHANNEL];
const channelGen = {
  generate(rng) {
    const reserved = rng() < 0.25;
    if (reserved) return RESERVED[Math.floor(rng() * RESERVED.length)];
    const alphabet = CHANNEL_ALPHABETS[Math.floor(rng() * CHANNEL_ALPHABETS.length)];
    const length = Math.floor(rng() * 30);
    let s = '';
    for (let i = 0; i < length; i += 1) s += alphabet[Math.floor(rng() * alphabet.length)];
    return s;
  },
  shrink(value) {
    if (value.length <= 1) return [];
    return [...new Set([value.slice(0, 1), value.slice(0, Math.floor(value.length / 2)), value.slice(1), value.slice(0, -1)])];
  },
};

const muteGen = {
  generate(rng) {
    return {
      intent: rng() < 0.5,
      policy: rng() < 0.5,
      visible: rng() < 0.5,
    };
  },
  shrink(v) {
    const out = [];
    if (v.intent) out.push({ ...v, intent: false });
    if (v.policy) out.push({ ...v, policy: false });
    if (v.visible) out.push({ ...v, visible: false });
    return out;
  },
};

// ---- predicates over the shipped functions --------------------------------
function playlistPredicate(src) {
  const info = buildPlaylistInfo(src);
  return (c) => {
    const got = info(c.text);
    const expectedAdOnly = c.marker.flagged && c.n > 0 && c.adExtinf === c.n;
    return got.extinf === c.n
      && got.adExtinf === c.adExtinf
      && got.hasStitched === c.marker.flagged
      && got.adOnly === expectedAdOnly
      && got.adExtinfSamples.length === Math.min(3, c.adExtinf);
  };
}

function channelPredicate(src) {
  let segment = '';
  const fns = buildChannelFns(src, () => segment);
  return (s) => {
    segment = s;
    const valid = /^[a-z0-9_]{2,25}$/.test(s) && !NOT_CHANNEL.has(s);
    // currentSlug() returns null on refusal, the slug itself on acceptance;
    // overlayTargetRoute() must agree with that same owning predicate.
    return fns.currentSlug() === (valid ? s : null) && fns.overlayTargetRoute() === valid;
  };
}

function mutePredicate(src) {
  let state = { muted: false, policy: false, visible: false };
  const want = buildWant(src, () => state);
  return (c) => {
    state = c;
    return want(SURFACE).muted === (c.intent || c.policy || !c.visible);
  };
}

async function main() {
  const { fc } = await import('../_tools/property-harness.mjs');
  const checks = [];
  let checksRun = 0;
  let failed = 0;
  const options = { runs: RUNS, seed: SEED };
  const check = (name, fn) => {
    checksRun += 1;
    try {
      fn();
      checks.push(`PASS ${name}`);
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      checks.push(`FAIL ${name}  ${error.message}`);
      console.log(`FAIL ${name}  ${error.message}`);
    }
  };
  const green = (name, predicate, generator) => check(name, () => {
    const r = fc.property(name, generator, predicate, options);
    if (!r.ok) throw new Error(`counterexample at case ${r.cases}: ${JSON.stringify(r.shrunk)}`);
  });
  const red = (name, source, from, to, predicate, generator) => check(`RED ${name}`, () => {
    const mutant = mutate(source, from, to);
    const r = fc.property(`red-${name}`, generator, predicate(mutant), options);
    if (r.ok) throw new Error('the mutation still passed: this arm measures nothing');
    console.log(`EXPECTED-RED ${name} ${r.line}`);
  });

  const playlist = playlistPredicate(AD);
  const channel = channelPredicate(CONTENT);
  const mute = mutePredicate(AUDIO);

  green('playlist-marker-decisive', playlist, playlistGen);
  green('channel-key-exact', channel, channelGen);
  green('mute-truth-table', mute, muteGen);

  red('playlist-marker-decisive', AD, ...MUTATIONS.playlist, playlistPredicate, playlistGen);
  red('channel-key-exact', CONTENT, ...MUTATIONS.channel, channelPredicate, channelGen);
  red('mute-truth-table', AUDIO, ...MUTATIONS.mute, mutePredicate, muteGen);

  // Exhaustive arms: sampling alone cannot prove "for all boolean combinations".
  check('mute-truth-table-exhaustive', () => {
    for (let bits = 0; bits < 8; bits += 1) {
      const c = { intent: !!(bits & 1), policy: !!(bits & 2), visible: !!(bits & 4) };
      if (!mute(c)) throw new Error(`wrong row ${JSON.stringify(c)}`);
    }
  });
  check('channel-key-uppercase-normalises', () => {
    let upper = '';
    const fns = buildChannelFns(CONTENT, () => upper);
    upper = 'AbC';
    if (fns.currentSlug() !== 'abc' || fns.overlayTargetRoute() !== true) {
      throw new Error('uppercase key is not normalised to the stored lowercase form');
    }
  });

  console.log('ARMS 6/6 present');
  console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} property-invariants checks=${checksRun} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.log(`FAIL property-invariants-setup  ${error.message}`);
  console.log('RESULT FAIL property-invariants checks=0 failed=1');
  process.exitCode = 1;
});
