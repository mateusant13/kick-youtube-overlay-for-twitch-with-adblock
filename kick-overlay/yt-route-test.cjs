// YouTube page -> kick channel routing, measured against the REAL content.js.
//
// Owner report 2026-11-07 (console dump): every YouTube watch page logged
//   Unsafe attempt to load URL https://kick.com/api/v2/channels/__uw9vktm-m
//   from frame with URL https://www.youtube.com/watch?v=__Uw9vKtm-M
// twice per video, for ~20 videos. The slug is the lowercase VIDEO ID: the
// page had no stored mapping, so resolveYtPageKick() invented a kick channel
// out of the video id (and out of the UC channel id on the next tier) and the
// probe could never succeed -- kick.com does not answer a cross-origin fetch
// from youtube.com, and no such channel exists anyway.
//
// `node yt-route-test.cjs` (no frameworks). The pre-fix tiers are restored as a
// negative arm; the detector must go RED.
'use strict';
const fs = require('fs');
const path = require('path');

// The checkout is CRLF; mutations below are written LF-only.
const SOURCE = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8').replace(/\r\n/g, '\n');

// Pull a top-level `function name(...) { ... }` out of the real source by
// brace matching, so the test runs the shipped code and not a copy.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const HELPERS = ['ytDirectVideoId', 'resolveYtPageKick'].map((n) => extractFunction(SOURCE, n)).join('\n');
const build = () => new Function(
  'KO', 'ytPageChannelId', 'ytPageHandle', 'ytPageName', 'ytPageVideoId',
  `${HELPERS}\nreturn resolveYtPageKick;`,
);

// Run the shipped resolver against a fake page.
function resolveOn({ cid = null, handle = null, name = null, vid = null, mappings = {} }) {
  const fn = build()({ mappings }, () => cid, () => handle, () => name, () => vid);
  return fn();
}

const SLUG_HELPERS = extractFunction(SOURCE, 'plausibleKickSlug') +
  '\n' + SOURCE.match(/const KICK_SLUG_RE = [^\n]+/)[0];
const plausible = (slug) => new Function(`${SLUG_HELPERS}\nreturn plausibleKickSlug;`)()(slug);

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

// The pre-fix code, restored for the negative arm.
function preFixSource() {
  const anchor = '  return null;\n}\n// Diagnostics stay inside the extension';
  assert(SOURCE.includes(anchor), 'the pre-fix mutation target moved');
  return SOURCE.replace(
    '  // A YouTube VIDEO id and a UC channel id are not kick handles',
    "  if (vid) return { slug: 'host:yt:' + vid.toLowerCase(), m: { kick: vid.toLowerCase() }, via: 'videoId' };\n"
    + "  if (cid) return { slug: 'host:yt:' + cid, m: { kick: cid }, via: 'ytId-fallback' };\n"
    + '  // A YouTube VIDEO id and a UC channel id are not kick handles',
  );
}

function main() {
  // ---- 1. a page with no mapping must not invent a channel ---------------
  check('a watch page with only a videoId resolves to no channel', () => {
    const r = resolveOn({ vid: 'dQw4w9WgXcQ' });
    assert(r === null, `invented ${JSON.stringify(r)} from a video id`);
  });
  check('a page with only a UC channel id resolves to no channel', () => {
    const r = resolveOn({ cid: 'UC1234567890abcdefghijkl' });
    assert(r === null, `invented ${JSON.stringify(r)} from a UC id`);
  });
  // ---- 2. the tiers that CAN be right still work --------------------------
  check('a page handle still resolves by the same-handle doctrine', () => {
    const r = resolveOn({ handle: 'rodil' });
    assert(r && r.via === 'handle' && r.m.kick === 'rodil', `handle tier broke: ${JSON.stringify(r)}`);
  });
  check('a stored mapping still wins over the handle guess', () => {
    const r = resolveOn({ handle: 'rodil', mappings: { rodil: { kick: 'rodil', yt: '@rodil' } } });
    assert(r && r.via === 'yt', `stored mapping ignored: ${JSON.stringify(r)}`);
  });
  // ---- 3. the probe itself refuses an impossible handle -------------------
  check('the kick probe refuses a handle that cannot exist', () => {
    assert(plausible('rodil') === true, 'a real handle was refused');
    assert(plausible('uc1234567890abcdefghijkl') === false, 'a UC id was accepted as a kick channel');
    assert(plausible('') === false, 'an empty slug was accepted');
    assert(plausible('x') === false, 'a one-character slug was accepted');
  });

  // ---- 4. negative arm: the pre-fix tiers must be caught ------------------
  let mutant = null;
  try {
    mutant = preFixSource();
  } catch (error) {
    check('negative arm (guessed channel): the mutation applies', () => {
      throw error;
    });
  }
  if (mutant) {
    const runMutant = ({ cid = null, handle = null, vid = null }) => {
      const helpers = ['ytDirectVideoId', 'resolveYtPageKick'].map((n) => extractFunction(mutant, n)).join('\n');
      const fn = new Function('KO', 'ytPageChannelId', 'ytPageHandle', 'ytPageName', 'ytPageVideoId',
        `${helpers}\nreturn resolveYtPageKick;`)({ mappings: {} }, () => cid, () => handle, () => null, () => vid);
      return fn();
    };
    check('negative arm (guessed channel): the pre-fix resolver is caught inventing a channel', () => {
      const a = runMutant({ vid: 'dQw4w9WgXcQ' });
      const b = runMutant({ cid: 'UC1234567890abcdefghijkl' });
      assert(a && a.via === 'videoId', `the mutant no longer guesses from a video id: ${JSON.stringify(a)}`);
      assert(b && b.via === 'ytId-fallback', `the mutant no longer guesses from a UC id: ${JSON.stringify(b)}`);
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
    console.error(`\nANTI-VACUITY FAIL suite=yt-route checks=${actual} expected=${expected}: an arm stopped running`);
    process.exit(1);
  }
  console.log(`ANTI-VACUITY suite=yt-route checks=${actual} expected=${expected}`);
}
antiVacuity(checks.length, 6);
  console.log(`RESULT ${failed.length ? 'FAIL' : 'PASS'} yt-route checks=${checks.length} failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('\nRESULT FAIL', error && error.message ? error.message : error);
    process.exit(1);
  }
}
