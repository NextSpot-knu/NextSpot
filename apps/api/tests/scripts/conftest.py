"""tests/scripts 공통 픽스처."""

import pytest


@pytest.fixture(autouse=True)
def _no_actions_step_summary(monkeypatch):
    """CI 러너가 늘 설정하는 GITHUB_STEP_SUMMARY 를 지운다 — 적재 스크립트를 부르는 테스트가
    CI 실행 Summary 에 가짜 'TourAPI 적재' 줄을 남기지 않게. 이 값을 보는 테스트는 스스로 tmp 경로를 준다."""
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
