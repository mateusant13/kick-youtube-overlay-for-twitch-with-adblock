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
//            sets it (a volumechange we did not write, the popup, the badge).
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

(function () {
  'use strict';
  // Injected once per matching content_scripts entry (twitch lists three), so
  // the FIRST instance is the authority: a second one would rebuild the intent
  // store from defaults and silently discard the user's choice.
  if (window.KOAudio) return;

  const TTL = 700;            // a write this young is OURS, not the user's
  const VOL_EPS = 0.02;       // volume granularity below which nothing changes

  const intents = {
    twitch: { muted: false, volume: 1 },
    kick: { muted: true, volume: 1 },
    yt: { muted: false, volume: 1 },
  };
  const writers = Object.create(null);   // surface -> { kind, ... }
  const shares = Object.create(null);    // surface -> the surface whose intent it uses
  const policy = new Set();              // surfaces silenced by browser policy
  const sent = Object.create(null);      // surface -> last state COMMANDED (echo guard)
  const writes = new WeakMap();          // Element -> { at, muted, volume }
  const listeners = new Set();           // intent change subscribers
  let requested = null;                  // the surface the page's own layers show
  let claimed = null;                    // a surface that COVERS the page (the ad
                                         // path's clean player); wins while set
  const visibleNow = () => claimed || requested;
  let persist = () => {};
  let listening = false;

  const clamp = (v) => Math.max(0, Math.min(1, Number(v)));
  const isNum = (v) => typeof v === 'number' && isFinite(v);
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
      let els;
      try {
        els = w.elements ? w.elements() : [];
      } catch {
        els = [];
      }
      for (const el of els) {
        if (!el || !el.isConnected) continue;
        try {
          if (!!el.muted !== target.muted) {
            el.muted = target.muted;
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
    return KOAudio;
  }

  // The surface the extension's own layers show. Overridden by a claim.
  function setVisible(surface) {
    const next = surface || null;
    if (next === requested) return KOAudio;
    requested = next;
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
    claimed = next;
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
    if (changed && !(opts && opts.silent)) {
      apply();
      notify();
    }
    if (changed && opts && opts.persist) {
      try {
        persist();
      } catch {
        /* storage is best-effort */
      }
    }
    return KOAudio;
  }

  function setPersister(fn) {
    if (typeof fn === 'function') persist = fn;
    return KOAudio;
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return KOAudio;
  }

  // A volumechange that we did not write is the ONLY signal carrying the user's
  // decision. Read it from the surface's main element only: Twitch fires the
  // same event from preview/PBP videos and from its own ad element, and none of
  // those are the user talking.
  function installGestureReader() {
    if (listening || typeof document === 'undefined') return;
    listening = true;
    document.addEventListener('volumechange', (ev) => {
      const el = ev && ev.target;
      if (!el || el.tagName !== 'VIDEO' || !el.isConnected) return;
      if (isOwnWrite(el, el.muted, el.volume)) return; // our own write echoing
      let owner = null;
      for (const name of Object.keys(writers)) {
        const w = writers[name];
        if (w.kind !== 'native' || typeof w.main !== 'function') continue;
        let main = null;
        try {
          main = w.main();
        } catch {
          main = null;
        }
        if (main && main === el) {
          owner = name;
          break;
        }
      }
      if (!owner) return; // not a surface's main element: not a user decision
      const patch = { muted: !!el.muted, volume: Number(el.volume) };
      setIntent(owner, patch, { persist: true, silent: true });
      const now = visibleNow();
      if (now && now !== owner) setIntent(now, patch, { persist: true, silent: true });
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
    forget,
    // ---- wiring
    register,
    registerNative,
    setPersister,
    onChange,
  };

  try {
    Object.defineProperty(window, 'KOAudio', { value: KOAudio, enumerable: true });
  } catch {
    window.KOAudio = KOAudio;
  }
})();
