#!/usr/bin/env node
// THE VERDICT READER MUST NOT REPORT BLINDNESS IT CAN LIFT.
//
// MEASURED live 2026-11-27 (0.8.130, guest Chrome, four page loads on a real
// Twitch stream): one episode printed
//   worker-hooked=NONE: ... (the player started no worker, or the row was evicted)
// while the SAME episode carried `worker-playlist=2`. A playlist row is posted from
// inside `workerMain()`, the prelude stringified into the patched worker's blob, so
// one playlist row is proof the hook ran; the honest answer is EVICTED, not "a clean
// playlist could not be proven". The reader can separate the two causes from data it
// already holds, so it must.
//
// Arms (black box, through the CLI the project actually reads):
//   1. playlists but no hook row -> `worker-hooked=EVICTED`, never "could not be proven"
//   2. playlists AND a hook row  -> `worker-hooked=worker` (unchanged)
//   3. no playlist and no hook   -> the NONE line survives for the case it is true of
//   4. the EVICTED line is not a defect: exit stays 0
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const READER = path.join(ROOT, '_tools', 'ko-adlog-verdict.mjs');
const SCRATCH = 'G:/Temp/ko-scratch';

let checks = 0;
let failed = 0;
const lines = [];
function ok(cond, label, detail = '') {
  checks += 1;
  if (cond) lines.push(`  ok   ${label}`);
  else {
    failed += 1;
    lines.push(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

let t = Date.parse('2026-11-27T08:20:00Z');
function ev(name, d = {}, gapMs = 120) {
  t += gapMs;
  return { ev: name, t, d };
}

// Episode A: playlists posted, no worker-hook row (the live shape that triggered this).
const epA = [
  ev('recorder-ready', { ver: '0.8.130', slug: 'twitch' }, 0),
  ev('script-start', { href: 'https://www.twitch.tv/twitch' }),
  ev('worker-playlist', { extinf: 4, adExtinf: 0, url: 'https://video-edge/x.m3u8' }),
  ev('worker-playlist', { extinf: 4, adExtinf: 0, url: 'https://video-edge/x.m3u8' }),
];
// Episode B: the hook row survived.
const epB = [
  ev('recorder-ready', { ver: '0.8.130', slug: 'twitch' }, 500),
  ev('worker-hook', { kind: 'worker', src: 'https://player.ttvnw.net/x.js' }),
  ev('worker-playlist', { extinf: 4, adExtinf: 0, url: 'https://video-edge/y.m3u8' }),
];
// Episode C: nothing was fetched at all - the case the NONE line is true of.
const epC = [ev('recorder-ready', { ver: '0.8.130', slug: 'twitch' }, 500), ev('script-start', { href: 'https://www.twitch.tv/twitch' })];

mkdirSync(SCRATCH, { recursive: true });
// Two fixtures, because the third shape (nothing fetched) IS a defect by the
// product's own rule and must exit 1; mixing it in would make an exit code that
// means two things.
const hooked = path.join(SCRATCH, `adlog-fixture-hooked-${process.pid}.json`);
const silent = path.join(SCRATCH, `adlog-fixture-silent-${process.pid}.json`);
writeFileSync(hooked, JSON.stringify([...epA, ...epB]), 'utf8');
writeFileSync(silent, JSON.stringify(epC), 'utf8');

function read(file, episodes) {
  // `--span` is MILLISECONDS in this reader, and the fixture spans ~2 s; a 60
  // passed here clipped every row and every arm went green against an empty ring
  // (measured while writing this arm). Ten minutes is the whole fixture.
  const r = spawnSync(process.execPath, [READER, `--file=${file}`, `--episodes=${episodes}`, '--span=600000'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    killSignal: 'SIGKILL',
  });
  return { rc: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

try {
  const r = read(hooked, 2);
  const rn = read(silent, 1);

  // 1. The episode with playlists and no hook row is EVICTED, and the ambiguous
  //    sentence is gone from THAT episode's block.
  const blocks = r.out.split(/^EPISODE /m).slice(1);
  const a = blocks[0] || '';
  const b = blocks[1] || '';
  const c = rn.out.split(/^EPISODE /m).slice(1)[0] || '';
  ok(/worker-hooked=EVICTED/.test(a), 'arm1: playlists without a hook row reads EVICTED', a.match(/worker-hooked=\S+/)?.[0] || '(no AD DEFENCE line)');
  ok(/2 playlist row\(s\) in this episode/.test(a), 'arm1: the line carries the playlist count it inferred from');
  ok(!/could not be proven/.test(a), 'arm1: no blindness claim over evidence in hand', a.match(/could not be proven/)?.[0] || '');

  // 2. A surviving hook row still names its kind.
  ok(/worker-hooked=worker\b/.test(b), 'arm2: a surviving hook row is reported by kind', b.match(/worker-hooked=\S+/)?.[0] || '');

  // 3. The genuinely empty episode keeps the NONE line.
  ok(/worker-hooked=NONE/.test(c), 'arm3: no playlist and no hook keeps NONE', c.match(/worker-hooked=\S+/)?.[0] || '');
  ok(/could not be proven/.test(c), 'arm3: NONE still says the proof is missing');

  // 4. EVICTED is not a defect (exit 0), while the genuinely silent load still fails -
  //    so the exit code answers the same question in both directions.
  ok(r.rc === 0, 'arm4: EVICTED is not a defect - exit 0', `rc=${r.rc}`);
  ok(rn.rc === 1, 'arm4: the silent load still exits 1 (the arm can fail the other way)', `rc=${rn.rc}`);
} finally {
  for (const f of [hooked, silent]) { try { unlinkSync(f); } catch { /* exact path */ } }
}

for (const l of lines) console.log(l);
console.log(`RESULT ${failed === 0 ? 'PASS' : 'FAIL'} adlog-verdict checks=${checks} failed=${failed} arms=4/4`);
process.exit(failed === 0 ? 0 : 1);
