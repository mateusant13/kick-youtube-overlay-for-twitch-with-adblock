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
  const LOG_MAX = 500;
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

  const persist = (ev) => {
    const rec = Object.assign({ t: Date.now(), sid }, ev);
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
          audio.setIntent(
            target,
            {
              muted: typeof d.muted === 'boolean' ? d.muted : undefined,
              volume: Number.isFinite(Number(d.volume)) ? Number(d.volume) : undefined,
            },
            { persist: true },
          );
        } catch {
          /* malformed intent */
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
      root.setAttribute('data-ko-adlog-sid', sid);
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
