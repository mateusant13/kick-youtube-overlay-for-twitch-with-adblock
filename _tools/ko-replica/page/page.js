// page.js — the replica watch page's own boot.
//
// Mimics the sequence Twitch's page performs: mint a PlaybackAccessToken over
// GQL, resolve the usher master, then let the PLAYER WORKER fetch the media
// playlist. The worker is created from a blob URL so the extension's Worker
// hook applies, and the native <video> is driven by the MediaSourceHandle the
// worker transfers back.
//
// The extension's page-world token rewriter changes playerType to popout
// before the request leaves, which is exactly the live behaviour; the replica
// decides ad-bearing from the token it receives, not from a page variable.
(function () {
  'use strict';

  const CHANNEL = (location.pathname.split('/').filter(Boolean)[0] || 'replicach').toLowerCase();
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const GQL_URL = 'https://gql.twitch.tv/gql';
  const video = document.getElementById('ko-replica-video');
  const player = document.querySelector('[data-a-target="video-player"]');
  const wrap = document.querySelector('.stream-display-ad__wrapper');
  const inner = wrap.querySelector('.stream-display-ad__inner');
  const container = document.querySelector('.video-player__container');
  const ref = document.querySelector('.video-ref');
  const stats = { handleAt: 0, firstPlayAt: 0, errors: [], textures: [] };
  window.__koReplica = stats;

  function adtext() {
    let el = document.getElementById('ko-replica-adtext');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ko-replica-adtext';
      el.className = 'ko-replica-adtext';
      player.appendChild(el);
    }
    return el;
  }

  function setWrapper(on, squeeze) {
    if (!wrap) return;
    if (!on) {
      wrap.classList.add('stream-display-ad__wrapper-hidden');
      inner.style.width = '0px';
      inner.style.height = '0px';
      return;
    }
    wrap.classList.remove('stream-display-ad__wrapper-hidden');
    const pr = player.getBoundingClientRect();
    inner.style.width = `${Math.round(pr.width)}px`;
    inner.style.height = `${Math.round(squeeze ? pr.height * 0.18 : pr.height)}px`;
  }

  function applyState(s) {
    stats.state = s;
    // A painted wrapper is a full hold; a banner squeeze is a different shape
    // and gets its own branch so adSurfaceRect() sees a wide shallow node.
    if (s.ui === 'wrapper' || s.ui === 'squeeze') setWrapper(true, s.ui === 'squeeze');
    else setWrapper(false, false);

    if (s.ui === 'countdown' || s.ui === 'slate' || s.ui === 'aria') {
      const el = adtext();
      el.textContent = s.label || 'Anúncio (0:15)';
      el.style.visibility = 'visible';
      if (s.ui === 'aria') {
        el.setAttribute('aria-label', s.label || 'Anúncio (0:15)');
        el.textContent = '';
      } else {
        el.removeAttribute('aria-label');
      }
    } else {
      const el = document.getElementById('ko-replica-adtext');
      if (el) el.style.visibility = 'hidden';
    }

    if (typeof s.nativeMuted === 'boolean' && video.muted !== s.nativeMuted) {
      video.muted = s.nativeMuted;
    }
  }

  async function pollState() {
    try {
      const r = await fetch('/__ko/state', { signal: AbortSignal.timeout(3000), cache: 'no-store' });
      applyState(await r.json());
    } catch (e) {
      stats.errors.push(`state: ${String(e)}`);
    }
    setTimeout(pollState, 300);
  }

  async function boot() {
    const body = {
      operationName: 'PlaybackAccessToken',
      variables: { isLive: true, login: CHANNEL, isVod: false, vodID: '', playerType: 'site', platform: 'web' },
      extensions: { persistedQuery: { version: 1, sha256Hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9' } },
    };
    const gql = await fetch(GQL_URL, {
      signal: AbortSignal.timeout(8000),
      method: 'POST',
      headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const tok = gql && gql.data && gql.data.streamPlaybackAccessToken;
    if (!tok) throw new Error('no playback token');

    const masterUrl = new URL(`https://usher.ttvnw.net/api/v2/channel/hls/${encodeURIComponent(CHANNEL)}.m3u8`);
    masterUrl.searchParams.set('sig', tok.signature);
    masterUrl.searchParams.set('token', tok.value);
    masterUrl.searchParams.set('allow_source', 'true');
    masterUrl.searchParams.set('player', 'twitchweb');
    masterUrl.searchParams.set('type', 'any');

    const master = await fetch(masterUrl, { signal: AbortSignal.timeout(8000), credentials: 'omit' }).then((r) => r.text());
    const lines = master.replace(/\r/g, '').split('\n');
    let variant = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (!line) continue;
        if (!line.startsWith('#')) { variant = line; break; }
      }
      if (variant) break;
    }
    if (!variant) throw new Error('no variant in master');
    const mediaUrl = new URL(variant, masterUrl).toString();

    const workerSrc = await fetch('/__ko/player-worker.js', { signal: AbortSignal.timeout(5000), cache: 'no-store' }).then((r) => r.text());
    const blob = new Blob([workerSrc], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    stats.workerUrl = url;

    worker.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'handle') {
        stats.handleAt = Math.round(performance.now());
        try {
          video.srcObject = d.handle;
          video.play().then(() => { stats.firstPlayAt = Math.round(performance.now()); }).catch((e) => {
            stats.errors.push(`play: ${String(e)}`);
          });
        } catch (e) {
          stats.errors.push(`srcObject: ${String(e)}`);
        }
      } else if (d.type === 'error') {
        stats.errors.push(d.error);
      } else if (d.type === 'tick') {
        stats.appended = d.appended;
        stats.ct = d.ct;
      }
    };
    worker.postMessage({ type: 'start', mediaUrl });
    stats.mediaUrl = mediaUrl;
  }

  pollState();
  boot().catch((e) => {
    stats.errors.push(`boot: ${String(e)}`);
    const el = adtext();
    el.textContent = `replica boot failed: ${String(e)}`;
    el.style.visibility = 'visible';
  });
})();
