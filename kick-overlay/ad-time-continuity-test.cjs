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
]];
// 3. no continuous intent tracking: the frame is told a frozen "muted" instead
//    of the authority's state, so an unmute never reaches the clean player.
const PRE_FIX_INTENT = [[
  '    const a = audioState();\n    const muted = !!(a.muted || overlay.audioRefused);',
  '    const a = { volume: 1 };\n    const muted = true;',
]];
// 4. resume any paused native, in any visibility.
const PRE_FIX_RESUME = [[
  '    if (document.visibilityState && document.visibilityState !== \'visible\') return true;\n    if (overlay.pauseBeforeAd && !overlay.coldPreroll) return true;\n',
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
  ['const HEALTH_BUFFER_SEC = 3;', 'const HEALTH_BUFFER_SEC = 4;'],
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
function setNative(page, { ct, edge, bufferedEnd, bufferedStart, paused = false, muted = false }) {
  const v = page.video;
  v.currentTime = ct;
  v.paused = paused;
  v.readyState = 4;
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

async function main() {
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
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt({ pos: 36, lat: 9, buffered: 8.6 }));
    await settle(10);
    const before = page.seeks().length;
    for (let i = 0; i < 4; i++) {
      page.frameMsg(healthySt({ pos: 41 + i * 5, lat: 9, buffered: 8.6 }));
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
    // 2. the page calls play() again: one pause is not enough
    page.video.play();
    api.adUiHoldTick();
    await settle(5);
    check('the page taking the pause back is re-asserted, not accepted', () => {
      assert(page.video.paused === true, 'Twitch resumed the ad and the hold gave up');
    });
    // 3. the ad ends with no pod ever starting: the player comes back by itself
    api.adUiRelease();
    await settle(30);
    check('an ad with no clean source hands the player back on its own', () => {
      assert(page.video.paused === false, 'the hold left the player frozen after the ad');
      const r = page.logsOf('ad-ui-release').pop();
      assert(!!r, 'the release wrote no line');
      assert(r.d.act === 'resume', `act=${JSON.stringify(r.d.act)}`);
      assert(r.d.reasserts >= 1, `reasserts=${JSON.stringify(r.d.reasserts)} does not count the take-back`);
    });
  }
  // A banner or a squeezeback is not a playing ad: the hold must not cost the
  // user his picture there.
  {
    const page = makeWorld();
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    const api = page.stats();
    check('a small squeezeback does not pause the stream', () => {
      assert(api.adHoldWorthy({ kind: 'wrapper', w: 240, h: 135 }, page.video) === false,
        'a 240x135 squeezeback was judged a playing ad');
      assert(api.adHoldWorthy({ kind: 'wrapper', w: 1280, h: 720 }, page.video) === true,
        'a full-size wrapper was not judged a playing ad');
      assert(api.adHoldWorthy({ kind: 'aria', label: 'Anúncio (0:12)' }, page.video) === true,
        'the countdown label was not judged a playing ad');
    });
    api.adUiHold({ kind: 'wrapper', w: 240, h: 135 });
    await settle(5);
    check('the squeezeback hold is a no-op in effect', () => {
      assert(page.video.paused === false, 'the squeezeback paused the picture');
    });
  }
  // 4. RED: without the area/label gate every wrapper is an ad.
  {
    const blind = mutate([["      return detail.w * detail.h >= 0.5 * r.width * r.height;", "      return true;"]]);
    const page = makeWorld({ adSource: blind });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    page.stats().adUiHold({ kind: 'wrapper', w: 240, h: 135 });
    await settle(5);
    check('RED: a wrapper-only gate pauses the stream on a squeezeback', () => {
      assert(page.video.paused === true,
        'the mutant refused the squeezeback too: this arm is not measuring the gate');
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
      const src = fs.readFileSync('twitch-adblock.js', 'utf8');
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
      ["      try {\n        const nv = mainVideo();\n        if (nv && nv.isConnected && nv.paused && !resumeRefusedByUser(nv)) {\n          resumeNative(nv, 'no-frame-exit');\n          armNativeRecovery(nv, 'no-frame-exit');\n        }\n      } catch { /* ignore */ }",
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
        '          if (advanced < -RESUME_GAP_SEC) {',
        '          if (false) {',
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
    page.frameMsg({ t: 'st', st: { state: 'Playing', paused: false, muted: true, rs: 4, buffered: 0.5, pos: 102, lat: 12, dur: 0, q: { name: '360p' }, lv: 0, bw: 400000 } });
    await settle(30);
    const pnh = page.logsOf('playing-not-healthy').pop();
    check('A: playing-not-healthy carries lv and bw from frame st payload', () => {
      assert(pnh, 'no playing-not-healthy row');
      assert(pnh.d.lv === 0, `lv ${JSON.stringify(pnh.d.lv)}`);
      assert(pnh.d.bw === 400000, `bw ${JSON.stringify(pnh.d.bw)}`);
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
      "              adLog('playing-not-healthy', { rs: m.st.rs, buffered: m.st.buffered, pos: m.st.pos, why: posFrozen ? 'pos-frozen' : null, lv: m.st.lv == null ? null : m.st.lv, bw: m.st.bw == null ? null : m.st.bw });",
      "              adLog('playing-not-healthy', { rs: m.st.rs, buffered: m.st.buffered, pos: m.st.pos, why: posFrozen ? 'pos-frozen' : null });",
    ]]);
    const page = makeWorld({ adSource: old });
    setNative(page, { ct: 397, edge: 400, bufferedEnd: 400 });
    await pod(page, { pos: 100, lat: 3 });
    page.frameMsg({ t: 'st', st: { state: 'Playing', paused: false, muted: true, rs: 4, buffered: 0.5, pos: 102, lat: 12, dur: 0, q: { name: '360p' }, lv: 0, bw: 400000 } });
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
