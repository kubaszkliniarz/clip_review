import json
from pathlib import Path

import pytest
import respx
from httpx import Response

from clip_review.scripts.mint_twitch_token import _load_dotenv, _main, _parse_dotenv


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
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Run from an empty dir so _load_dotenv() can't pick up the repo's own .env.
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("TWITCH_CLIENT_ID", raising=False)
        monkeypatch.setenv("TWITCH_CLIENT_SECRET", "s")
        assert await _main(["mint"]) == 2

    @pytest.mark.asyncio
    async def test_returns_two_when_client_secret_missing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(tmp_path)
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


class TestParseDotenv:
    def test_parses_basic_pairs(self) -> None:
        assert _parse_dotenv("FOO=bar\nBAZ=qux\n") == {"FOO": "bar", "BAZ": "qux"}

    def test_strips_export_prefix(self) -> None:
        assert _parse_dotenv("export FOO=bar") == {"FOO": "bar"}

    def test_strips_matching_outer_quotes(self) -> None:
        text = "A=\"hi\"\nB='yo'\nC=\"mismatched'\n"
        parsed = _parse_dotenv(text)
        assert parsed["A"] == "hi"
        assert parsed["B"] == "yo"
        # Mismatched quotes are preserved verbatim.
        assert parsed["C"] == "\"mismatched'"

    def test_ignores_comments_and_blank_lines(self) -> None:
        text = "# this is a comment\n\nFOO=bar\n   \n# another\nBAZ=qux"
        assert _parse_dotenv(text) == {"FOO": "bar", "BAZ": "qux"}

    def test_ignores_lines_without_equals(self) -> None:
        assert _parse_dotenv("FOO\nBAR=baz\n") == {"BAR": "baz"}

    def test_ignores_empty_keys(self) -> None:
        assert _parse_dotenv("=value\nFOO=bar") == {"FOO": "bar"}


class TestLoadDotenv:
    def test_loads_into_environ_when_file_present(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        env = tmp_path / ".env"
        env.write_text("TWITCH_CLIENT_ID=fromfile\nOTHER=x\n")
        monkeypatch.delenv("TWITCH_CLIENT_ID", raising=False)
        monkeypatch.delenv("OTHER", raising=False)
        n = _load_dotenv(env)
        assert n == 2
        import os

        assert os.environ["TWITCH_CLIENT_ID"] == "fromfile"
        assert os.environ["OTHER"] == "x"

    def test_does_not_override_existing_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        env = tmp_path / ".env"
        env.write_text("TWITCH_CLIENT_ID=from_dotenv\n")
        monkeypatch.setenv("TWITCH_CLIENT_ID", "from_real_env")
        _load_dotenv(env)
        import os

        assert os.environ["TWITCH_CLIENT_ID"] == "from_real_env"

    def test_noop_when_file_missing(self, tmp_path: Path) -> None:
        assert _load_dotenv(tmp_path / "missing.env") == 0

    @pytest.mark.asyncio
    async def test_main_picks_up_dotenv_when_env_unset(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Repo-root detection walks up looking for pyproject.toml — fake one here.
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        (tmp_path / ".env").write_text(
            "TWITCH_CLIENT_ID=from_dotenv_id\nTWITCH_CLIENT_SECRET=from_dotenv_secret\n"
        )
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("TWITCH_CLIENT_ID", raising=False)
        monkeypatch.delenv("TWITCH_CLIENT_SECRET", raising=False)

        out = tmp_path / "twitch_token.json"
        with respx.mock(base_url="https://id.twitch.tv") as mock:
            mock.post("/oauth2/token").mock(return_value=Response(200, json={"access_token": "t"}))
            rc = await _main(["mint", str(out)])
        assert rc == 0
        data = json.loads(out.read_text())
        assert data["client_id"] == "from_dotenv_id"
