// Reachability arm for KO-20261023-01 (cold cover) in real Chrome.
//
// What it proves (0.8.51 contract, and the reason the contract changed): on a real
// Twitch page with the shipped extension, an ad-hold that arrives while the clean
// source is not yet healthy (the cold state) FREEZES the picture on the ad-hold tick —
// the native <video> is PAUSED and NOT hidden, so the last live frame stays on screen —
// with a small centred notice panel and the clean frame not raised. It must resolve
// inside the bound (3000 ms) either by revealing a healthy player or by failing open
// (which seeks the native to the live edge and skips the rest of the pod).
//
// 0.8.48 hid the native and painted an inset:0 black panel for up to 9 s; the owner
// photographed exactly that on 2026-11-08, which is why "covered" is no longer a pass
// condition and "not hidden" is.
//
// Why "early": overlay.playing turns true only after three consecutive healthy
// heartbeats (twitch-adblock.js:1288-1293) and the health test ignores the video's
// paused flag, so pausing the clean player does NOT reproduce the cold state. Cold
// means the frame exists and healthyTicks is still under 3, which only happens right
// after the standby starts. Run this immediately after
//   node _tools/ko-harness.mjs start <twitch URL> --fresh
// and it polls up to 60 s for #ko-adfix, then posts the real ad-hold on the
// extension's own BroadcastChannel at the first sight of the frame.
//
// The ad-hold is injected: a Twitch-served ad that paints is still NOT MEASURED and
// needs the owner's Chrome. What this removes is the whole class of "the branch may
// never run in production" doubt.
//
// Outcome vocabulary:
//   RESULT PASS        cover on the hold tick, native hidden, resolved in bound
//   RESULT NO-VERDICT  the branch was not reached (no frame, late start, warm path)
//   RESULT FAIL        the branch ran and the contract was violated
//
// Usage: node _tools/ko-real-arm-d1.mjs [port] [channel]
import { connect, findTargets, attach, delay } from './ko-cdp.mjs';

const port = Number(process.argv[2] || 9333);
const channel = process.argv[3] || '';
const out = { instrument: 'd1-early-arm', steps: {} };

const cdp = await connect(port);
async function attachFresh(kind, tries = 6) {
  let lastErr = new Error(`no ${kind} target`);
  for (let k = 0; k < tries; k++) {
    // In the owner's Chrome the matching tab is not the first one: prefer a
    // real twitch channel and never fall back to a YouTube tab.
    const t = await findTargets(cdp, { pageRe: /twitch\.tv\/[a-z0-9_]/i });
    const target = kind === 'page' ? t.page : t.hls;
    if (target) {
      try {
        return await attach(cdp, target, kind);
      } catch (e) {
        lastErr = e;
      }
    }
    await delay(500);
  }
  throw lastErr;
}

const s = await attachFresh('page');
await s.refreshContexts();
const ctx = (s.contexts || []).find(
  (c) => c.auxData && c.auxData.isDefault && String(c.origin || '').startsWith('https://www.twitch.tv'),
);
if (!ctx) {
  console.log('RESULT NO-VERDICT d1-early-arm (no twitch.tv main-world context)');
  process.exit(1);
}
const evalPage = (expr) => s.evalRaw(expr, { contextId: ctx.id });

const PROBE = `(()=>{const f=document.getElementById('ko-adfix');const vids=[...document.querySelectorAll('video')];
  const c=document.getElementById('ko-adfix-cover');
  return {at:Math.round(performance.now()),
    frame:f?{opacity:f.style.opacity}:null,
    cover:c?{display:c.style.display,text:c.textContent}:null,
    native:vids.map(v=>({vis:v.style.visibility,paused:v.paused,ct:+Number(v.currentTime||0).toFixed(1)})),
    st:((window.__koTwitchAdblockStats||{}).lastMsg||{}).st||null,
    last:(window.__koTwitchAdblockStats||{}).lastAdLog||null};})()`;

// Wait for the frame, then hold on the same tick it appears.
let first = null;
const t0 = Date.now();
for (let k = 0; k < 600; k++) {
  const p = await evalPage(
    `({frame:!!document.getElementById('ko-adfix'),pageId:(window.__koTwitchAdblockStats||{}).pageId||null,href:location.href})`,
  );
  if (p.frame && p.pageId) {
    first = p;
    break;
  }
  await delay(100);
}
out.steps.frame_seen_at_ms = first ? Date.now() - t0 : null;
out.steps.page = first;
if (!first) {
  console.log(JSON.stringify(out, null, 2));
  console.log('RESULT NO-VERDICT d1-early-arm (no #ko-adfix frame appeared in 60 s)');
  process.exit(1);
}

out.steps.before_hold = await evalPage(PROBE);
// Event stream, not last-event polling: adLog dispatches a `ko-adlog` CustomEvent,
// and a reveal between two 500 ms samples was invisible to the last-only probe.
out.steps.listener = await evalPage(`(()=>{
  window.__koArmLog = [];
  if (!window.__koArmHooked) {
    window.__koArmHooked = true;
    document.addEventListener('ko-adlog', (e) => { try { window.__koArmLog.push(JSON.parse(e.detail)); } catch (err) {} });
  }
  return {hooked:true, seen: window.__koArmLog.length};
})()`);
out.steps.hold_posted = await evalPage(`(()=>{const c=new BroadcastChannel('ko-adblock-bypass');
  c.postMessage({type:'ad-hold',page:${JSON.stringify(first.pageId)},channel:${JSON.stringify(channel||null)}});c.close();return true;})()`);

const fast = [];
for (let k = 0; k < 30; k++) {
  await delay(100);
  fast.push(await evalPage(PROBE));
}
const cover = fast.find((x) => x.last && x.last.ev === 'cold-cover');
out.cover = {
  events: [...new Set(fast.map((x) => (x.last ? x.last.ev : null)).filter(Boolean))],
  cold_cover_at_ms: cover ? cover.at : null,
  frame_opaque_at_ms: (fast.find((x) => x.frame && x.frame.opacity === '1') || {}).at ?? null,
  native_hidden_when_held: cover ? cover.native.length > 0 && cover.native.every((v) => v.vis === 'hidden') : null,
  native_paused_when_held: cover ? cover.native.length > 0 && cover.native.every((v) => v.paused === true) : null,
  frame_opaque_when_held: cover ? cover.frame && cover.frame.opacity === '1' : null,
  cover_shown_when_held: cover ? !!(cover.cover && cover.cover.display === 'flex') : null,
  panel_css_when_held: cover ? String((cover.cover && cover.cover.cssText) || '') : null,
  clean_st: cover ? cover.st : null,
  samples: fast.slice(0, 4),
};

if (!cover) {
  console.log(JSON.stringify(out, null, 2));
  console.log('RESULT NO-VERDICT d1-early-arm (hold posted at first frame sight still did not cold-cover)');
  process.exit(1);
}

const tail = [];
for (let k = 0; k < 28; k++) {
  await delay(500);
  const p = await evalPage(PROBE);
  tail.push({ at_ms: 3000 + (k + 1) * 500, ev: p.last ? p.last.ev : null, opacity: p.frame ? p.frame.opacity : null, nativeVis: p.native.map((v) => v.vis) });
  const log = await evalPage(`(window.__koArmLog||[]).filter((e)=>e.ev!=="bypass-msg")`);
  if (log.some((e) => /cold-cover-timeout|overlay-stop|overlay-reveal/.test(String(e.ev)))) break;
}
out.tail = tail;
out.events = await evalPage(
  `(window.__koArmLog||[]).filter((e)=>e.ev!=="bypass-msg").map((e)=>({ev:e.ev, ms:e.d&&e.d.ms}))`,
);
const resolved = (out.events || []).find((e) => /cold-cover-timeout|overlay-stop|overlay-reveal/.test(String(e.ev)));
const coverAt = cover ? (cover.last.d && cover.last.d.ms) : null;
out.verdict = {
  cold_cover_logged: true,
  frame_opaque_on_hold: out.cover.frame_opaque_at_ms !== null,
  native_hidden_on_cover: out.cover.native_hidden_when_covered,
  resolved: resolved ? resolved.ev : null,
  resolved_at_ms: resolved ? resolved.ms : null,
  until_resolved_ms: resolved && coverAt !== null ? resolved.ms - coverAt : null,
  within_bound:
    !!resolved &&
    resolved.ms - coverAt <= 3000 &&
    /cold-cover-timeout|overlay-stop|overlay-reveal/.test(String(resolved.ev)),
};
// 0.8.51 contract: the hold FREEZES the picture (native paused, not hidden), the
// notice is a small panel and not a full-screen rectangle, and the clean picture is
// not raised before it exists.
out.verdict.frozen_not_black = out.verdict.native_hidden_when_held === false
  && out.verdict.native_paused_when_held === true
  && out.verdict.cover_shown_when_held === true
  && !/inset:\s*0/.test(String(out.verdict.panel_css_when_held || ''))
  && out.verdict.frame_opaque_when_held === false;
out.pass = out.verdict.frozen_not_black && out.verdict.within_bound;
console.log(JSON.stringify(out, null, 2));
console.log(out.pass ? 'RESULT PASS d1-early-arm (hold froze the picture: native paused and visible, small panel, frame raised only with a picture, resolved in bound)' : 'RESULT FAIL d1-early-arm');
cdp.close();
process.exit(out.pass ? 0 : 1);
