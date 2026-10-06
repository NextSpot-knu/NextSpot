"""카드 '분' 정수 규칙(app/services/card_minutes.py) — 서버 문장과 웹 칩이 같은 분을 말하는가.

2026-10-06: 추천 사유만 대기를 올림으로 바꾸자, 웹 칩은 그대로 반올림이라 대기 9.2분이 같은 카드에서
칩 '9분' · 사유 '예상 대기 10분' 으로 갈렸다. 규칙을 서버가 따로 정하면 이런 일이 다시 생기므로,
웹 소스의 규칙이 이 모듈이 옮긴 규칙과 같은지 아래 패리티 테스트가 대조한다.
"""
import re
from pathlib import Path

import pytest

from app.services.card_minutes import wait_minutes, walk_minutes

WEB = Path(__file__).resolve().parents[4] / "apps" / "web"


@pytest.mark.parametrize(
    ("minutes", "shown"),
    [(0, 1), (0.3, 1), (1.0, 1), (2.2, 3), (2.5, 3), (4.0, 4), (12.01, 13)],
)
def test_walk_minutes_rounds_up_with_one_minute_floor(minutes, shown):
    assert walk_minutes(minutes) == shown


@pytest.mark.parametrize(
    ("minutes", "shown"),
    # JS Math.round 와 같다 — .5 는 올린다(파이썬 round(2.5)=2, round(0.5)=0 과 다르다).
    [(0, 0), (0.4, 0), (0.5, 1), (2.5, 3), (9.2, 9), (9.5, 10), (12.0, 12)],
)
def test_wait_minutes_matches_js_math_round(minutes, shown):
    assert wait_minutes(minutes) == shown


def _web_source(*parts: str) -> str:
    path = WEB.joinpath(*parts)
    if not path.exists():
        pytest.skip(f"{path} 부재(모노레포 밖 실행) — 패리티 검증 생략")
    return path.read_text(encoding="utf-8")


_CHANGE_TOGETHER = "웹 규칙이 바뀌었다면 app/services/card_minutes.py 도 같은 릴리스에서 바꿀 것"


def test_walk_rule_matches_web_display_walking_minutes():
    text = _web_source("lib", "recommender.ts")
    body = re.search(r"export function displayWalkingMinutes\([\s\S]*?\n}", text)
    assert body, "recommender.ts 에서 displayWalkingMinutes 를 찾지 못했다(이름이 바뀌었다면 이 테스트도 고칠 것)"
    assert "return Math.max(1, Math.ceil(resolved));" in body.group(0), _CHANGE_TOGETHER


def test_wait_rule_matches_explore_recommend_card():
    # 서버 추천 사유가 글자로 찍히는 곳 — 같은 카드의 대기 칸이 max(1, Math.round(대기)) 다.
    text = _web_source("app", "explore", "recommend", "page.tsx")
    assert "locale === 'ko' && rec.reason ? rec.reason" in text, "추천 사유가 찍히는 자리가 바뀌었다 — 이 테스트도 고칠 것"
    assert re.search(r"Math\.max\(1, Math\.round\(rawWait\)\)", text), _CHANGE_TOGETHER


def test_minutes_rule_matches_top3_comparison_row():
    # 비교 답변(recommendation_explanation_service) 바로 위 '도보·대기' 줄.
    text = _web_source("components", "RecommendationComparison.tsx")
    assert "displayWalkingMinutes(r.breakdown.travelTime, r.distanceM)" in text, _CHANGE_TOGETHER
    assert "Math.round(r.breakdown.waitTime)" in text, _CHANGE_TOGETHER
