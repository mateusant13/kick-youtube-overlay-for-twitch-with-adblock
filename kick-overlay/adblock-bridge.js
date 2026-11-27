'use strict';
// Mirrors the persisted adblock toggle into a DOM attribute the MAIN-world
// script can read, and persists the ad-event log across page refreshes.
//
// MAIN-world content scripts cannot use chrome.storage, so this tiny ISOLATED
// bridge is the only channel. Default adblock state is ON.
//
// Persistent log: `chrome.storage.local['ko.adlog']` is a ring buffer (500
// events, oldest dropped). Every page load gets a new `sid`; events are
// appended, never cleared, so a preroll that fires after a refresh is still
// visible next time. Read it with:
//   chrome.storage.local.get('ko.adlog', o => console.log(o['ko.adlog']))
// or from CDP on an extension page.
// Wrapped in an IIFE: content scripts share the isolated world's lexical
// scope, and content.js also declares `KEY`.
(() => {
  const KEY = 'ko.v2';
  const LOG_KEY = 'ko.adlog';
  const LOG_MAX = 1200;
  const sid = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  let booted = false;

  // In-memory cache + debounced flush. A storage get/set per event would make
  // ad-tick writes visible as jank; this keeps writes to <=1 per 400ms.
  let logCache = null;
  let pending = [];
  let loading = false;
  let flushTimer = 0;
  let flushBusy = false;

  const flush = () => {
    if (!logCache || flushBusy) return;
    flushBusy = true;
    const out = logCache.slice();
    try {
      chrome.storage.local.set({ [LOG_KEY]: out }, () => {
        void chrome.runtime.lastError;
        flushBusy = false;
        if (logCache && logCache.length !== out.length) scheduleFlush(200);
      });
    } catch {
      flushBusy = false;
    }
  };

  function scheduleFlush(ms) {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = 0;
      flush();
    }, ms);
  }

  const push = (rec) => {
    if (!logCache) {
      pending.push(rec);
      return;
    }
    logCache.push(rec);
    if (logCache.length > LOG_MAX) logCache.splice(0, logCache.length - LOG_MAX);
    scheduleFlush(400);
  };

  // A RING THAT WRAPS CANNOT BE READ BY INDEX, AND THE INTRODUCTION OF `n` IS
  // the fix for a tool that broke silently: `muteauthor` counted `length`, then
  // re-read `slice(mark)` — correct while the log grows, ALWAYS EMPTY once it
  // reached LOG_MAX (1200), so every measurement of "who moved the sound" read
  // NONE on a long-lived tab (measured 2026-11-13: the adlog itself proved
  // `user:pointer` + `audio-refused {why:'stale-input'}` while the arm reported
  // failure). `n` is monotonic across the ring's whole life, so a reader can ask
  // for "everything after n=X" without knowing where the buffer started.
  let seq = 0;
  const persist = (ev) => {
    seq += 1;
    const rec = Object.assign({ t: Date.now(), sid, n: seq }, ev);
    if (logCache) {
      push(rec);
      return;
    }
    pending.push(rec);
    if (loading) return;
    loading = true;
    try {
      chrome.storage.local.get(LOG_KEY, (o) => {
        void chrome.runtime.lastError;
        loading = false;
        logCache = Array.isArray(o && o[LOG_KEY]) ? o[LOG_KEY] : [];
        // The ring outlives this instance: continue its counter instead of
        // restarting at 1, or a reader that saw n=900 would treat the next 900
        // entries as already-read.
        for (const r of logCache) {
          if (r && typeof r.n === 'number' && r.n > seq) seq = r.n;
        }
        const batch = pending;
        pending = [];
        for (const p of batch) push(p);
        scheduleFlush(50);
      });
    } catch {
      loading = false;
    }
  };

  const flushNow = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = 0;
    }
    flush();
  };

  // The MAIN-world script dispatches a string detail, which is safe across the
  // isolated-world boundary (objects are not shared).
  try {
    document.addEventListener(
      'ko-adlog',
      (ev) => {
        try {
          const data = JSON.parse(String(ev && ev.detail));
          if (data && typeof data.ev === 'string') persist({ ev: data.ev, d: data.d || null });
        } catch {
          /* ignore malformed events */
        }
      },
      true,
    );
  } catch {
    /* document may be unavailable very early */
  }

  // ---- audio bridge (the authority is ko-audio.js, in THIS world) -----------
  // The ad path runs in the MAIN world on the same page and cannot reach the
  // arbiter. Attributes carry the DERIVED state down (it applies them to its own
  // iframe and nothing else); string-detail events carry the user's intent and
  // the "I am covering the page" claim up. No mute decision crosses the
  // boundary: that is how two independent policies used to fight over the same
  // <video> element and revert the owner's unmute.
  const attachAudioBridge = () => {
    const audio = window.KOAudio;
    const root = document.documentElement;
    if (!audio || !root) {
      document.addEventListener('DOMContentLoaded', attachAudioBridge, { once: true });
      return;
    }
    audio.register('ad', {
      shares: 'twitch', // the clean player renders the SAME stream as the page
      write: (s) => {
        try {
          root.setAttribute('data-ko-audio-m', s.muted ? '1' : '0');
          root.setAttribute('data-ko-audio-v', Number(s.volume).toFixed(2));
        } catch {
          /* document tearing down */
        }
      },
    });
    // WHY the page surface ends up silenced, published for the owner's own
    // ko.adlog and for a DOM read: which surface the authority believes is
    // VISIBLE, and what it wants the main Twitch element to be. Owner report
    // 2026-11-11: "quando o anuncio acaba e o player volta pro da twitch, fica
    // mutado. o player diz que nao ta mutado, mas ta mutado" — an element muted
    // by the derived state while the UI mirrors the INTENT is exactly this pair
    // disagreeing, and nothing in the log said which one.
    let whySig = '';
    const publishWhy = () => {
      try {
        const vis = String(audio.visible() || '');
        const wt = audio.wanted('twitch').muted ? '1' : '0';
        const it = audio.intent('twitch').muted ? '1' : '0';
        root.setAttribute('data-ko-audio-vis', vis);
        root.setAttribute('data-ko-audio-wt', wt);
        root.setAttribute('data-ko-audio-it', it);
        // A transition, not a tick: the owner's pod reports need the moment the
        // page surface changes hands, with the element's own state beside the
        // derived one. "UI says unmuted, the element is muted" is one line here.
        const els = [...document.querySelectorAll('video')];
        const main = els.find((v) => v.videoWidth > 0 || !v.paused) || els[0];
        const el = main ? (main.muted ? '1' : '0') + '|' + Number(main.volume).toFixed(2) : '';
        // The census beside the state: "the element is unmuted and the picture
        // plays, yet there is no sound" is only answerable with how many media
        // elements are audible and how many frames the ad path still has up.
        const audible = els.filter((v) => !v.muted && v.volume > 0.02).length;
        const playing = els.filter((v) => !v.paused).length;
        const sig = vis + '|' + wt + '|' + it + '|' + el + '|' + audible + '|' + playing;
        if (sig === whySig) return;
        whySig = sig;
        persist({ ev: 'audio-state', d: { vis, wt, it, el, audible, playing } });
      } catch {
        /* document tearing down */
      }
    };
    audio.onChange(publishWhy);
    publishWhy();
    document.addEventListener(
      'ko-audio-claim',
      (ev) => {
        const v = String((ev && ev.detail) || '');
        audio.claim(v === 'ad' ? 'ad' : null);
      },
      true,
    );
    document.addEventListener(
      'ko-audio-intent',
      (ev) => {
        try {
          const d = JSON.parse(String(ev && ev.detail));
          const target = audio.visible() || 'twitch';
          // `Number(null)` IS `0`: a JSON intent with `volume:null` used to be
          // written as a real, permanent volume-0 intent. Only a JSON number
          // is a level; anything else is refused by name, not coerced.
          const vol = d && typeof d.volume === 'number' && Number.isFinite(d.volume) ? d.volume : undefined;
          if (d && 'volume' in d && vol === undefined) {
            persist({ ev: 'audio-refused', d: { why: 'invalid-intent-volume', surface: target, received: String(d.volume), origin: 'code:adpath' } });
          }
          audio.setIntent(
            target,
            {
              muted: typeof d.muted === 'boolean' ? d.muted : undefined,
              volume: vol,
            },
            { persist: true, origin: 'code:adpath' },
          );
        } catch {
          /* malformed intent */
        }
      },
      true,
    );
    // The arbiter echoes the policy it ACCEPTED, naming the author and frame
    // it actually took. A refused frame-policy ask writes an audio-refused
    // row and NO echo, so the MAIN world can never read an attribute that
    // claims a policy the authority refused.
    document.addEventListener(
      'ko-audio-policy',
      (ev) => {
        try {
          const d = JSON.parse(String(ev && ev.detail));
          root.setAttribute('data-ko-audio-policy', d && d.on === true ? String(d.author || '') : '');
        } catch {
          /* malformed echo */
        }
      },
      true,
    );
    // The MAIN-world ad path cannot call the arbiter. It asks for a FRAME
    // policy here, naming its author and the frame that was actually refused.
    // An ask with no author or no frame is a machine write, refused out loud.
    document.addEventListener(
      'ko-audio-frame-policy',
      (ev) => {
        try {
          const d = JSON.parse(String(ev && ev.detail));
          const author = String((d && d.author) || '');
          const frame = String((d && d.frame) || '');
          if (!author.startsWith('ad:') || !frame) {
            persist({ ev: 'audio-refused', d: { why: 'unlabelled-frame-policy', author, frame, surface: 'ad' } });
            return;
          }
          audio.setPolicy('ad', d.on === true, { origin: author, why: String(d.why || ''), frame });
        } catch {
          persist({ ev: 'audio-refused', d: { why: 'malformed-frame-policy', surface: 'ad' } });
        }
      },
      true,
    );
    audio.apply();
  };
  try {
    attachAudioBridge();
  } catch {
    /* document may be unavailable very early */
  }

  const apply = (state) => {
    const on = !state || state.adblock !== false;
    const root = document.documentElement;
    if (!root) {
      document.addEventListener('DOMContentLoaded', () => apply(state), { once: true });
      return;
    }
    try {
      root.setAttribute('data-ko-adblock', on ? '1' : '0');
      // MAIN-world ad code needs the extension origin for the clean-stream
      // player iframe, and cannot call chrome.runtime.getURL itself.
      root.setAttribute('data-ko-ext-id', chrome.runtime.id);
    } catch {
      /* document may be tearing down */
    }
    if (!booted) {
      booted = true;
      persist({
        ev: 'boot',
        d: {
          href: location.href,
          adblock: on,
          ext: (() => {
            try {
              return chrome.runtime.id;
            } catch {
              return null;
            }
          })(),
          version: (() => {
            try {
              return chrome.runtime.getManifest().version;
            } catch {
              return null;
            }
          })(),
          ua: String(navigator.userAgent || '').slice(0, 140),
        },
      });
    }
  };

  try {
    chrome.storage.local.get(KEY, (o) => {
      void chrome.runtime.lastError;
      apply(o && o[KEY]);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const value = changes[KEY].newValue;
      apply(value);
      persist({
        ev: 'adblock-change',
        d: { adblock: !value || value.adblock !== false },
      });
    });
  } catch {
    apply(null); // storage unavailable — keep the default ON
  }

  try {
    document.addEventListener('visibilitychange', () => {
      persist({ ev: 'visibility', d: { state: document.visibilityState } });
      if (document.visibilityState === 'hidden') flushNow();
    });
    window.addEventListener('pagehide', () => {
      persist({ ev: 'pagehide', d: { href: location.href } });
      flushNow();
    });
  } catch {
    /* optional */
  }
})();
