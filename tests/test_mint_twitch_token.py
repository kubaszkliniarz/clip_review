import json
from pathlib import Path

import pytest
import respx
from httpx import Response

from clip_review.scripts.mint_twitch_token import _main


class TestMintScript:
    @pytest.mark.asyncio
    async def test_writes_token_payload_to_given_path(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        out = tmp_path / "twitch_token.json"
        monkeypatch.setenv("TWITCH_CLIENT_ID", "id123")
        monkeypatch.setenv("TWITCH_CLIENT_SECRET", "secret")

        with respx.mock(base_url="https://id.twitch.tv") as mock:
            mock.post("/oauth2/token").mock(
                return_value=Response(200, json={"access_token": "tok", "expires_in": 5_000_000})
            )
            rc = await _main(["mint", str(out)])

        assert rc == 0
        data = json.loads(out.read_text())
        assert data["client_id"] == "id123"
        assert data["access_token"] == "tok"
        assert "minted_at" in data

    @pytest.mark.asyncio
    async def test_creates_parent_directories_if_needed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        out = tmp_path / "nested" / "dirs" / "twitch_token.json"
        monkeypatch.setenv("TWITCH_CLIENT_ID", "id")
        monkeypatch.setenv("TWITCH_CLIENT_SECRET", "s")

        with respx.mock(base_url="https://id.twitch.tv") as mock:
            mock.post("/oauth2/token").mock(return_value=Response(200, json={"access_token": "x"}))
            rc = await _main(["mint", str(out)])

        assert rc == 0
        assert out.exists()

    @pytest.mark.asyncio
    async def test_returns_two_when_client_id_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("TWITCH_CLIENT_ID", raising=False)
        monkeypatch.setenv("TWITCH_CLIENT_SECRET", "s")
        assert await _main(["mint"]) == 2

    @pytest.mark.asyncio
    async def test_returns_two_when_client_secret_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("TWITCH_CLIENT_ID", "id")
        monkeypatch.delenv("TWITCH_CLIENT_SECRET", raising=False)
        assert await _main(["mint"]) == 2

    @pytest.mark.asyncio
    async def test_does_not_write_secret_into_payload(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        out = tmp_path / "twitch_token.json"
        monkeypatch.setenv("TWITCH_CLIENT_ID", "id")
        monkeypatch.setenv("TWITCH_CLIENT_SECRET", "supersecret_should_never_be_in_output")

        with respx.mock(base_url="https://id.twitch.tv") as mock:
            mock.post("/oauth2/token").mock(
                return_value=Response(200, json={"access_token": "tok"})
            )
            await _main(["mint", str(out)])

        body = out.read_text()
        assert "supersecret_should_never_be_in_output" not in body
