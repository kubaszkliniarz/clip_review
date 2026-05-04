"""Shared types + a tiny URL parser for Twitch / Kick streamer references."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, NamedTuple

Provider = Literal["twitch", "kick"]
Window = Literal["day", "week", "month"]


class StreamerRef(NamedTuple):
    provider: Provider
    login: str


@dataclass(frozen=True)
class Clip:
    provider: Provider
    id: str
    title: str
    view_count: int
    duration_sec: float
    thumbnail_url: str
    embed_url: str
    url: str
    broadcaster_name: str
    created_at: str


_TWITCH_RE = re.compile(r"^(?:https?://)?(?:www\.)?twitch\.tv/(?P<login>[a-zA-Z0-9_]+)/?$")
_KICK_RE = re.compile(r"^(?:https?://)?(?:www\.)?kick\.com/(?P<login>[a-zA-Z0-9_]+)/?$")
_BARE_RE = re.compile(r"^[a-zA-Z0-9_]{3,30}$")


def parse_streamer(value: str, *, default_provider: Provider = "twitch") -> StreamerRef:
    """Parse a URL or bare login. Raises ValueError on garbage input.

    Bare logins (no host) fall back to ``default_provider``.
    """
    s = value.strip()
    if m := _TWITCH_RE.match(s):
        return StreamerRef("twitch", m["login"].lower())
    if m := _KICK_RE.match(s):
        return StreamerRef("kick", m["login"].lower())
    if _BARE_RE.match(s):
        return StreamerRef(default_provider, s.lower())
    raise ValueError(f"could not parse streamer reference: {value!r}")


_WINDOW_DELTA: dict[Window, timedelta] = {
    "day": timedelta(days=1),
    "week": timedelta(days=7),
    "month": timedelta(days=30),
}


def window_to_range(window: Window, *, now: datetime | None = None) -> tuple[datetime, datetime]:
    """Return (started_at, ended_at) for the window, both UTC, ended_at=now."""
    end = now or datetime.now(tz=UTC)
    return end - _WINDOW_DELTA[window], end
