"""Kick public clips provider.

Kick's browser-accessible JSON endpoint at /api/v2 is not officially documented
as a public surface but is what kick.com itself uses. CORS may block direct
browser calls from third-party origins; in that case a small proxy is needed.
This module is the authoritative parser regardless of whether the request
originates in the browser or behind a proxy.
"""

from __future__ import annotations

from types import TracebackType
from typing import Any, Self

import httpx

from clip_review.providers import Clip, Window

API_BASE = "https://kick.com/api/v2"

_WINDOW_PARAM: dict[Window, str] = {"day": "day", "week": "week", "month": "month"}


def _to_clip(raw: dict[str, Any], *, channel_slug: str) -> Clip:
    clip_id = str(raw.get("id", ""))
    channel = raw.get("channel") or {}
    name = str(channel.get("username") or channel.get("slug") or channel_slug)
    fallback_url = f"https://kick.com/{channel_slug}/clips/{clip_id}"
    return Clip(
        provider="kick",
        id=clip_id,
        title=str(raw.get("title", "")),
        view_count=int(raw.get("view_count") or raw.get("views") or 0),
        duration_sec=float(raw.get("duration") or 0.0),
        thumbnail_url=str(raw.get("thumbnail_url") or ""),
        embed_url=fallback_url,
        url=str(raw.get("clip_url") or fallback_url),
        broadcaster_name=name,
        created_at=str(raw.get("created_at", "")),
    )


class KickProvider:
    """Async helper around Kick's public clips endpoint. No auth required."""

    def __init__(self, *, http: httpx.AsyncClient | None = None) -> None:
        self._http = http or httpx.AsyncClient(timeout=10.0)
        self._owns_http = http is None

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def get_top_clips(self, channel: str, window: Window, count: int = 50) -> list[Clip]:
        params = {"sort": "view", "time": _WINDOW_PARAM[window]}
        resp = await self._http.get(f"{API_BASE}/channels/{channel}/clips", params=params)
        resp.raise_for_status()
        body = resp.json()
        raw_clips = body.get("clips") or body.get("data") or []
        clips = [_to_clip(c, channel_slug=channel) for c in raw_clips]
        return clips[: max(1, count)]
