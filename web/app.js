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
/** @type {Array<{provider:string,id:string,title:string,viewCount:number,durationSec:number,thumbnailUrl:string,embedUrl:string,url:string,broadcasterName:string,createdAt:string}>} */
let clips = [];
let activeIdx = -1;
const played = new Set();
let advanceTimer = null;

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
  if (activeIdx < 0 || !clips[activeIdx]) {
    player.innerHTML = `
      <div class="player__placeholder">
        <p>No clip loaded.</p>
        <p class="player__hint">Pick a streamer above to start.</p>
      </div>`;
    playerMeta.hidden = true;
    [btnPrev, btnSkip, btnNext, btnRefresh].forEach((b) => (b.disabled = true));
    return;
  }
  const c = clips[activeIdx];
  // Tear down any previous iframe and create a fresh one — also acts as the
  // refresh implementation when the same active idx is re-rendered.
  player.innerHTML = "";
  const frame = document.createElement("iframe");
  frame.src = c.embedUrl;
  frame.allow = "autoplay; fullscreen; clipboard-write; encrypted-media";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "origin";
  frame.title = c.title || "clip";
  player.appendChild(frame);

  playerMeta.hidden = false;
  playerTitle.textContent = c.title;
  playerViews.textContent = `${fmtViews(c.viewCount)} views`;
  btnPrev.disabled = activeIdx <= 0;
  btnNext.disabled = activeIdx >= clips.length - 1;
  btnSkip.disabled = false;
  btnRefresh.disabled = false;

  scheduleAdvance();
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
let dragState = null;
queueEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragState = {
    startX: e.clientX,
    startScroll: queueEl.scrollLeft,
    moved: false,
  };
  queueEl.setPointerCapture(e.pointerId);
  queueEl.classList.add("is-dragging");
});
queueEl.addEventListener("pointermove", (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  if (Math.abs(dx) > 4) dragState.moved = true;
  queueEl.scrollLeft = dragState.startScroll - dx;
});
const endDrag = (e) => {
  if (!dragState) return;
  queueEl.classList.remove("is-dragging");
  suppressClick = dragState.moved;
  dragState = null;
  if (e && e.pointerId !== undefined) {
    try {
      queueEl.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
  }
  setTimeout(() => {
    suppressClick = false;
  }, 0);
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
  if (!raw) return;

  let ref;
  try {
    ref = parseStreamer(raw);
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
      setStatus(`No clips found for ${ref.provider}/${ref.login} in the last ${win}.`);
      renderQueue();
      return;
    }
    activeIdx = 0;
    renderQueue();
    renderPlayer();
    queueEl.scrollLeft = 0;
    setStatus(`Loaded ${clips.length} clips. Playing #1 — ${clips[0].title}`);
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- Initial render ----------
renderQueue();
setStatus("Ready. Type a streamer (e.g. twitch.tv/forsen) and press Load clips.");
