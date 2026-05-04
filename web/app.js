// Clip Review — front-end behavior, wired to real Twitch + Kick providers.

import { parseStreamer } from "./providers/parse.js";
import * as twitch from "./providers/twitch.js";
import * as kick from "./providers/kick.js";

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const status = $("status");
const form = $("streamer-form");
const queueEl = $("queue");
const queueCount = $("queue-count");
const player = $("player");
const playerMeta = $("player-meta");
const playerTitle = $("player-title-text");
const playerViews = $("player-views");
const btnPrev = $("btn-prev");
const btnSkip = $("btn-skip");
const btnNext = $("btn-next");
const btnRefresh = $("btn-refresh");
const btnQPrev = $("btn-queue-prev");
const btnQNext = $("btn-queue-next");
const btnTheatre = $("btn-theatre");
const breakSlider = $("break");
const breakReadout = $("break-readout");
const submitBtn = form.querySelector("button[type='submit']");

// ---------- State ----------
/** @type {Array<{provider:string,id:string,title:string,viewCount:number,durationSec:number,thumbnailUrl:string,embedUrl:string,videoUrl?:string,url:string,broadcasterName:string,createdAt:string,_raw?:object}>} */
let clips = [];
let activeIdx = -1;
const played = new Set();
let advanceTimer = null;
let activeHls = null;
let renderGen = 0; // monotonic — abandons stale async work after re-renders
let hlsLoaderPromise = null;

const HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";

async function ensureHls() {
  if (window.Hls) return window.Hls;
  if (!hlsLoaderPromise) {
    hlsLoaderPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = HLS_CDN;
      s.onload = () => resolve(window.Hls);
      s.onerror = () => reject(new Error(`failed to load hls.js from ${HLS_CDN}`));
      document.head.appendChild(s);
    });
  }
  return hlsLoaderPromise;
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

// ---------- Helpers ----------
const setStatus = (msg) => {
  status.textContent = msg;
};

const fmtViews = (n) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

const cancelAdvance = () => {
  if (advanceTimer) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
};

// ---------- Rendering ----------
const renderQueue = () => {
  if (!clips.length) {
    queueEl.innerHTML = `<li class="queue-strip__empty">Queue is empty. Load a streamer to fill it.</li>`;
    queueCount.textContent = "0 clips";
    return;
  }
  queueCount.textContent = `${clips.length} clips`;
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
      return `
        <li class="${cls}" data-idx="${i}">
          <div class="queue-tile__thumb">
            <span class="queue-tile__index">#${i + 1}</span>
            ${thumb}
          </div>
          <div class="queue-tile__body">
            <p class="queue-tile__title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</p>
            <span class="queue-tile__views">${fmtViews(c.viewCount)} views</span>
          </div>
        </li>
      `;
    })
    .join("");
  queueEl.innerHTML = html;
};

const renderPlayer = () => {
  cancelAdvance();
  destroyActiveHls();
  if (activeIdx < 0 || !clips[activeIdx]) {
    player.innerHTML = `
      <div class="player__placeholder">
        <p>No clip loaded.</p>
        <p class="player__hint">Pick a provider, type a streamer, hit Load clips.</p>
      </div>`;
    playerMeta.hidden = true;
    [btnPrev, btnSkip, btnNext, btnRefresh].forEach((b) => (b.disabled = true));
    return;
  }
  const c = clips[activeIdx];
  player.innerHTML = "";

  if (c.provider === "kick") {
    if (c.videoUrl) {
      const gen = ++renderGen;
      const video = document.createElement("video");
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = "auto";
      if (c.thumbnailUrl) video.poster = c.thumbnailUrl;
      video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;";

      const onEnded = () => {
        cancelAdvance();
        const breakSec = parseInt(breakSlider.value, 10) || 3;
        advanceTimer = setTimeout(() => {
          if (activeIdx < clips.length - 1) goTo(activeIdx + 1);
          else setStatus("End of queue.");
        }, breakSec * 1000);
      };
      video.addEventListener("ended", onEnded);

      const isHls = /\.m3u8(\?|$)/i.test(c.videoUrl);
      const nativeHls = video.canPlayType("application/vnd.apple.mpegurl");

      if (isHls && !nativeHls) {
        // Chrome/Firefox — need hls.js. Load lazily, then attach.
        ensureHls()
          .then((Hls) => {
            if (gen !== renderGen) return; // user navigated away
            if (!Hls || !Hls.isSupported()) {
              renderKickFallback(c);
              return;
            }
            const hls = new Hls();
            hls.loadSource(c.videoUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_evt, data) => {
              if (gen !== renderGen) return;
              if (data.fatal) renderKickFallback(c);
            });
            if (gen === renderGen) {
              activeHls = hls;
            } else {
              hls.destroy();
            }
          })
          .catch(() => {
            if (gen === renderGen) renderKickFallback(c);
          });
      } else {
        // Safari (native HLS) or a non-HLS URL.
        video.src = c.videoUrl;
        video.addEventListener("error", () => renderKickFallback(c));
      }

      player.appendChild(video);
    } else {
      renderKickFallback(c);
    }
  } else {
    // Twitch — real iframe embed.
    const frame = document.createElement("iframe");
    frame.src = c.embedUrl;
    frame.allow = "autoplay; fullscreen; clipboard-write; encrypted-media";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "origin";
    frame.title = c.title || "clip";
    player.appendChild(frame);
  }

  playerMeta.hidden = false;
  playerTitle.textContent = c.title;
  playerViews.textContent = `${fmtViews(c.viewCount)} views`;
  btnPrev.disabled = activeIdx <= 0;
  btnNext.disabled = activeIdx >= clips.length - 1;
  btnSkip.disabled = false;
  btnRefresh.disabled = false;

  scheduleAdvance();
};

const renderKickFallback = (c) => {
  player.innerHTML = "";
  const fallback = document.createElement("div");
  fallback.className = "player__fallback";
  fallback.innerHTML = `
    ${
      c.thumbnailUrl
        ? `<img src="${escapeHtml(c.thumbnailUrl)}" alt="" class="player__fallback-thumb" />`
        : ""
    }
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
  player.appendChild(fallback);
};

const renderError = (title, hint) => {
  cancelAdvance();
  player.innerHTML = `
    <div class="player__placeholder player__placeholder--error">
      <p class="player__error-title">${escapeHtml(title)}</p>
      ${hint ? `<p class="player__hint">${escapeHtml(hint)}</p>` : ""}
    </div>`;
  playerMeta.hidden = true;
  [btnPrev, btnSkip, btnNext, btnRefresh].forEach((b) => (b.disabled = true));
};

const scrollQueueToActive = () => {
  const tile = queueEl.querySelector(`.queue-tile[data-idx="${activeIdx}"]`);
  if (!tile) return;
  const stripRect = queueEl.getBoundingClientRect();
  const tileRect = tile.getBoundingClientRect();
  const target =
    queueEl.scrollLeft +
    (tileRect.left - stripRect.left) -
    stripRect.width / 2 +
    tileRect.width / 2;
  queueEl.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
};

// ---------- Auto-advance ----------
const scheduleAdvance = () => {
  cancelAdvance();
  if (activeIdx < 0 || !clips[activeIdx]) return;
  const breakSec = parseInt(breakSlider.value, 10) || 3;
  // Twitch returns clip duration; Kick may not. Default to 30s if missing.
  const clipSec = clips[activeIdx].durationSec || 30;
  const totalMs = (clipSec + breakSec) * 1000;
  advanceTimer = setTimeout(() => {
    if (activeIdx < clips.length - 1) {
      goTo(activeIdx + 1);
    } else {
      setStatus("End of queue.");
    }
  }, totalMs);
};

// ---------- Controls ----------
const goTo = (idx) => {
  if (idx < 0 || idx >= clips.length) return;
  if (activeIdx >= 0) played.add(activeIdx);
  activeIdx = idx;
  renderQueue();
  renderPlayer();
  scrollQueueToActive();
  setStatus(`Playing clip ${idx + 1} of ${clips.length} — ${clips[idx].title}`);
};

const next = () => goTo(activeIdx + 1);
const prev = () => goTo(activeIdx - 1);
const refresh = () => {
  if (activeIdx < 0) return;
  setStatus(`Reloading clip ${activeIdx + 1}…`);
  renderPlayer();
};

btnPrev.addEventListener("click", prev);
btnNext.addEventListener("click", next);
btnSkip.addEventListener("click", next);
btnRefresh.addEventListener("click", refresh);

btnQPrev.addEventListener("click", () => {
  queueEl.scrollBy({ left: -360, behavior: "smooth" });
});
btnQNext.addEventListener("click", () => {
  queueEl.scrollBy({ left: 360, behavior: "smooth" });
});

// Click-to-jump on tiles (suppressed if we just dragged).
let suppressClick = false;
queueEl.addEventListener("click", (e) => {
  if (suppressClick) return;
  const tile = e.target.closest(".queue-tile");
  if (!tile) return;
  const idx = Number(tile.dataset.idx);
  if (Number.isFinite(idx)) goTo(idx);
});

// ---------- Drag-to-scroll ----------
// Capture only when actual drag movement happens — a plain click never
// engages pointer capture, so the click handler above always fires for taps.
const DRAG_THRESHOLD_PX = 5;
let dragState = null;
queueEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragState = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startScroll: queueEl.scrollLeft,
    captured: false,
    moved: false,
  };
});
queueEl.addEventListener("pointermove", (e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const dx = e.clientX - dragState.startX;
  if (!dragState.captured && Math.abs(dx) >= DRAG_THRESHOLD_PX) {
    dragState.captured = true;
    dragState.moved = true;
    try {
      queueEl.setPointerCapture(e.pointerId);
    } catch {
      /* not all browsers / element types */
    }
    queueEl.classList.add("is-dragging");
  }
  if (dragState.captured) {
    queueEl.scrollLeft = dragState.startScroll - dx;
  }
});
const endDrag = (e) => {
  if (!dragState || (e && e.pointerId !== dragState.pointerId)) return;
  const wasDrag = dragState.moved;
  if (dragState.captured) {
    queueEl.classList.remove("is-dragging");
    try {
      queueEl.releasePointerCapture(dragState.pointerId);
    } catch {
      /* already released */
    }
  }
  dragState = null;
  if (wasDrag) {
    suppressClick = true;
    // Reset after the synthesized click event has fired.
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  }
};
queueEl.addEventListener("pointerup", endDrag);
queueEl.addEventListener("pointercancel", endDrag);

// ---------- Theatre toggle ----------
btnTheatre.addEventListener("click", () => {
  const on = !document.body.classList.contains("is-theatre");
  document.body.classList.toggle("is-theatre", on);
  btnTheatre.setAttribute("aria-pressed", String(on));
  setStatus(on ? "Theatre mode on. Queue hidden — use Prev/Skip/Next." : "Theatre mode off.");
});

// ---------- Break slider ----------
breakSlider.addEventListener("input", () => {
  breakReadout.textContent = `${breakSlider.value}s`;
  // Reschedule the current clip's auto-advance with the new break.
  if (advanceTimer) scheduleAdvance();
});

// ---------- Form submit ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const raw = String(data.get("streamer") || "").trim();
  const win = String(data.get("window") || "week");
  const count = Number(data.get("count") || 50);
  const chosenProvider = String(data.get("provider") || "twitch");
  if (!raw) return;

  // Use the radio's value as the fallback when the input is a bare login.
  // A pasted URL like twitch.tv/foo still wins over the radio.
  let ref;
  try {
    ref = parseStreamer(raw, chosenProvider);
  } catch (err) {
    setStatus(`Could not parse streamer: ${err.message}`);
    return;
  }

  submitBtn.disabled = true;
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
    queueEl.scrollLeft = 0;
    const requested = count;
    const got = clips.length;
    const summary =
      got < requested
        ? `Loaded ${got} clips (provider returned fewer than ${requested} requested).`
        : `Loaded ${got} clips.`;
    setStatus(`${summary} Playing #1 — ${clips[0].title}`);
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
    // Surface specific known errors with helpful hints
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
    submitBtn.disabled = false;
  }
});

// ---------- Initial render ----------
renderQueue();
setStatus("Ready. Type a streamer (e.g. twitch.tv/forsen) and press Load clips.");
