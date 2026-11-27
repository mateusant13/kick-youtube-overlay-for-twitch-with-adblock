// ko-audio.js - THE audio authority for this extension.
//
// WHY THIS FILE EXISTS. Mute used to be tracked in nine places at once:
// `KO.muted` (a Set), `muteWrites`, `KO.kickMuted`, `KO.ytMuted`, `KO.kickVol`,
// `KO.ytVol`, and in the ad path `muteIntent`, `muteSent`, `autoplayMuted`,
// `wasMuted`, `wasVolume`, `holdWasMuted`, `holdVolume` and the per-element
// snapshot in `hiddenVideos[]`. Nearly every one of those was a SNAPSHOT of
// "what the value happened to be", and a swap restored the frozen value on top
// of the user's newer decision. Every owner report on this subject for two days
// (2026-11-07 "unmuting during the swap mutes the clean player, or vice versa";
// 2026-11-08 "fica mutando quando eu desmuto o tempo inteiro") is that shape.
//
// THE MODEL (one line, everything derives from it):
//
//     muted(surface) = intent[surface].muted || policy(surface) || surface !== visible
//     volume(surface) = intent[surface].volume
//
//   intent   the USER's choice for that surface. Persisted. Only a real gesture
//            sets it (a volumechange we did not write that arrives right after
//            a real input, the popup, the badge).
//   policy   silence the BROWSER forced (autoplay refused). Never read back as
//            intent, cleared by a gesture.
//   visible  the one surface being listened to. Exactly one, or none.
//
// No snapshot, no restore: a surface that stops being visible is muted by the
// same rule that unmutes the next one, so both ends of every swap are a single
// expression. A user gesture on a hidden surface is transferred to the visible
// one, which is what the owner means by "I am talking about the sound I hear".
//
// Writers are registered, never inline: a native surface iterates the elements
// it owns, a command surface receives one state object. Nothing outside this
// file writes `.muted`, `.volume` or sends a mute command.
//
// The derived state is also ENFORCED, not only applied on change: an element
// that appears after the last apply (Twitch builds ad/preview/PBP videos while
// the overlay owns the picture) starts audible and no caller will ever report
// it. `enforceSilence()` re-closes such an element on a 400 ms tick and on the
// media events that mark one becoming audible. It only writes `muted = true`,
// so it can neither invent a user mute nor un-mute what the page silenced.

(function () {
  'use strict';
  // Injected once per matching content_scripts entry (twitch lists three), so
  // the FIRST instance is the authority: a second one would rebuild the intent
  // store from defaults and silently discard the user's choice.
  if (window.KOAudio) return;

  const TTL = 700;            // a write this young is OURS, not the user's
  const VOL_EPS = 0.02;       // volume granularity below which nothing changes

  // Every surface starts AUDIBLE. A default `muted: true` is a decision the
  // user never made, and it becomes the state of whatever player a swap brings
  // in (owner report 2026-11-09: "acabou de trocar o player e MUTAR a live do
  // player novo sozinho"). "Only one surface is heard" is the job of
  // `visibleNow() !== surface` below, not of a mute default.
  const intents = {
    twitch: { muted: false, volume: 1 },
    kick: { muted: false, volume: 1 },
    yt: { muted: false, volume: 1 },
  };
  // A MUTE REMEMBERS THE LEVEL IT SILENCED. `intents[surface].volume` is the
  // audible level, never the momentary `0` a mute button writes. The level is
  // kept separately so an unmute restores it in ONE event (and survives a
  // reload of this tab), instead of depending on the page sending a second
  // volumechange with the old level.
  const levels = Object.create(null);
  // Every audio decision is reported, so the log answers the owner's questions
  // instead of the code being asked again: which surface was audible, WHAT
  // changed its state, and whether a swap carried the mute. content.js forwards
  // `ko-audio-log` into `ko.adlog` (owner order 2026-11-12: "era pros logs te
  // falar TUDO que eu ja te falei antes. FAÇA OS LOGS OUTPUTAREM O QUE DEVEM").
  function report(ev, d) {
    try {
      document.dispatchEvent(new CustomEvent('ko-audio-log', { detail: JSON.stringify({ ev, d: d || {} }) }));
    } catch {
      /* a log line must never break audio */
    }
  }

  const writers = Object.create(null);   // surface -> { kind, ... }
  const shares = Object.create(null);    // surface -> the surface whose intent it uses
  const policy = new Set();              // surfaces silenced by browser policy
  const sent = Object.create(null);      // surface -> last state COMMANDED (echo guard)
  const writes = new WeakMap();          // Element -> { at, muted, volume }
  const policyFrames = new Map();         // surface -> the frame a policy was tested on
  const listeners = new Set();           // intent change subscribers
  let lastApplyStamp = '';               // last reported derived state
  let requested = null;                  // the surface the page's own layers show
  let claimed = null;                    // a surface that COVERS the page (the ad
  let releasedAt = 0;                // when the claim was released (the machine's mute window)
                                         // path's clean player); wins while set
  const visibleNow = () => claimed || requested;
  let listening = false;
  // TAB SCOPE. The intent is the user's choice FOR THIS TAB: two Twitch tabs are
  // two independent sound decisions (owner report 2026-11-08: "mutar uma aba e
  // todas mutarem. e vice versa"). It used to live in the shared `ko.v2` record,
  // so every tab applied every other tab's mute through storage.onChanged; here
  // it is persisted per tab (sessionStorage survives a reload, never crosses a
  // tab) and the shared record carries no audio at all.
  // v2: 0.8.57 and earlier could record a MACHINE mute as the user's intent
  // (owner report 2026-11-11: he clicks to recover the delay, Twitch mutes its
  // own element, the click made that event fresh). Every stored row from that
  // era is untrustworthy, so the key is bumped and the tab starts at the
  // defaults — sound on — instead of inheriting a mute nobody chose.
  const TAB_KEY = 'ko.audio.v2';
  const tabStore = () => {
    try {
      return window.sessionStorage || null;
    } catch {
      return null; // storage denied (sandboxed frame): in-memory for this tab
    }
  };
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const clamp = (v) => Math.max(0, Math.min(1, Number(v)));
  const levelOf = (key) => (isNum(levels[key]) && levels[key] > 0.001 ? clamp(levels[key]) : 1);

  // Restore this tab's own choices. Runs once, before the object is exported.
  function restoreTab() {
    const store = tabStore();
    if (!store) return;
    let rec = null;
    try {
      rec = JSON.parse(store.getItem(TAB_KEY) || 'null');
    } catch {
      rec = null;
    }
    if (!rec || typeof rec !== 'object') return;
    for (const key of Object.keys(rec)) {
      const v = rec[key];
      if (!v || typeof v !== 'object') continue;
      const it = intents[key] || (intents[key] = { muted: false, volume: 1 });
      if (typeof v.m === 'boolean') it.muted = v.m;
      if (isNum(v.v)) it.volume = clamp(v.v);
      if (isNum(v.v) && v.v > 0.001) levels[key] = clamp(v.v);
      if (isNum(v.l) && v.l > 0.001) levels[key] = clamp(v.l);
    }
  }

  function persistTab() {
    const store = tabStore();
    if (!store) return;
    const rec = {};
    for (const key of Object.keys(intents)) {
      rec[key] = { m: !!intents[key].muted, v: clamp(intents[key].volume), l: levelOf(key) };
    }
    try {
      store.setItem(TAB_KEY, JSON.stringify(rec));
    } catch {
      /* quota/denied: the in-memory intent still holds for this page */
    }
  }

  const surfaceOf = (s) => shares[s] || s;

  function intentOf(surface) {
    const key = surfaceOf(surface);
    const it = intents[key] || (intents[key] = { muted: false, volume: 1 });
    return it;
  }

  // The single desired state for a surface, derived. Never stored.
  function want(surface) {
    const it = intentOf(surface);
    return {
      muted: !!(it.muted || policy.has(surface) || visibleNow() !== surface),
      volume: clamp(it.volume),
    };
  }

  function markWrite(el) {
    try {
      writes.set(el, { at: Date.now(), muted: !!el.muted, volume: Number(el.volume) });
    } catch {
      /* detached */
    }
  }

  // Is this element state the one WE just wrote? Shared by every reader of
  // `volumechange`; a write we made can never be mistaken for a user decision.
  function isOwnWrite(el, muted, volume) {
    const w = el && writes.get(el);
    if (!w || Date.now() - w.at > TTL) return false;
    if (w.muted !== !!muted) return false;
    return isNum(volume) ? Math.abs(w.volume - Number(volume)) <= VOL_EPS : true;
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn(visibleNow());
      } catch {
        /* a subscriber must never break the arbiter */
      }
    }
  }

  function notify() {
    emit();
  }

  // Apply the derived state to every registered surface, writing only diffs.
  function apply() {
    // TRANSITION ONLY: a 400 ms tick that changes nothing logs nothing.
    let stamp = '';
    try {
      stamp = Object.keys(writers)
        .sort()
        .map((n) => {
          const t = want(n);
          return `${n}:${t.muted ? 'm' : '-'}${t.volume.toFixed(2)}`;
        })
        .join(' ');
    } catch {
      stamp = '';
    }
    if (stamp && stamp !== lastApplyStamp) {
      lastApplyStamp = stamp;
      report('audio-apply', { vis: visibleNow(), st: stamp });
    }
    for (const name of Object.keys(writers)) {
      const w = writers[name];
      const target = want(name);
      if (w.kind === 'command') {
        const last = sent[name];
        if (last && last.muted === target.muted && Math.abs(last.volume - target.volume) <= VOL_EPS) continue;
        sent[name] = target;
        try {
          w.write(target);
        } catch {
          /* the frame can be gone mid-swap */
        }
        continue;
      }
      // Element surface: per-element diff, per-element attribution.
      //
      // ONE VOICE PER SURFACE. A Twitch page carries more than one <video>
      // (the main player, an ad clip element, a hidden preview/PBP), and the old
      // loop wrote the SAME unmute to every one of them - the owner hears the
      // stream twice and then three times ("ta duplicando audio e depois
      // triplicando", 2026-11-11; his own ko.adlog has
      // `audio-state {audible:2, playing:2}`). Only the surface's MAIN element
      // may be audible; every other element of that surface is held muted, and
      // keeps the surface's volume so a promoted element is not silent.
      let els;
      try {
        els = w.elements ? w.elements() : [];
      } catch {
        els = [];
      }
      let main = null;
      if (typeof w.main === 'function') {
        try {
          main = w.main();
        } catch {
          main = null;
        }
      }
      for (const el of els) {
        if (!el || !el.isConnected) continue;
        const isMain = !main || el === main;
        const muted = isMain ? target.muted : true;
        try {
          if (!!el.muted !== muted) {
            el.muted = muted;
            markWrite(el);
          }
          if (isNum(el.volume) && Math.abs(Number(el.volume) - target.volume) > VOL_EPS) {
            el.volume = target.volume;
            markWrite(el);
          }
        } catch {
          /* a detached element mid-write */
        }
      }
    }
  }

  // A fresh frame/element replaces the old one: forget what was commanded to it
  // so the next apply() re-asserts instead of trusting a dead surface.
  function forget(surface) {
    delete sent[surface];
  }

  // ---- the silencing guard -------------------------------------------------
  // `apply()` writes only when the arbiter is TOLD something changed, and the
  // page's layers are what tell it. One gap in that model is audible: an element
  // that appears AFTER the last apply. Twitch builds ad/preview/PBP <video>s
  // while the overlay owns the picture, every new element starts `muted:false`
  // by default, and nothing ever asks it to close. Measured in the owner's
  // Chrome (0.8.75, twitch.tv/titiltei, player=kick):
  //
  //   data-ko-owner="kick"
  //   [...document.querySelectorAll('video')] -> [{muted:false, paused:true, videoHeight:0}]
  //
  // The convergence that content.js runs every 400 ms compares each element
  // against `wanted(visibleSurface())`, and for the visible OVERLAY that is the
  // layer's own "sound on", so a page element opened by the page is not drift to
  // it. The authority cannot depend on a caller being right, so it enforces the
  // one direction that is audible: no element of a surface may be OPEN unless
  // the derived state allows it (its main element while that surface is heard).
  //
  // The guard only ever writes `muted = true`. It never un-mutes anything, so
  // the intent rule keeps its shape (a machine mute is never read back as the
  // user's choice) and no state the page set is overwritten in the direction the
  // user would hear. It runs on a tick, because an element that never fires an
  // event still starts open, and on the media events that mark an element about
  // to be audible, so the tick is the backstop rather than the only answer.
  const SILENCE_MS = 400; // = content.js's enforcement tick
  const AUDIBLE_EVENTS = ['play', 'playing', 'loadedmetadata', 'loadeddata', 'emptied'];
  let silenceTimer = 0;
  let silenceListening = false;

  function enforceSilence() {
    for (const name of Object.keys(writers)) {
      const w = writers[name];
      if (!w || w.kind !== 'native') continue;
      let els;
      try {
        els = w.elements ? w.elements() : [];
      } catch {
        els = [];
      }
      if (!els || !els.length) continue;
      let main = null;
      if (typeof w.main === 'function') {
        try {
          main = w.main();
        } catch {
          main = null;
        }
      }
      const target = want(name);
      for (const el of els) {
        if (!el || !el.isConnected || el.muted) continue; // already silent
        // The surface's MAIN element is the one voice: open is correct only in
        // the state the arbiter derived for the surface.
        if ((!main || el === main) && !target.muted) continue;
        try {
          el.muted = true;
          markWrite(el);
        } catch {
          /* a detached element mid-write */
        }
      }
    }
  }

  function armSilence() {
    if (silenceTimer || typeof setTimeout !== 'function') return;
    let native = false;
    for (const name of Object.keys(writers)) {
      if (writers[name] && writers[name].kind === 'native') native = true;
    }
    if (!native) return; // only an element surface can open on its own
    silenceTimer = setTimeout(silenceTick, SILENCE_MS) || 1;
  }

  function silenceTick() {
    silenceTimer = 0;
    try {
      enforceSilence();
    } finally {
      armSilence();
    }
  }

  // An element that the page INSERTS is not a timer: a hidden tab throttles
  // timers (measured in the owner's Chrome 2026-11-11: a 500 ms setTimeout had
  // not fired 1.5 s later), so the tick cannot be the only way to see one. The
  // observer is not throttled, and it is what a source-less <video> (no media
  // event ever fires) has as its only signal.
  let silenceObserving = false;
  function installSilenceObserver() {
    if (silenceObserving || typeof MutationObserver !== 'function') return;
    if (typeof document === 'undefined' || !document) return;
    silenceObserving = true;
    try {
      const observer = new MutationObserver((records) => {
        for (const rec of records) {
          const added = rec && rec.addedNodes;
          if (!added || !added.length) continue;
          for (const n of added) {
            if (!n) continue;
            const video = n.tagName === 'VIDEO' || (typeof n.querySelector === 'function' && n.querySelector('video'));
            if (video) {
              enforceSilence();
              return;
            }
          }
        }
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch {
      /* no observer: the tick and the media events still cover a visible tab */
    }
  }

  function installSilenceGuard() {
    if (silenceListening || typeof document === 'undefined' || !document) return;
    if (typeof document.addEventListener !== 'function') return;
    silenceListening = true;
    armSilence();
    installSilenceObserver();
    for (const type of AUDIBLE_EVENTS) {
      try {
        document.addEventListener(
          type,
          (ev) => {
            const el = ev && ev.target;
            if (!el || el.tagName !== 'VIDEO') return;
            enforceSilence();
          },
          true,
        );
      } catch {
        /* an engine without capture must not blind the guard */
      }
    }
  }

  function register(surface, spec) {
    writers[surface] = Object.assign({ kind: 'command' }, spec);
    if (spec && spec.shares) shares[surface] = spec.shares;
    forget(surface);
    return KOAudio;
  }

  function registerNative(surface, spec) {
    writers[surface] = Object.assign({ kind: 'native' }, spec);
    if (spec && spec.shares) shares[surface] = spec.shares;
    installGestureReader();
    installSilenceGuard();
    return KOAudio;
  }

  // The swap carries the user's sound. Owner rule 2026-11-09, verbatim:
  // "se antes tava desmutado > vai pra desmutado no player. e vice versa."
  // The incoming surface inherits the outgoing one's decision, so replacing the
  // player never invents a mute (and never invents sound either).
  function inheritState(from, to) {
    if (!from || !to || surfaceOf(from) === surfaceOf(to)) return;
    const src = intentOf(from);
    const dst = intentOf(to);
    if (dst.muted === !!src.muted && Math.abs(dst.volume - clamp(src.volume)) <= VOL_EPS) return;
    const was = { muted: dst.muted, volume: clamp(dst.volume) };
    dst.muted = !!src.muted;
    dst.volume = clamp(src.volume);
    persistTab();
    // The swap rule, measured: "se antes tava desmutado > vai pra desmutado no
    // player. e vice versa" (owner 2026-11-09). This line is what proves the
    // carry happened, or that it did NOT (owner 2026-11-12: "O PLAYER TAVA
    // MUTADO ... DEIXOU PAUSADO E DESMUTADO").
    report('audio-inherit', { from: surfaceOf(from), to: surfaceOf(to), was, now: { muted: dst.muted, volume: clamp(dst.volume) } });
  }

  // The surface the extension's own layers show. Overridden by a claim.
  function setVisible(surface) {
    const next = surface || null;
    if (next === requested) return KOAudio;
    const prev = requested;
    requested = next;
    inheritState(prev, next);
    report('audio-visible', { from: prev, to: next, claimed: claimed || null });
    apply();
    notify();
    return KOAudio;
  }

  // A surface that covers the whole page (the ad path's clean player) owns the
  // sound while it is up: the page's own layers must not steal it back from
  // their 400 ms tick. claim(null) releases.
  function claim(surface) {
    const next = surface || null;
    if (next === claimed) return KOAudio;
    if (!next) {
      releasedAt = Date.now();
      // A MACHINE policy is a verdict on the frame that was tested. It belongs
      // to the claim that owned that frame; the hand-back drops it with the
      // claim, so a refusal from a dead pod cannot silence the page that comes
      // back. Without this, `overlay.audioRefused` survived as a second writer
      // long after the frame it described was gone.
      if (policy.has('ad')) setPolicy('ad', false, { origin: 'ad:claim-release', why: 'handback' });
    }
    const prevClaim = claimed;
    claimed = next;
    // The claim is the single fact that decides whose sound is on screen, so it
    // carries the sound it is about to silence/restore, not just its own name.
    const w = next ? want(next) : null;
    report('audio-claim', {
      from: prevClaim || null,
      to: next || null,
      visible: visibleNow(),
      wanted: w ? { muted: !!w.muted, volume: +Number(w.volume).toFixed(2) } : null,
      intents: {
        twitch: { muted: !!intentOf('twitch').muted, volume: +clamp(intentOf('twitch').volume).toFixed(2) },
        kick: { muted: !!intentOf('kick').muted, volume: +clamp(intentOf('kick').volume).toFixed(2) },
      },
    });
    apply();
    notify();
    return KOAudio;
  }

  // The bridge publishes ONLY what the authority accepted. The echo carries
  // the author and frame that were actually taken; a refused ask logs
  // audio-refused and emits nothing, so no attribute can claim that refusal.
  const publishPolicy = (on, author, frame) => {
    try {
      if (typeof CustomEvent === 'function' && document && typeof document.dispatchEvent === 'function') {
        document.dispatchEvent(new CustomEvent('ko-audio-policy', {
          detail: JSON.stringify({ on: !!on, author: String(author || ''), frame: frame ? String(frame) : '' }),
        }));
      }
    } catch {
      /* early boot: the decision is still held by the authority */
    }
  };

  // Policy is the authority's OWN machine decision, never a second writer: a
  // caller may only ASK for it, and the ask must name its author and the frame
  // it tested. An unlabelled ask is refused out loud, not applied.
  function setPolicy(surface, on, opts) {
    const origin = String((opts && opts.origin) || 'code:UNLABELLED');
    const why = String((opts && opts.why) || 'direct');
    const frame = opts && opts.frame ? String(opts.frame) : null;
    // The BRIDGE refuses an unlabelled or frame-less ask before it reaches
    // here; a direct in-world call (popup, content script) stays valid.
    const had = policy.has(surface);
    if (on) {
      const prev = policyFrames.get(surface) || null;
      if (prev && prev !== frame) {
        // The frame that was refused is not the frame on screen now.
        report('audio-refused', { why: 'stale-frame-policy', surface, from: prev, frame, origin });
        return KOAudio;
      }
      policyFrames.set(surface, frame);
      policy.add(surface);
      publishPolicy(true, origin, frame);
    } else {
      policy.delete(surface);
      policyFrames.delete(surface);
      publishPolicy(false, '', frame);
    }
    if (had !== !!on) {
      report('audio-policy', { surface, on: !!on, why, origin, frame, visible: visibleNow() });
      apply();
    }
    return KOAudio;
  }

  function setIntent(surface, patch, opts) {
    const it = intentOf(surface);
    const before = { muted: it.muted, volume: it.volume };
    // WHO asked for this. The owner's order 2026-11-12: "tu tem que entender se
    // o mute vem do meu click do mouse e se vem de alguma decisao do codigo".
    // An ACCEPTED intent that names no author is what made his own log read as
    // the extension muting him for no reason, so the label is mandatory: every
    // in-file writer passes one, and an unlabelled write is itself the bug.
    const origin = String((opts && opts.origin) || 'code:UNLABELLED');
    const evidence = opts && opts.ev
      ? {
          input: opts.ev.input || null,
          inputAgeMs: opts.ev.inputAgeMs == null ? null : Math.round(opts.ev.inputAgeMs),
          userActive: !!opts.ev.userActive,
          ownWrite: !!opts.ev.ownWrite,
        }
      : null;
    const patchMuted = patch && typeof patch.muted === 'boolean' ? !!patch.muted : null;
    const wantsMute = patchMuted === null ? it.muted : patchMuted;
    let vol = patch && isNum(patch.volume) ? clamp(patch.volume) : it.volume;
    if (patch && isNum(patch.volume) && patch.volume <= 0.001 && patchMuted !== true) {
      // A zero with no mute decision is not an audible level: it is a silence
      // someone else wrote. Refuse it by name instead of persisting it.
      report('audio-refused', { why: 'zero-volume-without-mute', surface: String(surface), origin, volume: patch.volume });
    }
    // The native volumechange reader already normalises its OWN patch (the
    // level it silenced), so it is the writer of that decision here. All other
    // callers—bar, popup, bridge—get the level rule at this arbiter.
    const fromNativeReader = String((opts && opts.origin) || '') === 'user:pointer';
    if (!fromNativeReader && vol <= 0.001) vol = levelOf(surfaceOf(surface));
    if (vol > 0.001) levels[surfaceOf(surface)] = vol;
    if (patchMuted !== null) it.muted = patchMuted;
    it.volume = vol;
    const changed = before.muted !== it.muted || Math.abs(before.volume - it.volume) > 0.0001;
    if (changed) {
      report('audio-intent', {
        surface: String(surface),
        before,
        after: { muted: it.muted, volume: clamp(it.volume) },
        why: String((opts && opts.why) || 'direct'),
        origin,
        ev: evidence,
        silent: !!(opts && opts.silent),
        // WHO is on screen and what covers it, at the instant the decision was
        // written. Without these three, an accepted mute cannot be told apart
        // from the machine's, which is exactly the report of 2026-11-12.
        visible: visibleNow(),
        claimed: claimed || null,
        surfaces: Object.keys(writers),
      });
    }
    if (changed && !(opts && opts.silent)) {
      apply();
      notify();
    }
    if (changed) persistTab();
    return KOAudio;
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return KOAudio;
  }

  // ---- gesture freshness --------------------------------------------------
  // `navigator.userActivation.hasBeenActive` is STICKY: once the owner clicked
  // anywhere (chat, the volume bar) it stays true for the life of the page, so
  // it cannot tell his click from Twitch's player muting itself on an ad a
  // minute later. Owner report 2026-11-09: "ta mutando de forma aleatoria essa
  // merda. tentei falar com um streamer e mutou sozinho".
  //
  // What separates the two is FRESHNESS: a human gesture and the volumechange
  // it causes are delivered in the same task, a few ms apart. INPUT_FRESH_MS is
  // 1200 ms = three of content.js's 400 ms RECT_MS enforcement ticks (and two
  // of the ad path's 500 ms positionOverlay ticks): enough for a slow frame or
  // a queued event, yet shorter than the ad path's 1500 ms unmute-check delay
  // and about one player-bridge heartbeat (1000 ms), so a machine write that
  // lands later is not attributable to the gesture.
  const CLAIM_RELEASE_MS = 2500; // a mute this soon after the hand-back is Twitch's
  const INPUT_FRESH_MS = 1200;
  const INPUT_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart', 'click'];
  let lastInputAt = 0;
  let lastInputKind = '';
  let lastInputVolumeCapable = false;
  // WHICH element took the input. "He clicked" is not an answer: a click on the
  // player's volume button and a click on the picture are the same event, and
  // the difference decides whether a mute is his. The row carries it so the
  // next reader does not have to guess (owner order 2026-11-16: "TUDO ISSO
  // deveria estar nos logs").
  let lastInputTarget = null;
  // A pointerdown ON A VOLUME CONTROL opens a drag window. `pointermove` is not
  // in INPUT_EVENTS, so a slider drag's volumechange is older than
  // INPUT_FRESH_MS and would be refused as the machine's. The window keeps it
  // fresh and volume-capable until pointerup/pointercancel closes it.
  let volumeDrag = 0;
  // Positive evidence for the machine-window exception. `volumeCapableTarget`
  // below is deliberately permissive (no target is not a refutation); an
  // exception to the claim guard needs the opposite: a named control or a real
  // volume key, never a target-less click standing in for one.
  let lastInputCertified = false;
  // A letter typed in chat is not a volume gesture. `m` in a text box is text,
  // not Twitch's mute shortcut; without this check a fresh keydown certified
  // whatever the player wrote next as the user's decision (owner report
  // 2026-11-16: "tentei falar com um streamer e mutou sozinho").
  function editableTarget(t) {
    try {
      if (!t || typeof t !== 'object') return false;
      if (t.isContentEditable) return true;
      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(String(t.tagName || ''))) return true;
      if (typeof t.closest === 'function' && t.closest('[contenteditable], [role="textbox"], [data-a-target="chat-input"], #chat-input')) return true;
    } catch {
      /* a detached stub has no ancestor chain: no positive evidence */
    }
    return false;
  }
  function describeTarget(t) {
    try {
      if (!t || typeof t !== 'object') return null;
      if (t.id) return `#${t.id}`;
      const attr = (t.getAttribute && (t.getAttribute('data-a-target') || t.getAttribute('aria-label'))) || '';
      if (attr) return String(attr).slice(0, 40);
      const tag = String(t.tagName || '').toLowerCase();
      const cls = String((t.className && t.className.baseVal) || t.className || '').split(/\s+/)[0];
      return (tag || '?') + (cls ? `.${cls.slice(0, 30)}` : '');
    } catch {
      return null;
    }
  }
  // WHICH input, not just WHEN. Freshness alone cannot tell a click on the
  // player's volume button from a click anywhere else on the page followed by
  // the machine muting its own element. Measured in the owner's ko.adlog
  // 2026-11-15 (0.8.92, twitch.tv/buzzyi_):
  //   audio-intent {origin:"user:pointer", ev:{input:"click", inputAgeMs:57},
  //                 after:{muted:true, volume:0.81}, surface:"twitch"}
  //   ... then the next live he opened started MUTED ("troquei de live e ela
  //   começou mutada ... só desmuta se eu ligar e desligar o som").
  // His click was on the picture (recovering a stall), Twitch muted its own
  // element 57 ms later, and the freshest-input rule made that his decision for
  // the rest of the tab. A MUTE is only his when the input could have changed a
  // volume: our own bar, or a control inside the player's control bar. An
  // UNMUTE stays his from any fresh input - refusing it would trap a silent tab.
  // A LABEL CERTIFIES MUTE/UNMUTE ONLY AS A WORD. `[aria-label*="ute"]` certified
  // any label containing those letters ("Absolute", "Route", "Computer"), so a
  // click on an unrelated labelled button could be read as a volume gesture.
  // CSS has no case-insensitive word boundary; the selector keeps the real
  // controls, and this test makes the wording exact.
  const MUTE_WORD_RE = /\b(?:un)?mut(?:e|ed|ing)\b/i;
  function labelledMute(el) {
    try {
      if (!el || typeof el.getAttribute !== 'function') return null;
      const label = el.getAttribute('aria-label');
      return typeof label === 'string' && MUTE_WORD_RE.test(label) ? el : null;
    } catch {
      return null;
    }
  }
  function muteLabelHit(el) {
    try {
      for (let e = el; e; e = e.parentElement) {
        const hit = labelledMute(e);
        if (hit) return hit;
      }
    } catch {
      /* a detached stub has no ancestor chain */
    }
    return null;
  }
  const VOLUME_CONTROL_SEL = [
    '#ko-wrap', '#ko-volwrap', '#ko-mute', '#ko-vol',
    '[data-a-target="player-volume-slider"]',
    '[data-a-target="player-mute-unmute-button"]',
    '[data-a-target*="volume"]',
    '[data-a-target*="mute"]',
    '[aria-label*="olume"]',
    // YOUTUBE'S OWN PLAYER CHROME CARRIES NEITHER. Measured 2026-11-24 on the
    // owner's tab (`youtube.com/watch?v=BuC4wthYlLU`): `.ytp-mute-button` is a
    // 40x40 visible button with `aria-label:null` and no `data-a-target`, so
    // every click on it fell through this selector and was refused as
    // `audio-refused {why:"not-volume-control"}`. The refusal calls `apply()`,
    // which re-asserts the unmuted intent — the owner's "o meu youtube ta com
    // problema pra mutar e desmutar ... ele nao muta". The button is the user's
    // control no matter how Twitch-shaped our selector was; match the player
    // chrome itself, and `closest()` covers the icon inside it.
    '.ytp-mute-button', '.ytp-volume-button', '.ytp-volume-area',
    '.ytp-volume-panel', '.ytp-volume-slider', '.ytp-volume-slider-handle',
    // TWITCH'S AD-UI VOLUME CONTROLS. His 0.8.113 ring refused the ad slider as
    // `not-volume-control`: that chrome carries none of the data-a-target or
    // aria-label shapes above. Name the CONTROL, never the whole player — a
    // whole-player selector would make a click on the picture volume-capable
    // (the measured 2026-11-15 defect).
    '[role="slider"]', '[class*="volume-slider"]', '[class*="ad-volume"]',
    '[data-purpose="volume-control"]',
  ].join(',');
  // A wildcard selector is a HINT, not a certificate: `[aria-label*="olume"]`
  // and `[data-a-target*="mute"]` must also name a whole volume/mute word on
  // the element itself. Otherwise a label like "Absolute" certifies a machine
  // mute through the adjacent substring selector while MUTE_WORD_RE above
  // would refuse the very same word. One owning predicate for both shapes.
  const VOLUME_NAME_RE = /\b(?:volume|volumes|(?:un)?mut(?:e|ed|ing))\b/i;
  const WILDCARD_SELS = VOLUME_CONTROL_SEL.split(',').map((s) => s.trim()).filter((s) => s.includes('*='));
  function wildcardHitWithoutName(el) {
    try {
      let matched = false;
      for (const sel of WILDCARD_SELS) {
        if (typeof el.matches === 'function' && el.matches(sel)) matched = true;
      }
      if (!matched) return false;
      for (let e = el; e; e = e.parentElement) {
        if (typeof e.getAttribute !== 'function') continue;
        for (const attr of ['aria-label', 'data-a-target']) {
          const v = e.getAttribute(attr);
          if (typeof v === 'string' && VOLUME_NAME_RE.test(v)) return false;
        }
      }
      return true;
    } catch {
      return false; // no positive refutation from an element we cannot read
    }
  }
  function volumeCapableTarget(ev) {
    try {
      const t = ev && ev.target;
      // An event with no target at all carries no evidence either way (a
      // synthesised event, an engine that omits it). Only a KNOWN target that
      // cannot change a volume refutes the mute; unknown is not a refutation.
      if (!t) return true;
      // A GENERIC SLIDER IS NOT A VOLUME CONTROL. YouTube's progress bar and
      // every seek bar are `role="slider"` too (the owner's YouTube progress bar
      // carries aria-label "Seek slider"), and certifying a seek click would let
      // the mute the player writes next be recorded as his - the 2026-11-15
      // picture-click defect in a new shape. A bare slider counts only when its
      // own name/class, or an ancestor's, says volume.
      const labelHit = muteLabelHit(t);
      const hit = labelHit || (t.closest && t.closest(VOLUME_CONTROL_SEL));
      if (hit) {
        let named = null;
        let generic = false;
        try {
          named = hit.closest && hit.closest('[class*="volume"],[aria-label*="olume"],[data-a-target*="volume"],[data-a-target*="mute"]');
        } catch { named = null; }
        if (!named && labelHit) named = labelHit;
        try {
          generic = typeof hit.matches === 'function' && hit.matches('[role="slider"]');
        } catch { generic = false; }
        if (wildcardHitWithoutName(hit)) return false;
        return !generic || !!named;
      }
      // A keyboard shortcut can change a volume, but ONLY the keys that do:
      // Twitch's player binds `m` to mute and ArrowUp/ArrowDown to volume.
      // Accepting ANY keydown made every other key the owner presses — space to
      // pause, a letter typed in chat, an arrow used to seek — authorize
      // whatever the player wrote next. Measured in his own ko.adlog 2026-11-16
      // (0.8.95, twitch.tv/iolkaida):
      //   audio-refused {intent:{volume:1}, el:{volume:0.32}, why:"stale-input"}   (x11)
      //   ... then, 528 ms after a keydown:
      //   audio-intent  {before:{volume:1}, after:{volume:0.32}, ev:{input:"keydown", inputAgeMs:528}}
      // 0.32 is Twitch's own ad volume: the same value the arbiter had been
      // REFUSING all pod long, accepted once because a keystroke was fresh.
      // That is his "ai mutou a live". An UNMUTE is still accepted from any
      // fresh input (see the caller), so a refused mute can never trap a silent
      // tab, and every refusal names itself in `audio-refused`.
      const kind = String((ev && ev.type) || '');
      if (kind !== 'keydown' || editableTarget(ev && ev.target)) return false;
      const key = String((ev && (ev.key || ev.code)) || '');
      // ONLY the player's own volume keys certify a mute. Everything else
      // (space, chat text, seek arrows) is refused at the reader below.
      return key === 'm' || key === 'M' || key === 'ArrowUp' || key === 'ArrowDown';
    } catch {
      return false;
    }
  }
  function markInput(ev) {
    lastInputAt = Date.now();
    lastInputKind = String((ev && ev.type) || '');
    lastInputVolumeCapable = volumeCapableTarget(ev);
    lastInputTarget = describeTarget(ev && ev.target);
    // A target-less event is not positive evidence of a control, even though
    // `volumeCapableTarget` cannot refute it. Only a named control or a real
    // volume key may open the claim exception or a drag window.
    lastInputCertified = !!lastInputVolumeCapable && !!(ev && ev.target);
    if (lastInputKind === 'pointerdown' && lastInputCertified) volumeDrag = Date.now();
  }
  function closeDrag() {
    volumeDrag = 0;
  }
  function installInputClock() {
    const targets = [];
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') targets.push(window);
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') targets.push(document);
    for (const target of targets) {
      for (const type of INPUT_EVENTS) {
        try {
          target.addEventListener(type, markInput, { capture: true, passive: true });
        } catch {
          /* an engine without capture must not break the arbiter */
        }
      }
    }
    // A released (or cancelled) pointer ends the drag; afterwards a
    // volumechange is the machine's again, not the user's.
    for (const target of targets) {
      for (const type of ['pointerup', 'pointercancel']) {
        try {
          target.addEventListener(type, closeDrag, { capture: true, passive: true });
        } catch {
          /* an engine without capture must not break the arbiter */
        }
      }
    }
  }

  // A volumechange that we did not write is the ONLY signal carrying the user's
  // decision. Read it from the surface's main element only: Twitch fires the
  // same event from preview/PBP videos and from its own ad element, and none of
  // those are the user talking.
  // Has this tab ever seen a real user activation? Chrome's own autoplay mute
  // fires a volumechange without one; Twitch's volume button cannot. This is a
  // SECOND, non-decisive signal: it can veto an event, never decide one.
  function userActive() {
    try {
      const nav = (typeof window !== 'undefined' && window.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
      const ua = nav && nav.userActivation;
      if (ua && typeof ua.hasBeenActive === 'boolean') return ua.hasBeenActive;
    } catch {
      /* older engine: no signal */
    }
    return true; // no signal must not silence the feature: assume the user
  }

  function installGestureReader() {
    if (listening || typeof document === 'undefined') return;
    listening = true;
    installInputClock();
    document.addEventListener('volumechange', (ev) => {
      const el = ev && ev.target;
      if (!el || el.tagName !== 'VIDEO' || !el.isConnected) return;
      if (isOwnWrite(el, el.muted, el.volume)) return; // our own write echoing
      // Which surface holds this element, and is it that surface's MAIN element?
      // Only a main element can carry the user's decision; a secondary one is
      // held muted by the one-voice rule, so whatever opened it is the page (or
      // the browser) and must be silenced instead of read as a gesture. This is
      // the second way the stream got a second audible copy in the owner's tab.
      let owner = null;
      let isMain = true;
      for (const name of Object.keys(writers)) {
        const w = writers[name];
        if (!w || w.kind !== 'native' || typeof w.elements !== 'function') continue;
        let els;
        try {
          els = w.elements() || [];
        } catch {
          els = [];
        }
        let holds = false;
        for (const e of els) {
          if (e === el) {
            holds = true;
            break;
          }
        }
        if (!holds) continue;
        owner = name;
        let main = null;
        if (typeof w.main === 'function') {
          try {
            main = w.main();
          } catch {
            main = null;
          }
        }
        isMain = !main || main === el;
        break;
      }
      if (!owner) return; // not a surface this tab owns: not ours to read
      if (!isMain) {
        enforceSilence(); // a secondary element never carries the user's decision
        return;
      }
      // Only a FRESH input can have produced this volumechange. A stale one is
      // the machine: Twitch's player muting itself on an ad, the ad path's
      // claim silencing the page, or the player restarting. Recording it as
      // intent persisted the mute per tab and the next player inherited it —
      // the owner's "it muted by itself".
      // A drag opened by a pointerdown on a volume control keeps its events
      // fresh and volume-capable: `pointermove` is not an INPUT_EVENT, so the
      // moves of a slider drag never refresh `lastInputAt` and every change
      // after INPUT_FRESH_MS was refused as `stale-input`.
      const dragging = !!volumeDrag;
      const fresh = dragging || Date.now() - lastInputAt <= INPUT_FRESH_MS;
      const volumeCapable = dragging || lastInputVolumeCapable;
      if (!fresh) {
        report('audio-refused', {
          why: 'stale-input',
          owner,
          el: { muted: !!el.muted, volume: +Number(el.volume || 0).toFixed(2) },
          sinceInputMs: lastInputAt ? Date.now() - lastInputAt : null,
          intent: { muted: !!intentOf(owner).muted, volume: clamp(intentOf(owner).volume) },
        });
        apply();
        return;
      }
      // Second, non-decisive signal: a tab that has never seen activation
      // cannot have a real gesture (Chrome silencing an autoplay). It can veto
      // the event above, never decide it.
      if (!userActive()) {
        report('audio-refused', {
          why: 'never-activated',
          owner,
          el: { muted: !!el.muted, volume: +Number(el.volume || 0).toFixed(2) },
          intent: { muted: !!intentOf(owner).muted, volume: clamp(intentOf(owner).volume) },
        });
        // Machine-driven: a player that muted itself, or Chrome's autoplay
        // policy. Neither is the user's choice, so it must not become one; and
        // it must not silence the surface either, because the intent says the
        // user wants sound. Re-assert the derived state instead: the surface
        // goes back to what the user left it at.
        apply();
        return;
      }
      // A MUTE arriving on a surface the extension's own layer is currently
      // covering is the machine's, even when a click was 1 s ago. Owner report
      // 2026-11-11: "deixou a live com delay ... e o player trocou pra ficar
      // mutado" — he clicks the player to recover the delay, Twitch mutes its
      // own element as the pod takes over, the click made the event FRESH, and
      // the mute became his intent for the rest of the session. An UNMUTE is
      // still his (0.8.54 already carries it to the new surface), so only the
      // silencing direction is refused here.
      // A MUTE arriving on the page surface right after the extension's own
      // layer let go of it is the machine's, even when a click was 1 s ago.
      // Owner report 2026-11-11: "deixou a live com delay ... e o player trocou
      // pra ficar mutado" -- he clicks the player to recover the delay, the pod
      // ends, Twitch re-mutes its own element, the click made the event FRESH,
      // and the mute became his intent for the rest of the session. An UNMUTE
      // is still his, so only the silencing direction is refused here.
      // WHILE A CLAIM IS UP, A MUTE IS THE MACHINE'S UNLESS A CERTIFIED GESTURE
      // SAY OTHERWISE. The old test compared `surfaceOf(owner) !==
      // surfaceOf(claimed)`, and the ad surface SHARES the `twitch` intent by
      // design - so `surfaceOf('twitch') === surfaceOf('ad')` and the guard was
      // blind for the one claim that always covers the page. Measured in the
      // owner's own ko.adlog 2026-11-12 390919, mid-pod:
      //   audio-intent {surface:"twitch", before:{muted:false,volume:0.88},
      //                 after:{muted:true,volume:0}, silent:true}
      //   ... 38 s later: audio-claim {from:"ad", to:null} -> page comes back
      //                   muted, volume 0 ("voltou MUTADO sendo que antes eu
      //                   estava com a live DESMUTADA").
      // The claimed surface silences the page's element, so a mute with NO
      // certified gesture is the machine's. A fresh pointerdown on a volume
      // control (or a volume key) is the one exception: owner 2026-11-24
      // (0.8.113) saw his own click on Twitch's mute button refused as
      // `covered`. An UNMUTE was and remains his in both cases.
      const machineWindow = !!claimed || (releasedAt > 0 && Date.now() - releasedAt <= CLAIM_RELEASE_MS);
      const certified = fresh && (dragging || lastInputCertified);
      if (machineWindow && !!el.muted && !certified) {
        // Say it out loud: an ACCEPTED intent beside an unlogged refusal is
        // what made the owner's own adlog look like the extension muting him
        // for no reason. This line names the claim, the surface it covers and
        // the intent it was protecting.
        report('audio-refused', {
          why: 'covered',
          owner,
          claimed: claimed || null,
          releasedMsAgo: releasedAt ? Date.now() - releasedAt : null,
          el: { muted: !!el.muted, volume: +Number(el.volume || 0).toFixed(2) },
          intent: { muted: !!intentOf(owner).muted, volume: clamp(intentOf(owner).volume) },
          visible: visibleNow(),
        });
        apply();
        return;
      }
      // A CLICK THAT COULD NOT HAVE CHANGED A VOLUME CANNOT HAVE MUTED. The
      // freshness test above answers WHEN, not WHICH: the owner clicks the
      // picture to unstick the player, Twitch mutes its own element 57 ms later
      // (2026-11-15 ring, surface twitch, volume 0.81), and the freshest-input
      // rule recorded that as his decision — which is why the NEXT live he
      // opened started muted and "só desmuta se eu ligar e desligar o som".
      // Only a mute arriving on a control that can carry a volume is his. An
      // UNMUTE is never refused here: refusing it would trap a silent tab.
      // ...and the same is true of a volume DROP. The gate above only covered
      // the `muted` direction, so Twitch's ad volume arriving fresh after a
      // keystroke became intent as `{muted:false, volume:0.32}` — a slash he
      // can hear and cannot explain (owner 2026-11-16: "ai mutou a live", with
      // the same 0.32 the arbiter had refused eleven times in that pod). A
      // LOWERING is the harm; a raise can only make the tab louder than he
      // asked, and refusing that would trap a quiet tab.
      const prevVolume = +Number(intentOf(owner).volume || 0);
      const lowering = !!el.muted || +Number(el.volume || 0) < prevVolume - 0.01;
      if (lowering && !volumeCapable) {
        report('audio-refused', {
          why: 'not-volume-control',
          dir: el.muted ? 'mute' : 'drop',
          owner,
          el: { muted: !!el.muted, volume: +Number(el.volume || 0).toFixed(2) },
          sinceInputMs: lastInputAt ? Date.now() - lastInputAt : null,
          input: lastInputKind || null,
          inputTarget: lastInputTarget || null,
          intent: { muted: !!intentOf(owner).muted, volume: clamp(intentOf(owner).volume) },
        });
        apply();
        return;
      }
      policy.delete(owner);
      // A MUTE REMEMBERS THE LEVEL IT SILENCED. Twitch's own volume button writes
      // `muted:true` AND `volume:0`, and persisting that 0 threw the level away:
      // unmuting then reported `{muted:false, volume:0}` - unmuted by intent,
      // silent by volume, the bar icon saying "sound on" - until the player
      // happened to send a SECOND volumechange. That is the owner's "o botao de
      // mutar e desmutar funciona de forma inconsistente ... normalmente vendo
      // live mesmo" (2026-11-16), and his ring shows both halves of it:
      //   audio-intent {before:{muted:false,volume:1}, after:{muted:true,volume:0}}
      //   audio-intent {before:{muted:true,volume:0},  after:{muted:false,volume:0}}
      //   audio-intent {before:{muted:false,volume:0}, after:{muted:false,volume:1}}
      // One gesture, three rows, and a restore that depends on the page sending
      // the last event. The decision is "muted"; the level is what he had, and
      // `want()` applies the 0 only while muted.
      const prevIntent = intentOf(owner);
      const lvl = Number(el.volume);
      const patch = {
        muted: !!el.muted,
        volume: Math.abs(lvl) > 0.001 ? lvl : clamp(prevIntent.volume),
      };
      // The ONLY path allowed to call a volumechange the user's: a fresh input
      // and a real activation, both stated in the line so the owner's question
      // ("veio do meu clique ou do código?") is answered by the log itself.
      const gestureEvidence = {
        input: lastInputKind || null,
        inputAgeMs: lastInputAt ? Date.now() - lastInputAt : null,
        inputTarget: lastInputTarget || null,
        volumeCapable,
        userActive: userActive(),
        ownWrite: false,
      };
      setIntent(owner, patch, { silent: true, origin: 'user:pointer', ev: gestureEvidence });
      const now = visibleNow();
      if (now && now !== owner) setIntent(now, patch, { silent: true, origin: 'user:pointer->visible', ev: gestureEvidence });
      apply();
      notify();
    }, true);
  }

  const KOAudio = {
    // ---- state readers
    intent: (surface) => {
      const it = intentOf(surface);
      return { muted: !!it.muted, volume: clamp(it.volume) };
    },
    wanted: (surface) => want(surface),
    visible: () => visibleNow(),
    isOwnWrite,
    // ---- state writers
    setIntent,
    setVisible,
    claim,
    setPolicy,
    apply,
    // MUTE-ONLY convergence, for a caller that wants to re-assert without ever
    // taking a machine-muted element back to audible (content.js's 400 ms
    // drift check should call this instead of apply()). Never un-mutes.
    enforceSilence,
    forget,
    // ---- wiring
    register,
    registerNative,
    onChange,
  };

  restoreTab();

  try {
    Object.defineProperty(window, 'KOAudio', { value: KOAudio, enumerable: true });
  } catch {
    window.KOAudio = KOAudio;
  }
})();
