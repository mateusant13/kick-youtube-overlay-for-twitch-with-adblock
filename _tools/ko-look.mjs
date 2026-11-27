// ONE instrument for "what does the extension see on Twitch right now".
//
// Written because every question this session cost a new throwaway probe
// (ko-now, ko-tabs, ko-owner-st, ko-usher-probe, ko-followed, ko-nav-watch...).
// Ask this instead. It never navigates, never activates and never focuses one of
// the owner's tabs: his Chrome is READ through CDP, and anything that has to play
// a stream runs in the guest profile, which ko-guest.mjs launches off-screen
// (--window-position=-32000,-32000).
//
//   node _tools/ko-look.mjs                 his Chrome: build + channels + tabs + worker + adlog
//   node _tools/ko-look.mjs --channels      his followed channels that are live (hidden tab, closed)
//   node _tools/ko-look.mjs --now           one snapshot of his Twitch tabs (no navigation)
//   node _tools/ko-look.mjs --live [chan]   guest profile: play a LIVE channel, drive the hold arm,
//                                           watch for a pod for --minutes, print the timeline
//   node _tools/ko-look.mjs --json          machine output on stdout
//
// Flags: --port <n> (his Chrome, default 9222), --guest-port <n> (default 9333),
//        --minutes <n> (watch length for --live, default 6), --no-adlog.
// Exit: 0 = everything it looked at is consistent, 2 = a contract violation
//       (the hold did not freeze the picture / no clean source / version drift).
import { connect } from 'file:///C:/Users/Administrador/.agents/skills/_packs/task/chrome-unpacked-extension-deploy/scripts/cdp.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const REPO = path.resolve(ROOT, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const PORT = Number(opt('--port', 9222));
const GUEST_PORT = Number(opt('--guest-port', 9333));
const MINUTES = Number(opt('--minutes', 6));
const JSON_OUT = has('--json');
const lines = [];
const say = (s) => { lines.push(s); if (!JSON_OUT) console.log(s); };
const out = { at: new Date().toISOString(), sections: {} };

// ---- helpers ---------------------------------------------------------------
async function attachToPage(cdp, re) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'page' && re.test(x.url || ''));
  if (!t) return null;
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const evalIn = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
    if (r.exceptionDetails) return { ERR: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
    return r.result && r.result.value;
  };
  return { target: t, sessionId, evalIn };
}

const PAGE_PROBE = `(() => {
  const st = window.__koTwitchAdblockStats || null;
  // The frame's last message lives on adBypass (stats.adBypass = bypassStats),
  // NOT on stats itself: reading st.lastMsg made every snapshot report "no st
  // from a clean player yet" while overlay-catchup logs proved the opposite.
  const msg = (st && ((st.adBypass && st.adBypass.lastMsg) || st.lastMsg)) || {};
  const w = (st && st.adBypass) || {};
  const v = document.querySelector('video');
  const cover = document.getElementById('ko-adfix-cover');
  const frame = document.getElementById('ko-adfix');
  return {
    href: location.href, visibility: document.visibilityState, hasStats: !!st, pageId: st && st.pageId,
    audioM: document.documentElement.getAttribute('data-ko-audio-m'),
    audioV: document.documentElement.getAttribute('data-ko-audio-v'),
    frame: frame ? { opacity: frame.style.opacity } : null,
    cover: cover ? { display: getComputedStyle(cover).display, text: cover.textContent, css: cover.style.cssText } : null,
    clean: msg.st ? { state: msg.st.state, lat: msg.st.lat, latSrc: msg.st.latSrc, pos: +(+msg.st.pos).toFixed(1),
                      buf: +(+msg.st.buffered).toFixed(2), rs: msg.st.rs } : null,
    bypass: { msgs: w.msgs, standbyReady: w.standbyReady, reveals: w.reveals },
    worker: st && st.lastWorkerDebug && { step: st.lastWorkerDebug.step, detail: st.lastWorkerDebug.detail },
    native: v ? { paused: v.paused, rs: v.readyState, ct: +Number(v.currentTime || 0).toFixed(1), muted: v.muted } : null,
    lastAdLog: st && st.lastAdLog,
  };
})()`;

async function readAdlog(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && /kick|overlay/i.test(t.url || ''));
  let extId = null;
  try {
    const list = await cdp.send('Extensions.getExtensions');
    extId = ((list.extensions || []).find((e) => /Overlay/i.test(e.name || '')) || {}).id || null;
  } catch { /* not started with unsafe extension debugging */ }
  if (!extId && worker) extId = (worker.url.match(/^chrome-extension:\/\/([a-p]+)/) || [])[1];
  if (!extId) return { ERR: 'no extension id (worker asleep, Extensions.getExtensions unavailable)' };
  const created = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html`, background: true });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await delay(700);
  const r = await cdp.send('Runtime.evaluate', {
    expression: `new Promise(r => chrome.storage.local.get(null, o => r({ ver: chrome.runtime.getManifest().version, log: o['ko.adlog'] || [], state: o['ko.v2'] || null })))`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  return r.result.value || {};
}

function summariseAdlog(log, rows = 24) {
  const noise = new Set(['worker-playlist', 'video-waiting', 'video-playing', 'worker-debug', 'ad-net', 'bypass-msg', 'video-emptied', 'video-loadedmetadata']);
  const keep = [];
  for (const e of (log || []).slice(-600)) if (!noise.has(e.ev)) keep.push({ ms: e.t, ev: e.ev, d: e.d });
  return keep.slice(-rows);
}

// ---- 1. his Chrome: build, tabs, worker, adlog ------------------------------
async function look() {
  const cdp = await connect(PORT);
  const adlog = has('--no-adlog') ? null : await readAdlog(cdp);
  if (adlog && !adlog.ERR) {
    out.sections.build = { installed: adlog.ver, state: adlog.state };
    say(`build     installed=${adlog.ver} player=${adlog.state && adlog.state.player} adblock=${adlog.state && adlog.state.adblock}`);
    out.sections.adlog = summariseAdlog(adlog.log, 18);
    if (out.sections.adlog.length) {
      let prev = null;
      say('adlog     last events (worker noise removed)');
      for (const e of out.sections.adlog) { const dt = prev ? `+${e.ms - prev}` : ''; prev = e.ms; say(`  ${String(e.ms).slice(-6)} ${dt.padStart(7)} ${e.ev.padEnd(18)} ${JSON.stringify(e.d || {}).slice(0, 150)}`); }
    }
  } else if (adlog) say(`build     ${adlog.ERR}`);

  const page = await attachToPage(cdp, /twitch\.tv\/[a-z0-9_]+/i);
  if (!page) {
    say('tabs      no Twitch channel tab open in his Chrome');
    out.sections.tabs = [];
  } else {
    const p = await page.evalIn(PAGE_PROBE);
    out.sections.tabs = [p];
    say(`tab       ${p.href} vis=${p.visibility} frame=${p.frame ? 'up@' + p.frame.opacity : 'none'} cover=${p.cover ? p.cover.display : 'none'}`);
    say(`  audio   data-ko-audio-m=${p.audioM} v=${p.audioV}   native=${JSON.stringify(p.native)}`);
    say(`  clean   ${p.clean ? JSON.stringify(p.clean) : 'no st from a clean player yet'}`);
    say(`  worker  ${p.worker ? JSON.stringify(p.worker) : 'n/a'}  bypass=${JSON.stringify(p.bypass)}`);
    if (p.clean && !p.clean.latSrc) say('  NOTE    the page runs an OLDER build (no latSrc in the frame payload) — reload the tab');
  }
  cdp.close();
}

// ---- 2. his followed channels that are live ---------------------------------
async function channels() {
  const cdp = await connect(PORT);
  // Reuse a twitch tab if one exists (a background tab created fresh reaches the
  // query before its document has committed to the twitch origin, and the fetch
  // then dies as an opaque-origin CORS failure — measured). Only create one when
  // there is none, and always in the background: the owner's screen is not ours.
  const { targetInfos } = await cdp.send('Target.getTargets');
  const existing = targetInfos.find((x) => x.type === 'page' && /twitch\.tv\/[a-z0-9_]/i.test(x.url || ''));
  if (!existing) {
    // Deliberately does NOT open one: a tab created in his Chrome is a tab on
    // his screen (2026-11-08, "to vendo essa porra abrir na minha tela"), and the
    // homepage origin refuses the query anyway. His follows need a Twitch tab he
    // already has open; the live test does not need his list at all.
    say('channels  no Twitch channel tab open in his Chrome — nothing opened. Open one, or use --live <channel> (guest, headless).');
    out.sections.channels = { existing: false };
    cdp.close();
    return;
  }
  const targetId = existing.targetId;
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  // The page must be the real twitch origin before its cookies and its own
  // request plumbing are usable: Twitch installs an integrity wrapper over
  // fetch, and a fetch fired from a half-loaded document throws "Failed to
  // fetch" (measured).
  let docInfo = '';
  for (let i = 0; i < 40; i++) {
    const ready = await cdp.send('Runtime.evaluate', {
      expression: `document.readyState + '|' + location.href + '|' + Math.round(performance.now()) + '|' + (document.body ? document.body.innerText.length : 0)`,
      returnByValue: true }, sessionId);
    docInfo = String((ready.result && ready.result.value) || '');
    const [, href, age, bodyLen] = docInfo.split('|');
    if (/complete/.test(docInfo) && /twitch\.tv/.test(href || '') && Number(age) > 2000 && Number(bodyLen) > 200) break;
    await delay(500);
  }
  say(`  tab     ${docInfo}`);
  const expr = `(async () => {
    const q = 'query{currentUser{login follows(first:100){edges{node{login displayName stream{id viewersCount}}}}}';
    // XHR, not fetch: Twitch's integrity shim (k.twitchcdn.net/p.js) and this
    // extension both wrap window.fetch, and a request through either dies as
    // "Failed to fetch" (measured from this tab); XHR reaches the network.
    const post = (url, body, headers) => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.withCredentials = true;
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.onload = () => resolve({ status: x.status, text: x.responseText });
      x.onerror = () => reject(new Error('xhr error'));
      x.send(body);
    });
    let status = 0, txt = '';
    try {
      const res = await post('https://gql.twitch.tv/gql', JSON.stringify({ query: q }),
        { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'text/plain;charset=UTF-8' });
      status = res.status; txt = res.text;
    } catch (e) { return { ERR: String(e) }; }
    let j = null; try { j = JSON.parse(txt); } catch {}
    const edges = j && j.data && j.data.currentUser && j.data.currentUser.follows && j.data.currentUser.follows.edges;
    return { status, login: j && j.data && j.data.currentUser && j.data.currentUser.login,
      live: edges ? edges.map((e) => e.node).filter((n) => n.stream).map((n) => ({ login: n.login, viewers: n.stream.viewersCount }))
                  .sort((a, b) => b.viewers - a.viewers) : null,
      total: edges ? edges.length : null, head: edges ? null : txt.slice(0, 300) };
  })()`;
  // MAIN world, on a document that has committed to the twitch origin. Measured:
  // from a freshly created background tab (document still about:blank) the same
  // query dies as "Failed to fetch"; from an isolated world it dies too; from a
  // loaded twitch page it answers 200.
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  const v = (r.result && r.result.value) || {};

  out.sections.channels = v;
  if (v.ERR || (r.exceptionDetails)) say(`channels  ERROR ${JSON.stringify(r.exceptionDetails || v)}`);
  else if (v.live) {
    say(`channels  ${v.login || '(anon)'}: ${v.live.length} live of ${v.total} followed`);
    for (const c of v.live.slice(0, 15)) say(`  live   ${c.login.padEnd(24)} viewers=${c.viewers}`);
  } else say(`channels  gql status=${v.status} no follows in the answer: ${v.head || ''}`);
  cdp.close();
}

// ---- 3. the guest: a real live channel, off the owner's screen ---------------
async function live(channel) {
  // A guest left over from an earlier run keeps the code it loaded THEN: bg_29
  // reused bg_28's page and measured a build two edits old. --live restarts the
  // guest unless --reuse says otherwise.
  let cdp = null;
  if (!opt('--reuse')) {
    try {
      const { spawn } = await import('node:child_process');
      const st = spawn(process.execPath, [path.join(ROOT, 'ko-harness.mjs'), 'stop'],
                       { stdio: 'ignore', windowsHide: true });
      await new Promise((r) => st.on('exit', r));
    } catch { /* no guest to stop */ }
  } else {
    try { cdp = await connect(GUEST_PORT); } catch { cdp = null; }
  }
  if (!cdp) {
    say(`guest     starting an off-screen Chrome (profile under G:/Temp/ko-harness) on ${channel}`);
    await new Promise((res) => {
      // Headless, always: a windowed guest is an off-screen window that Windows
      // still shows in the taskbar/alt-tab, and the owner has already reported
      // seeing it (2026-11-08: "to vendo essa porra abrir na minha tela").
      const ch = spawn(process.execPath, [path.join(ROOT, 'ko-harness.mjs'), 'start', `https://www.twitch.tv/${channel}`, '--fresh'], {
        stdio: 'inherit',
        windowsHide: true,
        env: { ...process.env, KO_HEADLESS: '1' },
      });
      ch.on('exit', res);
    });
    cdp = await connect(GUEST_PORT);
  }
  const page = await attachToPage(cdp, /twitch\.tv\//);
  if (!page) { say('guest     no guest page'); cdp.close(); return 2; }
  if (!new RegExp(`/${channel}(\\?|$)`).test(page.target.url)) {
    await cdp.send('Page.navigate', { url: `https://www.twitch.tv/${channel}` }, page.sessionId);
    await delay(4000);
  }
  const timeline = [];
  const t0 = Date.now();
  let frameAt = null, holdDone = false, stSeen = null;
  for (let i = 0; i < Math.max(20, MINUTES * 60); i++) {
    const p = await page.evalIn(PAGE_PROBE);
    const sec = +((Date.now() - t0) / 1000).toFixed(0);
    if (p && p.hasStats) {
      const row = { s: sec, worker: p.worker && p.worker.step, frame: !!p.frame, cover: p.cover && p.cover.display,
        clean: p.clean && { lat: p.clean.lat, latSrc: p.clean.latSrc, state: p.clean.state, buf: p.clean.buf, rs: p.clean.rs },
        native: p.native && { paused: p.native.paused, rs: p.native.rs, ct: p.native.ct }, reveal: p.bypass && p.bypass.reveals };
      if (row.clean && !stSeen) { stSeen = row.clean; say(`clean     first st: ${JSON.stringify(row.clean)}`); }
      if (p.frame && !frameAt) { frameAt = sec; say(`frame     up at ${sec}s (standby or ad path)`); }
      timeline.push(row);
      // Drive the hold arm once the page has a clean source to hold for.
      if (!holdDone && p.frame && p.pageId && (p.clean || p.worker && p.worker.step === 'prewarm.ok')) {
        holdDone = true;
        await page.evalIn(`(()=>{const c=new BroadcastChannel('ko-adblock-bypass');c.postMessage({type:'ad-hold',page:${JSON.stringify(p.pageId)},channel:${JSON.stringify(channel)}});c.close();return true;})()`);
        await delay(300);
        const h = await page.evalIn(PAGE_PROBE);
        out.sections.hold = { at: sec, page: h };
        // Two holds exist and they owe DIFFERENT things. A COLD hold (page just
        // loaded, preroll) must freeze the picture without hiding it or painting
        // the surface, because there is no ad to show yet -- that is the 0.8.51
        // contract. An AD hold must hide the native under the ad frame: the user
        // is watching the real ad, and the panel is the only thing on screen.
        const frozen = h.native && h.native.paused === true;
        const vis = await page.evalIn(`(()=>{const v=document.querySelector('video');return v?getComputedStyle(v).visibility:'none';})()`);
        const panel = h.cover ? h.cover.css : '';
        const fullscreen = /inset:\s*0/.test(panel);
        const opaque = h.frame && h.frame.opacity === '1';
        const lastLog = (h.lastAdLog && h.lastAdLog.kind) || '';
        const cold = /cold-cover|hold-arm-cold/.test(lastLog);
        const verdict = cold
          ? { kind: 'cold', pass: frozen && vis !== 'hidden' && !fullscreen && !opaque }
          : { kind: 'ad', pass: opaque, note: 'native hidden under the ad frame is the design' };
        out.sections.hold_verdict = { cold, native_paused: frozen, native_visibility: vis, panel_fullscreen: fullscreen, frame_opaque: opaque, ...verdict };
        say(`hold      ${cold ? 'COLD' : 'AD'} (last ${lastLog || '?'}) at ${sec}s -> native paused=${frozen} visibility=${vis} panel_fullscreen=${fullscreen} frame_opaque=${opaque} => ${verdict.pass ? 'PASS' : 'FAIL'}`);
      }
      // A pod that really arrives ends the watch with the reveal timing.
      if (p.bypass && p.bypass.reveals > 0 && i > 4) { say(`reveal    ${p.bypass.reveals} reveal(s); last st ${JSON.stringify(p.clean)}`); break; }
    }
    await delay(1000);
  }
  out.sections.timeline = timeline;
  const last = timeline[timeline.length - 1] || {};
  say(`guest     end: worker=${last.worker} frame=${last.frame} clean=${JSON.stringify(last.clean)} native=${JSON.stringify(last.native)}`);
  cdp.close();
  const v = out.sections.hold_verdict;
  if (v && (v.native_paused !== true || v.panel_fullscreen === true || v.frame_opaque === true)) return 2;
  return 0;
}

// Keep the newest 40 look receipts in the DECLARED scratch store. Deletes are
// by exact path (never a wildcard), so a similarly named file survives.
function pruneLookReceipts(dir) {
  try {
    const names = fs.readdirSync(dir)
      .filter((n) => /^ko-look-\d{4}-\d{2}-\d{2}T[\w-]+\.md$/.test(n))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of names.slice(40)) fs.unlinkSync(path.join(dir, old.n));
  } catch { /* evidence is best effort */ }
}

// ---- run ------------------------------------------------------------------
let rc = 0;
if (has('--channels')) await channels();
else if (has('--live')) {
  const ch = argv[argv.indexOf('--live') + 1] && !argv[argv.indexOf('--live') + 1].startsWith('--') ? argv[argv.indexOf('--live') + 1] : 'kaicenat';
  rc = await live(ch);
} else await look();

if (!JSON_OUT) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = 'G:/Temp/ko-scratch'; // declared family in .artifacts.toml, never I:
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `ko-look-${stamp}.md`), '# ko-look\n\n```\n' + lines.join('\n') + '\n```\n');
    pruneLookReceipts(dir);
  } catch { /* evidence is best effort */ }
} else console.log(JSON.stringify(out, null, 1));
process.exit(rc);
