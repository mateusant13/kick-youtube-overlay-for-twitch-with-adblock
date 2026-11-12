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
    }
  }

  function persistTab() {
    const store = tabStore();
    if (!store) return;
    const rec = {};
    for (const key of Object.keys(intents)) {
      rec[key] = { m: !!intents[key].muted, v: clamp(intents[key].volume) };
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
    if (!next) releasedAt = Date.now();
    const prevClaim = claimed;
    claimed = next;
    report('audio-claim', { from: prevClaim || null, to: next || null });
    apply();
    notify();
    return KOAudio;
  }

  function setPolicy(surface, on) {
    const had = policy.has(surface);
    if (on) policy.add(surface);
    else policy.delete(surface);
    if (had !== !!on) apply();
    return KOAudio;
  }

  function setIntent(surface, patch, opts) {
    const it = intentOf(surface);
    const before = { muted: it.muted, volume: it.volume };
    if (patch && typeof patch.muted === 'boolean') it.muted = patch.muted;
    if (patch && isNum(patch.volume)) it.volume = clamp(patch.volume);
    const changed = before.muted !== it.muted || Math.abs(before.volume - it.volume) > 0.0001;
    if (changed) {
      report('audio-intent', {
        surface: String(surface),
        before,
        after: { muted: it.muted, volume: clamp(it.volume) },
        why: String((opts && opts.why) || 'direct'),
        silent: !!(opts && opts.silent),
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
  function markInput() {
    lastInputAt = Date.now();
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
      const fresh = Date.now() - lastInputAt <= INPUT_FRESH_MS;
      if (!fresh) {
        apply();
        return;
      }
      // Second, non-decisive signal: a tab that has never seen activation
      // cannot have a real gesture (Chrome silencing an autoplay). It can veto
      // the event above, never decide it.
      if (!userActive()) {
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
      const machineWindow = claimed
        ? surfaceOf(owner) !== surfaceOf(claimed)
        : (releasedAt > 0 && Date.now() - releasedAt <= CLAIM_RELEASE_MS);
      if (machineWindow && !!el.muted) {
        apply();
        return;
      }
      policy.delete(owner);
      const patch = { muted: !!el.muted, volume: Number(el.volume) };
      setIntent(owner, patch, { silent: true });
      const now = visibleNow();
      if (now && now !== owner) setIntent(now, patch, { silent: true });
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
