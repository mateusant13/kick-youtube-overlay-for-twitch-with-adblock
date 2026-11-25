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
const GUEST_PORT = process.argv.some((a) => a === '--guest-port' || a.startsWith('--guest-port='))
  ? Number(argOf('guest-port', 9446))
  : await freePort();
const REPLICA_PORT = Number(argOf('replica-port', 8443));
const NO_EXT = flag('no-ext');
const KEEP_GUEST = flag('keep-guest');
const SCRATCH = process.env.KO_REPLICA_SCRATCH || 'G:/Temp/ko-replica/runs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenario = JSON.parse(readFileSync(SCN, 'utf8'));
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
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let serverReady = false;
server.stdout.on('data', (d) => {
  const s = String(d);
  if (s.includes('"ready":true')) serverReady = true;
  evidence.notes.push(`server: ${s.trim()}`);
});
server.stderr.on('data', (d) => evidence.notes.push(`server-err: ${String(d).trim()}`));
for (let i = 0; i < 80 && !serverReady; i++) await sleep(100);
if (!serverReady) {
  server.kill();
  finishEarly('replica-server-did-not-start');
}

// ---- guest Chrome ---------------------------------------------------------
// A port that still listens is a previous run's browser, and Chrome's answer is
// a `bind()` failure plus a ProcessSingleton abort — never a CDP handshake. The
// probe asks BOTH stacks (`::1` and `127.0.0.1`): the leaked guest measured
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
spawnSync(process.execPath, [join(ROOT, '_tools', 'ko-guest.mjs'), 'stop'], { stdio: 'ignore', windowsHide: true });
if (await portOpen('127.0.0.1') || await portOpen('::1')) {
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
  KO_GUEST_EXTRA_ARGS: JSON.stringify([
    '--ignore-certificate-errors',
    `--host-resolver-rules=${resolver}`,
  ]),
};
if (NO_EXT) guestEnv.KO_NO_EXT = '1';
let guest = null;
function launchGuest() {
  guest = spawn(process.execPath, [join(ROOT, '_tools', 'ko-guest.mjs'), 'start'], {
    env: guestEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  guest.stdout.on('data', (d) => evidence.notes.push(`guest: ${String(d).trim()}`));
  guest.stderr.on('data', (d) => evidence.notes.push(`guest-err: ${String(d).trim()}`));
  return guest;
}
launchGuest();

// ORDER MATTERS: the marker-based `stop` is what kills the Chrome TREE. Killing
// the launcher first leaves the browser alive with its profile lock and its
// CDP port — measured 2026-11-25: a run exited with the launcher killed, the
// next run's Chrome bound only ::1 (IPv4 `bind()` refused) and never answered
// CDP, and `ko-guest stop` then printed "nothing to stop" because the marker
// was already gone. The launcher is killed only after the tree is reaped.
function stopAll() {
  if (!KEEP_GUEST) {
    spawnSync(process.execPath, [join(ROOT, '_tools', 'ko-guest.mjs'), 'stop'], { stdio: 'ignore', windowsHide: true });
  }
  try { guest.kill(); } catch { /* ignore */ }
  try { server.kill(); } catch { /* ignore */ }
  if (!KEEP_GUEST && !process.env.KO_REPLICA_KEEP_UDD) {
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
  spawnSync(process.execPath, [join(ROOT, '_tools', 'ko-guest.mjs'), 'stop'], { stdio: 'ignore', windowsHide: true });
  if (attempt === 1) {
    await sleep(3000);
    if (!(await waitClosed(8000))) evidence.notes.push(`guest: port ${GUEST_PORT} still listening before the retry`);
    guestEnv.KO_GUEST_UDD = nextUdd();
    launchGuest();
  }
}
if (!cdp) finishEarly('guest-cdp-never-answered-2-launches');

let page = null;
for (let i = 0; i < 160 && !page; i++) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  page = targetInfos.find((t) => t.type === 'page' && /twitch\.tv\//.test(t.url)) || null;
  if (!page) await sleep(250);
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
const samples = (scenario.samples || []).slice().sort((a, b) => a.at - b.at);
// Scenario times are relative to the PAGE's navigation start (the server
// starts its episode clock on the same GET), not to when this runner attached.
let sinceNav = 0;
try { sinceNav = await evaluate('performance.now()'); } catch (e) { evidence.notes.push(`nav clock: ${String(e)}`); }
const pageEpoch = Date.now() - (typeof sinceNav === 'number' ? sinceNav : 0);
evidence.navEpoch = pageEpoch;
const t0 = pageEpoch;
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
const playback = evidence.samples.some((s) => s.probe && s.probe.video && s.probe.video.src && s.probe.replica && s.probe.replica.appended > 0);
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
  } else if (exp.type === 'noReload') {
    // The extension writes two boot rows per page load (provenance + state).
    const boots = E('boot').filter((e) => e.d && e.d.href).map((e) => Math.round(e.t / 1000));
    const loads = [...new Set(boots)].length;
    check('no reload (one page load)', loads <= 1, { loads });
  } else if (exp.type === 'probe') {
    const p = probeAt(exp.at || 0);
    const v = exp.path.split('.').reduce((o, k) => (o == null ? o : o[k]), p);
    check(`probe ${exp.path} ${exp.op} ${JSON.stringify(exp.value)}`, exp.op === 'eq' ? v === exp.value : v, { got: v });
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
evidence.verdict = cannot > 0 ? 'CANNOT-MEASURE' : NO_EXT ? (controlOk ? 'CONTROL-PASS' : 'CONTROL-FAIL') : failures > 0 ? 'FAIL' : 'PASS';
const report = JSON.stringify(evidence, null, 2);
writeFileSync(join(runDir, 'report.json'), report);
if (OUT) writeFileSync(OUT, report);
console.log(`RESULT ${evidence.verdict} scenario=${scenario.name} checks=${evidence.checks.length} failed=${failures} cannot=${cannot} build=${evidence.build || 'n/a'} rows=${log.length}`);
console.log(`report ${join(runDir, 'report.json')}`);
cdp.close();
stopAll();
process.exit(evidence.verdict === 'PASS' || evidence.verdict === 'CONTROL-PASS' ? 0 : evidence.verdict === 'FAIL' || evidence.verdict === 'CONTROL-FAIL' ? 1 : 2);
