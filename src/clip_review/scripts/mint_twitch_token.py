"""Mint a Twitch app access token and write it into the static bundle.

Run by GitHub Actions on a schedule (and before each deploy). Reads
``TWITCH_CLIENT_ID`` and ``TWITCH_CLIENT_SECRET`` from env, writes JSON to
the path passed as the first CLI argument (defaults to
``web/twitch_token.json``). The output file is consumed by the browser to
authenticate Helix calls; ``client_secret`` never leaves the CI environment.

For local development, a ``.env`` file at the repo root is auto-loaded — see
``.env.example`` for the format. Real env vars always win over ``.env`` so
CI behavior is unchanged.

App access tokens are public-bearer scope on Twitch (no user permissions),
so shipping one in the static bundle is acceptable for a personal toy. Tokens
last ~60 days but are rotated more aggressively here for safety.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from clip_review.providers.twitch import mint_app_access_token

DEFAULT_OUT = Path("web/twitch_token.json")


def _find_repo_root() -> Path:
    """Walk up from cwd looking for pyproject.toml. Falls back to cwd."""
    cwd = Path.cwd()
    for parent in (cwd, *cwd.parents):
        if (parent / "pyproject.toml").exists():
            return parent
    return cwd


def _parse_dotenv(text: str) -> dict[str, str]:
    """Parse a minimal .env shape (KEY=VALUE per line). Tolerates ``export ``
    prefixes, ``#`` comments, and matching single/double quotes around values."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key:
            continue
        v = value.strip()
        # Strip matching outer quotes only.
        if len(v) >= 2 and ((v[0] == v[-1]) and v[0] in ('"', "'")):
            v = v[1:-1]
        out[key] = v
    return out


def _load_dotenv(path: Path | None = None) -> int:
    """Load .env into os.environ via setdefault (existing env wins). Returns
    the count of keys set. No-op if the file is missing."""
    target = path or (_find_repo_root() / ".env")
    if not target.exists():
        return 0
    pairs = _parse_dotenv(target.read_text(encoding="utf-8"))
    set_count = 0
    for k, v in pairs.items():
        if k not in os.environ:
            os.environ[k] = v
            set_count += 1
    return set_count


async def _main(argv: list[str]) -> int:
    _load_dotenv()
    client_id = os.environ.get("TWITCH_CLIENT_ID")
    client_secret = os.environ.get("TWITCH_CLIENT_SECRET")
    if not client_id or not client_secret:
        sys.stderr.write(
            "ERROR: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set "
            "(via env or repo-root .env file). See .env.example.\n"
        )
        return 2

    out = Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT

    token = await mint_app_access_token(client_id, client_secret)
    payload = {
        "client_id": client_id,
        "access_token": token,
        "minted_at": datetime.now(tz=UTC).isoformat(),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n")
    sys.stdout.write(f"wrote {out} ({len(token)} char token)\n")
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(_main(sys.argv)))


if __name__ == "__main__":
    main()
