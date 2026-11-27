// Print the owner Chrome's ad log WITHOUT the worker/playlist noise, newest window
// last. Read-only: no reload, no seek, no page touch (a hidden extension page is
// opened to reach chrome.storage from the extension origin; the service worker
// sleeps and cannot be asked directly).
//   node _tools/ko-adlog-window.mjs [port] [rows] [--keep a,b,c]
import { connect } from './ko-cdp.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2] || 9222);
const rows = Number(process.argv[3] || 120);
const keepArg = process.argv.indexOf('--keep');
const KEEP = keepArg > 0 ? new Set(process.argv[keepArg + 1].split(',')) : null;
const NOISE = new Set(['worker-playlist', 'video-waiting', 'video-playing', 'worker-debug', 'ad-net', 'bypass-msg']);

const cdp = await connect(port);
const { targetInfos } = await cdp.send('Target.getTargets');
const worker = targetInfos.find((t) => t.type === 'service_worker' && /kick|overlay/i.test(t.url));
let extId = null;
try {
  const list = await cdp.send('Extensions.getExtensions');
  extId = ((list.extensions || []).find((e) => /Overlay/i.test(e.name || '')) || {}).id || null;
} catch { /* not started with unsafe extension debugging */ }
if (!extId && worker) extId = (worker.url.match(/^chrome-extension:\/\/([a-p]+)/) || [])[1];
if (!extId) { console.log('no extension id (worker asleep and no Extensions.getExtensions)'); process.exit(2); }

const created = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html`, hidden: true, background: true });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sessionId);
await delay(800);
const got = await cdp.send('Runtime.evaluate', {
  expression: `new Promise(r => chrome.storage.local.get(null, o => r({ ver: chrome.runtime.getManifest().version, log: o['ko.adlog'] || [], state: o['ko.v2'] || null })))`,
  returnByValue: true, awaitPromise: true,
}, sessionId);
const { ver, log, state } = got.result.value;
console.log('--- version', ver, 'entries', log.length, 'state', JSON.stringify({ player: state && state.player, adblock: state && state.adblock }));
const win = log.slice(-rows);
let prev = null;
for (const e of win) {
  if (KEEP ? !KEEP.has(e.ev) : NOISE.has(e.ev)) continue;
  const d = JSON.stringify(e.d || {});
  const dt = prev ? `+${e.t - prev}` : '';
  prev = e.t;
  // KO_FULL=1 prints the whole record: a truncated row hides the fields a
  // report actually turns on (measured 2026-11-25: `st.clean` was cut exactly
  // where the reveal's source and quality live).
  const LIMIT = process.env.KO_FULL === '1' ? Infinity : 240;
  console.log(String(e.t).slice(-6), dt.padStart(6), e.ev.padEnd(20), d.length > LIMIT ? d.slice(0, LIMIT) + '…' : d);
}
await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
cdp.close();
