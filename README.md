# clip_review

Tiny static site that auto-plays a streamer's top clips back-to-back, so you
can watch the highlights in the background instead of clicking through them
one at a time. Works for **Twitch** and **Kick** streamers; pick a window
(24h / 7d / 30d), get up to 100 clips ranked by views, hit play, and the
queue advances itself.

The site is pure HTML/CSS/JS deployed to GitHub Pages. Python is used only
for: the test suite (pytest, mypy, ruff) and a small CI script that mints a
fresh Twitch app token before each deploy.

## Quick start (local)

```sh
# 1. set up the Python venv (uv installs Python 3.14 if missing)
uv venv --python 3.14
uv pip compile requirements.in requirements-dev.in -o requirements-dev.txt
uv pip sync requirements-dev.txt
uv pip install -e . --no-deps

# 2. run the checks
.venv/bin/ruff check .
.venv/bin/mypy
.venv/bin/pytest

# 3. serve the static frontend
cd web && python3 -m http.server 5555
# open http://localhost:5555
```

For Twitch to work locally you need a minted token written to
`web/twitch_token.json` (gitignored — deploy-time artifact, not source).

The simplest setup is a `.env` at the repo root:

```sh
cp .env.example .env
# then edit .env with credentials from https://dev.twitch.tv/console/apps
.venv/bin/python -m clip_review.scripts.mint_twitch_token web/twitch_token.json
```

The mint script auto-loads `.env` from the repo root; existing env vars take
precedence so CI behavior is unchanged. Tokens are good for ~60 days; re-run
the mint command to refresh. Both `.env` and `web/twitch_token.json` are
gitignored.

You can also pass env vars inline if you don't want a `.env` on disk:

```sh
TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... \
  .venv/bin/python -m clip_review.scripts.mint_twitch_token web/twitch_token.json
```

## Deploy

Push to `main` (or `master`). The `deploy.yml` workflow:

1. Installs Python 3.14 + runtime deps via uv
2. Mints a Twitch app token (skipped silently if secrets aren't set)
3. Uploads `web/` as a GitHub Pages artifact
4. Deploys it

A 12-hour cron triggers the same workflow to refresh the Twitch token.

To enable Twitch on the deployed site, add two repo secrets:

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`

(Both come from a Twitch dev app at <https://dev.twitch.tv/console/apps>.
The redirect URL doesn't matter for app-credentials grant; any URL works.)

Without these, Kick still works and Twitch surfaces a clear error in the
status bar.

## Caveats

- **Kick is browse-only.** Kick serves all of `kick.com/*` with
  `X-Frame-Options: SAMEORIGIN`, so we cannot iframe-embed Kick clips
  from any third-party origin. The site falls back to a "browse" card
  per Kick clip with the thumbnail, title, view count, and an *Open on
  Kick* link — auto-advance still ticks through the queue, but each
  clip plays in a new tab on Kick itself.
  Kick's API is also fronted by Cloudflare's bot protection, so the
  initial channel fetch can fail with a 403 unless the visitor's browser
  has a valid `__cf_bm` cookie from a prior Kick visit. There's no
  client-side fix for either restriction; making Kick "play in-page"
  would require a backend proxy that this static deploy doesn't have.
  **For full playback support, use Twitch.**
- **Twitch autoplay with sound** depends on the browser's autoplay policy.
  Clicking *Load clips* counts as a user gesture, which usually unblocks it.
- **Embedded clip auto-advance** is timer-driven (`duration + break`), not
  driven by an end-of-video event from the iframe — those events are
  unreliable cross-origin. If a clip stalls, hit ↻ Refresh.

## Layout

```
src/clip_review/      Python: provider clients, token-mint script, tests
tests/                pytest suite (39 tests, mypy --strict clean)
web/                  static frontend (HTML/CSS, ES-module JS)
web/providers/        twitch.js, kick.js, parse.js — mirror the Python
.github/workflows/    ci.yml (lint+type+test), deploy.yml (Pages)
```
