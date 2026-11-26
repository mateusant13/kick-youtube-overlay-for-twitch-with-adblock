#!/usr/bin/env node
// Generate the HLS programs the replica plays, once, into the declared store.
//
// A LADDER, not one rendition, and the reason is measured: the owner's own ring
// (build 0.8.115, twitch.tv/buzzyi_) reveals the clean player at `q:"360p"`
// twice on a 1280x720 player, and a fixture with a single 1280x720 variant
// cannot represent that at all - `q` was a constant, so every quality defect
// was invisible offline. hls.js picks a rung by bandwidth AND by player size
// (`capLevelToPlayerSize`), so the ladder has to exist before the pick can be
// wrong.
//
// Content is a moving test pattern (a real clock the extension can measure);
// the ad is a solid blue program so a screenshot says "this is the ad" without
// guessing. Both are encoded per rung with identical keyframe cadence and
// segment boundaries, which is what lets hls.js switch rungs without a
// discontinuity in the middle of a fragment.
//
// Cache key is the encode parameter string, printed as MISS/CACHE HIT so a
// re-run is not counted as a new measurement.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = process.env.KO_REPLICA_MEDIA || 'G:/Temp/ko-replica/media';
const FFMPEG = process.env.KO_FFMPEG || 'ffmpeg';
const SEG = Number(process.env.KO_REPLICA_SEG || 2);
// This box is 10x weaker than it looks: one encode at a time, two threads, and
// a declared ceiling in the command that starts it (AGENTS.md).
const THREADS = process.env.KO_REPLICA_THREADS || '2';

// Rungs are served as 720p/480p/360p. 720p is the top so a 1280x720 player has
// somewhere to be capped DOWN to; 360p is the rung the owner actually saw.
// `kbps` is an explicit target with a 1 s-rate cap, which is what a real ladder
// is: the first encode without a bitrate target produced 109 MB at 720p for
// 120 s of motion-heavy test pattern (measured 2026-11-25) against a 0.4 GiB
// store budget. The ladder's own numbers are the reason ABR has a choice.
export const RUNGS = [
  { v: 720, w: 1280, h: 720, bw: 1400000, kbps: 1200 },
  { v: 480, w: 854, h: 480, bw: 800000, kbps: 650 },
  { v: 360, w: 640, h: 360, bw: 450000, kbps: 350 },
];

// ONE owner for the program length. `server.mjs` derives its segment count and
// its live window from these numbers; two constants in two files drifted once
// already (media became 60 s while the server still assumed 120 s, so the clean
// frame requested content_*_030.. and got 404 for every one, measured
// 2026-11-26 in run 1795662048928: `Buffering rs=0 hold=0`, no reveal).
export const PROGRAM_SECONDS = { content: 60, ad: 30 };

const PROGRAMS = [
  {
    id: 'content',
    source: 'testsrc2=size=1280x720:rate=30',
    seconds: PROGRAM_SECONDS.content,
    profile: 'main',
    level: '3.1',
  },
  {
    id: 'ad',
    source: 'color=c=0x0000FF:size=1280x720:rate=30',
    seconds: PROGRAM_SECONDS.ad,
    profile: 'main',
    level: '3.1',
  },
];

const sig = (p, r) =>
  `ffmpeg|${p.source}|${p.seconds}s|${SEG}s-fmp4|h264:${p.profile}:${p.level}|${r.w}x${r.h}|${r.kbps}k|30fps|t${THREADS}`;

export function ensureMedia({ quiet = false } = {}) {
  mkdirSync(DIR, { recursive: true });
  const out = [];
  for (const p of PROGRAMS) {
    for (const r of RUNGS) {
      const stem = `${p.id}_${r.v}`;
      const key = sig(p, r);
      const playlist = `${DIR}/${stem}.m3u8`;
      const init = `${DIR}/${stem}_init.mp4`;
      const keyFile = `${DIR}/${stem}.key`;
      const done = existsSync(playlist) && existsSync(init) &&
        existsSync(keyFile) && readFileSync(keyFile, 'utf8').trim() === key &&
        readFileSync(playlist, 'utf8').includes(`${stem}_000.m4s`);
      if (done) {
        if (!quiet) console.log(`${stem} CACHE HIT ${key}`);
        out.push({ id: p.id, v: r.v, dir: DIR, playlist, init });
        continue;
      }
      if (!quiet) console.log(`${stem} MISS ${key}`);
      execFileSync(FFMPEG, [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', p.source,
        '-t', String(p.seconds),
        '-vf', `scale=${r.w}:${r.h}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', THREADS,
        '-b:v', `${r.kbps}k`, '-maxrate', `${Math.round(r.kbps * 1.2)}k`,
        '-bufsize', `${r.kbps * 2}k`,
        '-profile:v', p.profile, '-level', p.level,
        '-pix_fmt', 'yuv420p',
        '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        '-an',
        '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0',
        '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', `${stem}_init.mp4`,
        '-hls_segment_filename', `${DIR}/${stem}_%03d.m4s`,
        playlist,
      ], { stdio: quiet ? 'ignore' : 'inherit' });
      writeFileSync(keyFile, key);
      out.push({ id: p.id, v: r.v, dir: DIR, playlist, init });
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = ensureMedia();
  console.log(`media ready: ${r.length} program x rung in ${DIR}`);
}
