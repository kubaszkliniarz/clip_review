// Clip Review — front-end behavior, wired to real Twitch + Kick providers.
//
// Architecture in one paragraph: a single advance scheduler owns the timer
// that moves to the next clip. Each provider's player wires its play / pause /
// ended events to the scheduler so pausing actually pauses the queue. Twitch
// uses the Twitch.Player JS SDK (loaded lazily) to expose those events;
// Kick uses a native <video> tag (HLS via lazy-loaded hls.js).

import { parseStreamer } from "./providers/parse.js";
import * as twitch from "./providers/twitch.js";
import * as kick from "./providers/kick.js";

// ============================================================================
// Constants
// ============================================================================

const HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
const TWITCH_EMBED_CDN = "https://player.twitch.tv/js/embed/v1.js";
const QUEUE_SCROLL_STEP_PX = 360;
const DRAG_THRESHOLD_PX = 5;
const DEFAULT_BREAK_SEC = 3;
const FALLBACK_DURATION_SEC = 30;

// ============================================================================
// DOM refs
// ============================================================================

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  form: $("streamer-form"),
  queue: $("queue"),
  queueCount: $("queue-count"),
  player: $("player"),
  playerMeta: $("player-meta"),
  playerTitle: $("player-title-text"),
  playerViews: $("player-views"),
  btnPrev: $("btn-prev"),
  btnSkip: $("btn-skip"),
  btnNext: $("btn-next"),
  btnRefresh: $("btn-refresh"),
  btnQPrev: $("btn-queue-prev"),
  btnQNext: $("btn-queue-next"),
  btnTheatre: $("btn-theatre"),
  btnAutoAdvance: $("btn-autoadvance"),
  breakSlider: $("break"),
  breakReadout: $("break-readout"),
};
els.submitBtn = els.form.querySelector("button[type='submit']");

// ============================================================================
// State
// ============================================================================

/**
 * @typedef {{
 *   provider: "twitch"|"kick",
 *   id: string,
 *   title: string,
 *   viewCount: number,
 *   durationSec: number,
 *   thumbnailUrl: string,
 *   embedUrl: string,
 *   videoUrl?: string,
 *   url: string,
 *   broadcasterName: string,
 *   createdAt: string,
 * }} Clip
 */

/** @type {Clip[]} */
let clips = [];
let activeIdx = -1;
const played = new Set();
let autoAdvanceOn = true;

// Advance state — one timer at a time, plus a closure to recompute it from
// the current player when we need to (e.g. break-slider change, toggle on).
let advanceTimer = null;
let activeRescheduler = null;

// Async-load state for the two embed SDKs and HLS instance.
let hlsLoaderPromise = null;
let twitchLoaderPromise = null;
let activeHls = null;
let renderGen = 0; // monotonic — abandons stale async work after re-renders

// ============================================================================
// Utilities
// ============================================================================

const setStatus = (msg) => {
  els.status.textContent = msg;
};

const fmtViews = (n) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

const timeAgo = (iso) => {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
};

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const breakSec = () => parseInt(els.breakSlider.value, 10) || DEFAULT_BREAK_SEC;

// ============================================================================
// Lazy CDN loaders (hls.js, twitch embed SDK)
// ============================================================================

const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });

async function ensureHls() {
  if (window.Hls) return window.Hls;
  if (!hlsLoaderPromise) hlsLoaderPromise = loadScript(HLS_CDN).then(() => window.Hls);
  return hlsLoaderPromise;
}

async function ensureTwitchEmbed() {
  if (window.Twitch && window.Twitch.Player) return window.Twitch;
  if (!twitchLoaderPromise) twitchLoaderPromise = loadScript(TWITCH_EMBED_CDN).then(() => window.Twitch);
  return twitchLoaderPromise;
}

function destroyActiveHls() {
  if (activeHls) {
    try {
      activeHls.destroy();
    } catch {
      /* ignore */
    }
    activeHls = null;
  }
}

// ============================================================================
// Advance scheduling
// ============================================================================
// One timer at a time. Players call scheduleAdvanceIn(ms) when they start
// playing (computed from remaining time + break) and cancelAdvance() on pause.
// On natural end, scheduleAdvanceIn(breakMs) since we want to wait the break
// before moving on.

function cancelAdvance() {
  if (advanceTimer) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

function scheduleAdvanceIn(ms) {
  cancelAdvance();
  if (!autoAdvanceOn) return;
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    if (activeIdx < clips.length - 1) goTo(activeIdx + 1);
    else setStatus("End of queue.");
  }, Math.max(0, ms));
}

// ============================================================================
// Per-provider player setup
// ============================================================================

function setupKickPlayer(c, gen) {
  const video = document.createElement("video");
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "auto";
  if (c.thumbnailUrl) video.poster = c.thumbnailUrl;
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;";

  // Reschedule based on the video's actual remaining time. Pausing cancels;
  // resuming picks up where we left off; ended waits just the break.
  const reschedule = () => {
    if (gen !== renderGen) return;
    if (video.paused || video.ended) {
      cancelAdvance();
      return;
    }
    const dur = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : c.durationSec || FALLBACK_DURATION_SEC;
    const remaining = Math.max(0, dur - (video.currentTime || 0));
    scheduleAdvanceIn(remaining * 1000 + breakSec() * 1000);
  };
  activeRescheduler = reschedule;

  video.addEventListener("playing", reschedule);
  video.addEventListener("seeked", reschedule);
  video.addEventListener("ratechange", reschedule);
  video.addEventListener("pause", cancelAdvance);
  video.addEventListener("ended", () => scheduleAdvanceIn(breakSec() * 1000));

  const isHls = /\.m3u8(\?|$)/i.test(c.videoUrl);
  if (isHls) {
    // Always try hls.js first. Chrome reports canPlayType("…apple.mpegurl")
    // as "maybe" but cannot actually play HLS — only iOS Safari can.
    ensureHls()
      .then((Hls) => {
        if (gen !== renderGen) return;
        if (Hls && Hls.isSupported()) {
          const hls = new Hls({ debug: false });
          hls.loadSource(c.videoUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (gen !== renderGen) return;
            if (data.fatal) {
              console.warn("[kick] fatal HLS error", data.type, data.details);
              renderKickFallback(c);
            }
          });
          if (gen === renderGen) activeHls = hls;
          else hls.destroy();
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = c.videoUrl;
          video.addEventListener("error", () => renderKickFallback(c));
        } else {
          renderKickFallback(c);
        }
      })
      .catch((err) => {
        console.warn("[kick] hls.js load failed", err);
        if (gen === renderGen) renderKickFallback(c);
      });
  } else {
    video.src = c.videoUrl;
    video.addEventListener("error", () => renderKickFallback(c));
  }

  return video;
}

function setupTwitchPlayer(c, gen) {
  // Use the Twitch.Player SDK (loaded lazily) so we get real PLAYING / PAUSE
  // / ENDED events. Falls back to a plain <iframe> + duration timer if the
  // SDK fails to load — pause detection is lost in that case but playback
  // still works.
  const host = document.createElement("div");
  host.id = `twitch-host-${gen}-${Math.random().toString(36).slice(2, 8)}`;
  host.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";

  ensureTwitchEmbed()
    .then((Twitch) => {
      if (gen !== renderGen) return;
      const tp = new Twitch.Player(host.id, {
        clip: c.id,
        parent: [window.location.hostname || "localhost"],
        autoplay: true,
        muted: false,
      });
      const reschedule = () => {
        if (gen !== renderGen) return;
        const dur = (typeof tp.getDuration === "function" && tp.getDuration()) || c.durationSec || FALLBACK_DURATION_SEC;
        const cur = (typeof tp.getCurrentTime === "function" && tp.getCurrentTime()) || 0;
        const remaining = Math.max(0, dur - cur);
        scheduleAdvanceIn(remaining * 1000 + breakSec() * 1000);
      };
      activeRescheduler = reschedule;
      tp.addEventListener(Twitch.Player.PLAYING, reschedule);
      tp.addEventListener(Twitch.Player.PAUSE, cancelAdvance);
      tp.addEventListener(Twitch.Player.ENDED, () => scheduleAdvanceIn(breakSec() * 1000));
    })
    .catch((err) => {
      console.warn("[twitch] embed SDK load failed, falling back to plain iframe", err);
      if (gen !== renderGen) return;
      host.innerHTML = "";
      const frame = document.createElement("iframe");
      frame.src = c.embedUrl;
      frame.allow = "autoplay; fullscreen; clipboard-write; encrypted-media";
      frame.allowFullscreen = true;
      frame.referrerPolicy = "origin";
      frame.title = c.title || "clip";
      frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;";
      host.appendChild(frame);
      // No pause detection without the SDK — fall back to duration timer.
      activeRescheduler = () => {
        scheduleAdvanceIn((c.durationSec + breakSec()) * 1000);
      };
      activeRescheduler();
    });

  return host;
}

// ============================================================================
// Rendering
// ============================================================================

const renderQueue = () => {
  if (!clips.length) {
    els.queue.innerHTML = `<li class="queue-strip__empty">Queue is empty. Load a streamer to fill it.</li>`;
    els.queueCount.textContent = "0 clips";
    return;
  }
  els.queueCount.textContent = `${clips.length} clips`;
  const html = clips
    .map((c, i) => {
      const cls = [
        "queue-tile",
        i === activeIdx ? "is-active" : "",
        played.has(i) ? "is-played" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const thumb = c.thumbnailUrl
        ? `<img class="queue-tile__thumb-img" src="${escapeHtml(c.thumbnailUrl)}" alt="" loading="lazy" />`
        : `<span aria-hidden="true">${i + 1}</span>`;
      const age = timeAgo(c.createdAt);
      const meta = age ? `${fmtViews(c.viewCount)} views · ${age}` : `${fmtViews(c.viewCount)} views`;
      return `
        <li class="${cls}" data-idx="${i}">
          <div class="queue-tile__thumb">
            <span class="queue-tile__index">#${i + 1}</span>
            ${thumb}
          </div>
          <div class="queue-tile__body">
            <p class="queue-tile__title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</p>
            <span class="queue-tile__views">${meta}</span>
          </div>
        </li>
      `;
    })
    .join("");
  els.queue.innerHTML = html;
};

const renderPlayer = () => {
  cancelAdvance();
  destroyActiveHls();
  activeRescheduler = null;

  if (activeIdx < 0 || !clips[activeIdx]) {
    els.player.innerHTML = `
      <div class="player__placeholder">
        <p>No clip loaded.</p>
        <p class="player__hint">Pick a provider, type a streamer, hit Load clips.</p>
      </div>`;
    els.playerMeta.hidden = true;
    [els.btnPrev, els.btnSkip, els.btnNext, els.btnRefresh].forEach((b) => (b.disabled = true));
    return;
  }

  const c = clips[activeIdx];
  const gen = ++renderGen;
  els.player.innerHTML = "";

  if (c.provider === "kick") {
    if (!c.videoUrl) {
      renderKickFallback(c);
    } else {
      els.player.appendChild(setupKickPlayer(c, gen));
    }
  } else {
    els.player.appendChild(setupTwitchPlayer(c, gen));
  }

  // Meta line.
  els.playerMeta.hidden = false;
  els.playerTitle.textContent = c.title;
  const age = timeAgo(c.createdAt);
  els.playerViews.textContent = age
    ? `${fmtViews(c.viewCount)} views · ${age}`
    : `${fmtViews(c.viewCount)} views`;

  els.btnPrev.disabled = activeIdx <= 0;
  els.btnNext.disabled = activeIdx >= clips.length - 1;
  els.btnSkip.disabled = false;
  els.btnRefresh.disabled = false;
};

const renderKickFallback = (c) => {
  els.player.innerHTML = "";
  const fallback = document.createElement("div");
  fallback.className = "player__fallback";
  fallback.innerHTML = `
    ${c.thumbnailUrl ? `<img src="${escapeHtml(c.thumbnailUrl)}" alt="" class="player__fallback-thumb" />` : ""}
    <div class="player__fallback-overlay">
      <p class="player__fallback-title">${escapeHtml(c.title || "untitled clip")}</p>
      <p class="player__fallback-msg">
        Kick's CDN refused to serve this clip directly to the browser.
        Auto-advance still works; tap below to watch on Kick.
      </p>
      <a class="button button--primary" target="_blank" rel="noopener" href="${escapeHtml(c.url)}">
        Open on Kick ↗
      </a>
    </div>`;
  els.player.appendChild(fallback);
  // Without playback events we fall back to the duration timer.
  activeRescheduler = () => scheduleAdvanceIn((c.durationSec + breakSec()) * 1000);
  activeRescheduler();
};

const renderError = (title, hint) => {
  cancelAdvance();
  els.player.innerHTML = `
    <div class="player__placeholder player__placeholder--error">
      <p class="player__error-title">${escapeHtml(title)}</p>
      ${hint ? `<p class="player__hint">${escapeHtml(hint)}</p>` : ""}
    </div>`;
  els.playerMeta.hidden = true;
  [els.btnPrev, els.btnSkip, els.btnNext, els.btnRefresh].forEach((b) => (b.disabled = true));
};

const scrollQueueToActive = () => {
  const tile = els.queue.querySelector(`.queue-tile[data-idx="${activeIdx}"]`);
  if (!tile) return;
  const stripRect = els.queue.getBoundingClientRect();
  const tileRect = tile.getBoundingClientRect();
  const target =
    els.queue.scrollLeft +
    (tileRect.left - stripRect.left) -
    stripRect.width / 2 +
    tileRect.width / 2;
  els.queue.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
};

// ============================================================================
// Navigation
// ============================================================================

function goTo(idx) {
  if (idx < 0 || idx >= clips.length) return;
  if (activeIdx >= 0) played.add(activeIdx);
  activeIdx = idx;
  renderQueue();
  renderPlayer();
  scrollQueueToActive();
  setStatus(`Playing clip ${idx + 1} of ${clips.length} — ${clips[idx].title}`);
}

const next = () => goTo(activeIdx + 1);
const prev = () => goTo(activeIdx - 1);
const refresh = () => {
  if (activeIdx < 0) return;
  setStatus(`Reloading clip ${activeIdx + 1}…`);
  renderPlayer();
};

// ============================================================================
// Event wiring
// ============================================================================

els.btnPrev.addEventListener("click", prev);
els.btnNext.addEventListener("click", next);
els.btnSkip.addEventListener("click", next);
els.btnRefresh.addEventListener("click", refresh);

els.btnQPrev.addEventListener("click", () => {
  els.queue.scrollBy({ left: -QUEUE_SCROLL_STEP_PX, behavior: "smooth" });
});
els.btnQNext.addEventListener("click", () => {
  els.queue.scrollBy({ left: QUEUE_SCROLL_STEP_PX, behavior: "smooth" });
});

// Click-to-jump on tiles (suppressed if we just dragged).
let suppressClick = false;
els.queue.addEventListener("click", (e) => {
  if (suppressClick) return;
  const tile = e.target.closest(".queue-tile");
  if (!tile) return;
  const idx = Number(tile.dataset.idx);
  if (Number.isFinite(idx)) goTo(idx);
});

// ---------- Drag-to-scroll ----------
// Capture only when actual drag movement happens — a plain click never
// engages pointer capture, so the click handler above always fires for taps.
let dragState = null;
els.queue.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragState = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startScroll: els.queue.scrollLeft,
    captured: false,
    moved: false,
  };
});
els.queue.addEventListener("pointermove", (e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const dx = e.clientX - dragState.startX;
  if (!dragState.captured && Math.abs(dx) >= DRAG_THRESHOLD_PX) {
    dragState.captured = true;
    dragState.moved = true;
    try {
      els.queue.setPointerCapture(e.pointerId);
    } catch {
      /* not all browsers / element types */
    }
    els.queue.classList.add("is-dragging");
  }
  if (dragState.captured) {
    els.queue.scrollLeft = dragState.startScroll - dx;
  }
});
const endDrag = (e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const wasDrag = dragState.moved;
  if (dragState.captured) {
    els.queue.classList.remove("is-dragging");
    try {
      els.queue.releasePointerCapture(dragState.pointerId);
    } catch {
      /* already released */
    }
  }
  dragState = null;
  if (wasDrag) {
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  }
};
els.queue.addEventListener("pointerup", endDrag);
els.queue.addEventListener("pointercancel", endDrag);

// ---------- Theatre toggle ----------
els.btnTheatre.addEventListener("click", () => {
  const on = !document.body.classList.contains("is-theatre");
  document.body.classList.toggle("is-theatre", on);
  els.btnTheatre.setAttribute("aria-pressed", String(on));
  setStatus(on ? "Theatre mode on. Queue hidden — use Prev/Skip/Next." : "Theatre mode off.");
});

// ---------- Auto-advance toggle ----------
const refreshAutoAdvanceLabel = () => {
  els.btnAutoAdvance.textContent = autoAdvanceOn ? "Auto: ON" : "Auto: OFF";
  els.btnAutoAdvance.setAttribute("aria-pressed", String(autoAdvanceOn));
};
els.btnAutoAdvance.addEventListener("click", () => {
  autoAdvanceOn = !autoAdvanceOn;
  refreshAutoAdvanceLabel();
  if (!autoAdvanceOn) {
    cancelAdvance();
    setStatus("Auto-advance off. Use Prev/Skip/Next manually.");
  } else {
    setStatus("Auto-advance on.");
    if (activeRescheduler) activeRescheduler();
  }
});
refreshAutoAdvanceLabel();

// ---------- Break slider ----------
els.breakSlider.addEventListener("input", () => {
  els.breakReadout.textContent = `${els.breakSlider.value}s`;
  if (activeRescheduler) activeRescheduler();
});

// ---------- Form submit ----------
els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(els.form);
  const raw = String(data.get("streamer") || "").trim();
  const win = String(data.get("window") || "week");
  const count = Number(data.get("count") || 50);
  const chosenProvider = String(data.get("provider") || "twitch");
  if (!raw) return;

  let ref;
  try {
    ref = parseStreamer(raw, chosenProvider);
  } catch (err) {
    setStatus(`Could not parse streamer: ${err.message}`);
    return;
  }

  els.submitBtn.disabled = true;
  setStatus(`Loading ${ref.provider} clips for ${ref.login} (${win})…`);
  cancelAdvance();
  clips = [];
  played.clear();
  activeIdx = -1;
  renderQueue();
  renderPlayer();

  try {
    const provider = ref.provider === "kick" ? kick : twitch;
    const fetched = await provider.getTopClips(ref.login, win, count);
    clips = fetched;
    if (!clips.length) {
      const msg = `No clips found for ${ref.provider}/${ref.login} in the last ${win}.`;
      setStatus(msg);
      renderError(msg, "Try a different window or check the spelling.");
      return;
    }
    activeIdx = 0;
    renderQueue();
    renderPlayer();
    els.queue.scrollLeft = 0;
    const summary =
      clips.length < count
        ? `Loaded ${clips.length} clips (provider returned fewer than ${count} requested).`
        : `Loaded ${clips.length} clips.`;
    setStatus(`${summary} Playing #1 — ${clips[0].title}`);
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
    if (/twitch_token\.json/i.test(err.message) || /No Twitch token bundled/i.test(err.message)) {
      renderError(
        "Twitch token missing.",
        "The site needs web/twitch_token.json. In CI it's minted from secrets; for local dev, run: " +
          "TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... .venv/bin/python -m " +
          "clip_review.scripts.mint_twitch_token web/twitch_token.json"
      );
    } else if (ref.provider === "kick") {
      renderError(
        "Kick request blocked.",
        "Kick's CDN often blocks browser fetches from third-party origins. " +
          "This is a Kick-side restriction — there's no fix without a backend proxy."
      );
    } else {
      renderError(`Failed: ${err.message}`, "");
    }
  } finally {
    els.submitBtn.disabled = false;
  }
});

// ============================================================================
// Init
// ============================================================================

renderQueue();
setStatus("Ready. Type a streamer (e.g. twitch.tv/forsen) and press Load clips.");
