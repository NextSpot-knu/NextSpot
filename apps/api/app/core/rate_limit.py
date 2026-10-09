"""인메모리 IP 레이트리밋 — 라우터 둘 이상이 쓰는 공용 헬퍼(AGENTS.md "횡단 관심사는 app/core").

원래 `routers/search.py`의 `_client_ip`·`_check_rate_limit`·`_rate_limit_or_429` 였다. 동작은 그대로
옮겼고(search 는 같은 이름으로 다시 import 한다), 비인증·게스트 LLM 경로(`/travel-context/parse`·
`/preferences/parse`, HANDOVER 보안 진단 '상')가 같은 키·같은 윈도우로 재사용한다.

전제: 단일 인스턴스(Render 512MB 1대) — 저장소는 프로세스 메모리라 재기동 시 리셋되고, 다중 인스턴스로
늘리면 공유 저장소로 승격해야 한다(reports.py/tracking.py 와 같은 전제).

⚠️ XFF 방향 미검증: `client_ip`는 X-Forwarded-For 의 **마지막 값**을 쓴다(첫 값은 클라이언트가 위조 가능).
운영 경로(Cloudflare/Render 엣지)에서 마지막 값이 실제 방문자 IP 인지, 엣지 노드 IP 인지는 실측하지 않았다.
엣지 IP 라면 여러 방문자가 한 키를 공유해 제한이 '사이트 전체 합계'처럼 동작한다 — 그래서 이 키를 쓰는
한도는 사람 한 명의 속도보다 넉넉하게 잡고, 초과 시에도 화면이 결정적 경로로 계속 동작하게 둔다.
"""

import time
from typing import Optional

from fastapi import HTTPException, Request

RATE_LIMIT_WINDOW_SEC = 60.0


def client_ip(request: Request) -> str:
    """레이트리밋 키용 클라이언트 IP.

    ⚠️ XFF 의 '첫 값'은 클라이언트가 위조 가능하다(프록시는 뒤에 append) — 요청마다 다른
    가짜 첫 값으로 분당 제한을 무한 우회할 수 있다. 신뢰 프록시(Render 엣지)가 마지막에
    덧붙인 값이 실제 피어이므로 **마지막 항목**을 쓴다(recommendations._voice_client_ip 미러,
    §-14 백로그 'XFF 첫 값' 정리). 프록시 없는 로컬은 소켓 피어.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


def check_rate_limit(store: dict[str, list[float]], ip: str, limit: int) -> Optional[int]:
    """분당 limit회 슬라이딩 윈도우 레이트리밋.

    통과 시 None, 초과 시 재시도까지 남은 초(Retry-After 헤더용, 최소 1)를 반환한다.
    초과 요청의 타임스탬프는 기록하지 않는다(연속 초과 요청으로 윈도우가 계속 밀리는 것 방지).
    """
    now = time.monotonic()
    hits = [t for t in store.get(ip, []) if now - t < RATE_LIMIT_WINDOW_SEC]
    if len(hits) >= limit:
        store[ip] = hits
        return max(1, int(RATE_LIMIT_WINDOW_SEC - (now - hits[0])))
    hits.append(now)
    store[ip] = hits
    return None


def rate_limit_or_429(store: dict[str, list[float]], ip: str, limit: int, message: str) -> None:
    retry_after = check_rate_limit(store, ip, limit)
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=message,
            headers={"Retry-After": str(retry_after)},
        )
