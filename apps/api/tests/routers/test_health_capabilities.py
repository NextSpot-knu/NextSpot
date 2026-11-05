"""/health 의 capabilities — region-guard 워크플로가 지역 격리를 아는 API 인지 확인한다."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.region import REGION_ISOLATION_VERSION
from app.main import app


def test_health_reports_region_isolation_capability():
    with TestClient(app) as client:
        for path in ("/health", "/"):
            body = client.get(path).json()
            assert body["status"] == "healthy"
            assert body["capabilities"] == {"region_isolation": REGION_ISOLATION_VERSION}
    assert REGION_ISOLATION_VERSION >= 1
