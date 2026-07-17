# 음성 의도 서비스 — '자세히/메뉴' 응답이 후보 실데이터로 구성되는지 검증.
# 배경(2026-07-17 Codex 리뷰 P1): 프런트가 후보에 menu(공식 first_menu/treat_menu 결합)를 동봉하기
# 시작했는데 _details_spoken 이 menu 를 읽지 않아 "메뉴 뭐 있어?" 에 종류만 답하고 있었다.

from app.services.voice_intent_service import _details_spoken, _keyword_interpret, _menu_str


_CANDIDATES = [
    {
        "id": "f1",
        "name": "카페능",
        "cuisine": "카페·디저트",
        "menu": "바닐라라떼 / 아메리카노 / 카페라떼 / 플랫화이트",
        "congestion": 0.3,
        "distance_m": 200,
    },
    {"id": "f2", "name": "피자옥", "congestion": 0.6, "distance_m": 400},
]


def test_details_spoken_includes_menu_when_present():
    # 1. 후보에 menu 가 있으면 대표 메뉴를 앞 2개까지 실제 데이터로 안내한다.
    spoken = _details_spoken("카페능", _CANDIDATES)
    assert spoken is not None
    assert "대표 메뉴는 바닐라라떼, 아메리카노입니다." in spoken
    assert "종류는 카페·디저트입니다" in spoken  # 기존 종류 안내는 그대로 유지


def test_details_spoken_without_menu_unchanged():
    # 2. menu 없는 후보는 기존 문장 그대로 — 지어내지 않는다(회귀 0).
    spoken = _details_spoken("피자옥", _CANDIDATES)
    assert spoken == "피자옥은(는) 혼잡도 60%, 도보 6분입니다."


def test_menu_str_variants():
    # 3. 결합 문자열 파싱 — 앞 2개, 공백 정리, 빈 값/None 은 빈 문자열.
    assert _menu_str("바닐라라떼 / 아메리카노 / 라떼") == "바닐라라떼, 아메리카노"
    assert _menu_str("한우 트러플 & 페퍼로니 반반") == "한우 트러플 & 페퍼로니 반반"
    assert _menu_str("") == ""
    assert _menu_str(None) == ""
    assert _menu_str(" / ") == ""


def test_keyword_interpret_menu_question_routes_to_details_with_menu():
    # 4. "메뉴 뭐 있어?" → details 로 분류되고 spoken 에 실제 메뉴가 실린다(E2E 키워드 경로).
    result = _keyword_interpret("메뉴 뭐 있어?", "카페능", _CANDIDATES)
    assert result["action"] == "details"
    assert result["spoken"] is not None
    assert "바닐라라떼" in result["spoken"]
