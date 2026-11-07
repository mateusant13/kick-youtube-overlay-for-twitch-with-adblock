// Reachability arm for the ORPHAN COVER (owner report 2026-11-07: "tomei ad que a
// tela ficou inteira preta ate o ad acabar").
//
// What it proves: when the clean source can never become healthy (the worker answers
// no-source / no-playing, as measured in the owner's own ko.adlog), the cover that
// hides the ad must release on its own inside COLD_COVER_BOUND_MS and restore the
// native player. Without that release the user watches a black rectangle for the whole
// pod, which is exactly what the owner reported.
//
// How the orphan state is produced without a real pod:
//   1. start on a live channel; wait for #ko-adfix while the standby is still cold
//      (healthyTicks < 3, see twitch-adblock.js healthy gate);
//   2. put the clean player's iframe OFFLINE over CDP, so the source can never start;
//   3. post the real ad-hold on the extension's own BroadcastChannel.
// The native player (the page target) is untouched, so the only thing that can make the
// page black is the extension hiding it.
//
// Outcome vocabulary:
//   RESULT PASS        cover went up and released inside the bound, native restored
//   RESULT FAIL        cover went up and did not release inside the bound
//   RESULT NO-VERDICT  the branch was not reached (no frame, already warm)
//
// Usage: node _tools/ko-orphan-cover-arm.mjs [port] [boundMs] [screenshotDir]
import { connect, findTargets, attach, delay } from './ko-cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const port = Number(process.argv[2] || 9333);
const boundMs = Number(process.argv[3] || 9000);
const shots = process.argv[4] || '';
const out = { instrument: 'orphan-cover-arm', bound_ms: boundMs, steps: {} };

const cdp = await connect(port);
async function attachFresh(kind, tries = 8) {
  let lastErr = new Error(`no ${kind} target`);
  for (let k = 0; k < tries; k++) {
    const t = await findTargets(cdp);
    const target = kind === 'page' ? t.page : t.hls;
    if (target) {
      try {
        return await attach(cdp, target, kind);
      } catch (e) {
        lastErr = e;
      }
    }
    await delay(300);
  }
  throw lastErr;
}

const s = await attachFresh('page');
await s.refreshContexts();
function findCtx() {
  return (s.contexts || []).find(
    (c) => c.auxData && c.auxData.isDefault && String(c.origin || '').startsWith('https://www.twitch.tv'),
  );
}
let ctx = findCtx();
if (!ctx) {
  console.log('RESULT NO-VERDICT orphan-cover-arm (no twitch.tv main-world context)');
  process.exit(1);
}
// The page can navigate under us (channel change, Twitch reload); a stale context id
// kills the whole run, so re-resolve once before giving up.
async function evalPage(expr) {
  try {
    return await s.evalRaw(expr, { contextId: ctx.id });
  } catch (e) {
    if (!/context/i.test(String(e && e.message))) throw e;
    await s.refreshContexts();
    ctx = findCtx();
    if (!ctx) throw e;
    return await s.evalRaw(expr, { contextId: ctx.id });
  }
}

const PROBE = `(()=>{const f=document.getElementById('ko-adfix');const vids=[...document.querySelectorAll('video')];
  return {at:Math.round(performance.now()),
    frame:f?{opacity:f.style.opacity}:null,
    native:vids.map(v=>({vis:v.style.visibility,disp:v.style.display,paused:v.paused,ct:+Number(v.currentTime||0).toFixed(1)})),
    last:(window.__koTwitchAdblockStats||{}).lastAdLog||null};})()`;

// Wait for the frame while the standby is still cold.
let first = null;
const t0 = Date.now();
for (let k = 0; k < 300; k++) {
  const p = await evalPage(
    `({frame:!!document.getElementById('ko-adfix'),pageId:(window.__koTwitchAdblockStats||{}).pageId||null,href:location.href})`,
  );
  if (p.frame && p.pageId) {
    first = p;
    break;
  }
  await delay(50);
}
out.steps.frame_seen_at_ms = first ? Date.now() - t0 : null;
if (!first) {
  console.log(JSON.stringify(out, null, 2));
  console.log('RESULT NO-VERDICT orphan-cover-arm (no #ko-adfix frame in 15 s)');
  process.exit(1);
}

// Cut the clean player off, so no health tick can ever arrive.
out.steps.starve = null;
try {
  const h = await attachFresh('hls');
  // attach() returns a session object; every CDP call goes through its cdp + sessionId.
  const hc = (m, p2 = {}) => h.cdp.send(m, p2, h.sessionId);
  await hc('Network.enable');
  await hc('Network.setBlockedURLs', { urls: ['*'] });
  await hc('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  out.steps.starve = 'blocked all urls + offline on the clean player target';
} catch (e) {
  out.steps.starve = `could not starve the clean player: ${e.message}`;
}

out.steps.listener = await evalPage(`(()=>{
  window.__koArmLog = [];
  if (!window.__koArmHooked) {
    window.__koArmHooked = true;
    document.addEventListener('ko-adlog', (e) => { try { window.__koArmLog.push(JSON.parse(e.detail)); } catch (err) {} });
  }
  return {hooked:true};
})()`);

const shot = async (name) => {
  if (!shots) return;
  try {
    mkdirSync(shots, { recursive: true });
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, s.sessionId);
    if (r && r.data) writeFileSync(`${shots}/${name}.png`, Buffer.from(r.data, 'base64'));
  } catch { /* screenshot is evidence, not the verdict */ }
};

out.steps.before_hold = await evalPage(PROBE);
await shot('00-before');
out.steps.hold_posted = await evalPage(`(()=>{const c=new BroadcastChannel('ko-adblock-bypass');
  c.postMessage({type:'ad-hold',page:${JSON.stringify(first.pageId)},channel:null});c.close();return true;})()`);

const samples = [];
let coverAt = null;
let restoredAt = null;
let lastEv = null;
for (let k = 0; k < 50; k++) {
  await delay(500);
  const p = await evalPage(PROBE);
  lastEv = p.last ? p.last.ev : lastEv;
  const covered = p.frame && p.frame.opacity === '1' && p.native.length > 0 && p.native.every((v) => v.vis === 'hidden');
  if (covered && coverAt === null) {
    coverAt = p.at;
    await shot('01-cover');
  }
  if (coverAt !== null && !covered && restoredAt === null) {
    restoredAt = p.at;
    await shot('02-after');
  }
  samples.push({
    at_ms: k * 500 + 500,
    opacity: p.frame ? p.frame.opacity : null,
    nativeVis: p.native.map((v) => v.vis),
    covered,
    ev: p.last ? p.last.ev : null,
  });
  if (coverAt === null && k >= 10) break;
  if (restoredAt !== null) break;
}

out.cover = { covered_at_ms: coverAt, released_at_ms: restoredAt, held_ms: coverAt !== null && restoredAt !== null ? restoredAt - coverAt : null };
out.samples = samples;
out.events = await evalPage(
  `(window.__koArmLog||[]).filter((e)=>!/^(bypass-msg|worker-|video-|playing-not)/.test(String(e.ev))).map((e)=>({ev:e.ev, ms:e.d&&e.d.ms, d:(e.d&&e.d.reason)||null}))`,
);
const released = (out.events || []).find((e) => /cold-cover-timeout|overlay-stop|overlay-reveal/.test(String(e.ev)));
out.verdict = {
  cover_went_up: coverAt !== null,
  released_by: released ? released.ev : null,
  held_ms: out.cover.held_ms,
  within_bound: out.cover.held_ms !== null && out.cover.held_ms <= boundMs + 1500,
  restored_native: restoredAt !== null,
};
out.pass = out.verdict.cover_went_up && out.verdict.restored_native && out.verdict.within_bound;
console.log(JSON.stringify(out, null, 2));
console.log(
  out.pass
    ? `RESULT PASS orphan-cover-arm (cover held ${out.cover.held_ms} ms <= ${boundMs} ms, native restored)`
    : `RESULT FAIL orphan-cover-arm (cover held ${out.cover.held_ms} ms, bound ${boundMs} ms, restored=${out.verdict.restored_native})`,
);
cdp.close();
process.exit(out.pass ? 0 : 1);
