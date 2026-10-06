"""카드에 찍히는 '분' 정수 규칙 — 서버 문장이 같은 카드의 웹 숫자와 같게 하기 위한 단일 출처.

서버가 만든 문장(추천 사유 · Top 3 비교 답변)이 바로 옆 웹 칩·표와 다른 분을 말하면 심사위원은 계산이
틀렸다고 읽는다. 그래서 규칙을 새로 정하지 않고 웹이 지금 쓰는 규칙을 그대로 옮긴다:
  - 도보: apps/web/lib/recommender.ts displayWalkingMinutes — 올림, 최소 1분.
  - 대기: 웹은 Math.round(.5 는 올림). 파이썬 round 는 짝수 쪽으로 보내(2.5→2) 같은 값이 1분 갈린다.
웹 규칙이 바뀌면(예: 계획 A4 의 대기 올림) 여기도 같은 릴리스에서 바뀌어야 한다 —
tests/services/test_card_minutes.py 가 웹 소스와 대조해 어긋나면 실패한다.
"""
import math


def walk_minutes(minutes: float) -> int:
    """도보 분 — 웹 displayWalkingMinutes 와 같다(올림, 0분도 1분)."""
    return max(1, math.ceil(minutes))


def wait_minutes(minutes: float) -> int:
    """대기 분 — 웹 Math.round 와 같다(.5 는 올림)."""
    return math.floor(minutes + 0.5)
