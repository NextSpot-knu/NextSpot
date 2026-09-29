"""사람이 숨긴 시설 — 밤 적재가 다시 켜지 않게 하는 표시.

PM 이 SQL 로 is_active=false 를 준 행(중복 카드·운영시간 없는 장소 등)을 적재 배치가 다음 밤 다시 켠 전례가 있다:
Kakao 보완 배치는 검색에 다시 잡힌 행마다 is_active 를 새로 쓰고, TourAPI showflag 동기화는 표출('1') 행을 복구하고,
LOCALDATA 동기화는 영업('01') 근거로 복구한다. 그래서 숨김은 is_active=false 와 함께
features.manual_hidden = {"reason": "...", "decided": "YYYY-MM-DD"} 로 남기고, 세 배치는 이 표시가 있으면 켜지 않는다.
표시를 지우면(키 삭제) 다음 밤부터 원래 규칙대로 돌아간다.
"""

from __future__ import annotations

from typing import Any

MANUAL_HIDDEN_KEY = "manual_hidden"


def is_manually_hidden(features: Any) -> bool:
    """features.manual_hidden 이 비어 있지 않으면 True(값의 모양은 따지지 않는다 — 사람이 남긴 표시)."""
    return isinstance(features, dict) and bool(features.get(MANUAL_HIDDEN_KEY))
