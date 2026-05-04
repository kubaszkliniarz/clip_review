"""Twitch Helix provider for top-by-views clips within a time window.

Reference for the JavaScript client running in the browser. Production fetches
happen there; this module mirrors the same logic and is exercised by tests.
"""

from __future__ import annotations

from datetime import datetime
from types import TracebackType
from typing import Any, Self

import httpx

from clip_review.providers import Clip, Window, window_to_range

API_BASE = "https://api.twitch.tv/helix"
TOKEN_URL = "https://id.twitch.tv/oauth2/token"


def _to_clip(raw: dict[str, Any]) -> Clip:
    return Clip(
        provider="twitch",
        id=str(raw["id"]),
        title=str(raw.get("title", "")),
        view_count=int(raw.get("view_count", 0)),
        duration_sec=float(raw.get("duration", 0.0)),
        thumbnail_url=str(raw.get("thumbnail_url", "")),
        embed_url=str(raw.get("embed_url", "")),
        url=str(raw.get("url", "")),
        broadcaster_name=str(raw.get("broadcaster_name", "")),
        created_at=str(raw.get("created_at", "")),
    )


async def mint_app_access_token(
    client_id: str, client_secret: str, *, http: httpx.AsyncClient | None = None
) -> str:
    """Run the OAuth client_credentials flow and return the bearer token.

    Used by the CI cron that refreshes the token written into the static bundle.
    """
    owns = http is None
    client = http or httpx.AsyncClient(timeout=10.0)
    try:
        resp = await client.post(
            TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "client_credentials",
            },
        )
        resp.raise_for_status()
        token = resp.json().get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("twitch token response missing access_token")
        return token
    finally:
        if owns:
            await client.aclose()


class TwitchProvider:
    """Async helper around Helix /users and /clips."""

    def __init__(
        self,
        client_id: str,
        app_access_token: str,
        *,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._client_id = client_id
        self._token = app_access_token
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

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "Client-ID": self._client_id,
            "Authorization": f"Bearer {self._token}",
        }

    async def get_user_id(self, login: str) -> str | None:
        resp = await self._http.get(
            f"{API_BASE}/users", params={"login": login}, headers=self._headers
        )
        resp.raise_for_status()
        data = resp.json().get("data") or []
        if not data:
            return None
        return str(data[0]["id"])

    async def get_top_clips(
        self,
        broadcaster_id: str,
        started_at: datetime,
        ended_at: datetime,
        first: int = 50,
    ) -> list[Clip]:
        first_clamped = min(max(first, 1), 100)
        params: dict[str, str | int] = {
            "broadcaster_id": broadcaster_id,
            "started_at": started_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "ended_at": ended_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "first": first_clamped,
        }
        resp = await self._http.get(f"{API_BASE}/clips", params=params, headers=self._headers)
        resp.raise_for_status()
        raw = resp.json().get("data") or []
        return [_to_clip(c) for c in raw]

    async def top_clips_for_login(self, login: str, window: Window, count: int = 50) -> list[Clip]:
        """Convenience: resolve login → user_id → top clips in one call."""
        user_id = await self.get_user_id(login)
        if user_id is None:
            return []
        started, ended = window_to_range(window)
        return await self.get_top_clips(user_id, started, ended, first=count)
