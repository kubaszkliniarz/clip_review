import pytest
import respx
from httpx import Response

from clip_review.providers.kick import API_BASE, KickProvider


def _clip_payload(
    clip_id: str = "clip_abc",
    title: str = "kick clip",
    views: int = 1000,
    channel_username: str = "xqc",
) -> dict[str, object]:
    return {
        "id": clip_id,
        "title": title,
        "view_count": views,
        "duration": 25,
        "thumbnail_url": f"https://kick.com/thumbs/{clip_id}.jpg",
        "clip_url": f"https://kick.com/xqc/clips/{clip_id}",
        "channel": {"username": channel_username},
        "created_at": "2026-04-30T00:00:00Z",
    }


class TestKickProvider:
    @pytest.mark.asyncio
    async def test_get_top_clips_parses_response_and_passes_window_param(self) -> None:
        with respx.mock(base_url=API_BASE) as mock:
            route = mock.get("/channels/xqc/clips").mock(
                return_value=Response(200, json={"clips": [_clip_payload()]})
            )
            async with KickProvider() as p:
                clips = await p.get_top_clips("xqc", "week", count=50)

        assert len(clips) == 1
        c = clips[0]
        assert c.provider == "kick"
        assert c.id == "clip_abc"
        assert c.view_count == 1000
        assert c.broadcaster_name == "xqc"
        assert c.embed_url == "https://kick.com/xqc/clips/clip_abc"

        sent_url = str(route.calls[0].request.url)
        assert "sort=view" in sent_url
        assert "time=week" in sent_url

    @pytest.mark.asyncio
    async def test_get_top_clips_respects_count_limit(self) -> None:
        many = [_clip_payload(clip_id=f"c{i}", views=100 - i) for i in range(80)]
        with respx.mock(base_url=API_BASE) as mock:
            mock.get("/channels/xqc/clips").mock(return_value=Response(200, json={"clips": many}))
            async with KickProvider() as p:
                clips = await p.get_top_clips("xqc", "week", count=20)
        assert len(clips) == 20

    @pytest.mark.asyncio
    async def test_get_top_clips_returns_empty_when_no_clips(self) -> None:
        with respx.mock(base_url=API_BASE) as mock:
            mock.get("/channels/ghost/clips").mock(return_value=Response(200, json={"clips": []}))
            async with KickProvider() as p:
                clips = await p.get_top_clips("ghost", "day")
        assert clips == []

    @pytest.mark.asyncio
    async def test_get_top_clips_handles_alternate_data_key(self) -> None:
        # Some response shapes use "data" instead of "clips"
        with respx.mock(base_url=API_BASE) as mock:
            mock.get("/channels/x/clips").mock(
                return_value=Response(200, json={"data": [_clip_payload(clip_id="z")]})
            )
            async with KickProvider() as p:
                clips = await p.get_top_clips("x", "month")
        assert len(clips) == 1
        assert clips[0].id == "z"

    @pytest.mark.asyncio
    async def test_get_top_clips_falls_back_to_synthetic_url_when_clip_url_missing(self) -> None:
        payload = _clip_payload(clip_id="nourl")
        del payload["clip_url"]
        with respx.mock(base_url=API_BASE) as mock:
            mock.get("/channels/xqc/clips").mock(
                return_value=Response(200, json={"clips": [payload]})
            )
            async with KickProvider() as p:
                clips = await p.get_top_clips("xqc", "week")
        assert clips[0].url == "https://kick.com/xqc/clips/nourl"

    @pytest.mark.parametrize(
        ("window", "expected"),
        [("day", "day"), ("week", "week"), ("month", "month")],
    )
    @pytest.mark.asyncio
    async def test_window_param_pass_through(self, window: str, expected: str) -> None:
        with respx.mock(base_url=API_BASE) as mock:
            route = mock.get("/channels/x/clips").mock(
                return_value=Response(200, json={"clips": []})
            )
            async with KickProvider() as p:
                await p.get_top_clips("x", window)  # type: ignore[arg-type]
        assert f"time={expected}" in str(route.calls[0].request.url)
