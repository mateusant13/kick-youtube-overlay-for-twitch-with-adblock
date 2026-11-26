// Time-continuity harness for the ad path (owner report 2026-11-07).
//
// Owner, verbatim: "quando troca o player por que ele protege de um ad, a live
// volta varios segundos ... quando acaba o ad e o player volta, aí acontece um
// salto no tempo por causa disso ... eu desmutar rapidamente a live quando
// acontece o ad e troca de player, faz ele mutar o player ... tem vezes que
// estou em outra aba, com uma aba da twitch pausada, por algum motivo é
// despausado sozinho por causa da extensao ... tenta sempre manter o tempo
// super parecido ou em tempo real, quando acontece o anuncio."
//
// Four properties, measured against the REAL twitch-adblock.js:
//   1. REVEAL AT REAL TIME — the clean player is pulled onto the live edge
//      before it covers the native. The old catch-up only ran inside an ACTIVE
//      ad and only above 20s, so a 5-19s delayed picture was revealed as-is and
//      never closed the gap (hls.js plays at 1x).
//   2. HAND-OFF AT THE SAME OFFSET — at ad-end the native is seeked to
//      `edge - target`, the same wall-clock second the clean player showed; a
//      native already there is not touched.
//   3. THE USER'S SOUND DECISION WINS — an unmute made while the pod owns the
//      player reaches the clean player immediately and survives ad-end.
//   4. A PAUSED PLAYER STAYS PAUSED — no resume in a hidden tab, and no resume
//      of a player the user parked before the pod (a cold preroll, which never
//      played at all, is still handed back).
//
// `node ad-time-continuity-test.cjs` (no frameworks). Every property has a
// negative arm that restores the PRE-FIX behaviour; the detector must go RED.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeWorld, makePage, settle, healthySt } = require('./mute-decision-test.cjs');

// The checkout is CRLF; every mutation below is written LF-only, so the source
// is normalised once here and handed to the stub DOM already normalised.
const SOURCE = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8').replace(/\r\n/g, '\n');
const PREWARM_ONLY = process.argv.includes('--prewarm-only');

// ---- pre-fix mutations (the shipped 0.8.43 behaviour) ----------------------
// 0. The ad path had no idea who owned playback: it covered the native (and
//    over the kick layer) on every pod, which is the "player da twitch volta,
//    e segundos depois o outro player volta de novo, segundos atras ... 360p"
//    loop the owner reported on 2026-11-11.
const PRE_FIX_OWNER = [[
  "    if (overlayOwnsPlayback()) {\n      if (overlay.adActive || overlay.standby || overlay.frame) stopAdOverlay('overlay-owns');\n      return;\n    }",
  '',
]];
// 1. catch-up only inside an ACTIVE ad and only above 20s.
const PRE_FIX_CATCHUP = [[
  "        if ((overlay.adActive || overlay.standby) && typeof m.st.lat === 'number') {",
  "        if (overlay.adActive && typeof m.st.lat === 'number' && m.st.lat > 20) {",
]];
// 2. hand-off seeked to the buffered end - 0.5 (a free jump, never aligned).
const PRE_FIX_HANDOFF = [[
  'const target = se > 0 ? Math.max(0, se - cleanLat) : from;',
  'const be = v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;\n      const target = be - 0.5;',
]];
// 6. no sentinel guard: `seekable.end` is trusted as a position. Twitch reports
//    1073741824 (2^30) on a live element whose timeline it does not know, and
//    the hand-back then seeks the native a billion seconds forward (owner
//    adlog 2026-11-08: `native-handoff {se: 1073741824}`).
const PRE_FIX_SENTINEL = [[
  'if (!(isFinite(e) && e > 0 && e < EDGE_MAX_SEC)) return 0;',
  '',
], [
  '        overlay.userDvr = overlay.holdBehind > POD_RECOVER_MIN && overlay.holdCt > POD_RECOVER_MIN;',
  '        overlay.userDvr = false;',
]];
// 3. no continuous intent tracking: the frame is told a frozen "muted" instead
//    of the authority's state, so an unmute never reaches the clean player.
const PRE_FIX_INTENT = [[
  '    const a = audioState();\n    const muted = !!(a.muted || overlay.audioRefused);',
  '    const a = { volume: 1 };\n    const muted = true;',
]];
// 4. resume any paused native, in any visibility.
const PRE_FIX_RESUME = [[
  '    if (document.visibilityState && document.visibilityState !== \'visible\') return true;\n    // A user pause during the pod and a player parked before it are the same\n    // refusal with one exit, so the census budget does not pay twice.\n    if (userPausedInPod || (overlay.pauseBeforeAd && !overlay.coldPreroll)) return true;\n',
  '',
]];

// 5. no cover deadline: the pre-fix timer was declared but the branch was never
//    announced, and a bound equal to the contract cannot resolve inside it.
// 6. no ready gate: commands are posted into a frame whose navigation has not
//    committed, where the browser rejects them against the page's origin and
//    the command is lost (measured as `Failed to execute 'postMessage' ...`).
const PRE_FIX_POST_EARLY = [[
  'if (!overlay.frameReady) {\n      if (!overlay.queue) overlay.queue = [];',
  'if (false) {\n      if (!overlay.queue) overlay.queue = [];',
]];

const PRE_FIX_COVER = [[
  "            adLog('cold-cover-timeout', { ms: Date.now() - (overlay.coldCoverAt || Date.now()) });\n            stopAdOverlay('cold-cover-timeout');",
  "            void 0;",
]];

// 7. the stall guard rewound the clean player 2s per nudge (owner adlog
//    2026-11-08: 14 `overlay-nudge` events, each one a visible rewind).
const PRE_FIX_NUDGE = [[
  "    const hold = Number(st.buffered);\n    const ahead = isFinite(hold) && hold > 0.5 ? hold - 0.3 : 0;\n    overlaySend({ t: 'seek', s: Math.max(0, pos + ahead) });\n    overlaySend({ t: 'play' });\n    adLog('overlay-nudge', { kind: String(kind || ''), pos: +pos.toFixed(2), to: +(pos + ahead).toFixed(2), hold: isFinite(hold) ? +hold.toFixed(2) : null, tries: overlay.nudgeTries });",
  "    overlaySend({ t: 'seek', s: Math.max(0, pos - 2) });\n    overlaySend({ t: 'play' });\n    adLog('overlay-nudge', { kind: String(kind || ''), pos: +pos.toFixed(2), to: +(pos - 2).toFixed(2), tries: overlay.nudgeTries });",
]];

// 8. the 4s reveal floor with no liveness exception: unreachable behind a 3s
//    live sync, so a decoding player was judged unhealthy on every tick.
const PRE_FIX_HEALTH = [
  ['const decoding = advancing !== false && forwardOk;', 'const decoding = advancing !== false && forwardOk && buffered >= 4;'],
  ['const alive = overlay.playing && rsOk', 'const alive = false && rsOk'],
];

// 9. the reveal re-sent the mute on every heartbeat instead of on transition.
const PRE_FIX_MUTE_SPAM = [[
  '    if (last && last.muted === muted && Math.abs(last.volume - volume) < 0.02) return;',
  '    if (false) return;',
]];

// 10. a standby left PAUSED by a previous pod was read as a ready cover: the
//     tick returned at "the pod owns it" on every tick, no hold was raised, and
//     the new ad played for its whole length (owner ring 2026-11-20: 62.6 s).
const PRE_FIX_STANDBY_STALE = [[
  '    if (standbyStale()) {',
  '    if (false && standbyStale()) {',
], [
  // The refusal used to treat a mere warm standby/frame as a cover; the fix
  // narrowed it to a real ad or a revealed picture. Reverting BOTH lines is the
  // pre-fix state the arm must catch: no teardown AND standby read as a cover.
  '    if (overlay.adActive || overlay.revealed) {',
  '    if (overlay.adActive || overlay.standby || overlay.frame) {',
], [
  // AND THE PRE-FIX BRANCH DID NOT FREEZE THE PAGE EITHER (0.8.112). Without
  // this pair the mutant carries today's `freezeNativeForPod()` inside the
  // restored guard, pauses the element it was supposed to leave playing, and
  // the negative arm measures nothing (it reported `paused=true staleRows=0`).
  '      const pv = freezeNativeForPod();\n',
  '      const pv = null;\n',
]];

const checks = [];
const armLog = []; // GREEN arm labels actually printed in this run
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

// Runs the SAME arm against a source whose fix line was restored to the
// pre-fix behaviour. The arm MUST fail there; the failure is printed as a RED
// line (and not counted as a suite failure) so one run shows red -> green.
async function redArm(label, source, fn) {
  let error = null;
  try {
    await fn(source);
  } catch (e) {
    error = e;
  }
  if (!error) {
    checks.push({ name: `RED ${label} did not fail`, status: 'FAIL', detail: 'the mutation did not break the arm' });
    console.log(`FAIL RED ${label}  the mutation did not break the arm`);
    return;
  }
  console.log(`FAIL RED ${label}  ${error.message}`);
}

async function greenArm(label, fn) {
  try {
    await fn();
    checks.push({ name: label, status: 'PASS' });
    armLog.push(label);
    console.log(`PASS ${label}`);
  } catch (error) {
    checks.push({ name: label, status: 'FAIL', detail: error.message });
    console.log(`FAIL ${label}  ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
// An arm can report every property in the GREEN run (each one counted as a
// check) and still throw on the RED copy of the same source: `record` is the
// assertion there, and `check` only in the green run.
function strictRecord(name, cond, msg) {
  assert(cond, msg);
}
function checkRecord(name, cond, msg) {
  check(name, () => assert(cond, msg));
}
function mutate(pairs) {
  let src = SOURCE;
  for (const [from, to] of pairs) {
    if (!src.includes(from)) throw new Error(`mutation target not found: ${from.slice(0, 60)}`);
    src = src.split(from).join(to);
  }
  return src;
}

// Native player at a controllable position. `edge` is the live edge, so
// `edge - ct` is the native's own latency.
function setNative(page, { ct, edge, bufferedEnd, bufferedStart, paused = false, muted = false, rs = 4 }) {
  const v = page.video;
  v.currentTime = ct;
  v.paused = paused;
  // `rs` is a parameter because a hand-back onto an element below
  // HAVE_FUTURE_DATA is a freeze with a delay on it (the 0.8.122 wait's whole
  // reason), and an arm that cannot set it measures nothing.
  v.readyState = rs;
  // The mute must arrive as a USER gesture: ko-audio.js records intent from a
  // volumechange it did not write, and setting `.muted` behind its back leaves
  // the intent untouched (the whole point of the new model).
  page.userSetsNative(!!muted, 1);
  v.volume = 1;
  v.plays = 0;
  v.seekable = { length: 1, start: () => Math.max(0, edge - 3600), end: () => edge };
  const bStart = bufferedStart == null ? Math.max(0, edge - 3600) : bufferedStart;
  v.buffered = { length: 1, start: () => bStart, end: () => bufferedEnd };
  return v;
}

// Warm standby: minted hidden, healthy, at `lat` seconds behind the edge.
async function warmStandby(page, { pos, lat, buffered } = {}) {
  const st = buffered == null ? { pos, lat } : { pos, lat, buffered };
  page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
  await settle(20);
  page.frameMsg({ t: 'ready' });
  page.frameMsg(healthySt(st));
  page.frameMsg(healthySt(st));
  page.frameMsg(healthySt(st));
  await settle(10);
}

// A full pod: ad-hold -> ad-start -> healthy Playing ticks -> reveal.
async function pod(page, { pos = 100, lat = 3, lv, bw } = {}) {
  // lv/bw travel with the samples that PRODUCE the reveal. An arm that sends
  // them after the reveal exists reads the pre-reveal report, and the row it
  // measures was written before the fields arrived (measured: lv null).
  const extra = {};
  if (lv != null) extra.lv = lv;
  if (bw != null) extra.bw = bw;
  page.bypass({ type: 'ad-hold' });
  page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
  await settle(20);
  page.frameMsg({ t: 'ready' });
  page.frameMsg(healthySt({ pos, lat, ...extra }));
  page.frameMsg(healthySt({ pos, lat, ...extra }));
  page.frameMsg(healthySt({ pos, lat, ...extra }));
  await settle(10);
}

// ---- 23. ONE PAGE-LOAD WARM, CONSUMED ONCE BY THE FIRST POD --------------
// A cold hold used to force a fresh GQL mint even when the worker had already
// resolved a clean URL (3-4 s of preroll before the picture). These arms drive
// the page-side cache through the real bypass channel: the worker is a peer,
// so it only answers a request the page actually posted.
async function prewarmArms() {
  const WARM_URL = 'https://clean.example/prewarm.m3u8';
  const FALLBACK_URL = 'https://clean.example/fallback.m3u8';
  function warmFrame(page) {
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i += 1) page.frameMsg(healthySt({ pos: 14.6, lat: 1.4, buffered: 8 }));
  }

  async function consumedPrewarmArm(src, record = strictRecord) {
    const page = makePage(src);
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    await settle(260); // the 150 ms kick and the 200 ms cold retry have fired
    const kick = page.logsOf('standby-request').filter((l) => l.d.why === 'prewarm');
    record('the page load kicks exactly one clean-source warm', kick.length === 1,
      `no single page-load warm was posted: ${JSON.stringify(page.logsOf('standby-request'))}`);
    page.bypass({ type: 'standby-start', url: WARM_URL, channel: 'rodil' });
    await settle(20);
    const warm = page.logsOf('standby-prewarm');
    record('the warm resolve is one transition row with its ms',
      warm.length === 1 && warm[0].d.ok === true && Number.isFinite(warm[0].d.ms),
      `the resolve was silent or unnamed: ${JSON.stringify(warm)}`);
    warmFrame(page);
    await settle(15);
    const api = page.stats();
    const key = api.standbyPrewarm();
    record('the warm is cached with the standby key and lifetime clock',
      key.channel === 'rodil' && key.url === WARM_URL && key.at > 0 && key.pending === false,
      `the warmed URL was not cached: ${JSON.stringify(key)}`);
    api.adUiHold({ kind: 'wrapper', w: 1280, h: 720 }); // the first pod asks
    await settle(15);
    const used = page.logsOf('standby-prewarm-used');
    record('the first pod consumes the warm source once',
      used.length === 1 && Number.isFinite(used[0].d.ageMs) && used[0].d.ageMs >= 0,
      `no single-use consumption row: ${JSON.stringify(used)}`);
    record('the consumed key is single-use', api.standbyPrewarm().url === null,
      `the key survived its pod: ${JSON.stringify(api.standbyPrewarm())}`);
    record('the pod does not repeat its forced mint',
      page.logsOf('standby-request').filter((l) => l.d.why === 'ad-ui-hold').length === 0,
      `the pod minted again: ${JSON.stringify(page.logsOf('standby-request'))}`);
    page.bypass({ type: 'ad-hold' });
    await settle(25);
    record('the warm source still covers the pod', page.logsOf('overlay-reveal').length === 1,
      `the consumed source did not reveal: ${JSON.stringify(page.logsOf('overlay-reveal'))}`);
  }
  const RED_CONSUME = mutate([[
    '      if (consumeStandbyPrewarm()) return;',
    '      if (false && consumeStandbyPrewarm()) return;',
  ]]);
  await redArm('RED: a pre-warmed source is re-minted inside the hold', RED_CONSUME, (src) => consumedPrewarmArm(src));
  await greenArm('a pre-warmed source is consumed by the first pod without a second mint', () => consumedPrewarmArm(SOURCE, checkRecord));

  // The measured 5 ms race (KO-20261126-06): the pod's forced ask lands while
  // the page-load warm is still in flight, so `consumeStandbyPrewarm()` sees an
  // empty slot, mints a second clean source and throws the warm away.
  async function parkedPrewarmArm(src, record = strictRecord) {
    const page = makePage(src);
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    await settle(160); // the 150 ms warm is in flight and has not resolved
    const pre = page.stats().standbyPrewarm();
    record('a page-load warm is in flight when the pod asks',
      pre.pending === true && !pre.url,
      `the warm was not pending at the ask: ${JSON.stringify(pre)}`);
    page.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(15);
    const wait = page.logsOf('standby-prewarm-wait');
    const podsAsk = page.logsOf('standby-request').filter((l) => l.d.why === 'ad-ui-hold');
    record('a forced ask parks on the in-flight warm instead of minting a second source',
      wait.length === 1 && wait[0].d.ask === 'ad-ui-hold' && podsAsk.length === 0,
      `the parked ask was silent or the pod minted anyway: ${JSON.stringify({
        wait, asks: page.logsOf('standby-request'),
      })}`);
    page.bypass({ type: 'standby-start', url: WARM_URL, channel: 'rodil' });
    await settle(20);
    const served = page.logsOf('standby-prewarm-served');
    const used = page.logsOf('standby-prewarm-used');
    record('the resolve serves the parked ask in the same task it caches the source',
      served.length === 1 && used.length === 1 && page.stats().standbyPrewarmWaiters().length === 0,
      `the parked ask outlived its source: ${JSON.stringify({
        served, used, parked: page.stats().standbyPrewarmWaiters(),
      })}`);
    page.bypass({ type: 'ad-hold' });
    warmFrame(page);
    await settle(25);
    record('the served source reveals the pod that parked',
      page.logsOf('overlay-reveal').length === 1,
      `the parked pod never revealed: ${JSON.stringify(page.logsOf('overlay-reveal'))}`);
  }
  const RED_PARKED = mutate([[
    "      if (standbyPrewarm.pending && warmAge <= STANDBY_PREWARM_PARK_MS) {\n        const ask = String(why || 'unspecified');",
    "      if (false) {\n        const ask = String(why || 'unspecified');",
  ]]);
  await redArm('RED: a forced ask beside an in-flight warm mints a second source', RED_PARKED, (src) => parkedPrewarmArm(src));
  await greenArm('a forced ask beside an in-flight warm parks and is served by the resolve', () => parkedPrewarmArm(SOURCE, checkRecord));

  // The park has a ceiling: a warm that has been in flight longer than a mint
  // would take is a failure in progress, and a pod must not wait seconds of ad
  // for an optimisation. The pod mints its own source, exactly as before.
  async function staleWarmArm(src, record = strictRecord) {
    const page = makePage(src);
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    await settle(160);
    page.stats().ageStandbyPrewarmKick(3000); // in flight, but far past a mint
    page.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(15);
    const wait = page.logsOf('standby-prewarm-wait');
    const podsAsk = page.logsOf('standby-request').filter((l) => l.d.why === 'ad-ui-hold');
    record('a warm older than a mint never parks the pod: it mints its own source',
      wait.length === 0 && podsAsk.length === 1 && page.stats().standbyPrewarmWaiters().length === 0,
      `a stuck warm held the pod's only ask: ${JSON.stringify({
        wait, asks: page.logsOf('standby-request'), parked: page.stats().standbyPrewarmWaiters(),
      })}`);
  }
  const RED_STALE_WARM = mutate([[
    '      if (standbyPrewarm.pending && warmAge <= STANDBY_PREWARM_PARK_MS) {',
    '      if (standbyPrewarm.pending) {',
  ]]);
  await redArm('RED: without the ceiling a warm stuck in flight parks a pod for its whole budget', RED_STALE_WARM, (src) => staleWarmArm(src));
  await greenArm('a warm stuck in flight past a mint does not park the pod', () => staleWarmArm(SOURCE, checkRecord));

  // The warm's own budget is the only clock: when it expires, the parked ask
  // must be re-issued through the ordinary door instead of dying with the warm.
  async function parkedTimeoutArm(src, record = strictRecord) {
    const page = makePage(src);
    page.stats().setPrewarmWaitMs(60);
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    await settle(160);
    page.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(10);
    const wait = page.logsOf('standby-prewarm-wait');
    record('the parked ask is a row before its warm expires',
      wait.length === 1 && wait[0].d.ask === 'ad-ui-hold',
      `the parked ask was silent: ${JSON.stringify(page.logsOf('standby-prewarm-wait'))}`);
    await settle(120); // the 60 ms budget started with the 150 ms kick
    const flush = page.logsOf('standby-prewarm-timeout-flush');
    const podsAsk = page.logsOf('standby-request').filter((l) => l.d.why === 'ad-ui-hold');
    record('a warm that times out re-issues the parked ask through the ordinary door',
      flush.length === 1 && flush[0].d.asks[0] === 'ad-ui-hold' && podsAsk.length === 1,
      `the parked ask died with its warm: ${JSON.stringify({
        flush, asks: page.logsOf('standby-request'), parked: page.stats().standbyPrewarmWaiters(),
      })}`);
  }
  const RED_PARKED_TIMEOUT = mutate([[
    "        const asks = standbyPrewarmWaiters.splice(0);\n        if (asks.length) {",
    "        const asks = standbyPrewarmWaiters.splice(0);\n        if (false) {",
  ]]);
  await redArm('RED: without the flush a timed-out warm drops the ask that parked on it', RED_PARKED_TIMEOUT, (src) => parkedTimeoutArm(src));
  await greenArm('a timed-out warm flushes its parked ask instead of dropping it', () => parkedTimeoutArm(SOURCE, checkRecord));

  async function fallbackPrewarmArm(src, record = strictRecord) {
    const page = makePage(src);
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    await settle(260);
    // A peer's answer for another channel is a FAILED warm: it must not be
    // cached and the pod must still ask for its own source.
    page.bypass({ type: 'standby-start', url: WARM_URL, channel: 'other' });
    await settle(15);
    const failed = page.logsOf('standby-prewarm');
    record('a failed warm is logged, never silent',
      failed.length === 1 && failed[0].d.ok === false && failed[0].d.why === 'channel-changed',
      `the failure had no row: ${JSON.stringify(failed)}`);
    page.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(15);
    const asked = page.logsOf('standby-request').filter((l) => l.d.why === 'ad-ui-hold');
    record('a failed warm falls back to the pod mint', asked.length === 1,
      `the pod did not ask for a source: ${JSON.stringify(page.logsOf('standby-request'))}`);
    if (asked.length) page.bypass({ type: 'standby-start', url: FALLBACK_URL, channel: 'rodil' });
    await settle(15);
    page.bypass({ type: 'ad-hold' });
    warmFrame(page);
    await settle(25);
    record('the pod still reveals without a warm source', page.logsOf('overlay-reveal').length === 1,
      `the fallback did not reveal: ${JSON.stringify(page.logsOf('overlay-reveal'))}`);

    // Expiry is the same optimisation: the key is discarded with a row and
    // the forced ask still runs, without waiting 90 s of wall clock.
    const stale = makePage(src);
    setNative(stale, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    await settle(260);
    stale.bypass({ type: 'standby-start', url: WARM_URL, channel: 'rodil' });
    await settle(15);
    stale.stats().ageStandbyPrewarm(91000);
    stale.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(15);
    const expired = stale.logsOf('standby-prewarm').filter((l) => l.d.why === 'expired');
    const busy = stale.logsOf('standby-refused').filter((l) => l.d.why === 'busy');
    stale.bypass({ type: 'ad-hold' });
    warmFrame(stale);
    await settle(25);
    record('an expired warm is named, never consumed, and the pod still reveals',
      expired.length === 1 && expired[0].d.ok === false && busy.length === 1
        && stale.logsOf('standby-prewarm-used').length === 0 && stale.logsOf('overlay-reveal').length === 1,
      `expiry blocked or silenced the fallback: ${JSON.stringify({
        rows: stale.logsOf('standby-prewarm'), refused: stale.logsOf('standby-refused'), reveal: stale.logsOf('overlay-reveal'),
      })}`);
  }
  const RED_FALLBACK = mutate([[
    "    requestStandby(0, true, 'ad-ui-hold');",
    '    void 0; // RED: the fallback mint was removed',
  ]]);
  await redArm('RED: without the fallback mint the pod never reveals', RED_FALLBACK, (src) => fallbackPrewarmArm(src));
  await greenArm('a failed pre-warm is not a precondition: the hold falls back to a mint and reveals', () => fallbackPrewarmArm(SOURCE, checkRecord));
}

async function main() {
  if (PREWARM_ONLY) {
    await prewarmArms();
    const onlyFailed = checks.filter((c) => c.status === 'FAIL');
    console.log(`RESULT ${onlyFailed.length ? 'FAIL' : 'PASS'} ad-time-continuity prewarm-only checks=${checks.length} failed=${onlyFailed.length}`);
    process.exit(onlyFailed.length ? 1 : 0);
  }
  // ---- 1. a hidden standby is pulled onto the live edge -------------------
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 }); // nativeLat = 3
    await warmStandby(page, { pos: 100, lat: 12 });
    page.frameMsg(healthySt({ pos: 100, lat: 12 }));
    await settle(10);
    check('a standby 12s behind live is pulled forward, never past the data it holds', () => {
      const seeks = page.seeks();
      assert(seeks.length >= 1, `no seek sent: ${JSON.stringify(page.sent)}`);
      // lat 12 at pos 100 with 8s buffered: edge-3 is 109, i.e. 5s BEYOND the
      // buffer. Seeking there is a download the player cannot finish, and the
      // measured result was a starvation teardown (ko.adlog 2026-11-08), so the
      // ceiling is the newest frame the element already holds.
      assert(seeks[0] > 100, `seek ${seeks[0]} does not move the picture forward`);
      assert(seeks[0] <= 100 + 8 - 1 + 0.001, `seek ${seeks[0]} left the buffered range (ceiling 107)`);
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    page.frameMsg(healthySt({ pos: 100, lat: 12, buffered: 30 }));
    await settle(10);
    check('a standby with the buffer to reach the edge is seeked all the way to edge-3', () => {
      const seeks = page.seeks();
      assert(seeks.length >= 1, `no seek sent: ${JSON.stringify(page.sent)}`);
      assert(Math.abs(seeks[0] - (100 + 12 - 3)) < 0.6, `seek target ${seeks[0]} != edge-3 (109)`);
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await warmStandby(page, { pos: 200, lat: 6 });
    page.bypass({ type: 'ad-hold' }); // a warm playing standby is revealed here
    await settle(20);
    check('a 6s-behind standby is re-aligned before it covers the native', () => {
      // Owner report 2026-11-15: "ao trocar pro outro player, não sei se tá em
      // tempo real". His own 0.8.92 ring shows why: `overlay-reveal
      // {clean:{lat:6.3,hold:4.34}}` — the seek was sent on the same tick the
      // frame was raised, so the first picture he saw was still 6.3 s behind.
      // The seek is asked for, and the reveal WAITS for the frame to report the
      // new position (bounded) instead of racing it.
      const seeks = page.seeks();
      assert(seeks.length >= 1, `no catch-up seek: ${JSON.stringify(page.sent)}`);
      assert(Math.abs(seeks[0] - (200 + 6 - 3)) < 0.6, `seek target ${seeks[0]} != edge-3 (203)`);
      assert(page.frame.style.opacity !== '1',
        'the frame was raised on the same tick as the seek: the picture shown is the old position');
    });
    // One report that carries the caught-up position IS the landing.
    page.frameMsg(healthySt({ pos: 203, lat: 3, buffered: 30 }));
    await settle(20);
    check('the reveal lands on the report that shows the position the seek aimed at', () => {
      assert(page.frame.style.opacity === '1', `still hidden after the caught-up report: ${JSON.stringify(page.sent)}`);
      assert(page.seeks().length === 1, `re-seeked a frame that had already moved: ${JSON.stringify(page.seeks())}`);
    });
  }
  // A frame that never reports again must not leave the user without a picture.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await warmStandby(page, { pos: 200, lat: 6 });
    page.bypass({ type: 'ad-hold' });
    await settle(20);
    check('a silent frame is revealed at the bound, and the delay is stated', () => {
      assert(page.frame.style.opacity !== '1', 'the reveal did not wait at all');
    });
    await new Promise((r) => setTimeout(r, 1750));
    check('...and the bound fires: reveal-behind is logged with the measured delay', () => {
      assert(page.frame.style.opacity === '1', 'the bound never revealed: the pod has no picture at all');
      const rec = page.logsOf('reveal-behind').pop();
      assert(!!rec, `no reveal-behind row: ${JSON.stringify(page.sent)}`);
      assert(typeof rec.d.lat === 'number' && rec.d.lat > 0, `lat missing: ${JSON.stringify(rec.d)}`);
    });
  }

  // ---- 1b. Twitch's sentinel edge: the wall clock is the only timeline -----
  // Owner report 2026-11-11: "deixou a live com delay multiplas vezes por causa
  // do anuncio e da troca de player". Twitch's native reports `seekable.end`
  // as the 2^30 sentinel, so the hand-back fell back to `buffered.end - 0.5`
  // and a native that sat frozen through the pod resumed at its old position:
  // every pod added its own duration to the delay and nothing ever closed it.
  {
    const page = makeWorld();
    // A POD-SIZED deficit on purpose: the 2026-11-12 rule refuses a forward seek
    // past the downloaded data for a couple of seconds (measured: landing 0.5 s
    // before `buffered.end` parks the element at rs:1), and only pays that price
    // for the delay a whole pod costs. `POD_RECOVER_MIN` is 10 s.
    setNative(page, { ct: 100, edge: 1073741824, bufferedEnd: 101 });
    await pod(page);
    // the native is frozen for the pod: real time passes, currentTime does not
    await new Promise((r) => setTimeout(r, 12200));
    page.bypass({ type: 'ad-end' });
    await settle(30);
    // THE CONTRACT THIS ARM NOW HOLDS IS THE OPPOSITE OF WHAT IT HELD BEFORE, and
    // the owner's own 2026-11-16 report is why: "ao voltar pro player da twitch,
    // ele TRAVA inves de voltar pro tempo real ... e pra destravar eu q tenho q
    // clicar em pause despause". A wall-clock target that sits PAST the newest
    // downloaded frame is a seek into nothing: the browser clamps it, the
    // element parks at rs:1, and the picture stays frozen until he clicks. With
    // 1 s of runway (his log's `buf 101` over `ct 100` shape) there is no
    // forward landing inside the data the element holds, so doing nothing IS the
    // recovery - Twitch refills from its own live edge. The skip says both
    // numbers instead of silently parking the element.
    check('a recovery target past the downloaded data is skipped, and the skip carries both numbers', () => {
      const v = page.video;
      const rec = page.logsOf('native-edge-recover');
      assert(rec.length === 0, `the hand-back seeked into undownloaded media: ${JSON.stringify(rec[0] && rec[0].d)}`);
      const skip = page.logsOf('native-seek-skipped');
      assert(skip.length === 1, `expected one native-seek-skipped, got ${skip.length}`);
      assert(Math.abs(skip[0].d.from - 100) < 0.2, `from ${skip[0].d.from} is not the frozen position`);
      assert(skip[0].d.to > 105, `to ${skip[0].d.to} did not record the wall-clock target`);
      assert(Math.abs(skip[0].d.buffered - 101) < 0.2, `buffered ${skip[0].d.buffered} is not the element's own end`);
      assert(Math.abs(v.currentTime - 100) < 0.2, `currentTime ${v.currentTime} moved on a refused seek`);
    });
  }
  {
    // RED: the pre-fix hand-back, with the wall-clock recovery removed.
    // RED: the runway clamp removed -> the hand-back seeks 9 s into media the
    // element does not hold, which is the freeze the arm above refuses.
    const mutated = mutate([[
      "        if (covered && se <= 0 && runwayEnd > 0 && want > runwayEnd - HEALTH_BUFFER_SEC) {",
      "        if (false && covered && se <= 0 && runwayEnd > 0 && want > runwayEnd - HEALTH_BUFFER_SEC) {",
    ]]);
    const page = makeWorld(mutated);
    setNative(page, { ct: 100, edge: 1073741824, bufferedEnd: 101 });
    await pod(page);
    await new Promise((r) => setTimeout(r, 12200));
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('RED: without the runway clamp the hand-back seeks past the downloaded data', () => {
      assert(page.video.currentTime > 106,
        `the mutant left the element at ${page.video.currentTime}, so the arm above measures nothing`);
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 }); // a REAL edge
    await pod(page);
    await new Promise((r) => setTimeout(r, 2100));
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('a usable edge suppresses the wall-clock recovery (no double seek)', () => {
      assert(page.logsOf('native-edge-recover').length === 0, 'the recovery seek ran on a usable edge');
    });
  }

  // ---- 2. ad-end hands the native back at the SAME offset -----------------
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 }); // already at edge-3
    await pod(page);
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('ad-end on a native already at the target offset does not seek', () => {
      assert(page.logsOf('native-catchup').length === 0, 'the hand-back seeked a native that was already in place');
      assert(page.video.currentTime === 397, `currentTime became ${page.video.currentTime}`);
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page);
    // Twitch parked the covered element while the clean player was on screen.
    page.video.currentTime = 100;
    page.video.paused = true;
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('a native parked behind by the pod is handed back at edge-3', () => {
      const v = page.video;
      assert(v.currentTime > 396 && v.currentTime < 398, `currentTime ${v.currentTime} != 397 (edge 400 - 3)`);
      const logs = page.logsOf('native-catchup');
      assert(logs.length === 1, `expected one hand-back seek, got ${logs.length}`);
      assert(logs[0].d.gap > 290, `logged gap ${logs[0].d.gap} does not show the pod-length catch-up`);
    });
  }

  // ---- 2b. Twitch's live sentinel is not a position ----------------------
  {
    const page = makeWorld();
    // The owner's own adlog: `native-handoff {se: 1073741824}` on buzzyi_.
    setNative(page, { ct: 30, edge: 40, bufferedEnd: 40 });
    page.video.seekable = { length: 1, start: () => 0, end: () => 1073741824 };
    page.video.duration = Infinity;
    await pod(page);
    page.video.currentTime = 30;
    page.video.paused = false;
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('a 2^30 seekable end is not used as the live edge', () => {
      const v = page.video;
      assert(v.currentTime < 1000, `the hand-back seeked the native to ${v.currentTime}`);
      assert(page.logsOf('native-edge-unusable').length === 1, 'the sentinel was not reported in the adlog');
    });
  }
  {
    const page = makeWorld();
    // The same element, but the pod left it far behind a big downloaded window.
    // `buffered.end` is the newest frame DOWNLOADED, not the live edge: on his
    // own log the buffer sits 8-300 s ahead of the playhead (`buf 305.1 ct
    // 302.4`). Landing there is a forward jump over content nobody watched.
    setNative(page, { ct: 100, edge: 40, bufferedEnd: 400 });
    page.video.seekable = { length: 1, start: () => 0, end: () => 1073741824 };
    page.video.duration = Infinity;
    await pod(page);
    page.video.currentTime = 100;
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('with no usable edge the hand-back never jumps into the downloaded window', () => {
      const v = page.video;
      assert(v.currentTime === 100, `the hand-back moved the picture to ${v.currentTime} with no edge to aim at`);
      assert(page.logsOf('native-catchup').length === 0, `a catch-up ran on a sentinel edge: ${page.logsOf('native-catchup').length}`);
    });
  }
  {
    // RED: the pre-fix `buffered.end - 0.5` target, which lands ~300 s ahead of
    // the frame he was watching (the reported skip).
    const page = makeWorld({
      adSource: mutate([['      const target = se > 0 ? Math.max(0, se - cleanLat) : from;',
        '      const target = se > 0 ? Math.max(0, se - cleanLat) : Math.max(0, nativeBufferedEnd(v) - 0.5);']]),
    });
    setNative(page, { ct: 100, edge: 40, bufferedEnd: 400 });
    page.video.seekable = { length: 1, start: () => 0, end: () => 1073741824 };
    page.video.duration = Infinity;
    await pod(page);
    page.video.currentTime = 100;
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('RED: a buffered-end landing jumps the picture past everything he watched', () => {
      assert(page.video.currentTime > 300,
        `the mutant did not jump (currentTime ${page.video.currentTime}), so the arm above measures nothing`);
    });
  }

  // ---- 2c. A HAND-BACK ONTO AN ELEMENT THAT CANNOT PLAY FORWARD WAITS -----
  // Measured in the replica 2026-11-26 (dev-preroll-hold 1795677985765, 0.8.121):
  // `ad-ui-release {act:'pod-end'}` at 14743 ms, `native-handoff {ct:0, se:16}`
  // at 14747, `native-resume {rs:1}` x4 (15049, 15949, 17248, 18748) and the
  // first `display-clock` LIVE at ~19 s. The clean frame was torn down while it
  // was decoding (`cleanLat:6`) and the user watched a frozen native for ~4 s.
  //
  // A REVEALED live frame ADVANCES. `cleanFrameCanCover()` refuses a playhead
  // that repeats its position across samples more than 2 s apart, so an arm that
  // sends one sample and then waits measures that guard instead of the wait -
  // the first version of these arms did exactly that (`covered:false` at 303 ms).
  async function liveFrame(page, n, startPos = 100) {
    for (let i = 0; i < n; i += 1) {
      // 1x, not 3x: `cleanFrameAdvancing` refuses moved > expected*2 + 0.2,
      // and a pump faster than real time silently marks the frame not-playing.
      page.frameMsg(healthySt({ pos: startPos + i * 0.28, lat: 3 }));
      await settle(300);
    }
  }
  await greenArm('a hand-back onto a native without HAVE_FUTURE_DATA keeps the picture on screen', async () => {
    const page = makeWorld();
    setNative(page, { ct: 30, edge: 40, bufferedEnd: 40, rs: 1 });
    await pod(page);
    await liveFrame(page, 2);
    page.bypass({ type: 'ad-end' });
    await settle(60);
    const wait = page.logsOf('handback-wait').pop();
    assert(wait, 'the hand-back did not wait on an element at rs=1');
    assert(wait.d.rs === 1, `rs ${JSON.stringify(wait.d.rs)}`);
    assert(wait.d.capMs > 0, `no ceiling in the row: ${JSON.stringify(wait.d)}`);
    assert(page.logsOf('native-resume').filter((l) => l.d.tag === 'ad-end').length === 0,
      'the native was resumed while it could not play forward');
    assert(page.logsOf('overlay-reveal').length > 0, 'the clean picture was never revealed, so there is nothing to wait on');
    assert(page.stats().frameMounted() === true,
      'the wait armed with the frame already torn down: the user sees the frozen element it was meant to hide');
    assert(page.stats().handbackWait() !== null, 'the wait is not live, so the timer would never finish');
    page.video.readyState = 4;
    await settle(400);
    const ready = page.logsOf('handback-ready').pop();
    assert(ready, 'no handback-ready row');
    assert(ready.d.capped === false && ready.d.rs >= 3, `ready ${JSON.stringify(ready.d)}`);
    assert(page.logsOf('native-resume').some((l) => l.d.tag === 'ad-end'), 'the native was never handed back');
  });
  // The ceiling: a native that never recovers still gets the hand-back it would
  // have had, because a frame held forever is a worse defect than a frozen
  // element the user can pause/unpause.
  await greenArm('a native that never recovers is handed back at the ceiling, not held forever', async () => {
    const page = makeWorld();
    setNative(page, { ct: 30, edge: 40, bufferedEnd: 40, rs: 1 });
    await pod(page);
    page.bypass({ type: 'ad-end' });
    await liveFrame(page, 11, 100); // 3.3 s of a healthy, advancing clean picture
    const ready = page.logsOf('handback-ready').pop();
    assert(ready, 'no handback-ready row after the ceiling');
    assert(ready.d.capped === true, `capped=${JSON.stringify(ready.d)}`);
    const tags = page.logsOf('native-resume').map((l) => l.d.tag + ':' + l.d.rs);
    const tail = page.logs().slice(-14).map((l) => l.ev);
    assert(page.logsOf('native-resume').some((l) => l.d.tag === 'ad-end'),
      `the capped wait never handed back (resumes=${JSON.stringify(tags)} paused=${page.video.paused} revealed=${page.stats().revealed()} active=${page.stats().adActive()} tail=${JSON.stringify(tail)})`);
  });
  // RED: the wait removed -> a frozen element is put on screen immediately.
  const RED_NO_WAIT = mutate([[
    '      if (wv && wrs < 3 && !resumeRefusedByUser(wv)) {',
    '      if (false) {',
  ]]);
  await redArm('RED: without the wait a frozen native is revealed at pod end', RED_NO_WAIT, async (src) => {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 30, edge: 40, bufferedEnd: 40, rs: 1 });
    await pod(page);
    await liveFrame(page, 2);
    page.bypass({ type: 'ad-end' });
    await settle(60);
    // The arm asserts the CONTRACT, so the mutant breaks it: with the wait
    // removed the pod end reveals a frozen element (`native-resume {rs:1}`) and
    // no `handback-wait` row exists. Asserting the mutant's own behaviour here
    // would pass on both sides and measure nothing.
    const wait = page.logsOf('handback-wait').pop();
    assert(wait, 'the mutant revealed a frozen native at pod end with no wait');
    assert(page.logsOf('native-resume').filter((l) => l.d.tag === 'ad-end').length === 0,
      'the mutant resumed the element while it could not play forward');
  });
  // A NEW POD ENDS THE WAIT. The wait deliberately keeps the OLD frame revealed,
  // so `frame && revealed` is the normal state while it is armed and the ad-start
  // branch used to return without mounting the new pod - or, on a source switch,
  // let the stale poll see `!covered` and tear the REPLACEMENT frame down
  // (~150 ms after it mounted). Found by the refutation pass on 0.8.122.
  await greenArm('a new pod during the hand-back wait cancels it and keeps a picture up', async () => {
    const page = makeWorld();
    setNative(page, { ct: 30, edge: 40, bufferedEnd: 40, rs: 1 });
    await pod(page);
    await liveFrame(page, 2);
    page.bypass({ type: 'ad-end' });
    await settle(200);
    assert(page.logsOf('handback-wait').length === 1, 'the wait never armed, so this arm measures nothing');
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(400);
    const cancelled = page.logsOf('handback-wait-cancelled');
    assert(cancelled.length === 1 && cancelled[0].d.why === 'ad-start',
      `the new pod did not cancel the wait: ${JSON.stringify(cancelled.map((l) => l.d.why))}`);
    assert(page.logsOf('handback-ready').length === 0, 'the stale wait still ended the hand-back after the new pod');
    assert(page.logsOf('native-resume').filter((l) => l.d.tag === 'ad-end').length === 0,
      'the new pod handed the page back while it still owned the picture');
    assert(page.stats().frameMounted() === true, 'the new pod has no frame up');
  });
  // A TRANSIENT BLIND SAMPLE IS NOT A LOST COVER: one heartbeat that repeats its
  // position (or reports Paused) says nothing about the next 150 ms, and ending
  // the wait on it is the frozen native this change exists to prevent.
  await greenArm('one blind cover sample does not end the hand-back wait', async () => {
    const page = makeWorld();
    setNative(page, { ct: 30, edge: 40, bufferedEnd: 40, rs: 1 });
    await pod(page);
    await liveFrame(page, 2);
    page.bypass({ type: 'ad-end' });
    await settle(200);
    assert(page.logsOf('handback-wait').length === 1, 'the wait never armed, so this arm measures nothing');
    page.frameMsg({ ...healthySt({ pos: 100.3, lat: 3 }), paused: true });
    await settle(200);
    assert(page.logsOf('handback-ready').length === 0,
      'one blind sample ended the wait and put the frozen native back on screen');
    await liveFrame(page, 2, 100.6);
    await settle(400);
    assert(page.logsOf('handback-ready').length === 0, 'a recovered cover still ended the wait');
    assert(page.stats().handbackWait() !== null, 'the wait did not survive the blind sample');
  });
  // THE USER'S OWN PLAY ENDS THE WAIT: holding our picture over a player he just
  // took back is the 0.8.114 pause fight from the other side.
  await greenArm('a user play during the hand-back wait ends it with its reason', async () => {
    const page = makeWorld();
    setNative(page, { ct: 30, edge: 40, bufferedEnd: 40, rs: 1 });
    await pod(page);
    await liveFrame(page, 2);
    page.bypass({ type: 'ad-end' });
    await settle(200);
    assert(page.logsOf('handback-wait').length === 1, 'the wait never armed, so this arm measures nothing');
    page.document.fire({ type: 'pointerdown' });
    page.video.play();
    page.document.fire({ type: 'play', target: page.video });
    await settle(400);
    const ready = page.logsOf('handback-ready').pop();
    assert(ready, 'the user play did not end the wait');
    assert(ready.d.why === 'user-resume', `the wait ended as ${JSON.stringify(ready.d.why)}, not the user's play`);
    assert(ready.d.capped === false, 'the wait ended as the ceiling, not the gesture');
  });
  // RED: both cancels removed -> a switch during the wait tears the replacement
  // frame down 150 ms after it mounted.
  const RED_NO_CANCEL = mutate([
    ["        cancelHandbackWait('ad-start');\n", ''],
    ["    cancelHandbackWait('start-overlay');\n", ''],
  ]);
  await redArm('RED: without the cancel a switch during the wait tears the new frame down', RED_NO_CANCEL, async (src) => {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 30, edge: 40, bufferedEnd: 40, rs: 1 });
    await pod(page);
    await liveFrame(page, 2);
    page.bypass({ type: 'ad-end' });
    await settle(200);
    assert(page.logsOf('handback-wait').length === 1, 'the wait never armed in the mutant either, so this arm measures nothing');
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil', switch: true });
    await settle(400);
    assert(page.logsOf('handback-wait-cancelled').length === 1,
      'the mutant left the wait armed across a source switch');
    assert(page.logsOf('handback-ready').length === 0,
      'the stale wait tore down the frame the switch had just mounted');
  });

  // ---- 3. the user's sound decision wins ----------------------------------
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400, muted: true });
    await pod(page); // muteIntent captured as TRUE at take-over
    page.userSetsNative(false); // the user unmutes while the pod owns the player
    await settle(5);
    check('an unmute made during the pod reaches the clean player immediately', () => {
      assert(page.muteSent().includes(false), `clean player never unmuted: ${JSON.stringify(page.muteSent())}`);
      assert(page.audio.intent('twitch').muted === false, 'the intent change was not recorded');
    });
    page.bypass({ type: 'ad-end' });
    await settle(20);
    check('the in-pod unmute survives ad-end (the native is not re-muted)', () => {
      assert(page.video.muted === false, `native restored muted=${page.video.muted}`);
    });
  }

  // ---- 4. a paused player stays paused ------------------------------------
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page);
    page.document.visibilityState = 'hidden'; // the user is in another tab
    page.document.hidden = true;
    page.video.currentTime = 100;
    page.video.paused = true;
    page.bypass({ type: 'ad-end' });
    await settle(80);
    check('a pod that ends while the tab is hidden never starts playback', () => {
      assert(page.video.paused === true, 'the ad path resumed a player in a background tab');
      assert((page.video.plays || 0) === 0, `play() called ${page.video.plays} time(s)`);
    });
    page.showTab();
    await settle(30);
    check('...and it resumes once the tab is visible again', () => {
      assert(page.video.paused === false, 'the native stayed paused after the user returned to the tab');
      assert((page.video.plays || 0) >= 1, 'play() was never called on the visible tick');
      assert(page.logsOf('native-resume-visible').length === 1, 'the deferred resume was not recorded');
    });
  }
  {
    const page = makeWorld();
    // The user parked the stream at 120s, THEN the pod took over.
    setNative(page, { ct: 120, edge: 400, bufferedEnd: 400, paused: true });
    await pod(page);
    page.bypass({ type: 'ad-end' });
    await settle(1500); // the 300/1200ms resume retries must stay refused
    check('a player the user had paused is not restarted after the pod', () => {
      assert(page.video.paused === true, 'the user-paused native was resumed');
      assert((page.video.plays || 0) === 0, `play() called ${page.video.plays} time(s)`);
    });
  }
  {
    const page = makeWorld();
    // Cold preroll: the native never played (it is at the very beginning), so
    // the hand-off must still be able to start it.
    setNative(page, { ct: 0.2, edge: 400, bufferedEnd: 40, paused: true });
    await pod(page);
    page.bypass({ type: 'ad-end' });
    await settle(60);
    check('a cold preroll still hands back a running player at edge-3', () => {
      assert(page.video.paused === false, 'the cold-preroll native was left paused');
      assert(page.video.currentTime > 396 && page.video.currentTime < 398, `cold hand-off ct ${page.video.currentTime}`);
    });
  }

  // ---- 6. the cold cover has a deadline INSIDE the 12 s contract ----------
  // Measured 2026-11-07T13:40Z in a guest Chrome: the cover was taken at
  // 3410 ms, the clean frame reported `buffered=2.450291` and never reached the
  // 4 s reveal gate, and the cover ended at 15294 ms — past the contract, and
  // with no log line naming the branch, so the instrument read it as "resolved
  // by nothing". These two arms pin the branch: the timer must fire before the
  // bound and it must announce itself.
  async function coldCoverArm(source, boundMutated) {
    const page = makePage(source);
    setNative(page, { ct: 0.2, edge: 0, bufferedEnd: 0, paused: true }); // cold preroll
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    // Thin forward buffer: the reveal gate wants the 3 s sync target, and this
    // source never gives it (measured 2.45 s on the owner's own adlog).
    page.frameMsg(healthySt({ buffered: 2.45, lat: 30, pos: 30 }));
    page.bypass({ type: 'ad-hold' });
    await settle(40);
    const covered = page.logsOf('cold-cover').length > 0;
    const started = Date.now();
    await settle(boundMutated ? 12600 : 9600); // past 9 s, or past 12 s for the mutant
    return { page, covered, elapsed: Date.now() - started };
  }
  {
    const { page, covered } = await coldCoverArm(SOURCE, false);
    check('a cover that never reaches the 4s buffer bound hands the native back inside the 9s deadline', () => {
      assert(covered, `no cold-cover was taken (${JSON.stringify(page.logs().map((l) => l.ev))})`);
      const fired = page.logsOf('cold-cover-timeout');
      assert(fired.length === 1, `cold-cover-timeout fired ${fired.length} time(s), not once`);
      assert(fired[0].d.ms <= 9500, `the deadline fired at ${fired[0].d.ms} ms, not inside 9 s`);
      assert(page.logsOf('overlay-reveal').length === 0, 'the clean player was revealed although it never got healthy');
      assert(page.video.style.visibility !== 'hidden', `the native was left hidden (${page.video.style.visibility})`);
    });
  }

  // ---- 7. a command for a frame that has not navigated is held, not lost --
  // The browser rejects a post whose targetOrigin (the extension) does not
  // match the recipient window's origin, which is still the PAGE origin until
  // the frame's navigation commits: "Failed to execute 'postMessage' on
  // 'DOMWindow': The target origin provided ('chrome-extension://...') does
  // not match the recipient window's origin ('https://www.twitch.tv')"
  // (owner console 2026-11-07). A thrown post is a LOST command.
  {
    // A frame that has NOT navigated: the only way to observe the gate.
    const page = makePage(SOURCE, { autoLoad: false });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    // A second ad event with a fresher URL arrives while the frame is still
    // loading; pre-fix this posted `load` straight into a page-origin window.
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8?2', channel: 'rodil' });
    await settle(10);
    check('no command is posted into the clean frame before its navigation commits', () => {
      assert(page.frame, 'the overlay frame was never created');
      assert(page.sent.length === 0, `posted ${page.sent.length} command(s) into an un-navigated frame: ${JSON.stringify(page.sent)}`);
    });
    for (const f of ((page.frame.listeners.load || []).slice())) f();
    await settle(5);
    check('the held commands are flushed once the frame loads', () => {
      assert(page.sent.length > 0, 'the held command was dropped instead of flushed');
      assert(page.sent.some((m) => m && m.t === 'load'), `the load command never reached the frame: ${JSON.stringify(page.sent)}`);
    });
  }

  // ---- 8. the clean player is never pulled BACKWARD ----------------------
  // Owner report 2026-11-08: "trocou o player, voltou vários segundos". The
  // stall guard used to seek `pos - 2` twice before giving up, and the owner's
  // ko.adlog carries 14 `overlay-nudge` events with the position going back
  // 2s each time. A live picture only ever moves forward.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page, { pos: 100, lat: 4 });
    // A stalled tick: no future data, so the health gate cannot pass and the
    // stall guard runs its nudge.
    page.frameMsg(healthySt({ pos: 104, lat: 3, buffered: 0.2, rs: 2 }));
    await settle(2700);
    check('a stalled clean player is nudged FORWARD, never rewound', () => {
      const nudges = page.logsOf('overlay-nudge');
      assert(nudges.length >= 1, `the stall guard never ran: ${JSON.stringify(page.logs().map((l) => l.ev))}`);
      for (const n of nudges) assert(n.d.to >= n.d.pos, `nudge moved backward: ${n.d.pos} -> ${n.d.to}`);
      for (const s of page.seeks()) assert(s >= 100, `a seek went behind the picture: ${s}`);
    });
  }

  // ---- 9. a thin buffer does not tear down a player that is decoding -----
  // The 4s reveal floor was unreachable with `liveSyncDuration: 3`: every
  // genuine tick sat at ~3.6s, so the overlay was judged unhealthy forever,
  // nudged, and stopped (`overlay-stall-stop`) — the native came back behind.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page, { pos: 100, lat: 3 });
    assert(page.frame.style.opacity === '1', 'precondition: the overlay is revealed');
    for (let i = 0; i < 4; i++) {
      page.frameMsg(healthySt({ pos: 103 + i, lat: 3.6, buffered: 3.6, rs: 4 }));
      await settle(5);
    }
    check('a revealed player at the sync target is not nudged or stopped', () => {
      assert(page.logsOf('playing-not-healthy').length === 0, `still judged unhealthy at 3.6s of buffer: ${JSON.stringify(page.logsOf('playing-not-healthy').map((l) => l.d))}`);
      assert(page.logsOf('overlay-nudge').length === 0, 'the thin buffer fired the nudge');
      assert(page.logsOf('overlay-stall-stop').length === 0, 'the thin buffer tore the overlay down');
      assert(page.frame.style.opacity === '1', 'the overlay was hidden');
    });
  }

  // ---- 10. the sound hands over in the same tick as the picture ----------
  // Owner correction 2026-11-11: "se tu implementou de maneira burra, arruma. é
  // pra ser smooth/acontecer na hora/tempo real". A grace timer does not fix a
  // silence, it bounds it: the claim is taken in revealOverlay() only, in the
  // same synchronous task that raises the frame, and released at teardown. While
  // the page is the surface on screen it keeps its own sound, ad included.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(3200);
    const revealed = page.logsOf('overlay-reveal').length;
    check('take-over never silences the page that is still on screen', () => {
      assert(revealed === 0, `precondition: a cover revealed without a healthy sample (${revealed})`);
      assert(page.logsOf('claim-grace').length === 0, 'the grace machinery still exists');
      assert(page.video.muted === false, `the page was muted at take-over (muted=${page.video.muted})`);
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    const audibleAtTakeover = page.video.muted === false;
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3 }));
    await settle(10);
    check('the claim lands in the tick the clean picture appears', () => {
      assert(audibleAtTakeover, 'precondition: the page was already silenced at take-over');
      assert(page.logsOf('overlay-reveal').length === 1, 'precondition: the cover did not reveal');
      assert(page.frame.style.opacity === '1', 'precondition: the frame is not the surface');
      assert(page.video.muted === true, `the native kept its sound over the clean picture (muted=${page.video.muted})`);
    });
  }
  {
    const page = makeWorld({
      adSource: mutate([['        // writer the arbiter replaced.', '        audioClaim(true);\n        // writer the arbiter replaced.']]),
    });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    check('RED: a claim taken at take-over silences a page that still has its picture', () => {
      assert(page.video.muted === true, 'the mutant did not restore the pre-fix claim');
    });
  }

  // ---- 10a2. the catch-up does not turn the buffer frontier into a jump ---
  // Owner report 2026-11-12: "destravou, e avancou e malguma parte da live que
  // eu nao sei se e tempo real ou nao". His ko.adlog from that same session has
  // the mechanism, five times over, while the clean player was ON SCREEN:
  //   overlay-catchup {lat:9, hold:8.98, pos:36, to:41, want:41}
  //   overlay-catchup {lat:8, hold:8.03, pos:41, to:47, want:47}
  //   overlay-catchup {lat:8.5, hold:8.47, pos:47.5, to:53, want:53}
  // `lat` never closed because the seconds it counts are the source's own
  // segment cadence: the buffer already reaches the edge, so every seek threw
  // the picture 5-6 s forward and bought nothing.
  {
    const page = makeWorld();
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    // Prime the player HEALTHY at the target, so the reveal's own pre-show
    // alignment (which is allowed to seek) has already happened and this arm
    // measures the steady state only.
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 33, lat: 3, buffered: 8 }));
    await settle(60);
    // Exactly the reported shape: the edge is 9 s away, the buffer holds 8.6.
    for (let i = 0; i < 3; i++) { page.frameMsg(healthySt({ pos: 36 + i * 0.4, lat: 9, buffered: 8.6 })); await settle(220); }
    await settle(10);
    const before = page.seeks().length;
    for (let i = 0; i < 4; i++) {
      page.frameMsg(healthySt({ pos: 37.2 + i * 2.2, lat: 9, buffered: 8.6 }));
      await settle(2200); // past the 2 s catch-up throttle
    }
    check('a catch-up never seeks when the buffer already reaches the edge', () => {
      const rows = page.logsOf('overlay-catchup');
      assert(rows.length === 0, `catch-up fired ${rows.length}x on an edge the buffer already reaches: ${JSON.stringify(rows.map((r) => r.d))}`);
      assert(page.seeks().length === before, `the clean player was seeked ${page.seeks().length - before}x`);
    });
  }
  {
    // RED: drop the buffer-frontier rule and the same samples DO jump.
    const page = makeWorld({
      adSource: mutate([['    if (overlay.revealed && !force) return false;', '    if (false) return false;']]),
    });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 33, lat: 3, buffered: 8 }));
    await settle(60);
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 36, lat: 9, buffered: 8.6 }));
    await settle(10);
    page.frameMsg(healthySt({ pos: 41, lat: 9, buffered: 8.6 }));
    await settle(2200);
    check('RED: without the buffer-frontier rule the picture jumps 5 s forward', () => {
      const rows = page.logsOf('overlay-catchup');
      assert(rows.length >= 1, 'the mutant did not catch up either: the arm measures nothing');
      assert(rows[0].d.to - rows[0].d.pos >= 4, `the mutant sought only ${rows[0].d.to - rows[0].d.pos}s`);
    });
  }

  // ---- 10a2b. a PAUSED standby is not chased (the owner's own 0.8.96 ring) --
  // twitch.tv/lua_hx, player=kick, 2026-11-16: `overlay-catchup {hold:8.04,
  // lat:8, pos:82, source:"standby"}` -> `{hold:9, lat:9, pos:87}` ->
  // `{pos:93}` -> `{pos:103}` ... twenty rows over two minutes, `lat` never
  // closing. The playhead is PAUSED and the frontier it measures against moves
  // at 1x, so the same seek is due again as soon as the buffer grows past the
  // gap - and every one of them threw away the hls.js buffer it had filled.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    // Three healthy-but-PARKED reports, then the steady shape: 9 s behind, 8 s
    // of downloaded media in hand, the playhead never moving.
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ state: 'Paused', paused: true, pos: 82, lat: 9, buffered: 8.5 }));
    await settle(10);
    const before = page.seeks().length;
    for (let i = 0; i < 4; i++) {
      page.frameMsg(healthySt({ state: 'Paused', paused: true, pos: 82 + i * 5, lat: 9, buffered: 8.5 }));
      await settle(2200); // past the 2 s catch-up throttle
    }
    check('a paused standby is not chased: no seek, and the skip is said once per signature', () => {
      const seeked = page.seeks().length - before;
      assert(seeked === 0, `a paused standby was seeked ${seeked}x: ${JSON.stringify(page.seeks().slice(before))}`);
      const skips = page.logsOf('overlay-catchup-skip');
      assert(skips.length === 1, `expected one transition row, got ${skips.length}`);
      assert(skips[0].d.why === 'standby-paused', `wrong reason: ${skips[0].d.why}`);
      assert(page.logsOf('overlay-catchup').length === 0, 'a catch-up row was written for a paused standby');
    });
  }
  {
    // RED: the guard is what stops it. Without it the same four samples seek.
    const page = makeWorld({
      adSource: mutate([[`          const pausedStandby = !!overlay.standby && !overlay.revealed && !!m.st.paused;`, '          const pausedStandby = false;']]),
    });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ state: 'Paused', paused: true, pos: 82, lat: 9, buffered: 8.5 }));
    await settle(10);
    const before = page.seeks().length;
    for (let i = 0; i < 3; i++) {
      page.frameMsg(healthySt({ state: 'Paused', paused: true, pos: 82 + i * 5, lat: 9, buffered: 8.5 }));
      await settle(2200);
    }
    check('RED: without the paused-standby guard the same samples seek every time', () => {
      const seeked = page.seeks().length - before;
      assert(seeked >= 1, 'the mutant did not seek either: the arm measures nothing');
    });
  }

  // ---- 10a2c. A PAUSED STANDBY LEFT BY A PREVIOUS POD IS NOT A COVER ------
  // Owner report 2026-11-20, verbatim: "eu peguei anuncio por varios segundos".
  // His own Chrome's ring (twitch.tv/xqc, player=kick): 31 rows of
  // `overlay-catchup-skip {why:"standby-paused"}` and ~62.6 s of the native
  // playing the ad. The standby the previous pod left behind (paused, never
  // revealed, never torn down) answered `overlay.standby` on every tick, and
  // both the tick and the hold read that flag as "a clean picture is ready", so
  // no hold was raised and no source that can play was ever asked for.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    // The leftover: minted by a previous pod, then twelve 1 Hz reports saying
    // the frame never started. The run length is the proof, not one sample: a
    // frame that was just minted reports `paused` while its first segment is
    // fetched.
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 12; i++) {
      page.frameMsg(healthySt({ state: 'Paused', paused: true, pos: 82, lat: 9, buffered: 8.5 }));
    }
    await settle(10);
    check('twelve paused reports are what makes a standby stale', () => {
      const n = page.stats().standbyPausedReports();
      assert(n === 12, `the frame said paused 12 times and the counter says ${n}`);
    });
    page.stats().adUiHoldTick();
    await settle(10);
    check('the tick tears the stale standby down instead of calling it a cover', () => {
      const row = page.logsOf('ad-ui-hold').find((l) => l.d.act === 'standby-stale');
      assert(!!row, `no standby-stale row: ${JSON.stringify(page.logsOf('ad-ui-hold').map((l) => l.d))}`);
      assert(row.d.why === 'paused-never-revealed', `why=${JSON.stringify(row.d.why)}`);
      assert(row.d.reports === 12, `the row does not name the evidence: reports=${JSON.stringify(row.d.reports)}`);
      assert(page.frame && page.frame.removed === true, 'the stale frame is still mounted');
    });
    // ...and the NEW ad is served: the hold that was refusing at its standby
    // guard now pauses the ad frame. That is the contract the ring lost.
    page.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(10);
    check('a new ad is served once the stale standby is gone', () => {
      assert(page.video.paused === true, 'the ad kept playing after the stale standby was torn down');
      const held = page.logsOf('ad-ui-hold').filter((l) => l.d.act === 'paused');
      assert(held.length === 1, `hold rows=${JSON.stringify(held.map((l) => l.d))}`);
    });
  }
  // The other half: a standby that is PLAYING is not stale, and the same tick
  // must leave it alone (a fix that tore down every standby would "serve" every
  // ad by throwing away the warm source the pod depends on).
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await warmStandby(page, { pos: 100, lat: 3 });
    page.stats().adUiHoldTick();
    await settle(10);
    check('a standby that is playing is not torn down by the same tick', () => {
      assert(page.frame && page.frame.removed !== true, 'the tick tore down a healthy standby');
      const stale = page.logsOf('ad-ui-hold').filter((l) => l.d.act === 'standby-stale');
      assert(stale.length === 0, `a healthy standby was judged stale: ${JSON.stringify(stale.map((l) => l.d))}`);
    });
  }
  // The RED arm for this decision lives in the `negatives` list as
  // 'stale standby': the pre-fix branch leaves the flag set and the new ad is
  // refused by a standby from the previous pod.

  // ---- 10a3. no seek the element cannot cover (the 7 s freeze) -----------
  // Owner report 2026-11-12: "travou por uns 7 segundos. depois, destravou".
  // His ko.adlog: `native-handoff {buf:468, ct:468}` -> `native-edge-recover
  // {from:468, to:470.5}` -> `native-resume {ct:467, rs:1}` repeated at 300 /
  // 1200 / 2500 / 4000 / watch ms, every retry `native-edge-unusable {rs:1}`
  // and a `video-pause {rs:1}` under it, for seven seconds. The element held
  // nothing forward and Twitch's seekable edge is the 2^30 sentinel, so the
  // 2.6 s seek could only park it.
  {
    const page = makeWorld();
    setNative(page, { ct: 468, edge: 1073741824, bufferedEnd: 468 });
    page.video.readyState = 1; // HAVE_METADATA, no future data
    await pod(page);
    // The pod must have COST wall-clock time for a recovery to be proposed at
    // all: `behind = elapsed - advanced`, and his log shows `gap:2.6`. The pod
    // here is long enough that the WATCHED-OFFSET landing (`behind - cleanLat`)
    // is still a forward seek, and short enough that the pod-sized escape
    // (`POD_RECOVER_MIN`) does not apply: only the readiness guard can save it.
    await new Promise((r) => setTimeout(r, 5200));
    const writes = [];
    let clock = page.video.currentTime;
    Object.defineProperty(page.video, 'currentTime', {
      configurable: true,
      get: () => clock,
      set: (x) => {
        writes.push(+Number(x).toFixed(1));
        clock = x;
      },
    });
    page.bypass({ type: 'ad-end' });
    await settle(120);
    check('a small forward seek the element cannot cover is skipped, and logged', () => {
      const rows = page.logsOf('native-seek-skipped');
      assert(rows.length === 1, `native-seek-skipped rows: ${rows.length}`);
      assert(rows[0].d.why === 'no-data', `skip reason: ${rows[0].d.why}`);
      assert(writes.length === 0, `the native clock was written: ${JSON.stringify(writes)}`);
    });
  }
  {
    // RED: without the guard the same hand-back seeks into nothing.
    const page = makeWorld({
      adSource: mutate([
        ['        let covered = seekCovered(v, want);', '        let covered = true;'],
        // and the runway clamp, which is a second guard on the same harm: a RED
        // that leaves it armed measures the clamp, not the guard under test.
        [
          '        if (covered && se <= 0 && runwayEnd > 0 && want > runwayEnd - HEALTH_BUFFER_SEC) {',
          '        if (false && covered && se <= 0 && runwayEnd > 0 && want > runwayEnd - HEALTH_BUFFER_SEC) {',
        ],
      ]),
    });
    setNative(page, { ct: 468, edge: 1073741824, bufferedEnd: 468 });
    page.video.readyState = 1;
    await pod(page);
    await new Promise((r) => setTimeout(r, 5200));
    const writes = [];
    let clock = page.video.currentTime;
    Object.defineProperty(page.video, 'currentTime', {
      configurable: true,
      get: () => clock,
      set: (x) => {
        writes.push(+Number(x).toFixed(1));
        clock = x;
      },
    });
    page.bypass({ type: 'ad-end' });
    await settle(120);
    check('RED: without the guard the hand-back seeks past everything it holds', () => {
      assert(writes.length === 1, `the mutant wrote the clock ${writes.length}x: ${JSON.stringify(writes)}`);
      assert(writes[0] > 468, `the mutant seeked to ${writes[0]}, not forward`);
    });
  }

  // ---- 10a4. a POD-SIZED deficit is not a licence to seek an element that
  // ---- holds nothing (the 141.9 s jump, owner 2026-11-13) -----------------
  // His own ko.adlog, 0.8.90, twitch.tv/buzzyi_ (n 275628-275635):
  //   native-edge-unusable {from:30.1, rs:2}
  //   native-edge-recover  {behind:144.9, from:30.1, to:172, buf:42.4}
  //   native-resume        {ct:41.4, rs:1}
  // The pod cost 144.9 s of wall clock, so `overlay.recoverBehind >=
  // POD_RECOVER_MIN` held and the escape hatch set `covered = true` WITHOUT
  // consulting the readiness guard that had just refused the same seek — a
  // 130 s jump past the last buffered frame on a HAVE_METADATA element. The
  // browser clamped it, left rs:1, and the picture had to be refilled from
  // nothing. A long deficit is no more seekable than a short one on an element
  // that cannot play forward.
  {
    const page = makeWorld();
    setNative(page, { ct: 30.1, edge: 1073741824, bufferedEnd: 42.4 });
    page.video.readyState = 2; // HAVE_CURRENT_DATA: the state his element was in
    await pod(page);
    // A pod long enough that the escape hatch WOULD fire: `behind` grows with
    // the wall clock, so the whole wait is the defect's own precondition.
    await new Promise((r) => setTimeout(r, 16000));
    const writes = [];
    let clock = page.video.currentTime;
    Object.defineProperty(page.video, 'currentTime', {
      configurable: true,
      get: () => clock,
      set: (x) => {
        writes.push(+Number(x).toFixed(1));
        clock = x;
      },
    });
    page.bypass({ type: 'ad-end' });
    await settle(150);
    check('a pod-sized deficit does not licence a seek on an element that cannot play forward', () => {
      const rec = page.logsOf('native-edge-recover');
      assert(rec.length === 0, `the hand-back seeked anyway: ${JSON.stringify(rec.map((r) => r.d))}`);
      assert(writes.length === 0, `the native clock was written at rs=2: ${JSON.stringify(writes)}`);
      const skipped = page.logsOf('native-seek-skipped');
      assert(skipped.length === 1, `the skip was not reported (rows ${skipped.length})`);
    });
  }

  {
    // RED: the pre-fix escape hatch, which ignored readiness. This is the
    // defect itself, rebuilt from his own log line.
    const page = makeWorld({
      adSource: mutate([
        [
          '        if (!covered && readyForPodSeek && why === \'edge-recover\' && overlay.recoverBehind >= POD_RECOVER_MIN) covered = true;',
          '        if (!covered && why === \'edge-recover\' && overlay.recoverBehind >= POD_RECOVER_MIN) covered = true;',
        ],
        // and the runway clamp, added after this RED was written: leaving it
        // armed would make the mutant measure the clamp instead of the gap.
        [
          '        if (covered && se <= 0 && runwayEnd > 0 && want > runwayEnd - HEALTH_BUFFER_SEC) {',
          '        if (false && covered && se <= 0 && runwayEnd > 0 && want > runwayEnd - HEALTH_BUFFER_SEC) {',
        ],
      ]),
    });
    setNative(page, { ct: 30.1, edge: 1073741824, bufferedEnd: 42.4 });
    page.video.readyState = 2;
    await pod(page);
    await new Promise((r) => setTimeout(r, 16000));
    const writes = [];
    let clock = page.video.currentTime;
    Object.defineProperty(page.video, 'currentTime', {
      configurable: true,
      get: () => clock,
      set: (x) => {
        writes.push(+Number(x).toFixed(1));
        clock = x;
      },
    });
    page.bypass({ type: 'ad-end' });
    await settle(150);
    check('RED: without the readiness gate the pod-sized deficit jumps past everything held', () => {
      assert(writes.length === 1, `the mutant wrote the clock ${writes.length}x: ${JSON.stringify(writes)}`);
      assert(writes[0] > 42.4, `the mutant seeked to ${writes[0]}, not past the buffered end 42.4`);
    });
  }

  // ---- 10b. the hand-back is ONE seek, and the retries never seek --------
  // Owner report 2026-11-11, right after the pod: "it then came back to the
  // twitch player and flicked/glitched. showed a part of the livestream, then
  // advanced and returned". His ko.adlog has that literally: `native-edge-recover
  // to 554.8` and, one millisecond later, `native-catchup to 531.7` — two seeks
  // in opposite directions — then three more catchups of 13, 17 and 17 s from
  // the 300/1200/2500 ms retries.
  {
    // A POD-SIZED deficit on purpose: the 2026-11-12 rule refuses a forward seek
    // past the downloaded data for a couple of seconds (measured: landing 0.5 s
    // before `buffered.end` parks the element at rs:1), and only pays that price
    // for the delay a whole pod costs. `POD_RECOVER_MIN` is 10 s.
    const page = makeWorld();
    // RUNWAY, not 1 s: the 2026-11-16 clamp refuses a landing past the data the
    // element holds (that refusal is its own arm). This arm measures the
    // different contract - ONE seek per hand-back, none from the retries - so it
    // needs a target the element can actually reach.
    setNative(page, { ct: 100, edge: 1073741824, bufferedEnd: 130 });
    await pod(page);
    await new Promise((r) => setTimeout(r, 12200));
    // Count every write to the native clock from here on.
    const writes = [];
    let clock = page.video.currentTime;
    Object.defineProperty(page.video, 'currentTime', {
      configurable: true,
      get: () => clock,
      set: (x) => {
        writes.push(+Number(x).toFixed(1));
        clock = x;
      },
    });
    page.bypass({ type: 'ad-end' });
    // The buffer keeps filling after the hand-back, exactly as measured: the
    // player's own data ran ~30 s ahead of its clock, which is what turned each
    // retry into a forward seek.
    await settle(420);
    page.video.buffered = { length: 1, start: () => 0, end: () => clock + 30 };
    await settle(4180); // past every retry (300/1200/2500/4000)
    check('the hand-back seeks once and the retries never seek', () => {
      assert(writes.length === 1, `the native clock was written ${writes.length} time(s): ${JSON.stringify(writes)}`);
      assert(writes[0] > 101, `the single seek went to ${writes[0]}, not forward to the live offset`);
      assert(page.logsOf('native-catchup').length + page.logsOf('native-edge-recover').length === 1,
        `more than one recovery logged: ${JSON.stringify([...page.logsOf('native-catchup'), ...page.logsOf('native-edge-recover')].map((l) => l.ev))}`);
    });
  }
  {
    // Mutation: the retries seek again (`if (seek)` -> `if (true)`) AND the
    // hand-back aims at `buffered.end - 0.5`. That PAIR is the pre-fix shape:
    // the target is what made every retry a forward jump, so restoring only the
    // retry guard leaves nothing to seek to.
    const page = makeWorld({
      adSource: mutate([
        ['      if (seek) {', '      if (true) {'],
        ['      const target = se > 0 ? Math.max(0, se - cleanLat) : from;',
          '      const target = se > 0 ? Math.max(0, se - cleanLat) : Math.max(0, nativeBufferedEnd(v) - 0.5);'],
      ]),
    });
    // The same runway the arm above uses: the mutant restores the pre-fix aim,
    // and the clamp (armed here, since this mutant is about the retries) must
    // not be what produces the second write.
    setNative(page, { ct: 100, edge: 1073741824, bufferedEnd: 130 });
    await pod(page);
    await new Promise((r) => setTimeout(r, 12200));
    let writes = 0;
    let clock = page.video.currentTime;
    Object.defineProperty(page.video, 'currentTime', {
      configurable: true,
      get: () => clock,
      set: (x) => { writes++; clock = x; },
    });
    page.bypass({ type: 'ad-end' });
    await settle(420);
    page.video.buffered = { length: 1, start: () => 0, end: () => clock + 30 };
    await settle(1300);
    check('RED: a retry that seeks moves the picture again after the hand-back', () => {
      assert(writes > 1, `the mutant did not seek on the retry (writes=${writes})`);
    });
  }

  // ---- 10c. the swap reconciles the clean player's OWN audio report -------
  // Owner report 2026-11-11: "just got an ad, player switched, and its muted".
  // A fresh media element starts muted and a diffed command is never re-sent, so
  // a frame that reports muted right after the claim has to be corrected inside
  // the swap window - and never after it (that would be the mute fight 0.8.50
  // ended).
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3, muted: false }));
    await settle(10);
    const before = page.muteSent().filter((m) => m === false).length;
    page.frameMsg(healthySt({ pos: 100, lat: 3, muted: true })); // element remuted underneath
    await settle(10);
    check('a report that cannot have seen our command is named as lag, and corrected at once', () => {
      const lag = page.logsOf('audio-stale-report');
      assert(lag.length === 1, `stale-report rows=${lag.length}`);
      assert(lag[0].d.sentAgeMs != null && lag[0].d.sentAgeMs < 400, `sentAgeMs=${lag[0].d.sentAgeMs}`);
      assert(page.logsOf('audio-mismatch').length === 0, 'a lagging report was logged as a real disagreement');
      assert(page.muteSent().filter((m) => m === false).length > before, 'the unmute was not re-sent');
    });
  }
  {
    // The other half of the same bound: a disagreement the frame had time to
    // act on IS a real swap mute, and it keeps its own name and its re-send.
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3, muted: false }));
    await settle(500); // inside AUDIO_ASSERT_MS, past AUDIO_REPORT_LAG_MS for the streak
    const before = page.muteSent().filter((m) => m === false).length;
    page.frameMsg(healthySt({ pos: 101, lat: 3, muted: true })); // first report of the streak: lag
    await settle(500);
    page.frameMsg(healthySt({ pos: 102, lat: 3, muted: true })); // it survived a report: a mute
    await settle(10);
    check('a swap disagreement the frame had time to heed is still a mismatch', () => {
      const mm = page.logsOf('audio-mismatch');
      assert(mm.length >= 1, 'a real swap disagreement was excused as lag');
      assert(mm[0].d.phase === 'swap', `mismatch classified as ${mm[0].d.phase}`);
      assert(mm[0].d.heldMs >= 400, `heldMs=${mm[0].d.heldMs}`);
      assert(page.logsOf('audio-stale-report').length === 1, 'the streak did not start as a lag row');
      assert(page.muteSent().filter((m) => m === false).length > before, 'the unmute was not re-sent');
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3, muted: false }));
    await settle(4300); // past AUDIO_ASSERT_MS
    const before = page.muteSent().filter((m) => m === false).length;
    page.frameMsg(healthySt({ pos: 100, lat: 3, muted: true }));
    await settle(10);
    check('a late disagreement is reported, never overridden (no mute fight)', () => {
      const mm = page.logsOf('audio-mismatch');
      assert(mm.length >= 1, 'no mismatch was detected');
      assert(mm[mm.length - 1].d.phase === 'late', `mismatch classified as ${mm[mm.length - 1].d.phase}`);
      assert(page.muteSent().filter((m) => m === false).length === before, 'the late report was overridden');
    });
  }

  // ---- 10. the heartbeat never re-sends the mute the user just changed ---
  // Owner report 2026-11-08: "fica mutando quando eu desmuto o tempo inteiro".
  // `revealOverlay()` runs on every `st` (1/s) and re-sent `mute:true` forever;
  // his ko.adlog has 50 `reveal-muted` in 70s.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400, muted: true });
    await pod(page);
    const before = page.muteSent().filter((m) => m === true).length;
    for (let i = 0; i < 5; i++) {
      page.frameMsg(healthySt({ pos: 100 + i, lat: 3 }));
      await settle(3);
    }
    check('a muted pod sends the mute once, not on every heartbeat', () => {
      const after = page.muteSent().filter((m) => m === true).length;
      assert(after - before <= 1, `the heartbeat re-sent the mute ${after - before} times over 5 ticks`);
      assert(page.logsOf('reveal-muted').length <= 2, `reveal-muted logged ${page.logsOf('reveal-muted').length} times`);
    });
    // The user unmutes: the decision must survive the following heartbeats.
    page.userSetsNative(false, 0.97);
    await settle(5);
    const idx = page.muteSent().length;
    for (let i = 0; i < 3; i++) {
      page.frameMsg(healthySt({ pos: 105 + i, lat: 3, muted: false }));
      await settle(3);
    }
    check('an unmute made during the pod is not overwritten by the heartbeat', () => {
      const after = page.muteSent().slice(idx).filter((m) => m === true).length;
      assert(after === 0, `the heartbeat re-muted the player ${after} times after the user unmuted`);
      // The unmute reaching the page is the CLEAN frame being told `mute:false`
      // and the authority holding that intent; the native's own `paused` flag is
      // no evidence here, because a held pod pauses it by design (and, since
      // 0.8.93, from `ad-hold` itself rather than from the first frame).
      assert(page.muteSent().includes(false), `the clean frame was never unmuted: ${JSON.stringify(page.muteSent())}`);
      assert(page.audio.intent('twitch').muted === false, 'the authority lost the unmute');
    });
  }

  // ---- 10. THE AD STOPS WHEN TWITCH SAYS IT IS AN AD --------------------
  // Owner report 2026-11-15, verbatim: "bugs: ad toca por uns 4 segundos até
  // finalmente ser 'defendido' pela extensao". `ad-hold` is posted by the
  // worker's playlist probe, which needs a segment refresh; Twitch's own ad
  // wrapper is in the DOM before that, and those seconds are exactly what he
  // sees. The hold therefore also starts from the page's own signal.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    const api = page.stats();
    // 1. the signal is enough on its own, with no worker message at all
    api.adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(5);
    check('the ad wrapper appearing pauses the player before any ad-hold arrives', () => {
      assert(page.video.paused === true, 'the ad kept playing until the worker noticed');
      const l = page.logsOf('ad-ui-hold');
      assert(l.length >= 1, 'the hold wrote no ad-ui-hold line');
      assert(l[0].d.act === 'paused', `act=${JSON.stringify(l[0].d.act)}`);
      assert(api.adUiHeldAt() > 0, 'the hold did not record when it started');
    });
    // 2. THE MACHINE play: Twitch's ad renderer calls play() with no gesture.
    // Clear the input clock so this arm cannot inherit a pointerdown from
    // setup and accidentally measure the USER path.
    api.adTestClock({ clearInput: true });
    page.video.play();
    page.document.fire({ type: 'play', target: page.video });
    api.adUiHoldTick();
    await settle(5);
    check('a machine play (no gesture) is re-asserted, not accepted', () => {
      assert(page.video.paused === true, 'Twitch resumed the ad and the hold gave up');
      assert(api.userPlayAt() === 0, `a gestureless play was stamped as a user play (${api.userPlayAt()})`);
    });
    // 2b. THE GESTURE-BEARING COMPANION. Same play event, but a real input
    // first: the hold releases once and the 500 ms tick never takes it back.
    page.document.fire({ type: 'pointerdown' });
    page.video.play();
    page.document.fire({ type: 'play', target: page.video });
    api.adUiHoldTick();
    await settle(5);
    check('a fresh user play releases the hold and is not re-paused', () => {
      assert(api.userPlayAt() > 0, 'the user play was not stamped');
      assert(page.video.paused === false, 'the tick undid the user unpause');
      assert(api.adUiHeldAt() === 0, 'the hold stamp survived the user play');
      assert(page.logsOf('ad-ui-hold').filter((l) => l.d.act === 'user-resume').length === 1,
        'the user resume was not logged exactly once');
    });
    api.adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(5);
    check('the episode failed by the user is not re-held', () => {
      assert(page.video.paused === false, 'the same episode took the picture back');
    });
    // 3. the ad ends after the user took back: nothing is left frozen.
    api.adUiRelease();
    await settle(30);
    check('an ad the user took back stays his after it ends', () => {
      assert(page.video.paused === false, 'the ad-end path re-paused the user picture');
      const r = page.logsOf('ad-ui-release').pop();
      assert(!!r, 'the release wrote no line');
      assert(r.d.act === 'playing', `act=${JSON.stringify(r.d.act)}`);
    });
  }
  // ---- 4. A PAUSE IS THE USER'S ONLY WITH A REAL INPUT BESIDE IT ---------
  // Owner ring 2026-11-26 (0.8.116, twitch.tv/buzzyi_): alt-tabbed, the page
  // paused its OWN element inside a playlist pod (`ad-tick playing while
  // owned=6`), the listener stamped `ad-ui-hold {act:"user-pause", ct:3.4}`
  // with nobody at the keyboard, and `userPausedInPod` then refused every
  // hand-back resume for the rest of the pod - `native-handoff
  // {resume:NEVER, podAge:3m12.1}` with the picture parked. That is the report
  // verbatim: "a live pausou enquanto eu estava alt tab".
  {
    const page = makeWorld();
    const api = page.stats();
    setNative(page, { ct: 120, edge: 400, bufferedEnd: 400 });
    await pod(page);
    await settle(300); // OUR take-over pause (`selfPausedAt`) must age out first
    api.adTestClock({ clearInput: true });
    page.video.pause();
    page.document.fire({ type: 'pause', target: page.video });
    await settle(10);
    check('a machine pause inside a pod is not the user parking the picture', () => {
      const rows = page.logsOf('ad-ui-hold');
      const stamped = rows.filter((r) => r.d.act === 'user-pause');
      assert(stamped.length === 0,
        `a gestureless pause was stamped as the user's: ${JSON.stringify(stamped.map((r) => r.d))}`);
      const refused = rows.filter((r) => r.d.act === 'pause-refused');
      assert(refused.length === 1,
        `the refusal was not recorded exactly once: ${JSON.stringify(rows.map((r) => r.d.act))}`);
      assert(refused[0].d.sinceInputMs == null, `the refusal invented an input age: ${JSON.stringify(refused[0].d)}`);
    });
    page.bypass({ type: 'ad-end' });
    await settle(400);
    check('...and that pod still gives the picture back at the hand-back', () => {
      assert(page.video.paused === false,
        'the hand-back left the element parked after a pause nobody made');
    });
  }
  {
    // The companion: the same two events WITH a gesture are the user's, and
    // the hand-back must then leave his picture alone.
    const page = makeWorld();
    const api = page.stats();
    setNative(page, { ct: 120, edge: 400, bufferedEnd: 400 });
    await pod(page);
    await settle(300); // OUR take-over pause (`selfPausedAt`) must age out first
    page.document.fire({ type: 'pointerdown' });
    page.video.pause();
    page.document.fire({ type: 'pause', target: page.video });
    await settle(10);
    check('a pause with a fresh input is the user\'s, and the row names the input', () => {
      const rows = page.logsOf('ad-ui-hold').filter((r) => r.d.act === 'user-pause');
      assert(rows.length === 1, `user-pause rows=${JSON.stringify(rows.map((r) => r.d))}`);
      assert(typeof rows[0].d.inputAgeMs === 'number',
        `the accepted pause did not name the input that authorized it: ${JSON.stringify(rows[0].d)}`);
    });
    page.bypass({ type: 'ad-end' });
    await settle(400);
    check('...and a player HE parked stays parked at the hand-back', () => {
      assert(page.video.paused === true, 'the ad path restarted a player the user paused');
    });
  }
  // RED: without the input clock any pause that is not ours becomes the user's,
  // which is the measured production behaviour.
  {
    const blindPause = mutate([[
      "      if (!hasFreshInput()) {\n        if (!userPauseRefusedLogged) {",
      "      if (false) {\n        if (!userPauseRefusedLogged) {",
    ]]);
    const page = makeWorld({ adSource: blindPause });
    const api = page.stats();
    setNative(page, { ct: 120, edge: 400, bufferedEnd: 400 });
    await pod(page);
    await settle(300); // OUR take-over pause (`selfPausedAt`) must age out first
    api.adTestClock({ clearInput: true });
    page.video.pause();
    page.document.fire({ type: 'pause', target: page.video });
    await settle(10);
    check('RED: without the input clock a machine pause parks the picture for the pod', () => {
      const stamped = page.logsOf('ad-ui-hold').filter((r) => r.d.act === 'user-pause');
      assert(stamped.length === 1,
        `the mutant refused the pause: this arm measures nothing (${JSON.stringify(page.logsOf('ad-ui-hold').map((r) => r.d.act))})`);
    });
  }
  // RED: the pre-fix play listener had no input clock, so a gesture did not
  // release the hold and the very next tick re-paused the user's unpause.
  {
    const blind = mutate([[
      "      const pod = adUiHeldAt ? 'hold' : (overlay.adActive || overlay.revealed ? 'playlist' : null);",
      "      if (!adUiHeldAt || userResumedHeld()) return;\n      const pod = null;",
    ]]);
    const page = makeWorld({ adSource: blind });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    const api = page.stats();
    api.adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(5);
    page.document.fire({ type: 'pointerdown' });
    page.video.play();
    page.document.fire({ type: 'play', target: page.video });
    api.adUiHoldTick();
    await settle(5);
    check('RED: without the input clock the user unpause is undone by the tick', () => {
      assert(page.video.paused === true, 'the mutant honoured the gesture: this arm measures nothing');
      assert(page.logsOf('ad-ui-hold').filter((l) => l.d.act === 'user-resume').length === 0,
        'the mutant logged a user resume');
    });
  }
  // A BARE banner on an unshrunk player is the control: an ad surface, but
  // the full-size picture must never be paused over it.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    const api = page.stats();
    check('a bare banner on an unshrunk player does not pause the stream', () => {
      assert(api.adHoldWorthy({ kind: 'wrapper', w: 160, h: 90 }, page.video) === false,
        'a 160x90 bare banner was judged a playing ad');
      assert(api.adHoldWorthy({ kind: 'wrapper', w: 1280, h: 720 }, page.video) === true,
        'a full-size wrapper was not judged a playing ad');
      assert(api.adHoldWorthy({ kind: 'aria', label: 'Anúncio (0:12)' }, page.video) === true,
        'the countdown label was not judged a playing ad');
    });
    api.adUiHold({ kind: 'wrapper', w: 160, h: 90 });
    await settle(5);
    check('the bare-banner hold is a no-op in effect', () => {
      assert(page.video.paused === false, 'the bare banner paused the picture');
    });
  }
  // 4. RED: without the width gate any wrapper is an ad.
  {
    const blind = mutate([["      return detail.w >= 0.5 * r.width; // a wide lower third is a played ad", "      return true;"]]);
    const page = makeWorld({ adSource: blind });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.stats().adUiHold({ kind: 'wrapper', w: 160, h: 90 });
    await settle(5);
    check('RED: a wrapper-only gate pauses the stream on a bare banner', () => {
      assert(page.video.paused === true,
        'the mutant refused the bare banner too: this arm is not measuring the gate');
    });
  }
  // ---- 10e. A NEW AD AFTER REVEAL IS NOT A HAND-BACK --------------------
  // The clean frame revealed; Twitch starts another pod before ad-end. The
  // old `adActive || revealed` gate skipped it, and hand-back resumed the
  // native straight onto the live ad.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page);
    await settle(40);
    check('precondition: the pod revealed and froze the native', () => {
      assert(page.logsOf('overlay-reveal').length === 1, 'no clean picture revealed');
      assert(page.video.paused === true, 'the native was not frozen for the hand-back');
    });
    const api = page.stats();
    api.setAdUiDetailForTest(() => ({ kind: 'wrapper', w: 1280, h: 720 }));
    page.bypass({ type: 'ad-end' });
    await settle(80);
    check('a new ad after reveal is held, never resumed onto', () => {
      const named = page.logsOf('ad-ui-hold').filter((l) => l.d.act === 'ad-after-reveal');
      assert(named.length === 1, `the new ad was not named exactly once: ${JSON.stringify(page.logsOf('ad-ui-hold'))}`);
      assert(page.logsOf('native-resume').filter((l) => l.d.tag === 'ad-end').length === 0,
        'the hand-back resumed the native onto the new ad');
      assert(page.video.paused === true, 'the new ad kept playing');
    });
  }
  {
    const blind = mutate([
      ['    if (revealedAd) holdAfterReveal(revealedAd);', '    if (false) holdAfterReveal(revealedAd);'],
      ['    const target = adUiHoldTarget();\n    if (target) {', '    const target = null;\n    if (target) {'],
      ['      if (v && !revealedAd) {', '      if (v) {'],
      ['    if (overlay.adEndTries < 3 && adUiPresent()) {', '    if (false) {'],
    ]);
    const page = makeWorld({ adSource: blind });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page);
    await settle(40);
    check('RED precondition: the mutant revealed the clean picture too', () => {
      assert(page.logsOf('overlay-reveal').length === 1, 'the mutant never revealed');
    });
    page.stats().setAdUiDetailForTest(() => ({ kind: 'wrapper', w: 1280, h: 720 }));
    page.bypass({ type: 'ad-end' });
    await settle(80);
    check('RED: the pre-fix hand-back resumes the native onto the live ad', () => {
      assert(page.logsOf('native-resume').filter((l) => l.d.tag === 'ad-end').length >= 1,
        'the mutant never resumed: this arm measures nothing');
      assert(page.video.paused === false, 'the mutant kept the native parked');
    });
  }
  // 5. THE FREEZE: our own pause must not be read as the user parking the player.
  // Owner report 2026-11-15: "ao voltar pro player da twitch, ele TRAVA inves de
  // voltar pro tempo real ... pra destravar eu q tenho q clicar em pause
  // despause". The hold pauses the element seconds before the pod takes over,
  // and `pauseBeforeAd = !!v.paused` then recorded OUR pause as HIS, so every
  // resume was refused and the picture stayed stopped.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(5);
    check('the instant hold really paused the element first', () => {
      assert(page.video.paused === true, 'the arm needs the hold to have paused the native');
    });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3 }));
    await settle(10);
    page.bypass({ type: 'ad-end' });
    await settle(60);
    check('a pod that took over from our own hold still hands the picture back', () => {
      assert(page.video.paused === false, 'the hand-back left the native frozen (the reported freeze)');
      const r = page.logsOf('native-resume').pop();
      assert(!!r, 'the hand-back wrote no native-resume line');
      assert(r.d.userParked === false, `userParked=${JSON.stringify(r.d.userParked)} blames the user for our pause`);
      assert(typeof r.d.behind === 'number', 'native-resume did not say how far from the edge the picture is');
    });
  }
  // 6. RED: the pre-fix attribution freezes exactly that hand-back.
  {
    const blind = mutate([["overlay.pauseBeforeAd = !!v.paused && !selfPausedRecently() && !overlay.coldPreroll;",
      "overlay.pauseBeforeAd = !!v.paused;"]]);
    const page = makeWorld({ adSource: blind });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(5);
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3 }));
    await settle(10);
    page.bypass({ type: 'ad-end' });
    await settle(60);
    check('RED: reading our own hold as the user freeze the hand-back', () => {
      assert(page.video.paused === true,
        'the mutant resumed it too: this arm is not measuring the attribution');
    });
  }

  // ---- 10d. the cooldown's escape hatch asks the same question the hold does
  // Owner report 2026-11-19, verbatim: "tomou outro anuncio agora - ~4-5s de
  // anuncio, nosso player entrou, e depois de mais alguns segundos tomou anuncio
  // DE NOVO". `AD_REOPEN_COOLDOWN_MS` exists exactly to refuse that second cover:
  // a playlist marker outlives the break that produced it. Its escape hatch was
  // a bare `adUiDetail()`, and Twitch keeps a squeezeback shell in the DOM
  // PERMANENTLY (0x0, `__wrapper-hidden`, measured 2026-11-15), so the hatch was
  // open on a node that is not an ad - the second pod walked straight through.
  //
  // The two predicates are driven directly, because that is where the decision
  // lives: `adUiDetail()` returns the shell and `adHoldWorthy()` refuses it, and
  // the cooldown must read the second. Driving them through the DOM walk would
  // test `adSurfaceRect`, which is a different question with its own arms.
  {
    const api = makeWorld().stats();
    const permanentShell = { kind: 'wrapper', w: 0, h: 0 };
    const measuredAd = { kind: 'wrapper', w: 1236, h: 695 };
    check('the permanent squeezeback shell is what adUiDetail() answers', () => {
      assert(api.adHoldWorthy(permanentShell, makeWorld().video) === false,
        'a 0x0 wrapper was hold-worthy: the shell would pause the player');
    });
    check('a measured ad surface IS hold-worthy (the control)', () => {
      assert(api.adHoldWorthy(measuredAd, makeWorld().video) === true,
        'a full-player surface was refused, so the cooldown can never reopen');
    });
    // The cooldown's clause, exactly as shipped: refuse while a pod just ended
    // AND the page does not show a hold-worthy ad right now.
    check('the cooldown reads adHoldWorthy, not a bare adUiDetail()', () => {
      // Resolve from the suite's own directory: MEASURED 2026-11-26, this arm
      // failed with `ENOENT .../kicktwitchyoutube_instagram/twitch-adblock.js`
      // when the suite was started from the repo root, so it asserted on cwd
      // instead of on the file it names.
      const src = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8');
      // Find the clause by its CONDITION, not by the constant: the comment
      // above it is long enough to eat any fixed-size window.
      const at = src.indexOf('!adHoldWorthy(adUiDetail(), mainVideo())');
      assert(at > 0, 'the cooldown hatch is not the strong predicate in this file');
      // ...and it must sit inside the cooldown clause, not somewhere else.
      const cool = src.lastIndexOf('AD_REOPEN_COOLDOWN_MS &&', at);
      assert(cool > 0 && at - cool < 900,
        `the strong predicate is ${at - cool} chars from the cooldown clause`);
    });
    // RED: the pre-fix hatch, evaluated over the shell the page really carries.
    const weak = (detail) => !detail;
    check('RED: the weak hatch is open on the permanent shell', () => {
      // The shell is truthy, so `!adUiDetail()` is false and the cooldown is
      // skipped: the second pod starts. That is the defect, stated as data.
      assert(weak(permanentShell) === false,
        'the weak hatch refused the shell, so the arm above is not measuring it');
    });
  }

  // ---- 11. "AM I IN REAL TIME?" IS A LOG FIELD ---------------------------
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    // The frame is the only code that can say WHICH instrument measured `lat`,
    // so the reports that lead to the reveal carry one. The reveal is a
    // transition: a later report cannot retroactively label it.
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100 + i, lat: 3.4, buffered: 6, latSrc: 'hls' }));
    await settle(20);
    const r = page.logsOf('overlay-reveal').pop();
    check('the reveal says how far behind the edge the picture that went up is', () => {
      assert(!!r, 'no overlay-reveal line');
      assert(r.d.lat === 3.4, `lat=${JSON.stringify(r.d.lat)} is not the frame's own measurement`);
      assert(r.d.latSrc === 'hls', `latSrc=${JSON.stringify(r.d.latSrc)} does not name the instrument`);
      assert('edgeBehind' in r.d, 'the reveal does not carry the native edge distance');
      assert(r.d.edgeBehind === 3, `edgeBehind=${JSON.stringify(r.d.edgeBehind)} is not edge-ct`);
      assert(r.d.target === 3, `target=${JSON.stringify(r.d.target)} is not the sync target`);
    });
  }

  // ---- 12. THE HAND-BACK UNSTICKS ITSELF --------------------------------
  // Owner report 2026-11-15: "ao voltar pro player da twitch, ele TRAVA inves
  // de voltar pro tempo real ... pra destravar eu q tenho q clicar em pause
  // despause". Measured in HIS 0.8.92 ring: `native-resume {ct:19.1, rs:2}`
  // followed by 8.7 s of nothing while the element held 0.1 s in front of the
  // playhead. The nudge threshold was 1 s, and `play()` needs 3.
  {
    const page = makeWorld();
    // The element sits at the head of what it already holds: exactly the
    // hand-back state his log shows.
    // 1.0 s of runway: above the old 0.5 s gate and below the health gate's 3 s,
    // which is the whole window the reported freeze lived in. The edge is the
    // sentinel on purpose (his own ring: `se:1073741824`), so no forward seek
    // can rescue the element and the nudge is the only recovery there is.
    setNative(page, { ct: 18.2, edge: 1073741824, bufferedStart: 0, bufferedEnd: 19.2 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 30, lat: 3 }));
    await settle(20);
    page.bypass({ type: 'ad-end' });
    await settle(3000);
    const moves = page.logsOf('native-nudge');
    check('a hand-back with no runway rewinds into its own buffer instead of waiting', () => {
      assert(moves.length === 1, `expected one nudge, got ${moves.length}: ${JSON.stringify(moves.map((r) => r.d))}`);
      assert(moves[0].d.to < 18.2, `nudged to ${moves[0].d.to}, not back from 18.2`);
      assert(moves[0].d.runway >= 3 - 0.05, `runway after the nudge was ${moves[0].d.runway}s`);
      assert(page.video.currentTime < 18.2, `currentTime=${page.video.currentTime} was not moved back into the buffer`);
    });
  }
  // RED: a half-second threshold leaves the element parked (the reported freeze).
  {
    const blind = mutate([
      ['if (b.end(i) - b.start(i) >= HEALTH_BUFFER_SEC + 0.5 && b.end(i) - ct < HEALTH_BUFFER_SEC) {',
        'if (b.end(i) - b.start(i) >= 2 && b.end(i) - ct < 0.5) {'],
      ['if (ahead >= HEALTH_BUFFER_SEC || target === null) return false;', 'if (ahead >= 0.5 || target === null) return false;'],
    ]);
    const page = makeWorld({ adSource: blind });
    // 1.0 s of runway: above the old 0.5 s gate and below the health gate's 3 s,
    // which is the whole window the reported freeze lived in. The edge is the
    // sentinel on purpose (his own ring: `se:1073741824`), so no forward seek
    // can rescue the element and the nudge is the only recovery there is.
    setNative(page, { ct: 18.2, edge: 1073741824, bufferedStart: 0, bufferedEnd: 19.2 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 30, lat: 3 }));
    await settle(20);
    page.bypass({ type: 'ad-end' });
    await settle(3000);
    const rec = page.logsOf('native-recover').pop();
    check('RED: with the pre-fix threshold the element is left parked', () => {
      assert(page.logsOf('native-nudge').length === 0, 'the mutant moved the clock, so it is not measuring the threshold');
      assert(!!rec && rec.d.nudged === false,
        `the mutant nudged too (${JSON.stringify(rec && rec.d)}): this arm is not measuring the threshold`);
    });
  }

  // ---- 12b. A HOLD WHOSE POD NEVER ARRIVED STILL OWES HIM THE PLAYER ------
  // His 2026-11-15 report: "tela piscou preta sem anuncio, ai a live pausou e
  // tive q despausar". The hold pauses the native the moment the ad UI shows;
  // when the pod's own lifecycle never starts (the mint failed, or the ad UI
  // was the only signal), the cold-cover bound is the ONLY exit - and it used
  // to return through the frame-less branch without resuming, because that
  // branch was written when nothing had paused the element yet.
  {
    const page = makeWorld();
    setNative(page, { ct: 300, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold', channel: 'rodil' });
    await settle(20);
    check('the hold pauses the native before any frame exists', () => {
      assert(page.video.paused === true, 'the hold never paused the element: this arm measures nothing');
    });
    // Past COLD_COVER_BOUND_MS with no clean picture available.
    await new Promise((r) => setTimeout(r, 3200));
    check('a hold whose pod never arrived hands the player back playing', () => {
      assert(page.video.paused === false,
        'the native was left paused with no ad and no clean player: "a live pausou e tive q despausar"');
      assert((page.video.plays || 0) >= 1, 'play() was never called on the held element');
    });
  }
  // RED: the pre-fix frame-less exit leaves the element paused.
  {
    const blind = mutate([
      ["      try {\n        const nv = mainVideo();\n        if (!revealedAd && nv && nv.isConnected && nv.paused && !resumeRefusedByUser(nv)) {\n          resumeNative(nv, 'no-frame-exit');\n          armNativeRecovery(nv, 'no-frame-exit');\n        }\n      } catch { /* ignore */ }",
       "      try { const nv = mainVideo(); void nv; } catch { /* ignore */ }"],
    ]);
    const page = makeWorld({ adSource: blind });
    setNative(page, { ct: 300, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold', channel: 'rodil' });
    await new Promise((r) => setTimeout(r, 3200));
    check('RED: without the frame-less resume the held native stays paused', () => {
      assert(page.video.paused === true, 'the mutant resumed the element: this arm is not measuring the exit');
    });
  }

  // ---- 13. A HAND-BACK THAT LANDS AT THE EDGE STILL HAS NO RUNWAY ---------
  // His 0.8.92 ring 2026-11-15, the exact row: `native-handoff {ct:4771.9,
  // buf:4774.1}` — the element came back ON the newest frame Twitch had, 2.2 s
  // in front of the playhead, reported rs:4 `native-resume`, and drained to
  // rs:1 within 1.5 s. `play()` needs HAVE_FUTURE_DATA (3 s here), so the
  // hand-back owes the element that runway before it calls play.
  //
  // The edge is the sentinel, because that is what his element reported: no
  // forward seek can rescue it, so the nudge inside the buffer is the only
  // recovery in the code path.
  async function handBackAt(ct, bufEnd, { paused = false } = {}) {
    const page = makeWorld();
    setNative(page, { ct, edge: 1073741824, bufferedStart: 0, bufferedEnd: bufEnd, paused });
    await pod(page);
    page.bypass({ type: 'ad-end' });
    await settle(60);
    return page;
  }
  {
    const page = await handBackAt(4771.9, 4774.1);
    check('a hand-back with 2.2s of runway is moved back to the health gate, not left to drain', () => {
      const moved = page.seeks().length ? page.seeks() : [page.video.currentTime];
      assert(page.video.currentTime < 4771.9,
        `ct=${page.video.currentTime}: the element was handed back at the frontier it cannot play forward from`);
      // The source's own constant, quoted as the number it is (3 s): a test
      // that reads the product constant would pass if the product changed it.
      assert(4774.1 - page.video.currentTime >= 2.95,
        `runway ${(4774.1 - page.video.currentTime).toFixed(2)}s < 3s`);
    });
  }
  {
    // ...and an element that ALREADY has the runway is not touched: the rule is
    // about starvation, not about always rewinding.
    const page = await handBackAt(4771.9, 4780);
    check('a hand-back that already holds the runway is left exactly where it is', () => {
      const moved = page.logsOf('native-recover').filter((r) => r.d && r.d.nudged === true);
      assert(moved.length === 0, `nudged a healthy hand-back: ${JSON.stringify(moved.map((r) => r.d))}`);
    });
  }

  // ---- negative arms: the pre-fix code must fail every detector -----------
  const negatives = [
    ['overlay playback ownership', PRE_FIX_OWNER, async () => {
      const page = makePage(mutate(PRE_FIX_OWNER));
      page.docEl.setAttribute('data-ko-owner', 'kick');
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      page.bypass({ type: 'ad-hold' });
      page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
      await settle(30);
      return {
        caught: !!page.frame || page.logsOf('ad-skip').length === 0,
        detail: `frame=${!!page.frame} skips=${page.logsOf('ad-skip').length}`,
      };
    }],
    ['catch-up scope/threshold', PRE_FIX_CATCHUP, async () => {
      const page = makePage(mutate(PRE_FIX_CATCHUP));
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      await warmStandby(page, { pos: 100, lat: 12 });
      page.frameMsg(healthySt({ pos: 100, lat: 12 }));
      await settle(10);
      return { caught: page.seeks().length === 0, detail: `seeks=${JSON.stringify(page.seeks())}` };
    }],
    ['hand-off target', PRE_FIX_HANDOFF, async () => {
      const page = makePage(mutate(PRE_FIX_HANDOFF));
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      await pod(page);
      page.video.currentTime = 100;
      page.video.paused = true;
      page.bypass({ type: 'ad-end' });
      await settle(30);
      return {
        caught: Math.abs(page.video.currentTime - 397) > 1,
        detail: `ct=${page.video.currentTime} (target 397)`,
      };
    }],
    ['mute intent tracking', PRE_FIX_INTENT, async () => {
      const page = makeWorld({ adSource: mutate(PRE_FIX_INTENT) });
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400, muted: true });
      await pod(page);
      page.userSetsNative(false);
      await settle(5);
      return {
        caught: !page.muteSent().includes(false) || page.logsOf('mute-intent').length === 0,
        detail: `muteSent=${JSON.stringify(page.muteSent())} intents=${page.logsOf('mute-intent').length}`,
      };
    }],
    ['resume guard', PRE_FIX_RESUME, async () => {
      const page = makeWorld({ adSource: mutate(PRE_FIX_RESUME) });
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      await pod(page);
      page.document.visibilityState = 'hidden';
      page.document.hidden = true;
      page.video.currentTime = 100;
      page.video.paused = true;
      page.bypass({ type: 'ad-end' });
      await settle(80);
      return {
        caught: page.video.paused === false || (page.video.plays || 0) > 0,
        detail: `paused=${page.video.paused} plays=${page.video.plays || 0}`,
      };
    }],
    ['frame ready gate', PRE_FIX_POST_EARLY, async () => {
      const page = makePage(mutate(PRE_FIX_POST_EARLY), { autoLoad: false });
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      page.bypass({ type: 'ad-hold' });
      page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
      await settle(20);
      page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8?2', channel: 'rodil' });
      await settle(10);
      return {
        caught: page.sent.length > 0,
        detail: `pre-load posts=${JSON.stringify(page.sent)}`,
      };
    }],
    ['sentinel edge', PRE_FIX_SENTINEL, async () => {
      const page = makePage(mutate(PRE_FIX_SENTINEL));
      setNative(page, { ct: 30, edge: 40, bufferedEnd: 40 });
      page.video.seekable = { length: 1, start: () => 0, end: () => 1073741824 };
      page.video.duration = Infinity;
      await pod(page);
      page.video.currentTime = 30;
      page.video.paused = false;
      page.bypass({ type: 'ad-end' });
      await settle(30);
      return {
        caught: page.video.currentTime > 1e6,
        detail: `ct=${page.video.currentTime} (the sentinel became a seek target)`,
      };
    }],
    ['cover deadline', PRE_FIX_COVER, async () => {
      const { page, covered } = await coldCoverArm(mutate(PRE_FIX_COVER), true);
      const fired = page.logsOf('cold-cover-timeout').length;
      return {
        caught: !covered || fired !== 1 || page.video.style.visibility === 'hidden',
        detail: `covered=${covered} timeouts=${fired} nativeVis=${page.video.style.visibility}`,
      };
    }],
    ['backward nudge', PRE_FIX_NUDGE, async () => {
      const page = makePage(mutate(PRE_FIX_NUDGE));
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      await pod(page, { pos: 100, lat: 4 });
      page.frameMsg(healthySt({ pos: 104, lat: 3, buffered: 0.2, rs: 2 }));
      await settle(2700);
      const backward = page.logsOf('overlay-nudge').filter((n) => n.d.to < n.d.pos);
      return { caught: backward.length > 0, detail: `nudges=${JSON.stringify(page.logsOf('overlay-nudge').map((n) => [n.d.pos, n.d.to]))}` };
    }],
    ['reveal health floor', PRE_FIX_HEALTH, async () => {
      const page = makePage(mutate(PRE_FIX_HEALTH));
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      await pod(page, { pos: 100, lat: 3 });
      for (let i = 0; i < 4; i++) {
        page.frameMsg(healthySt({ pos: 103 + i, lat: 3.6, buffered: 3.6, rs: 4 }));
        await settle(5);
      }
      const bad = page.logsOf('playing-not-healthy').length > 0
        || page.logsOf('overlay-nudge').length > 0
        || page.logsOf('overlay-stall-stop').length > 0;
      return { caught: bad, detail: `unhealthy=${page.logsOf('playing-not-healthy').length} nudges=${page.logsOf('overlay-nudge').length} stops=${page.logsOf('overlay-stall-stop').length}` };
    }],
    ['mute heartbeat', PRE_FIX_MUTE_SPAM, async () => {
      const page = makeWorld({ adSource: mutate(PRE_FIX_MUTE_SPAM) });
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400, muted: true });
      await pod(page);
      const before = page.muteSent().filter((m) => m === true).length;
      for (let i = 0; i < 5; i++) {
        page.frameMsg(healthySt({ pos: 100 + i, lat: 3 }));
        await settle(3);
      }
      const after = page.muteSent().filter((m) => m === true).length;
      return { caught: after - before > 1, detail: `re-sent mute ${after - before} times over 5 ticks` };
    }],
    ['stale standby', PRE_FIX_STANDBY_STALE, async () => {
      const page = makePage(mutate(PRE_FIX_STANDBY_STALE));
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
      await settle(20);
      page.frameMsg({ t: 'ready' });
      for (let i = 0; i < 12; i++) {
        page.frameMsg(healthySt({ state: 'Paused', paused: true, pos: 82, lat: 9, buffered: 8.5 }));
      }
      await settle(10);
      page.stats().adUiHoldTick();
      page.stats().adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
      await settle(10);
      const stale = page.logsOf('ad-ui-hold').filter((l) => l.d.act === 'standby-stale');
      return {
        caught: page.video.paused === false && !!page.frame && page.frame.removed !== true && stale.length === 0,
        detail: `paused=${page.video.paused} frame=${!!page.frame} staleRows=${stale.length}`,
      };
    }],
  ];
  for (const [label, pairs, run] of negatives) {
    let ok = true;
    try {
      mutate(pairs);
    } catch (error) {
      ok = false;
      check(`negative arm (${label}): the mutation applies`, () => {
        throw error;
      });
    }
    if (!ok) continue;
    const { caught, detail } = await run();
    check(`negative arm (${label}): the pre-fix behaviour is caught`, () => {
      assert(caught, `the detector accepted the pre-fix behaviour (${detail}) — it measures nothing`);
    });
  }

  // ---- the overlay player owns the picture: the ad path must stay out ------
  // Owner 2026-11-11: "por que ele troca de player dizendo sem anuncio - 360p
  // quando eu to no player da kick que NUNCA tem anuncio?" and, right after,
  // "o player vem, fica em tempo real, ai o player da twitch volta, e segundos
  // depois o outro player volta de novo, segundos atras ... e fica a 360p".
  {
    const page = makePage(SOURCE);
    page.docEl.setAttribute('data-ko-owner', 'kick');
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(30);
    check('a pod while the overlay player owns playback starts nothing', () => {
      assert(!page.frame, 'the ad path built a clean player on top of the kick layer');
      assert(page.logsOf('ad-skip').length === 1, `ad-skip was logged ${page.logsOf('ad-skip').length} time(s)`);
      assert(page.logsOf('overlay-reveal').length === 0, 'the ad path revealed its own picture');
      assert(page.video.muted === false, 'the ad path muted the native while the overlay was playing');
    });
  }

  // Owner 2026-11-11 (regression): *"depois de uns segundos, o anuncio volta,
  // mas o player volta tambem. ficam brigando, sendo que isso nao ocorria
  // antes."* The attribute flaps on a re-buffer, so a raw sample let the ad path
  // start a pod the moment the overlay stopped reporting a picture for one tick.
  // Once the overlay has owned the page, a pod needs OWNER_CLEAR_MS of silence.
  {
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      const page = makePage(SOURCE);
      setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
      page.docEl.setAttribute('data-ko-owner', 'kick');
      page.bypass({ type: 'ad-hold' });
      await settle(30);
      const skipsWhileOwner = page.logsOf('ad-skip').length;
      page.docEl.removeAttribute('data-ko-owner'); // the re-buffer sample
      page.bypass({ type: 'ad-hold' });
      page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
      await settle(40);
      check('a pod cannot start on a flapping owner attribute (no ad/player fight)', () => {
        assert(skipsWhileOwner === 1, `while owned: ad-skip was logged ${skipsWhileOwner} time(s)`);
        assert(!page.frame, 'the ad path built a clean player one tick after the owner attribute blinked');
        assert(page.logsOf('ad-skip').length === 2, `after the blink: ad-skip was logged ${page.logsOf('ad-skip').length} time(s)`);
      });
      skew += 4100; // past OWNER_CLEAR_MS: the overlay really did let go
      page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
      await settle(30);
      check('after the clear window the ad path protects the page again', () => {
        assert(!!page.frame, 'the ad path never resumed after the owner went away for good');
      });
    } finally {
      Date.now = realNow;
    }
  }

  // Mid-pod switch: the owner attribute appears while the cover is up -> gone.
  {
    const page = makePage(SOURCE);
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page);
    const before = !!(page.frame && !page.frame.removed);
    page.docEl.setAttribute('data-ko-owner', 'kick');
    await settle(30);
    check('switching to the overlay player mid-pod releases the cover in the same tick', () => {
      assert(before, 'precondition: the pod never built its player');
      assert(!page.frame || page.frame.removed, 'the clean player outlived the owner switch');
    });
  }

  // ---- 10d. a degenerate rect is not the frame's death (the hover guard) --
  // Owner report 2026-11-13: "ele da hide mesmo dando hover". Hovering the
  // player opens Twitch's floating preview (a second, tiny <video> that
  // `mainVideo()` picks as "largest" during a swap), a quality switch
  // re-creates the element, and a rebuilt player is briefly 0x0. The old tick
  // hid the frame on the FIRST `width < 40`, so the clean picture vanished from
  // a player that was on screen the whole time.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page);
    await settle(600); // one position tick with a real rect
    page.video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
    await settle(1200); // two degenerate ticks, well inside the grace
    check('a degenerate rect keeps the revealed frame on its last real geometry', () => {
      const f = page.frame;
      assert(f && !f.removed, 'the frame was torn down instead of kept');
      assert(f.style.display === 'block', `the frame was hidden on a degenerate rect (display=${f.style.display})`);
      assert(f.style.width === '1280px', `the frame lost its geometry: width=${f.style.width}`);
    });
    // A HOVER THAT LASTS is the report that was not covered: Twitch's floating
    // preview is up for as long as the user keeps pointing at the player, so a
    // fixed grace (4000 ms) still hid the picture from a mouse that never left.
    // Measured window here is 6000 ms, past the old constant.
    await settle(6000);
    check('a hover past the old grace window keeps the revealed frame on its last geometry', () => {
      const f = page.frame;
      assert(f && !f.removed, 'the frame was torn down during a long hover');
      assert(f.style.display === 'block', `the frame was hidden during a long hover (display=${f.style.display})`);
      assert(f.style.width === '1280px', `the frame lost its geometry during a long hover: width=${f.style.width}`);
    });
    // ...and a player that really left IS hidden, in one tick, with no timer.
    page.video.isConnected = false;
    await settle(700);
    check('a removed player hides the frame without waiting for a timer', () => {
      const f = page.frame;
      assert(f && f.style.display === 'none', `a removed player left the clean picture up (display=${f && f.style.display})`);
    });
    // RED: without the kept rect, the first degenerate tick hides the picture.
    const page2 = makeWorld({
      adSource: mutate([['    } else if (overlay.revealed && overlay.lastRect) {', '    } else if (false) {']]),
    });
    setNative(page2, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page2);
    await settle(600);
    page2.video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
    await settle(1200);
    check('RED: a reveal that trusts every rect hides the picture at the first 0x0 tick', () => {
      const f = page2.frame;
      assert(f && f.style.display === 'none', `the mutant kept the frame (display=${f && f.style.display}), so the arm above measures nothing`);
    });
  }

  // ---- 11b. a native that RELOADED during the pod needs no seek -----------
  // Measured in the guest Chrome 2026-11-15 on a live element (twitch.tv/rodil,
  // player=twitch): pausing a Twitch <video> for 22 s EMPTIES it and it reloads
  // from 0, i.e. at the live edge (`ct 211.8 buf 212.9` -> `ct 0 buf null rs 1`).
  // `holdCt` then names a timeline that no longer exists, so `behind` measures
  // the reload plus the pod - and his own ko.adlog 2026-11-13 shows the target
  // that arithmetic produced (`to:172` on a 42.4 s window) and the refusal it
  // earned. The hand-back must recognise the reset and NOT seek: the element is
  // already at the edge, and moving it is what hurt.
  {
    const page = makeWorld();
    setNative(page, { ct: 211.8, edge: 1073741824, bufferedEnd: 212.9 });
    await pod(page);
    // The reload: the element empties and comes back at the edge, well BEHIND
    // the position it held when the pod took over.
    page.video.currentTime = 0;
    // The reload finishes: measured in the guest, the element is back at rs 4 a
    // second after it reloads. A rs:1 element would be refused by the readiness
    // guard BEFORE the reset test, and both arms would measure nothing.
    page.video.buffered = { length: 1, start: () => 0, end: () => 12 };
    page.video.readyState = 4;
    await new Promise((r) => setTimeout(r, 3200));
    const writes = [];
    let clock = page.video.currentTime;
    Object.defineProperty(page.video, 'currentTime', {
      configurable: true,
      get: () => clock,
      set: (x) => {
        writes.push(+Number(x).toFixed(1));
        clock = x;
      },
    });
    page.bypass({ type: 'ad-end' });
    await settle(150);
    check('a native that reloaded during the pod is reported and never seeked', () => {
      const rows = page.logsOf('native-timeline-reset');
      assert(rows.length === 1, `native-timeline-reset rows: ${rows.length} (the reset was not recognised)`);
      assert(rows[0].d.holdCt === 211.8, `the row does not name the dead timeline: holdCt=${rows[0].d.holdCt}`);
      assert(writes.length === 0, `the reloaded native was seeked anyway: ${JSON.stringify(writes)}`);
      assert(page.logsOf('native-edge-recover').length === 0,
        'a recovery seek ran on a timeline that had already reset');
    });
  }
  {
    // RED: the pre-fix arithmetic, which reads the reset as a pod-sized deficit.
    const page = makeWorld({
      adSource: mutate([[
        '          } else if (advanced < -RESUME_GAP_SEC) {',
        '          } else if (false) {',
      ]]),
    });
    setNative(page, { ct: 211.8, edge: 1073741824, bufferedEnd: 212.9 });
    await pod(page);
    page.video.currentTime = 0;
    // The reload finishes: measured in the guest, the element is back at rs 4 a
    // second after it reloads. A rs:1 element would be refused by the readiness
    // guard BEFORE the reset test, and both arms would measure nothing.
    page.video.buffered = { length: 1, start: () => 0, end: () => 12 };
    page.video.readyState = 4;
    await new Promise((r) => setTimeout(r, 3200));
    page.bypass({ type: 'ad-end' });
    await settle(150);
    check('RED: without the reset guard the reload is read as a pod-sized deficit', () => {
      const rows = page.logsOf('native-timeline-reset');
      assert(rows.length === 0, 'the mutant still reported a reset, so the arm above measures nothing');
      const rec = page.logsOf('native-edge-recover');
      assert(rec.length === 1, `the mutant did not seek (${rec.length} rows), so the arm above measures nothing`);
      assert(rec[0].d.behind > 200,
        `the mutant's deficit ${rec[0].d.behind} does not describe the reload-plus-pod the defect reports`);
    });
  }

  // ---- 11b-2. HIDDEN TAB + DVR OFFSET: never snap to the live edge --------
  // Owner ring ms 723133: `native-resume-visible {ct:314.3, tag:"ad-end"}` ->
  // `native-edge-unusable {from:314.3, rs:2}` ->
  // `native-edge-recover {behind:611.7, from:314.3, to:922.9}` -> the native
  // landed at the live edge instead of his DVR position. The hidden-tab gap
  // was counted as element freeze, and the take-over was behind the edge.
  function trackSeeks(page) {
    const writes = [];
    let ct = page.video.currentTime;
    Object.defineProperty(page.video, 'currentTime', {
      configurable: true,
      get: () => ct,
      set: (x) => { writes.push(+Number(x).toFixed(1)); ct = x; },
    });
    return writes;
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 314.3, edge: 922.9, bufferedEnd: 922.9 });
    await pod(page, { pos: 100, lat: 3 });
    await settle(30);
    const api = page.stats();
    const clock = api.adTestClock();
    assert(clock.userDvr === true, `the take-over offset was not classified as DVR: ${JSON.stringify(clock)}`);
    page.document.visibilityState = 'hidden';
    page.document.hidden = true;
    page.document.fire({ type: 'visibilitychange' });
    await settle(10);
    assert(api.adTestClock().hiddenAt > 0, 'hiddenAt was not stamped on the hidden tab');
    page.showTab();
    await settle(5);
    assert(api.adTestClock().hiddenGapMs > 0 && api.adTestClock().hiddenAt === 0,
      `the hidden gap was not accounted for: ${JSON.stringify(api.adTestClock())}`);
    // The measured 12 s gap, injected so the arm is exact and fast.
    api.adTestClock({ hiddenGapMs: 12000 });
    const writes = trackSeeks(page);
    page.bypass({ type: 'ad-end' });
    await settle(80);
    check('a hidden-tab gap never becomes a recovery seek to the live edge', () => {
      assert(page.logsOf('native-edge-recover').length === 0,
        `recovery fired on a hidden-tab gap: ${JSON.stringify(page.logsOf('native-edge-recover')[0] && page.logsOf('native-edge-recover')[0].d)}`);
      assert(writes.every((w) => w < 500), `the native was snapped to live: ${JSON.stringify(writes)}`);
      assert(page.logsOf('native-seek-declined').some((l) => l.d.why === 'hidden-tab'),
        'the declined seek was not named in the ring');
    });
  }
  {
    const blind = mutate([
      ['        const elapsed = overlay.holdAt\n          ? Math.max(0, (Date.now() - overlay.holdAt - hiddenMs) / 1000)\n          : 0;',
        '        const elapsed = overlay.holdAt\n          ? Math.max(0, (Date.now() - overlay.holdAt) / 1000)\n          : 0;'],
      ['        if (hiddenMs > 1000) {', '        if (false) {'],
      ['        overlay.userDvr = overlay.holdBehind > POD_RECOVER_MIN && overlay.holdCt > POD_RECOVER_MIN;', '        overlay.userDvr = false;'],
      ['        if (target > want && hiddenMs <= 1000 && !overlay.userDvr) {', '        if (target > want) {'],
      ["          why = why ? 'edge-recover+catchup' : 'catchup';", "          why = 'edge-recover';"],
    ]);
    const page = makeWorld({ adSource: blind });
    setNative(page, { ct: 314.3, edge: 922.9, bufferedEnd: 922.9 });
    await pod(page, { pos: 100, lat: 3 });
    await settle(30);
    page.stats().adTestClock({ hiddenGapMs: 12000 });
    const writes = trackSeeks(page);
    page.bypass({ type: 'ad-end' });
    await settle(80);
    check('RED: the pre-fix recovery snaps the DVR player to the live edge', () => {
      const rec = page.logsOf('native-edge-recover');
      assert(rec.length === 1, `the mutant did not recover (${rec.length} rows): this arm measures nothing`);
      assert(rec[0].d.to > 900, `target ${rec[0].d.to} is not the live edge (922.9)`);
      assert(writes.some((w) => w > 900), `the native did not move to the edge: ${JSON.stringify(writes)}`);
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 314.3, edge: 922.9, bufferedEnd: 922.9 });
    await pod(page, { pos: 100, lat: 3 });
    await settle(30);
    page.stats().adTestClock({ holdAgeMs: 12000 }); // visible pod, no hidden gap
    const writes = trackSeeks(page);
    page.bypass({ type: 'ad-end' });
    await settle(80);
    check('a DVR offset is preserved as holdCt + elapsed, not the live edge', () => {
      const rec = page.logsOf('native-edge-recover');
      assert(rec.length === 1, `no recovery row: ${JSON.stringify(page.logsOf('native-catchup'))}`);
      assert(rec[0].d.why === 'user-dvr', `why=${JSON.stringify(rec[0].d.why)}`);
      assert(Math.abs(rec[0].d.to - 326.3) < 2, `to ${rec[0].d.to} is not holdCt(314.3) + elapsed(12)`);
      assert(writes.every((w) => w < 500), `the hand-back sought to live: ${JSON.stringify(writes)}`);
    });
  }
  {
    const blind = mutate([
      ['        overlay.userDvr = overlay.holdBehind > POD_RECOVER_MIN && overlay.holdCt > POD_RECOVER_MIN;', '        overlay.userDvr = false;'],
      ['        if (target > want && hiddenMs <= 1000 && !overlay.userDvr) {', '        if (target > want) {'],
      ["          why = why ? 'edge-recover+catchup' : 'catchup';", "          why = 'edge-recover';"],
      ['        if (overlay.userDvr && hiddenMs <= 1000 && elapsed > RESUME_GAP_SEC) {', '        if (false) {'],
    ]);
    const page = makeWorld({ adSource: blind });
    setNative(page, { ct: 314.3, edge: 922.9, bufferedEnd: 922.9 });
    await pod(page, { pos: 100, lat: 3 });
    await settle(30);
    page.stats().adTestClock({ holdAgeMs: 12000 });
    trackSeeks(page);
    page.bypass({ type: 'ad-end' });
    await settle(80);
    check('RED: without the DVR guard the hand-back seeks to the live edge', () => {
      const rec = page.logsOf('native-edge-recover');
      assert(rec.length === 1, `the mutant did not recover (${rec.length} rows): this arm measures nothing`);
      assert(rec[0].d.to > 900, `target ${rec[0].d.to} is not the live edge (922.9)`);
    });
  }

  // ---- 11c. a catch-up must never land on an empty buffer ----------------
  // The owner's own 0.8.91 ko.adlog 2026-11-15: `overlay-catchup {hold:6,
  // lat:18.8, pos:160, source:"standby"}`. The ceiling was `pos + hold - 1`, so
  // the seek landed with ONE second of media in hand, and the `|| frontierGap
  // >= 2` branch let a 12.8 s gap override exactly that starvation - the same
  // class the ceiling was introduced to prevent (2026-11-08, four for four
  // `overlay-stall-stop`).
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await warmStandby(page, { pos: 160, lat: 18.8, buffered: 6 });
    await settle(2200);
    const seeks = page.seeks();
    check('a catch-up lands with the health gate\'s runway, not on the buffer frontier', () => {
      assert(seeks.length >= 1, 'no catch-up seek was issued at all');
      const landed = seeks[seeks.length - 1];
      const moved = landed - 160;
      // 6 s held, 3 s must remain: the deepest legal landing is pos + 3.
      assert(moved <= 3.05, `the seek moved ${moved.toFixed(2)}s into a 6 s buffer, leaving ${(6 - moved).toFixed(2)}s`);
      assert(moved >= 1.5, `the seek moved only ${moved.toFixed(2)}s, below the seek threshold`);
    });
  }
  {
    // RED: the pre-fix ceiling, which left 1 s of runway.
    const page = makeWorld({
      adSource: mutate([[
        '    const ceiling = pos + hold - HEALTH_BUFFER_SEC;',
        '    const ceiling = pos + hold - 1;',
      ]]),
    });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await warmStandby(page, { pos: 160, lat: 18.8, buffered: 6 });
    await settle(2200);
    const seeks = page.seeks();
    check('RED: the pre-fix ceiling lands with a second of runway', () => {
      assert(seeks.length >= 1, 'the mutant issued no seek, so the arm above measures nothing');
      const moved = seeks[seeks.length - 1] - 160;
      assert(moved > 3.05, `the mutant moved only ${moved.toFixed(2)}s, so the arm above measures nothing`);
    });
  }


  // ---- A: standby lifecycle rows and lv/bw cost fields -------------------
  // The standby path must be answerable from the ring: request/url/frame/firstst/play
  // are transition-only rows, and playing-not-healthy/overlay-reveal carry lv/bw.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil', src: 'worker' });
    await settle(30);
    if (page.frame && typeof page.frame.fire === 'function') page.frame.fire({ type: 'load' });
    page.frameMsg({ t: 'ready' });
    page.frameMsg(healthySt({ pos: 100, lat: 3, buffered: 5, lv: 2, bw: 900000 }));
    page.frameMsg(healthySt({ pos: 101, lat: 3, buffered: 5, lv: 2, bw: 900000 }));
    await settle(30);
    check('A: standby lifecycle rows appear as transition-only events', () => {
      assert(page.logsOf('standby-url').length === 1, 'missing standby-url');
      assert(page.logsOf('standby-frame').length === 1, 'missing standby-frame');
      assert(page.logsOf('standby-firstst').length === 1, 'missing standby-firstst');
      assert(page.logsOf('standby-play').length === 1, 'missing standby-play');
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    // The reveal is produced from these samples, so they carry the cost fields:
    // the row must publish the quality the picture was actually shown at.
    await pod(page, { pos: 100, lat: 3, lv: 1, bw: 800000 });
    const rev = page.logsOf('overlay-reveal').pop();
    check('A: overlay-reveal carries lv and bw from frame st payload', () => {
      assert(rev, 'no overlay-reveal row');
      assert(rev.d.lv === 1, `lv ${JSON.stringify(rev.d.lv)}`);
      assert(rev.d.bw === 800000, `bw ${JSON.stringify(rev.d.bw)}`);
    });
  }
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page, { pos: 100, lat: 3 });
    // playing-not-healthy arm: unhealthy Playing report
    page.frameMsg({ t: 'st', st: { state: 'Playing', paused: false, muted: true, rs: 2, buffered: 0.5, pos: 102, lat: 12, dur: 0, q: { name: '360p' }, lv: 0, bw: 400000 } });
    await settle(30);
    const pnh = page.logsOf('playing-not-healthy').pop();
    check('A: playing-not-healthy carries lv and bw from frame st payload', () => {
      assert(pnh, 'no playing-not-healthy row');
      assert(pnh.d.lv === 0, `lv ${JSON.stringify(pnh.d.lv)}`);
      assert(pnh.d.bw === 400000, `bw ${JSON.stringify(pnh.d.bw)}`);
    });
    check('A: playing-not-healthy NAMES the gate that refused it', () => {
      assert(pnh.d.why === 'rs', `why ${JSON.stringify(pnh.d.why)} (rs:2 must be named 'rs')`);
    });
  }
  {
    // The replica's own refusal (dev-preroll-hold 1795677250450, 916 ms): rs=4,
    // 2.92 s buffered, and a playhead that advanced 0.07 s in 0.74 s. The gate
    // was RIGHT to wait; the row said `why:null`, so it could not say so.
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page, { pos: 100, lat: 3 });
    const st = (pos) => ({ t: 'st', st: { state: 'Playing', paused: false, muted: true, rs: 4, buffered: 2.92, pos, lat: 3, dur: 0, q: { name: '720p' }, lv: 2, bw: 1400000 } });
    page.frameMsg(st(25.01));
    await settle(740);
    page.frameMsg(st(25.08));
    await settle(30);
    const pnh = page.logsOf('playing-not-healthy').pop();
    check('A: a frame that advanced 0.07s in 0.74s is refused as advancing, with the movement', () => {
      assert(pnh, 'no playing-not-healthy row');
      assert(pnh.d.why === 'advancing', `why ${JSON.stringify(pnh.d.why)}`);
      assert(pnh.d.advanced === false && Math.abs(Number(pnh.d.moved) - 0.07) < 0.02, `moved ${JSON.stringify(pnh.d.moved)} advanced ${JSON.stringify(pnh.d.advanced)}`);
    });
  }
  {
    // RED: pre-fix standby-request had no why/delay shape; our fix logs it.
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.stats().requestStandby(0, false, 'test-why');
    await settle(20);
    const req = page.logsOf('standby-request').pop();
    check('A: standby-request carries why and delay', () => {
      assert(req, 'no standby-request row');
      assert(req.d.why === 'test-why', `why ${JSON.stringify(req.d.why)}`);
      assert(req.d.delay === 0, `delay ${JSON.stringify(req.d.delay)}`);
    });
  }
  {
    // RED: pre-fix playing-not-healthy had no lv/bw fields
    const old = mutate([[
      "              adLog('playing-not-healthy', { rs: m.st.rs, buffered: m.st.buffered, pos: m.st.pos, why: refuseWhy, advanced: advancing, moved: (overlay.prevSt && typeof overlay.prevSt.pos === 'number' && typeof m.st.pos === 'number') ? +(Number(m.st.pos) - Number(overlay.prevSt.pos)).toFixed(2) : null, lv: m.st.lv == null ? null : m.st.lv, bw: m.st.bw == null ? null : m.st.bw });",
      "              adLog('playing-not-healthy', { rs: m.st.rs, buffered: m.st.buffered, pos: m.st.pos });",
    ]]);
    const page = makeWorld({ adSource: old });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page, { pos: 100, lat: 3 });
    page.frameMsg({ t: 'st', st: { state: 'Playing', paused: false, muted: true, rs: 2, buffered: 0.5, pos: 102, lat: 12, dur: 0, q: { name: '360p' }, lv: 0, bw: 400000 } });
    await settle(30);
    const pnh = page.logsOf('playing-not-healthy').pop();
    check('A RED: pre-fix playing-not-healthy omits lv/bw', () => {
      assert(pnh, 'no playing-not-healthy row');
      assert(!('lv' in pnh.d) && !('bw' in pnh.d), `unexpected lv/bw ${JSON.stringify(pnh.d)}`);
    });
  }
  // ---- 15. THE AD IS NOT PLAYED UNDER THE POD ----------------------------
  // Owner report 2026-11-22, verbatim: "ele dessincroniza a live (nao deixa em
  // tempo real)". His own 0.8.111 ring has the mechanism as a row:
  // `ad-tick {video:{ct:260.5, paused:false, rs:4, muted:true}}` under a
  // REVEALED pod. `hideNativeVideos()` only sets `visibility:hidden`, so the
  // page kept playing the ad behind the clean picture: the pod consumed the
  // break in the background, the hand-back found 1.9-2.4 s of forward buffer
  // (`native-handoff {ct:290.6, buf:292.5}`) and parked at `rs=1`, which is the
  // freeze and the 21.56 s jump the verdict printed.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    // Twitch's own player resumes itself while the clean picture is buffering.
    // This is the measured state (his `ad-tick` row), not an invention: without
    // it the hold's own pause would make this arm pass with the fix removed.
    page.video.paused = false;
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3 }));
    await settle(10);
    check('a revealed pod freezes the native and names it', () => {
      assert(page.logsOf('overlay-reveal').length === 1, 'precondition: the pod never revealed');
      assert(page.video.paused === true, `the page kept playing the ad under the clean picture (paused=${page.video.paused})`);
      const row = page.logsOf('native-pod-freeze').pop();
      assert(!!row, `no native-pod-freeze row: ${JSON.stringify(page.logsOf('overlay-audio').pop() && page.logsOf('overlay-audio').pop().d)}`);
    });
    page.bypass({ type: 'ad-end' });
    await settle(60);
    check('...and the hand-back resumes the element it froze', () => {
      assert(page.video.paused === false, 'the native stayed frozen after the pod ended');
    });
  }
  // RED: the pre-fix reveal raised the frame and left the page playing.
  {
    const page = makeWorld({ adSource: mutate([['      const frozen = freezeNativeForPod();', '      const frozen = null;']]) });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    page.video.paused = false;
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3 }));
    await settle(10);
    check('RED: without the freeze the ad keeps playing behind the clean picture', () => {
      assert(page.logsOf('overlay-reveal').length === 1, 'precondition: the mutant never revealed');
      assert(page.video.paused === false,
        'the mutant froze it too: this arm is not measuring the freeze');
    });
  }

  // ---- 16. A REFUSAL BELONGS TO THE FRAME THAT WAS TESTED -----------------
  // His 0.8.111 ring: `overlay-audio {muted:true, refused:true}` at EVERY reveal
  // while the authority published `ad:-1.00` (audible). One autoplay refusal at
  // boot outlived its frame for the whole page load, so every later pod's clean
  // player was commanded muted, and the only thing that cleared it was an
  // unrelated click on the page - which unmuted the pod at a random moment
  // ("fica mutando e desmutando em hora errada").
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    // The retry window opens 2.5 s after the frame started.
    await settle(2600);
    page.frameMsg({ t: 'st', st: { state: 'Buffering', paused: true, muted: true, rs: 1, buffered: 0, pos: 0, lat: 0, dur: 0, q: { name: '360p' } } });
    await settle(10);
    check('a frame that cannot autoplay declares policy and mutes itself', () => {
      const row = page.logsOf('overlay-audio').pop();
      assert(row, 'no overlay-audio row at all');
      assert(row.d.refused === true && row.d.muted === true,
        `the refusal was not declared: ${JSON.stringify(row.d)}`);
    });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3 }));
    await settle(10);
    check('the reveal clears the refusal: a playing frame is audible', () => {
      assert(page.logsOf('overlay-reveal').length === 1, 'precondition: the pod never revealed');
      const row = page.logsOf('overlay-audio').pop();
      assert(!!row, 'the reveal commanded nothing');
      assert(row.d.muted === false && row.d.refused === false,
        `revealed a frame muted by a stale refusal: ${JSON.stringify(row.d)}`);
      const last = page.muteSent().slice(-1)[0];
      assert(last === false, `last mute command to the clean frame was ${JSON.stringify(page.muteSent())}`);
    });
  }
  // RED: keeping the refusal across the frame is exactly his ring row.
  {
    const page = makeWorld({
      adSource: mutate([[
        '      overlay.audioRefused = false;\n      overlay.unmuteTried = false;\n      overlay.unmuteTries = 0;',
        '      overlay.unmuteTried = false;\n      overlay.unmuteTries = 0;',
      ]]),
    });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    await settle(2600);
    page.frameMsg({ t: 'st', st: { state: 'Buffering', paused: true, muted: true, rs: 1, buffered: 0, pos: 0, lat: 0, dur: 0, q: { name: '360p' } } });
    await settle(10);
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 100, lat: 3 }));
    await settle(10);
    check('RED: a sticky refusal reveals the clean player muted', () => {
      assert(page.logsOf('overlay-reveal').length === 1, 'precondition: the mutant never revealed');
      const row = page.logsOf('overlay-audio').pop();
      assert(row && row.d.muted === true && row.d.refused === true,
        `the mutant cleared the refusal too: ${JSON.stringify(row && row.d)}`);
    });
  }

  // ---- 17. A PLAYLIST POD MUST NOT UNDO A USER RESUME --------------------
  // `ad-hold` opens this pod with no DOM ad, so `adUiHeldAt` is never stamped.
  // The shipped play handler returned at that guard, the freeze stamp stayed
  // set, and the next real 500 ms tick paused the element the user resumed.
  const playlistResumeRed = mutate([[
    "      const pod = adUiHeldAt ? 'hold' : (overlay.adActive || overlay.revealed ? 'playlist' : null);",
    "      if (!adUiHeldAt || userResumedHeld()) return;\n      const pod = null;",
  ]]);
  async function playlistResumeArm(src) {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    await settle(10);
    assert(page.video.paused === true, 'precondition: ad-hold did not pause the native');
    assert(page.stats().adUiHeldAt() === 0, 'precondition: a DOM hold was stamped');
    page.document.fire({ type: 'pointerdown' }); // a fresh gesture, not a machine play
    page.video.play();
    page.document.fire({ type: 'play', target: page.video }); // the REAL play listener
    await settle(600); // at least one real 500 ms tick body
    assert(page.video.paused === false,
      `the pod's next tick re-paused the user resume (paused=${page.video.paused})`);
    const rows = page.logsOf('ad-ui-hold').filter((l) => l.d.act === 'user-resume');
    assert(rows.length === 1, `user-resume rows=${JSON.stringify(rows.map((r) => r.d))}`);
    assert(rows[0].d.pod === 'playlist', `pod=${JSON.stringify(rows[0].d.pod)}`);
  }
  await redArm('a playlist-pod user resume is re-paused by the next tick', playlistResumeRed, playlistResumeArm);
  await greenArm('a fresh user play releases a playlist pod and is not re-paused', () => playlistResumeArm(SOURCE));

  // ---- 18. A USER PAUSE DURING THE POD SURVIVES HAND-BACK ----------------
  // A real `pause` event (no gesture: the user used the control) after the
  // take-over is the user's decision. The four ad-end retries must not start
  // that element again; only a later fresh play clears the decision.
  const userPauseRed = mutate([[
    '    if (userPausedInPod || (overlay.pauseBeforeAd && !overlay.coldPreroll)) return true;',
    '    if (overlay.pauseBeforeAd && !overlay.coldPreroll) return true;',
  ]]);
  async function userPauseArm(src) {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page);
    await settle(300); // let OUR take-over pause stamp age out
    page.document.fire({ type: 'pointerdown' });
    page.video.play();
    page.document.fire({ type: 'play', target: page.video });
    await settle(10);
    page.video.pause();
    page.document.fire({ type: 'pause', target: page.video }); // the REAL pause listener
    await settle(10);
    assert(page.video.paused === true, 'precondition: the user pause did not park the element');
    const beforeEnd = page.logsOf('native-resume').length;
    page.bypass({ type: 'ad-end' });
    await settle(4300); // 300 / 1200 / 2500 / 4000 ms hand-back retries
    assert(page.video.paused === true,
      `hand-back resumed a player the user parked (paused=${page.video.paused})`);
    assert(page.logsOf('native-resume').length === beforeEnd,
      `a retry resumed the user-parked element: ${JSON.stringify(page.logsOf('native-resume').map((l) => l.d.tag))}`);
  }
  await redArm('a user pause during the pod is resumed at hand-back', userPauseRed, userPauseArm);
  await greenArm('a user pause during the pod stays paused across all four hand-back retries', () => userPauseArm(SOURCE));

  // ---- 19. native-handoff BELONGS TO A POD END ---------------------------
  const handoffRed = mutate([
    ['      const podEnd = !!overlay.holdAt && !overlay.nativeHandoffLogged;', '      const podEnd = !wasStandby;'],
    [
      '        overlay.holdAt = 0;\n        overlay.holdCt = 0;\n        overlay.nativeHandoffLogged = true;\n      }',
      '      }',
    ],
  ]);
  async function handoffArm(src) {
    const idle = makeWorld({ adSource: src });
    setNative(idle, { ct: 397, edge: 400, bufferedEnd: 400 });
    for (let i = 0; i < 3; i++) {
      // A frame without an `ad-hold` take-over: the standby-timeout / ad-only /
      // clean-stall shape that used to print a hand-back with no pod at all.
      idle.bypass({ type: 'ad-start', url: `https://clean.example/live${i}.m3u8`, channel: 'rodil', switch: true });
      await settle(15);
      idle.bypass({ type: 'ad-end' });
      await settle(15);
    }
    assert(idle.logsOf('native-handoff').length === 0,
      `no pod took over but ${idle.logsOf('native-handoff').length} hand-backs were logged`);
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page);
    page.bypass({ type: 'ad-end' });
    await settle(60);
    assert(page.logsOf('native-handoff').length === 1,
      `one real pod end logged ${page.logsOf('native-handoff').length} rows`);
    for (let i = 0; i < 3; i++) {
      // The real pod ended. These three teardowns have no NEW take-over, but
      // the old `holdAt` survived when no recovery seek consumed it.
      page.bypass({ type: 'ad-start', url: `https://clean.example/after${i}.m3u8`, channel: 'rodil', switch: true });
      await settle(15);
      page.bypass({ type: 'ad-end' });
      await settle(15);
    }
    assert(page.logsOf('native-handoff').length === 1,
      `stale take-over stamp logged ${page.logsOf('native-handoff').length} hand-backs`);
  }

  // ---- 11. THE WORKER'S PLAYLIST IS THE PAGE'S AD PATH ------------------
  // The replica's patched worker saw 14 ad-bearing playlists and the ring had
  // ZERO playlist-derived ad-hold rows: playlists are fetched inside the
  // player worker, so the page fetch hook never saw one. Drive the real
  // BroadcastChannel message and measure the pod it must open.
  const WORKER_AD = {
    type: 'playlist',
    url: 'https://video-edge-a.playlist.ttvnw.net/v1/playlist/live.m3u8?pt=popout',
    extinf: 7, adExtinf: 3, adOnly: false, hasStitched: true,
    adExtinfSamples: ['#EXTINF:2.000,', '#EXTINF:2.000,', '#EXTINF:4.000,'],
    changed: false,
  };
  const WORKER_CLEAN = { ...WORKER_AD, adExtinf: 0, adOnly: false, hasStitched: false, adExtinfSamples: [] };
  async function workerRouteArm(src) {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await warmStandby(page, { pos: 100, lat: 3, buffered: 8 });
    page.debug(WORKER_AD);
    await settle(20);
    assert(page.stats().adActive() === true, `the ad playlist did not open a pod: ${JSON.stringify(page.bypassPosts())}`);
    const posts = page.bypassPosts().filter((p) => p.type === 'ad-hold');
    assert(posts.length === 1, `expected one ad-hold post, got ${posts.length}`);
    const p = posts[0];
    assert(p.from === 'worker-playlist' && p.extinf === 7 && p.adExtinf === 3 && p.adOnly === false &&
      p.hasStitched === true && p.adSec === 8,
      `the playlist evidence did not ride the post: ${JSON.stringify(p)}`);
    const row = page.logsOf('bypass-msg').find((l) => l.d.type === 'ad-hold' && l.d.from === 'worker-playlist');
    assert(row && row.d.adSec === 8, `the ring row does not name the trigger: ${JSON.stringify(row && row.d)}`);
    const wr = page.logsOf('worker-playlist').pop();
    assert(wr && wr.d.adSec === 8, `worker-playlist row has no adSec: ${JSON.stringify(wr && wr.d)}`);
    page.debug(WORKER_CLEAN);
    page.debug(WORKER_CLEAN);
    await settle(60);
    assert(page.stats().adActive() === false, 'two clean playlists did not close the pod');
    assert(page.logsOf('native-handoff').length === 1,
      `the pod end wrote ${page.logsOf('native-handoff').length} hand-backs`);
  }
  const redWorkerRoute = mutate([[
    "        if (playlistBypassChannel) playlistBypassChannel.postMessage({\n          type: 'ad-hold',",
    "        if (false && playlistBypassChannel) playlistBypassChannel.postMessage({\n          type: 'ad-hold',",
  ]]);
  await redArm('RED: without the worker ad-hold post the ad playlist never opens a pod', redWorkerRoute, workerRouteArm);
  await greenArm('a real worker ad playlist posts ad-hold with evidence and a clean streak hands back', () => workerRouteArm(SOURCE));

  // ---- 11b. A COLD-COVER POD MUST ACCEPT ITS OWN CLEAN SOURCE -----------
  // Replica: the worker playlist arrived BEFORE the standby URL, and the
  // standby-start was refused by the pod it was meant to end (no frame, yet
  // `held`), so the ad played to the end under a cover that never painted.
  async function coldCoverStandbyArm(src) {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    page.debug(WORKER_AD); // no standby exists yet
    await settle(10);
    assert(page.stats().adActive() === true, 'the worker playlist did not open a pod');
    assert(page.logsOf('cold-cover').length === 1, 'no cold cover was taken');
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    assert(!!page.frame, 'the active pod refused the clean source it needs to end');
    assert(page.stats().adActive() === true, 'mounting the standby cleared the pod claim');
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 30, lat: 3, buffered: 8 }));
    await settle(20);
    assert(page.logsOf('overlay-reveal').length === 1,
      `the pod never showed its clean picture: ${JSON.stringify(page.logsOf('overlay-reveal'))}`);
  }
  const redColdStandby = mutate([[
    '        if ((overlay.held || overlay.adActive) && overlay.frame) return;',
    '        if (overlay.held || overlay.adActive) return;',
  ]]);
  await redArm('RED: a held cold pod refuses the standby that would cover it', redColdStandby, coldCoverStandbyArm);
  const redStandbyClaim = mutate([[
    '    overlay.adActive = standby ? overlay.adActive : true;',
    '    overlay.adActive = !standby;',
  ]]);
  await redArm('RED: mounting a standby clears the cold pod claim', redStandbyClaim, coldCoverStandbyArm);
  await greenArm('a cold-cover pod mounts its clean source and reveals it', () => coldCoverStandbyArm(SOURCE));

  // ---- 12. THE TICK MUST NOT CALL ITS OWN PAUSE A NATIVE PAUSE -----------
  // Replica ring, same millisecond: `ad-ui-hold {act:"paused"}` then
  // `{act:"skip", why:"native-paused"}`. The DOM tick runs adUiHold() then
  // adUiHoldTick(); the pause between them is ours.
  async function sameTickArm(src) {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    const api = page.stats();
    api.adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    await settle(5);
    api.adUiHoldTick();
    const rows = page.logsOf('ad-ui-hold');
    assert(rows.some((l) => l.d.act === 'paused'), 'the hold never wrote its pause');
    assert(!rows.some((l) => l.d.act === 'skip' && l.d.why === 'native-paused'),
      `the tick refused the pause it had just issued: ${JSON.stringify(rows.map((l) => l.d))}`);
    assert(page.video.paused === true, 'the hold did not keep the native frozen');
    // The same pause is still ours a second later (a cold cover at 285 ms was
    // re-detected at 3650 ms in the fixed replica run). Re-taking the hold must
    // refresh the attribution, not call the frozen native a refusal.
    api.adTestClock({ selfPauseAgeMs: 1000, clearHold: true });
    api.adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    api.adUiHoldTick();
    assert(page.logsOf('ad-ui-hold').some((l) => l.d.act === 'already-paused'),
      'the second hold did not see the paused element');
    assert(!page.logsOf('ad-ui-hold').some((l) => l.d.act === 'skip' && l.d.why === 'native-paused'),
      `an old pause of ours was called a native pause: ${JSON.stringify(page.logsOf('ad-ui-hold').map((l) => l.d))}`);
  }
  const redSameTick = mutate([[
    "      if (overlay.selfPausedAt && Date.now() - overlay.selfPausedAt <= AD_UI_OWN_PAUSE_MS) {\n        adLog('ad-ui-hold', { act: 'reassert', own: 'hold', ct: +Number(v.currentTime || 0).toFixed(1) });\n        return;\n      }\n      return adUiTickSkip('native-paused');",
    "      return adUiTickSkip('native-paused');",
  ]]);
  await redArm('RED: without the own-pause guard the same tick writes skip native-paused', redSameTick, sameTickArm);
  const redColdAttribution = mutate([[
    '      if (selfPausedRecently()) overlay.selfPausedAt = adUiHeldAt;\n',
    '',
  ]]);
  await redArm('RED: an old pause of ours is re-labelled native-paused on re-take', redColdAttribution, sameTickArm);
  await greenArm('a hold never reports its own pause as a native pause, even after a cold cover', () => sameTickArm(SOURCE));

  // ---- 13. A HOLD THAT EXPIRES HANDS BACK THE PICTURE -------------------
  // Replica: `native-resume {behind:15.6, ct:0.4}` while the mounted clean
  // frame was healthy at pos 22.8. `behind` was computed and never used.
  async function holdExpiryArm(src) {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    await warmStandby(page, { pos: 22.8, lat: 3.1, buffered: 8 });
    const api = page.stats();
    api.adUiHold({ kind: 'wrapper', w: 1280, h: 720 });
    api.adTestClock({ holdUiAgeMs: 12500 });
    api.adUiHoldTick();
    await settle(20);
    assert(page.logsOf('ad-ui-hold').some((l) => l.d.act === 'handed-to-clean'),
      `the expired hold did not hand back the clean picture: ${JSON.stringify(page.logsOf('ad-ui-hold').map((l) => l.d))}`);
    assert(api.adActive() === true && api.revealed() === true, 'the clean frame was not raised');
    assert(page.video.paused === true, 'the native was resumed onto the parked ad frame');
  }
  const redHoldExpiry = mutate([[
    `      if (v0 && v0.isConnected && !resumeRefusedByUser(v0)) {
        if (cleanFrameCanCover()) {
          revealOverlay('hold-expired');
          adLog('ad-ui-hold', { act: 'handed-to-clean', ct: ct0 });
        } else {
          resumeNative(v0, 'hold-expired');
        }
      }`,
    "      if (v0 && v0.isConnected && v0.paused) resumeNative(v0, 'hold-expired', { seek: false });",
  ]]);
  await redArm('RED: the pre-fix hold expiry resumes the parked ad frame', redHoldExpiry, holdExpiryArm);
  await greenArm('an expired hold reveals the healthy mounted clean player', () => holdExpiryArm(SOURCE));
  // ---- 14. THE REVEAL GATE MEASURES A DECODING FRAME, NOT A BUFFER SNAPSHOT
  // Owner ring 0.8.115: reveal 11.0 s after ad-hold, q:"360p", hold 2.86 at
  // rs=4 with latSrc "hls". The 3 s floor called that frame unhealthy on every
  // heartbeat although its position advanced at 1x. The replica's owner-shape
  // arm (KO_REPLICA_NO_INFLIGHT=1) reproduced it: hold 2.85/2.02, no reveal at
  // 4/9/13 s and the ad painted end to end. This arm feeds exactly that shape.
  async function drainedLiveArm(src) {
    const page = makePage(src);
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    page.frameMsg(healthySt({ pos: 37.1, lat: 3.3, buffered: 2.86 }));
    await settle(600);
    page.frameMsg(healthySt({ pos: 37.7, lat: 3.3, buffered: 2.86 }));
    await settle(20);
    assert(page.logsOf('overlay-reveal').length === 1,
      `a decoding frame at hold 2.86 was never revealed: ${JSON.stringify(page.logs().map((l) => l.ev))}`);
    assert(page.logsOf('playing-not-healthy').length === 0
      && page.logsOf('overlay-nudge').length === 0
      && page.logsOf('overlay-stall-stop').length === 0,
      `a decoding frame was treated as stalled: ${JSON.stringify(page.logsOf('playing-not-healthy').map((l) => l.d))}`);
  }
  const RED_DRAINED_GATE = mutate([[
    'const decoding = advancing !== false && forwardOk;',
    'const decoding = advancing !== false && forwardOk && buffered >= HEALTH_BUFFER_SEC;',
  ]]);
  await redArm('RED: the old 3 s buffer floor refuses a decoding frame at hold 2.86', RED_DRAINED_GATE, drainedLiveArm);
  await greenArm('a decoding frame at hold 2.86 is revealed on progress, not buffer size', () => drainedLiveArm(SOURCE));
  {
    // FALSIFIER of "the gate was simply removed": a stalled frame must still
    // be refused (replica row pos 15.95 twice, rs=2, 0.05 s in hand).
    const page = makePage(SOURCE);
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    page.frameMsg(healthySt({ pos: 15.95, lat: 0.57, buffered: 0.05, rs: 2 }));
    await settle(600);
    page.frameMsg(healthySt({ pos: 15.95, lat: 0.57, buffered: 0.05, rs: 2 }));
    await settle(20);
    check('a frozen rs=2 frame with 0.05 s in hand is still not revealed', () => {
      assert(page.logsOf('overlay-reveal').length === 0, 'a stalled frame was revealed');
      assert(page.logsOf('playing-not-healthy').length > 0, 'the stall was not logged');
    });
  }

  // ---- 15. THE WORKER CAN RE-ASK FOR A STANDBY AT INSTALL TIME -----------
  // The page's first cold-start posts predate the Worker hook, and
  // BroadcastChannel does not replay. The new worker-ready handshake makes
  // the first *effective* request happen at worker install, not at the first
  // master fetch (owner ring: 8135 ms standby-start after 1444 ms hook).
  async function workerReadyArm(src) {
    const page = makePage(src);
    await settle(20);
    page.bypass({ type: 'worker-ready' });
    await settle(20);
    const rows = page.logsOf('standby-request').filter((l) => l.d && l.d.why === 'worker-ready');
    assert(rows.length === 1,
      `worker-ready did not produce exactly one cold request: ${JSON.stringify(rows)}`);
    // The guard is still the old one: a held cold pod cannot be over-requested.
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.bypass({ type: 'ad-hold' });
    await settle(20);
    page.bypass({ type: 'worker-ready' });
    await settle(20);
    assert(page.logsOf('standby-request').filter((l) => l.d && l.d.why === 'worker-ready').length === 1,
      'worker-ready bypassed the held-pod guard');
  }
  const RED_NO_READY = mutate([[
    "if (msg.type === 'worker-ready') {",
    "if (msg.type === 'worker-ready-never') {",
  ]]);
  await redArm('RED: without the worker-ready handshake no cold request is re-asked', RED_NO_READY, workerReadyArm);
  await greenArm('a worker-ready message re-asks once, then respects a held pod', () => workerReadyArm(SOURCE));

  // ---- 13b. A POD END OWNS THE HAND-BACK OVER A LATE HOLD EXPIRY ---------
  // Owner ring 2026-11-25, one page load: ms 55784 `native-handoff
  // {ct:0.5, holdCt:0.5, podAgeMs:14853, se:1073741824}` (no seek), ms 56066
  // `ad-ui-hold {act:"release", why:"hold-expired", ct:0.5, paused:false}`,
  // ms 56068 `native-resume {tag:"hold-expired", ct:0.5, st.who.holdAt:0}`.
  // The pod end consumed the take-over stamp; 284 ms later the expired DOM
  // hold resumed the same element at the parked ad position, and the native
  // played the whole ad program from 0.5 to 49.6 s.
  async function podEndHoldExpiryArm(src) {
    const page = makeWorld({ adSource: src });
    setNative(page, { ct: 0.5, edge: 1073741824, bufferedEnd: 8.1 });
    const api = page.stats();
    // A hold that predates the pod end and is NOT yet expired when the pod
    // takes over (the slate hold in the ring). It survives the worker's
    // ad-end, which does not go through `adUiRelease(true)`.
    api.adTestClock({ holdUiAgeMs: 3000 });
    await pod(page);
    assert(page.logsOf('overlay-reveal').length === 1, 'precondition: the pod never revealed');
    assert(page.logsOf('native-handoff').length === 0, 'precondition: the pod handed back before the test did');
    // The owner had been away from the tab: the hand-back DECLINED the seek
    // (`hiddenMs > 1000`), consumed the stamp, and left the element at ct 0.5.
    api.adTestClock({ hiddenGapMs: 15000 });
    page.bypass({ type: 'ad-end' });
    await settle(60);
    assert(page.logsOf('native-handoff').length === 1,
      `precondition: the pod end wrote ${page.logsOf('native-handoff').length} hand-offs`);
    assert(page.logsOf('native-resume').filter((l) => l.d.tag === 'ad-end').length === 1,
      'precondition: the pod end did not hand the picture back');
    assert(page.logsOf('native-seek-declined').some((l) => l.d.why === 'hidden-tab'),
      'precondition: the pod hand-back seeked instead of declining the hidden-tab gap');
    assert(Math.abs(page.video.currentTime - 0.5) < 0.1,
      `precondition: the pod hand-back moved the ad element to ${page.video.currentTime}`);
    // 284 ms later the same hold runs out of budget and the DOM tick fires.
    await settle(284);
    api.adTestClock({ holdUiAgeMs: 12500 });
    api.adUiHoldTick();
    await settle(20);
    const late = page.logsOf('native-resume').filter((l) => l.d.tag === 'hold-expired').map((l) => ({
      tag: l.d.tag,
      ct: l.d.ct,
      holdAt: l.d.st && l.d.st.who && l.d.st.who.holdAt,
      holdCt: l.d.st && l.d.st.who && l.d.st.who.holdCt,
    }));
    assert(late.length === 0,
      `the expired hold resumed the element after the pod hand-back: ${JSON.stringify(late)}`);
    const named = page.logsOf('ad-ui-hold').filter((l) => l.d.act === 'skip' && l.d.why === 'pod-handoff-owns');
    assert(named.length === 1,
      `the refusal did not name its owner: ${JSON.stringify(page.logsOf('ad-ui-hold').map((l) => l.d))}`);
    assert(page.logsOf('overlay-reveal').length === 1,
      'the expired hold revived the clean frame after the pod ended');
    assert(page.logsOf('native-handoff').length === 1, 'a second hand-back was logged for one pod');
  }
  const redPodEndExpiry = mutate([[
    '      if (overlay.podHandoffAt) {',
    '      if (false && overlay.podHandoffAt) {',
  ]]);
  await redArm('hold expiry re-resumes the element the pod already handed back', redPodEndExpiry, podEndHoldExpiryArm);
  await greenArm('a pod-end hand-back owns the element over a late hold expiry', () => podEndHoldExpiryArm(SOURCE));

  // ---- 20. A POD OPENING MAY MINT AT ONCE --------------------------------
  // Replica: `ad-hold` 284 ms, first clean standby URL 5163 ms. The page's own
  // cold request arms the 4 s cooldown; the pod's first ask was then refused
  // as `standby-refused {why:'throttle'}` instead of minting its clean source.
  async function podStartMintArm(src, record = strictRecord) {
    const page = makePage(src);
    setNative(page, { ct: 0.4, edge: 16, bufferedEnd: 16 });
    const api = page.stats();
    api.requestStandby(0, true, 'visible'); // the page's own cold request
    await settle(15);
    const pageRows = page.logsOf('standby-request').filter((l) => l.d.why === 'visible');
    record('a page request seeds the throttle without a bypass', pageRows.length === 1 && pageRows[0].d.bypass == null,
      `expected one unmarked page request: ${JSON.stringify(page.logsOf('standby-request'))}`);
    api.requestStandby(0, true, 'ad-ui-hold'); // the pod opening
    await settle(15);
    const mint = page.logsOf('standby-request').filter((l) => l.d.why === 'ad-ui-hold');
    record('a pod opening is not throttled out of its mint', mint.length === 1 && mint[0].d.bypass === 'pod-start',
      `the pod did not mint with a bypass row: ${JSON.stringify(page.logsOf('standby-request'))}`);
    record('the pod start wrote no refusal', page.logsOf('standby-refused').length === 0,
      `a pod start was refused: ${JSON.stringify(page.logsOf('standby-refused'))}`);
    api.requestStandby(0, true, 'ad-ui-hold'); // a second ask in the SAME pod
    await settle(15);
    const refused = page.logsOf('standby-refused').filter((l) => l.d.why === 'throttle');
    record('a second bypass in the same pod is still throttled',
      page.logsOf('standby-request').filter((l) => l.d.why === 'ad-ui-hold').length === 1
        && refused.length === 1 && refused[0].d.ask === 'ad-ui-hold',
      `the same pod minted twice or named no refusal: ${JSON.stringify({ req: page.logsOf('standby-request'), refused })}`);
    api.requestStandby(0, true, 'stale-standby'); // every other caller keeps the guard
    await settle(15);
    record('standby-refused semantics are unchanged for other callers',
      page.logsOf('standby-request').length === 2 && api.standbyBypass().pod !== null,
      `a non-pod caller crossed the cooldown: ${JSON.stringify(page.logsOf('standby-request'))}`);
    page.bypass({ type: 'ad-hold' });
    await settle(20);
    page.bypass({ type: 'ad-end' });
    await settle(20);
    record('a pod end clears the spent bypass', api.standbyBypass().pod === null,
      `the bypass outlived its pod: ${JSON.stringify(api.standbyBypass())}`);
    api.requestStandby(0, true, 'ad-ui-hold'); // the next pod
    await settle(15);
    record('the next pod gets its own bypass', page.logsOf('standby-request').filter((l) => l.d.bypass === 'pod-start').length === 2,
      `the next pod did not mint: ${JSON.stringify(page.logsOf('standby-request'))}`);
  }
  const RED_POD_START = mutate([[
    '      if (throttled && !canBypass) {',
    '      if (throttled) {',
  ]]);
  await redArm('RED: a pod start is throttled out of its mint', RED_POD_START, (src) => podStartMintArm(src));
  await greenArm('a pod start is not throttled out of its mint', () => podStartMintArm(SOURCE, checkRecord));

  // ---- 21. ONE PROGRESSING SAMPLE IS A HEALTHY SAMPLE -------------------
  // The two-sample rule was written for a 2.86 s drain, not for a frame that
  // carries its own confirmation: a 0.5 s advance with a full landing runway
  // does not need a second heartbeat to be believed.
  async function progressingGateArm(src, record = strictRecord) {
    function pod() {
      const p = makePage(src);
      setNative(p, { ct: 397, edge: 400, bufferedEnd: 400 });
      p.bypass({ type: 'ad-hold' });
      p.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
      return p;
    }
    const moving = pod();
    await settle(20);
    moving.frameMsg({ t: 'ready' });
    // rs=2 is NOT healthy: it drains a second later. Only the second sample
    // is healthy, and it is the one carrying the progress evidence.
    moving.frameMsg(healthySt({ pos: 30, lat: 3, buffered: 8, rs: 2 }));
    await settle(20);
    moving.frameMsg(healthySt({ pos: 30.5, lat: 3, buffered: 8, rs: 4 }));
    await settle(20);
    record('one progressing sample reveals on a dense heartbeat', moving.logsOf('overlay-reveal').length === 1,
      `the progressing sample did not reveal: ${JSON.stringify(moving.logsOf('overlay-reveal'))}`);

    const stalled = pod();
    await settle(20);
    stalled.frameMsg({ t: 'ready' });
    stalled.frameMsg(healthySt({ pos: 15.95, lat: 0.57, buffered: 0.05, rs: 2 }));
    await settle(600);
    stalled.frameMsg(healthySt({ pos: 15.95, lat: 0.57, buffered: 0.05, rs: 2 }));
    await settle(20);
    record('a stalled sample still needs two dense heartbeats',
      stalled.logsOf('overlay-reveal').length === 0 && stalled.logsOf('playing-not-healthy').length > 0,
      `a frozen frame was revealed: ${JSON.stringify(stalled.logsOf('overlay-reveal'))}`);

    const sparse = pod();
    await settle(20);
    sparse.frameMsg({ t: 'ready' });
    sparse.frameMsg(healthySt({ pos: 30, lat: 3, buffered: 1, rs: 2 }));
    await settle(1600); // > 1500 ms: progress is NOT the reason this reveals
    sparse.frameMsg(healthySt({ pos: 31.6, lat: 3, buffered: 1, rs: 4 }));
    await settle(20);
    record('a sparse heartbeat still reveals on one sample', sparse.logsOf('overlay-reveal').length === 1,
      `the sparse heartbeat lost its one-sample rule: ${JSON.stringify(sparse.logsOf('overlay-reveal'))}`);
  }
  const RED_PROGRESS = mutate([[
    'const need = (overlay.stGapMs || 0) > 1500 || progressed ? 1 : 2;',
    'const need = (overlay.stGapMs || 0) > 1500 ? 1 : 2;',
  ]]);
  await redArm('RED: a progressing sample needs a second confirmation again', RED_PROGRESS, (src) => progressingGateArm(src));
  await greenArm('one progressing sample reveals, a stalled one does not', () => progressingGateArm(SOURCE, checkRecord));

  // ---- 22. A USABLE EDGE CAN STILL BE THE POD'S OWN EXTENT ---------------
  // Replica dev-preroll-hold 1795665925912: ad-ui-release at 14509 ms,
  // native-handoff ct 0 / se 14 / buf 14 / podAge 14378, then four retries
  // `behind:27.6..33.4` with the picture inside the stitched ad at 20000 ms.
  // The buffer grows to 36 only AFTER the hand-back, which is where the one
  // recovery must land. The 14.3 s pod age is stamped through the existing
  // adTestClock seam instead of waiting 14 s of wall clock in this suite.
  async function podExtentEdgeArm(src, record = strictRecord) {
    const page = makePage(src);
    setNative(page, { ct: 0, edge: 14, bufferedEnd: 14 });
    await pod(page, { pos: 35.6, lat: 5.9 });
    page.stats().adTestClock({ holdAgeMs: 14300 });
    const seeks = trackSeeks(page);
    page.bypass({ type: 'ad-end' });
    await settle(40); // hand-back sees se 14 / buf 14, still inside the ad
    const handoff = page.logsOf('native-handoff').pop();
    record('the hand-back reports the pod extent and the wall clock',
      !!handoff && Math.abs(handoff.d.se - 14) < 0.1 && Math.abs(handoff.d.buf - 14) < 0.1
        && Math.abs(handoff.d.podAgeMs - 14300) < 500,
      `hand-back did not carry the reproduced numbers: ${JSON.stringify(handoff && handoff.d)}`);
    // Content is appended a moment later in the run: se/buffered go 14 -> 36.
    page.video.seekable = { length: 1, start: () => 0, end: () => 36 };
    page.video.buffered = { length: 1, start: () => 0, end: () => 36 };
    await settle(4400); // past all four resume retries
    const rec = page.logsOf('native-edge-recover');
    const evidence = JSON.stringify({
      recover: rec.map((l) => l.d),
      skips: page.logsOf('native-seek-skipped').map((l) => l.d),
      seeks,
      ct: page.video.currentTime,
      resume: page.logsOf('native-resume').map((l) => ({ tag: l.d.tag, ct: l.d.ct, behind: l.d.behind })),
    });
    // The hand-back now lands at `podExtent - HEALTH_BUFFER_SEC` (11) instead of
    // declining, so the retry measures its deficit from 11: `behind = 36 - 11 =
    // 25`, and the landing is `11 + 25 - cleanLat`. Both numbers moved with the
    // landing; the invariant the arm guards is unchanged - ONE wall recovery,
    // onto content past the pod.
    record('exactly one wall-clock recovery runs on the usable edge',
      rec.length === 1 && rec[0].d.basis === 'wall' && rec[0].d.why === 'edge-recover-retry'
        && Math.abs(rec[0].d.behind - 25) < 1.5 && rec[0].d.from >= 10,
      `expected one wall recovery on se 36 from the pod-end landing: ${evidence}`);
    record('the landing is on content inside the newly buffered range',
      rec.length === 1 && rec[0].d.to > 14 && rec[0].d.to <= 33
        && seeks.length === 2 && seeks[0] > 10 && seeks[0] < 14 && seeks[1] === rec[0].d.to
        && page.video.currentTime > 14,
      `the picture stayed in the ad media or moved more than once: ${evidence}`);
  }
  const RED_POD_EXTENT = mutate([
    [
      '        if ((se <= 0 || podExtentEdge) && overlay.holdAt) {',
      '        if (se <= 0 && overlay.holdAt) {',
    ],
    [
      '      if (!seek && se > 0 && !overlay.edgeRecovered && !overlay.timelineReset',
      '      if (false && !seek && se > 0 && !overlay.edgeRecovered && !overlay.timelineReset',
    ],
  ]);
  await redArm('RED: a usable edge at the pod extent suppresses recovery', RED_POD_EXTENT, (src) => podExtentEdgeArm(src));
  await greenArm('a pod-extent edge recovers once onto content after the buffer grows', () => podExtentEdgeArm(SOURCE, checkRecord));

  async function refusedPodExtentSeekArm(src, record = strictRecord) {
    const page = makePage(src);
    setNative(page, { ct: 0, edge: 14, bufferedEnd: 14 });
    await pod(page, { pos: 35.6, lat: 5.9 });
    page.stats().adTestClock({ holdAgeMs: 14300 });
    const seeks = trackSeeks(page);
    page.bypass({ type: 'ad-end' });
    await settle(80);
    const skips = page.logsOf('native-seek-skipped').filter((l) => l.d.why === 'inside-pod');
    const evidence = JSON.stringify({
      skips: page.logsOf('native-seek-skipped').map((l) => l.d),
      seeks,
      ct: page.video.currentTime,
      recover: page.logsOf('native-edge-recover').map((l) => l.d),
    });
    record('a refused pod-extent seek names from, to, buffered and why',
      skips.length === 1 && typeof skips[0].d.from === 'number'
        && typeof skips[0].d.to === 'number' && typeof skips[0].d.buffered === 'number'
        && skips[0].d.why === 'inside-pod'
        && Math.abs(skips[0].d.from) < 0.2 && Math.abs(skips[0].d.to - 8.4) < 0.3
        && Math.abs(skips[0].d.buffered - 14) < 0.2 && skips[0].d.rs === 4,
      `the refusal was silent or unnamed: ${evidence}`);
  }
  const RED_REFUSAL = mutate([[
    '            if (podExtentEdge && want <= se) {',
    '            if (false && podExtentEdge && want <= se) {',
  ]]);
  await redArm('RED: a refused pod-extent seek is silent', RED_REFUSAL, (src) => refusedPodExtentSeekArm(src));
  await greenArm('a refused pod-extent seek is logged with both numbers and a why', () => refusedPodExtentSeekArm(SOURCE, checkRecord));

  // ---- 22b. THE REFUSAL SURVIVES THE CATCH-UP ----------------------------
  // Measured in the replica on 0.8.118 (dev-preroll-hold 1795670018437, a PASS
  // run): the refusal named the media (`native-seek-skipped {why:'inside-pod',
  // to:7.3, podExtent:14}`) and the generic catch-up seeked to 7.3 anyway one
  // line later, then the retry watcher seeked again to 11. Two seeks, both
  // inside the pod, and the element landed 7 s of ad media back from the end of
  // what it already held. One landing, at the end of the pod, is the only one
  // this shape earns.
  async function podEndLandingArm(src, record = strictRecord) {
    const page = makePage(src);
    setNative(page, { ct: 0, edge: 14, bufferedEnd: 14 });
    await pod(page, { pos: 35.6, lat: 5.9 });
    page.stats().adTestClock({ holdAgeMs: 14300 });
    const seeks = trackSeeks(page);
    page.bypass({ type: 'ad-end' });
    await settle(120);
    const rows = page.logsOf('native-catchup').filter((l) => l.d.basis === 'pod-end');
    const evidence = JSON.stringify({
      seeks,
      catchup: page.logsOf('native-catchup').map((l) => l.d),
      skips: page.logsOf('native-seek-skipped').map((l) => l.d),
      ct: page.video.currentTime,
    });
    record('the pod-end hand-back seeks ONCE, to the end of the pod media it holds',
      rows.length === 1 && Math.abs(rows[0].d.to - 11) < 0.3
        && Math.abs(rows[0].d.podExtent - 14) < 0.2
        && seeks.length === 1 && Math.abs(page.video.currentTime - 11) < 0.3,
      `expected one landing at 11 with podExtent 14: ${evidence}`);
    record('the clean offset inside the pod is not taken by the catch-up',
      page.logsOf('native-catchup').filter((l) => l.d.basis === 'edge').length === 0,
      `a catch-up overrode the refusal: ${evidence}`);
  }
  // The landing itself is what this arm proves: with `podLand = from` the
  // hand-back is the pre-fix "no seek", which leaves the picture at the head of
  // the pod media and is what the generic catch-up used to move to 7.3.
  const RED_POD_END = mutate([[
    '              const podLand = se - HEALTH_BUFFER_SEC;',
    '              const podLand = from; // RED: pre-fix, the refusal landed nothing',
  ]]);
  await redArm('RED: the catch-up overrides a pod-end landing', RED_POD_END, (src) => podEndLandingArm(src));
  await greenArm('a pod-end landing is one seek, at the end of the pod media the element holds', () => podEndLandingArm(SOURCE, checkRecord));

  await prewarmArms();

  // ANTI-VACUITY. Every GREEN arm above prints its own label; one deleted or
  // skipped without its label must fail the suite, not quietly shorten it.
  const ARMS = [
    'a fresh user play releases a playlist pod and is not re-paused',
    'a user pause during the pod stays paused across all four hand-back retries',
    'a real worker ad playlist posts ad-hold with evidence and a clean streak hands back',
    'a cold-cover pod mounts its clean source and reveals it',
    'a hold never reports its own pause as a native pause, even after a cold cover',
    'an expired hold reveals the healthy mounted clean player',
    'a decoding frame at hold 2.86 is revealed on progress, not buffer size',
    'a worker-ready message re-asks once, then respects a held pod',
    'a pod-end hand-back owns the element over a late hold expiry',
    'a pod start is not throttled out of its mint',
    'one progressing sample reveals, a stalled one does not',
    'a pod-extent edge recovers once onto content after the buffer grows',
    'a refused pod-extent seek is logged with both numbers and a why',
    'a pod-end landing is one seek, at the end of the pod media the element holds',
    'a pre-warmed source is consumed by the first pod without a second mint',
    'a forced ask beside an in-flight warm parks and is served by the resolve',
    'a warm stuck in flight past a mint does not park the pod',
    'a timed-out warm flushes its parked ask instead of dropping it',
    'a failed pre-warm is not a precondition: the hold falls back to a mint and reveals',
    'a hand-back onto a native without HAVE_FUTURE_DATA keeps the picture on screen',
    'a native that never recovers is handed back at the ceiling, not held forever',
    'a new pod during the hand-back wait cancels it and keeps a picture up',
    'one blind cover sample does not end the hand-back wait',
    'a user play during the hand-back wait ends it with its reason',
  ];
  const printed = armLog.map((l) => String(l).trim());
  const missing = ARMS.filter((a) => !printed.includes(a));
  assert(missing.length === 0, `arms that never printed their PASS line: ${missing.join(', ')}`);
  console.log(`ARMS ${ARMS.length - missing.length}/${ARMS.length} present`);
  const failed = checks.filter((c) => c.status === 'FAIL');
  console.log('');
  console.log(`RESULT ${failed.length ? 'FAIL' : 'PASS'} ad-time-continuity checks=${checks.length} failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\nRESULT FAIL', error && error.message ? error.message : error);
    process.exit(1);
  });
}
