from datetime import UTC, datetime

import pytest
import respx
from httpx import HTTPStatusError, Response

from clip_review.providers.twitch import (
    API_BASE,
    TOKEN_URL,
    TwitchProvider,
    mint_app_access_token,
)


class TestTwitchProvider:
    @pytest.mark.asyncio
    async def test_get_user_id_returns_id_for_existing_login(self) -> None:
        with respx.mock(base_url=API_BASE) as mock:
            mock.get("/users").mock(
                return_value=Response(200, json={"data": [{"id": "22484632", "login": "forsen"}]})
            )
            async with TwitchProvider(client_id="c", app_access_token="t") as p:
                assert await p.get_user_id("forsen") == "22484632"

    @pytest.mark.asyncio
    async def test_get_user_id_returns_none_when_login_not_found(self) -> None:
        with respx.mock(base_url=API_BASE) as mock:
            mock.get("/users").mock(return_value=Response(200, json={"data": []}))
            async with TwitchProvider(client_id="c", app_access_token="t") as p:
                assert await p.get_user_id("nope") is None

    @pytest.mark.asyncio
    async def test_get_top_clips_parses_response_and_passes_window_params(self) -> None:
        clip_payload = {
            "id": "abc",
            "title": "insane play",
            "view_count": 12345,
            "duration": 30.0,
            "thumbnail_url": "https://t/x.jpg",
            "embed_url": "https://clips.twitch.tv/embed?clip=abc",
            "url": "https://clips.twitch.tv/abc",
            "broadcaster_name": "Forsen",
            "created_at": "2026-04-01T00:00:00Z",
        }
        with respx.mock(base_url=API_BASE) as mock:
            route = mock.get("/clips").mock(
                return_value=Response(200, json={"data": [clip_payload]})
            )
            async with TwitchProvider(client_id="c", app_access_token="t") as p:
                started = datetime(2026, 4, 27, 12, 0, 0, tzinfo=UTC)
                ended = datetime(2026, 5, 4, 12, 0, 0, tzinfo=UTC)
                clips = await p.get_top_clips("22484632", started, ended, first=50)

        assert len(clips) == 1
        c = clips[0]
        assert c.provider == "twitch"
        assert c.id == "abc"
        assert c.view_count == 12345
        assert c.embed_url == "https://clips.twitch.tv/embed?clip=abc"
        sent = route.calls[0].request
        url = str(sent.url)
        assert "broadcaster_id=22484632" in url
        assert "first=50" in url
        assert "started_at=2026-04-27T12%3A00%3A00Z" in url
        assert "ended_at=2026-05-04T12%3A00%3A00Z" in url
        assert sent.headers["Client-ID"] == "c"
        assert sent.headers["Authorization"] == "Bearer t"

    @pytest.mark.asyncio
    async def test_get_top_clips_clamps_first_above_one_hundred(self) -> None:
        with respx.mock(base_url=API_BASE) as mock:
            route = mock.get("/clips").mock(return_value=Response(200, json={"data": []}))
            async with TwitchProvider(client_id="c", app_access_token="t") as p:
                started = datetime(2026, 4, 27, 12, 0, 0, tzinfo=UTC)
                ended = datetime(2026, 5, 4, 12, 0, 0, tzinfo=UTC)
                await p.get_top_clips("1", started, ended, first=500)
        assert "first=100" in str(route.calls[0].request.url)

    @pytest.mark.asyncio
    async def test_top_clips_for_login_resolves_then_fetches(self) -> None:
        with respx.mock(base_url=API_BASE) as mock:
            mock.get("/users").mock(return_value=Response(200, json={"data": [{"id": "42"}]}))
            mock.get("/clips").mock(
                return_value=Response(
                    200,
                    json={
                        "data": [
                            {
                                "id": "x",
                                "title": "t",
                                "view_count": 1,
                                "duration": 30.0,
                                "thumbnail_url": "",
                                "embed_url": "https://e",
                                "url": "https://u",
                                "broadcaster_name": "B",
                                "created_at": "2026-05-01T00:00:00Z",
                            }
                        ]
                    },
                )
            )
            async with TwitchProvider(client_id="c", app_access_token="t") as p:
                clips = await p.top_clips_for_login("forsen", "week", count=10)
        assert len(clips) == 1
        assert clips[0].id == "x"

    @pytest.mark.asyncio
    async def test_top_clips_for_login_returns_empty_when_user_missing(self) -> None:
        with respx.mock(base_url=API_BASE) as mock:
            mock.get("/users").mock(return_value=Response(200, json={"data": []}))
            async with TwitchProvider(client_id="c", app_access_token="t") as p:
                clips = await p.top_clips_for_login("ghost", "week")
        assert clips == []


class TestMintAppAccessToken:
    @pytest.mark.asyncio
    async def test_returns_token_on_happy_path(self) -> None:
        with respx.mock(base_url="https://id.twitch.tv") as mock:
            route = mock.post("/oauth2/token").mock(
                return_value=Response(200, json={"access_token": "tok123", "expires_in": 5000000})
            )
            token = await mint_app_access_token("c", "s")
        assert token == "tok123"
        sent = route.calls[0].request
        body = sent.content.decode()
        assert "client_id=c" in body
        assert "client_secret=s" in body
        assert "grant_type=client_credentials" in body

    @pytest.mark.asyncio
    async def test_raises_when_response_missing_token(self) -> None:
        with respx.mock(base_url="https://id.twitch.tv") as mock:
            mock.post("/oauth2/token").mock(return_value=Response(200, json={}))
            with pytest.raises(RuntimeError, match="missing access_token"):
                await mint_app_access_token("c", "s")

    @pytest.mark.asyncio
    async def test_raises_on_http_error(self) -> None:
        with respx.mock(base_url="https://id.twitch.tv") as mock:
            mock.post("/oauth2/token").mock(return_value=Response(401, json={"message": "bad"}))
            with pytest.raises(HTTPStatusError):
                await mint_app_access_token("c", "s")

    def test_token_url_constant_points_to_twitch(self) -> None:
        assert TOKEN_URL.startswith("https://id.twitch.tv/")
