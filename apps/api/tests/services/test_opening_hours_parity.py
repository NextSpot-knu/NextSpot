"""휴무일·영업시간·가능 여부 판정 — 웹(apps/web/lib/restDate.ts)과 같은 사례 파일을 읽는 패리티 테스트.

사례 파일(tests/fixtures/opening_hours_parity.json)은 웹 테스트(lib/restDate.test.ts)도 그대로 읽는다.
서버만 고치거나 웹만 고치면 한쪽 테스트가 깨진다 — 카드가 '영업' 이라 말하는 곳을 추천이 '휴무' 로 빼는
일(또는 그 반대)이 다시 생기지 않게 하려는 것이다.
"""
import json
from datetime import datetime
from pathlib import Path

import pytest

from app.services.tourapi.transform import parse_availability_text
from app.services.travel_context import closed_day_status, open_status_at_arrival

CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "opening_hours_parity.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", CASES["closed_day"], ids=lambda case: f"{case['text']}@{case['at']}")
def test_closed_day_status_matches_shared_cases(case):
    assert closed_day_status(case["text"], datetime.fromisoformat(case["at"])) == case["expected"]


@pytest.mark.parametrize("case", CASES["arrival"], ids=lambda case: f"{case['hours']}@{case['at']}")
def test_arrival_status_matches_shared_cases(case):
    facility = {"operating_hours": case["hours"]}
    assert open_status_at_arrival(facility, datetime.fromisoformat(case["at"])) == case["expected"]


@pytest.mark.parametrize("case", CASES["availability"], ids=lambda case: repr(case["text"]))
def test_availability_text_matches_shared_cases(case):
    assert parse_availability_text(case["text"]) is case["expected"]


def test_shared_cases_cover_the_reported_sunday_regression():
    # 2026-10-31 재현: '매주 월요일 휴무' 가게가 일요일에 closed_confirmed 였다. 사례 파일에서 이 줄이
    # 빠지면 버그가 돌아와도 두 테스트 모두 초록이다.
    sunday = [case for case in CASES["closed_day"] if case["at"].startswith("2026-11-01")]
    assert any(case["text"] == "매주 월요일 휴무" and case["expected"] == "open" for case in sunday)
