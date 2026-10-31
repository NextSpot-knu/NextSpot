"""정규화된 구역 혼잡 관측과 공급원 인터페이스 — 순수 데이터 모양만 둔다(DB·네트워크 없음).

`docs/SEOUL_TESTBED_PLAN.md` §3.1 · §3.2. 추천 엔진(S3 이후)은 공급원이 서울 공공 API 인지 경주
통신사인지 몰라야 한다. 그래서 공급원마다 다른 것(인원 단위·등급 눈금·예측 유무·집계 주기)은 전부
이 모양 안의 **값**으로 들어오고, 모양 자체는 바뀌지 않는다.

## 규칙
  · 실패는 예외가 아니라 **관측 없음**이다(`fetch_current` 가 그 구역을 빼고 돌려준다). 엔진이 공급원
    장애로 죽지 않게 하는 경계가 여기다.
  · `level` 은 0~1 이고, 공급원의 원래 등급은 `level_label`·`level_scale` 로 함께 남긴다 — 환산 방식이
    바뀌어도 원래 값으로 되돌아갈 수 있게.
  · 인원은 범위(`population_min/max`)와 점 추정(`population_point`)을 따로 둔다. 서울은 범위만 주고,
    통신사는 점 추정만 줄 수 있다. 없는 값은 지어내지 않고 None 이다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Protocol, Sequence, runtime_checkable

# zones.kind 의 CHECK 와 같은 목록(마이그레이션 테스트가 대조한다).
ZONE_KINDS = ("hotspot_polygon", "grid_cell", "admin_area")


@dataclass(frozen=True)
class Zone:
    """구역 정의 한 줄(`zones` 표 한 행과 같은 모양).

    `provider_zone_name` 은 공급원에 요청할 때 쓰는 이름이다(서울은 이름으로 호출한다).
    `radius_m` 은 다각형이 아직 없을 때 쓰는 둘레 근사(같은 넓이의 원 반지름)다.
    """

    zone_id: str
    region: str
    kind: str
    name: str
    provider: str
    provider_zone_code: str | None
    provider_zone_name: str | None
    cluster: str | None
    centroid_lat: float
    centroid_lng: float
    radius_m: int | None = None


@dataclass(frozen=True)
class CrowdForecast:
    """공급원이 준 대상 시각별 예측 한 점. 공급원이 예측을 주지 않으면 만들지 않는다."""

    zone_id: str
    source: str
    issued_at: datetime
    target_at: datetime
    population_min: int | None = None
    population_max: int | None = None
    level: float | None = None
    level_label: str | None = None


@dataclass(frozen=True)
class CrowdObservation:
    """구역 × 시각 혼잡 관측 한 건(§3.2).

    · `observed_at` — 공급원이 집계한 시각(서울 `PPLTN_TIME`). 우리가 받은 시각은 `fetched_at`.
    · `period_seconds` — 공급원 집계 단위(서울 약 5분 · 통신사는 계약값). 모르면 None.
    · `quality` — 공급원·표본·결측·지연 플래그. 키는 자유지만 값은 JSON 으로 저장 가능해야 한다.
    """

    zone_id: str
    source: str
    observed_at: datetime
    fetched_at: datetime
    level_scale: str
    period_seconds: int | None = None
    population_min: int | None = None
    population_max: int | None = None
    population_point: float | None = None
    level: float | None = None
    level_label: str | None = None
    forecast: tuple[CrowdForecast, ...] = ()
    quality: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.level is not None and not 0.0 <= self.level <= 1.0:
            raise ValueError("level must be within 0..1")
        if (
            self.population_min is not None
            and self.population_max is not None
            and self.population_min > self.population_max
        ):
            raise ValueError("population_min must not exceed population_max")


@dataclass(frozen=True)
class ProviderDescription:
    """공급원 명세(§3.1 `describe()`). 통신사 계약 명세(§5)의 항목과 같은 이름을 쓴다."""

    source: str
    region: str
    cadence_seconds: int
    expected_latency_seconds: int | None
    spatial_resolution: str
    level_scale: str
    provides_forecast: bool
    provides_history: bool
    license: str


@runtime_checkable
class CrowdProvider(Protocol):
    """구역 혼잡 공급원. 지역마다 하나를 설정으로 고른다(서울: `SeoulCitydataProvider`)."""

    source: str

    def describe(self) -> ProviderDescription:
        ...

    async def fetch_current(self, zones: Sequence[Zone]) -> list[CrowdObservation]:
        """구역별 현재 관측. 실패한 구역은 **빠진다**(예외 없음)."""
        ...

    async def fetch_forecast(self, zones: Sequence[Zone], horizon: timedelta) -> list[CrowdForecast]:
        """구역별 예측(선택). 예측을 주지 않는 공급원은 빈 목록을 돌려준다."""
        ...


def forecasts_within(
    observations: Sequence[CrowdObservation], horizon: timedelta
) -> list[CrowdForecast]:
    """관측에 딸려 온 예측 가운데 관측 시각부터 `horizon` 안의 것만 모은다(순서 유지)."""
    selected: list[CrowdForecast] = []
    for observation in observations:
        limit = observation.observed_at + horizon
        selected.extend(item for item in observation.forecast if item.target_at <= limit)
    return selected
