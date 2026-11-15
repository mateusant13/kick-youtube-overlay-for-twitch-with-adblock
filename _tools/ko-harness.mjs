#!/usr/bin/env node
// ko-harness.mjs — one diagnostic harness for the Kick Overlay extension.
// (The check suite lives in ko-harness-check.mjs; the CDP client in ko-cdp.mjs.)
//
//   node _tools/ko-harness.mjs start [url] [--fresh]
//   node _tools/ko-harness.mjs check [--yt=<watch/live URL>] [--no-adblock]
//   node _tools/ko-harness.mjs state
//   node _tools/ko-harness.mjs set --player=youtube --yt=https://...
//   node _tools/ko-harness.mjs eval "KO.kickState" --world=isolated
//   node _tools/ko-harness.mjs click "#ko-golive" --real
//   node _tools/ko-harness.mjs shot [path]
//   node _tools/ko-harness.mjs net --pattern=googlevideo --seconds=10 --target=hls
//   node _tools/ko-harness.mjs console --seconds=5
//   node _tools/ko-harness.mjs stop
//
// Exit 0 = PASS/SKIP/WARN only; 1 = FAIL or exception.
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connect, findTargets, attach } from './ko-cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUEST = path.join(HERE, 'ko-guest.mjs');
// 9446, never 9333: that is the owner's Chrome relay (browser.relayUrl).
const PORT = Number(process.env.KO_PORT || 9446);
const OUT_DIR = 'G:/Temp/opencode';
const DEFAULT_URL = process.env.KO_GUEST_URL || 'https://www.twitch.tv/rodil';
const DEFAULT_YT = 'https://www.youtube.com/watch?v=3cOk_W3ewcE';
mkdirSync(OUT_DIR, { recursive: true });

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // Split on the FIRST '=' only: URLs/queries contain '=' (watch?v=...).
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const k = eq === -1 ? body : body.slice(0, eq);
      const v = eq === -1 ? undefined : body.slice(eq + 1);
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

// One declared root for every guest profile, and a cap so a day of runs cannot
// pile up gigabytes (2026-11-08: 15 profiles = 1424 MiB, all disposable).
const PROFILE_ROOT = process.env.KO_PROFILE_ROOT || 'G:/Temp/ko-harness';
// Keep the run that just ended plus one previous, and no more: an old profile
// silently serves the PREVIOUS extension build (see ko-guest.mjs killTree), so
// a growing pile is both disk and a false build. Steady state = 2 profiles.
const KEEP_PROFILES = 1;

function pruneProfiles(keep = KEEP_PROFILES) {
  let names = [];
  try {
    names = readdirSync(PROFILE_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'profile' && e.name !== 'manual')
      .map((e) => e.name)
      .sort();
  } catch (e) { console.log(`[harness] profile prune skipped: ${String(e && e.message).slice(0, 60)}`); return; }
  const drop = names.slice(0, Math.max(0, names.length - keep));
  for (const name of drop) {
    try { rmSync(path.join(PROFILE_ROOT, name), { recursive: true, force: true }); } catch { /* in use */ }
  }
}

const GUEST_MARKER = process.env.KO_MARKER || 'G:/Temp/ko-harness/guest.json';

// A live CDP port is not enough to call something a guest: the owner's Chrome
// answers on its relay port too, and treating that as a guest drove his browser
// (measured 2026-11-11: nine of his tabs closed). The marker is written by the
// guest launcher and deleted by its stop, and the pid must still be alive.
function guestMarker() {
  try {
    const j = JSON.parse(readFileSync(GUEST_MARKER, 'utf8'));
    if (Number(j.port) !== PORT) return null;
    try { process.kill(Number(j.pid), 0); } catch { return null; }
    return j;
  } catch { return null; }
}

async function guestUp(timeout = 1500) {
  if (!guestMarker()) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch { return false; }
}

// A guest Chrome that survives its own `stop` keeps the debug PORT bound, and
// the next start cannot open the devtools http server at all: measured
// 2026-11-09, two starts in a row died with `bind() returned an error` and
// `Cannot start http server for devtools`, and the harness then reported
// "guest Chrome did not open the CDP port" for eight minutes while a chrome
// tree sat on the port. `stop` now waits for the port and kills whoever holds
// it (chrome.exe on the guest's own port only; the owner's browser is 9222).
function portHolders() {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  const pids = new Set();
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (!line.includes(`:${PORT} `)) continue;
    const m = line.trim().match(/\s(\d+)\s*$/);
    if (m) pids.add(Number(m[1]));
  }
  pids.delete(0);
  return [...pids];
}

function commandLineOf(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '');
}

// Kill a leftover guest Chrome that holds THIS port. Two guards, both paid for
// by measurement (2026-11-09): the pid must be a chrome.exe AND its command
// line must carry `--remote-debugging-port=<PORT>` - without the second guard a
// 500 ms timeout on a healthy guest (a loaded machine) read as "stale" and the
// loop killed the guest it had just started, ten times in a row.
async function freePort({ quiet = false } = {}) {
  for (let i = 0; i < 6; i++) {
    const holders = portHolders();
    if (!holders.length) return true;
    let killedAny = false;
    for (const pid of holders) {
      const cl = commandLineOf(pid);
      if (!/chrome\.exe/i.test(cl) || !cl.includes(`--remote-debugging-port=${PORT}`)) continue;
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
      if (!quiet) console.log(`[harness] freed port ${PORT} from chrome pid ${pid}`);
      killedAny = true;
      break;
    }
    if (!killedAny) return false; // the holder is not ours: leave it alone and let start() report
    await delay(800);
  }
  return portHolders().length === 0;
}

async function stopGuest() {
  const r = spawnSync(process.execPath, [GUEST, 'stop'], { encoding: 'utf8', windowsHide: true });
  process.stdout.write((r.stdout || '').trim() + '\n');
  await freePort();
}

// ONE guest browser per box. A second one doubles the process count and the
// RSS for no measurement that the first cannot do (watcher DM, 2026-11-09).
// Reuse is cheap: KO_PORT names the browser, and every command attaches to it.
const GUEST_PORTS = [9444, 9445, 9446, 9447, 9448, 9449];
const flagsAllowSecondGuest = process.argv.includes('--second-guest');

async function otherGuestAlive() {
  for (const port of GUEST_PORTS) {
    if (port === PORT) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (String(j['Browser'] || '').includes('Chrome')) return port;
      }
    } catch { /* not this one */ }
  }
  return null;
}

async function ensureGuest({ fresh = false, url = DEFAULT_URL, quiet = false } = {}) {
  if (!(await guestUp())) {
    const busy = await otherGuestAlive();
    if (busy && !flagsAllowSecondGuest) {
      throw new Error(`a guest browser is already running on port ${busy}; reuse it with KO_PORT=${busy} (one guest per box - ceiling declared in AGENTS.md)`);
    }
    await freePort({ quiet });
  }
  if (await guestUp()) {
    if (!fresh) return;
    stopGuest();
    await delay(1200);
  }
  // Every profile this project creates lives under ONE root so it can be
  // declared to the disk census (`artifact-census.py --own G:/Temp/ko-harness`,
  // owner order 2026-11-08). A per-run directory outside a declared root is
  // invisible to a `du` of the checkout: 15 throwaway profiles measured
  // 1424 MiB on G: while the project read as 41 MiB.
  const udd = fresh
    ? path.join(PROFILE_ROOT, new Date().toISOString().replace(/[:.]/g, '-'))
    : (process.env.KO_GUEST_UDD || path.join(PROFILE_ROOT, 'profile'));
  if (fresh) pruneProfiles(KEEP_PROFILES);
  if (!quiet) console.log(`[harness] starting guest Chrome profile=${udd}`);
  const child = spawn(process.execPath, [GUEST, 'start', url], {
    env: { ...process.env, KO_GUEST_UDD: udd, KO_GUEST_PORT: String(PORT) },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 45000) {
    if (await guestUp()) return;
    await delay(1000);
  }
  throw new Error('guest Chrome did not open the CDP port');
}

// The owner's Chrome and the guest are both CDP endpoints, and a collapsed port
// default made `ko-harness status` attach to HIS browser (measured 2026-11-11:
// a cleanup closed nine of his tabs). The relay extension id is an unambiguous
// marker: a browser that carries it is his, never a measurement target.
const RELAY_EXT_ID = 'jdphdacdpdgbfdcolnnlangmpfajejno';
async function assertNotOwnerBrowser(cdp) {
  const ids = new Set();
  let infos = [];
  try {
    const r = await cdp.send('Target.getTargets');
    infos = r.targetInfos || [];
  } catch { /* older CDP shape */ }
  for (const t of infos) {
    const u = String(t.url || '');
    if (u.includes(RELAY_EXT_ID)) ids.add(t.targetId);
  }
  if (ids.size) {
    throw new Error(
      `refusing to drive the OWNER's browser on port ${PORT}: the relay extension (${RELAY_EXT_ID}) is loaded there. ` +
        'A guest is a different browser on a different port (KO_PORT, default 9446).',
    );
  }
}

async function openSessions({ requireKo = true } = {}) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < 45000) {
    try {
      const cdp = await connect(PORT);
      await assertNotOwnerBrowser(cdp);
      const t = await findTargets(cdp, { pageRe: /twitch\.tv|youtube\.com/ });
      if (!t.page) throw new Error('no Twitch/YouTube page target');
      const page = await attach(cdp, t.page, 'page');
      page.cdp = cdp;
      await page.enable({ page: true });
      // The content script may still be loading after the guest's reload.
      let ko = false;
      try { ko = await page.evalIsolated('typeof KO !== "undefined" && !!KO'); } catch { /* no isolated ctx yet */ }
      if (requireKo && !ko) throw new Error('content script not injected yet');
      const sw = await attach(cdp, t.sw, 'sw');
      const hls = await attach(cdp, t.hls, 'hls');
      const ivs = await attach(cdp, t.ivs, 'ivs');
      if (hls) await hls.enable({ network: true });
      if (ivs) await ivs.enable();
      if (sw) await sw.enable();
      return { cdp, targets: t, page, sw, hls, ivs };
    } catch (e) {
      lastErr = e;
      await delay(1000);
    }
  }
  throw new Error(`openSessions: ${lastErr?.message || 'timeout'}`);
}

async function refreshIframes(s) {
  const t = await findTargets(s.cdp, { pageRe: /twitch\.tv|youtube\.com/ });
  if (t.hls && (!s.hls || s.hls.targetId !== t.hls.targetId)) {
    s.hls = await attach(s.cdp, t.hls, 'hls');
    await s.hls.enable({ network: true });
  }
  if (t.ivs && (!s.ivs || s.ivs.targetId !== t.ivs.targetId)) {
    s.ivs = await attach(s.cdp, t.ivs, 'ivs');
    await s.ivs.enable();
  }
  // A frame that went away leaves a session id the browser no longer knows:
  // every later probe then fails with "Session with given id not found" and the
  // audit reports an error row instead of "no such surface" (measured
  // 2026-11-09 after switching from the kick player to the native one).
  if (!t.hls && s.hls) s.hls = null;
  if (!t.ivs && s.ivs) s.ivs = null;
  return s;
}

const STATE_EXPR = `(() => {
  const out = { href: location.href, readyState: document.readyState };
  if (typeof KO !== 'undefined' && KO) {
    const pill = document.getElementById('ko-golive');
    out.ko = {
      enabled: KO.enabled, player: KO.player, playerPreference: KO.playerPreference,
      slug: KO.slug, kickSlug: KO.kickSlug, ytRaw: KO.ytRaw, ytId: KO.ytId,
      ytHls: String(KO.ytHlsUrl || '').slice(0, 100), ytHlsFailed: KO.ytHlsFailed,
      kickReady: KO.kickReady, kickState: KO.kickState, kickOnDvr: KO.kickOnDvr,
      // Which url the frame was last told to load, and how long ago. Without
      // this a "go live" that silently re-loads the DVR url is indistinguishable
      // from one that loaded the live url and stalled.
      kickUrl: KO.activeUrl ? String(KO.activeUrl).slice(-46) : null,
      kickUrlAgeMs: KO.kickUrlT ? Date.now() - KO.kickUrlT : null,
      kickDvrUrl: KO.kickDvrUrl ? String(KO.kickDvrUrl).slice(-46) : null,
      kickDur: KO.kickDur, yt: KO.ytState, adblock: KO.adblock,
      wrap: KO.wrap ? { cls: KO.wrap.className, display: KO.wrap.style.display } : null,
      pill: pill ? {
        display: getComputedStyle(pill).display,
        pointerEvents: getComputedStyle(pill).pointerEvents,
        text: pill.textContent,
      } : null,
    };
  }
  const v = document.querySelector('video');
  out.twitchVideo = v ? { paused: v.paused, muted: v.muted, ct: v.currentTime, rs: v.readyState, dur: v.duration } : null;
  return out;
})()`;

const ADBLOCK_EXPR = `({
  stats: window.__koTwitchAdblockStats || null,
  flag: window.__koTwitchAdblock === true,
  attr: document.documentElement.getAttribute('data-ko-adblock'),
  worker: String(window.Worker).slice(0, 60),
})`;

async function getState(s) {
  const page = await s.page.evalIsolated(STATE_EXPR);
  let adblock = null;
  try { adblock = await s.page.evalMain(ADBLOCK_EXPR); } catch { /* main world not ready */ }
  let hlsVideo = null;
  if (s.hls) {
    try {
      hlsVideo = await s.hls.evalRaw(`(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        const s = []; for (let i = 0; i < v.seekable.length; i++) s.push([v.seekable.start(i), v.seekable.end(i)]);
        const b = []; for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i), v.buffered.end(i)]);
        return { ct: v.currentTime, dur: v.duration, paused: v.paused, rs: v.readyState, ended: v.ended, muted: v.muted, seekable: s, buffered: b };
      })()`);
    } catch { /* frame gone */ }
  }
  return { ...page, adblock, hlsVideo };
}

// ONE LINE for "which source is the picture coming from, and where is it".
// This is the question behind every stall/go-live report, and answering it used
// to need a join across `state`, the frame's target and the adlog. The three
// facts that decide it: the source the frame was last told to load (live vs
// replay), the position it reports, and whether that position is MOVING.
const SOURCE_EXPR = `(async () => {
  const out = { at: Date.now() };
  if (typeof KO === 'undefined' || !KO) return { err: 'no KO' };
  const st = KO.kickState || null;
  out.ver = typeof KO_VER === 'string' ? KO_VER : null;
  out.player = KO.player;
  out.enabled = !!KO.enabled;
  out.source = KO.kickOnDvr ? 'replay' : 'live';
  out.url = KO.activeUrl ? String(KO.activeUrl).slice(-44) : null;
  out.urlAgeMs = KO.kickUrlT ? Date.now() - KO.kickUrlT : null;
  out.dvrUrl = KO.kickDvrUrl ? String(KO.kickDvrUrl).slice(-44) : null;
  out.dvrTarget = KO.kickDvrTarget;
  out.dvrDur = KO.kickDvrDur;
  out.pos = st ? +Number(st.pos || 0).toFixed(2) : null;
  out.state = st ? st.state : null;
  out.dur = st ? +Number(st.dur || 0).toFixed(1) : null;
  out.lat = st ? +Number(st.lat || 0).toFixed(2) : null;
  out.paused = st ? !!st.paused : null;
  out.reconnectCount = KO.reconnectCount;
  out.stableSince = KO.stableSince;
  // MOVING is the decisive field: a frozen element keeps reporting Playing, and
  // that is the whole defect class this command exists for.
  const p0 = out.pos;
  await new Promise((r) => setTimeout(r, 1200));
  const st2 = KO.kickState || null;
  out.posAfter = st2 ? +Number(st2.pos || 0).toFixed(2) : null;
  out.movedSec = out.posAfter !== null && p0 !== null ? +(out.posAfter - p0).toFixed(2) : null;
  out.verdict = out.movedSec === null ? 'CANNOT-MEASURE'
    : out.movedSec > 0.3 ? 'MOVING'
    : (out.state === 'Playing' ? 'FROZEN (reports Playing, clock still)' : 'NOT PLAYING');
  return out;
})()`;

async function setConfig(s, cfg) {
  const payload = JSON.stringify(cfg);
  const res = await s.page.evalIsolated(`new Promise((res) => {
    chrome.storage.local.get('ko.v2', (o) => {
      const st = o['ko.v2'] || {};
      const cfg = ${payload};
      if (cfg.enabled !== undefined) st.enabled = !!cfg.enabled;
      if (cfg.player) st.player = cfg.player;
      if (cfg.yt) {
        st.mappings = { ...(st.mappings || {}) };
        st.mappings[st.slug || cfg.slug || 'rodil'] = { ...(st.mappings[st.slug || cfg.slug || 'rodil'] || {}), yt: cfg.yt };
      }
      if (cfg.ytId) {
        st.mappings = { ...(st.mappings || {}) };
        st.mappings[st.slug || cfg.slug || 'rodil'] = { ...(st.mappings[st.slug || cfg.slug || 'rodil'] || {}), ytId: cfg.ytId };
      }
      chrome.storage.local.set({ 'ko.v2': st }, () => res(st));
    });
  })`);
  return res;
}

function printState(st) {
  console.log(JSON.stringify(st, null, 2));
}

function usage() {
  console.log(`ko-harness commands:
  start [url] [--fresh]          start guest Chrome (fresh profile optional)
  stop                           stop guest Chrome
  status                         guest up? + targets
  state                          KO + adblock + iframe snapshot
  source                          WHICH source the picture comes from (live vs replay), its position,
                                 and whether that position is MOVING — one line, no log join. Reads
                                 the clock twice, 1.2 s apart, and prints MOVING / FROZEN / NOT PLAYING,
                                 because a frozen element keeps reporting Playing (the 2026-11-13 class).
  check [--yt=URL] [--no-adblock] end-to-end PASS/FAIL suite
  set --player=kick|youtube|twitch [--yt=URL] [--enabled=1|0]
  eval "<expr>" [--world=isolated|main] [--target=page|sw|hls|ivs]
  click "<selector>" [--real]    real mouse or synthetic click
  key ArrowLeft|ArrowRight|f     real CDP key event (overlay handler test)
  scrolltest [--width=1600 --height=900 --y=600]   scroll-anchor regression
  tabmute [url]                  TWO tabs on one live channel: mute tab A, prove tab B keeps its sound
  muteauthor                     who moved the sound: his pointer, our bar, or the machine (refused)
                                 - reads the origin field the debug verdict also reads
  extreload                      reload the EXTENSION (chrome.runtime.reload) then the page, and print
                                 the version the tab is actually running (a page reload alone keeps
                                 the OLD content script: Chrome caches extension files until the
                                 extension itself reloads - measured 2026-11-09)
  watch [--seconds=N]            transitions of {visible, intent(twitch/kick/yt), native muted+volume}
                                 sampled twice a second, printed only when the tuple changes. This is
                                 how a silent mute gets a timestamp instead of a guess.
  live [--port=9222] [--channel=a,b] [--json]
                                 WHICH channels are broadcasting right now. Node queries Twitch's
                                 GQL directly; --port names the browser whose cookies give the
                                 FOLLOWED list (read-only, no tab created or touched). Named
                                 channels need no session. Use this instead of guessing a channel.
  parity-ab [--channel=NAME]     A/B against kick.com's OWN player (in the guest browser)
  parity-live [--channel=NAME] [--port=9222]  the same A/B in HIS Chrome, own background tabs only, never activates his
  kickparity                     kick.com playback parity: pause, resume, arrow seek, 10s/60s rewind, seek inside the DVR, go live, quality, latency
  shot [path]                    PNG screenshot
  net --pattern=RE --seconds=N [--target=hls|page|sw]
  console [--seconds=N]          captured errors from page/hls/sw`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { _: pos, flags } = parseArgs(argv);
  const cmd = pos[0] || 'help';

  if (cmd === 'help' || flags.help) { usage(); return; }
  if (cmd === 'start') {
    const want = pos[1] || DEFAULT_URL;
    await ensureGuest({ fresh: !!flags.fresh, url: want });
    console.log('[harness] guest up; waiting for content script…');
    const s = await openSessions();
    // `start <url>` on an ALREADY running guest used to ignore the url and
    // leave the tab wherever it was - measured 2026-11-09: `start
    // https://www.twitch.tv/titiltei` answered href=https://www.twitch.tv/,
    // and every later reading (kickState null, no bar) was measured against a
    // page with no channel. Navigate when the tab is elsewhere, always.
    let st = await getState(s);
    if (want && st.href && st.href.replace(/\/$/, '') !== want.replace(/\/$/, '')) {
      try {
        await s.page.cdp.send('Page.navigate', { url: want }, s.page.sessionId);
      } catch { /* older CDP shape */ }
      for (let i = 0; i < 40; i++) {
        await delay(500);
        st = await getState(s);
        if (st.href && st.href.startsWith('http') && st.href !== 'about:blank' && st.ko) break;
      }
      for (let i = 0; i < 40; i++) {
        await delay(500);
        st = await getState(s);
        if (st.ko && st.ko.enabled) break;
      }
    }
    console.log('[harness] ready', JSON.stringify({ href: st.href, ko: !!st.ko, enabled: st.ko?.enabled, player: st.ko?.player }));
    s.cdp.close();
    return;
  }
  if (cmd === 'stop') { await stopGuest(); return; }
  if (cmd === 'status') {
    const up = await guestUp();
    if (!up) {
      console.log(JSON.stringify({ up: false, port: PORT }, null, 2));
      return;
    }
    const cdp0 = await connect(PORT);
    try {
      await assertNotOwnerBrowser(cdp0);
    } catch (e) {
      cdp0.close();
      console.log(JSON.stringify({ up: false, port: PORT, refused: e.message }, null, 2));
      return;
    }
    cdp0.close();
    console.log(JSON.stringify({ up, port: PORT }, null, 2));
    if (up) {
      const cdp = await connect(PORT);
      const t = await findTargets(cdp, { pageRe: /twitch\.tv|youtube\.com/ });
      console.log(JSON.stringify({
        page: t.page?.url, hls: t.hls?.url?.slice(0, 100), ivs: t.ivs?.url?.slice(0, 100), sw: t.sw?.url,
      }, null, 2));
      cdp.close();
    }
    return;
  }

  // `parity-live` runs in the OWNER'S Chrome with his profile and opens its own
  // background tabs, so it must neither start nor attach to the guest browser.
  const needsGuest = cmd !== 'parity-live';
  // Commands below need a live page + content script. Start the guest if it is
  // not up yet; --fresh always replaces the profile with clean extension code.
  if (needsGuest && (!(await guestUp()) || flags.fresh)) {
    await ensureGuest({ fresh: !!flags.fresh, url: flags.url || DEFAULT_URL });
  }
  const s = needsGuest ? await openSessions() : null;

  if (cmd === 'state') { printState(await getState(s)); s.cdp.close(); return; }

  if (cmd === 'source') {
    const o = await s.page.evalIsolated(SOURCE_EXPR);
    console.log(JSON.stringify(o, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'set') {
    const cfg = {
      player: flags.player,
      yt: flags.yt,
      ytId: flags['yt-id'],
      enabled: flags.enabled === undefined ? undefined : String(flags.enabled) !== '0',
      slug: flags.slug,
    };
    const st = await setConfig(s, cfg);
    console.log('[harness] storage', JSON.stringify({ player: st.player, enabled: st.enabled, mappings: st.mappings }));
    if (flags.reload) await s.page.reload();
    console.log('[harness] state', JSON.stringify((await getState(s)).ko));
    s.cdp.close();
    return;
  }

  if (cmd === 'eval') {
    const expr = pos[1];
    if (!expr) throw new Error('eval needs an expression');
    const target = flags.target || 'page';
    const world = flags.world || (target === 'page' ? 'isolated' : 'main');
    let val;
    if (target === 'page') val = world === 'main' ? await s.page.evalMain(expr) : await s.page.evalIsolated(expr);
    else if (target === 'sw') val = await s.sw.evalRaw(expr, { contextId: s.sw.mainContext()?.id });
    else if (target === 'hls') val = await s.hls.evalRaw(expr, { contextId: s.hls.mainContext()?.id });
    else if (target === 'ivs') val = await s.ivs.evalRaw(expr, { contextId: s.ivs.mainContext()?.id });
    else throw new Error(`unknown target ${target}`);
    console.log(JSON.stringify(val, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'click') {
    const selector = pos[1];
    if (!selector) throw new Error('click needs a selector');
    const r = await s.page.click(selector, { real: !flags.synthetic, settle: Number(flags.settle || 800) });
    console.log(JSON.stringify(r, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'key') {
    const key = pos[1];
    if (!key) throw new Error('key needs a key name (e.g. ArrowLeft)');
    const vk = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, f: 70 }[key];
    if (!vk) throw new Error(`unsupported key ${key}`);
    const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await s.page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, s.page.sessionId);
    await s.page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s.page.sessionId);
    await delay(Number(flags.wait || 1200));
    console.log(JSON.stringify({ sent: key }, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'scrolltest') {
    const w = Number(flags.width || 1600);
    const hh = Number(flags.height || 900);
    const y = Number(flags.y || 600);
    await s.page.setViewport(w, hh);
    await delay(800);
    const before = await s.page.evalMain('({innerWidth,innerHeight,docH:document.documentElement.scrollHeight,bodyH:document.body.scrollHeight,scrollY,bodyOverflow:getComputedStyle(document.body).overflow})');
    // Force a real document scroll even when Twitch's layout pins the body.
    await s.page.evalMain(`(() => {
      document.documentElement.style.height = '2000px';
      document.body.style.height = '2000px';
      document.body.style.overflow = 'auto';
      window.scrollTo(0, ${y});
      return true;
    })()`);
    await delay(1200);
    const after = await s.page.evalIsolated('({scrollY,wrapTop:+KO.wrap.getBoundingClientRect().top.toFixed(1),anchorTop:+(twitchAnchorRect()?.top||0).toFixed(1),wrapH:+KO.wrap.getBoundingClientRect().height.toFixed(1),anchorH:+(twitchAnchorRect()?.height||0).toFixed(1),display:KO.wrap.style.display})');
    await s.page.evalMain(`(() => { document.documentElement.style.height=''; document.body.style.height=''; document.body.style.overflow=''; window.scrollTo(0,0); return true; })()`);
    console.log(JSON.stringify({ before, after }, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'shot') {
    const file = pos[1] || path.join(OUT_DIR, `ko-harness-${Date.now()}.png`);
    await s.page.setViewport(Number(flags.width || 1600), Number(flags.height || 900));
    await delay(800);
    await s.page.screenshot(file);
    console.log(file);
    s.cdp.close();
    return;
  }

  if (cmd === 'net') {
    const pattern = new RegExp(flags.pattern || '.', 'i');
    const seconds = Number(flags.seconds || 8);
    const target = flags.target || 'hls';
    const sess = target === 'hls' ? s.hls : target === 'ivs' ? s.ivs : target === 'sw' ? s.sw : s.page;
    if (!sess) throw new Error(`${target} session not attached`);
    await sess.cdp.send('Network.enable', {}, sess.sessionId);
    sess.network = [];
    await delay(seconds * 1000);
    const rows = sess.network.filter((n) => pattern.test(n.url));
    const summary = new Map();
    for (const n of rows.filter((r) => r.kind === 'res')) summary.set(n.status, (summary.get(n.status) || 0) + 1);
    console.log(JSON.stringify({
      target, count: rows.length, statuses: Object.fromEntries(summary),
      rows: rows.slice(-80).map((r) => ({ kind: r.kind, status: r.status, mime: r.mime, error: r.error, url: String(r.url).slice(0, 180) })),
    }, null, 2));
    s.cdp.close();
    return;
  }

  if (cmd === 'console') {
    const seconds = Number(flags.seconds || 5);
    await delay(seconds * 1000);
    console.log(JSON.stringify({
      page: { exceptions: s.page.exceptions, console: s.page.console },
      hls: s.hls ? { exceptions: s.hls.exceptions, console: s.hls.console } : null,
      ivs: s.ivs ? { exceptions: s.ivs.exceptions, console: s.ivs.console } : null,
      sw: s.sw ? { exceptions: s.sw.exceptions, console: s.sw.console } : null,
    }, null, 2));
    s.cdp.close();
    return;
  }

  // ---- tabmute: the owner's per-tab audio report (2026-11-08) -------------
  // "mutar uma aba e todas mutarem. e vice versa." Opens a SECOND tab on the
  // same channel, mutes tab A through the arbiter's real gesture path (a
  // volumechange the extension did not write, which is what Twitch's own volume
  // button produces), and reads tab B's intent and native element. Prints the
  // numbers and exits 1 if the gesture crossed the tab boundary.
  // ---- live: the ONE way to answer "what is on air" ----------------------
  // Owner order 2026-11-09: "para de dar guess em stream. faz um mecanismo que
  // tu vai usar sempre pra ver que lives tao online". Node has no CORS, so the
  // query runs here; the logged-in view comes from the owner's own cookies read
  // over CDP (read-only: no tab is created, navigated or closed). Named channels
  // need no session at all, so this works on any machine.
  // ---- extreload ----------------------------------------------------------
  if (cmd === 'extreload') {
    try { await s.page.evalIsolated('chrome.runtime.reload(); 1'); } catch { /* the world dies with it */ }
    await delay(2500);
    try {
      const cdp = await connect(PORT);
      const t = await findTargets(cdp, { pageRe: /twitch\.tv|youtube\.com/ });
      cdp.close();
      if (!t.page) throw new Error('no page target');
    } catch { /* fall through to the reload below */ }
    const cdp2 = await connect(PORT);
    const tg = await findTargets(cdp2, { pageRe: /twitch\.tv|youtube\.com/ });
    cdp2.close();
    if (!tg.page) throw new Error('no Twitch/YouTube tab to reload');
    const cdp3 = await connect(PORT);
    const page = await attach(cdp3, tg.page, 'page');
    await page.enable({ page: true });
    await page.reload();
    const ver = await page.waitFor('typeof KO !== "undefined" && KO_VER', (v) => !!v, { timeout: 30000, label: 'content script after extreload' })
      .catch(() => null);
    const audio = await page.evalIsolated('typeof KOAudio !== "undefined" ? "KOAudio" : "no-audio"').catch(() => '?');
    console.log(JSON.stringify({ koVer: ver, audio, href: await page.evalMain('location.href').catch(() => null) }));
    cdp3.close();
    return;
  }

  // ---- watch: who changed the sound, and when ----------------------------
  if (cmd === 'watch') {
    const seconds = Number(flags.seconds || 15);
    const sample = `(() => {
      const a = window.KOAudio;
      if (!a) return null;
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      return {
        vis: a.visible(),
        tw: a.intent('twitch'), kick: a.intent('kick'), yt: a.intent('yt'),
        want: a.wanted(a.visible() || 'twitch'),
        el: v ? { muted: v.muted, volume: +Number(v.volume).toFixed(2), paused: v.paused } : null,
        ui: { kickMuted: KO.kickMuted, ytMuted: KO.ytMuted },
      };
    })()`;
    let last = '';
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      let cur = '';
      try { cur = JSON.stringify(await s.page.evalIsolated(sample)); } catch { cur = '"no-arbiter"'; }
      if (cur !== last) {
        console.log(`+${String(Date.now() - t0).padStart(5)}ms ${cur.replace(/^"|"$/g, '')}`);
        last = cur;
      }
      await delay(500);
    }
    s.cdp.close();
    return;
  }

  if (cmd === 'audio') {
    let probeSessions = null;
    let seenSurfaces = null;
    // ONE question, every surface: "what is making sound right now, and is it
    // more than one thing?" Owner report 2026-11-09 asks for exactly three
    // answers (muted at the right moment, duplicated audio, cross-platform
    // overlap) and each one is a COUNT of audible surfaces, so the count is the
    // shape this command prints. Every media element is read in the process
    // that owns it: the page (Twitch's native video), the clean ad frame, and
    // each overlay frame (kick / YouTube) are separate CDP targets, and a
    // cross-origin frame's element cannot be read from the page at all.
    const PROBE = `(() => {
      const out = [];
      const vis = (el) => {
        let n = el, op = 1;
        for (let i = 0; i < 6 && n; i++, n = n.parentElement) op *= Number(getComputedStyle(n).opacity || 1);
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { area: Math.round(r.width) * Math.round(r.height), op: +op.toFixed(3), hidden: cs.display === 'none' || cs.visibility === 'hidden' };
      };
      for (const el of document.querySelectorAll('video,audio')) {
        const v = vis(el);
        out.push({
          src: String(el.currentSrc || el.src || '').slice(0, 70),
          muted: !!el.muted, volume: +Number(el.volume).toFixed(2), paused: !!el.paused,
          ct: +Number(el.currentTime).toFixed(1), rs: el.readyState, ...v,
        });
      }
      return { href: location.href, origin: location.origin, els: out };
    })()`;
    const seconds = Number(flags.seconds || 20);
    const audible = (e) => e && !e.muted && e.volume > 0 && !e.paused && e.area > 0 && e.op > 0.05 && !e.hidden;
    const sample = async () => {
      // The three surfaces are the ones the extension can make sound with:
      // the page's own player (Twitch native), and the two extension frames
      // (the clean ad player and the kick/YouTube overlay player). They live in
      // separate targets because they are separate processes; openSessions
      // already holds those sessions, and re-attaching here would cost seconds
      // per sample (Runtime.enable on a throttled frame).
      await refreshIframes(s);
      const rows = [];
      const probes = [['PAGE', s.page], ['OVERLAY-hls', s.hls], ['OVERLAY-ivs', s.ivs]];
      // A surface that disappears must not read as silence: a torn-down kick
      // frame with the native player audible printed `ONE` and looked healthy
      // (found by the 2026-11-09 audio lane in its own gate-doubt). Remember
      // which surfaces existed and report the missing ones.
      seenSurfaces = seenSurfaces || new Set();
      for (const [label, sess] of probes) if (sess) seenSurfaces.add(label);
      const missing = [...seenSurfaces].filter((l) => !probes.find(([n, x]) => n === l && x));
      for (const [label, sess] of probes) {
        if (!sess) continue;
        let r = null;
        // The page has an isolated world (the content script); the extension
        // frames are extension pages and have only the main one.
        const run = async () => {
          try { return await sess.evalIsolated(PROBE); } catch { return await sess.evalMain(PROBE); }
        };
        try {
          r = await run();
        } catch (e) {
          // A page reload replaces the execution context; the session still
          // holds the dead id and would report an error row forever (measured
          // 2026-11-09 across a reload during a soak). Refresh once, then retry.
          if (/context/i.test(String(e.message))) {
            try { await sess.refreshContexts(); r = await run(); } catch (e2) { rows.push({ label, origin: '-', href: 'probe error: ' + e2.message, els: [] }); continue; }
          } else { rows.push({ label, origin: '-', href: 'probe error: ' + e.message, els: [] }); continue; }
        }
        if (!r) { rows.push({ label, origin: '-', href: 'no result', els: [] }); continue; }
        rows.push({ label, origin: r.origin, href: String(r.href).slice(0, 90), els: r.els });
      }
      let ui = null;
      try {
        ui = await s.page.evalIsolated(`(() => {
          const a = window.KOAudio;
          const cover = document.getElementById('ko-adfix-cover');
          const adfix = document.getElementById('ko-adfix');
          return {
            vis: a ? a.visible() : null,
            intent: a ? { tw: a.intent('twitch'), kick: a.intent('kick'), yt: a.intent('yt') } : null,
            ad: {
              frame: !!adfix,
              frameRect: adfix ? (() => { const b = adfix.getBoundingClientRect(); return [b.left | 0, b.top | 0, b.width | 0, b.height | 0]; })() : null,
              coverPainted: !!cover && getComputedStyle(cover).display !== 'none',
              coverText: cover ? cover.textContent : null,
            },
            bar: (() => { const b = document.getElementById('ko-bar'); return b ? getComputedStyle(b).display : null; })(),
          };
        })()`);
      } catch { /* no arbiter */ }
      // A surface that was never there is not "silent": if the overlay SAYS it
      // is showing the kick layer and no kick frame exists, the honest verdict
      // is MISSING - `ONE` on the native player is the wrong answer (measured
      // 2026-11-09: `player=kick` with no kick frame mounted printed ONE).
      try {
        if (ui && ui.vis === 'kick' && !probes.find(([n, x]) => n === 'OVERLAY-ivs' && x) && !missing.includes('OVERLAY-ivs')) missing.push('OVERLAY-ivs');
        if (ui && (ui.vis === 'yt' || ui.vis === 'page') && !probes.find(([n, x]) => n === 'OVERLAY-hls' && x) && !missing.includes('OVERLAY-hls')) missing.push('OVERLAY-hls');
        if (ui && ui.vis === 'twitch' && !s.page) missing.push('PAGE');
      } catch { /* no ui: nothing to expect */ }
      const live = [];
      for (const row of rows) for (const e of row.els) if (audible(e)) live.push(`${row.label}/${row.origin.replace('https://', '')}/${e.src.replace(/^.*\//, '').slice(0, 28)}`);
      const outs = rows;
      const verdict = missing.length
        ? `MISSING(${missing.join(',')})${live.length ? '+AUDIBLE(' + live.length + ')' : ''}`
        : (live.length === 0 ? 'SILENT' : (live.length === 1 ? 'ONE' : `DUPLICATED(${live.length})`));
      return { live, verdict, missing, ui, rows: outs };
    };
    let last = '';
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      let cur;
      try { cur = await sample(); } catch (e) { cur = { err: e.message }; }
      const key = JSON.stringify({ v: cur.verdict, live: cur.live, miss: cur.missing, el: (cur.rows || []).map((r) => r.els.map((e) => [r.label, e.muted, e.volume, e.paused, e.op, e.area])), ui: cur.ui });
      if (key !== last) {
        last = key;
        const head = `+${String(Date.now() - t0).padStart(5)}ms ${cur.verdict || cur.err} ${JSON.stringify(cur.live)}`;
        const body = (cur.rows || []).map((r) => `   ${r.label} ${r.origin} ${r.href}\n` + r.els.map((e) => '     ' + JSON.stringify(e)).join('\n')).join('\n');
        console.log(head + (body ? '\n' + body : ''));
        if (cur.ui) console.log('   ui ' + JSON.stringify(cur.ui));
      }
      await delay(500);
    }
    s.cdp.close();
    return;
  }

  if (cmd === 'parity-ab') {
    // PROOF OF PARITY, not a contract. `kickparity` asserts what OUR player
    // must do; it never asks kick.com what IT does. This command runs the same
    // capability on both players in the same guest browser - the REFERENCE is
    // kick.com/<channel>'s own player, the CANDIDATE is twitch.tv/<channel>
    // with our kick overlay - and prints the two numbers side by side. Parity
    // is decided on the RESULT (offset behind the live edge, and whether
    // playback holds there), because the two players take different inputs:
    // the reference is driven through its own media element (what its DVR
    // does internally) and the candidate through the real bar click a user
    // makes.
    const channel = String(flags.channel || 'titiltei').toLowerCase();
    const OFFSETS = [10, 60, 600];
    const sleepms = (n) => delay(n);
    const nav = async (url) => {
      await s.page.cdp.send('Page.navigate', { url }, s.page.sessionId);
      await sleepms(1500);
    };
    // Pick the BIGGEST playing video, and never trust a sentinel: measured on
    // kick.com 2026-11-09 the first run "measured" a 2-second video (a preview
    // or an ad) and then reported `behind=1073741824s`, which is the same
    // 1 GiB sentinel Twitch's own element exposes. A reference read through a
    // bad element is a wrong reference, so both filters are mandatory.
    const refProbe = `(() => {
      const cands = [...document.querySelectorAll('video')]
        .map((v) => { const r = v.getBoundingClientRect(); return { v, area: r.width * r.height }; })
        .filter((x) => x.v.readyState >= 2 && x.area > 100000)
        .sort((a, b) => b.area - a.area);
      if (!cands.length) return null;
      const v = cands[0].v;
      const sk = v.seekable;
      let end = null;
      let start = 0;
      if (sk && sk.length) {
        const e = sk.end(sk.length - 1);
        const b = sk.start(0);
        if (Number.isFinite(e) && e < 1e6) end = +e.toFixed(2);
        if (Number.isFinite(b) && b < 1e6) start = +b.toFixed(2);
      }
      if (end === null && Number.isFinite(v.duration) && v.duration < 1e6) end = +v.duration.toFixed(2);
      return { pos: +v.currentTime.toFixed(2), paused: !!v.paused, end, start, area: cands[0].area };
    })()`;
    const refSeek = `(t) => (() => {
      const cands = [...document.querySelectorAll('video')]
        .map((v) => { const r = v.getBoundingClientRect(); return { v, area: r.width * r.height }; })
        .filter((x) => x.v.readyState >= 2 && x.area > 100000)
        .sort((a, b) => b.area - a.area);
      if (!cands.length) return null;
      const v = cands[0].v;
      v.currentTime = t;
      return +v.currentTime.toFixed(2);
    })()`;
    const rows = [];
    const ref = {};

    // ---- REFERENCE: kick.com's own player
    await nav(`https://kick.com/${channel}`);
    let refOk = false;
    for (let i = 0; i < 40; i++) {
      const v = await s.page.evalMain(refProbe).catch(() => null);
      if (v && v.end !== null) { refOk = true; ref.base = v; break; }
      await sleepms(500);
    }
    if (!refOk) {
      rows.push({ name: 'reference', pass: false, detail: 'kick.com player never produced a seekable video (login/consent/offline?) - PARITY UNPROVEN' });
      console.log('FAIL reference kick.com player unavailable; parity is UNPROVEN, not a pass');
    } else {
      console.log(`[harness] reference kick.com/${channel} ${JSON.stringify(ref.base)}`);
      for (const off of OFFSETS) {
        const cur = await s.page.evalMain(refProbe);
        const edge = cur.end;
        const target = Math.max(cur.start || 0, edge - off);
        await s.page.evalMain(`(${refSeek})(${target})`).catch(() => null);
        await sleepms(2500);
        const a = await s.page.evalMain(refProbe);
        await sleepms(4000);
        const b = await s.page.evalMain(refProbe);
        const heldRef = !!a && !!b && b.pos - a.pos > 2.5;
        const got = a ? +(edge - a.pos).toFixed(1) : null;
        ref[off] = { got, held: heldRef, posA: a && a.pos, posB: b && b.pos };
        console.log(`[harness] reference back ${off}s -> behind=${got}s held=${heldRef} (pos ${a && a.pos} -> ${b && b.pos})`);
      }
    }

    // ---- CANDIDATE: twitch.tv + our kick overlay, driven by the real bar
    await nav(`https://www.twitch.tv/${channel}`);
    let candOk = false;
    for (let i = 0; i < 120; i++) {
      const st = await s.page.evalIsolated(`(() => { const k = window.KO && KO.kickState; return k ? { pos: +Number(k.pos||0).toFixed(2), lat: +Number(k.lat||0).toFixed(2), state: k.state, dur: +Number(KO.kickDur||0).toFixed(1) } : null; })()`).catch(() => null);
      if (st && st.state === 'Playing' && st.pos > 1) { candOk = true; console.log(`[harness] candidate ${JSON.stringify(st)}`); break; }
      await sleepms(500);
    }
    const cand = {};
    if (!candOk) {
      rows.push({ name: 'candidate', pass: false, detail: 'our kick layer did not reach Playing - CANDIDATE UNPROVEN' });
      console.log('FAIL candidate kick layer not playing; parity is UNPROVEN, not a pass');
    } else {
      const st = () => s.page.evalIsolated(`(() => { const k = KO.kickState; return { pos: +Number(k.pos||0).toFixed(2), lat: +Number(k.lat||0).toFixed(2), paused: !!k.paused, onDvr: !!KO.kickOnDvr, dur: +Number(KO.kickDur||0).toFixed(1) }; })()`);
      const clickBar = async (targetSec) => {
        const r = await s.page.evalMain(`(() => { const b = document.querySelector('#ko-seekbar'); if (!b) return null; const x = b.getBoundingClientRect(); return [x.left, x.top, x.width, x.height]; })()`);
        if (!r) throw new Error('no seekbar');
        const s0 = await st();
        const max = s0.dur > 0 ? s0.dur : 1;
        const frac = Math.max(0.002, Math.min(0.998, targetSec / max));
        const x = r[0] + r[2] * frac;
        const y = r[1] + r[3] / 2;
        await s.page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, s.page.sessionId);
        await s.page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, s.page.sessionId);
        await s.page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, s.page.sessionId);
        return { frac, max, requested: frac * max };
      };
      for (const off of OFFSETS) {
        let before = await st();
        if (!(before.pos > 1)) { await sleepms(3000); before = await st(); }
        if (!(before.pos > 1)) { cand[off] = { got: null, held: false, note: 'layer not playing' }; console.log(`[harness] candidate back ${off}s SKIP (layer not playing)`); continue; }
        const edge = before.onDvr ? before.pos + before.lat : before.dur - before.lat;
        const target = Math.max(1, edge - off);
        const c = await clickBar(target);
        await sleepms(2500);
        const a = await st();
        await sleepms(4000);
        const b = await st();
        const held = !!(a && b) && b.pos - a.pos > 2.5;
        const got = a && Number.isFinite(a.pos) ? +(edge - a.pos).toFixed(1) : null;
        cand[off] = { got, held, onDvr: a && a.onDvr, note: `clicked=${c.requested.toFixed(1)}` };
        console.log(`[harness] candidate back ${off}s -> behind=${got}s held=${held} onDvr=${a && a.onDvr} (pos ${a && a.pos} -> ${b && b.pos})`);
      }
    }

    // ---- COMPARISON
    for (const off of OFFSETS) {
      const r = ref[off];
      const c = cand[off];
      const rTxt = r ? `kick behind=${r.got}s held=${r.held}` : 'kick UNMEASURED';
      const cTxt = c ? `ours behind=${c.got}s held=${c.held}` : 'ours UNMEASURED';
      const pass = !!(r && c && r.held === c.held && Number.isFinite(r.got) && Number.isFinite(c.got) && Math.abs(r.got - c.got) <= 8);
      rows.push({ name: `parity-back-${off}s`, pass, detail: `${rTxt} | ${cTxt}` });
    }
    const failed = rows.filter((x) => !x.pass).length;
    console.log('--- parity table ---');
    for (const x of rows) console.log(`${x.pass ? 'PASS' : 'FAIL'} ${x.name} ${x.detail}`);
    console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} parity-ab rows=${rows.length} failed=${failed}`);
    s.cdp.close();
    if (failed) process.exitCode = 1;
    return;
  }

  if (cmd === 'parity-live') {
    // PARITY IN THE OWNER'S BROWSER (owner order 2026-11-09: "u mesmo kick e
    // twitch no meu chrome. os dois sendo o canal titiltei. e testa de verdade
    // ... no background, nao na minha cara").
    //
    // This command NEVER touches a tab that already exists: it creates its own
    // background target per platform, measures it, and closes it. No
    // `Target.activateTarget`, no `Page.navigate` on his pages. The only state
    // it may borrow is the player preference, and it is restored verbatim
    // before the command returns.
    //
    // Reference = kick.com's own media element (what its DVR does internally).
    // Candidate = twitch.tv with OUR bar, seeking through `kickSeekTo` via a
    // synthetic pointer on `#ko-seekbar`. Synthetic on purpose: the bar sits
    // where Twitch's own controls sit, and a trusted pointer over his live page
    // would be a click on HIS player.
    const channel = String(flags.channel || 'titiltei').toLowerCase();
    const port = Number(flags.port || 9222);
    const OFFSETS = String(flags.offsets || '10,60,600').split(',').map((x) => Number(x)).filter((x) => x > 0);
    const sleepms = (n) => delay(n);
    const cdp = await connect(port);
    const opened = [];
    const log = (...a) => console.log('[parity]', ...a);

    const openTab = async (url, label) => {
      // `muted: true` matters twice: it never makes a sound in his face, and
      // a background tab that is NOT muted cannot autoplay (Chrome blocks
      // audible autoplay without a gesture) - the first run measured exactly
      // that: kick.com loaded and produced no playing video at all.
      const { targetId } = await cdp.send('Target.createTarget', { url, background: true, muted: true });
      opened.push(targetId);
      const sess = await attach(cdp, { targetId }, label);
      sess.cdp = cdp;
      await sess.enable({ page: true });
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const rs = await sess.evalMain('document.readyState').catch(() => null);
        if (rs === 'complete') break;
        await sleepms(400);
      }
      log(`${label} tab ready target=${targetId}`);
      return sess;
    };
    // A tab this command created is marked in its URL, so a leftover from a
    // crashed run is identifiable without guessing which of HIS tabs it is.
    const MARK = '?omp=parity';
    const closeTab = async (targetId) => {
      await cdp.send('Target.detachFromTarget', { targetId }, null).catch(() => null);
      try {
        const t = await cdp.send('Target.getTargets');
        const sess = t.targetInfos.find((x) => x.targetId === targetId);
        if (sess && sess.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: sess.sessionId }).catch(() => null);
      } catch { /* ignore */ }
      await cdp.send('Target.closeTarget', { targetId }).catch(() => null);
    };
    const cleanMarks = async () => {
      const t = await cdp.send('Target.getTargets');
      const mine = t.targetInfos.filter((x) => x.type === 'page' && (x.url || '').includes('omp=parity'));
      for (const x of mine) await closeTab(x.targetId);
      return mine.length;
    };
    if (flags.clean) {
      const n = await cleanMarks();
      console.log(`[parity] cleaned ${n} leftover measurement tab(s)`);
      cdp.close();
      return;
    }
    // `refreshContexts()` disables and re-enables Runtime, and on a loaded
    // browser that call itself times out (measured: `Runtime.enable: timeout`
    // right after a lifecycle wake). A plain re-attach is the cheap repair: the
    // context ids are only stale after a navigation.
    const safeEval = async (sess, expr, main = false) => {
      const run = () => (main ? sess.evalMain(expr) : sess.evalIsolated(expr));
      try { return await run(); } catch (e) {
        if (!/Cannot find context/.test(String(e))) throw e;
        const fresh = await attach(cdp, { targetId: sess.targetId }, sess.label);
        if (!fresh) throw e;
        fresh.cdp = cdp;
        await fresh.enable({ page: true }).catch(() => null);
        sess.contexts = fresh.contexts;
        sess.mainFrameId = fresh.mainFrameId;
        sess.sessionId = fresh.sessionId;
        await sleepms(300);
        return await run();
      }
    };

    const refProbe = `(() => {
      const cands = [...document.querySelectorAll('video')]
        .map((v) => { const r = v.getBoundingClientRect(); return { v, area: r.width * r.height }; })
        .filter((x) => x.v.readyState >= 2 && x.area > 100000)
        .sort((a, b) => b.area - a.area);
      const out = { n: document.querySelectorAll('video').length, href: location.href, title: document.title.slice(0, 60) };
      if (!cands.length) return out;
      const v = cands[0].v;
      const sk = v.seekable;
      let end = null, start = 0;
      if (sk && sk.length) {
        const e = sk.end(sk.length - 1), b = sk.start(0);
        if (Number.isFinite(e) && e < 1e6) end = +e.toFixed(2);
        if (Number.isFinite(b) && b < 1e6) start = +b.toFixed(2);
      }
      if (end === null && Number.isFinite(v.duration) && v.duration < 1e6) end = +v.duration.toFixed(2);
      return { ...out, pos: +v.currentTime.toFixed(2), paused: !!v.paused, end, start, area: Math.round(cands[0].area), dur: Number.isFinite(v.duration) && v.duration < 1e6 ? +v.duration.toFixed(1) : null };
    })()`;
    const refSeek = `(t) => {
      const cands = [...document.querySelectorAll('video')]
        .map((v) => { const r = v.getBoundingClientRect(); return { v, area: r.width * r.height }; })
        .filter((x) => x.v.readyState >= 2 && x.area > 100000)
        .sort((a, b) => b.area - a.area);
      if (!cands.length) return null;
      cands[0].v.currentTime = t;
      return +cands[0].v.currentTime.toFixed(2);
    }`;

    // A background tab is `visibilityState: 'hidden'` and kick.com mounts its
    // player only for a visible page - with the OneTrust overlay up, no <video>
    // existed at all (measured: `{n:0, title:'titiltei Live Stream'}`). Lifecycle
    // `active` plus a consent dismissal is the strongest thing CDP offers short
    // of `Page.bringToFront`, which is FORBIDDEN here because it would pull the
    // tab into his face.
    const wake = async (sess, label) => {
      await sess.evalRaw(`(() => {
        const ids = ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler'];
        for (const q of ids) { const b = document.querySelector(q); if (b) { b.click(); return 'consent:' + q; } }
        const b = [...document.querySelectorAll('button,a')].find((e) => /^(accept all|aceitar tudo|accept|agree)$/i.test((e.textContent || '').trim()));
        if (b) { b.click(); return 'consent:text'; }
        return 'no-consent';
      })()`).then((r) => log(`${label} wake ${r}`)).catch(() => null);
      // Every CDP call here is bounded at 5 s: on a loaded browser
      // `Page.setWebLifecycleState` can fail to answer at all, and the default
      // 30 s timeout turned a stuck browser call into a stuck measurement.
      await sess.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sess.sessionId, 5000).catch(() => null);
      await sess.cdp.send('Page.setWebLifecycleState', { state: 'active' }, sess.sessionId, 5000).catch(() => null);
      await sleepms(1200);
      const vis = await sess.cdp.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sess.sessionId, 5000).then((r) => r.result && r.result.value).catch(() => '?');
      log(`${label} visibilityState=${vis}`);
    };
    const bail = async () => { for (const t of opened) await closeTab(t); };
    process.on('uncaughtException', async (e) => { console.log('[parity] ABORT', String(e).slice(0, 200)); await bail(); process.exit(1); });
    const rows = [];
    const refOut = {};
    const candOut = {};

    // ---- REFERENCE: kick.com's own player, in its own background tab
    // MEASURED WALL (2026-11-09, his Chrome): a background kick.com tab mounts
    // no <video> at all, and after a lifecycle wake its renderer stops
    // answering CDP (`Runtime.evaluate: timeout` at 8 s, three attempts). The
    // reference therefore cannot be produced without a RENDERED kick tab, which
    // would mean pulling a tab into his face. `--skip-ref` measures our side
    // alone and says so in the verdict.
    const kickTab = flags['skip-ref'] ? null : await openTab(`https://kick.com/${channel}${MARK}`, 'kick');
    if (kickTab) await wake(kickTab, 'kick');
    // kick.com mounts its <video> but leaves it PAUSED (measured: readyState 4,
    // currentTime 0, paused true, width 0) until it is played, and its seekable
    // window is 2 s until the replay window lands. Muted `play()` is the one
    // thing a page may do without a gesture, and the tab is muted at browser
    // level, so nothing is audible.
    const primeRef = `(() => {
      const v = [...document.querySelectorAll('video')][0];
      if (!v) return 'no-video';
      v.muted = true;
      const p = v.play();
      return p ? (p.then(() => 'play').catch((e) => 'rej:' + e.name)) : 'no-promise';
    })()`;
    const primed = kickTab ? await safeEval(kickTab, primeRef, true).catch((e) => 'ERR ' + String(e).slice(0, 60)) : 'skipped';
    log(`kick prime ${primed}`);
    let refBase = null;
    for (let i = 0; kickTab && i < 40; i++) {
      const v = await safeEval(kickTab, refProbe, true).catch(() => null);
      // A 2 s window is not the DVR: require a real span before measuring.
      if (v && v.end !== null && v.pos > 1 && (v.end - (v.start || 0)) > 60) { refBase = v; break; }
      if (v && v.paused) await safeEval(kickTab, primeRef, true).catch(() => null);
      await sleepms(1500);
    }
    if (!refBase) {
      const v = await safeEval(kickTab, refProbe, true).catch((e) => ({ err: String(e) }));
      log(`reference detail ${JSON.stringify(v)}`);
      rows.push({ name: 'reference', pass: false, detail: `kick.com/${channel} produced no seekable video: ${JSON.stringify(v)} - PARITY UNPROVEN` });
      log('FAIL reference unavailable; parity stays UNPROVEN');
    } else {
      log(`reference kick.com/${channel} ${JSON.stringify(refBase)}`);
      for (const off of OFFSETS) {
        const cur = await kickTab.evalMain(refProbe);
        const edge = cur.end;
        const target = Math.max(cur.start || 0, edge - off);
        await kickTab.evalMain(`(${refSeek})(${target})`).catch(() => null);
        await sleepms(2500);
        const a = await kickTab.evalMain(refProbe);
        await sleepms(4000);
        const b = await kickTab.evalMain(refProbe);
        const held = !!(a && b) && b.pos - a.pos > 2.5;
        refOut[off] = { behind: a ? +(edge - a.pos).toFixed(1) : null, held, posA: a && a.pos, posB: b && b.pos };
        log(`reference back ${off}s -> behind=${refOut[off].behind}s held=${held} (pos ${a && a.pos} -> ${b && b.pos})`);
      }
    }
    if (kickTab) await closeTab(opened[0]);

    // ---- CANDIDATE: twitch.tv + our kick overlay
    const twitchTab = await openTab(`https://www.twitch.tv/${channel}${MARK}`, 'twitch');
    // chrome.storage exists only in the content-script world: the first run
    // asked the MAIN world, got `undefined`, and therefore treated a real
    // record as absent before overwriting it.
    const readRec = () => twitchTab.evalIsolated(`new Promise((r) => chrome.storage.local.get('ko.v2', (o) => r(o['ko.v2'] || null)))`).catch(() => null);
    let rec0 = null;
    for (let i = 0; i < 30 && !rec0; i++) { rec0 = await readRec(); if (!rec0) await sleepms(500); }
    const st0 = () => safeEval(twitchTab, `(() => { const k = window.KO && KO.kickState; return k ? { pos: +Number(k.pos||0).toFixed(2), lat: +Number(k.lat||0).toFixed(2), paused: !!k.paused, onDvr: !!KO.kickOnDvr, dur: +Number(KO.kickDur||0).toFixed(1), player: KO.player } : null; })()`).catch(() => null);
    let cur = null;
    for (let i = 0; i < 90; i++) {
      cur = await st0();
      if (cur && cur.state !== 'Stopped' && cur.pos > 1) break;
      await sleepms(500);
    }
    // The overlay only mounts OUR kick layer when the preference says so. If
    // the profile prefers another player, borrow it for this measurement and
    // put it back before returning.
    let restore = null;
    if (!cur || cur.player !== 'kick') {
      const base = rec0 || {};
      restore = { rec: rec0 };
      await safeEval(twitchTab, `new Promise((r) => chrome.storage.local.set({ 'ko.v2': ${JSON.stringify({ ...base, player: 'kick', enabled: true })} }, () => r(1)))`);
      await twitchTab.evalMain('location.reload(), 1').catch(() => null);
      await sleepms(1500);
      await twitchTab.refreshContexts();
      await twitchTab.enable({ page: true }).catch(() => null);
      for (let i = 0; i < 120; i++) {
        cur = await st0();
        if (cur && cur.player === 'kick' && cur.pos > 1) break;
        await sleepms(500);
      }
      log(`borrowed player=kick (was ${(rec0 && rec0.player) || 'unset'}), restored at exit`);
    }
    if (!cur || !(cur.pos > 1)) {
      rows.push({ name: 'candidate', pass: false, detail: `our kick layer never reached playing: ${JSON.stringify(cur)} - CANDIDATE UNPROVEN` });
      log('FAIL candidate not playing');
    } else {
      log(`candidate twitch.tv/${channel} ${JSON.stringify(cur)}`);
      const seekMark = `(frac) => {
        const sb = document.getElementById('ko-seekbar');
        if (!sb) return null;
        const r = sb.getBoundingClientRect();
        if (!r.width) return null;
        const x = r.left + r.width * frac;
        const y = r.top + r.height / 2;
        const mk = (type) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: type === 'pointerdown' ? 1 : 0 });
        sb.dispatchEvent(mk('pointerdown'));
        sb.dispatchEvent(mk('pointerup'));
        return { x: Math.round(x), frac };
      }`;
      for (const off of OFFSETS) {
        let before = await st0();
        if (!(before.dur > 0)) { await sleepms(3000); before = await st0(); }
        const base = Math.max(1, before.dur || 1);
        const edge = before.dur - before.lat;
        const target = Math.max(1, edge - off);
        const frac = Math.max(0.002, Math.min(0.998, target / base));
        await twitchTab.evalIsolated(`(${seekMark})(${frac})`).catch(() => null);
        await sleepms(2500);
        const a = await st0();
        await sleepms(4000);
        const b = await st0();
        const held = !!(a && b) && b.pos - a.pos > 2.5;
        candOut[off] = { behind: a ? +((a.onDvr ? a.pos + a.lat : a.dur) - a.pos).toFixed(1) : null, held, onDvr: a && a.onDvr, posA: a && a.pos, posB: b && b.pos, clicked: +(frac * base).toFixed(1) };
        log(`candidate back ${off}s -> clicked=${candOut[off].clicked} behind=${candOut[off].behind}s held=${held} onDvr=${a && a.onDvr} (pos ${a && a.pos} -> ${b && b.pos})`);
      }
    }
    await closeTab(opened[1]);

    // ---- restore the borrowed preference, verbatim
    if (restore) {
      const back = restore.rec;
      const tw = await openTab(`https://www.twitch.tv/${channel}${MARK}`, 'restore').catch(() => null);
      if (tw) {
        const expr = back
          ? `new Promise((r) => chrome.storage.local.set({ 'ko.v2': ${JSON.stringify(back)} }, () => r(1)))`
          : `new Promise((r) => chrome.storage.local.remove('ko.v2', () => r(1)))`;
        await safeEval(tw, expr).catch(() => null);
        await closeTab(opened[2]);
        log(`player preference restored: ${back ? JSON.stringify({ player: back.player }) : 'record removed'}`);
      }
    }

    for (const off of OFFSETS) {
      const r = refOut[off];
      const c = candOut[off];
      const ok = !!(r && c && Number.isFinite(r.behind) && Number.isFinite(c.behind));
      const pass = ok && r.held === c.held && Math.abs(r.behind - c.behind) <= 8;
      rows.push({
        name: `parity-back-${off}s`,
        pass,
        detail: ok
          ? `kick behind=${r.behind}s held=${r.held} | ours behind=${c.behind}s held=${c.held} onDvr=${c.onDvr}${pass ? '' : ` (delta=${Math.abs(r.behind - c.behind).toFixed(1)}s)`}`
          : `kick ${r ? 'held=' + r.held : 'UNMEASURED'} | ours ${c ? 'behind=' + c.behind : 'UNMEASURED'}`,
      });
    }
    const failed = rows.filter((x) => !x.pass).length;
    console.log('--- parity live table ---');
    for (const x of rows) console.log(`${x.pass ? 'PASS' : 'FAIL'} ${x.name} ${x.detail}`);
    console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} parity-live rows=${rows.length} failed=${failed} (his Chrome, port ${port})`);
    cdp.close();
    if (failed) process.exitCode = 1;
    return;
  }

  if (cmd === 'kickparity') {
    // "The kick player inside Twitch must behave like kick.com's own player"
    // (owner order 2026-11-09). Parity is a LIST of operations with an
    // observable result, so this command runs the list and prints one PASS/FAIL
    // row per operation with the numbers that decided it. Every action is a
    // real CDP mouse press/key so the page's own handlers run, except the
    // quality menu (a synthetic click on the item is what a user click does).
    // The guest's default 800x600 viewport makes Twitch put its chat panel OVER
    // the right half of the player; the overlay bar is below it, so a click at
    // ~99.5% (a 60s rewind on a 3h stream) lands on Twitch's chat instead of
    // the seekbar (measured 2026-11-09: elementFromPoint returned a chat DIV).
    // A desktop viewport lays the chat beside the video, which is the layout the
    // owner sees; without it the rewind rows measure the instrument, not the
    // product.
    await s.page.setViewport(1600, 900);
    await delay(1500);
    const KP = `(() => {
      // content.js declares const KO in the isolated world, so it is NOT a
      // property of window. The old window.KO guard read every row's
      // pos/state/paused/q from {}, so the preflight could never see Playing.
      const k = KO && KO.kickState ? KO.kickState : {};
      return {
        ver: typeof KO_VER === 'string' ? KO_VER : null,
        player: KO.player,
        pos: +Number(k.pos || 0).toFixed(2), lat: +Number(k.lat || 0).toFixed(2),
        paused: !!k.paused, state: k.state || null, q: k.q && k.q.name ? k.q.name : null,
        onDvr: !!KO.kickOnDvr, dur: +Number(KO.kickDur || 0).toFixed(1),
        bar: !!document.getElementById('ko-bar'),
      };
    })()`;
    const st = () => s.page.evalIsolated(KP);
    const waitFor = async (pred, ms = 15000, step = 250) => {
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < ms) {
        last = await st();
        if (pred(last)) return { ok: true, v: last, ms: Date.now() - t0 };
        await delay(step);
      }
      return { ok: false, v: last, ms: Date.now() - t0 };
    };
    const clickAt = async (x, y) => {
      await s.page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, s.page.sessionId);
      await s.page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, s.page.sessionId);
      await s.page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, s.page.sessionId);
    };
    const key = async (name) => {
      const vk = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, f: 70 }[name];
      const base = { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await s.page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, s.page.sessionId);
      await s.page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s.page.sessionId);
    };
    const seekBarTo = async (targetSec) => {
      const r = await s.page.evalMain(`(() => { const b = document.querySelector('#ko-seekbar'); if (!b) return null; const x = b.getBoundingClientRect(); return [x.left, x.top, x.width, x.height]; })()`);
      if (!r) throw new Error('no seekbar (the kick bar is not mounted)');
      const cur = await st();
      const max = cur.dur > 0 ? cur.dur : 1;
      // Keep the click inside the bar but represent sub-second offsets: on a
      // 3h stream at 1000px one pixel is ~11s, so the old 0.002..0.998 clamp
      // made the last ~25s (including a 10s rewind) unclickable by construction.
      const halfPx = r[2] > 0 ? 0.5 / r[2] : 0.0005;
      const frac = Math.max(halfPx, Math.min(1 - halfPx, targetSec / max));
      await clickAt(r[0] + r[2] * frac, r[1] + r[3] / 2);
      // The page's endDrag maps the same fraction against KO.kickDur, so this
      // is the broadcast offset the bar actually requested. Printed in the row
      // so a target/clicked mismatch is visible instead of inferred.
      return { frac, max, x: r[0] + r[2] * frac, target: frac * max };
    };
    // The kick layer can go through a teardown/remount of its own (measured
    // 2026-11-09: `kickState` null for ~90 s, then `Playing` again at pos 0).
    // A row that starts measuring inside that window reports a defect that is
    // not the row's, so each row first waits for playback to come back.
    const waitPlaying = async (ms = 25000) => {
      const w = await waitFor((v) => v.state === 'Playing' && v.pos > 0.5, ms, 400);
      return w;
    };
    const rows = [];
    const row = async (name, fn) => {
      try {
        const r = await fn();
        rows.push({ name, pass: !!r.pass, detail: r.detail });
        console.log(`${r.pass ? 'PASS' : 'FAIL'} ${name} ${r.detail}`);
      } catch (e) {
        rows.push({ name, pass: false, detail: 'error: ' + e.message });
        console.log(`FAIL ${name} error: ${e.message}`);
      }
    };

    // Preflight: a player that is not playing makes every row below vacuous
    // (measured 2026-11-09: a fresh guest printed PASS on `seek-within-dvr` at
    // pos=0 because the kick layer had never mounted - kickReady=false). A row
    // that cannot be exercised is a FAIL, never a pass.
    const pf = await waitFor((v) => v.bar && v.state === 'Playing' && v.pos > 1, 90000, 500);
    console.log(`${pf.ok ? 'PASS' : 'FAIL'} preflight-playing ${JSON.stringify(pf.v)} (${pf.ms}ms)`);
    if (!pf.ok) {
      console.log('RESULT FAIL kickparity rows=1 failed=1 (the kick layer is not playing: nothing below can be measured)');
      s.cdp.close();
      process.exitCode = 1;
      return;
    }
    const before = await st();
    if (before.player !== 'kick') {
      // The parity list is about the kick layer; ask for it instead of silently
      // measuring the native player.
      console.log(`[harness] player=${before.player}; run: node _tools/ko-harness.mjs set --player=kick`);
    }
    console.log(`[harness] kickparity start ${JSON.stringify(before)}`);

    // Which element a REAL pointer reaches at our bar is not assertable here:
    // Twitch's own control bar sits in the same place and is only invisible
    // because a headless browser never hovers out of it (measured 2026-11-09:
    // elementFromPoint returned ScCoreButton for our #ko-play at z-index 30,
    // while the same point passes for a real user once the controls fade to
    // pointer-events:none). So the pause/resume rows below dispatch on OUR
    // element (synthetic) - they test our handler, not Twitch's hover state -
    // and the "does a pointer reach the bar" question stays a live check.
    await row('pause-freezes', async () => {
      const gate = await waitPlaying();
      if (!gate.ok) return { pass: false, detail: `precondition: not playing ${JSON.stringify(gate.v)}` };
      // A live IVS session drops its position on pause (measured 2026-11-09:
      // pos 93 -> 0 / readyState 0, resuming at the edge) - that is the live
      // engine's rule, not a resumable pause. Move to the replay first: pause
      // on the replay is the case this row is about, and it must hold there.
      const a = await st();
      if (!a.onDvr) {
        // MID-DVR, never `dur - 60`. `dur` is the report's own max while
        // `kickSeekTo` clamps against `KO.kickDur`, and right after the layer
        // mounts the two disagree by seconds — a target 60 s from the edge then
        // lands inside `KICK_EDGE_GO_LIVE_SEC` of the clamp, the click is
        // translated into "go live", and the row waits 45 s for a replay the
        // click deliberately did not ask for. Measured 2026-11-12, three runs:
        // `no replay {pos:74.09, onDvr:false, dur:1454.9}` while `rewind-60s`
        // on the same player reached `onDvr=true` every time.
        const target = Math.max(1, Math.round(a.dur * 0.5));
        await seekBarTo(target);
        // 45 s, not 25: the DVR->replay load is the same source switch the
        // `go-live` row documents at ~35 s (the IVS replay starts at its lowest
        // rendition), so a 25 s window declared a working switch a failure and
        // then measured the click mid-load (measured 2026-11-12: two runs failed
        // here with `pos=1.36` while `rewind-60s` on the same player passed).
        const dw = await waitFor((v) => v.onDvr && v.state === 'Playing' && Math.abs(v.pos - target) <= 20, 45000);
        if (!dw.ok) return { pass: false, detail: `precondition: no replay (${JSON.stringify(dw.v)})` };
      }
      // Wait for STEADY Playing (two consecutive samples): the first Playing
      // after a load can flip to Buffering inside the click's settle, and the
      // play button then sends `play`, not pause.
      let steady = 0;
      for (let i = 0; i < 16 && steady < 2; i++) {
        await delay(500);
        const v = await st();
        steady = v.state === 'Playing' && !v.paused ? steady + 1 : 0;
      }
      if (steady < 2) return { pass: false, detail: `precondition: replay not steady (${JSON.stringify(await st())})` };
      await s.page.click('#ko-play', { synthetic: true, settle: 400 });
      // Measure the freeze between two samples AFTER the pause is reported:
      // the click->pause latency is not the freeze, and comparing across it
      // made a healthy pause look like it moved.
      const p = await waitFor((v) => v.paused === true, 3000);
      if (!p.ok) return { pass: false, detail: `pause click did not pause (${JSON.stringify(p.v)})` };
      const b0 = p.v;
      await delay(1600);
      const b = await st();
      const moved = Math.abs(b.pos - b0.pos);
      return { pass: b.paused && moved < 0.6, detail: `onDvr=${b.onDvr} paused=${b.paused} moved=${moved.toFixed(2)}s` };
    });
    await row('resume-advances', async () => {
      await s.page.click('#ko-play', { synthetic: true, settle: 400 });
      // Measure AFTER the playing state is reported: the resume latency is
      // not the advance, and comparing across it left <0.7s in the window.
      const r = await waitFor((v) => !v.paused && v.state === 'Playing', 4000);
      if (!r.ok) return { pass: false, detail: `resume click did not play (${JSON.stringify(r.v)})` };
      const a = r.v;
      await delay(1800);
      const b = await st();
      const moved = b.pos - a.pos;
      return { pass: !b.paused && moved > 0.7, detail: `paused=${b.paused} moved=${moved.toFixed(2)}s` };
    });
    await row('arrow-back-5s', async () => {
      const gate = await waitPlaying();
      if (!gate.ok) return { pass: false, detail: `precondition: not playing` };
      const a = await st();
      // A live session's buffer and the broadcast both start at 0; below ~6s
      // there is no room for a 5s step. The predicate must see a real move
      // backward: accepting `onDvr` alone passed with back=0.00s on the DVR.
      if (a.pos < 6) return { pass: false, detail: `precondition: pos=${a.pos} (no room to rewind 5s)` };
      const wasDvr = a.onDvr;
      await key('ArrowLeft');
      const w = await waitFor((v) => (v.onDvr !== wasDvr) || v.pos <= a.pos - 2, 8000);
      const b = w.v;
      const back = a.pos - b.pos;
      return { pass: w.ok && back >= 2, detail: `from=${a.pos} to=${b.pos} back=${back.toFixed(2)}s onDvr=${b.onDvr} lat=${b.lat} (${w.ms}ms)` };
    });
    await row('rewind-60s-holds', async () => {
      const gate = await waitPlaying();
      if (!gate.ok) return { pass: false, detail: `precondition: not playing` };
      const a = await st();
      // On the live url `pos` is the IVS session clock (pos ~3s, dur 0), so
      // `pos + lat` is NOT a broadcast offset; KO.kickDur (a.dur) is. Once on
      // the DVR url `pos` becomes the broadcast offset and pos + lat is right.
      const target = Math.max(1, (a.onDvr ? a.pos + a.lat : a.dur) - 60);
      const clicked = await seekBarTo(target);
      const w = await waitFor((v) => Math.abs(v.pos - target) <= 8 && v.paused === false, 20000);
      const b = w.v;
      await delay(4000);
      const c = await st();
      const advanced = c.pos - b.pos;
      const latHeld = Math.abs(c.lat - b.lat) <= 6;
      const pass = w.ok && advanced > 2.2 && latHeld && c.onDvr;
      return { pass, detail: `target=${target.toFixed(1)} clicked=${clicked.target.toFixed(1)} got=${b.pos} onDvr=${b.onDvr} advanced=${advanced.toFixed(2)}s lat=${b.lat}->${c.lat}` };
    });
    await row('rewind-10s-holds', async () => {
      const a = await st();
      const target = Math.max(1, (a.onDvr ? a.pos + a.lat : a.dur) - 10);
      const clicked = await seekBarTo(target);
      const w = await waitFor((v) => Math.abs(v.pos - target) <= 6 && v.paused === false, 20000);
      const b = w.v;
      await delay(3000);
      const c = await st();
      const advanced = c.pos - b.pos;
      const pass = w.ok && advanced > 1.5 && c.onDvr;
      return { pass, detail: `target=${target.toFixed(1)} clicked=${clicked.target.toFixed(1)} got=${b.pos} onDvr=${b.onDvr} advanced=${advanced.toFixed(2)}s lat=${b.lat}->${c.lat}` };
    });
    await row('seek-within-dvr', async () => {
      const a = await st();
      if (!(a.pos > 5)) return { pass: false, detail: `precondition: pos=${a.pos} (no playback to rewind from)` };
      const target = Math.max(1, a.pos - 120);
      await seekBarTo(target);
      const w = await waitFor((v) => Math.abs(v.pos - target) <= 10, 20000);
      return { pass: w.ok, detail: `from=${a.pos} target=${target.toFixed(1)} got=${w.v.pos} (${w.ms}ms)` };
    });
    await row('go-live', async () => {
      const g0 = await st();
      if (!(g0.pos > 5)) return { pass: false, detail: `precondition: pos=${g0.pos}` };
      // Synthetic on purpose: `#ko-golive` renders at the player's right edge,
      // the same place Twitch's own controls sit, and a headless browser never
      // hovers them out of the way. The row tests OUR handler; whether a real
      // pointer reaches the chip is a live check, not a headless one.
      const chip = await s.page.evalIsolated(`(() => {
        const b = document.getElementById('ko-golive');
        if (!b) return 'missing';
        const r = b.getBoundingClientRect();
        return { shown: b.classList.contains('ko-show'), w: Math.round(r.width), h: Math.round(r.height) };
      })()`);
      if (!chip || chip === 'missing' || !chip.shown) return { pass: false, detail: `no live chip: ${JSON.stringify(chip)}` };
      await s.page.click('#ko-golive', { synthetic: true, settle: 400 });
      // The live IVS position can be the session clock OR the broadcast clock
      // (measured both), so a small-pos bound is wrong. The live load also
      // reports Playing/Buffering in flapping samples for several seconds, so
      // one instantaneous sample only proves a frozen pos. Require two
      // consecutive samples that are live and actually advancing.
      // A DVR->live switch RESETS the clock: the replay reports the broadcast
      // position (26000 s) and the live url reports a session position (6 s).
      // Measured 2026-11-09: the switch needed ~35 s (the IVS live playlist
      // starts at the lowest rendition, q 1080p60 -> 360p) and the old 32 s
      // window called a working go-live a failure. Accept the reset as the
      // transition, then require two consecutive ADVANCING live samples.
      let prev = null;
      let stable = 0;
      let last = null;
      let reset = false;
      for (let i = 0; i < 150 && stable < 2; i++) {
        await delay(500);
        const v = await st();
        last = v;
        const ok = !v.onDvr && v.lat >= 0 && v.lat < 8 && v.state === 'Playing';
        if (ok && v.pos < 60 && prev && prev.pos > 100) reset = true;
        const advancing = ok && prev && (reset ? v.pos > prev.pos + 0.2 : v.pos > prev.pos + 0.3);
        stable = advancing ? stable + 1 : 0;
        prev = v;
      }
      if (stable < 2) return { pass: false, detail: `live never advanced (${JSON.stringify(last)})` };
      const a = await st();
      await delay(2000);
      const b = await st();
      const adv = b.pos - a.pos;
      // The reset may already have happened before the first sample (the
      // switch can complete inside the click's settle), so the clock SHAPE is
      // the evidence: a pre-click broadcast position (>200 s) that is now a
      // session position (<200 s) means the live url took over.
      const liveClock = b.pos < 200 && g0.pos > 200;
      return {
        pass: b.state === 'Playing' && !b.onDvr && adv > 1.2 && (reset || liveClock),
        detail: `reset=${reset} liveClock=${liveClock} onDvr=${b.onDvr} lat=${b.lat} pos=${a.pos}->${b.pos} adv=${adv.toFixed(2)}s`,
      };
    });
    await row('quality-480p', async () => {
      const cur = await st();
      if (!cur.q) return { pass: false, detail: 'no quality reported' };
      await s.page.click('#ko-settings', { real: true, settle: 500 });
      const clicked = await s.page.evalMain(`(() => {
        const items = [...document.querySelectorAll('#ko-quality-menu button')];
        const want = items.find((b) => /480p/.test(b.textContent || ''));
        if (!want) return 'no 480p item: ' + items.map((b) => b.textContent).join('|');
        want.click();
        return 'clicked';
      })()`);
      if (clicked !== 'clicked') return { pass: false, detail: String(clicked) };
      const w = await waitFor((v) => v.q === '480p', 20000);
      return { pass: w.ok, detail: `from=${cur.q} to=${w.v.q} (${w.ms}ms)` };
    });
    await row('latency-at-edge', async () => {
      const a = await st();
      return { pass: a.lat > 0.2 && a.lat < 6, detail: `lat=${a.lat}s pos=${a.pos} state=${a.state}` };
    });

    const failed = rows.filter((r) => !r.pass).length;
    console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} kickparity rows=${rows.length} failed=${failed}`);
    s.cdp.close();
    if (failed) process.exitCode = 1;
    return;
  }

  if (cmd === 'live') {
    const CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    const gql = async (query, cookie) => {
      const headers = { 'Client-ID': CLIENT, 'Content-Type': 'text/plain' };
      if (cookie) headers.Cookie = cookie;
      if (cookie && token) headers.Authorization = 'OAuth ' + token;
      const r = await fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: JSON.stringify({ query }) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text };
    };
    const wanted = String(flags.channel || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const out = { account: null, followed: [], named: [], errors: [], notes: [] };

    // The session cookie, if a browser with it is reachable.
    let cookie = '';
    let token = '';
    const port = Number(flags.port || 9222);
    try {
      const cdp = await connect(port);
      const ck = await cdp.send('Storage.getCookies', {});
      cdp.close();
      const mine = (ck.cookies || []).filter((c) => /(^|\.)twitch\.tv$/.test(c.domain || ''));
      cookie = mine.map((c) => `${c.name}=${c.value}`).join('; ');
      // Twitch resolves the GQL viewer from the Authorization header, not from
      // the cookie jar alone (measured 2026-11-09: cookie-only -> currentUser
      // null). The token is the same `auth-token` cookie the page sends.
      const tk = mine.find((c) => c.name === 'auth-token');
      if (tk) token = tk.value;
      if (!mine.length) out.notes.push(`port ${port}: browser reachable, no twitch.tv cookie`);
    } catch (e) {
      out.notes.push(`port ${port}: no browser (${String(e.message || e).slice(0, 80)}); followed list skipped`);
    }

    if (cookie) {
      const r = await gql('{ currentUser { login follows(first:100) { edges { node { login displayName stream { viewersCount game { name } } } } } } }', cookie);
      if (flags.raw) console.log('[raw followed]', String(r.text).slice(0, 600));
      const u = r.json && r.json.data && r.json.data.currentUser;
      if (u) {
        out.account = u.login;
        if (u.follows === null) out.notes.push('Twitch refused the followed list for this client (service error): name channels with --channel=');
        out.followedTotal = ((u.follows && u.follows.edges) || []).length;
        for (const e of (u.follows && u.follows.edges) || []) {
          const n = (e && e.node) || {};
          if (!n.stream) continue;
          out.followed.push({ login: n.login, viewers: n.stream.viewersCount, game: (n.stream.game && n.stream.game.name) || '' });
        }
        out.followed.sort((a, b) => b.viewers - a.viewers);
      } else {
        out.errors.push(`followed: http ${r.status} ${String(r.text).slice(0, 120)}`);
      }
    }

    // The account's OWN channel is always worth answering: "is my channel on
    // air" is the question the followed list was standing in for, and Twitch
    // refuses `follows` without the web app's integrity headers (measured
    // 2026-11-09: service error). One public query, no session needed.
    if (out.account && !wanted.includes(out.account.toLowerCase())) wanted.push(out.account.toLowerCase());

    if (wanted.length) {
      const r = await gql(`{ users(logins: ${JSON.stringify(wanted)}) { login stream { viewersCount game { name } } } }`);
      const list = (r.json && r.json.data && r.json.data.users) || null;
      if (list) {
        for (const name of wanted) {
          const u = list.find((x) => x && String(x.login).toLowerCase() === name) || null;
          out.named.push({ login: name, live: !!(u && u.stream), viewers: u && u.stream ? u.stream.viewersCount : 0, game: u && u.stream && u.stream.game ? u.stream.game.name : '' });
        }
      } else {
        out.errors.push(`named: http ${r.status} ${String(r.text).slice(0, 120)}`);
      }
    }

    if (flags.json) {
      console.log(JSON.stringify(out));
      process.exitCode = out.errors.length ? 1 : 0;
      return;
    }
    console.log(`account: ${out.account || 'unknown'}${cookie ? '' : ' (no session cookie)'}`);
    if (out.followed.length) {
      console.log(`following, LIVE now (${out.followed.length}):`);
      for (const f of out.followed) console.log(`  ${String(f.viewers).padStart(7)}  twitch.tv/${f.login}  ${f.game}`);
    } else if (out.account) {
      console.log(`following: 0 of ${out.followedTotal || 0} followed channel(s) on air right now`);
    }
    for (const n of out.named) console.log(`  ${n.live ? 'LIVE' : 'off '}  twitch.tv/${n.login}  viewers=${n.viewers}  ${n.game}`);
    for (const x of out.notes) console.log(`  note: ${x}`);
    for (const x of out.errors) console.log(`  error: ${x}`);
    process.exitCode = out.errors.length ? 1 : 0;
    return;
  }

  if (cmd === 'tabmute') {
    const targetUrl = (await s.page.evalIsolated('location.href')) || flags.url || DEFAULT_URL;
    const { targetId } = await s.cdp.send('Target.createTarget', { url: targetUrl });
    let other = null;
    for (let i = 0; i < 40 && !other; i++) {
      await delay(500);
      const info = (await s.cdp.send('Target.getTargets')).targetInfos.find((t) => t.targetId === targetId);
      if (!info) continue;
      try {
        const cand = await attach(s.cdp, info, 'tabB');
        await cand.enable({ page: true });
        const ready = await cand.evalIsolated('typeof KOAudio !== "undefined" && typeof KO !== "undefined"').catch(() => false);
        if (ready) other = cand;
      } catch {
        /* content script not injected yet */
      }
    }
    if (!other) throw new Error('second tab never got the content script');
    // Both tabs must see a real, playing native player — the audio surfaces.
    const readTab = async (label, sess) => {
      const iso = await sess.evalIsolated(`({
        intent: KOAudio.intent('twitch'),
        kick: KOAudio.intent('kick'),
        visible: KOAudio.visible(),
        muted: KO.kickMuted,
        slug: KO.slug,
      })`);
      const main = await sess.evalMain(`(() => {
        const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
        return v ? { muted: v.muted, volume: v.volume, paused: v.paused, ct: v.currentTime } : null;
      })()`);
      const stored = await sess.evalIsolated(`new Promise((res) => chrome.storage.local.get('ko.v2', (o) => {
        const st = (o && o['ko.v2']) || {};
        res({ hasVols: Object.prototype.hasOwnProperty.call(st, 'vols'), player: st.player });
      }))`);
      return { label, iso, main, stored };
    };
    // ko-audio.js only attributes a volumechange to the user when it lands
    // within INPUT_FRESH_MS (1200 ms) of a real input event. A synthetic
    // `new Event('pointerdown')` would forge that trust — exactly the class the
    // window exists to stop — so every write below is preceded by a CDP
    // Input.dispatchMouseEvent, which the browser marks trusted.
    const gesture = async (sess) => {
      try {
        await sess.click('video', { real: true, settle: 120 });
      } catch {
        await sess.click('body', { real: true, settle: 120 });
      }
    };
    // Both tabs start audible: a fresh guest profile hands Chrome an autoplay
    // mute, and a real click + the write is the gesture the arbiter reads.
    const unmute = async (sess) => {
      await gesture(sess);
      return sess.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      if (!v) return false;
      v.muted = false;
      if (v.volume === 0) v.volume = 0.6;
      return !v.muted;
    })()`);
    };
    await unmute(s.page);
    await unmute(other);
    await delay(1500);
    const out = { url: targetUrl, before: {}, after: {}, uTurn: {} };
    out.before.A = await readTab('A', s.page);
    out.before.B = await readTab('B', other);

    // The gesture: a real click in tab A, then Twitch's own volume button
    // writes element.muted, which fires the volumechange the arbiter reads. No
    // KOAudio call is made here.
    await gesture(s.page);
    await s.page.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      if (!v) return false;
      v.muted = true;
      return v.muted;
    })()`);
    await delay(1500);
    out.after.A = await readTab('A', s.page);
    out.after.B = await readTab('B', other);

    // Reverse direction, the owner's "e vice versa": unmute A, then mute B and
    // require A to stay audible; then unmute B.
    await gesture(s.page);
    await s.page.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      if (!v) return false;
      v.muted = false;
      return !v.muted;
    })()`);
    await delay(1200);
    out.uTurn.A = await readTab('A', s.page);
    await gesture(other);
    await other.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      if (!v) return false;
      v.muted = true;
      return v.muted;
    })()`);
    await delay(1200);
    out.muteB = { A: await readTab('A', s.page), B: await readTab('B', other) };
    await gesture(other);
    await other.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      if (!v) return false;
      v.muted = false;
      return !v.muted;
    })()`);
    await delay(1200);
    out.unmuteB = { A: await readTab('A', s.page), B: await readTab('B', other) };

    const fails = [];
    const intentOf = (t) => (t && t.iso && t.iso.intent ? t.iso.intent.muted : null);
    if (intentOf(out.before.A) === null || intentOf(out.before.B) === null) fails.push('no KOAudio intent readable');
    if (intentOf(out.after.A) !== true) fails.push('tab A did not take the mute');
    if (intentOf(out.after.B) !== intentOf(out.before.B)) fails.push('tab B intent CHANGED with tab A mute');
    if (out.after.B && out.after.B.main && out.before.B && out.before.B.main && out.after.B.main.muted !== out.before.B.main.muted) {
      fails.push('tab B native element CHANGED with tab A mute');
    }
    if (out.after.B && out.after.B.stored && out.after.B.stored.hasVols) fails.push('shared record still carries vols');
    if (intentOf(out.uTurn.A) !== false) fails.push('tab A did not take its own unmute');
    if (intentOf(out.muteB.B) !== true) fails.push('tab B did not take its own mute');
    if (intentOf(out.muteB.A) !== false) fails.push('tab A was muted/unmuted by tab B mute');
    if (intentOf(out.unmuteB.A) !== false) fails.push('tab A changed with tab B unmute');
    if (out.muteB.A && out.muteB.A.main && out.muteB.A.main.muted !== false) fails.push('tab A native muted by tab B mute');

    const brief = (t) => ({
      intentMuted: t.iso.intent.muted,
      intentVol: t.iso.intent.volume,
      nativeMuted: t.main ? t.main.muted : null,
      nativeVol: t.main ? t.main.volume : null,
      hasVols: t.stored.hasVols,
    });
    const table = {
      before: { A: brief(out.before.A), B: brief(out.before.B) },
      afterMuteInA: { A: brief(out.after.A), B: brief(out.after.B) },
      afterUnmuteInA: { A: brief(out.uTurn.A) },
      afterMuteInB: { A: brief(out.muteB.A), B: brief(out.muteB.B) },
      afterUnmuteInB: { A: brief(out.unmuteB.A), B: brief(out.unmuteB.B) },
    };
    console.log(JSON.stringify(table, null, 2));
    console.log(`[tabmute] ${fails.length ? 'FAIL' : 'PASS'} ${fails.length ? fails.join(' | ') : 'one tab gesture stays in that tab'}`);
    try { await s.cdp.send('Target.closeTarget', { targetId }); } catch { /* guest tab already gone */ }
    s.cdp.close();
    process.exitCode = fails.length ? 1 : 0;
    return;
  }

  // ---- muteauthor: who moved the sound, on a real page -------------------
  // Owner order 2026-11-12: "tu tem que entender se o mute vem do meu click do
  // mouse e se vem de alguma decisao do codigo. (no caso, logga isso)". The
  // verdict script reads the same field, so the two must agree: this arm proves
  // the FIELD is written, by driving three cases on one live tab and reading
  // `origin` back out of the extension's own adlog.
  if (cmd === 'muteauthor') {
    const url = flags.url || (await s.page.evalIsolated('location.href')) || DEFAULT_URL;
    const rows = [];
    // Read by the log's OWN monotonic counter, never by array index: the ring
    // caps at LOG_MAX (1200) and then wraps, so `slice(mark)` returns NOTHING
    // forever on a long-lived tab. That is exactly how this arm reported NONE
    // for a gesture the adlog had recorded (measured 2026-11-13). `n` is
    // stamped by adblock-bridge.js and survives the wrap.
    const lastSeq = async () => {
      const n = await s.page.evalIsolated(`new Promise((res) => chrome.storage.local.get('ko.adlog', (o) => {
        const log = (o && o['ko.adlog']) || [];
        let m = 0;
        for (const r of log) if (r && typeof r.n === 'number' && r.n > m) m = r.n;
        res(m);
      }))`);
      return Number(n) || 0;
    };
    const readSince = async (mark) => {
      const log = await s.page.evalIsolated(`new Promise((res) => chrome.storage.local.get('ko.adlog', (o) => {
        const all = (o && o['ko.adlog']) || [];
        res(all.filter((r) => r && typeof r.n === 'number' ? r.n > ${mark} : false));
      }))`);
      return log || [];
    };
    const lastOrigin = (log) => {
      const intents = log.filter((e) => e.ev === 'audio-intent');
      return intents.length ? String((intents[intents.length - 1].d || {}).origin || 'MISSING') : 'NONE';
    };
    let mark = await lastSeq();

    // (1) HIS POINTER: a real trusted click, then the element's own volume
    //     changes — exactly what Twitch's volume button does.
    try { await s.page.click('video', { real: true, settle: 120 }); } catch { await s.page.click('body', { real: true, settle: 120 }); }
    // Write the OPPOSITE of what the ELEMENT currently holds, not the opposite
    // of the intent. A held-muted element (kick mode keeps the native muted
    // because it is not the visible surface) already equals `!intent.muted`, so
    // writing that value is a no-op that fires NO volumechange and the arm then
    // reports `origin=NONE` for a correct build — measured 2026-11-13. The
    // gesture the reader must see is a real change on the element.
    await s.page.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      if (!v) return false;
      v.muted = !v.muted;
      if (v.volume === 0) v.volume = 0.5;
      return v.muted;
    })()`);
    await delay(900);
    rows.push({ step: 'pointer', origin: lastOrigin(await readSince(mark)), want: 'user:pointer' });
    mark = await lastSeq();

    // (2) THE CODE: the extension's own bar button, via a real click on it.
    let hit = null;
    for (let i = 0; i < 12 && !hit; i += 1) {
      hit = await s.page.evalIsolated(`(() => {
        const b = document.querySelector('#ko-mute');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
      })()`);
      if (!hit) await delay(500);
    }
    // THE BAR ONLY EXISTS WHERE THE EXTENSION OWNS THE PICTURE. In `player=twitch`
    // the overlay is deliberately never mounted (`activeLayerLive`), so a missing
    // `#ko-mute` is the product working, not an unproven author. Reporting it as
    // FAIL made this arm red on a correct build (measured 2026-11-13), which is
    // the same "the instrument blames the product" failure as the index reader.
    const mode = String((await s.page.evalIsolated(`new Promise((res) => chrome.storage.local.get('ko.v2', (o) => res(((o && o['ko.v2']) || {}).player || 'kick')))`)) || 'kick');
    if (hit) {
      await s.page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 }, s.page.sessionId);
      await s.page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 }, s.page.sessionId);
      await delay(900);
      rows.push({ step: 'bar', origin: lastOrigin(await readSince(mark)), want: 'user:ui:bar-*' });
    } else rows.push({ step: 'bar', origin: mode === 'twitch' ? 'N/A' : 'MISSING', want: 'user:ui:bar-*', mode });

    // (3) THE MACHINE: a sound change with NO input near it must be refused AND
    //     logged, and the intent must not move. The direction is an UNMUTE on
    //     purpose: `muted = true` on an element the arbiter is already holding
    //     muted fires no volumechange at all (measured on the first run of this
    //     arm), so it would prove a silence, not a refusal. An unmute against
    //     the arbiter's derived state always fires one.
    await delay(1600); // past INPUT_FRESH_MS: the next change is nobody's
    mark = await lastSeq();
    const beforeMute = await s.page.evalIsolated(`KOAudio.intent('twitch')`);
    const elBefore = await s.page.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      return v ? { muted: v.muted, volume: v.volume } : null;
    })()`);
    await s.page.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      if (!v) return false;
      if (v.volume === 0) v.volume = 0.5;
      v.muted = false; // the machine trying to make the page audible
      return true;
    })()`);
    await delay(900);
    const refusedLog = await readSince(mark);
    const refusedRows = refusedLog.filter((e) => e.ev === 'audio-refused');
    const refused = refusedRows.length;
    const why = refused ? String((refusedRows[refusedRows.length - 1].d || {}).why || '') : '';
    const staleOrigin = lastOrigin(refusedLog);
    const afterMute = await s.page.evalIsolated(`KOAudio.intent('twitch')`);
    const elAfter = await s.page.evalMain(`(() => {
      const v = [...document.querySelectorAll('video')].find((x) => x.isConnected && x.readyState > 0) || document.querySelector('video');
      return v ? { muted: v.muted, volume: v.volume } : null;
    })()`);
    rows.push({
      step: 'stale',
      origin: staleOrigin,
      want: 'NONE (refused)',
      refused,
      why,
      intentMoved: afterMute.muted !== beforeMute.muted,
      elementBefore: elBefore,
      elementAfter: elAfter,
    });

    const stale = rows.find((r) => r.step === 'stale');
    const fails = [];
    if (!/^user:pointer/.test(rows[0].origin)) fails.push(`pointer step origin=${rows[0].origin}`);
    if (hit && !/^user:ui:bar/.test(rows[1].origin)) fails.push(`bar step origin=${rows[1].origin}`);
    if (stale.origin !== 'NONE') fails.push(`stale change was ACCEPTED as ${stale.origin}`);
    if (!stale.refused) fails.push('stale change left no audio-refused line');
    if (stale.why !== 'stale-input') fails.push(`refusal reason=${stale.why} (want stale-input)`);
    if (stale.intentMoved) fails.push('stale change moved the intent');
    if (stale.elementAfter && stale.elementAfter.muted === false) {
      fails.push('the arbiter did not re-assert the machine element back to muted');
    }
    // Only a mode that is SUPPOSED to mount the bar can fail this step.
    if (!hit && mode !== 'twitch') fails.push(`bar was never visible in player=${mode}: the ui author is UNPROVEN here`);
    console.log(JSON.stringify({ url, rows }, null, 2));
    console.log(`[muteauthor] ${fails.length ? 'FAIL' : 'PASS'} ${fails.length ? fails.join(' | ') : 'pointer/bar accepted with their author, machine mute refused'}`);
    s.cdp.close();
    process.exitCode = fails.length ? 1 : 0;
    return;
  }

  if (cmd === 'check') {
    const { runCheck } = await import('./ko-harness-check.mjs');
    const yt = flags.yt || DEFAULT_YT;
    const report = await runCheck(s, {
      yt,
      adblock: !flags['no-adblock'],
      viewport: { width: Number(flags.width || 1600), height: Number(flags.height || 900) },
      onRefresh: () => refreshIframes(s),
    });
    s.cdp.close();
    process.exitCode = report.failed ? 1 : 0;
    return;
  }

  throw new Error(`unknown command ${cmd}`);
}

main()
  .then(() => {
    // A detached guest + the browser WebSocket can keep handles alive; this is
    // a CLI, so exit explicitly (the guest is detached and keeps running).
    setTimeout(() => process.exit(process.exitCode || 0), 150);
  })
  .catch((e) => {
    console.error('[harness] ERROR', e?.stack || e?.message || e);
    process.exit(1);
  });
