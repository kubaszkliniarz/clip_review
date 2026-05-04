// Twitch Helix client. Loads the app access token from ./twitch_token.json
// (written by the CI mint script before deploy). Mirrors providers/twitch.py.

const API = "https://api.twitch.tv/helix";
const WINDOW_DAYS = { day: 1, week: 7, month: 30 };

let _auth = null;

async function getAuth() {
  if (_auth) return _auth;
  const resp = await fetch("./twitch_token.json", { cache: "no-cache" });
  if (!resp.ok) {
    throw new Error(
      `No Twitch token bundled (HTTP ${resp.status}). The CI deploy mints one.`
    );
  }
  _auth = await resp.json();
  return _auth;
}

async function helix(path, params) {
  const { client_id, access_token } = await getAuth();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, {
    headers: {
      "Client-ID": client_id,
      Authorization: `Bearer ${access_token}`,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Twitch ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}

async function getUserId(login) {
  const data = await helix("/users", { login });
  return (data && data.data && data.data[0] && data.data[0].id) || null;
}

function helixDate(d) {
  // 2026-04-27T12:00:00Z (no millis, RFC3339-Z)
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildEmbedUrl(slug) {
  const parent = window.location.hostname || "localhost";
  const params = new URLSearchParams({
    clip: slug,
    parent,
    autoplay: "true",
    muted: "false",
  });
  return `https://clips.twitch.tv/embed?${params.toString()}`;
}

function resolveThumbnail(raw) {
  // Twitch returns a template URL with {width} and {height} placeholders.
  if (!raw) return "";
  return raw.replace("{width}", "168").replace("{height}", "94");
}

function toClip(c) {
  return {
    provider: "twitch",
    id: c.id,
    title: c.title || "",
    viewCount: Number(c.view_count || 0),
    durationSec: Number(c.duration || 0),
    thumbnailUrl: resolveThumbnail(c.thumbnail_url),
    embedUrl: buildEmbedUrl(c.id),
    url: c.url || "",
    broadcasterName: c.broadcaster_name || "",
    createdAt: c.created_at || "",
  };
}

export async function getTopClips(login, win, count = 50) {
  const userId = await getUserId(login);
  if (!userId) return [];
  const ended = new Date();
  const days = WINDOW_DAYS[win] ?? 7;
  const started = new Date(ended.getTime() - days * 86400000);
  const data = await helix("/clips", {
    broadcaster_id: userId,
    started_at: helixDate(started),
    ended_at: helixDate(ended),
    first: Math.min(Math.max(count, 1), 100),
  });
  return (data.data || []).map(toClip);
}
