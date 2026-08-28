"""최근 실패를 프로세스 안에 잠깐 담아 두는 링버퍼.

Render 로그를 볼 수 없는 상황에서 프로덕션 예외의 **정체**를 확인하기 위한 진단 통로다.
개발자 콘솔(/api/v1/dev/failures)에서만 읽는다.

의도적으로 작고 휘발성이다 — DB 스키마도 외부 의존도 없고, 재시작하면 사라진다.
영구 보관이 필요해지면 그때 제대로 된 관측 도구를 붙일 일이지 이걸 키울 일이 아니다.
"""
import threading
import time
from collections import deque

_MAX = 50
_lock = threading.Lock()
_entries: deque[dict] = deque(maxlen=_MAX)


def record_failure(kind: str, error: BaseException, **context) -> None:
    """실패 하나를 기록한다. 절대 예외를 던지지 않는다(진단이 본류를 깨면 안 된다)."""
    try:
        with _lock:
            _entries.append({
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "kind": kind,
                "error_type": type(error).__name__,
                "error": str(error)[:300],
                "context": {k: str(v)[:120] for k, v in context.items()},
            })
    except Exception:
        pass


def recent_failures(limit: int = 50) -> list[dict]:
    with _lock:
        return list(_entries)[-limit:][::-1]
