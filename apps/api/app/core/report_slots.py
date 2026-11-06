"""혼잡 '1인 1표' 자리 잡기 — 제보(reports)와 방문 확인 체감 혼잡(recommendations outcome) 공용.

규칙(2026-10-30 제보 경로에 도입, 10-31 게스트 방문 확인 답으로 확장 — PRODUCT_EVALUATION_PLAN §6 D3.
계정 사용자의 방문 확인 답에는 걸지 않는다):
  · 사용자·시설당 쿨다운(선택) — 같은 사람의 연타.
  · **IP·시설당 한 계정**(교차검증 창 30분) — 한 단말·한 와이파이에서 계정(게스트 세션 포함) 여러 개를 돌려
    '두 사람의 일치' 를 꾸미는 것. 교차검증은 30분 안의 서로 다른 계정 둘을 센다(DB 트리거
    correlate_congestion_report_evidence ±30분 · record_facility_availability_report 최근 30분). 그래서 IP 쪽을
    쿨다운 길이(5분·1분)로 걸면 두 번째 계정이 5분 1초 뒤에 보내 그대로 corroborated 가 된다 — 늦출 뿐 막지 못한다.
    같은 와이파이 일행의 두 번째 표도 막히지만, 같은 일행의 같은 관찰은 원래 '독립된 두 확인' 이 아니다.

혼잡 표(CONGESTION_VOTES_BY_IP)는 명시 제보가 쓰고, 게스트 방문 확인 답은 그 표를 읽기만 한다(아래 게스트 표 주석).
영업 상태 표는 따로다(다른 판정이다).

저장: 프로세스 메모리만(단일 인스턴스 데모 기준 — 다중 인스턴스는 Redis 등 공유 저장소로 승격). 원본 IP 는 이 표의
키로 메모리에만 있고(창 30분 + 걷기 주기 최대 1분 뒤 지운다 — _prune) DB·로그에 남기지 않는다.
IP 해석은 app/core/client_ip.py(XFF 마지막 값).

검사와 자리 잡기는 await 없이 한 번에 한다 — 사이에 await 가 있으면 동시에 들어온 두 계정이 둘 다 검사를 통과한다.
저장이 실패하면 호출부가 release_report_slot 으로 되돌린다(실패한 시도가 자리를 남기지 않게).
"""
import math
import time

from fastapi import HTTPException

CORROBORATION_WINDOW_SEC = 1800.0

SHARED_IP_DETAIL = "같은 네트워크에서 다른 계정이 이 장소를 이미 알려 주었어요. 잠시 후 다시 시도해 주세요."

# (IP, 시설) → (그 IP 에서 마지막으로 표를 낸 계정, monotonic 시각). 혼잡 제보 + 방문 확인 체감 혼잡 공용.
CONGESTION_VOTES_BY_IP: dict[tuple[str, str], tuple[str, float]] = {}
# 게스트 방문 확인 답 전용 표(그림자·실시간 모두). 게스트 답은 위 표를 **읽기만** 하고(계정 사용자가 이미 낸 IP·장소면
# 버린다) 자리는 이 표에 잡는다 — 게스트 답이 계정 사용자의 제보를 막지 않고, 게스트끼리는 1인 1표가 그대로 걸린다.
# 계정 사용자의 방문 확인 답은 어느 표도 보지 않는다(10-31 이전 동작 그대로 — 공용 와이파이·CGNAT 에서 답을 잃지 않게).
GUEST_ANSWER_VOTES_BY_IP: dict[tuple[str, str], tuple[str, float]] = {}
# (게스트 계정, 시설) → 마지막 답 시각. 같은 게스트가 추천을 돌려 같은 장소에 답을 쌓지 못하게 30분 쿨다운.
GUEST_ANSWER_LAST_BY_USER: dict[tuple[str, str], float] = {}

_MISSING = object()

# 지난 항목 걷기 — 표의 키에 원본 IP 가 들어 있다. 창(30분)이 지난 항목은 판정에 쓰이지 않으니 지운다. 그래야
# '원본 IP 는 서버 메모리에 약 30분만 머문다'(개인정보 안내 privacy.abuseBody)가 참이 된다. 매 호출 전부 훑지 않도록
# 표마다 _PRUNE_EVERY_SEC 에 한 번만 걷는다 — 그래서 실제 체류는 '창 + 최대 1분' 이다(재시작하면 표 전체가 사라진다).
_PRUNE_EVERY_SEC = 60.0
_last_pruned: dict[int, float] = {}


def _prune(store: dict, now_mono: float, max_age: float) -> None:
    last = _last_pruned.get(id(store))
    if last is not None and now_mono - last < _PRUNE_EVERY_SEC:
        return
    _last_pruned[id(store)] = now_mono
    for key in [k for k, v in store.items() if now_mono - (v[1] if isinstance(v, tuple) else v) >= max_age]:
        store.pop(key, None)


def prune_expired(store: dict, max_age: float = CORROBORATION_WINDOW_SEC) -> None:
    """창이 지난 항목을 지금 바로 지운다(테스트·운영 점검용 — 평소에는 reserve_report_slot 이 1분에 한 번 걷는다)."""
    _last_pruned.pop(id(store), None)
    _prune(store, time.monotonic(), max_age)


def shared_ip_retry_after(
    ip_store: dict[tuple[str, str], tuple[str, float]], *, user_id: str, ip: str, facility_id: str
) -> int | None:
    """같은 IP·시설의 **다른** 계정이 창 안에 표를 냈으면 남은 초(Retry-After), 아니면 None."""
    entry = ip_store.get((ip, facility_id))
    if entry is None or entry[0] == user_id:
        return None
    elapsed = time.monotonic() - entry[1]
    if elapsed >= CORROBORATION_WINDOW_SEC:
        return None
    return max(1, math.ceil(CORROBORATION_WINDOW_SEC - elapsed))


def reserve_report_slot(
    *,
    ip_store: dict[tuple[str, str], tuple[str, float]],
    user_id: str,
    ip: str,
    facility_id: str,
    user_store: dict[tuple[str, str], float] | None = None,
    cooldown_sec: float = 0.0,
    cooldown_detail: str = "",
) -> tuple:
    """쿨다운(선택)과 IP 한 계정 규칙을 검사하고, 통과하면 **같은 동기 구간에서** 자리를 잡는다.

    막히면 429(HTTPException, Retry-After 헤더), 통과하면 release_report_slot 에 넘길 되돌리기 토큰을 돌려준다.
    """
    now_mono = time.monotonic()
    _prune(ip_store, now_mono, CORROBORATION_WINDOW_SEC)
    if user_store is not None:
        _prune(user_store, now_mono, max(cooldown_sec, 1.0))
    user_key = (user_id, facility_id)
    ip_key = (ip, facility_id)
    if user_store is not None:
        last_at = user_store.get(user_key)
        if last_at is not None and now_mono - last_at < cooldown_sec:
            raise HTTPException(
                status_code=429,
                detail=cooldown_detail,
                headers={"Retry-After": str(max(1, math.ceil(cooldown_sec - (now_mono - last_at))))},
            )
    retry_after = shared_ip_retry_after(ip_store, user_id=user_id, ip=ip, facility_id=facility_id)
    if retry_after is not None:
        raise HTTPException(status_code=429, detail=SHARED_IP_DETAIL, headers={"Retry-After": str(retry_after)})
    previous_user = _MISSING if user_store is None else user_store.get(user_key, _MISSING)
    token = (user_store, ip_store, user_key, ip_key, previous_user, ip_store.get(ip_key, _MISSING))
    if user_store is not None:
        user_store[user_key] = now_mono
    ip_store[ip_key] = (user_id, now_mono)
    return token


def release_report_slot(token: tuple) -> None:
    """reserve_report_slot 이 잡은 자리를 잡기 전 값으로 되돌린다."""
    user_store, ip_store, user_key, ip_key, previous_user, previous_ip = token
    pairs = [(ip_store, ip_key, previous_ip)]
    if user_store is not None:
        pairs.append((user_store, user_key, previous_user))
    for store, key, previous in pairs:
        if previous is _MISSING:
            store.pop(key, None)
        else:
            store[key] = previous
