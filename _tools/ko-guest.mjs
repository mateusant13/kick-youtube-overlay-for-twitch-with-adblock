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
import { rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';

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

function killTree() {
  // Match BOTH profile families (ko-guest*, ko-harness-*) but only the browser
  // that owns OUR debug port. Leaving an old harness Chrome alive kept port
  // 9333 and served STALE extension files; killing by profile name instead
  // killed OTHER lanes' browsers mid-measurement (measured 2026-11-09: two
  // lanes lost their guest and one lost a running parity protocol to a `stop`
  // issued for an unrelated port).
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ' +
    `Where-Object { $_.CommandLine -like '*--remote-debugging-port=${PORT}*' } | ` +
    'ForEach-Object { taskkill /PID $($_.ProcessId) /T /F 2>&1 | Out-Null }';
  try {
    // windowsHide: a console-subsystem child spawned from a console-less parent
    // allocates a NEW console, and Windows presents it as a real window that
    // takes focus (owner report 2026-11-07: a terminal popped up on his screen
    // while this kill ran). The flag belongs on every level of the chain.
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  } catch {}
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(`${UDD}/${f}`, { force: true }); } catch {}
  }
}

if (process.argv[2] === 'stop') {
  try { rmSync(process.env.KO_MARKER || 'G:/Temp/ko-harness/guest.json', { force: true }); } catch {}
  killTree();
  log('stopped');
  process.exit(0);
}

if (process.argv[2] === 'status') {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
  URL_,
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

await sleep(3000);
const lu = await send('Extensions.loadUnpacked', { path: EXT.replaceAll('/', '\\') });
log('loadUnpacked', JSON.stringify(lu).slice(0, 300));
const extId = lu.result?.id || null;
if (!extId) { log('FATAL: extension did not load'); process.exit(2); }

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
    log('reload page for content scripts');
    await send('Page.navigate', { url: URL_ }, sess);
    await sleep(8000);
    const origins = [...ctxSink];
    log('worlds', JSON.stringify(origins));
    log('EXT INJECTED', origins.some(o => o.startsWith('chrome-extension://')));
  }
}
log('READY extId=' + extId + ' port=' + PORT);
await new Promise(() => {});
