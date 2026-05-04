// Kick public clips client. No auth required, but cross-origin browser calls
// may be CORS-blocked depending on Kick's policy at the time. Mirrors
// providers/kick.py. If CORS fails, the only fix is a small proxy.

const API = "https://kick.com/api/v2";

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
    url: c.clip_url || fallback,
    broadcasterName: channel.username || channel.slug || channelSlug,
    createdAt: c.created_at || "",
  };
}

export async function getTopClips(channel, win, count = 50) {
  const url = new URL(`${API}/channels/${encodeURIComponent(channel)}/clips`);
  url.searchParams.set("sort", "view");
  url.searchParams.set("time", win);
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
  return raw.slice(0, Math.max(1, count)).map((c) => toClip(c, channel));
}
