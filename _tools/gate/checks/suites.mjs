// ---- 3. behavioural suites (real product files, no browser) ----------------
//
// Each entry spawns the shipped suite in `kick-overlay/` and requires its own
// verdict. The suites carry their own negative arms; the gate checks rc and the
// verdict string, never a re-implementation of the contract.
//
// Every run is recorded through `ctx.capture`, so `vacuous-green` can refuse a
// suite that prints PASS while counting nothing.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function runSuite(ctx, check, rel, { maxBuffer, env } = {}) {
  ctx.assert(existsSync(path.join(ctx.ROOT, rel)), `missing ${rel}`);
  const opts = { cwd: path.join(ctx.ROOT, 'kick-overlay'), encoding: 'utf8' };
  if (maxBuffer) opts.maxBuffer = maxBuffer;
  // A suite that declares a single-flight lock QUEUES for the gate: the landing run
  // must land, and it must never run the same heavy compile twice alongside the edit
  // loop (measured 2026-11-27: two concurrent copies of ad-time-continuity were the
  // box's named top pressure - watcher DM dm-f77bd3e66a863677296f).
  if (env) opts.env = { ...process.env, ...env };
  // 300 s is a HANG ceiling, never a performance bound: a suite that runs longer
  // than this has a wedged child, and the gate must refuse instead of waiting.
  const r = spawnSync(process.execPath, [path.join(ctx.ROOT, rel)], { timeout: 300000, killSignal: 'SIGKILL', ...opts });
  ctx.capture(check, rel, r);
  return r;
}

// THE TAIL LOSES THE NAME OF THE FAILING CHECK. Measured 2026-11-27: a gate run
// printed `RESULT FAIL cold-cover-fixture checks=18 failed=1` and the receipt's
// Detail column held exactly that, while the suite had already printed the arm's
// name dozens of lines above it. A red whose check cannot be named sends the next
// reader through the whole suite again, so the FAIL lines are lifted out first and
// the tail is kept for context.
function lastLines(r, n) {
  const text = String(r.stderr || r.stdout || '');
  const fails = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^FAIL\b/.test(l));
  if (!fails.length) return text.trim().slice(-n);
  return `${fails.length} FAIL line(s): ${fails.slice(0, 3).join(' | ').slice(0, n)} | tail: ${text.trim().slice(-Math.min(200, n))}`;
}

export const suiteChecks = [
  {
    // ---- 6b-2. YouTube page -> kick channel routing -----------------------
    // Every YouTube watch page used to invent a kick channel out of its VIDEO id
    // and probe https://kick.com/api/v{1,2}/channels/<guessed> from the youtube.com
    // origin, which the browser blocks: two console errors per video and a channel
    // that cannot exist (owner console dump 2026-11-07, ~20 videos). This runs the
    // shipped resolver and the shipped slug guard from content.js and its negative
    // arm restores the guessing tiers.
    name: 'yt-route',
    run(ctx) {
      const rel = 'kick-overlay/yt-route-test.cjs';
      const r = runSuite(ctx, 'yt-route', rel);
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      return 'no channel invented from a video/UC id; handle + stored mapping still route';
    },
  },
  {
    // ---- 6b. route gate (behavioural, no browser) -------------------------
    // content.js is a position:fixed layer that mirrors a player rect. Both hosts
    // keep a ghost player in the DOM after an SPA navigation, so "which routes own
    // a mirrored player" is a contract that needs a test, not a comment. This runs
    // the real content.js in a stubbed DOM (owner report 2026-10-26:
    // twitch.tv/<channel>/clips left the overlay pinned over the clips grid).
    name: 'route-gate',
    run(ctx) {
      const rel = 'kick-overlay/route-gate-test.cjs';
      const r = runSuite(ctx, 'route-gate', rel);
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      return 'route contract + hide-on-route-change + no mount on non-player routes';
    },
  },
  {
    // ---- 6c. mute decision across a player swap ---------------------------
    // The ad path replaces the native player with a clean hls.js frame. That frame
    // is started muted for autoplay, and the pre-0.8.40 code unmuted it
    // unconditionally at reveal, so a user who had muted got sound back on every
    // ad pod (owner report 2026-10-26). This runs the real twitch-adblock.js
    // against a stubbed DOM through the real ad path and asserts the decision on
    // the wire, at the badge and at ad-end; its negative arm replays the pre-fix
    // gate and requires the detector to catch it.
    name: 'mute-decision',
    run(ctx) {
      const rel = 'kick-overlay/mute-decision-test.cjs';
      const r = runSuite(ctx, 'mute-decision', rel);
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      return 'muted reveal + generic click + badge + ad-end, with the pre-fix negative arm';
    },
  },
  {
    // content-fix-test.cjs — the ONLY suite that runs the real content.js: the `st`
    // message listener, the rect loop's watchdogs, ownership, the visibility
    // boundary, the kick seek/load commands. It was referred to by comments here and
    // NEVER executed by this gate, which is how three freeze defects (0.8.87) sat
    // behind a green receipt. It carries its own anti-vacuity guard: every expected
    // arm label must print, so an arm that silently stops running fails the gate.
    name: 'content-fix',
    run(ctx) {
      const rel = 'kick-overlay/content-fix-test.cjs';
      const r = runSuite(ctx, 'content-fix', rel, { maxBuffer: 8 * 1024 * 1024 });
      const out = String(r.stdout || '') + String(r.stderr || '');
      ctx.assert(r.status === 0, `${rel}: ${out.trim().slice(-400)}`);
      ctx.assert(/ALL CONTENT\.JS FIX CHECKS PASSED/.test(out), `${rel}: suite did not print its verdict`);
      const arms = (out.match(/ARMS (\d+)\/(\d+) present/) || []);
      ctx.assert(arms.length && arms[1] === arms[2], `${rel}: an arm is missing (${arms[0] || 'no ARMS line'})`);
      return `real content.js behaviour; ${arms[0]}`;
    },
  },
  {
    // ---- 6b. bridge handshake (KO-20261026-02) ---------------------------
    // The IVS frame's `ready` used to be addressed to a hardcoded twitch.tv origin,
    // which the browser drops on a youtube.com page (measured: 0 deliveries), so
    // the content script never saw `ready` and the layer stayed a black box. This
    // runs the real player-bridge.js against a parent that enforces targetOrigin
    // like the browser, plus the pre-fix mutation as a negative arm.
    name: 'bridge-handshake',
    run(ctx) {
      const rel = 'kick-overlay/bridge-handshake-test.cjs';
      const r = runSuite(ctx, 'bridge-handshake', rel);
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      return 'ready delivered to a youtube.com parent before learning, exact origin after, with the pre-fix negative arm';
    },
  },
  {
    // ---- 6c. YouTube resume (owner report 2026-10-26) --------------------
    // resumeNativePagePlayer() started any paused <video>, and probe() runs on a
    // 20 s poll plus on every `playing` event, so on a YouTube watch page with
    // player=twitch the extension resumed a video the owner had paused himself.
    // This runs the real content.js against a stubbed YouTube page and asserts the
    // paused video is untouched by a probe; its pre-fix arm removes the ownership
    // guard and requires the detector to catch the resume.
    name: 'youtube-resume',
    run(ctx) {
      const rel = 'kick-overlay/youtube-resume-test.cjs';
      const r = runSuite(ctx, 'youtube-resume', rel);
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      ctx.state.capturedArms['KO-20261026-04'] = { check: 'youtube-resume', rel, r };
      return 'user-paused YouTube stays paused across probe(); a video we paused is still handed back (pre-fix arm goes RED)';
    },
  },
  {
    // ---- 6d. cold-cover fixture (KO-20261023-01) -------------------------
    // A live preroll cannot be manufactured: Twitch served 5 ad-net requests and
    // painted no ad in 150 s on live Caedrel (2026-10-26). This fixture manufactures
    // the INPUT instead — real m3u8 bytes with the stitched-ad markers, served over
    // real HTTP from 127.0.0.1 — then runs the real worker over them and feeds the
    // resulting ad-hold into the real page module. GREEN: cold-cover on the hold
    // tick, native hidden, reveal inside the 12 s bound. RED: the pre-fix mutation
    // (no cold cover) leaves the native ad visible, which the detector must catch.
    name: 'cold-cover-fixture',
    run(ctx) {
      const rel = 'kick-overlay/cold-cover-fixture-test.cjs';
      const r = runSuite(ctx, 'cold-cover-fixture', rel);
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      ctx.state.capturedArms['KO-20261023-01'] = { check: 'cold-cover-fixture', rel, r };
      return 'served ad-only m3u8 -> real worker digest -> ad-hold -> cold-cover on the tick, reveal inside 12 s; pre-fix arm goes RED';
    },
  },
  {
    // ---- 6e. SPA channel switch (owner report 2026-10-27) ----------------
    // Twitch changes channels without reloading the page. The clean-player overlay
    // lives in the same document, and only its invisible STANDBY was guarded
    // against a stale channel; a revealed overlay (a live pod) had no path back, so
    // after a switch the previous channel's stream stayed on screen with the native
    // player hidden ("it keeps the last stream"). This runs the real
    // twitch-adblock.js through the real ad path to a revealed overlay, moves the
    // pathname the way Twitch does, and asserts the previous channel's player is
    // removed, the native is handed back and the next ad cold-starts on the new
    // channel; its negative arm disables the guard and requires the detector to
    // catch the leak (pre-fix arm goes RED).
    name: 'channel-switch',
    run(ctx) {
      const rel = 'kick-overlay/channel-switch-test.cjs';
      const r = runSuite(ctx, 'channel-switch', rel);
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      ctx.state.capturedArms['KO-20261027-01'] = { check: 'channel-switch', rel, r };
      return 'revealed + standby overlays dropped on an SPA channel switch, native handed back, same-channel sub-route keeps it; pre-fix arm goes RED';
    },
  },
  {
    // ---- 6g. ad-path time continuity (owner report 2026-11-07) -----------
    // "when the player is swapped because of an ad the live comes back several
    // seconds; when the ad ends there is a jump in time; unmuting during the swap
    // makes it mute the player; a paused Twitch tab gets unpaused by itself."
    // The clean player was only pulled forward when it was 20s+ behind, the
    // hand-back seeked to the buffered end instead of the clean offset, the mute
    // decision was captured once at take-over, and the resume had no visibility or
    // user-intent guard at all. This runs the real twitch-adblock.js through the
    // real ad path for all four and mutates each one back to its pre-fix shape; the
    // detector must catch every mutation.
    name: 'ad-time-continuity',
    run(ctx) {
      const rel = 'kick-overlay/ad-time-continuity-test.cjs';
      const r = runSuite(ctx, 'ad-time-continuity', rel, { env: { KO_HEAVY_WAIT_MS: '300000' } });
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      return 'reveal at real time + hand-off at the same offset + user mute intent + no resume of a paused/hidden player; four pre-fix arms go RED';
    },
  },
  {
    // ---- 6d. per-tab audio scope (owner report 2026-11-08) ----------------
    // "mutar uma aba e todas mutarem. e vice versa." The intent lived in the shared
    // `ko.v2` record and every tab's storage.onChanged fed it back into that tab's
    // arbiter, so one tab's mute reached all of them. This runs the real ko-audio.js
    // in one world per simulated tab and requires: A's gesture never reaches B, a
    // reload restores only its own choice, a fresh tab starts clean, and the shared
    // record carries no audio — with a positive control and two source mutations
    // proving the fence fires.
    name: 'tab-audio-scope',
    run(ctx) {
      const rel = 'kick-overlay/tab-audio-scope-test.cjs';
      const r = runSuite(ctx, 'tab-audio-scope', rel);
      ctx.assert(r.status === 0, `${rel}: ${lastLines(r, 320)}`);
      return 'one tab gesture stays in that tab; shared record carries no audio; positive control + 2 mutations';
    },
  },
  {
    // ---- 6g. ad DETECTION: the DOM detector and the media worker ---------
    // Owner report 2026-11-15: "eu tomei anuncio INTEIRO". His ring had zero
    // `ad-ui-on`, zero `ad-hold` and zero `worker-playlist` rows for a whole page
    // load while a 15 s pod played, because (a) the DOM detector tested Twitch's
    // permanent `__wrapper-hidden` class token instead of the surface it paints, and
    // never read the countdown/slate text at all, and (b) only `window.Worker` was
    // hooked while the player that feeds `MediaSourceHandle` uses `SharedWorker`.
    // Both arms above, each with the pre-fix mutation required to go RED.
    name: 'ad-detect',
    run(ctx) {
      const rel = 'kick-overlay/ad-detect-test.cjs';
      const r = runSuite(ctx, 'ad-detect', rel);
      const out = String(r.stdout || '') + String(r.stderr || '');
      ctx.assert(r.status === 0, `${rel}: ${out.trim().slice(-400)}`);
      ctx.assert(/ARMS (\d+)\/\1\b/.test(out), `${rel}: arm count not equal-sided:\n${out.trim().slice(-300)}`);
      return 'wrapper measured by paint not class token, countdown/slate text read, SharedWorker hooked; 2 pre-fix arms go RED';
    },
  },
];
