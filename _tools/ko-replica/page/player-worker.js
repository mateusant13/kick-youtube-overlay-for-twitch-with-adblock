// player-worker.js — the replica's player worker.
//
// Loaded as a blob:https://www.twitch.tv/... Worker: that is the URL shape the
// extension's Worker hook rewrites, so every fetch below goes through its
// patched self.fetch, exactly like Twitch's own player worker.
//
// The worker runs MSE and transfers a MediaSourceHandle to the page. Our fMP4
// segments carry their own absolute timestamps (ffmpeg writes a running tfdt),
// so the appender reads tfdt from each segment and sets timestampOffset so the
// block lands exactly where the previous one ended. Without that, re-anchoring
// on buffer end double-counts the segment's own timestamp and leaves holes
// (measured: [0,2] [4,6] [10,12] ... and a stalled playhead at 1.97 s).
const MIME = 'video/mp4; codecs="avc1.4d401f"';
const SEG = 2;
let ms = null;
let sb = null;
let mediaUrl = null;
let lastEnd = 0;
let inited = false;
let timescale = null;
let appended = 0;
const seen = new Set();
let polling = false;

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'start' || polling) return;
  mediaUrl = msg.mediaUrl;
  polling = true;
  try {
    ms = new MediaSource();
    self.postMessage({ type: 'handle', handle: ms.handle }, [ms.handle]);
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    sb = ms.addSourceBuffer(MIME);
    await poll();
  } catch (e) {
    self.postMessage({ type: 'error', error: String(e && e.message || e) });
  }
};

const sleep = (msDelay) => new Promise((r) => setTimeout(r, msDelay));

function waitUpdate() {
  return new Promise((resolve) => {
    const done = () => { sb.removeEventListener('updateend', done); resolve(); };
    sb.addEventListener('updateend', done);
  });
}

async function appendBytes(bytes) {
  if (sb.updating) await waitUpdate();
  sb.appendBuffer(bytes);
  await waitUpdate();
  const b = sb.buffered;
  if (b.length) lastEnd = b.end(b.length - 1);
}

async function fetchBytes(uri) {
  const r = await fetch(uri, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!r.ok) throw new Error(`segment ${r.status} ${uri}`);
  return new Uint8Array(await r.arrayBuffer());
}

function boxes(bytes, start, end) {
  const out = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = start;
  while (i + 8 <= end) {
    const size = dv.getUint32(i);
    if (size < 8 || i + size > end) break;
    out.push({ type: String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]), at: i, size });
    i += size;
  }
  return out;
}

function timescaleOf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const moov of boxes(bytes, 0, bytes.byteLength)) {
    if (moov.type !== 'moov') continue;
    for (const trak of boxes(bytes, moov.at + 8, moov.at + moov.size)) {
      if (trak.type !== 'trak') continue;
      for (const mdia of boxes(bytes, trak.at + 8, trak.at + trak.size)) {
        if (mdia.type !== 'mdia') continue;
        for (const mdhd of boxes(bytes, mdia.at + 8, mdia.at + mdia.size)) {
          if (mdhd.type !== 'mdhd') continue;
          const v = bytes[mdhd.at + 8];
          return v === 1 ? dv.getUint32(mdhd.at + 8 + 4 + 8 + 8) : dv.getUint32(mdhd.at + 8 + 4 + 4);
        }
      }
    }
  }
  return null;
}

function tfdtOf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const moof of boxes(bytes, 0, bytes.byteLength)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(bytes, moof.at + 8, moof.at + moof.size)) {
      if (traf.type !== 'traf') continue;
      for (const tfdt of boxes(bytes, traf.at + 8, traf.at + traf.size)) {
        if (tfdt.type !== 'tfdt') continue;
        const v = bytes[tfdt.at + 8];
        return v === 1
          ? dv.getUint32(tfdt.at + 12) * 4294967296 + dv.getUint32(tfdt.at + 16)
          : dv.getUint32(tfdt.at + 12);
      }
    }
  }
  return null;
}

function parsePlaylist(text, base) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const items = [];
  let disc = false;
  let map = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) map = new URL(m[1], base).toString();
    } else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
      disc = true;
    } else if (line.startsWith('#EXTINF:')) {
      // duration is carried by the segment's own tfdt, not by this line
    } else if (!line.startsWith('#')) {
      items.push({ uri: new URL(line, base).toString(), disc, map });
      disc = false;
    }
  }
  return items;
}

async function apply(text) {
  const items = parsePlaylist(text, mediaUrl);
  self.postMessage({ type: 'playlist', n: items.length, ad: /stitched|X-TV-TWITCH-AD-URL/.test(text) });
  for (const it of items) {
    if (seen.has(it.uri)) continue;
    if (!it.map) continue;                       // a segment with no init is unusable
    if (!inited || it.disc) {
      const initBytes = await fetchBytes(it.map);
      if (!timescale) timescale = timescaleOf(initBytes) || 15360;
      sb.timestampOffset = 0;
      await appendBytes(initBytes);
      inited = true;
    }
    const bytes = await fetchBytes(it.uri);
    const ts = timescale || 15360;
    const tfdt = tfdtOf(bytes);
    // Land the block exactly where the previous one ended. tfdt is in the
    // track's timescale; subtracting it keeps the timeline contiguous no
    // matter which program (content/ad) produced the bytes.
    sb.timestampOffset = lastEnd - (tfdt == null ? 0 : tfdt / ts);
    await appendBytes(bytes);
    seen.add(it.uri);
    appended++;
  }
}

async function poll() {
  let failures = 0;
  while (polling) {
    try {
      const r = await fetch(mediaUrl, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
      if (!r.ok) throw new Error(`playlist ${r.status}`);
      await apply(await r.text());
      failures = 0;
      self.postMessage({ type: 'tick', appended, ct: lastEnd });
    } catch (e) {
      failures++;
      self.postMessage({ type: 'error', error: String(e && e.message || e), failures });
      if (failures > 30) { polling = false; break; }
    }
    await sleep(1000);
  }
}
