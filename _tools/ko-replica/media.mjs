#!/usr/bin/env node
// Generate the two HLS programs the replica plays, once, into the declared
// store. Content is a moving test pattern (a real clock the extension can
// measure); the ad is a solid blue frame so a screenshot says "this is the ad"
// without guessing. ffmpeg is the same binary the machine already ships.
//
// Cache key is the encode parameter string, printed as MISS/CACHE HIT so a
// re-run is not counted as a new measurement.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = process.env.KO_REPLICA_MEDIA || 'G:/Temp/ko-replica/media';
const FFMPEG = process.env.KO_FFMPEG || 'ffmpeg';
// Segment duration is a fixture property: hls.js only ever holds liveSyncDuration
// of forward buffer on 2 s segments, and the extension's health gate needs 3 s.
// 6 s segments put the playhead up to a segment behind the playlist end, which
// is the shape real Twitch clean masters have (measured clean hold 4.3-9 s).
const SEG = Number(process.env.KO_REPLICA_SEG || 2);

const PROGRAMS = [
  {
    id: 'content',
    source: 'testsrc2=size=640x360:rate=30',
    seconds: 120,
    profile: 'main',
    level: '3.1',
  },
  {
    id: 'ad',
    source: 'color=c=0x0000FF:size=640x360:rate=30',
    seconds: 30,
    profile: 'main',
    level: '3.1',
  },
];

function sig(p) {
  return `ffmpeg|${p.source}|${p.seconds}s|${SEG}s-fmp4|h264:${p.profile}:${p.level}|640x360|30fps`;
}

export function ensureMedia({ quiet = false } = {}) {
  mkdirSync(DIR, { recursive: true });
  const out = [];
  for (const p of PROGRAMS) {
    const key = sig(p);
    const playlist = `${DIR}/${p.id}.m3u8`;
    const init = `${DIR}/${p.id}_init.mp4`;
    const keyFile = `${DIR}/${p.id}.key`;
    const done = existsSync(playlist) && existsSync(init) &&
      existsSync(keyFile) && readFileSync(keyFile, 'utf8').trim() === key &&
      readFileSync(playlist, 'utf8').includes(`${p.id}_000.m4s`);
    if (done) {
      if (!quiet) console.log(`${p.id} CACHE HIT ${key}`);
      out.push({ id: p.id, dir: DIR, playlist, init });
      continue;
    }
    if (!quiet) console.log(`${p.id} MISS ${key}`);
    execFileSync(FFMPEG, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', p.source,
      '-t', String(p.seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-profile:v', p.profile, '-level', p.level,
      '-pix_fmt', 'yuv420p',
      '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
      '-an',
      '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0',
      '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', `${p.id}_init.mp4`,
      '-hls_segment_filename', `${DIR}/${p.id}_%03d.m4s`,
      playlist,
    ], { stdio: quiet ? 'ignore' : 'inherit' });
    writeFileSync(keyFile, key);
    out.push({ id: p.id, dir: DIR, playlist, init });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = ensureMedia();
  console.log(`media ready: ${r.length} programs in ${DIR}`);
}
