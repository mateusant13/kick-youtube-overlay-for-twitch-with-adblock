// ---- 5. instruments: the census and the live-state probe contract -----------
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const instrumentChecks = [
  {
    // ---- 6b. silent-decision census ---------------------------------------
    // A GUARD THAT RETURNS WITHOUT A ROW IS THE CLASS EVERY SURPRISE CAME FROM.
    // Measured 2026-11-20: `adUiHoldTick()` bailed out on `overlay.standby` with no
    // log line and a 62.6 s ad played; three freeze defects of 0.8.88 sat behind a
    // green suite for the same reason. The ring cannot say a silent guard happened,
    // so the only way to find one was to read the source — which is exactly the
    // surprise the owner asked about. This check does not demand that all 119 exits
    // log; it pins the measured count and refuses GROWTH, so a new silent guard has
    // to be argued for in the budget file instead of sneaking in.
    name: 'silent-census',
    run(ctx) {
      const tool = path.join(ctx.ROOT, '_tools/ko-census.mjs');
      ctx.assert(existsSync(tool), 'missing _tools/ko-census.mjs');
      const r = spawnSync(process.execPath, [tool, '--gate'], { timeout: 120000, killSignal: 'SIGKILL',
        cwd: ctx.ROOT,
        encoding: 'utf8',
      });
      const out = String(r.stdout || '') + String(r.stderr || '');
      ctx.assert(r.status === 0, `census refused:\n${out.trim().slice(-500)}`);
      const m = /RESULT PASS\s+guardShaped=(\d+)\s+unexercisedState=(\d+)/.exec(out);
      ctx.assert(m, `census printed no verdict:\n${out.trim().slice(-400)}`);
      return `guard-shaped silent exits=${m[1]}, ad-path state fields no arm touches=${m[2]}; a planted silent guard makes this check FAIL`;
    },
  },
  {
    // ---- 6b. live state probe --------------------------------------------
    // The ring holds TRANSITIONS, so a state that is stably wrong emits nothing and
    // "is it stuck right now" had no instrument (measured 2026-11-20: a native
    // element sat frozen for 70 s with no row). `ko-snapshot` reads what the page
    // publishes, so THIS check can only prove its CONTRACT: every attribute it
    // reads is still written somewhere, and every verdict it can print still has
    // its branch. The probe is deliberately NOT spawned here: a live reading needs
    // the owner Chrome and belongs to the project-harness job, not this static gate.
    name: 'live-state-probe',
    run(ctx) {
      const tool = path.join(ctx.ROOT, '_tools/ko-snapshot.mjs');
      ctx.assert(existsSync(tool), 'missing _tools/ko-snapshot.mjs');
      const src = ctx.read('_tools/ko-snapshot.mjs');
      // Full attribute names, hyphens included: `[a-z]+` stopped at the first
      // hyphen, so `data-ko-audio-m` counted as `audio` and the check reported 3
      // readers where the probe reads 7. A census that undercounts its own subject
      // is the same defect class it exists to catch.
      const readers = [...src.matchAll(/data-ko-([a-z0-9]+(?:-[a-z0-9]+)*)/g)]
        .map((m) => m[1]);
      const uniq = [...new Set(readers)];
      ctx.assert(uniq.length >= 6, `probe reads only ${uniq.length} published attribute(s): ${uniq.join(', ')}`);

      const producers = ['kick-overlay/content.js', 'kick-overlay/adblock-bridge.js']
        .map((f) => ctx.read(f)).join('\n');
      const orphan = uniq.filter((a) => !producers.includes(`data-ko-${a}`));
      ctx.assert(!orphan.length, `probe reads attribute(s) nothing writes: ${orphan.join(', ')}`);

      for (const cls of ['FROZEN', 'PAUSED', 'REPEAT', 'PLAYING']) {
        ctx.assert(src.includes(cls), `probe lost the ${cls} verdict branch`);
      }
      // A LAYER THAT OWNS THE PICTURE IS THE SURFACE. The probe once read the
      // page's own <video> — paused BY DESIGN under `player=kick` — and printed
      // `-> PAUSED` while the kick frame reported Playing at lat 1.65. The branch
      // must still exist in the source; whether it fires needs the owner Chrome.
      ctx.assert(src.includes('SURFACE=FRAME'), 'probe lost the SURFACE=FRAME branch for an owning layer');
      ctx.assert(/no Twitch\/YouTube tab|NOT measurable from the DOM/.test(src), 'probe lost its no-tab / DOM-limits verdict branch');
      return `${uniq.length} published attribute(s) each with a writer, SURFACE=FRAME branch present; probe NOT spawned (static contract only)`;
    },
  },
  {
    // ---- 6c. one heavy job at a time --------------------------------------
    // Measured 2026-11-27 (watcher DM dm-f77bd3e66a863677296f, owner order "é pra
    // sempre verificar o maior culpado do stutter"): `node kick-overlay/
    // ad-time-continuity-test.cjs` was the box's named top pressure while TWO copies
    // ran at once - this gate's suite check and the edit loop's deep tier - on a box
    // at 64 % CPU with `I:` at 419.9 % busy / 50.7 ms latency. One copy costs the
    // same wall as the pair and half the compile work and spindle queue.
    // The suite now takes a single-flight lock (refuse for the loop, queue for this
    // gate) and this check pins the lock's own contract: refuse names the holder in
    // <200 ms, a queued caller waits instead of stealing, a dead holder is stolen
    // from. Proven both ways - the same selftest against a no-op lock prints
    // `RESULT FAIL heavy-lock checks=10 failed=5`.
    name: 'heavy-lock',
    run(ctx) {
      const tool = path.join(ctx.ROOT, '_tools/gate/heavy-lock-selftest.mjs');
      ctx.assert(existsSync(tool), 'missing _tools/gate/heavy-lock-selftest.mjs');
      const r = spawnSync(process.execPath, [tool], { timeout: 60000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
      const out = String(r.stdout || '') + String(r.stderr || '');
      ctx.assert(r.status === 0, `heavy-lock selftest refused:\n${out.trim().slice(-500)}`);
      const m = /RESULT PASS heavy-lock checks=(\d+) failed=0 arms=(\d+)\/4/.exec(out);
      ctx.assert(m, `selftest printed no verdict:\n${out.trim().slice(-400)}`);
      // The suite must still HOLD the lock, or the whole check is decoration.
      const suite = ctx.read('kick-overlay/ad-time-continuity-test.cjs');
      ctx.assert(/singleFlight\('ad-time-continuity'/.test(suite), 'the heavy suite no longer takes its single-flight lock');
      const gate = ctx.read('_tools/gate/checks/suites.mjs');
      ctx.assert(/KO_HEAVY_WAIT_MS: '300000'/.test(gate), 'the gate no longer queues for the heavy suite (it would be refused mid-landing)');
      return `single-flight lock proven (${m[1]} checks, ${m[2]} arms): refuse <200ms naming the holder, queue waits, dead holder stolen; the heavy suite holds it and this gate queues`;
    },
  },
  {
    // A TIMING METRIC GRADED ON A STARVED BOX IS A RED NOBODY CAN FIX.
    //
    // MEASURED 2026-11-27: the acceptance rail graded `subsystem.ad_time_continuity_ms` at
    // 16 923.85 ms vs a 5 963.49 ms baseline (+183.8 %) while all eight E-cores were pinned
    // and no product file had changed. The metric's command is now
    // `_tools/ko-timed-suite.mjs`, which refuses on BUSY/CANNOT-MEASURE with a typed
    // `latency_refused` instead of printing a number. This check runs the wrapper's own
    // arms, and refuses if the wrapper stops being the metric's command - otherwise the
    // arms would be decoration beside an unwired tool.
    name: 'timed-suite',
    run(ctx) {
      const tool = path.join(ctx.ROOT, '_tools/gate/timed-suite-selftest.mjs');
      ctx.assert(existsSync(tool), 'missing _tools/gate/timed-suite-selftest.mjs');
      const r = spawnSync(process.execPath, [tool], { timeout: 120000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
      const out = String(r.stdout || '') + String(r.stderr || '');
      ctx.assert(r.status === 0, `timed-suite selftest refused:\n${out.trim().slice(-500)}`);
      const m = /RESULT PASS timed-suite checks=(\d+) failed=0 arms=4\/4/.exec(out);
      ctx.assert(m, `selftest printed no verdict:\n${out.trim().slice(-400)}`);
      const budgets = ctx.read('benchmarks/budgets.json');
      ctx.assert(/node _tools\/ko-timed-suite\.mjs --label ad_time_continuity/.test(budgets), 'the ad-time-continuity metric no longer runs through the timing wrapper');
      ctx.assert(/"parse_pattern": "RESULT_MS=/.test(budgets), 'the metric no longer parses the wrapper\'s RESULT_MS line');
      return `starvation refusal proven (${m[1]} checks, 4 arms): busy and cannot-measure refuse with the numbers, ready measures, a failing suite propagates its rc, and the mutant arm shows the ceilings are what makes the refusal real`;
    },
  },
  {
    // THE GUEST IS THIS PROJECT'S ONE HEAVY STEP; ITS LAUNCHER MUST ASK THE BOX.
    //
    // MEASURED 2026-11-27: `ko-load-check` printed BUSY, the launcher started the guest
    // anyway, and the watcher billed this pane 18 processes at 11.9 % of the machine
    // (`dm-025e33fc2336dfca59e3`). The refusal now lives in `ko-guest.mjs`; this check runs
    // its arms and refuses if the launcher stops asking (the arms start nothing: every path
    // is a refusal or a dry run, so the check cannot become the heavy step it guards).
    name: 'guest-load-guard',
    run(ctx) {
      const tool = path.join(ctx.ROOT, '_tools/gate/guest-load-guard-selftest.mjs');
      ctx.assert(existsSync(tool), 'missing _tools/gate/guest-load-guard-selftest.mjs');
      const r = spawnSync(process.execPath, [tool], { timeout: 120000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
      const out = String(r.stdout || '') + String(r.stderr || '');
      ctx.assert(r.status === 0, `guest-load-guard selftest refused:\n${out.trim().slice(-500)}`);
      const m = /RESULT PASS guest-load-guard checks=(\d+) failed=0 arms=4\/4/.exec(out);
      ctx.assert(m, `selftest printed no verdict:\n${out.trim().slice(-400)}`);
      const guest = ctx.read('_tools/ko-guest.mjs');
      ctx.assert(/readLoad\(/.test(guest), 'ko-guest.mjs no longer reads the load pre-flight');
      ctx.assert(/process\.exit\(3\)/.test(guest), 'ko-guest.mjs no longer refuses with exit 3');
      return `guest launch guard proven (${m[1]} checks, 4 arms): BUSY refuses with the reading and names KO_ALLOW_BUSY=1, the override proceeds and still reports BUSY, READY launches, a --flag is never the URL`;

    },
  },
  {
    // A READER THAT REPORTS BLINDNESS IT CAN LIFT IS A DEFECT IN THE INSTRUMENT.
    //
    // MEASURED live 2026-11-27: an episode printed `worker-hooked=NONE ... could not be
    // proven` while carrying `worker-playlist=2`; a playlist row is posted from inside
    // `workerMain()`, the prelude stringified into the patched worker's blob, so it is
    // proof the hook ran. The reader now says EVICTED and counts the evidence. This check
    // runs its arms (three fixture rings, ~1 s, no browser) and refuses if the reader
    // goes back to claiming it cannot tell.
    name: 'adlog-verdict',
    run(ctx) {
      const tool = path.join(ctx.ROOT, '_tools/gate/adlog-verdict-selftest.mjs');
      ctx.assert(existsSync(tool), 'missing _tools/gate/adlog-verdict-selftest.mjs');
      const r = spawnSync(process.execPath, [tool], { timeout: 120000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
      const out = String(r.stdout || '') + String(r.stderr || '');
      ctx.assert(r.status === 0, `adlog-verdict selftest refused:\n${out.trim().slice(-500)}`);
      const m = /RESULT PASS adlog-verdict checks=(\d+) failed=0 arms=4\/4/.exec(out);
      ctx.assert(m, `selftest printed no verdict:\n${out.trim().slice(-400)}`);
      const src = ctx.read('_tools/ko-adlog-verdict.mjs');
      ctx.assert(/worker-hooked=EVICTED/.test(src), 'the reader no longer reports EVICTED');
      return `verdict reader proven (${m[1]} checks, 4 arms): playlists without a hook row read EVICTED with the count, a surviving hook is named by kind, a genuinely silent load keeps NONE and still exits 1, EVICTED exits 0`;

    },
  },
];
