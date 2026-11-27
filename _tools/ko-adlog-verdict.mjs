// The DEBUG ANSWER, not a dump. Reads `ko.adlog` (live over CDP, or a JSON array
// with --file) and prints only the decisions that explain what the owner saw:
// which player was on screen when it changed, what the picture was doing, and —
// for every sound change — WHOSE it was (his pointer, our bar, or code).
//
// Owner order 2026-11-12: "teus logs nao e pra ter dump inutil. entao faz um
// script que te diz exatamente o que tu precisa pra debug" and "tu tem que
// entender se o mute vem do meu click do mouse e se vem de alguma decisao do
// codigo".
//
//   node _tools/ko-adlog-verdict.mjs                 # owner Chrome, last 30 min
//   node _tools/ko-adlog-verdict.mjs --port 9447     # a guest browser
//   node _tools/ko-adlog-verdict.mjs --file dump.json
//   node _tools/ko-adlog-verdict.mjs --episodes 2    # last two page loads
//
// Exit code is a verdict, not decoration: 0 = nothing found worth a fix,
// 1 = at least one defect class present (swaps>1 without a pod, freeze >2s,
// sound changed by code, or a mute/volume with no author).
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const argv = process.argv.slice(2);
// `--flag value` AND `--flag=value`, because the second form was silently
// ignored: `--file=dump.json` fell back to the LIVE ring, and a reader that
// answers from a different population than the one it was pointed at is worse
// than no reader (measured 2026-11-24: the dump's pod was outside the 1200-row
// live window, so the verdict reported "no ad signal" for a dump that had one).
const argOf = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 9222));
const FILE = argOf('--file', null);
const EPISODES = Number(argOf('--episodes', 1));
const SPAN_MS = Number(argOf('--span', 30 * 60 * 1000));

// ---- events that answer "what was on screen" -------------------------------
// Everything else (heartbeats, ad-net noise, worker payloads) is not printed.
const SCREEN = new Set([
  'audio-claim',
  'overlay-reveal',
  'overlay-stall-stop',
  'overlay-stall-start',
  'native-handoff',
  'native-catchup',
  'native-edge-recover',
  'native-edge-unusable',
  'native-resume',
  'overlay-nudge',
  'overlay-catchup',
  'cold-cover',
  'overlay-no-playing',
  'video-emptied',
  'ad-ui-on',
  'ad-ui-hold',
  'ad-ui-release',
  'ad-hold',
  'worker-hook',
  'worker-hook-fail',
  'native-stall',
  'native-stall-resume',
  'native-stall-reload',
  'native-stall-skipped',
  'native-stall-recovered',
  'native-stall-failed',
]);
const SOUND = new Set([
  'audio-intent',
  'audio-refused',
  'audio-inherit',
  'audio-visible',
  'audio-mismatch',
  'audio-stale-report',
  'audio-agreed',
  'overlay-audio',
  'video-volume',
]);

async function loadLive() {
  const { connect } = await import(
    'file:///C:/Users/Administrador/.agents/skills/_packs/task/chrome-unpacked-extension-deploy/scripts/cdp.mjs'
  );
  const cdp = await connect(PORT);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && /kick|overlay/i.test(t.url));
  let extId = null;
  try {
    const list = await cdp.send('Extensions.getExtensions');
    extId = ((list.extensions || []).find((e) => /Overlay/i.test(e.name || '')) || {}).id || null;
  } catch {
    /* not started with unsafe extension debugging */
  }
  if (!extId && worker) extId = (worker.url.match(/^chrome-extension:\/\/([a-p]+)/) || [])[1];
  if (!extId) throw new Error('no extension id (worker asleep and no Extensions.getExtensions)');
  const created = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extId}/popup.html`,
    hidden: true,
    background: true,
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await delay(700);
  const got = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `new Promise(r => chrome.storage.local.get(null, o => r({ ver: chrome.runtime.getManifest().version, log: o['ko.adlog'] || [] })))`,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  cdp.close();
  return { ver: got.result.value.ver, log: got.result.value.log };
}

function fmt(ms) {
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}m${(s % 60).toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}

// ---- the answer about the sound --------------------------------------------
// Every intent line now carries `origin` and `ev`. Builds before 0.8.85 carry
// neither, and saying so is the point: an unattributed mute is a defect.
function authorOf(d) {
  const origin = d && d.origin;
  if (!origin) return { who: 'UNLABELLED', cls: 'gap', note: 'build predates origin logging' };
  if (origin.startsWith('user:pointer')) {
    const age = d.ev && typeof d.ev.inputAgeMs === 'number' ? `${d.ev.inputAgeMs} ms after ${d.ev.input}` : 'fresh input';
    return { who: 'USER (pointer)', cls: 'user', note: age };
  }
  if (origin.startsWith('user:ui')) return { who: 'USER (bar/popup)', cls: 'user', note: origin.split(':').slice(2).join(':') || 'ui' };
  if (origin.startsWith('user:frame-slider'))
    return { who: 'USER (frame slider)', cls: 'user', note: 'inside our player frame' };
  if (origin.startsWith('code:')) return { who: 'CODE', cls: 'code', note: origin.slice(5) };
  return { who: origin, cls: 'code', note: '' };
}

function episodesOf(log) {
  const eps = [];
  let cur = null;
  for (const e of log) {
    if (e.ev === 'recorder-ready' || !cur) {
      cur = { start: e.t, ver: null, slug: null, events: [] };
      eps.push(cur);
    }
    const d = e.d || {};
    if (!cur.ver && d.ver) cur.ver = d.ver;
    if (!cur.slug && d.slug) cur.slug = d.slug;
    cur.events.push(e);
  }
  return eps;
}

function reportEpisode(ep, idx) {
  const evs = ep.events;
  // Worker-hook rows are the load's own statement about whether the media
  // fetcher was patched. Collected once, reported in AD DEFENCE.
  const seenHooks = [];
  const last = evs.length ? evs[evs.length - 1].t : ep.start;
  const span = last - ep.start;
  const lines = [];
  const findings = [];

  // ---- swaps: who was on screen, and why it changed
  const swaps = [];
  let reveals = 0;
  for (const e of evs) {
    const d = e.d || {};
    if (e.ev === 'overlay-reveal') {
      reveals = d.n || reveals + 1;
      swaps.push({
        t: e.t,
        kind: 'native -> CLEAN',
        why: `reveal #${reveals} reason=${d.reason || '?'}`,
        extra: [
          // "esta em tempo real?" is a NUMBER, not a feeling: the clean picture's
          // own latency and the instrument that measured it, beside the native's
          // distance from the edge, in the row that names the swap.
          d.lat != null ? `lat=${d.lat}s(${d.latSrc || '?'})` : null,
          d.target != null ? `target=${d.target}s` : null,
          d.edgeBehind != null ? `nativeEdgeBehind=${d.edgeBehind}s` : null,
          d.q != null ? `q=${d.q}` : null,
          d.advanced != null ? `advanced=${d.advanced}s` : null,
          d.sinceMs != null ? `since=${fmt(d.sinceMs)}` : null,
        ].filter(Boolean),
      });
    } else if (e.ev === 'overlay-stall-stop' && d.revealed) {
      const hist = Array.isArray(d.hist) && d.hist.length
        ? ` hist=[${d.hist.slice(-3).map((h) => `${h.rs}/${h.buf ?? '-'}${h.why ? ':' + h.why : ''}`).join(' ')}]`
        : '';
      swaps.push({
        t: e.t,
        kind: 'CLEAN -> native',
        why: `stall-stop kind=${d.kind || '?'}${hist}`,
        extra: [],
      });
    } else if (e.ev === 'audio-claim') {
      if (d.to === 'ad' && !d.from) swaps.push({ t: e.t, kind: 'claim(ad)', why: 'clean player covers the page', extra: [] });
      else if (d.from && !d.to) swaps.push({ t: e.t, kind: 'release(ad)', why: 'clean player gone', extra: [] });
      } else if (e.ev === 'cold-cover') {
      swaps.push({ t: e.t, kind: 'cold-cover', why: `painted=${d.painted}`, extra: [] });
    } else if (e.ev === 'reveal-caught-up' || e.ev === 'reveal-behind') {
      // The reveal that waited for the catch-up is a different event from the
      // reveal that raced it: one shows real time, the other shows the delay it
      // was asked to close. Owner report 2026-11-15 ("não sei se tá em tempo
      // real") is answered BY THIS ROW, not by reading the code.
      swaps.push({
        t: e.t,
        kind: e.ev === 'reveal-caught-up' ? 'catch-up LANDED' : 'catch-up TIMED OUT',
        why: `${e.ev} after ${fmt(d.ms || 0)}`,
        extra: [d.lat != null ? `lat=${d.lat}s` : null, d.target != null ? `target=${d.target}s` : null].filter(Boolean),
      });
    }
  }
  // ---- the ad window: how long an ad played before it was stopped ----------
  // Owner report 2026-11-15: "ad toca por uns 4 segundos até finalmente ser
  // defendido". `ad-ui-on` is when Twitch painted the ad, `ad-ui-hold` is when
  // we stopped it; the difference IS the number that report is about.
  for (const e of evs) if (/^worker-hook/.test(e.ev)) seenHooks.push(e);
  const adWindows = [];
  let adSeen = null;
  for (const e of evs) {
    const d = e.d || {};
    if (e.ev === 'ad-ui-on' && !adSeen) adSeen = { at: e.t, hold: null, release: null, worker: null };
    if (e.ev === 'ad-hold' && adSeen && !adSeen.worker) adSeen.worker = e.t;
    // A TICK'S REFUSAL IS NOT A HOLD. `adUiHoldTick` names every decision it
    // makes under the same event (`act:'skip'`), and a stale standby being torn
    // down (`act:'standby-stale'`) is the opposite of a hold. Listening to the
    // first row of the event would start the defence window at a refusal and
    // credit the ad path with a pause it never took.
    if (e.ev === 'ad-ui-hold' && adSeen
      && adSeen.hold == null
      && d.act !== 'skip'
      && d.act !== 'standby-stale') adSeen.hold = { t: e.t, act: d.act };
    if (e.ev === 'ad-ui-release' && adSeen) {
      adSeen.release = { t: e.t, act: d.act, reasserts: d.reasserts };
      adWindows.push(adSeen);
      adSeen = null;
    }
  }
  if (adSeen) adWindows.push(adSeen);
  const screenSwaps = swaps.filter((s) => s.kind.includes('->') || s.kind === 'cold-cover');
  if (screenSwaps.length > 1) findings.push(`${screenSwaps.length} screen changes in this page (a pod is one)`);

  // ---- hand-back: what the picture was when the pod ended ------------------
  // His 2026-11-15 report has three questions and this section answers two:
  // did the native come back (or stay parked), and how far from the edge is the
  // picture it came back with. `behind:null` means the edge was the 2^30
  // sentinel, i.e. the element's distance from live was NOT measurable at that
  // instant - stated, never guessed.
  const handbacks = [];
  for (let i = 0; i < evs.length; i += 1) {
    if (evs[i].ev !== 'native-handoff') continue;
    const h = evs[i];
    const after = evs.slice(i + 1, i + 40);
    const resume = after.find((e) => e.ev === 'native-resume');
    const reset = after.find((e) => e.ev === 'native-timeline-reset');
    const recover = after.find((e) => e.ev === 'native-edge-recover');
    const skipped = after.find((e) => e.ev === 'native-seek-skipped');
    const rec = after.find((e) => e.ev === 'native-recover');
    const reload = after.find((e) => e.ev === 'native-reload');
    handbacks.push({
      t: h.t,
      ct: h.d && h.d.ct,
      buf: h.d && h.d.buf,
      resumeAfter: resume ? resume.t - h.t : null,
      behind: resume && resume.d ? resume.d.behind : null,
      rs: resume && resume.d ? resume.d.rs : null,
      reloaded: !!reset || !!reload,
      recovered: rec ? { nudged: rec.d && rec.d.nudged, rs: rec.d && rec.d.rs, after: rec.t - h.t } : null,
      skipped: !!skipped,
      seeked: recover ? +(recover.d && recover.d.to) : null,
      // The recovery DECISION's inputs, logged on the hand-off row itself: a
      // verdict that says `recovery NEVER RAN` must be able to say whether the
      // wall clock was even stamped, or the next reader re-reads the source.
      // `null` and "absent" are different facts: a ring written before 0.8.96
      // has no field at all, and claiming the wall clock "was never stamped"
      // from an absent field is an invented finding.
      podAgeMs: h.d && Object.prototype.hasOwnProperty.call(h.d, 'podAgeMs') ? h.d.podAgeMs : undefined,
      holdCt: h.d && h.d.holdCt,
      clock: recover && recover.d ? recover.d.clock || null : null,
    });
  }

  // ---- freezes: a native parked at readyState<3 after a hand-back
  const freezes = [];
  let open = null;
  for (const e of evs) {
    const d = e.d || {};
    if (e.ev === 'native-resume' || e.ev === 'native-catchup') {
      const rs = d.rs ?? (d.st && d.st.nat && d.st.nat.rs);
      if (typeof rs === 'number' && rs < 3) {
        if (!open) open = { from: e.t, to: e.t, hits: 0, rs };
        open.to = e.t;
        open.hits += 1;
        open.rs = rs;
      }
    } else if (e.ev === 'native-handoff' || e.ev === 'overlay-stall-stop') {
      if (open) freezes.push(open), (open = null);
    } else if (open && (e.ev === 'content-play' || (d.video && d.video.paused === false && (d.video.rs ?? 0) >= 3))) {
      open.to = e.t;
      freezes.push(open);
      open = null;
    }
  }
  if (open) freezes.push(open);
  const frozenMs = freezes.reduce((a, f) => a + Math.max(0, f.to - f.from), 0);
  const parkHits = freezes.reduce((a, f) => a + f.hits, 0);
  if (freezes.length) findings.push(`player parked at readyState<3 ${parkHits}x (${fmt(frozenMs)} total)`);

  // ---- jumps: forward seeks the owner sees as a skip
  const jumps = [];
  for (const e of evs) {
    const d = e.d || {};
    if (e.ev === 'overlay-nudge' && typeof d.to === 'number' && typeof d.pos === 'number' && d.to - d.pos > 1.5)
      jumps.push({ t: e.t, delta: +(d.to - d.pos).toFixed(1), what: 'clean picture nudge' });
    if (e.ev === 'native-nudge' && typeof d.from === 'number' && typeof d.to === 'number' && d.from - d.to > 1.5)
      jumps.push({ t: e.t, delta: -(d.from - d.to).toFixed(1), what: 'native runway nudge (rewind inside held media)' });
    if (e.ev === 'native-catchup' && typeof d.from === 'number' && typeof d.to === 'number' && d.to - d.from > 3)
      jumps.push({ t: e.t, delta: +(d.to - d.from).toFixed(1), what: 'native catch-up' });
    if (e.ev === 'native-edge-recover' && typeof d.behind === 'number' && d.behind > 3)
      jumps.push({ t: e.t, delta: +d.behind.toFixed(1), what: 'native edge recover' });
  }

  // ---- sound: whose decision was each change
  const sound = [];
  const mutable = [];
  for (const e of evs) {
    const d = e.d || {};
    if (e.ev === 'audio-intent') {
      const a = authorOf(d);
      const before = d.before ? `${d.before.muted ? 'muted' : 'on'} ${Number(d.before.volume).toFixed(2)}` : '?';
      const after = d.after ? `${d.after.muted ? 'muted' : 'on'} ${Number(d.after.volume).toFixed(2)}` : '?';
      sound.push({ t: e.t, text: `${String(d.surface).padEnd(6)} ${before} -> ${after}`, a });
      if (String(d.surface) === 'twitch' || String(d.surface) === 'page') mutable.push({ t: e.t, d, a, after });
    } else if (e.ev === 'audio-refused') {
      const a = { who: 'CODE (refused)', cls: 'code', note: d.why || '' };
      sound.push({
        t: e.t,
        text: `${String(d.owner).padEnd(6)} refused ${d.why || ''} el=${d.el ? `${d.el.muted ? 'muted' : 'on'} ${Number(d.el.volume).toFixed(2)}` : '?'}`,
        a,
      });
    } else if (e.ev === 'audio-inherit') {
      sound.push({
        t: e.t,
        text: `${d.from} -> ${d.to} inherit ${d.was ? `${d.was.muted ? 'muted' : 'on'} ${Number(d.was.volume).toFixed(2)}` : '?'} => ${d.now ? `${d.now.muted ? 'muted' : 'on'} ${Number(d.now.volume).toFixed(2)}` : '?'}`,
        a: { who: 'CODE', cls: 'code', note: 'swap inherit' },
      });
    } else if (e.ev === 'audio-agreed') {
      // The number he actually asked for: how long the swap was silent, from
      // our command to the first report that matched it.
      sound.push({
        t: e.t,
        ms: d.ms,
        text: `swap audio agreed after ${d.ms} ms (${d.wantMuted ? 'muted' : 'on'} ${d.wantVol}, sends=${d.sends})`,
        a: { who: 'CODE', cls: 'code', note: 'swap audio' },
      });
    } else if (e.ev === 'audio-stale-report') {
      sound.push({
        t: e.t,
        text: `stale report ${d.sentAgeMs} ms after our write: frame said ${d.frameMuted ? 'muted' : 'on'}, want ${d.wantMuted ? 'muted' : 'on'} (report lag, not a mute)`,
        a: { who: 'CODE', cls: 'code', note: 'report lag' },
      });
    } else if (e.ev === 'audio-mismatch') {
      const own = d.sentAgeMs == null ? 'NO WRITE FROM US' : `our last write ${d.sentAgeMs} ms ago (#${d.sends})`;
      sound.push({
        t: e.t,
        text: `${d.phase} frame=${d.frameMuted ? 'muted' : 'on'} ${d.frameVol} want=${d.wantMuted ? 'muted' : 'on'} ${d.wantVol} (${own})`,
        a: { who: d.sentAgeMs == null ? 'MACHINE/UNKNOWN' : 'OUR WRITE ECHOED', cls: d.sentAgeMs == null ? 'gap' : 'code', note: '' },
      });
    }
  }
  const mutedByCode = mutable.filter((m) => m.after && m.after.muted && m.a.cls === 'code');
  const mutedByUser = mutable.filter((m) => m.after && m.after.muted && m.a.cls === 'user');
  const unattributed = sound.filter((s) => s.a.cls === 'gap');
  if (mutedByCode.length) findings.push(`page sound muted by CODE ${mutedByCode.length}x`);
  if (unattributed.length) findings.push(`${unattributed.length} sound line(s) with no author`);

  // ---- collapses: "no useless dump" is an order, not a preference -----------
  // A ramp is one event to the eye and twenty to the log. Group consecutive
  // volume-only writes on the SAME surface that arrive faster than a hand can
  // type and that never leave the same direction; that shape is a player
  // fading its own volume, not a decision.
  const collapsed = [];
  for (let i = 0; i < sound.length; i += 1) {
    const cur = sound[i];
    if (!/->/.test(cur.text)) {
      collapsed.push(cur);
      continue;
    }
    let j = i;
    while (j + 1 < sound.length && /->/.test(sound[j + 1].text) && sound[j + 1].t - sound[j].t <= 250
      && sound[j + 1].text.slice(0, 6) === cur.text.slice(0, 6)) {
      j += 1;
    }
    if (j - i >= 2) {
      const first = cur.text;
      const lastText = sound[j].text;
      collapsed.push({
        t: cur.t,
        text: `${first.split('->')[0].trim()} -> ${lastText.split('->')[1].trim()} RAMP ${j - i + 1} writes in ${fmt(sound[j].t - cur.t)}`,
        a: cur.a,
      });
      i = j;
    } else {
      collapsed.push(cur);
    }
  }
  let refusals = [];
  const keep = [];
  for (const s2 of collapsed) {
    if (s2.a.who.startsWith('CODE (refused)')) {
      refusals.push(s2);
      continue;
    }
    if (refusals.length) {
      const f = refusals[0];
      keep.push({ t: f.t, text: `${f.text.split(' refused')[0].trim()} refused: ${refusals.length}x ${f.a.note}`, a: f.a });
      refusals = [];
    }
    keep.push(s2);
  }
  if (refusals.length) {
    const f = refusals[0];
    keep.push({ t: f.t, text: `${f.text.split(' refused')[0].trim()} refused: ${refusals.length}x ${f.a.note}`, a: f.a });
  }
  const shown = keep.length > 14 ? keep.slice(0, 7).concat([{ t: null, text: `... ${keep.length - 14} more sound events`, a: { who: '', note: '', cls: 'gap' } }], keep.slice(-7)) : keep;

  // ---- print
  lines.push('');
  lines.push(
    `EPISODE ${idx + 1}  ver=${ep.ver || '?'}  slug=${ep.slug || '?'}  span=${fmt(span)}  events=${evs.length}`,
  );
  if (screenSwaps.length) {
    lines.push('  ON SCREEN');
    for (const s of screenSwaps) lines.push(`    ${fmt(s.t - ep.start).padStart(7)}  ${s.kind.padEnd(16)} ${s.why}${s.extra.length ? '  ' + s.extra.join(' ') : ''}`);
  }
  // ---- pod freeze: did the page play the ad BEHIND our picture -------------
  // Owner report 2026-11-22, verbatim: "ele dessincroniza a live (nao deixa em
  // tempo real)". `hideNativeVideos()` only sets `visibility:hidden`, so a
  // native element that resumed itself under a REVEALED pod played the break in
  // the background, ate the hand-back buffer and parked the picture at rs<3.
  // This is the question the ring could not answer before: between a reveal and
  // the hand-back, did the page's own element report itself PLAYING?
  const podFreeze = { freezes: 0, reasserts: 0, playedUnder: [] };
  {
    let ownedAt = null;
    for (const e of evs) {
      const d = e.d || {};
      if (e.ev === 'overlay-reveal') ownedAt = e.t;
      else if (e.ev === 'native-handoff' || e.ev === 'ad-pod-max' || e.ev === 'overlay-stall-stop') ownedAt = null;
      if (e.ev === 'native-pod-freeze') podFreeze.freezes += 1;
      if (e.ev === 'ad-ui-hold' && d.act === 'reassert') podFreeze.reasserts += 1;
      if (e.ev === 'ad-tick' && ownedAt != null && d.video && d.video.paused === false) {
        podFreeze.playedUnder.push({ t: e.t, age: e.t - ownedAt });
      }
    }
  }
  if (podFreeze.freezes || podFreeze.reasserts || podFreeze.playedUnder.length) {
    lines.push('  POD FREEZE (did the page play the ad behind our picture)');
    const first = podFreeze.playedUnder[0];
    lines.push(
      `    native-pod-freeze=${podFreeze.freezes}  reasserts=${podFreeze.reasserts}` +
        `  ad-tick playing while owned=${podFreeze.playedUnder.length}` +
        (first ? `  first ${fmt(first.age)} after the reveal` : ''),
    );
    if (podFreeze.playedUnder.length) {
      findings.push(
        `the page element played ${podFreeze.playedUnder.length}x under a revealed pod` +
          (podFreeze.freezes ? '' : ' (build < 0.8.112 does not freeze it)'),
      );
    }
  }
  // ---- hold expiry: did anything resume the picture -------------------------
  // Owner report 2026-11-24, verbatim: "acabei de tomar anuncio e travou a live"
  // and "as vezes a live para e a pagina recarrega sozinha". The hold's budget
  // ran out with no clean source, `ad-ui-hold {why:"hold-expired"}` fired, and
  // NOTHING resumed the element: 71 s at one `ct` until the page reloaded. A
  // hold that expires must name its release, or the ring cannot tell "the
  // extension chose to leave it" from "the extension forgot it".
  const holdExpiry = [];
  for (let i = 0; i < evs.length; i += 1) {
    const d = evs[i].d || {};
    if (evs[i].ev !== 'ad-ui-hold' || d.why !== 'hold-expired' || d.act === 'release') continue;
    let released = null;
    let cured = null;
    for (let j = i + 1; j < evs.length; j += 1) {
      const e2 = evs[j];
      const d2 = e2.d || {};
      if (e2.ev === 'ad-ui-hold' && (d2.act === 'release' || d2.why === 'hold-failed')) released = e2.t;
      if (released != null && e2.ev === 'native-resume') { cured = 'native-resume'; break; }
      if (released != null && e2.ev === 'native-stall-resume') { cured = 'native-stall-resume'; break; }
      if (e2.ev === 'pagehide' || e2.ev === 'boot') break;
    }
    holdExpiry.push({ t: evs[i].t, heldMs: d.heldMs, released, cured });
  }
  if (holdExpiry.length) {
    lines.push('  HOLD EXPIRY (the hold ran out: did the picture come back)');
    for (const h of holdExpiry) {
      lines.push(
        `    ${fmt(h.t - ep.start).padStart(7)}  held=${h.heldMs == null ? '?' : fmt(h.heldMs)}` +
          `  release=${h.released == null ? 'NEVER' : fmt(h.released - h.t)}  cured=${h.cured || 'NONE'}`,
      );
      if (h.released == null) {
        findings.push(
          `a hold expired and NOTHING resumed the picture (${fmt(h.heldMs)} held; build < 0.8.113 leaves it frozen)`,
        );
      }
    }
  }
  // ---- the four 0.8.115 owed checks, each a transition it can be read from --
  // Owner reports 2026-11-24 that produced these rows: a banner squeeze that
  // changed the picture size, a pause during a pod that came back playing, an
  // unpause that was re-paused, and a rewind that minted live. The rows exist
  // to be READ here, not grepped out of a dump.
  const layouts = evs.filter((e) => e.ev === 'ad-layout').map((e) => ({ t: e.t, d: e.d || {} }));
  if (layouts.length) {
    lines.push('  LAYOUT (a squeeze: was the picture changed, and did it come back)');
    let restored = 0;
    let released = 0;
    for (const l of layouts) {
      const d = l.d;
      const size = d.banner ? `${d.banner.w}x${d.banner.h}` : '-';
      lines.push(
        `    ${fmt(l.t - ep.start).padStart(7)}  ${String(d.act || '?').padEnd(8)}  banner=${size}` +
          (d.skipped ? `  skipped=${d.skipped}${d.missing ? `(${d.missing.join(',')})` : ''}` : '') +
          (d.stale ? `  stale=${d.stale}` : ''),
      );
      if (d.act === 'restore') restored += 1;
      if (d.act === 'release') released += 1;
    }
    if (restored > released) {
      findings.push(`a squeeze layout was saved ${restored}x and released ${released}x (the picture may stay shrunk)`);
    }
  }
  const userPauses = evs.filter((e) => e.ev === 'ad-ui-hold' && (e.d || {}).act === 'user-pause');
  const userResumes = evs.filter((e) => e.ev === 'ad-ui-hold' && (e.d || {}).act === 'user-resume');
  if (userPauses.length || userResumes.length) {
    lines.push('  HIS GESTURES DURING A POD (who won)');
    for (const g of [...userPauses, ...userResumes].sort((a, b) => a.t - b.t)) {
      const d = g.d || {};
      lines.push(`    ${fmt(g.t - ep.start).padStart(7)}  ${String(d.act).padEnd(11)}  pod=${d.pod || 'hold'}  ct=${d.ct ?? '?'}`);
    }
    // A pause he made must not be undone by a resume OUR side issued before his
    // next play. A `user-resume` is his own play, so it is not one of those.
    for (const g of userPauses) {
      const after = evs.find((e) => e.t > g.t && e.ev === 'native-resume');
      const play = userResumes.find((r) => r.t > g.t);
      if (after && (!play || after.t < play.t)) {
        findings.push(`his pause during a pod was overridden by a native-resume ${fmt(after.t - g.t)} later`);
      }
    }
  }
  const rescues = evs.filter((e) => e.ev === 'dvr-ended-rescue').map((e) => ({ t: e.t, d: e.d || {} }));
  if (rescues.length) {
    lines.push('  DVR RESCUE (a replay error: reload the offset, or mint live)');
    for (const r of rescues) {
      lines.push(
        `    ${fmt(r.t - ep.start).padStart(7)}  dur=${r.d.dur ?? '?'}  want=${r.d.want ?? '?'}  target=${r.d.target ?? '?'}` +
          `  wentLive=${r.d.wentLive === true ? 'YES' : 'no'}`,
      );
      if (r.d.wentLive === true) findings.push('a replay error minted a live url (his "voltou pro ao vivo")');
    }
  }
  // ---- whose reload was it --------------------------------------------------
  // `pagehide` + `boot` with the SAME version on both sides is indistinguishable
  // between the version heal, his F5 and Twitch's own player recovery. 0.8.113
  // stamps `boot-nav {nav, heal}`; before that the ring answers CANNOT-MEASURE.
  {
    const navs = evs.filter((e) => e.ev === 'boot-nav').map((e) => e.d || {});
    const hides = evs.filter((e) => e.ev === 'pagehide').length;
    if (hides || navs.length) {
      lines.push('  RELOADS (who navigated this page)');
      lines.push(`    pagehide=${hides}  boot-nav=${navs.length}`);
      for (const n of navs) lines.push(`    nav=${n.nav || '?'}  heal=${n.heal || '-'}`);
      if (hides && !navs.length) lines.push('    author=NOT-MEASURABLE (build < 0.8.113 does not stamp boot-nav)');
    }
  }
  if (adWindows.length) {
    lines.push('  AD WINDOW (how long it played before it was stopped)');
    for (const w of adWindows) {
      const defended = w.hold ? w.hold.t - w.at : null;
      const workerLate = w.worker ? w.worker - w.at : null;
      lines.push(
        `    ${fmt(w.at - ep.start).padStart(7)}  played=${defended == null ? 'NOT STOPPED' : fmt(defended)}` +
          `  by=${w.hold ? w.hold.act : '-'}  worker=${workerLate == null ? '-' : fmt(workerLate)}` +
          `  held=${w.release ? fmt(w.release.t - (w.hold ? w.hold.t : w.at)) : '?'}  end=${w.release ? w.release.act : 'no-uioff'}` +
          `  reasserts=${w.release ? w.release.reasserts : '-'}`,
      );
    }
  }
  if (handbacks.length) {
    lines.push('  HAND-BACK (the pod ended: how the native came back)');
    for (const h of handbacks) {
      const bits = [
        `ct=${h.ct ?? '?'}`,
        `buf=${h.buf ?? '?'}`,
        `resume=${h.resumeAfter == null ? 'NEVER' : fmt(h.resumeAfter)}`,
        `rs=${h.rs ?? '?'}`,
        h.behind == null ? 'behind=NOT-MEASURABLE(sentinel edge)' : `behind=${h.behind}s`,
        h.reloaded ? 'native RELOADED to a new timeline' : null,
        h.seeked != null ? `seeked to ${h.seeked}s` : null,
        h.skipped ? 'seek refused: no data in hand' : null,
        h.recovered
          ? `recovery after ${fmt(h.recovered.after)} nudged=${h.recovered.nudged} rs=${h.recovered.rs}`
          : h.podAgeMs === undefined
            ? 'recovery NEVER RAN (build < 0.8.96 does not log the decision inputs)'
            : h.podAgeMs === null
              ? 'recovery NEVER RAN (the wall clock was never stamped at take-over)'
            : `no recovery ran (pod age ${fmt(h.podAgeMs)}, stamped at ct=${h.holdCt}) - deficit under the 1.5s floor or the element reloaded`,
      ].filter(Boolean);
      lines.push(`    ${fmt(h.t - ep.start).padStart(7)}  ${bits.join('  ')}`);
      if (h.rs != null && h.rs < 3) findings.push(`hand-back at ${fmt(h.t - ep.start)} resumed at rs=${h.rs} (parked)`);
    }
  }
  if (freezes.length) {
    lines.push('  FROZEN');
    for (const f of freezes)
      lines.push(`    ${fmt(f.from - ep.start).padStart(7)}  ${fmt(f.to - f.from).padStart(6)}  rs=${f.rs} ${f.hits}x parked`);
  }
  if (jumps.length) {
    lines.push('  JUMPS (what he sees as "pulou")');
    for (const j of jumps) lines.push(`    ${fmt(j.t - ep.start).padStart(7)}  +${j.delta}s  ${j.what}`);
  }
  // ---- the display clock: what the surface on screen was DOING ------------
  // The owner's 2026-11-16 questions - lag behind, "a live ta em x tempo em
  // tempo real mas o display ta y tempo atras", "quando repeticoes acontecem" -
  // had no section here at all before this. The rows are transition-only, so a
  // run of identical samples prints as one line.
  const clocks = evs.filter((e) => e.ev === 'display-clock').map((e) => ({ t: e.t, d: e.d || {} }));
  const repeats = evs.filter((e) => e.ev === 'display-repeat').map((e) => ({ t: e.t, d: e.d || {} }));
  const frozenDisplays = evs.filter((e) => e.ev === 'display-frozen').map((e) => ({ t: e.t, d: e.d || {} }));
  if (clocks.length) {
    lines.push('  DISPLAY (the surface on screen, sampled)');
    for (const c of clocks.slice(-6)) {
      const d = c.d;
      lines.push(
        `    ${fmt(c.t - ep.start).padStart(7)}  ${String(d.srf || '?').padEnd(7)} pos=${d.pos} delta=${d.delta == null ? '?' : d.delta} lat=${d.lat == null ? 'NOT-MEASURABLE' : `${d.lat}s(${d.latSrc})`}  ${d.verdict}`,
      );
    }
  }
  if (repeats.length) {
    lines.push('  REPEATS (the picture went back and showed what he already watched)');
    for (const r of repeats) {
      lines.push(`    ${fmt(r.t - ep.start).padStart(7)}  ${String(r.d.srf || '?').padEnd(7)} -${r.d.back}s  ${r.d.from} -> ${r.d.to}`);
    }
    findings.push(`${repeats.length} repeat(s) on screen (largest -${Math.max(...repeats.map((r) => Number(r.d.back) || 0))}s)`);
  }
  if (frozenDisplays.length) {
    lines.push('  FROZEN DISPLAY (still claimed to play, did not move)');
    for (const f of frozenDisplays) lines.push(`    ${fmt(f.t - ep.start).padStart(7)}  ${String(f.d.srf || '?').padEnd(7)} ${fmt(f.d.ms)} at pos=${f.d.pos}`);
    findings.push(`${frozenDisplays.length} frozen display period(s)`);
  }
  if (shown.length) {
    lines.push('  SOUND');
    for (const s of shown) {
      const at = s.t == null ? '        ' : fmt(s.t - ep.start).padStart(7);
      lines.push(`    ${at}  ${String(s.a.who).padEnd(19)} ${s.text}${s.a.note ? `  [${s.a.note}]` : ''}`);
    }
  }
  // Did anything SEE the ad? This is the exact question his 2026-11-15 report
  // asks ("eu tomei anuncio INTEIRO") and the ring could not answer before: a
  // missing `ad-ui-on` used to be indistinguishable from "there was no ad".
  const hooks = [...seenHooks];
  const defence = {
    adUi: evs.filter((e) => e.ev === 'ad-ui-on').length,
    adHold: evs.filter((e) => e.ev === 'ad-hold').length,
    playlists: evs.filter((e) => e.ev === 'worker-playlist').length,
    hooks: hooks.filter((h) => /^worker-hook$/.test(h.ev)),
    hookFails: hooks.filter((h) => /^worker-hook-fail$/.test(h.ev)),
  };
  lines.push('  AD DEFENCE (did anything see the ad at all)');
  lines.push(
    `    ad-ui-on=${defence.adUi}  ad-hold=${defence.adHold}  worker-playlist=${defence.playlists}  worker-hooked=${defence.hooks.length ? defence.hooks.map((h) => (h.d && h.d.kind) || '?').join('+') : 'NONE'}`,
  );
  if (defence.hookFails.length) {
    lines.push(`    worker-hook-fail: ${defence.hookFails.map((h) => (h.d && h.d.err) || '?').join(' | ').slice(0, 160)}`);
  }
  if (!defence.adUi && !defence.adHold && !defence.playlists) {
    // SCOPED TO THE WINDOW, because the window is what was read: a pod outside
    // it produces this same silence, and claiming it of the whole page load sent
    // one diagnosis chasing a detector that had worked (2026-11-24).
    const scope = WIN_TAG;
    lines.push(`    NOTHING SAW AN AD ${scope}: no DOM signal, no playlist probe, no hold.`);
    findings.push(`no ad signal ${scope} (ad-ui-on=0 ad-hold=0 worker-playlist=0)`);
  }
  if (!defence.hooks.length) {
    // `worker-hook` is written WHEN the constructor is patched, so an empty list
    // has two causes: the player started no worker at all, or the row was
    // evicted before this episode was read (the ring holds 1200 entries and a
    // busy load evicts the first seconds). The line used to assert "never
    // patched", which was wrong on every long ring.
    //
    // THIS READER CAN SEPARATE THEM, from its own data (added 2026-11-27 after a
    // live episode printed the ambiguous line while `worker-playlist=2`): a
    // `worker-playlist` row is posted to `ko-adblock-debug` from INSIDE
    // `workerMain()`, the prelude that is stringified into the patched worker's
    // blob. Nothing else knows that channel, so ONE playlist row is proof the
    // patched worker ran in this episode - the hook was not missing, its row
    // aged out. Reporting "could not be proven" over that evidence is the
    // reader being blind to a fact it holds.
    lines.push(
      defence.playlists > 0
        ? `    worker-hooked=EVICTED: ${defence.playlists} playlist row(s) in this episode, and only the patched worker posts them, so the hook ran here - its \`worker-hook\` row aged out of the ring (the ad defence was live; the kind of worker is what is unknown)`
        : '    worker-hooked=NONE: no patch row and no playlist row in this episode (the player started no worker, or none survived the ring) - a clean playlist could not be proven',
    );
  }
  const ramps = collapsed.filter((c) => /RAMP/.test(c.text));
  if (ramps.length) findings.push(`${ramps.length} volume ramp(s) accepted as intent (${ramps[0].text})`);
  lines.push('  ANSWER');
  const latRows = swaps.filter((s) => /lat=/.test(s.extra.join(' ')));
  const lastLat = latRows.length ? latRows[latRows.length - 1].extra.find((x) => /^lat=/.test(x)) : null;
  const worstAd = adWindows.reduce((w, x) => {
    const ms = x.hold ? x.hold.t - x.at : Infinity;
    return ms > (w == null ? -1 : w) ? ms : w;
  }, null);
  lines.push(`    reveals=${reveals} screenChanges=${screenSwaps.length} frozen=${fmt(frozenMs)} jumps=${jumps.length}`);
  if (clocks.length) {
    const last = clocks[clocks.length - 1].d;
    lines.push(
      `    display: last=${last.verdict} lat=${last.lat == null ? 'NOT-MEASURABLE' : `${last.lat}s(${last.latSrc})`}  repeats=${repeats.length} freezes=${frozenDisplays.length}`,
    );
  }
  lines.push(
    `    realtime: last reveal ${lastLat || 'NO LATENCY LOGGED'}` +
      (adWindows.length ? `  adPlayed=${worstAd === Infinity ? 'NEVER STOPPED' : fmt(worstAd)} (${adWindows.length} window(s))` : ''),
  );
  lines.push(
    `    mute by USER=${mutedByUser.length}  by CODE=${mutedByCode.length}  unattributed=${unattributed.length}`,
  );
  if (layouts.length || userPauses.length || userResumes.length || rescues.length) {
    lines.push(
      `    gestures: pause=${userPauses.length} resume=${userResumes.length}` +
        `  squeeze=${layouts.filter((l) => l.d.act === 'restore').length}` +
        `  dvrRescue=${rescues.length} minted=${rescues.filter((r) => r.d.wentLive === true).length}`,
    );
  }
  const agreedMs = sound.filter((s) => typeof s.ms === 'number').map((s) => s.ms);
  if (agreedMs.length) {
    lines.push(
      `    swap audio: ${agreedMs.length} agreement(s), worst=${agreedMs.reduce((a, b) => Math.max(a, b), 0)} ms  staleReports=${sound.filter((s) => /^stale report/.test(s.text)).length}`,
    );
  }
  return { lines, findings };
}

// The build that ANSWERED is the build the ROWS were written by, never the
// manifest the browser happens to hold now. Printing the manifest beside an
// episode booted by an older script read as "0.8.96 verdict" over 0.8.95 rows
// (measured 2026-11-16), which is the reader-lying class this file exists to
// avoid: a stale tab is exactly the case where the two disagree.
function episodeBuilds(list) {
  const seen = [];
  for (const ep of list) {
    const v = String((ep && ep.ver) || '').trim();
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen.length ? seen.join('+') : '?';
}

// ---- run -------------------------------------------------------------------
let ver = '?';
let log;
if (FILE) {
  const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
  log = Array.isArray(parsed) ? parsed : parsed.log || [];
} else {
  const got = await loadLive();
  ver = got.ver;
  log = got.log;
}
if (!log.length) {
  console.log('empty ko.adlog');
  process.exit(2);
}
const cutoff = log[log.length - 1].t - SPAN_MS;
const beforeWindow = log.length;
log = log.filter((e) => e.t >= cutoff);
// A WINDOW IS NOT A PAGE LOAD. Measured 2026-11-24: a ring whose pod sat 17 min
// in and whose last row was 21 min later lost `ad-ui-on`, `ad-overlay-reveal`
// and the whole hand-back to the default 30 min cutoff, and the verdict then
// printed "NOTHING SAW AN AD in this page load" - the loudest possible wrong
// answer, on the one report it exists to answer. Every section that says
// "nothing" now says it about a named window, with the count it dropped.
const droppedByWindow = beforeWindow - log.length;
const WIN_TAG = droppedByWindow ? 'in this window' : 'in this page load';
const eps = episodesOf(log).slice(-EPISODES);
// WHICH TAB IS RUNNING WHAT. An extension reload re-injects nothing, so a tab
// opened before the update keeps the old code and answers the owner's reports
// with rows from a build that is no longer installed (measured twice: 2026-11-12
// and 2026-11-19). The build a row names is on the row itself, and a reader must
// not have to open `hb` by hand to find it (2026-11-23: the mute the owner
// reported came from a `ver:"0.8.111"` tab while the manifest was 0.8.112).
const builds = new Map();
for (const e of log) {
  const d = e.d || {};
  const v = d.ver || d.version;
  if (!v || v === '?') continue;
  const rec = builds.get(v) || { n: 0, slugs: new Set() };
  rec.n += 1;
  if (d.slug) rec.slugs.add(d.slug);
  builds.set(v, rec);
}
if (droppedByWindow) {
  console.log(
    `WINDOW last ${Math.round(SPAN_MS / 60000)}m: ${droppedByWindow} older row(s) EXCLUDED` +
      ' (widen with --span MILLISECONDS; an absence below is an absence in this window)',
  );
  console.log('');
}
if (builds.size) {
  console.log('BUILDS IN THIS RING (which tab is running what)');
  for (const [v, r] of [...builds.entries()].sort()) {
    const tag = v === ver ? '' : '  <- STALE TAB: reload it (an extension reload does not re-inject)';
    console.log(`  ${v}  rows=${r.n}  slug=${[...r.slugs].slice(0, 4).join(',') || '?'}${tag}`);
  }
  console.log('');
}
let findings = [];
for (let i = 0; i < eps.length; i += 1) {
  const r = reportEpisode(eps[i], i);
  console.log(r.lines.join('\n'));
  findings = findings.concat(r.findings);
}
console.log('');
if (findings.length) {
  console.log(`VERDICT build=${episodeBuilds(eps)} (manifest=${ver}) defects=${findings.length}`);
  for (const f of findings) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`VERDICT build=${episodeBuilds(eps)} (manifest=${ver}) clean`);
process.exit(0);
