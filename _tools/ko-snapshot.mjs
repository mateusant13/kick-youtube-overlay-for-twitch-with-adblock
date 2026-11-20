#!/usr/bin/env node
// ko-snapshot: WHAT DOES THE EXTENSION BELIEVE RIGHT NOW?
//
// The ring (`ko.adlog`) is a history of TRANSITIONS, and ko-adlog-verdict reads
// it. Neither answers "is the extension, at this instant, wrong?" - a state that
// is stably wrong emits no transition, so a frozen player and a healthy one look
// identical in the ring after the first row. Measured tonight: a native element
// sat at rs=1, ct frozen for 70s, and the ring had no row for the whole stretch.
//
// This probe answers the other question. It reads the state the page PUBLISHES
// into the DOM (`data-ko-*`, written by adblock-bridge and content.js), then
// samples the main media element twice to decide PLAYING / FROZEN / PAUSED /
// REPEAT. Read-only: no click, no seek, no pause, no navigate. Safe on the
// owner's tab while he watches.
//
// Why the DOM and not `KO`: `KO` is a closure inside the content script, not
// reachable from another world. The attributes are the extension's own published
// contract - reading them is reading what it DECIDED. What they cannot tell us
// is printed at the end rather than guessed.
//
//   node _tools/ko-snapshot.mjs              # port 9222 (the owner's Chrome)
//   node _tools/ko-snapshot.mjs 9446         # a guest
//   node _tools/ko-snapshot.mjs 9222 --json

import { connect } from 'file:///C:/Users/Administrador/.agents/skills/_packs/task/chrome-unpacked-extension-deploy/scripts/cdp.mjs';

const port = Number(process.argv[2]) || 9222;
const asJson = process.argv.includes('--json');

const SNAP = `(() => {
  const root = document.documentElement;
  const attr = (n) => { try { return root.getAttribute(n); } catch (e) { return null; } };
  const vids = [...document.querySelectorAll('video')].map((v) => {
    let ahead = null, se = null;
    try { const b = v.buffered; if (b && b.length) ahead = +(b.end(b.length - 1) - v.currentTime).toFixed(2); } catch (e) {}
    try { const s = v.seekable; if (s && s.length) { const e = s.end(s.length - 1); se = e < 1e6 ? +e.toFixed(2) : 'SENTINEL'; } } catch (e) {}
    return { w: v.videoWidth || 0, h: v.videoHeight || 0, ct: +(v.currentTime || 0).toFixed(2),
             paused: !!v.paused, muted: !!v.muted, vol: +(v.volume == null ? 1 : v.volume).toFixed(2),
             rs: v.readyState, ahead, seekableEnd: se };
  });
  const main = vids.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0] || null;
  return { href: location.href, vis: document.visibilityState,
    owner: attr('data-ko-owner'), adblock: attr('data-ko-adblock'),
    audio: { m: attr('data-ko-audio-m'), v: attr('data-ko-audio-v'), vis: attr('data-ko-audio-vis'),
             wt: attr('data-ko-audio-wt'), it: attr('data-ko-audio-it') },
    wrap: !!document.getElementById('ko-wrap'),
    frame: !!document.querySelector('#ko-wrap iframe'),
    bar: !!document.getElementById('ko-g1') || !!document.getElementById('ko-bar'),
    vids, main };
})()`;

const cdp = await connect(port);
const { targetInfos } = await cdp.send('Target.getTargets');

const wanted = [];
for (const t of targetInfos) {
  if (t.type !== 'page' || !/^https?:/.test(t.url || '')) continue;
  let host;
  try { host = new URL(t.url).hostname; } catch { continue; }
  if (/(^|\.)twitch\.tv$/.test(host) || /(^|\.)youtube\.com$/.test(host)) wanted.push(t);
}

if (!wanted.length) {
  const pages = targetInfos.filter((t) => t.type === 'page').length;
  console.error(`no Twitch/YouTube tab on port ${port} (${pages} page target(s) total)`);
  process.exit(2);
}

const out = [];
for (const t of wanted.slice(0, 4)) {
  let sessionId;
  try {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }));
    await cdp.send('Runtime.enable', {}, sessionId);
    const a = await cdp.evaluate(SNAP, sessionId);
    await cdp.delay(1500);
    const b = await cdp.evaluate(SNAP, sessionId);
    out.push({ title: t.title, a, b });
  } catch (e) {
    out.push({ title: t.title, url: t.url, error: e.message });
  } finally {
    if (sessionId) { try { await cdp.send('Target.detachFromTarget', { sessionId }, undefined, 5000); } catch { /* gone */ } }
  }
}
cdp.close();

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

let anomalies = 0;
for (const o of out) {
  if (o.error) { console.log(`\n${o.url}\n  CANNOT-MEASURE: ${o.error}`); continue; }
  const { a, b } = o;
  const m = b.main, m0 = a.main;
  console.log(`\n${b.href}`);
  console.log(`  tab=${b.vis}  adblock=${b.adblock ?? 'null'}  wrap=${b.wrap}  frame=${b.frame}  bar=${b.bar}`);
  console.log(`  owner=${b.owner || '(empty)'}  audio(m=${b.audio.m} v=${b.audio.v} vis=${b.audio.vis} wt=${b.audio.wt} it=${b.audio.it})`);
  if (!m) {
    console.log('  NO VIDEO ELEMENT in this page');
  } else {
    const adv = m0 ? +(m.ct - m0.ct).toFixed(2) : null;
    // A LAYER THAT OWNS THE PICTURE IS THE SURFACE, and the page's own element
    // is paused BY DESIGN (`syncMute()` pauses every page video so one surface
    // renders at a time). Reading that pause as the verdict answered the wrong
    // question: measured on a guest with `player=kick`, the kick frame reported
    // Playing at ct 169->201 and lat 1.65 while this probe printed `-> PAUSED`.
    // The element state stays printed; it just stops being the verdict.
    const layerSurface = !!(b.owner && b.frame);
    let verdict;
    if (m.paused) verdict = 'PAUSED';
    else if (adv !== null && Math.abs(adv) < 0.1) verdict = 'FROZEN (claims to play, clock did not move in 1.5s)';
    else if (adv !== null && adv < -1) verdict = `REPEAT (${adv}s backwards in 1.5s)`;
    else verdict = 'PLAYING';
    console.log(`  main ${m.w}x${m.h} ct=${m.ct}${adv !== null ? ` (${adv >= 0 ? '+' : ''}${adv}s/1.5s)` : ''} rs=${m.rs} ahead=${m.ahead ?? 'null'} seekableEnd=${m.seekableEnd}`);
    if (layerSurface) {
      console.log(`  muted=${m.muted} vol=${m.vol} paused=${m.paused} (page element; the surface is the ${b.owner} frame)`);
      console.log(`  -> SURFACE=FRAME(${b.owner})  this element's state is not the verdict; the frame's own pos/lat are in the ring`);
    } else {
      console.log(`  muted=${m.muted} vol=${m.vol} paused=${m.paused}  -> ${verdict}`);
    }
    if (b.vids.length > 1) console.log(`  (${b.vids.length} video elements; the largest is shown)`);
    const anomaly = (s) => { anomalies += 1; console.log(`  ANOMALY: ${s}`); };
    if (b.wrap && !b.frame) anomaly('#ko-wrap exists with no iframe (the frame was torn down)');
    if (b.owner && !b.wrap) anomaly(`owner="${b.owner}" but #ko-wrap is absent (ownership published with nothing mounted)`);
    if (!b.owner && b.frame) console.log('  NOTE: frame mounted but the owner attribute is empty (a pod may hold the screen)');
    if (!layerSurface) {
      if (!m.paused && adv !== null && Math.abs(adv) < 0.1) anomaly('the element claims to play and its clock does not advance');
      if (!m.paused && m.rs <= 1) anomaly(`playing with readyState ${m.rs} (no data)`);
    }
  }
}

console.log(`
NOT measurable from the DOM - do not infer these:
  - which branch a seek/arrow decision took (no row, no attribute exist)
  - the clean/standby frame's own pos/lat (cross-origin: read via ko-adlog)
  - why a video is paused (the user, code, or the page's own player)
Those live in the ring: node _tools/ko-adlog-verdict.mjs --episodes=N`);

process.exit(anomalies ? 1 : 0);
