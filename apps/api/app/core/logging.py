import logging
import sys
import structlog

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

