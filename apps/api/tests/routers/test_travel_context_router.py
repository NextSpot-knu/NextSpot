from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers.travel_context import router


app = FastAPI()
app.include_router(router)


def test_parse_requires_confirmation_and_does_not_apply_context():
    response = TestClient(app).post(
        "/api/v1/travel-context/parse",
        json={"text": "비가 와서 10분 안쪽 실내 문화시설로 가고 싶어"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "context": {
            "categories": ["culture"],
            "max_walk_minutes": 10,
            "required_attributes": ["indoor"],
        },
        "llm_status": "keyword",
        "requires_confirmation": True,
    }


def test_parse_rejects_empty_or_oversized_text():
    client = TestClient(app)
    assert client.post("/api/v1/travel-context/parse", json={"text": ""}).status_code == 422
    assert client.post("/api/v1/travel-context/parse", json={"text": "가" * 301}).status_code == 422
