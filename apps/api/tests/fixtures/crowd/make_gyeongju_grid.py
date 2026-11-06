"""합성 경주 격자 픽스처 생성기 — 통신사 격자 어댑터 템플릿·공급원 계약 테스트용.

**실제 통신사 데이터가 아니다.** 숫자는 전부 이 파일의 규칙(하루 모양 × 요일 계수 × 고정 씨앗 잡음)으로
만든 합성값이다. 형식은 `docs/CROWD_DATA_CONTRACT.md` §8 '기준 전달 형식'(`nextspot.crowd_grid.v1`)을 따른다.

  · 격자: 황리단길 기준점(35.8361, 129.2105 — `.env.example` · `weather_service` 와 같은 점)에서 시작하는
    100m 칸 2행 × 2열 = 4칸(기준점이 `G100-0-0` 의 중심). 칸 ID 는 `G100-<행>-<열>`. 파일을 작게 두려고
    칸 수를 줄였다 — 많은 칸·긴 기간이 필요한 테스트는 `build_payload(days=…)` 를 메모리에서 부른다.
  · 기간: 2026-10-23(금) ~ 10-25(일) KST, 10분 집계(하루 144행/칸).
  · 하루 모양: 밤 낮고 14~15시 정점(+ 저녁 작은 봉우리). 금 0.7 · 토 1.0 · 일 0.9.
  · 결측: 칸별 무작위 약 2% + 10-24(토) 12:00~12:20 전 칸 끊김(3버킷).
  · 표본 적은 칸: `G100-1-1`(가장자리 주거지 가정). 정점 약 12명 — 전 행 `sample_flag=low` 와 넓은 신뢰구간,
    최소 인원(`min_count`=5) 미만이면 인원을 빼고 `masked`.

다시 만들기(apps/api 에서): `python tests/fixtures/crowd/make_gyeongju_grid.py`
테스트(`test_crowd_telecom_template.py`)가 커밋된 JSON 과 이 생성기 출력이 같은지 대조한다 — 둘 중 하나만
고치면 실패한다. 표준 라이브러리만 쓴다(`app` 을 import 하지 않는다).
"""

from __future__ import annotations

import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

KST = timezone(timedelta(hours=9))
CENTER_LAT = 35.8361
CENTER_LNG = 129.2105
CELL_SIZE_M = 100
PERIOD_SECONDS = 600
MIN_COUNT = 5
SEED = 20261031
START = datetime(2026, 10, 23, tzinfo=KST)
DAYS = 3
ROWS, COLS = 2, 2
LOW_SAMPLE_CELL = "G100-1-1"
# 금·토·일 계수(요일 0=월). 다른 요일은 평일 계수.
DAY_FACTOR = {4: 0.7, 5: 1.0, 6: 0.9}
WEEKDAY_FACTOR = 0.6
# 칸별 정점 인원(토요일 오후 기준). 0행이 황리단길 큰길 쪽.
PEAK = {
    "G100-0-0": 760.0,
    "G100-0-1": 380.0,
    "G100-1-0": 260.0,
    LOW_SAMPLE_CELL: 12.0,
}
OUTAGE = (datetime(2026, 10, 24, 12, 0, tzinfo=KST), datetime(2026, 10, 24, 12, 30, tzinfo=KST))
OUTPUT = Path(__file__).with_name("gyeongju_grid_synthetic.json")

_M_PER_DEG_LAT = 111_320.0


def _cell_id(row: int, col: int) -> str:
    return f"G100-{row}-{col}"


def cells() -> list[dict[str, Any]]:
    """칸 정의. 기준점이 G100-0-0 의 중심이고, 행은 남쪽·열은 동쪽으로 늘어난다."""
    dlat = CELL_SIZE_M / _M_PER_DEG_LAT
    dlng = CELL_SIZE_M / (_M_PER_DEG_LAT * math.cos(math.radians(CENTER_LAT)))
    out: list[dict[str, Any]] = []
    for row in range(ROWS):
        for col in range(COLS):
            lat = CENTER_LAT - row * dlat
            lng = CENTER_LNG + col * dlng
            out.append(
                {
                    "cell_id": _cell_id(row, col),
                    "centroid_lat": round(lat, 6),
                    "centroid_lng": round(lng, 6),
                    "bbox": [
                        round(lng - dlng / 2, 6),
                        round(lat - dlat / 2, 6),
                        round(lng + dlng / 2, 6),
                        round(lat + dlat / 2, 6),
                    ],
                }
            )
    return out


def daily_shape(hour: float) -> float:
    """0~1. 밤 0.06 바닥, 14:30 정점, 19:30 작은 봉우리."""
    main = math.exp(-(((hour - 14.5) / 3.4) ** 2))
    evening = 0.25 * math.exp(-(((hour - 19.5) / 1.5) ** 2))
    return min(1.0, 0.06 + 0.94 * main + evening)


def build_payload(*, start: datetime = START, days: int = DAYS, seed: int = SEED) -> dict[str, Any]:
    rng = random.Random(seed)
    rows: list[dict[str, Any]] = []
    steps = days * 24 * 3600 // PERIOD_SECONDS
    cell_ids = [cell["cell_id"] for cell in cells()]
    for step in range(steps):
        moment = start + timedelta(seconds=step * PERIOD_SECONDS)
        factor = DAY_FACTOR.get(moment.weekday(), WEEKDAY_FACTOR)
        hour = moment.hour + moment.minute / 60.0
        for cell_id in cell_ids:
            noise = rng.uniform(0.9, 1.1)
            dropped = rng.random() < 0.02
            if dropped or OUTAGE[0] <= moment < OUTAGE[1]:
                continue
            population = round(PEAK[cell_id] * factor * daily_shape(hour) * noise, 1)
            row: dict[str, Any] = {"cell_id": cell_id, "observed_at": moment.isoformat(timespec="minutes")}
            if cell_id == LOW_SAMPLE_CELL:
                if population < MIN_COUNT:
                    row["sample_flag"] = "masked"
                else:
                    row["population"] = population
                    row["population_low"] = round(population * 0.5, 1)
                    row["population_high"] = round(population * 1.6, 1)
                    row["sample_flag"] = "low"
            else:
                row["population"] = population
            rows.append(row)
    return {
        "format": "nextspot.crowd_grid.v1",
        "note": "합성 데이터 — 실제 통신사 데이터가 아니다(tests/fixtures/crowd/make_gyeongju_grid.py)",
        "source": "synthetic_gyeongju_grid",
        "region": "gyeongju",
        "cell_size_m": CELL_SIZE_M,
        "period_seconds": PERIOD_SECONDS,
        "min_count": MIN_COUNT,
        "cells": cells(),
        "rows": rows,
    }


def render(payload: dict[str, Any]) -> str:
    """한 행 = 한 줄(검토·diff 가 쉽게)."""
    head = {key: value for key, value in payload.items() if key not in ("cells", "rows")}
    lines = ["{"]
    for key, value in head.items():
        lines.append(f"  {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)},")
    for name in ("cells", "rows"):
        lines.append(f'  "{name}": [')
        items = payload[name]
        for index, item in enumerate(items):
            comma = "," if index < len(items) - 1 else ""
            lines.append("    " + json.dumps(item, ensure_ascii=False, separators=(",", ":")) + comma)
        lines.append("  ]," if name == "cells" else "  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    OUTPUT.write_text(render(build_payload()), encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT}")
