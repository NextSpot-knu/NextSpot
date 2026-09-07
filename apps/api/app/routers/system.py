"""공개 시스템 설정 라우터 — 관광객 앱이 **인증 없이** 읽는 운영 스위치.

배경: system_settings 의 maintenance_mode / notice_text / congestion_threshold 는
설정 화면과 그 저장 API 말고는 저장소 어디에서도 읽히지 않았다. 그런데 관리자 화면은
'점검 모드를 활성화하면 사용자들의 앱 접속이 제한되고' 라고 단언했다. 장애 때 관리자가
점검 모드를 켜고 접속이 차단됐다고 믿지만, 관광객 앱은 그대로 열려 있었다.
이 엔드포인트가 그 배선의 서버 쪽 절반이다(관광객 앱 쪽 소비는 별도 작업).

## 왜 백엔드를 거치는가 — anon 은 이 표를 못 읽는다

system_settings 의 SELECT 정책(20260602120000 의 select_settings)은 `TO authenticated` 다.
관광객 앱은 익명 세션을 쓰므로 대개 authenticated 이지만, **세션 부트스트랩 전(첫 렌더)**
이나 세션 발급 실패 시에는 anon 이다. 점검 안내는 바로 그 순간에 가장 필요하다 —
그래서 service_role 로 읽어 인증 없이 내려보낸다.

## 무엇을 내보내지 않는가

`select("*")` 를 쓰지 않고 세 컬럼을 **이름으로 지정해** 읽는다. 이 표에는
merchant_console_enabled 같은 내부 스위치가 이미 있고 앞으로도 늘어난다. `*` 로 읽어
필드를 골라 내보내는 방식은 컬럼이 하나 늘 때마다 아무도 모르게 공개되는 구조다
(congestion_logs 가 정확히 그렇게 샜다 — 20260905090000 참조).

## 조회 실패는 '점검 중' 이 아니다

가장 중요한 결정이다. 설정 조회에 실패했을 때 maintenanceMode=true 로 폴백하면,
**설정 표 장애 한 번이 전 사용자에게 서비스 중단 안내를 띄운다.** 실제로는 앱이 멀쩡히
도는데도 그렇다. 그래서 fail-open 이다 — 읽지 못하면 '점검 아님' 으로 둔다
(core/authz.py 의 require_merchant_console_enabled 가 같은 이유로 같은 선택을 했다).

대신 그 사실을 숨기지도 않는다. `source` 가 값의 출처를 말한다:
  · "live"        — 방금 DB 에서 읽었다
  · "stale_cache" — 조회에 실패해 **직전에 성공한 값**을 그대로 쓴다(TTL 이 지났어도)
  · "fallback"    — 성공한 적이 한 번도 없다. 아래 기본값이며 실제 설정이 아니다
소비하는 쪽은 source != "live" 를 보고 '설정을 못 읽는 중' 을 알 수 있다.
"""
import asyncio
import time

import structlog
from fastapi import APIRouter, Response

from app.core.supabase import supabase_admin

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/system", tags=["system"])

# 60초 TTL. 관광객 앱이 화면 전환마다 두드려도 DB 왕복은 분당 1회로 묶인다.
# 점검 안내가 최대 60초 늦게 뜨는 것은 감수한다 — 이 표는 사람이 손으로 바꾸는 설정이고,
# 그 대가로 장애 시 설정 조회가 트래픽을 증폭시키지 않는다.
_CACHE_TTL_SECONDS = 60.0

# 캐시 형식: (성공 시각(monotonic), payload). 저장소의 기존 TTL 캐시 관용구
# (services/tourism_related_service.py 의 _cache/_lock)를 그대로 따른다.
_cache: tuple[float, dict] | None = None
_lock = asyncio.Lock()

# 한 번도 읽지 못했을 때의 값. **실제 설정이 아니다**(source="fallback" 이 그렇게 말한다).
#  · maintenanceMode=False — 위 'fail-open' 결정.
#  · noticeText="" — 공지 없음. 지어낸 문구를 띄우지 않는다.
#  · congestionThreshold=75 — 프런트 분류 함수가 지금 하드코딩하고 있는 '혼잡' 경계와
#    같은 값이다(0.25/0.5/0.75 중 마지막). 즉 폴백은 **지금 화면이 이미 하는 동작**이라
#    설정을 못 읽었다고 등급 기준이 갑자기 달라지지 않는다.
#    (참고: DB 컬럼 기본값은 80 이라 실제 저장값과 다르다 — 보고서의 사람 판단 항목.)
_FALLBACK_THRESHOLD = 75
_FALLBACK: dict = {
    "maintenanceMode": False,
    "noticeText": "",
    "congestionThreshold": _FALLBACK_THRESHOLD,
}


def _normalize(row: dict) -> dict:
    """DB 행 → 공개 payload. 세 키만 만들고 값의 타입을 강제한다.

    타입 강제가 필요한 이유: 이 값들은 그대로 관광객 앱의 분기 조건이 된다. 컬럼이
    NULL 이거나 예상 밖 타입이면 프런트에서 조용히 falsy/NaN 이 되므로 여기서 막는다.
    """
    threshold = row.get("congestion_threshold")
    try:
        threshold = int(threshold)
    except (TypeError, ValueError):
        threshold = _FALLBACK_THRESHOLD
    return {
        "maintenanceMode": bool(row.get("maintenance_mode")),
        "noticeText": str(row.get("notice_text") or ""),
        # DB CHECK(0~100)와 같은 범위로 한 번 더 조인다 — 화면 슬라이더는 50~100 이지만
        # 컬럼은 0~100 이라, 범위 밖 값이 등급 경계로 쓰이는 일만 막으면 된다.
        "congestionThreshold": max(0, min(threshold, 100)),
    }


async def _load_public_settings() -> dict:
    """공개 설정 payload 를 돌려준다. **절대 예외를 던지지 않는다.**

    이 엔드포인트가 500 을 내면 관광객 앱은 '설정을 읽지 못함' 과 '서버가 죽음' 을 구분할
    수 없고, 어느 쪽이든 화면은 같은 실패로 떨어진다. 여기서는 항상 무언가를 돌려주되
    그것이 무엇인지(source)를 함께 말한다.
    """
    global _cache
    now = time.monotonic()
    if _cache and now - _cache[0] < _CACHE_TTL_SECONDS:
        return {**_cache[1], "source": "live"}

    async with _lock:
        # 락 안에서 다시 확인 — 동시 요청이 같은 조회를 중복 실행하지 않게(single-flight).
        now = time.monotonic()
        if _cache and now - _cache[0] < _CACHE_TTL_SECONDS:
            return {**_cache[1], "source": "live"}
        try:
            res = await asyncio.to_thread(
                supabase_admin.table("system_settings")
                # ⚠️ 절대 select("*") 로 바꾸지 말 것 — 위 모듈 주석의 '무엇을 내보내지 않는가'.
                .select("maintenance_mode, notice_text, congestion_threshold")
                # system_settings 는 단일 행(id=1) 계약이라 limit(1) 은 의도된 상한이다.
                .eq("id", 1).limit(1).execute
            )
        except Exception as exc:
            logger.warning("public_settings_fetch_failed", error=str(exc))
            if _cache:
                # 직전 성공값을 그대로 쓴다. TTL 이 지났어도 '아무것도 모름' 보다 낫다 —
                # 설정은 분 단위로 바뀌는 값이 아니고, 낡았다는 사실은 source 가 말한다.
                return {**_cache[1], "source": "stale_cache"}
            return {**_FALLBACK, "source": "fallback"}

        rows = res.data or []
        if not rows:
            # 행이 없다 = 마이그레이션 미적용. 실패와는 다르지만 **읽을 설정이 없다**는
            # 점은 같으므로 폴백과 같은 값을 쓰되, 캐시에 넣지 않는다(행이 생기면 바로 읽게).
            logger.warning("public_settings_row_missing")
            return {**_FALLBACK, "source": "fallback"}

        payload = _normalize(rows[0])
        _cache = (now, payload)
        return {**payload, "source": "live"}


@router.get("/public-settings")
async def get_public_settings(response: Response):
    """공개 시스템 설정 — 인증 없음, 60초 캐시.

    반환: { maintenanceMode, noticeText, congestionThreshold, source }

    · maintenanceMode — **접속을 막는 플래그가 아니다.** 이 앱은 정적 export 라 서버가
      요청을 가로챌 수 없다. 이 값으로 할 수 있는 일은 '점검 안내를 전면에 띄우는 것'
      뿐이다(관리자 화면의 설명 문구도 그렇게 고쳤다).
    · noticeText — 앱 상단 고정 공지. 빈 문자열이면 띄우지 않는다.
    · congestionThreshold — '혼잡(Red)' 등급의 **경계값(%)**. 혼잡도 0~1 스케일로는
      threshold/100 이다(75 → 0.75). 프런트 분류 함수가 지금 0.25/0.5/0.75 로 하드코딩한
      마지막 경계가 이 값에 해당한다. 나머지 두 경계(여유/보통)는 이 설정이 정하지 않는다 —
      관리자 화면이 조정하는 것은 '혼잡' 하나뿐이기 때문이다.
    """
    payload = await _load_public_settings()
    # 서버 TTL 과 같은 60초. 이 응답은 사용자별로 달라지지 않으므로 공유 캐시도 허용한다.
    response.headers["Cache-Control"] = "public, max-age=60"
    return payload
