// Parse a streamer reference (URL or bare login) into { provider, login }.
// Mirrors src/clip_review/providers/parse_streamer.

const TWITCH_RE = /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]+)\/?$/;
const KICK_RE = /^(?:https?:\/\/)?(?:www\.)?kick\.com\/([a-zA-Z0-9_]+)\/?$/;
const BARE_RE = /^[a-zA-Z0-9_]{3,30}$/;

export function parseStreamer(value, defaultProvider = "twitch") {
  const s = String(value || "").trim();
  let m = s.match(TWITCH_RE);
  if (m) return { provider: "twitch", login: m[1].toLowerCase() };
  m = s.match(KICK_RE);
  if (m) return { provider: "kick", login: m[1].toLowerCase() };
  if (BARE_RE.test(s)) return { provider: defaultProvider, login: s.toLowerCase() };
  throw new Error(`could not parse streamer: ${value}`);
}
