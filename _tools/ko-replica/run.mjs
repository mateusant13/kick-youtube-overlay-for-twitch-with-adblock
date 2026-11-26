#!/usr/bin/env node
// ko-replica runner — one command per scenario, end to end:
//
//   node _tools/ko-replica/run.mjs --scenario _tools/ko-replica/scenarios/dev-preroll.json
//
// It starts the HTTPS replica on a free port, launches the ISOLATED guest
// Chrome with the extension loaded and --host-resolver-rules pointing every
// Twitch host at the replica, runs the scenario timeline, samples the real
// page (element state + screenshots), reads the extension's own ko.adlog ring,
// and grades contract-derived expectations.
//
// Exit codes: 0 PASS, 1 FAIL, 2 CANNOT-MEASURE (the run never exercised the
// instrument; a green here would be a false green).
//
// --no-ext runs the same scenario WITHOUT the extension: the ad must then be
// visible (blue pixel), which is the harness's known-bad arm.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { connect } from '../ko-cdp.mjs';
import { inflateSync } from 'node:zlib';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = resolve(HERE, '../..');
const SCN = resolve(argOf('scenario', join(HERE, 'scenarios', 'dev-baseline.json')));
const OUT = argOf('out', '');
// A FIXED debug port is a shared resource: a leaked guest keeps it, the next
// Chrome then binds only `::1` (`bind()` refused on IPv4) and every later run
// reads "CDP never answered". Measured 2026-11-25, twice. The port is chosen
// free per run unless `--guest-port` names one.
const netMod = await import('node:net');
const freePort = () => new Promise((res, rej) => {
  const srv = netMod.createServer();
  srv.once('error', rej);
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => res(p));
  });
});
const AUTO_GUEST_PORT = !process.argv.some((a) => a === '--guest-port' || a.startsWith('--guest-port='));
const GUEST_PORT = AUTO_GUEST_PORT ? await freePort() : Number(argOf('guest-port', 9446));
const REPLICA_PORT = Number(argOf('replica-port', 8443));
// A PRIVATE marker OUTSIDE the harness marker dir: `ko-guest stop` scans every
// guest*.json in G:/Temp/ko-harness and kills every live browser it names.
// Two replica lanes on one box (measured 2026-11-26, 8443 vs 8444) turned a
// private marker placed there into a cross-lane kill. This runner never invokes
// the sweep; it kills only the browser named HERE, and peers cannot see it.
const GUEST_MARKER = join('G:/Temp/ko-replica', `guest-marker-${GUEST_PORT}-${Date.now()}.json`);
// `--capture-out` makes the replica server write the playlist bodies it served
// in the same shape `_tools/ko-real-capture.mjs` emits, so `compare.mjs` can
// diff the offline page against a real capture:
//   node _tools/ko-replica/compare.mjs --real <real.json> --replica <capture-out>
const CAPTURE_OUT = argOf('capture-out', '');
const NO_EXT = flag('no-ext');
const KEEP_GUEST = flag('keep-guest');
// Pre-warm mode: launch a guest once, leave it alive, then let content-keyed
// runs attach to it and navigate a fresh page. A cold Chrome on this box took
// 14.4 s from navigate to content-script boot under load, which no 15 s scenario
// can absorb. Measured runs pay only the warm reload.
const PREPARE_GUEST = flag('prepare-guest');
const ATTACH_GUEST = flag('attach-guest');
const REUSE_GUEST = PREPARE_GUEST || ATTACH_GUEST;
const SCRATCH = process.env.KO_REPLICA_SCRATCH || 'G:/Temp/ko-replica/runs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenario = JSON.parse(readFileSync(SCN, 'utf8'));
// A scenario may ask the control arm for the plain `FAIL` verdict when its
// whole point is a pass/fail pair (`dev-fast` is an offline twin of the
// friction arms). Default stays CONTROL-FAIL: the timeline probe's vacuous
// control arm is a different thing from a demonstrated product failure.
const CONTROL_FAIL_VERDICT = NO_EXT && scenario.controlVerdict === 'FAIL' ? 'FAIL' : 'CONTROL-FAIL';
const channel = scenario.channel || 'replicach';
const runDir = join(SCRATCH, `${scenario.name}-${Date.now()}`);
mkdirSync(runDir, { recursive: true });

const evidence = { scenario: scenario.name, split: scenario.split || 'dev', noExt: NO_EXT, samples: [], rows: [], checks: [], notes: [] };
let failures = 0;
let cannot = 0;
function check(name, ok, detail) {
  evidence.checks.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
function unmeasurable(name, detail) {
  evidence.checks.push({ name, ok: false, unmeasurable: true, detail });
  cannot++;
  console.log(`CANNOT-MEASURE ${name}${detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

// ---- replica server -------------------------------------------------------
const server = spawn(process.execPath, [join(HERE, 'server.mjs'), '--port', String(REPLICA_PORT), '--scenario', SCN], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: CAPTURE_OUT ? { ...process.env, KO_REPLICA_CAPTURE_OUT: CAPTURE_OUT } : process.env,
});
let serverReady = false;
server.stdout.on('data', (d) => {
  const s = String(d);
  if (s.includes('"ready":true')) serverReady = true;
  evidence.notes.push(`server: ${s.trim()}`);
});
server.stderr.on('data', (d) => evidence.notes.push(`server-err: ${String(d).trim()}`));
// The server rewrites its capture file on its own 500 ms timer AND once at exit,
// so a merge written before it dies is overwritten by a later flush. Measured
// 2026-11-26: the run printed `capture … playlists=11 samples=6` and the file on
// disk had `samples: []`, which is why the first comparison reported
// `dom CANNOT-MEASURE` for a run that sampled the page every second.
const serverClosed = new Promise((res) => { server.once('exit', res); server.once('error', res); });
for (let i = 0; i < 80 && !serverReady; i++) await sleep(100);
if (!serverReady) {
  server.kill();
  finishEarly('replica-server-did-not-start');
}

// ---- guest Chrome ---------------------------------------------------------
// A port that still listens belongs to somebody else's browser: NEVER sweep
// the shared guest markers to clear it. An auto-picked port was free a moment
// ago, so a live listener here is a real conflict; report it and refuse.
// The probe asks BOTH stacks (`::1` and `127.0.0.1`): a leaked guest measured
// 2026-11-25 answered on `[::1]:9446` alone while `ko-guest stop` reported the
// port freed.
const net = await import('node:net');
const portOpen = (host) => new Promise((res) => {
  const s2 = net.connect({ port: GUEST_PORT, host });
  const done = (v) => { try { s2.destroy(); } catch { /* ignore */ } res(v); };
  s2.setTimeout(600, () => done(false));
  s2.once('connect', () => done(true));
  s2.once('error', () => done(false));
});
async function waitClosed(ms) {
  for (let i = 0; i < ms / 250; i++) {
    if (!(await portOpen('127.0.0.1')) && !(await portOpen('::1'))) return true;
    await sleep(250);
  }
  return false;
}
// No marker sweep. A private port was already probed free; a foreign listener
// is a blocker, never a process this run is allowed to kill.
if (!ATTACH_GUEST && (await portOpen('127.0.0.1') || await portOpen('::1'))) {
  if (!(await waitClosed(10000))) {
    console.log(`CANNOT-MEASURE port ${GUEST_PORT} still listening after a stop: a previous guest browser survived its launcher`);
    process.exit(2);
  }
}
const resolver = [
  'www.twitch.tv', 'gql.twitch.tv', 'usher.ttvnw.net',
  'video-edge-a.playlist.ttvnw.net', 'kick.com',
].map((h) => `MAP ${h} 127.0.0.1:${REPLICA_PORT}`).join(', ');
// A unique profile per run: the shared harness profile made a crashed run's
// Chrome hold the ProcessSingleton lock, and the NEXT run then died with
// "guest CDP never answered" while the orphan lived on. The profile is deleted
// by exact path at exit; nothing is shared, nothing is wildcarded.
const UDD_ROOT = 'G:/Temp/ko-replica/profiles/';
const uddDirs = [];
let RUN_UDD = '';
function nextUdd() {
  const dir = join('G:/Temp/ko-replica/profiles', `run-${Date.now()}-${uddDirs.length}`);
  if (existsSync(dir)) {
    console.log(`CANNOT-MEASURE profile ${dir} already exists`);
    process.exit(2);
  }
  uddDirs.push(dir);
  RUN_UDD = dir;
  return dir;
}
// A run killed by its own timeout leaves its guest profile behind (~16 MiB
// each). Sweep ONLY exact run-* paths older than 2 h, one at a time; a profile
// still held by Chrome is named and kept, never wildcard-deleted. This runs
// before nextUdd(), so nothing here can belong to this run.
const PROFILE_ROOT = 'G:/Temp/ko-replica/profiles';
// 2026-11-25 measured: `stopAll()` deleted its own profile while Chrome still
// held a file inside it, caught the refusal, and left 117 MiB of dead profiles
// behind (the census went from 0.33 to 0.44 GiB against a 0.40 ceiling). A
// Chrome that has just exited releases its handles within about a second, so
// one bounded second attempt is the whole fix; the sweep threshold drops from
// 2 h to a minute because a profile older than that belongs to a run that is
// over (two runs never share the guest port, and `uddDirs` guards this one).
const OLD_PROFILE_MS = 60 * 1000;
const PROFILE_RETRY_MS = 1500;
function reapProfile(dir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return true;
    } catch {
      if (attempt === 0) {
        const wait = Date.now() + PROFILE_RETRY_MS;
        while (Date.now() < wait) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch { /* no SharedArrayBuffer: busy wait */ } }
      }
    }
  }
  return false;
}
function dirBytes(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { bytes += statSync(p).size; } catch { /* vanished */ } }
    }
  }
  return bytes;
}
let reaped = 0;
let kept = 0;
let freedBytes = 0;
let profileEntries = [];
try { profileEntries = readdirSync(PROFILE_ROOT, { withFileTypes: true }); } catch { /* no store yet */ }
for (const e of profileEntries) {
  if (!e.isDirectory() || !/^run-/.test(e.name)) continue;
  const p = join(PROFILE_ROOT, e.name);
  if (uddDirs.includes(p)) { kept++; continue; }
  let old = false;
  try { old = Date.now() - statSync(p).mtimeMs > OLD_PROFILE_MS; } catch { /* vanished */ }
  if (!old) { kept++; continue; }
  const bytes = dirBytes(p);
  if (reapProfile(p)) {
    reaped++;
    freedBytes += bytes;
  } else {
    console.log(`leftover profile in use: ${p}`);
    kept++;
  }
}
console.log(`profiles: reaped=${reaped} kept=${kept} bytes=${(freedBytes / 1048576).toFixed(1)}MiB`);
nextUdd();
const guestEnv = {
  ...process.env,
  KO_GUEST_PORT: String(GUEST_PORT),
  KO_GUEST_URL: `https://www.twitch.tv/${channel}`,
  KO_GUEST_UDD: RUN_UDD,
  KO_GUEST_MARKER: GUEST_MARKER,
  KO_GUEST_EXTRA_ARGS: JSON.stringify([
    '--ignore-certificate-errors',
    `--host-resolver-rules=${resolver}`,
  ]),
};
if (NO_EXT) guestEnv.KO_NO_EXT = '1';
let guest = null;
function launchGuest() {
  if (ATTACH_GUEST) { guest = null; return null; }
  guest = spawn(process.execPath, [join(ROOT, '_tools', 'ko-guest.mjs'), 'start'], {
    env: guestEnv,
    stdio: PREPARE_GUEST ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: PREPARE_GUEST,
  });
  if (guest.stdout) {
    guest.stdout.on('data', (d) => evidence.notes.push(`guest: ${String(d).trim()}`));
    guest.stderr.on('data', (d) => evidence.notes.push(`guest-err: ${String(d).trim()}`));
  }
  if (PREPARE_GUEST) {
    guest.unref();
    writeFileSync(join('G:/Temp/ko-replica', 'guest-reuse.json'), JSON.stringify({ port: GUEST_PORT, marker: GUEST_MARKER, pid: guest.pid, at: Date.now() }));
  }
  return guest;
}
if (!ATTACH_GUEST) launchGuest();

// ORDER MATTERS: kill the Chrome TREE by the PID in THIS run's marker, then
// the launcher. Killing the launcher first leaves the browser alive with its
// profile lock and its CDP port (measured 2026-11-25). Idempotent: `process.on
// ('exit')` calls this again after the explicit stop at the end of the run.
let stoppedAll = false;
function ourChromePid() {
  try {
    const j = JSON.parse(readFileSync(GUEST_MARKER, 'utf8'));
    return j && Number(j.port) === GUEST_PORT && j.pid ? Number(j.pid) : null;
  } catch { return null; }
}
function killOurGuest() {
  const pid = ourChromePid();
  if (pid) {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ }
  }
  try { if (guest) guest.kill(); } catch { /* ignore */ }
  try { rmSync(GUEST_MARKER, { force: true }); } catch { /* ignore */ }
}
function stopAll() {
  if (stoppedAll) return;
  stoppedAll = true;
  if (!KEEP_GUEST && !REUSE_GUEST) killOurGuest();
  try { server.kill(); } catch { /* ignore */ }
  if (!KEEP_GUEST && !REUSE_GUEST && !process.env.KO_REPLICA_KEEP_UDD) {
    // `uddDirs` is declared after the server-start refusal path can reach
    // this function, so an early stop reads it in its temporal dead zone.
    try {
      for (const dir of uddDirs) {
        if (!String(dir).startsWith(UDD_ROOT)) continue;
        if (!reapProfile(dir)) console.log(`leftover profile in use: ${dir}`);
      }
    } catch { /* early exit: no profiles to reap */ }
  }
}
process.on('exit', stopAll);

// An early refusal is still a measurement: it must leave `report.json` beside
// every other run, with the notes that explain it. Measured 2026-11-25: two
// runs exited "CANNOT-MEASURE" and left an EMPTY directory, so the reason lived
// only in a terminal that had already been scrolled away.
function finishEarly(reason) {
  evidence.failures = 0;
  evidence.cannotMeasure = 1;
  evidence.verdict = 'CANNOT-MEASURE';
  evidence.reason = reason;
  const body = JSON.stringify(evidence, null, 2);
  try {
    const dir = runDir || join(SCRATCH, `early-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), body);
    console.log(`report ${join(dir, 'report.json')}`);
  } catch { /* the exit code still carries the verdict */ }
  if (OUT) { try { writeFileSync(OUT, body); } catch { /* ignore */ } }
  console.log(`RESULT CANNOT-MEASURE scenario=${scenario.name} reason=${reason}`);
  for (const n of evidence.notes.slice(-14)) console.log(`  ${n}`);
  stopAll();
  process.exit(2);
}

// ---- connect --------------------------------------------------------------
// A launch that never answers CDP is retried ONCE, after a clean stop: measured
// 2026-11-25, one run in three died here while the previous run's Chrome was
// still tearing down, and the run then reported "guest CDP never answered"
// with no reason beside it. The notes carry the launcher's own stderr, so a
// second failure names its cause instead of only its symptom.
let cdp = null;
for (let attempt = 1; attempt <= 2 && !cdp; attempt++) {
  for (let i = 0; i < 160 && !cdp; i++) {
    try { cdp = await connect(GUEST_PORT); } catch { await sleep(250); }
  }
  if (cdp) break;
  evidence.notes.push(`guest: attempt ${attempt} never answered CDP`);
  try { guest.kill(); } catch { /* ignore */ }
  killOurGuest();
  if (attempt === 1) {
    await sleep(3000);
    if (!(await waitClosed(8000))) evidence.notes.push(`guest: port ${GUEST_PORT} still listening before the retry`);
    guestEnv.KO_GUEST_UDD = nextUdd();
    launchGuest();
  }
}
if (!cdp) finishEarly('guest-cdp-never-answered-2-launches');

let page = null;
if (ATTACH_GUEST) {
  // A NEW TARGET, not a reload of the prepared tab: reusing a tab kept the
  // isolated-world guard from re-injecting its content script (measured 2026-
  // 11-26: ext:true in page world but 0 worker-playlist rows).
  const created = await cdp.send('Target.createTarget', { url: `https://www.twitch.tv/${channel}`, background: true }, undefined, 15000);
  page = { targetId: created.targetId, url: `https://www.twitch.tv/${channel}` };
} else {
  for (let i = 0; i < 160 && !page; i++) {
    try {
      // A guest that dies while loading its extension leaves the socket open:
      // the default 30 s send timeout crashed the whole run. A dead guest is a
      // CANNOT-MEASURE with its launcher stderr, not an uncaught exception.
      const { targetInfos } = await cdp.send('Target.getTargets', {}, undefined, 5000);
      page = targetInfos.find((t) => t.type === 'page' && /twitch\.tv\//.test(t.url)) || null;
    } catch (e) {
      evidence.notes.push(`targets: ${String(e)}`);
    }
    if (!page) await sleep(250);
  }
}
if (!page) {
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    evidence.notes.push(`targets at refusal: ${targetInfos.map((t) => `${t.type}:${String(t.url).slice(0, 90)}`).join(' | ')}`);
  } catch { /* best effort */ }
  finishEarly('replica-page-never-loaded');
}
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Page.enable', {}, sessionId);

// CLEAN-FRAME PROBE. The bridge posts one {__koKick:{t:'st',st}} per second;
// collecting them on the page is the only cross-origin-safe way to see the
// clean frame's own pos/hold/lat/level without changing the product. The
// iframe's own rect is read from the parent DOM (same document).
if (!NO_EXT) {
  await evaluate(`(() => {
    const p = (window.__koStProbe = { rows: [], t0: Math.round(performance.now()) });
    window.addEventListener('message', (ev) => {
      const m = ev.data && ev.data.__koKick;
      if (!m || m.t !== 'st' || !m.st) return;
      const f = document.getElementById('ko-adfix');
      const r = f ? f.getBoundingClientRect() : null;
      p.rows.push({
        ms: Math.round(performance.now()),
        pos: +Number(m.st.pos || 0).toFixed(2),
        hold: +Number(m.st.buffered || 0).toFixed(2),
        lat: +Number(m.st.lat || 0).toFixed(2),
        latSrc: m.st.latSrc || null,
        rs: m.st.rs, state: m.st.state,
        q: (m.st.q && m.st.q.name) || null,
        lv: m.st.lv == null ? null : m.st.lv,
        bw: m.st.bw == null ? null : m.st.bw,
        levels: (m.st.qualities || []).map((x) => x.h || x.w || x.name),
        rect: r ? [Math.round(r.width), Math.round(r.height)] : null,
      });
      if (p.rows.length > 600) p.rows.shift();
    });
    return true;
  })()`);
}
if (PREPARE_GUEST) {
  // Wait for the real content script, not merely the page target: a target can
  // exist 14 s before the extension world is injected on a loaded box.
  for (let i = 0; i < 100; i++) {
    const ok = await evaluate(NO_EXT ? '!!window.__koReplica' : '!!window.__koTwitchAdblock && !!window.__koReplica');
    if (ok === true) break;
    await sleep(200);
  }
  console.log(`GUEST_READY scenario=${scenario.name} port=${GUEST_PORT} marker=${GUEST_MARKER}`);
  process.exit(0);
}
async function evaluate(expr) {
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId, 15000);
    return r.result?.value ?? r.result;
  } catch (e) {
    return { error: String(e) };
  }
}

const probeExpr = `(() => {
  const v = document.querySelector('video');
  const bytes = (n) => (v && v.buffered && v.buffered.length ? +v.buffered.end(v.buffered.length - 1).toFixed(2) : null);
  return {
    href: location.href,
    ext: !!window.__koTwitchAdblock,
    replica: window.__koReplica ? {
      handleAt: window.__koReplica.handleAt || 0,
      appended: window.__koReplica.appended || 0,
      errors: (window.__koReplica.errors || []).slice(-3),
      state: window.__koReplica.state || null,
    } : null,
    video: v ? {
      rs: v.readyState, paused: v.paused, ct: +v.currentTime.toFixed(2),
      muted: v.muted, vol: +v.volume.toFixed(2), buf: bytes(),
      // Where the buffer STARTS is the difference between "nothing decoded"
      // and "decoded into a timeline the playhead is not on": a first program
      // appended past 0 plays 0 s of it and paints black.
      buf0: (() => { try { return v.buffered.length ? +v.buffered.start(0).toFixed(2) : null; } catch { return null; } })(),
      vw: v.videoWidth, vh: v.videoHeight, err: v.error ? v.error.code : null,
      // Frames the decoder actually produced. A black picture over an
      // advancing clock with a static frame count is a decode problem; a
      // growing count with black pixels is a paint/region problem.
      vf: (() => { try { return v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null; } catch { return null; } })(),
      src: !!v.srcObject,
      rect: (() => { const r = v.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); })(),
    } : null,
    owner: document.documentElement.getAttribute('data-ko-owner') || '',
    adpark: document.documentElement.getAttribute('data-ko-adpark') || '',
    wrapper: (() => { const w = document.querySelector('[class*="stream-display-ad"]'); return w ? { cls: w.className, w: Math.round(w.getBoundingClientRect().width), h: Math.round(w.getBoundingClientRect().height) } : null; })(),
    // The compare tool diffs the player rect against a real capture, so the
    // replica probe reports the same container the real probe measures.
    player: (() => { const p = document.querySelector('[data-a-target="video-player"]') || document.querySelector('.video-player') || document.getElementById('player'); if (!p) return null; const r = p.getBoundingClientRect(); return { rect: [r.x, r.y, r.width, r.height].map(Math.round) }; })(),
    adtext: (document.getElementById('ko-replica-adtext') || {}).textContent || '',
    frames: Array.from(document.querySelectorAll('iframe')).map((f) => String(f.src).slice(0, 80)),
  };
})()`;

// Chrome screenshots are 8-bit RGB/RGBA PNGs. Decoding them here keeps a
// pixel sample cheap: the old spawnSync('ffmpeg') per sample stalled for
// 7-17 s under load (measured 2026-11-25), which made the runner's 2 s sample
// labels lie about wall-clock pacing even while the media played 1:1.
function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const parts = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG ${width}x${height} depth=${bitDepth} color=${colorType}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(parts));
  const pixels = Buffer.allocUnsafe(height * stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const row = raw.subarray(at, at + stride); at += stride;
    const dst = pixels.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? dst[i - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[(y - 1) * stride + i - bpp] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`PNG filter ${filter}`);
      dst[i] = v & 255;
    }
  }
  return { pixels, bpp, n: width * height };
}
// A 2x2 center pixel cannot tell a solid-blue ad from the blue bar in the
// test pattern (measured: content sampled 42,51,210 and read as "not the ad").
// The whole player rect is captured small and classified by the FRACTION of
// pixels that are ad-blue, which a moving test pattern cannot fake.
async function centerRgb() {
  try {
    const rect = await evaluate(`(() => { const v = document.querySelector('video'); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    if (!rect || typeof rect.x !== 'number' || rect.w < 8 || rect.h < 8) return null;
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h), scale: 120 / Math.max(rect.w, rect.h) },
    }, sessionId, 15000);
    const img = decodePng(Buffer.from(shot.data, 'base64'));
    const b = img.pixels;
    if (!img.n || b.length < 300) return null;
    let r = 0, g = 0, bl = 0, blue = 0, dark = 0, n = 0;
    for (let i = 0; i < b.length; i += img.bpp) {
      const R = b[i], G = b[i + 1], B = b[i + 2];
      r += R; g += G; bl += B; n++;
      if (B > 150 && B - Math.max(R, G) > 80) blue++;
      if (R + G + B < 60) dark++;
    }
    return {
      mean: [Math.round(r / n), Math.round(g / n), Math.round(bl / n)],
      blue: +(blue / n).toFixed(3),
      dark: +(dark / n).toFixed(3),
      n,
    };
  } catch (e) {
    evidence.notes.push(`pixel: ${String(e)}`);
    return null;
  }
}

// ---- timeline -------------------------------------------------------------
if (ATTACH_GUEST) {
  // The new target starts its own navigation, hence a fresh server episode.
  for (let i = 0; i < 100; i++) {
    const st = await evaluate(`(() => ({ href: location.href, ready: !!window.__koReplica, ext: ${NO_EXT ? 'true' : '!!window.__koTwitchAdblock'} }))()`);
    if (st && st.ready && st.ext && String(st.href).includes(`/${channel}`)) break;
    await sleep(200);
  }
  // A background target is throttled: no MSE decode, no reveal, no handoff.
  // Do this AFTER the page is ready; bringing an unloaded target forward then
  // letting another tab steal focus produced `visibility:hidden` (measured
  // 2026-11-26 in dev-fast run 2: 27 ring rows, no reveal, no handoff).
  await cdp.send('Page.bringToFront', {}, sessionId, 5000);
  await sleep(200);
  await cdp.send('Page.bringToFront', {}, sessionId, 5000);
}
const samples = (scenario.samples || []).slice().sort((a, b) => a.at - b.at);
// Scenario times are relative to the PAGE's navigation start (the server
// starts its episode clock on the same GET), not to when this runner attached.
let sinceNav = 0;
try { sinceNav = await evaluate('performance.now()'); } catch (e) { evidence.notes.push(`nav clock: ${String(e)}`); }
const pageEpoch = Date.now() - (typeof sinceNav === 'number' ? sinceNav : 0);
evidence.navEpoch = pageEpoch;
const t0 = pageEpoch;
// ---- reload arm -----------------------------------------------------------
// THE OWNER'S OWN QUESTION, MEASURED: "in some ads I can reload and get a few
// seconds of the livestream, and every reload I get more seconds; other ads I
// can't". A reload is a new navigation, therefore a new playback token, a new
// playlist and a new ad decision, so whether it escapes depends on WHERE the ad
// lives (a decision still in flight vs a segment already stitched into the
// window). Anecdote cannot separate those two, this can: the same scenario is
// played once per arm and the report prints content-seconds, ad-seconds and
// load-seconds per cycle, so "it works sometimes" becomes a number per ad type.
if (scenario.reload && scenario.reload.everyMs > 0) {
  const everyMs = Number(scenario.reload.everyMs);
  const totalMs = Number(scenario.reload.forMs || scenario.durationMs || 40000);
  const rows = [];
  let lastReload = Date.now();
  let reloads = 0;
  let prevCt = null;
  const end = Date.now() + totalMs;
  while (Date.now() < end) {
    const at = Date.now() - pageEpoch;
    let probe = null;
    try { probe = await evaluate(probeExpr); } catch (e) { evidence.notes.push(`reload probe at ${at}: ${String(e)}`); }
    const px = await centerRgb();
    const ct = probe && probe.video ? probe.video.ct : null;
    const playing = !!(probe && probe.video && !probe.video.paused && probe.video.rs >= 3);
    // A cycle is LIVE only when the clock moved since the previous sample AND
    // the picture is not the ad program.
    const adv = ct != null && prevCt != null ? +(ct - prevCt).toFixed(2) : null;
    prevCt = ct;
    // Also recorded as a normal sample so `page-loaded` and the pixel rows keep
    // grading: a reload arm that bypassed them would report an unmeasurable
    // episode as a pass.
    evidence.samples.push({ at, wallMs: at, probe, px, adv, reloads });
    rows.push({
      at, ct, adv, playing,
      ad: px ? !!px.blue : null,
      dark: px ? !!px.dark : null,
      href: probe ? String(probe.href || '').slice(-40) : null,
      reloads,
    });
    if (Date.now() - lastReload >= everyMs) {
      try { await cdp.send('Page.reload', { ignoreCache: false }, sessionId, 15000); } catch (e) { evidence.notes.push(`reload: ${String(e)}`); }
      lastReload = Date.now();
      reloads++;
      prevCt = null;
    }
    await sleep(Math.max(250, 1000 - (Date.now() - pageEpoch - at)));
  }
  const live = rows.filter((r) => r.adv != null && r.adv > 0.2 && r.ad === false).length;
  const adSec = rows.filter((r) => r.ad === true).length;
  const loadSec = rows.filter((r) => !r.playing).length;
  evidence.reloadArm = {
    everyMs, reloads, samples: rows.length, liveSec: live, adSec, loadSec,
    livePerCycle: reloads ? +(live / reloads).toFixed(2) : null,
    adPerCycle: reloads ? +(adSec / reloads).toFixed(2) : null,
    loadPerCycle: reloads ? +(loadSec / reloads).toFixed(2) : null,
    rows,
  };
  writeFileSync(join(runDir, `${scenario.name}-reload-${Date.now()}.json`), JSON.stringify(evidence.reloadArm, null, 1));
  console.log(`RELOAD every=${everyMs}ms reloads=${reloads} live=${live}s ad=${adSec}s load=${loadSec}s -> live/cycle=${evidence.reloadArm.livePerCycle}s ad/cycle=${evidence.reloadArm.adPerCycle}s load/cycle=${evidence.reloadArm.loadPerCycle}s`);
}

for (const s of samples) {
  const wait = pageEpoch + s.at - Date.now();
  if (wait > 0) await sleep(wait);
  // A late CDP call or ffmpeg spawn does not move the scenario label, so a
  // report of "ct jumped 14 s in 2 s" can really be 14 s of wall clock. Record
  // the actual elapsed time beside every sample; never infer pacing from `at`.
  const wallMs = Date.now() - pageEpoch;
  const probeStart = Date.now();
  let probe = null;
  try {
    probe = await evaluate(probeExpr);
  } catch (e) {
    // A page that stops answering is evidence, not a crash: keep the samples
    // already taken and let grading report the hole.
    evidence.notes.push(`probe at ${s.at}: ${String(e)}`);
    break;
  }
  const pxStart = Date.now();
  const px = s.pixel ? await centerRgb() : null;
  const pxMs = Date.now() - pxStart;
  evidence.samples.push({ at: s.at, wallMs, probeMs: pxStart - probeStart, pxMs, probe, px });
  console.log(`SAMPLE ${s.at}ms wall=${wallMs}ms ${probe && probe.video ? `ct=${probe.video.ct} rs=${probe.video.rs} paused=${probe.video.paused} buf=${probe.video.buf} buf0=${probe.video.buf0} sized=${probe.video.vw}x${probe.video.vh} frames=${probe.video.vf} err=${probe.video.err}` : 'no-video'}${px ? ` blue=${px.blue} dark=${px.dark} mean=${px.mean.join(',')}` : ''} probeMs=${pxStart - probeStart} pxMs=${pxMs}`);
}

const lastAt = Math.max(0, ...samples.map((s) => s.at), ...(scenario.events || []).map((e) => e.at + (e.ms || 0)));
const tail = Number(scenario.tailMs || 12000);
const remain = t0 + lastAt + tail - Date.now();
if (remain > 0) await sleep(remain);

// ---- adlog ----------------------------------------------------------------
async function readAdlog() {
  let extId = null;
  try {
    const list = await cdp.send('Extensions.getExtensions', {}, undefined, 5000);
    extId = ((list.extensions || []).find((e) => /Overlay/i.test(e.name || '')) || {}).id || null;
  } catch { /* unsafe extension debugging not on */ }
  if (!extId) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const w = targetInfos.find((t) => t.type === 'service_worker' && /kick|overlay/i.test(t.url));
    if (w) extId = (w.url.match(/^chrome-extension:\/\/([a-p]+)/) || [])[1];
  }
  if (!extId) return null;
  const created = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html`, hidden: true, background: true });
  const at = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, at.sessionId);
  await sleep(700);
  const got = await cdp.send('Runtime.evaluate', {
    expression: `new Promise(r => chrome.storage.local.get(null, o => r({ ver: chrome.runtime.getManifest().version, log: o['ko.adlog'] || [] })))`,
    returnByValue: true, awaitPromise: true,
  }, at.sessionId, 15000);
  await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  return got.result?.value || null;
}

let ring = null;
if (!NO_EXT) {
  try { ring = await readAdlog(); } catch (e) { evidence.notes.push(`adlog: ${String(e)}`); }
}
if (!NO_EXT && !ring) unmeasurable('adlog-readable', 'extension page could not be opened');
// The ring is shared across page loads, so every judgement below is scoped to
// THIS episode: rows at or after this page's navigation. The previous appender
// read the whole ring, which made 6 historical boots look like 6 reloads.
const raw = (ring && ring.log) || [];
const epStart = evidence.navEpoch ? evidence.navEpoch - 3000 : 0;
const log = epStart ? raw.filter((e) => e.t >= epStart) : raw;
evidence.ringRows = raw.length;
evidence.build = ring ? ring.ver : null;
evidence.rows = log.map((e) => ({ t: e.t, ev: e.ev, d: e.d }));
const E = (ev) => log.filter((e) => e.ev === ev);
const first = (ev) => E(ev)[0] || null;
const firstAfter = (ev, ms) => log.find((e) => e.ev === ev && e.t >= ms) || null;

// ---- vacuity / instrument-reality gates -----------------------------------
const pageLoaded = evidence.samples.some((s) => s.probe && s.probe.href);
if (!pageLoaded) unmeasurable('page-loaded', 'no sample saw the replica page');
// `appended` is only published after a whole playlist apply succeeds. A
// scenario that refuses the NEXT segment appends init + one fragment, then
// throws before posting a tick, so a real decoded picture has appended=0.
// Frames decoded from the MediaSource handle are the same fact one level
// closer to the user, so either instrument proves the fixture played.
const playback = evidence.samples.some((s) => s.probe && s.probe.video && s.probe.video.src && s.probe.replica
  && (s.probe.replica.appended > 0 || (s.probe.video.vf > 0 && s.probe.video.buf > 0)));
if (!playback) unmeasurable('fixture-playback', 'the replica video never received an MSE append (fixture did not play)');
if (!NO_EXT) {
  const sawWorker = E('worker-hook').length > 0 || E('worker-playlist').length > 0;
  if (!sawWorker) unmeasurable('worker-hook', 'the extension never patched the replica worker');
}

// ---- expectations ---------------------------------------------------------
const probeAt = (ms) => {
  const near = evidence.samples.filter((s) => s.at <= ms).pop();
  return near ? near.probe : null;
};
// The ad program is a solid blue frame, so it fills the player with ad-blue.
// Content (a moving test pattern) never does. Thresholds are fractions of the
// captured player rect, printed with every verdict. 0.35 rather than 0.9
// because the captured rect includes the player's own black letterbox bars,
// which no program can paint (measured: a full-screen ad read blue=0.564).
function rgbNotBlue(px) {
  return px ? px.blue < 0.2 : null;
}
function rgbBlue(px) {
  return px ? px.blue > 0.35 : false;
}

const known = new Set([
  'row', 'absent', 'within', 'noReload', 'probe', 'pixelNotBlue', 'pixelBlue', 'pixelDark', 'rowsAtMost',
  'rowField', 'coverDuring',
]);
for (const exp of scenario.expect || []) {
  if (!known.has(exp.type)) {
    unmeasurable(`unknown-expectation-${exp.type}`, 'scenario names an expectation the runner does not implement');
    continue;
  }
  if (exp.type === 'row') {
    const n = E(exp.ev).length;
    check(`row ${exp.ev} >= ${exp.min}`, n >= exp.min, { n });
  } else if (exp.type === 'rowsAtMost') {
    const n = E(exp.ev).length;
    check(`row ${exp.ev} <= ${exp.max}`, n <= exp.max, { n });
  } else if (exp.type === 'absent') {
    const n = E(exp.ev).length;
    check(`row ${exp.ev} absent`, n === 0, { n });
  } else if (exp.type === 'within') {
    const a = first(exp.from);
    const b = a ? firstAfter(exp.to, a.t) : null;
    if (!a) check(`within ${exp.from}->${exp.to}`, false, 'from-row missing');
    else if (!b) check(`within ${exp.from}->${exp.to}`, false, 'to-row missing');
    else check(`within ${exp.from}->${exp.to} <= ${exp.maxMs}ms`, b.t - a.t <= exp.maxMs, { ms: b.t - a.t });
  } else if (exp.type === 'rowField') {
    const rows = E(exp.ev);
    const hit = rows.find((r) => {
      const v = r && r.d ? r.d[exp.field] : undefined;
      if (exp.op === 'lt') return Number.isFinite(Number(v)) && Number(v) < exp.value;
      if (exp.op === 'in') return Array.isArray(exp.value) && exp.value.includes(v);
      return exp.op === 'eq' ? v === exp.value : false;
    });
    check(`row ${exp.ev}.${exp.field} ${exp.op} ${JSON.stringify(exp.value)}`, !!hit, {
      n: rows.length, hit: hit ? { t: hit.t, d: hit.d } : null,
    });
  } else if (exp.type === 'coverDuring') {
    const a = first(exp.from);
    const b = a ? firstAfter(exp.to, a.t) : null;
    const ats = Array.isArray(exp.at) ? exp.at : [exp.at];
    const samples = evidence.samples.filter((x) => ats.includes(x.at));
    // adlog times are wall-clock epochs; sample wallMs is relative to nav.
    const hit = samples.find((s) => {
      const abs = evidence.navEpoch + s.wallMs;
      return a && b && abs >= a.t && abs <= b.t && s.px && s.px.blue != null && s.px.blue < 0.2;
    });
    check(`cover ${exp.from}->${exp.to} at ${JSON.stringify(ats)}`, !!hit, {
      from: a && a.t, to: b && b.t,
      samples: samples.map((s) => ({ at: s.at, blue: s.px ? s.px.blue : null })),
    });
  } else if (exp.type === 'noReload') {
    // The extension writes two boot rows per page load (provenance + state).
    const boots = E('boot').filter((e) => e.d && e.d.href).map((e) => Math.round(e.t / 1000));
    const loads = [...new Set(boots)].length;
    check('no reload (one page load)', loads <= 1, { loads });
  } else if (exp.type === 'probe') {
    const p = probeAt(exp.at || 0);
    const v = exp.path.split('.').reduce((o, k) => (o == null ? o : o[k]), p);
    check(`probe ${exp.path} ${exp.op} ${JSON.stringify(exp.value)}`, exp.op === 'eq' ? v === exp.value : exp.op === 'lt' ? Number(v) < exp.value : v, { got: v });
  } else if (exp.type === 'pixelNotBlue' || exp.type === 'pixelDark' || exp.type === 'pixelBlue') {
    const s = evidence.samples.find((x) => x.at === exp.at);
    const px = s ? s.px : null;
    const sum = px && px.mean ? px.mean[0] + px.mean[1] + px.mean[2] : null;
    let verdict = null;
    let label = '';
    if (exp.type === 'pixelNotBlue') { verdict = rgbNotBlue(px); label = `pixel at ${exp.at} is not the ad`; }
    if (exp.type === 'pixelDark') { verdict = sum == null ? null : sum <= 90; label = `pixel at ${exp.at} is dark (hold cover)`; }
    if (exp.type === 'pixelBlue') { verdict = px ? rgbBlue(px) : false; label = `pixel at ${exp.at} is the ad (known-bad arm)`; }
    if (verdict == null) {
      unmeasurable(`pixel at ${exp.at}`, 'no screenshot for this sample');
    } else if (NO_EXT) {
      // The control arm: with no extension loaded the ad MUST be visible and
      // nothing may cover it. The same scenario is re-read inverted, so one
      // file proves both directions instead of a second copy drifting.
      check(label, !verdict, { px, inverted: 'control-no-extension' });
    } else {
      check(label, verdict, { px });
    }
  }
}
// Print the clean frame once per second. Duplicates from the coalesced
// event-driven `st` messages are collapsed by whole second, keeping the last
// row in each second.
if (!NO_EXT) {
  const probeRows = await evaluate('window.__koStProbe ? window.__koStProbe.rows : []');
  const bySec = new Map();
  for (const row of Array.isArray(probeRows) ? probeRows : []) bySec.set(Math.floor(row.ms / 1000), row);
  evidence.cleanRows = [...bySec.values()];
  if (evidence.cleanRows.length) {
    console.log(`CLEAN-VARIANTS ${JSON.stringify(evidence.cleanRows[0].levels)} rect=${JSON.stringify(evidence.cleanRows[0].rect)}`);
    for (const r of evidence.cleanRows) {
      console.log(`CLEAN ${r.ms}ms pos=${r.pos} hold=${r.hold} lat=${r.lat} ${r.latSrc} rs=${r.rs} ${r.state} q=${r.q} lv=${r.lv} bw=${r.bw} rect=${JSON.stringify(r.rect)}`);
    }
  } else {
    console.log('CLEAN no st rows were observed (probe never fired)');
  }
}
// The wait's own rows are the evidence: the first is the extension reading the
// native element's readyState at pod end, the second is why it let go. Print
// both in ring order, plus an independent CDP probe of the same element, so a
// claim about `rs < 3` can be checked without reading the source.
if (!NO_EXT && (E('handback-wait').length || E('handback-ready').length)) {
  for (const ev of ['handback-wait', 'handback-ready', 'handback-wait-cancelled']) {
    for (const r of E(ev)) console.log(`HANDBACK ${r.t} ${ev} ${JSON.stringify(r.d)}`);
  }
  const w = first('handback-wait');
  if (w) {
    const near = evidence.samples.filter((s) => evidence.navEpoch + s.wallMs <= w.t).pop() || evidence.samples[0];
    const rs = near && near.probe && near.probe.video ? near.probe.video.rs : null;
    console.log(`NATIVE-AT-POD-END extension handback-wait.rs=${w.d && w.d.rs} at=${w.t}; CDP probe@${near && near.at}ms video.rs=${rs}`);
  }
  const srv = await evaluate('fetch("/__ko/state").then((r) => r.json())');
  if (srv && !srv.error) console.log(`STALL withheld native=${srv.stallNative} clean=${srv.stallClean}`);
}

// ---- report ---------------------------------------------------------------
evidence.failures = failures;
evidence.cannotMeasure = cannot;
// A control run (`--no-ext`) has a different contract: the ad must be VISIBLE
// and nothing may cover it, and every row expectation correctly finds nothing.
// Its verdict is read only from the inverted pixel checks, which is the arm
// that proves the product checks can fail at all.
const pixelChecks = evidence.checks.filter((c) => /^pixel at /.test(c.name));
const controlOk = NO_EXT ? pixelChecks.every((c) => c.ok) : false;
if (NO_EXT) {
  failures = evidence.checks.filter((c) => !c.ok && /^pixel at /.test(c.name)).length;
  evidence.arm = 'control-no-extension';
}
evidence.verdict = cannot > 0 ? 'CANNOT-MEASURE' : NO_EXT ? (controlOk ? 'CONTROL-PASS' : CONTROL_FAIL_VERDICT) : failures > 0 ? 'FAIL' : 'PASS';
const report = JSON.stringify(evidence, null, 2);
writeFileSync(join(runDir, 'report.json'), report);
if (OUT) writeFileSync(OUT, report);
// A `--capture-out` file is compared dimension by dimension, and `dom` is one
// of the dimensions: the server can only write the playlists it served, while
// the browser samples are what a DOM diff reads. Merge them here so one file
// answers both questions, instead of leaving `dom` as CANNOT-MEASURE for every
// replica run. The server has to be GONE first: its own timer and exit flush
// overwrite this file, and a merge racing them loses the samples (measured
// above). A missing file is a loud line, never a silent pass.
console.log(`RESULT ${evidence.verdict} scenario=${scenario.name} checks=${evidence.checks.length} failed=${failures} cannot=${cannot} build=${evidence.build || 'n/a'} rows=${log.length}`);
console.log(`report ${join(runDir, 'report.json')}`);
if (ATTACH_GUEST && page) await cdp.send('Target.closeTarget', { targetId: page.targetId }, undefined, 5000).catch(() => {});
cdp.close();
stopAll();
if (CAPTURE_OUT) {
  await Promise.race([serverClosed, sleep(4000)]);
  if (!existsSync(CAPTURE_OUT)) {
    console.error(`capture-missing ${CAPTURE_OUT}: the server wrote no playlist`);
  } else {
    try {
      const cap = JSON.parse(readFileSync(CAPTURE_OUT, 'utf8'));
      cap.samples = Array.isArray(evidence.samples) ? evidence.samples : [];
      // `source` marks the observer: the playlists come from the replica server,
      // which cannot attribute an HTTP request to a CDP target, while the real
      // capture is taken over CDP. Losing that marker made compare.mjs report
      // `fetchedBy DIVERGE` for a difference of the instrument.
      const probe = evidence.dom || (evidence.samples && evidence.samples[0] && evidence.samples[0].probe) || {};
      cap.dom = { ...probe, source: 'replica-server', merged: 'server-playlists+browser-samples' };
      cap.sampleCount = Array.isArray(evidence.samples) ? evidence.samples.length : 0;
      cap.scenario = scenario.name;
      cap.verdict = evidence.verdict;
      cap.url = cap.realUrl ? cap.url : (evidence.url || cap.url || '');
      writeFileSync(CAPTURE_OUT, `${JSON.stringify(cap, null, 1)}\n`);
      console.log(`capture ${CAPTURE_OUT} playlists=${cap.playlists.length} samples=${cap.samples.length}`);
    } catch (err) {
      console.error(`capture-merge-failed ${CAPTURE_OUT}: ${err && err.message}`);
    }
  }
}
process.exit(evidence.verdict === 'PASS' || evidence.verdict === 'CONTROL-PASS' ? 0 : evidence.verdict === 'FAIL' || evidence.verdict === 'CONTROL-FAIL' ? 1 : 2);
