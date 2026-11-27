// Audio authority regression suite. Nine fixes, nine RED mutations.
//
// Every check runs the REAL shipped source (ko-audio.js, adblock-bridge.js,
// content.js, twitch-adblock.js) and observes an external boundary: the
// authority's intent, the command posted into a frame, a ko.adlog row, or the
// patch a user gesture hands to the authority. A RED arm restores the exact
// pre-fix line in a COPY of that source and must be caught by the same arm.
// `node kick-overlay/audio-authority-test.cjs`
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { makeWorld, runPod, settle, healthySt } = require('./mute-decision-test.cjs');

const AUDIO = fs.readFileSync(path.join(__dirname, 'ko-audio.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(__dirname, 'adblock-bridge.js'), 'utf8');
const AD = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8');
const CONTENT = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');

const checks = [];
const reds = [];
function check(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function') throw new Error('use checkAsync for async arms');
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
function red(quote) {
  reds.push(quote);
  console.log(`RED ${quote}`);
}
function mutate(src, from, to, label) {
  assert(src.includes(from), `mutation did not apply: ${label}`);
  return src.split(from).join(to);
}
function extract(src, header) {
  const start = src.indexOf(header);
  assert(start >= 0, `no function ${header}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${header}`);
}
class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
}

// ---- the two DOM-adjacent seams ---------------------------------------------
// The bar handlers are lifted out of the shipped content.js and run against a
// stub authority, so the assertion is on the PATCH the gesture actually sent.
function barArm(source, cfg) {
  const a = source.indexOf("  muteBtn.addEventListener('click', () => {");
  const b = source.indexOf("  const volwrap = bar.querySelector('#ko-volwrap');", a);
  const c = source.indexOf('  const setVolFrom = (e) => {');
  const d = source.indexOf("  volwrap.addEventListener('pointerdown'", c);
  assert(a >= 0 && b > a && c >= 0 && d > c, 'the bar handlers were not found');
  const muteBlock = source.slice(a, b);
  const volBlock = source.slice(c, d);
  const calls = [];
  const state = { muted: cfg.muted, volume: cfg.volume };
  const audio = {
    intent: () => ({ ...state }),
    setIntent: (surface, patch, opts) => calls.push({ surface, patch, opts }),
  };
  const captured = {};
  const muteBtn = { addEventListener: (t, f) => { captured.click = f; }, innerHTML: '' };
  const fn = new Function('audio', 'KO', 'window', 'updateKickVolUI', 'muteBtn', 'volFrac',
    `${muteBlock}\n${volBlock}\nreturn setVolFrom;`);
  const setVolFrom = fn(audio, { player: 'kick' }, { KOAudio: audio }, () => {}, muteBtn, () => cfg.frac);
  return { clicks: () => captured.click(), slider: () => setVolFrom({ clientX: 0 }), calls };
}

function frameSampleArm(source, st) {
  const a = source.indexOf("    if (typeof st.volume === 'number' && st.volume >= 0 && !st.muted) {");
  const b = source.indexOf("    if (KO.player === 'youtube') throttledYtProbe();", a);
  assert(a >= 0 && b > a, 'the yt frame-sample block was not found');
  const block = source.slice(a, b);
  const calls = [];
  const logs = [];
  const audio = {
    wanted: () => ({ muted: false, volume: 0.77 }),
    setIntent: (...args) => calls.push(args),
    apply: () => calls.push(['apply']),
  };
  new Function('st', 'window', 'diag', block)(st, { KOAudio: audio }, (ev, d) => logs.push({ ev, d }));
  return { calls, logs };
}

// applyOverlayAudio() is run against the MAIN-world DOM it really reads: the
// data-ko-audio-* attributes. The bridge's half is modelled synchronously, so
// the only command observed is the one THIS function decided to post.
function overlayAudioArm(source, cfg) {
  const fnSrc = extract(source, '  function applyOverlayAudio() {');
  const policySrc = extract(source, '  function audioFramePolicy(on, why) {');
  const sent = [];
  const logs = [];
  const events = [];
  const attrs = {
    'data-ko-audio-m': cfg.authorityMuted ? '1' : '0',
    'data-ko-audio-v': '0.50',
    'data-ko-audio-policy': cfg.policy || '',
  };
  const root = { getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); } };
  const document = {
    documentElement: root,
    dispatchEvent(ev) {
      events.push(ev);
      const d = JSON.parse(String(ev.detail));
      if (d.author && d.frame) attrs['data-ko-audio-policy'] = d.on ? d.author : '';
      return true;
    },
  };
  const overlay = {
    frame: {}, token: 'tok-1', audioRefused: !!cfg.refused,
    audioRefusalFor: cfg.forFrame || null, audioSent: null,
  };
  const audioState = () => ({ muted: attrs['data-ko-audio-m'] === '1', volume: Number(attrs['data-ko-audio-v']), policy: String(attrs['data-ko-audio-policy'] || '') });
  const fn = new Function('overlay', 'document', 'CustomEvent', 'audioState', 'overlaySend', 'adLogState', 'adLog',
    `${policySrc}\n${fnSrc}\nreturn applyOverlayAudio;`)(
    overlay, document, CustomEvent, audioState,
    (m) => sent.push(m), (ev, d) => logs.push({ ev, d }), (ev, d) => logs.push({ ev, d }),
  );
  fn();
  return { sent, logs, events, attrs, overlay };
}

// The ISOLATED-world intent bridge is lifted out of the shipped source. `null`
// used to pass `Number.isFinite(Number(null))` and become a volume-0 intent.
function bridgeIntentArm(source, detail) {
  const anchor = source.indexOf("      'ko-audio-intent',");
  assert(anchor >= 0, 'the intent listener was not found');
  const a = source.indexOf('          const d = JSON.parse(String(ev && ev.detail));', anchor);
  const b = source.indexOf('        } catch {', a);
  assert(a >= 0 && b > a, 'the intent body was not found');
  const calls = [];
  const rows = [];
  const audio = { visible: () => 'twitch', setIntent: (...args) => calls.push(args) };
  new Function('ev', 'audio', 'persist', 'String', 'JSON', 'Number', source.slice(a, b))(
    { detail: JSON.stringify(detail) }, audio, (rec) => rows.push(rec), String, JSON, Number,
  );
  return { calls, rows };
}

// The policy listener in adblock-bridge.js decides who may ask the arbiter to
// silence a surface. Run its real body against stubs: a refusal is a row, not
// silence, and the author/frame are forwarded to setPolicy.
function bridgePolicyArm(source, detail) {
  const anchor = source.indexOf("      'ko-audio-frame-policy',");
  assert(anchor >= 0, 'the frame-policy listener was not found');
  const a = source.indexOf('          const d = JSON.parse(String(ev && ev.detail));', anchor);
  const b = source.indexOf('        } catch {', a);
  assert(a >= 0 && b > a, 'the frame-policy body was not found');
  const calls = [];
  const rows = [];
  const attrs = {};
  const audio = { setPolicy: (...args) => calls.push(args) };
  const root = { setAttribute: (k, v) => { attrs[k] = String(v); } };
  new Function('ev', 'audio', 'root', 'persist', 'String', 'JSON', source.slice(a, b))(
    { detail: JSON.stringify(detail) }, audio, root, (rec) => rows.push(rec), String, JSON,
  );
  return { calls, rows, attrs };
}

async function main() {
  // 1. The bar's mute button no longer invents a level of 1 on unmute.
  check('bar mute keeps the remembered level; unmute does not substitute 1', () => {
    const bar = barArm(CONTENT, { muted: true, volume: 0, frac: 0 });
    bar.clicks();
    assert.strictEqual(bar.calls[0].patch.volume, 0, 'the unmute replaced the stored level');
  });
  {
    const before = "volume: !muted && cur.volume === 0 ? 1 : cur.volume";
    const now = 'volume: cur.volume';
    const mutant = mutate(CONTENT, now, before, 'bar unmute substitution');
    const bar = barArm(mutant, { muted: true, volume: 0, frac: 0 });
    bar.clicks();
    assert.strictEqual(bar.calls[0].patch.volume, 1, 'the mutant did not restore the old substitution');
    red(`unmute with a stored zero substituted 1 instead of the user's level (bar.calls[0].patch.volume=1)`);
  }

  // 2. Sliding the bar to zero is a mute, not the destruction of the level.
  check('sliding the bar to zero keeps the level it silenced', () => {
    const bar = barArm(CONTENT, { muted: false, volume: 0.42, frac: 0 });
    bar.slider();
    assert.strictEqual(bar.calls[0].patch.volume, 0.42, `patch=${JSON.stringify(bar.calls[0].patch)}`);
    assert.strictEqual(bar.calls[0].patch.muted, true, 'the slider did not declare a mute');
  });
  {
    const pre = "if (audio) audio.setIntent(surface, { volume: v, muted: v === 0 }, { origin: 'user:ui:bar-slider' });";
    const now = "if (audio) audio.setIntent(surface, { volume: v === 0 ? keep : v, muted: v === 0 }, { origin: 'user:ui:bar-slider' });";
    const mutant = mutate(CONTENT, now, pre, 'bar zero-slider');
    const bar = barArm(mutant, { muted: false, volume: 0.42, frac: 0 });
    bar.slider();
    assert.strictEqual(bar.calls[0].patch.volume, 0, 'the mutant did not persist volume 0');
    red('sliding to zero persisted volume:0 and threw away the level 0.42');
  }

  // 3. The arbiter remembers the level across one mute/unmute pair.
  check('a mute never destroys its level; one unmute restores it', () => {
    const page = makeWorld();
    const a = page.audio;
    a.setIntent('twitch', { muted: false, volume: 0.42 }, { origin: 'code:test' });
    a.setIntent('twitch', { muted: true, volume: 0 }, { origin: 'code:test' });
    assert.strictEqual(a.intent('twitch').muted, true, 'the mute was not recorded');
    assert.strictEqual(a.intent('twitch').volume, 0.42, 'the mute threw the level away');
    a.setIntent('twitch', { muted: false, volume: 0 }, { origin: 'code:test' });
    assert.strictEqual(a.intent('twitch').muted, false, 'the unmute was not recorded');
    assert.strictEqual(a.intent('twitch').volume, 0.42, 'the unmute did not restore the level in one event');
  });
  {
    const policyFn = extract(AUDIO, '  function setPolicy(surface, on, opts) {');
    const pre = `  function setPolicy(surface, on) {
    const had = policy.has(surface);
    if (on) policy.add(surface);
    else policy.delete(surface);
    if (had !== !!on) apply();
    return KOAudio;
  }`;
    let src = mutate(AUDIO, '    if (!fromNativeReader && vol <= 0.001) vol = levelOf(surfaceOf(surface));', '', 'arbiter level memory')
      .split('    if (patchMuted !== null) it.muted = patchMuted;\n    it.volume = vol;')
      .join('    if (patch && typeof patch.muted === \'boolean\') it.muted = patch.muted;\n    if (patch && isNum(patch.volume)) it.volume = clamp(patch.volume);');
    // The pre-fix setPolicy also had no frame guard; one mutant source serves
    // both the memory arm and the policy arm below.
    src = src.split(policyFn).join(pre)
      .split("      if (policy.has('ad')) setPolicy('ad', false, { origin: 'ad:claim-release', why: 'handback' });").join('');
    const page = makeWorld({ audioSource: src });
    const a = page.audio;
    a.setIntent('twitch', { muted: false, volume: 0.42 }, { origin: 'code:test' });
    a.setIntent('twitch', { muted: true, volume: 0 }, { origin: 'code:test' });
    a.setIntent('twitch', { muted: false, volume: 0 }, { origin: 'code:test' });
    assert.strictEqual(a.intent('twitch').volume, 0, `the mutant kept the level: ${a.intent('twitch').volume}`);
    red('without the arbiter memory the unmute left volume:0 (a silent tab saying audible)');
    // item 5's authority arm reuses this same pre-fix mutant.
    global.__audioPreFix = src;
  }

  // 4. A 1 Hz frame sample is not a gesture and never becomes intent.
  check('a delayed frame volume echo is refused, not written as user intent', () => {
    const arm = frameSampleArm(CONTENT, { volume: 0.32, muted: false });
    assert.strictEqual(arm.calls.filter((c) => c[0] === 'yt').length, 0, 'the frame echo wrote an intent');
    assert(arm.logs.some((l) => l.ev === 'audio-refused' && l.d.why === 'frame-sample-not-a-gesture'), 'the refusal was silent');
  });
  {
    const pre = "        audio.setIntent('yt', { volume: st.volume }, { persist: true, origin: 'user:frame-slider', ev: { ownWrite: false, input: 'in-frame', inputAgeMs: null, userActive: true } });";
    const fixed = "        diag('audio-refused', { why: 'frame-sample-not-a-gesture', surface: 'yt', frame: +st.volume.toFixed(2), intent: +want.volume.toFixed(2) });\n        audio.apply();";
    const mutant = mutate(CONTENT, fixed, pre, 'frame sample intent');
    const arm = frameSampleArm(mutant, { volume: 0.32, muted: false });
    assert(arm.calls.some((c) => c[0] === 'yt' && c[1].volume === 0.32), 'the mutant did not write the echo as intent');
    red('the frame echo overwrote the newer bar decision with volume:0.32, ownWrite:false');
  }

  // 5. A letter in chat is not the player's mute shortcut.
  {
    const page = makeWorld();
    page.pressKey('m', { tagName: 'TEXTAREA', closest: () => null });
    page.machineMutesNative();
    check('a letter typed in chat does not certify a machine mute', () => {
      assert.strictEqual(page.audio.intent('twitch').muted, false, 'the chat keystroke became a mute intent');
      const refused = page.logsOf('audio-refused').slice(-1)[0];
      assert(refused && refused.d.why === 'not-volume-control', `why=${refused && refused.d.why}`);
    });
  }
  {
    const pre = "      if (kind !== 'keydown') return false;";
    const fixed = "      if (kind !== 'keydown' || editableTarget(ev && ev.target)) return false;";
    const mutant = mutate(AUDIO, fixed, pre, 'editable keydown gate');
    const page = makeWorld({ audioSource: mutant });
    page.pressKey('m', { tagName: 'TEXTAREA', closest: () => null });
    page.machineMutesNative();
    assert.strictEqual(page.audio.intent('twitch').muted, true, 'the mutant refused the chat keystroke');
    red('a mute typed as "m" in a TEXTAREA was certified as user:pointer');
  }

  // 6. A wildcard label must name a whole volume/mute word, like its sibling
  //    MUTE_WORD_RE does. Use a DOM-shaped stub: `matches` is what a real
  //    element has and what the substring selector used to hide behind.
  {
    const label = (v) => ({
      tagName: 'BUTTON', parentElement: null,
      getAttribute: (k) => (k === 'aria-label' ? v : null),
      matches: (sel) => /aria-label\*=/.test(sel),
      closest: (sel) => (/aria-label\*=|data-a-target\*=/.test(sel) ? label(v) : null),
    });
    const page = makeWorld();
    page.clickDocumentTarget(label('Absolute'));
    page.machineMutesNative();
    check('a label merely containing "ute" does not certify a mute', () => {
      assert.strictEqual(page.audio.intent('twitch').muted, false, 'Absolute certified the machine mute');
      const refused = page.logsOf('audio-refused').slice(-1)[0];
      assert(refused && refused.d.why === 'not-volume-control', `why=${refused && refused.d.why}`);
    });
    const good = makeWorld();
    good.clickDocumentTarget(label('Mute'));
    good.machineMutesNative();
    check('a real whole-word mute label still certifies the user control', () => {
      assert.strictEqual(good.audio.intent('twitch').muted, true, 'the word gate is too broad');
    });
  }
  {
    const selLine = "    '[aria-label*=\"olume\"]',";
    const mutant = mutate(AUDIO, selLine, `${selLine}\n    '[aria-label*="ute"]',`, 'substring label selector')
      .split('        if (wildcardHitWithoutName(hit)) return false;').join('');
    const label = {
      tagName: 'BUTTON', parentElement: null,
      getAttribute: (k) => (k === 'aria-label' ? 'Absolute' : null),
      matches: (sel) => String(sel).includes('ute') || /aria-label\*=/.test(sel),
      closest: (sel) => (String(sel).includes('ute') || /aria-label\*=/.test(sel) ? label : null),
    };
    const page = makeWorld({ audioSource: mutant });
    page.clickDocumentTarget(label);
    page.machineMutesNative();
    assert.strictEqual(page.audio.intent('twitch').muted, true, 'the mutant did not certify "Absolute"');
    red('the bare "[aria-label*=\\"ute\\"]" selector certified "Absolute" as a mute control');
  }

  // 7. The ad path may not OR a stale frame verdict into the authority's
  //    derived mute. The command sent to the frame comes from the authority.
  check('a frame refusal cannot silence a surface the authority says is audible', () => {
    const arm = overlayAudioArm(AD, { authorityMuted: false, refused: true, policy: '' });
    assert.strictEqual(arm.sent.filter((m) => m.t === 'mute').slice(-1)[0].m, false,
      `mute commands=${JSON.stringify(arm.sent)}`);
    assert(arm.logs.some((l) => l.ev === 'audio-refused' && l.d.why === 'frame-autoplay'), 'the refusal was not named');
  });
  {
    const fixed = '    const muted = !!a.muted; // THE authority, never `|| overlay.audioRefused`';
    const pre = '    const muted = !!(a.muted || overlay.audioRefused);';
    const mutant = mutate(AD, fixed, pre, 'second audio writer');
    const arm = overlayAudioArm(mutant, { authorityMuted: false, refused: true, policy: '' });
    assert.strictEqual(arm.sent.filter((m) => m.t === 'mute').slice(-1)[0].m, true, 'the mutant did not mute the audible surface');
    red('overlay.audioRefused was ORed into the derived mute and commanded mute:true over a newer audible intent');
  }

  // 8. The frame's autoplay gate is asked of the authority, never posted
  //    straight into the frame by the ad path.
  check('a fresh frame is muted by the authority, not by a direct frame command', () => {
    const a = CONTENT; // the two path ends: no direct mute write outside applyOverlayAudio
    const direct = /overlaySend\(\{ t: 'mute', m: true \}\)/g;
    assert.strictEqual((AD.match(direct) || []).length, 0, 'a direct overlay mute command survived');
    const ready = AD.indexOf("        overlay.audioSent = null; // a fresh frame knows nothing we told the old one");
    assert(ready > 0 && AD.slice(ready, ready + 120).includes('applyOverlayAudio()'), 'ready does not apply the authority state');
    assert(a.includes("ytCmd('mute');"), 'content.js still writes to a frame directly');
  });
  {
    const pre = "        overlaySend({ t: 'mute', m: true });";
    const mutant = mutate(AD, "        overlay.audioSent = null; // a fresh frame knows nothing we told the old one\n        applyOverlayAudio();",
      `${pre}\n        overlay.audioSent = { muted: true, volume: audioState().volume };\n        overlaySend({ t: 'load', url: overlay.url });\n        overlaySend({ t: 'play' })\n        applyOverlayAudio();`, 'direct frame mute');
    assert((mutant.match(/overlaySend\(\{ t: 'mute', m: true \}\)/g) || []).length > 0, 'the mutant did not restore the direct write');
    red('the frame was muted by a direct overlaySend, bypassing the registered writer');
  }

  // 9. The yt frame-ready mute goes through the registered command surface.
  check('the yt frame-ready mute goes through ytCmd, not a raw ytSend', () => {
    const a = CONTENT.indexOf("      if (KO.player !== 'youtube') {");
    const b = CONTENT.indexOf('    }\n    return;', a);
    const calls = [];
    new Function('ytCmd', 'ytSend', 'KO', CONTENT.slice(a, b))(
      (...args) => calls.push(['cmd', ...args]), (...args) => calls.push(['send', ...args]), { player: 'kick' },
    );
    assert(calls.some((c) => c[0] === 'cmd' && c[1] === 'mute'), `calls=${JSON.stringify(calls)}`);
    assert(!calls.some((c) => c[0] === 'send' && c[1] && c[1].t === 'mute'), 'a raw mute post survived');
  });
  {
    const mutant = mutate(CONTENT, "        ytCmd('mute'); // every mute goes through the registered writer's command surface",
      "        ytSend({ t: 'mute', m: true });", 'direct yt mute');
    const a = mutant.indexOf("      if (KO.player !== 'youtube') {");
    const b = mutant.indexOf('    }\n    return;', a);
    const calls = [];
    new Function('ytCmd', 'ytSend', 'KO', mutant.slice(a, b))(
      (...args) => calls.push(['cmd', ...args]), (...args) => calls.push(['send', ...args]), { player: 'kick' },
    );
    assert(calls.some((c) => c[0] === 'send' && c[1] && c[1].t === 'mute'), 'the mutant did not post a raw mute');
    red('ytSend({t:\'mute\',m:true}) bypassed the registered yt command surface');
  }
  check('a JSON intent with volume:null is refused, not written as volume 0', () => {
    const arm = bridgeIntentArm(BRIDGE, { muted: true, volume: null });
    assert(arm.calls.every((c) => c[1].volume !== 0), `patch=${JSON.stringify(arm.calls)}`);
    assert(arm.rows.some((r) => r.ev === 'audio-refused' && r.d.why === 'invalid-intent-volume'), 'the refusal was silent');
  });
  {
    const fixed = "const vol = d && typeof d.volume === 'number' && Number.isFinite(d.volume) ? d.volume : undefined;";
    const pre = 'const vol = Number.isFinite(Number(d.volume)) ? Number(d.volume) : undefined;';
    const mutant = mutate(BRIDGE, fixed, pre, 'null volume coercion');
    const arm = bridgeIntentArm(mutant, { muted: true, volume: null });
    assert(arm.calls.some((c) => c[1].volume === 0), 'the mutant did not coerce null to zero');
    red('Number(null) became a real volume:0 intent with no refusal row');
  }

  // 11. A machine policy is a frame-scoped ASK to the arbiter, refused by
  //     name when unlabelled or from a dead frame, and dropped on hand-back.
  check('an unlabelled frame-policy ask is refused; an authored one reaches the arbiter', () => {
    const bad = bridgePolicyArm(BRIDGE, { on: true, author: '', frame: 'f1' });
    assert(bad.rows.some((r) => r.ev === 'audio-refused' && r.d.why === 'unlabelled-frame-policy'),
      'an unlabelled ask was accepted silently');
    assert.strictEqual(bad.calls.length, 0, 'an unlabelled ask reached setPolicy');
    const good = bridgePolicyArm(BRIDGE, { on: true, author: 'ad:autoplay', why: 'frame-autoplay', frame: 'f1' });
    assert(good.calls.some((c) => c[0] === 'ad' && c[1] === true && c[2].origin === 'ad:autoplay' && c[2].frame === 'f1'),
      `setPolicy calls=${JSON.stringify(good.calls)}`);
    assert.strictEqual(good.attrs['data-ko-audio-policy'], 'ad:autoplay', 'the policy was not published to the frame');
  });
  check('a policy belongs to the frame it tested and dies with the claim', () => {
    const page = makeWorld();
    const fire = (d) => page.document.dispatchEvent(new CustomEvent('ko-audio-frame-policy', { detail: JSON.stringify(d) }));
    fire({ on: true, author: 'ad:autoplay', frame: 'f1' });
    assert(page.logsOf('audio-policy').some((l) => l.d.origin === 'ad:autoplay' && l.d.frame === 'f1'), 'the authored policy was not recorded');
    fire({ on: true, author: 'ad:autoplay', frame: 'f2' });
    assert(page.logsOf('audio-refused').some((l) => l.d.why === 'stale-frame-policy'), 'a policy from another frame was accepted');
    page.audio.setVisible('ad');
    assert.strictEqual(page.audio.wanted('ad').muted, true, 'the accepted policy did not silence its frame');
    page.audio.claim('ad');
    page.audio.claim(null);
    assert.strictEqual(page.audio.wanted('ad').muted, false, 'the refusal outlived the claim that owned its frame');
  });
  {
    const page = makeWorld({ audioSource: global.__audioPreFix });
    const fire = (d) => page.document.dispatchEvent(new CustomEvent('ko-audio-frame-policy', { detail: JSON.stringify(d) }));
    fire({ on: true, author: 'ad:autoplay', frame: 'f1' });
    fire({ on: true, author: 'ad:autoplay', frame: 'f2' });
    assert.strictEqual(page.logsOf('audio-refused').filter((l) => l.d.why === 'stale-frame-policy').length, 0,
      'the pre-fix authority refused a frame it should have accepted');
    page.audio.setVisible('ad');
    page.audio.claim('ad');
    page.audio.claim(null);
    assert.strictEqual(page.audio.wanted('ad').muted, true, 'the pre-fix policy was cleared by the hand-back');
    red('unlabelled and stale-frame policies were applied, and the refusal survived the hand-back');
  }

  console.log('');
// ANTI-VACUITY: a suite that silently loses an arm reads as a quieter green.
// The floor is the count every arm this file executes today; a deleted arm
// (or one that stops running because an earlier await short-circuits) fails here
// instead of printing PASS with a smaller number.
function antiVacuity(actual, expected) {
  if (actual !== expected) {
    console.error(`\nANTI-VACUITY FAIL suite=audio-authority checks=${actual} expected=${expected}: an arm stopped running`);
    process.exit(1);
  }
  console.log(`ANTI-VACUITY suite=audio-authority checks=${actual} expected=${expected}`);
}
antiVacuity(checks.length, 13);
  console.log(`RESULT PASS audio-authority checks=${checks.length} failed=0`);
  console.log(`REDS ${reds.length}:`);
  for (const r of reds) console.log(`  RED ${r}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`\nRESULT FAIL audio-authority checks=${checks.length} failed=1`);
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
