"""Mint a Twitch app access token and write it into the static bundle.

Run by GitHub Actions on a schedule (and before each deploy). Reads
``TWITCH_CLIENT_ID`` and ``TWITCH_CLIENT_SECRET`` from env, writes JSON to
the path passed as the first CLI argument (defaults to
``web/twitch_token.json``). The output file is consumed by the browser to
authenticate Helix calls; ``client_secret`` never leaves the CI environment.

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


async def _main(argv: list[str]) -> int:
    client_id = os.environ.get("TWITCH_CLIENT_ID")
    client_secret = os.environ.get("TWITCH_CLIENT_SECRET")
    if not client_id or not client_secret:
        sys.stderr.write("ERROR: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set\n")
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
