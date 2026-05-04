// Kick public clips client. No auth required, but cross-origin browser calls
// may be CORS-blocked depending on Kick's policy at the time. Mirrors
// providers/kick.py. If CORS fails, the only fix is a small proxy.

const API = "https://kick.com/api/v2";

function pickVideoUrl(c) {
  // Try every reasonable field — Kick has shifted shapes over the years.
  const candidates = [
    c.video_url,
    c.clip_url_mp4,
    c.mp4_url,
    c.download_url,
    c.media_url,
    c.stream_url,
    c.video?.url,
    c.video?.src,
    c.media?.url,
    c.clip?.video_url,
    c.urls?.mp4,
  ];
  for (const url of candidates) {
    if (typeof url === "string" && url) return url;
  }
  return "";
}

function toClip(c, channelSlug) {
  const id = String(c.id || "");
  const channel = c.channel || {};
  const fallback = `https://kick.com/${channelSlug}/clips/${id}`;
  return {
    provider: "kick",
    id,
    title: c.title || "",
    viewCount: Number(c.view_count || c.views || 0),
    durationSec: Number(c.duration || 0),
    thumbnailUrl: c.thumbnail_url || "",
    embedUrl: fallback,
    videoUrl: pickVideoUrl(c),
    url: c.clip_url || fallback,
    broadcasterName: channel.username || channel.slug || channelSlug,
    createdAt: c.created_at || "",
    _raw: c, // dev-only: kept on the object so we can log it once
  };
}

const MAX_PAGES = 10; // safety net: ~200 clips max

export async function getTopClips(channel, win, count = 50) {
  const target = Math.max(1, count);
  const all = [];
  let cursor = null;
  let pages = 0;

  while (all.length < target && pages < MAX_PAGES) {
    const url = new URL(`${API}/channels/${encodeURIComponent(channel)}/clips`);
    url.searchParams.set("sort", "view");
    url.searchParams.set("time", win);
    if (cursor) url.searchParams.set("cursor", cursor);

    let resp;
    try {
      resp = await fetch(url, { credentials: "omit" });
    } catch (err) {
      throw new Error(
        `Kick fetch failed (likely CORS — Kick blocks browser calls from third-party origins): ${err.message}`
      );
    }
    if (!resp.ok) {
      throw new Error(`Kick ${resp.status}: ${resp.statusText}`);
    }

    const body = await resp.json();
    const raw = body.clips || body.data || [];
    if (!raw.length) break;
    all.push(...raw);
    cursor = body.nextCursor || body.next_cursor || body.cursor || null;
    pages += 1;
    if (!cursor) break;
  }

  // One-off debug: dump the first raw clip + top-level keys so we can see
  // what Kick is actually returning. Strip this once the right field names
  // are pinned down.
  if (all[0]) {
    // eslint-disable-next-line no-console
    console.log("[kick debug] first clip top-level keys:", Object.keys(all[0]));
    // eslint-disable-next-line no-console
    console.log("[kick debug] first clip full payload:", all[0]);
  }

  return all.slice(0, target).map((c) => toClip(c, channel));
}
