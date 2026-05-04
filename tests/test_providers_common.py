from datetime import UTC, datetime

import pytest

from clip_review.providers import StreamerRef, parse_streamer, window_to_range


class TestParseStreamer:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("twitch.tv/forsen", StreamerRef("twitch", "forsen")),
            ("https://twitch.tv/Forsen", StreamerRef("twitch", "forsen")),
            ("https://www.twitch.tv/forsen/", StreamerRef("twitch", "forsen")),
            ("kick.com/xqc", StreamerRef("kick", "xqc")),
            ("https://kick.com/xQc", StreamerRef("kick", "xqc")),
            ("forsen", StreamerRef("twitch", "forsen")),
        ],
    )
    def test_parses_known_shapes(self, raw: str, expected: StreamerRef) -> None:
        assert parse_streamer(raw) == expected

    def test_bare_login_falls_back_to_kick_when_default_overridden(self) -> None:
        assert parse_streamer("xqc", default_provider="kick") == StreamerRef("kick", "xqc")

    @pytest.mark.parametrize(
        "raw",
        ["", "   ", "https://youtube.com/x", "twitch.tv/", "name with spaces"],
    )
    def test_rejects_garbage(self, raw: str) -> None:
        with pytest.raises(ValueError):
            parse_streamer(raw)


class TestWindowToRange:
    def test_week_yields_seven_day_span_ending_now(self) -> None:
        now = datetime(2026, 5, 4, 12, 0, 0, tzinfo=UTC)
        started, ended = window_to_range("week", now=now)
        assert ended == now
        assert (ended - started).days == 7

    def test_day_yields_one_day_span(self) -> None:
        now = datetime(2026, 5, 4, 12, 0, 0, tzinfo=UTC)
        started, ended = window_to_range("day", now=now)
        assert (ended - started).days == 1

    def test_month_yields_thirty_day_span(self) -> None:
        now = datetime(2026, 5, 4, 12, 0, 0, tzinfo=UTC)
        started, ended = window_to_range("month", now=now)
        assert (ended - started).days == 30
