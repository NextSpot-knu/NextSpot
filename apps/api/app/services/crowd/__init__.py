"""구역 혼잡 데이터 계층 — 공급원이 무엇이든 엔진은 정규화된 `CrowdObservation` 하나만 본다.

`docs/SEOUL_TESTBED_PLAN.md` §3. 지금 공급원은 서울 실시간 도시데이터(`seoul_provider`)이고, 경주
통신사 데이터는 나중에 **어댑터 1개 + 구역 정의 + 설정**으로 붙는다(G3).

  · `observation` — 데이터 모양(`Zone` · `CrowdObservation` · `CrowdForecast` · `ProviderDescription`)과
    공급원 인터페이스(`CrowdProvider`). DB·네트워크 없음.
  · `seoul_provider` — 서울 citydata 응답 → `CrowdObservation`. 서울 9곳 구역 정의(마이그레이션 시드와 같다).
  · `store` — `zone_crowd_snapshots` 저장(표가 아직 없어도 수집을 막지 않는다).
"""

from app.services.crowd.observation import (
    CrowdForecast,
    CrowdObservation,
    CrowdProvider,
    ProviderDescription,
    Zone,
)

__all__ = [
    "CrowdForecast",
    "CrowdObservation",
    "CrowdProvider",
    "ProviderDescription",
    "Zone",
]
