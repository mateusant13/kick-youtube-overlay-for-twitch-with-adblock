// Latency arm for the owner report 2026-11-07: "E AINDA ASSIM, FICOU COM DELAY A LIVE"
// after the ad swap.
//
// What it measures: after a real ad-hold reveals the clean player, how far behind the
// live edge does the picture the user is watching sit, second by second. The clean
// player reports {pos, lat} from its own session every ~1 s; `lat` is edge - position.
// A live stream should sit within a few seconds of the edge, and must not drift.
//
// This is deliberately NOT a pod test: the ad-hold is injected, the source is real.
// It answers "what latency does the swap leave behind", which is the part the owner
// can feel, and it fails loudly instead of guessing.
//
// Usage: node _tools/ko-live-latency-arm.mjs [port] [settleSec] [sampleSec]
import { connect, findTargets, attach, delay } from './ko-cdp.mjs';

const port = Number(process.argv[2] || 9333);
const settleSec = Number(process.argv[3] || 12);
const sampleSec = Number(process.argv[4] || 30);
const out = { instrument: 'live-latency-arm', settle_sec: settleSec, sample_sec: sampleSec };

const cdp = await connect(port);
async function attachPage(tries = 8) {
  let lastErr = new Error('no page target');
  for (let k = 0; k < tries; k++) {
    const t = await findTargets(cdp);
    if (t.page) {
      try {
        return await attach(cdp, t.page, 'page');
      } catch (e) {
        lastErr = e;
      }
    }
    await delay(300);
  }
  throw lastErr;
}

const s = await attachPage();
await s.refreshContexts();
function findCtx() {
  return (s.contexts || []).find(
    (c) => c.auxData && c.auxData.isDefault && String(c.origin || '').startsWith('https://www.twitch.tv'),
  );
}
let ctx = findCtx();
if (!ctx) {
  console.log('RESULT NO-VERDICT live-latency-arm (no twitch.tv main-world context)');
  process.exit(1);
}
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

// Wait for the frame and a page id (the extension is alive on this page).
let first = null;
for (let k = 0; k < 300; k++) {
  const p = await evalPage(
    `({frame:!!document.getElementById('ko-adfix'),pageId:(window.__koTwitchAdblockStats||{}).pageId||null,href:location.href})`,
  );
  if (p.frame && p.pageId) {
    first = p;
    break;
  }
  await delay(100);
}
if (!first) {
  console.log(JSON.stringify(out, null, 2));
  console.log('RESULT NO-VERDICT live-latency-arm (no #ko-adfix frame in 30 s)');
  process.exit(1);
}

const SAMPLE = `(()=>{const st=(window.__koTwitchAdblockStats||{});const v=document.querySelector('video');
  const se=v&&v.seekable&&v.seekable.length?v.seekable.end(v.seekable.length-1):null;
  return {at:Math.round(performance.now()),
    lastSt:st.lastSt?{state:st.lastSt.state,pos:st.lastSt.pos,lat:st.lastSt.lat}:null,
    nativeLat:se!==null&&v?+(se-v.currentTime).toFixed(1):null,
    nativeCt:v?+Number(v.currentTime||0).toFixed(1):null,
    revealed:!!(document.getElementById('ko-adfix')||{}).style&&document.getElementById('ko-adfix').style.opacity==='1'};})()`;

// Let the page settle so the native is genuinely live before we touch it.
await delay(settleSec * 1000);
out.steps.before = await evalPage(SAMPLE);

// Real ad-hold; the standby has its own real source.
out.steps.hold_posted = await evalPage(`(()=>{const c=new BroadcastChannel('ko-adblock-bypass');
  c.postMessage({type:'ad-hold',page:${JSON.stringify(first.pageId)},channel:null});c.close();return true;})()`);

// Wait for the reveal (frame opaque), then sample latency.
let revealed = false;
for (let k = 0; k < 60; k++) {
  await delay(500);
  const p = await evalPage(SAMPLE);
  if (p.revealed) {
    revealed = true;
    out.steps.revealed_at_ms = p.at;
    out.steps.reveal_sample = p;
    break;
  }
}
if (!revealed) {
  console.log(JSON.stringify(out, null, 2));
  console.log('RESULT NO-VERDICT live-latency-arm (the overlay never revealed in 30 s)');
  process.exit(1);
}

const trace = [];
for (let k = 0; k < sampleSec; k++) {
  await delay(1000);
  const p = await evalPage(SAMPLE);
  trace.push({ t_s: k + 1, lat: p.lastSt ? p.lastSt.lat : null, pos: p.lastSt ? p.lastSt.pos : null, nativeLat: p.nativeLat });
}
out.trace = trace;
const lats = trace.map((x) => Number(x.lat)).filter((x) => Number.isFinite(x));
const tail = lats.length > 10 ? lats.slice(10) : lats;
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
out.verdict = {
  samples: lats.length,
  first_lat: lats.length ? lats[0] : null,
  last_lat: lats.length ? lats[lats.length - 1] : null,
  median_lat_after_10s: med(tail),
  max_lat: lats.length ? Math.max(...lats) : null,
  // The product target is 3 s, the catch-up threshold 8 s (twitch-adblock.js:162-163).
  within_target: med(tail) !== null && med(tail) <= 4.5,
};
out.pass = out.verdict.within_target;
console.log(JSON.stringify(out, null, 2));
console.log(
  out.pass
    ? `RESULT PASS live-latency-arm (median ${out.verdict.median_lat_after_10s}s behind the edge after the swap)`
    : `RESULT FAIL live-latency-arm (median ${out.verdict.median_lat_after_10s}s behind the edge after the swap, max ${out.verdict.max_lat}s)`,
);
cdp.close();
process.exit(out.pass ? 0 : 1);
