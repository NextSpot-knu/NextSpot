import logging
import re
import sys
import structlog

# ── 외부 HTTP 클라이언트의 요청 로그 ─────────────────────────────────────────────
# httpx 는 INFO 로 요청마다 `HTTP Request: GET <전체 URL> "HTTP/1.1 200 OK"` 를 남긴다. 루트가 INFO 라
# 전부 Render 로그로 나갔다:
#  · 공공데이터포털 키가 쿼리스트링(serviceKey=…)에 실린다 — TourAPI·기상청·주차·경주 음식점 호출마다
#    키 원문이 로그에 남았다(tourapi/client.py · weather_service.py · parking_demand_service.py ·
#    gyeongju_restaurant_service.py).
#  · Supabase 호출의 URL 에는 수백 개짜리 id IN 목록이 실린다 — 지도 한 번에 약 72KB 의 로그.
# 오류(WARNING 이상)는 그대로 남긴다. 요청 성공 줄만 끈다.
_QUIET_HTTP_LOGGERS = ("httpx", "httpcore")

# 로그 문자열 어디에 있든(예외 메시지에 섞인 URL 포함) 키 값만 가린다. 파라미터 이름은 남겨 무엇이
# 가려졌는지는 보이게 한다. URL 인코딩된 '='(%3D)와 값(%2B 등)도 같이 잡는다.
_SECRET_QUERY_RE = re.compile(r"(?i)\b((?:servicekey|authkey)(?:=|%3D))[^&\s\"'\\<>]+")


def redact_secret_query_params(message: str) -> str:
    """문자열 속 serviceKey=/authKey= 값을 [redacted] 로 바꾼다."""
    return _SECRET_QUERY_RE.sub(r"\1[redacted]", message)


class RedactSecretQueryParamsFilter(logging.Filter):
    """핸들러 필터 — 어느 로거에서 온 레코드든 출력 직전에 키 값을 가린다. 레코드는 버리지 않는다."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
            redacted = redact_secret_query_params(message)
            if redacted != message:
                record.msg = redacted
                record.args = ()
        except Exception:  # noqa: BLE001 — 로그 가공 실패가 요청 처리를 깨뜨리면 안 된다
            pass
        return True


def add_log_severity(logger, name, event_dict):
    """
    structlog의 level을 표준 severity 필드(DEBUG/INFO/WARNING/ERROR/CRITICAL)로 복사 및 매핑합니다.
    """
    level = event_dict.get("level")
    if level:
        # 표준 severity 매핑
        mapping = {
            "debug": "DEBUG",
            "info": "INFO",
            "warning": "WARNING",
            "warn": "WARNING",
            "error": "ERROR",
            "critical": "CRITICAL",
            "fatal": "CRITICAL"
        }
        event_dict["severity"] = mapping.get(level.lower(), "INFO")
    return event_dict

def setup_logging():
    """
    structlog를 활용한 JSON 포맷팅 로그 시스템을 초기화합니다.
    """
    # 기본 표준 logging 설정 설정
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=logging.INFO,
    )
    for name in _QUIET_HTTP_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    for handler in logging.getLogger().handlers:
        if not any(isinstance(f, RedactSecretQueryParamsFilter) for f in handler.filters):
            handler.addFilter(RedactSecretQueryParamsFilter())

    # structlog 프로세서 체인 구성
    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            # severity 필드 추가
            add_log_severity,
            # JSON 로그 형식으로 내보내기
            structlog.processors.JSONRenderer()
        ],
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

