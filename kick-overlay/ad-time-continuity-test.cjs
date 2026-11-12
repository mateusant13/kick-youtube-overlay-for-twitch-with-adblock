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
  "if ((overlay.adActive || overlay.standby) && typeof m.st.lat === 'number') catchUpClean(m.st);",
  "if (overlay.adActive && typeof m.st.lat === 'number' && m.st.lat > 20) catchUpClean(m.st);",
]];
// 2. hand-off seeked to the buffered end - 0.5 (a free jump, never aligned).
const PRE_FIX_HANDOFF = [[
  'const target = se > 0 ? Math.max(0, se - cleanHandoffLat()) : Math.max(0, nativeBufferedEnd(v) - 0.5);',
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
function setNative(page, { ct, edge, bufferedEnd, paused = false, muted = false }) {
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
  v.buffered = { length: 1, start: () => Math.max(0, edge - 3600), end: () => bufferedEnd };
  return v;
}

// Warm standby: minted hidden, healthy, at `lat` seconds behind the edge.
async function warmStandby(page, { pos, lat }) {
  page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
  await settle(20);
  page.frameMsg({ t: 'ready' });
  page.frameMsg(healthySt({ pos, lat }));
  page.frameMsg(healthySt({ pos, lat }));
  page.frameMsg(healthySt({ pos, lat }));
  await settle(10);
}

// A full pod: ad-hold -> ad-start -> healthy Playing ticks -> reveal.
async function pod(page, { pos = 100, lat = 3 } = {}) {
  page.bypass({ type: 'ad-hold' });
  page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
  await settle(20);
  page.frameMsg({ t: 'ready' });
  page.frameMsg(healthySt({ pos, lat }));
  page.frameMsg(healthySt({ pos, lat }));
  page.frameMsg(healthySt({ pos, lat }));
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
      assert(page.frame.style.opacity === '1', 'the standby was not revealed');
      const seeks = page.seeks();
      assert(seeks.length >= 1, `revealed without a catch-up seek: ${JSON.stringify(page.sent)}`);
      assert(Math.abs(seeks[0] - (200 + 6 - 3)) < 0.6, `seek target ${seeks[0]} != edge-3 (203)`);
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
    setNative(page, { ct: 100, edge: 1073741824, bufferedEnd: 101 });
    await pod(page);
    // the native is frozen for the pod: real time passes, currentTime does not
    await new Promise((r) => setTimeout(r, 2100));
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('a frozen native with an unusable edge is seeked forward by the time it missed', () => {
      const v = page.video;
      const rec = page.logsOf('native-edge-recover');
      assert(rec.length === 1, `expected one recovery seek, got ${rec.length}`);
      const behind = rec[0].d.behind;
      assert(behind > 1.5, `logged deficit ${behind} is below the seek threshold`);
      assert(v.currentTime > 101, `currentTime ${v.currentTime} was not moved forward`);
      assert(Math.abs(v.currentTime - (100 + behind)) < 0.6, `currentTime ${v.currentTime} != ${100 + behind}`);
    });
  }
  {
    // RED: the pre-fix hand-back, with the wall-clock recovery removed.
    const mutated = mutate([[
      "      if (se <= 0 && overlay.holdAt) {",
      "      if (false && se <= 0 && overlay.holdAt) {",
    ]]);
    const page = makeWorld(mutated);
    setNative(page, { ct: 100, edge: 1073741824, bufferedEnd: 101 });
    await pod(page);
    await new Promise((r) => setTimeout(r, 2100));
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('RED: without the wall-clock recovery the delayed native stays delayed', () => {
      assert(page.video.currentTime < 102,
        `the mutated hand-back recovered to ${page.video.currentTime}, so the arm above measures nothing`);
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
    // The same element, but the pod parked it far behind: the fallback must be
    // the newest BUFFERED frame, never a computed position.
    setNative(page, { ct: 100, edge: 40, bufferedEnd: 400 });
    page.video.seekable = { length: 1, start: () => 0, end: () => 1073741824 };
    page.video.duration = Infinity;
    await pod(page);
    page.video.currentTime = 100;
    page.bypass({ type: 'ad-end' });
    await settle(30);
    check('with no usable edge the hand-back lands inside buffered data', () => {
      const v = page.video;
      const logs = page.logsOf('native-catchup');
      assert(logs.length === 1, `expected one catch-up seek, got ${logs.length}`);
      assert(logs[0].d.edge === 'buffered', `edge source=${logs[0].d.edge}`);
      assert(v.currentTime === 399.5, `currentTime ${v.currentTime} != bufferedEnd-0.5`);
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
    // all: `behind = elapsed - advanced`, and his log shows `gap:2.6`.
    await new Promise((r) => setTimeout(r, 2100));
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
      adSource: mutate([['        const covered = seekCovered(v, want);', '        const covered = true;']]),
    });
    setNative(page, { ct: 468, edge: 1073741824, bufferedEnd: 468 });
    page.video.readyState = 1;
    await pod(page);
    await new Promise((r) => setTimeout(r, 2100));
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

  // ---- 10b. the hand-back is ONE seek, and the retries never seek --------
  // Owner report 2026-11-11, right after the pod: "it then came back to the
  // twitch player and flicked/glitched. showed a part of the livestream, then
  // advanced and returned". His ko.adlog has that literally: `native-edge-recover
  // to 554.8` and, one millisecond later, `native-catchup to 531.7` — two seeks
  // in opposite directions — then three more catchups of 13, 17 and 17 s from
  // the 300/1200/2500 ms retries.
  {
    const page = makeWorld();
    setNative(page, { ct: 100, edge: 1073741824, bufferedEnd: 101 });
    await pod(page);
    await new Promise((r) => setTimeout(r, 2100));
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
    // Mutation: the retries seek again (`if (seek)` -> `if (true)`), which is
    // the pre-fix shape of the hand-back.
    const page = makeWorld({ adSource: mutate([['      if (seek) {', '      if (true) {']]) });
    setNative(page, { ct: 100, edge: 1073741824, bufferedEnd: 101 });
    await pod(page);
    await new Promise((r) => setTimeout(r, 2100));
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
    check('a frame that reports itself muted during the swap is corrected at once', () => {
      const mm = page.logsOf('audio-mismatch');
      assert(mm.length >= 1, 'no mismatch was detected');
      assert(mm[0].d.phase === 'swap', `mismatch classified as ${mm[0].d.phase}`);
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
      assert(page.video.paused === false || page.logsOf('mute-intent').length >= 1, 'the unmute never reached the page');
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
