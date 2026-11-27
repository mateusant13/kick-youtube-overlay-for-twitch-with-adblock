#!/usr/bin/env node
// ko-guest.mjs — isolated guest Chrome for Kick Overlay development.
// Loads the unpacked extension through the CDP Extensions domain (Chrome 137+
// ignores --load-extension). Keeps the pipe open; exposes a normal CDP port
// so other tools can attach. Never touches the user's C:\ChromeDebugProfile.
//
// Usage: node ko-guest.mjs start [url]
//        node ko-guest.mjs stop
//        node ko-guest.mjs status
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';

const CHROME = process.env.KO_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Under the harness's declared profile root (see ko-harness.mjs) so the disk
// census can measure it: artifact-census.py --own G:/Temp/ko-harness.
const UDD = process.env.KO_GUEST_UDD || 'G:/Temp/ko-harness/manual';
const EXT = process.env.KO_EXT_DIR || 'I:/kicktwitchyoutube_instagram/kick-overlay';
// 9446, never 9333: 9333 is the OWNER's Chrome relay port
// (browser.relayUrl). Attaching there drove his own browser and closed nine of
// his tabs on 2026-11-11 - a guest port that can collide with the relay is the
// defect, not the operator's typing.
const PORT = process.env.KO_GUEST_PORT || '9446';
const URL_ = process.argv[3] || process.env.KO_GUEST_URL || 'about:blank';
const HEADLESS = process.env.KO_HEADLESS !== '0';
const LOG = 'G:/Temp/opencode/ko-guest.log';

mkdirSync('G:/Temp/opencode', { recursive: true });
function log(...a) {
  const s = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { appendFileSync(LOG, s); } catch {}
  console.log(s.trimEnd());
}

function killTree(port = PORT) {
  // Match BOTH profile families (ko-guest*, ko-harness-*) but only the browser
  // that owns OUR debug port. Leaving an old harness Chrome alive kept port
  // 9333 and served STALE extension files; killing by profile name instead
  // killed OTHER lanes' browsers mid-measurement (measured 2026-11-09: two
  // lanes lost their guest and one lost a running parity protocol to a `stop`
  // issued for an unrelated port).
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ' +
    `Where-Object { $_.CommandLine -like '*--remote-debugging-port=${port}*' } | ` +
    'ForEach-Object { taskkill /PID $($_.ProcessId) /T /F 2>&1 | Out-Null }';
  try {
    // windowsHide: a console-subsystem child spawned from a console-less parent
    // allocates a NEW console, and Windows presents it as a real window that
    // takes focus (owner report 2026-11-07: a terminal popped up on his screen
    // while this kill ran). The flag belongs on every level of the chain.
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 60000, killSignal: 'SIGKILL', stdio: 'ignore', windowsHide: true });
  } catch {}
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(`${UDD}/${f}`, { force: true }); } catch {}
  }
}

if (process.argv[2] === 'stop') {
  // A marker FILENAME is not a contract (measured 2026-11-18): a guest launched
  // with `KO_MARKER=.../guest-9447.json` was invisible to this command, which
  // deleted the DEFAULT marker, killed nobody, and printed `stopped` while the
  // browser lived. Read every marker beside the default one, kill the tree for
  // each port a live marker names, delete every marker, and say what it did.
  const MK_DIR = 'G:/Temp/ko-harness';
  const found = [];
  try {
    for (const name of readdirSync(MK_DIR)) if (/^guest.*\.json$/.test(name)) found.push(`${MK_DIR}/${name}`);
  } catch { /* no marker directory is a fact to report, not a crash */ }
  if (process.env.KO_MARKER && !found.includes(process.env.KO_MARKER)) found.push(process.env.KO_MARKER);
  const ports = new Set([Number(PORT)]);
  const said = [];
  for (const file of found) {
    let j = null;
    try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable marker: delete and say so */ }
    let alive = false;
    if (j?.pid) { try { process.kill(Number(j.pid), 0); alive = true; } catch { /* dead pid */ } }
    if (alive) { ports.add(Number(j.port)); said.push(`killed pid ${j.pid} on port ${j.port} (${file})`); }
    else said.push(`stale marker ${file} (pid ${j?.pid ?? 'none'} not running)`);
    try { rmSync(file, { force: true }); } catch {}
  }
  for (const p of ports) killTree(p);
  for (const s of said) log(s);
  log(said.length ? 'stopped' : `nothing to stop: no guest marker in ${MK_DIR} and port ${PORT} freed`);
  process.exit(0);
}

if (process.argv[2] === 'status') {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    console.log(JSON.stringify({ up: true, browser: j.Browser, targets: list.map(t => ({ type: t.type, url: (t.url || '').slice(0, 100), id: t.id })) }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ up: false, error: String(e) }));
  }
  process.exit(0);
}

// start
killTree();
const args = [
  `--user-data-dir=${UDD}`,
  `--remote-debugging-port=${PORT}`,
  '--remote-debugging-pipe',
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  '--mute-audio',
  // Disk and renderer ceiling (watcher DM dm-d863c58ce100ac7d0843, 2026-11-09:
  // a guest doubled 15 procs/1.44 GB -> 31 procs/3.06 GB in twenty minutes on a
  // box the owner was already seeing black tabs on). A bounded cache keeps the
  // profile from growing without limit, and one visible page keeps the renderer
  // count flat.
  '--disk-cache-size=268435456',
  '--renderer-process-limit=4',
  '--autoplay-policy=no-user-gesture-required',
  ...(HEADLESS ? ['--headless=new', '--disable-gpu'] : ['--window-position=-32000,-32000', '--window-size=1366,900']),
  // A headless page has no user gesture, so Chrome's autoplay policy refuses
  // every unmute and reports it as `unmute-blocked` (measured 2026-11-08):
  // audio arms cannot be measured without this flag.
  '--autoplay-policy=no-user-gesture-required',
  // Replica harness (ko-replica): host-resolver mapping + a self-signed cert
  // need extra flags the live path must not carry. JSON array, additive only.
  ...(process.env.KO_GUEST_EXTRA_ARGS ? JSON.parse(process.env.KO_GUEST_EXTRA_ARGS) : []),
  // The destination is navigated to ONCE, after the extension is loaded
  // (2026-11-24). Launching Chrome on the URL and then navigating it again
  // loaded the page twice: the first load ran without the extension, was
  // thrown away, and cost a full network+render pass on a slow box.
  'about:blank',
];
log('chrome args', args.join(' '));
const child = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
// THE MARKER. A port alone does not say who is on the other end: 9333 was both
// this guest's default and the owner's relay port, so `status` attached to HIS
// Chrome and a cleanup closed nine of his tabs (2026-11-11). The guest records
// itself here, and the harness refuses a port that has no live marker.
const MARKER = process.env.KO_MARKER || 'G:/Temp/ko-harness/guest.json';
try {
  mkdirSync('G:/Temp/ko-harness', { recursive: true });
  writeFileSync(MARKER, JSON.stringify({ port: Number(PORT), pid: child.pid, udd: UDD, at: Date.now() }));
} catch {}
const clearMarker = () => { try { rmSync(MARKER, { force: true }); } catch {} };
process.on('exit', clearMarker);
child.stdio[2].on('data', (d) => { const s = String(d).trim(); if (s && !/TensorFlow|XNNPACK|Fontconfig/.test(s)) log('stderr', s.split('\n').slice(0, 3).join(' | ')); });
child.on('exit', (c) => { log('chrome exited', c); process.exit(0); });

const toChrome = child.stdio[3];
const fromChrome = child.stdio[4];
let buf = Buffer.alloc(0);
const pending = new Map();
const ctxSink = new Set();
fromChrome.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0)) >= 0) {
    const raw = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 1);
    let m; try { m = JSON.parse(raw); } catch { continue; }
    if (m.method === 'Runtime.executionContextCreated' && m.params?.context?.origin) ctxSink.add(m.params.context.origin);
    if (m.id !== undefined && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  }
});
let msgSeq = 0;
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++msgSeq;
  pending.set(i, res);
  toChrome.write(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }) + '\0');
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ __timeout: true, method }); } }, 20000);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome answers the pipe as soon as the browser target exists; 3 s was a
// guess that every start paid whether or not it was needed (2026-11-24).
for (let i = 0; i < 40; i++) {
  const t = await send('Target.getTargets', {});
  if ((t.result?.targetInfos || []).some((x) => x.type === 'page')) break;
  await sleep(200);
}
// The known-bad arm for the offline replica: no content scripts, no hooks, so a
// defending result there would be a harness that cannot fail. It skips the
// EXTENSION only — parking here instead of navigating left the guest on
// `about:blank` (measured 2026-11-25: `targets at refusal: page:about:blank`),
// which read as "the replica page never loaded".
let extId = null;
if (process.env.KO_NO_EXT === '1') {
  log('NO_EXT: extension not loaded on purpose');
} else {
  const lu = await send('Extensions.loadUnpacked', { path: EXT.replaceAll('/', '\\') });
  log('loadUnpacked', JSON.stringify(lu).slice(0, 300));
  extId = lu.result?.id || null;
  if (!extId) { log('FATAL: extension did not load'); process.exit(2); }
}

const tg = await send('Target.getTargets', {});
const pages = (tg.result?.targetInfos || []).filter((t) => t.type === 'page');
log('pages', JSON.stringify(pages.map(p => (p.url || '').slice(0, 100))));
if (pages.length) {
  const at = await send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
  const sess = at.result?.sessionId;
  if (sess) {
    await send('Page.enable', {}, sess);
    await send('Runtime.enable', {}, sess);
    ctxSink.clear();
    if (URL_ && URL_ !== 'about:blank') {
      log('navigate', URL_);
      await send('Page.navigate', { url: URL_ }, sess);
      // The fixed 8 s wait both overpaid on a fast load and underpaid under
      // load (2026-11-24). Poll the context list: the extension world appears
      // when the content script runs, and that is the only fact this step needs.
      const t0 = Date.now();
      let injected = false;
      // Without the extension there is no extension world to wait for: poll the
      // document instead, so the arm measures a loaded page and not a timeout.
      for (let i = 0; i < 120; i++) {
        if (process.env.KO_NO_EXT === '1') {
          const tl = await send('Target.getTargets', {});
          const pg = (tl.result?.targetInfos || []).find((x) => x.type === 'page' && String(x.url).startsWith('http'));
          if (pg) { injected = false; break; }
        } else if ([...ctxSink].some((o) => o.startsWith('chrome-extension://'))) { injected = true; break; }
        await sleep(250);
      }
      log('worlds', JSON.stringify([...ctxSink]));
      log('EXT INJECTED', injected, `(${Date.now() - t0}ms)`);
    } else {
      log('EXT INJECTED', 'n/a (about:blank)');
    }
  }
}
log('READY extId=' + (extId || 'none') + ' port=' + PORT);
await new Promise(() => {});
