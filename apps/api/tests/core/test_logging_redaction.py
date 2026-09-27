"""httpx 요청 로그 끄기 + 쿼리스트링 키 가리기(P0a).

httpx 는 INFO 로 요청마다 전체 URL 을 남긴다. 공공데이터포털 키(serviceKey=…)가 쿼리에 실리고,
Supabase URL 에는 수백 개짜리 id IN 목록이 실려 Render 로그로 그대로 나갔다.
"""
import logging

from app.core.logging import (
    RedactSecretQueryParamsFilter,
    redact_secret_query_params,
    setup_logging,
)


def test_httpx_and_httpcore_request_lines_are_quiet():
    setup_logging()
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() >= logging.WARNING
    # 오류는 그대로 남는다 — 끄는 것은 요청 성공 줄(INFO)뿐이다.
    assert logging.getLogger("httpx").isEnabledFor(logging.WARNING)


def test_root_handlers_carry_the_redaction_filter_once():
    setup_logging()
    setup_logging()  # 두 번 불러도 필터가 겹치지 않는다
    handlers = logging.getLogger().handlers
    assert handlers
    for handler in handlers:
        count = sum(isinstance(f, RedactSecretQueryParamsFilter) for f in handler.filters)
        assert count <= 1


def test_redacts_plain_and_url_encoded_keys_but_keeps_other_params():
    url = (
        "https://apis.data.go.kr/B551011/KorService2/areaBasedList2"
        "?serviceKey=abc%2Bdef%3D%3D&pageNo=1&numOfRows=100&MobileOS=ETC"
    )
    out = redact_secret_query_params(f'HTTP Request: GET {url} "HTTP/1.1 200 OK"')
    assert "abc" not in out
    assert "serviceKey=[redacted]&pageNo=1&numOfRows=100" in out

    assert redact_secret_query_params("x?authKey=SECRET123") == "x?authKey=[redacted]"
    assert redact_secret_query_params("q?SERVICEKEY%3Dsecret&a=1") == "q?SERVICEKEY%3D[redacted]&a=1"
    # JSON 로그 안의 문자열(따옴표로 끝남)에서도 값만 가린다.
    assert redact_secret_query_params('{"error": "GET /x?serviceKey=k1"}') == '{"error": "GET /x?serviceKey=[redacted]"}'
    # 키가 없으면 그대로.
    plain = "GET https://example.supabase.co/rest/v1/facilities?select=id"
    assert redact_secret_query_params(plain) == plain


def test_filter_rewrites_record_and_never_drops_or_raises():
    f = RedactSecretQueryParamsFilter()
    record = logging.LogRecord("httpx", logging.WARNING, __file__, 1, "GET %s", ("/x?serviceKey=zzz",), None)
    assert f.filter(record) is True
    assert record.getMessage() == "GET /x?serviceKey=[redacted]"

    broken = logging.LogRecord("x", logging.INFO, __file__, 1, "%d", ("not-a-number",), None)
    assert f.filter(broken) is True  # 포맷 실패도 레코드를 버리거나 예외를 올리지 않는다
