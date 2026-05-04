// Clip Review — front-end behavior.
// This file currently runs on stub data so the layout can be eyeballed.
// Real Twitch/Kick provider wiring lands in a later commit.

(() => {
  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const form = $("streamer-form");
  const queueEl = $("queue");
  const queueWrap = queueEl.parentElement;
  const queueCount = $("queue-count");
  const player = $("player");
  const playerMeta = $("player-meta");
  const playerTitle = $("player-title-text");
  const playerViews = $("player-views");
  const btnPrev = $("btn-prev");
  const btnSkip = $("btn-skip");
  const btnNext = $("btn-next");
  const btnQPrev = $("btn-queue-prev");
  const btnQNext = $("btn-queue-next");
  const btnTheatre = $("btn-theatre");
  const breakSlider = $("break");
  const breakReadout = $("break-readout");

  // ---------- State ----------
  /** @type {{id:string, title:string, views:number, played:boolean}[]} */
  let clips = [];
  let activeIdx = -1;
  const played = new Set();

  // ---------- Helpers ----------
  const setStatus = (msg) => {
    status.textContent = msg;
  };

  const fmtViews = (n) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };

  // Stub thumbnail: a deterministic platinum-era color block with the index.
  const stubThumbStyle = (i) => {
    const palette = ["#9aa9b8", "#b8a99a", "#a8b89a", "#b89aa8", "#9ab8a8", "#a89ab8"];
    return `background-color:${palette[i % palette.length]}`;
  };

  // ---------- Stub data ----------
  const buildStubClips = (count, who) => {
    const titles = [
      "absolutely insane play",
      "what just happened",
      "perfectly cut s",
      "first try, no way",
      "chat went feral",
      "this kills me every time",
      "300 IQ moment",
      "ratio'd live on stream",
      "rage incoming",
      "deserved a spot on the wall",
      "1v9 carry",
      "the prophecy",
      "no scope, no problem",
      "the silence was deafening",
      "comeback of the century",
    ];
    return Array.from({ length: count }, (_, i) => ({
      id: `stub-${i + 1}`,
      title: `${who}: ${titles[i % titles.length]}`,
      views: Math.round(50_000 / (i * 0.6 + 1) + Math.random() * 200),
      played: false,
    }));
  };

  // ---------- Render ----------
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
        return `
          <li class="${cls}" data-idx="${i}">
            <div class="queue-tile__thumb" style="${stubThumbStyle(i)}">
              <span class="queue-tile__index">#${i + 1}</span>
              <span aria-hidden="true">${i + 1}</span>
            </div>
            <div class="queue-tile__body">
              <p class="queue-tile__title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</p>
              <span class="queue-tile__views">${fmtViews(c.views)} views</span>
            </div>
          </li>
        `;
      })
      .join("");
    queueEl.innerHTML = html;
  };

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);

  const renderPlayer = () => {
    if (activeIdx < 0 || !clips[activeIdx]) {
      player.innerHTML = `
        <div class="player__placeholder">
          <p>No clip loaded.</p>
          <p class="player__hint">Pick a streamer above to start.</p>
        </div>`;
      playerMeta.hidden = true;
      [btnPrev, btnSkip, btnNext].forEach((b) => (b.disabled = true));
      return;
    }
    const c = clips[activeIdx];
    // Stub: render a placard until provider integration lands.
    player.innerHTML = `
      <div class="player__placeholder">
        <p>STUB · clip ${activeIdx + 1} of ${clips.length}</p>
        <p class="player__hint">${escapeHtml(c.title)}</p>
        <p class="player__hint">Real embed comes once Twitch/Kick providers are wired.</p>
      </div>`;
    playerMeta.hidden = false;
    playerTitle.textContent = c.title;
    playerViews.textContent = `${fmtViews(c.views)} views`;
    btnPrev.disabled = activeIdx <= 0;
    btnNext.disabled = activeIdx >= clips.length - 1;
    btnSkip.disabled = false;
  };

  const scrollQueueToActive = () => {
    const tile = queueEl.querySelector(`.queue-tile[data-idx="${activeIdx}"]`);
    if (!tile) return;
    const stripRect = queueEl.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    const target =
      queueEl.scrollLeft + (tileRect.left - stripRect.left) - stripRect.width / 2 + tileRect.width / 2;
    queueEl.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  };

  // ---------- Controls ----------
  const goTo = (idx) => {
    if (idx < 0 || idx >= clips.length) return;
    if (activeIdx >= 0) played.add(activeIdx);
    activeIdx = idx;
    renderQueue();
    renderPlayer();
    scrollQueueToActive();
    setStatus(`Playing clip ${idx + 1} of ${clips.length}.`);
  };

  const next = () => goTo(activeIdx + 1);
  const prev = () => goTo(activeIdx - 1);

  btnPrev.addEventListener("click", prev);
  btnNext.addEventListener("click", next);
  btnSkip.addEventListener("click", next);

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
      try { queueEl.releasePointerCapture(e.pointerId); } catch {}
    }
    // Reset suppressClick after the click event has fired.
    setTimeout(() => { suppressClick = false; }, 0);
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
  });

  // ---------- Form ----------
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const streamer = String(data.get("streamer") || "").trim();
    const window = String(data.get("window") || "week");
    const count = Number(data.get("count") || 50);
    if (!streamer) return;

    const who = streamer.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    setStatus(`STUB: showing ${count} fake clips for ${who} (${window}). Real fetch comes later.`);
    clips = buildStubClips(count, who);
    played.clear();
    activeIdx = 0;
    renderQueue();
    renderPlayer();
    queueEl.scrollLeft = 0;
  });

  // ---------- Initial render ----------
  renderQueue();
  setStatus("Ready. Type a streamer and press Load clips for a stub preview.");
})();
