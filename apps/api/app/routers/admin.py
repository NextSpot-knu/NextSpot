"""관리자 전용 라우터 — docs/IMPROVEMENT_PLAN.md WS-A-6.

배경: 관리자 프런트(admin/*)가 anon 키(createPublicClient)로 facilities/system_settings/inquiries 를
직접 쓰던 경로는 RLS 강화(20260707120000_security_hardening.sql) 이후 전부 거부된다(이전에도
0행 갱신이 성공으로 표시되는 무음 실패였다). 이 라우터가 그 쓰기/민감 읽기의 단일 관문이다.

- 모든 엔드포인트는 require_admin(X-Admin-Authorization 공유 토큰) 가드로 보호된다.
- DB 접근은 service_role(supabase_admin) — RLS 우회는 이 신뢰 경로 안에서만 일어난다.
- 예외 원문은 서버 로그로만 남기고 클라이언트에는 일반 메시지를 준다.
"""
import asyncio
import math
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.supabase import supabase_admin, require_admin

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(require_admin)])

FACILITY_TYPES = {"restaurant", "cafe", "attraction", "culture"}
INQUIRY_STATUSES = {"new", "in_progress", "resolved"}  # inquiries.status CHECK 와 동일


# =========================================================================
# 시설(POI) CRUD — components/admin/FacilityTable.tsx
# =========================================================================

class FacilityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    type: str
    capacity: int = Field(ge=1, le=100000)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class FacilityUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    capacity: int | None = Field(default=None, ge=1, le=100000)
    # 쿠폰 정책 개입(폐루프): 제휴 할인율(0.10=10%). DB CHECK(0~1)와 동일 범위.
    # 변경 즉시 다음 추천 요청의 w3 쿠폰강도(min(1, rate/0.20))에 반영된다 — score.py 참조.
    coupon_rate: float | None = Field(default=None, ge=0, le=1)


@router.post("/facilities")
async def create_facility(req: FacilityCreate):
    if req.type not in FACILITY_TYPES:
        raise HTTPException(status_code=422, detail=f"type 은 {sorted(FACILITY_TYPES)} 중 하나여야 합니다.")
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").insert(req.model_dump()).execute
        )
        if not res.data:
            raise HTTPException(status_code=500, detail="시설 등록에 실패했습니다.")
        logger.info("admin_facility_created", facility_id=res.data[0].get("id"), name=req.name)
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_facility_create_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시설 등록에 실패했습니다.")


@router.patch("/facilities/{facility_id}")
async def update_facility(facility_id: str, req: FacilityUpdate):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=422, detail="수정할 필드가 없습니다.")
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").update(fields).eq("id", facility_id).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
        logger.info("admin_facility_updated", facility_id=facility_id, fields=list(fields))
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_facility_update_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 수정에 실패했습니다.")


@router.delete("/facilities/{facility_id}")
async def delete_facility(facility_id: str):
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").delete().eq("id", facility_id).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
        logger.info("admin_facility_deleted", facility_id=facility_id)
        return {"success": True, "deleted_id": facility_id}
    except HTTPException:
        raise
    except Exception as e:
        # recommendations FK(ON DELETE SET NULL)·congestion_logs CASCADE 는 스키마가 처리한다.
        logger.error("admin_facility_delete_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 삭제에 실패했습니다.")


# =========================================================================
# 시스템 설정 — app/admin/settings/page.tsx (system_settings 단일 행 id=1)
# =========================================================================

class SettingsUpdate(BaseModel):
    maintenance_mode: bool
    notice_text: str = Field(max_length=500)
    congestion_threshold: int = Field(ge=0, le=100)
    coldstart_weight: int = Field(ge=0, le=100)


@router.get("/settings")
async def get_settings():
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("system_settings").select("*").eq("id", 1).limit(1).execute
        )
        # 행이 없으면 null — 프런트가 기본값으로 폴백한다(마이그레이션 미적용 환경).
        return res.data[0] if res.data else None
    except Exception as e:
        logger.error("admin_settings_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시스템 설정 조회에 실패했습니다.")


@router.put("/settings")
async def update_settings(req: SettingsUpdate):
    try:
        payload = req.model_dump()
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        res = await asyncio.to_thread(
            supabase_admin.table("system_settings").update(payload).eq("id", 1).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="system_settings 행이 없습니다. 마이그레이션 적용이 필요합니다.")
        logger.info("admin_settings_updated")
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_settings_update_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시스템 설정 저장에 실패했습니다.")


# =========================================================================
# 문의(inquiries) — app/admin/support/page.tsx (PII 포함 → RLS 강화 후 admin API 전용)
# =========================================================================

class InquiryStatusUpdate(BaseModel):
    status: str


@router.get("/inquiries")
async def list_inquiries(limit: int = 500):
    limit = max(1, min(limit, 1000))
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("inquiries")
            .select("*")
            .order("created_at", desc=True)
            .limit(limit)
            .execute
        )
        return res.data or []
    except Exception as e:
        logger.error("admin_inquiries_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="문의 목록 조회에 실패했습니다.")


@router.patch("/inquiries/{inquiry_id}")
async def update_inquiry_status(inquiry_id: str, req: InquiryStatusUpdate):
    if req.status not in INQUIRY_STATUSES:
        raise HTTPException(status_code=422, detail=f"status 는 {sorted(INQUIRY_STATUSES)} 중 하나여야 합니다.")
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("inquiries").update({"status": req.status}).eq("id", inquiry_id).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="해당 문의를 찾을 수 없습니다.")
        logger.info("admin_inquiry_status_updated", inquiry_id=inquiry_id, status=req.status)
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_inquiry_update_failed", inquiry_id=inquiry_id, error=str(e))
        raise HTTPException(status_code=500, detail="문의 상태 변경에 실패했습니다.")


# =========================================================================
# 대시보드/리포트 지표 — anon 열람이 막힌 recommendations/user_feedback 의 비식별 지표 제공
# (admin/dashboard: 최근 7일 수락률·오늘 DAU / admin/reports: 최근 28일 수락 추이)
# =========================================================================

@router.get("/metrics")
async def get_metrics(days: int = 28):
    days = max(1, min(days, 90))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        recs_res, fb_res = await asyncio.gather(
            asyncio.to_thread(
                supabase_admin.table("recommendations")
                .select("accepted, created_at")
                .gte("created_at", since)
                .limit(5000)
                .execute
            ),
            asyncio.to_thread(
                supabase_admin.table("user_feedback")
                .select("user_id, timestamp")
                .gte("timestamp", since)
                .limit(5000)
                .execute
            ),
        )
        return {
            "since": since,
            "recommendations": recs_res.data or [],
            "feedback": fb_res.data or [],
        }
    except Exception as e:
        logger.error("admin_metrics_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="지표 조회에 실패했습니다.")


# =========================================================================
# 분산 효과 정량화 — 수락된 추천의 '절감 대기시간' 합산 (admin/dashboard 위젯)
# 산식: Σ max(0, 원본 예상대기 − 대안 도착시점 예상대기)  [수락 건만]
#  · original_wait_time/wait_time 은 추천 생성 시점에 score_breakdown 으로 저장된다
#    (recommendations 라우터). 그 시점의 실측 혼잡 기반이라 사후 재계산보다 정직하다.
#  · original_wait_time 이 없는 레거시 행은 incentive_relief(원본혼잡−도착시점 예측혼잡, 0~1)
#    × 15분(타입 기본 처리시간 중앙값)으로 보수적으로 근사한다 — 근사 건수는 estimated 로 구분 표기.
# =========================================================================

_LEGACY_RELIEF_TO_MINUTES = 15.0  # wait_time.DEFAULT_PROCESSING_TIMES 중앙값(카페12·식당25·관광15·문화15)


@router.get("/impact")
async def get_impact(since: str | None = None, days: int = 1):
    """수락 추천 기준 재배치 건수·절감 대기시간(분) 집계.

    since(ISO8601, UTC)가 오면 그 시각 이후, 없으면 최근 days(기본 1)일 롤링 윈도우.
    프런트(대시보드)는 KST '오늘 00:00' 을 since 로 넘겨 '오늘' 지표로 쓴다.
    """
    days = max(1, min(days, 90))
    if since:
        try:
            # 검증 겸 정규화 — 잘못된 문자열이 PostgREST 필터로 그대로 흘러가지 않게 한다.
            since = datetime.fromisoformat(since.replace("Z", "+00:00")).isoformat()
        except ValueError:
            raise HTTPException(status_code=422, detail="since 는 ISO8601 형식이어야 합니다.")
    else:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    try:
        res = await asyncio.to_thread(
            supabase_admin.table("recommendations")
            .select("score_breakdown, created_at")
            .eq("accepted", True)
            .gte("created_at", since)
            .limit(5000)
            .execute
        )
    except Exception as e:
        logger.error("admin_impact_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="분산 효과 집계에 실패했습니다.")

    relocations = 0
    saved_minutes = 0.0
    measured = 0   # original_wait_time 실측 저장 행
    estimated = 0  # 레거시 근사(incentive_relief 기반) 행
    for row in res.data or []:
        relocations += 1
        bd = row.get("score_breakdown") or {}
        original_wait = bd.get("original_wait_time")
        candidate_wait = bd.get("wait_time")
        if original_wait is not None and candidate_wait is not None:
            saved_minutes += max(0.0, float(original_wait) - float(candidate_wait))
            measured += 1
        elif bd.get("incentive_relief") is not None:
            saved_minutes += max(0.0, float(bd["incentive_relief"])) * _LEGACY_RELIEF_TO_MINUTES
            estimated += 1

    return {
        "since": since,
        "relocations": relocations,
        "saved_wait_minutes": round(saved_minutes, 1),
        "measured": measured,
        "estimated": estimated,
    }


# =========================================================================
# 오늘(KST) 혼잡 집계 — 12k행 클라이언트 집계를 서버측으로 이관 (최적화 #4)
# 기존엔 admin/dashboard(page.tsx fetchCongestion)가 congestion_logs 최대 ~12,000행을
# 브라우저로 내려받아 JS 로 평균/이상건수/히트맵/이상알림을 집계했다. 이 엔드포인트가 동일 산식으로
# 서버에서 집계해 compact JSON 만 반환한다(네트워크·클라이언트 CPU 절감). 산식은 fetchCongestion 과 1:1.
# =========================================================================

_KST_OFFSET = timedelta(hours=9)
_DASHBOARD_LOG_CAP = 12000  # 클라이언트 페이지네이션(1000행×12페이지)과 동일한 과다조회 상한


def _js_round(value: float, digits: int) -> float:
    """JS Math.round(x·10^d)/10^d 재현(round-half-up).
    파이썬 round() 는 은행가 반올림이라 .x5 경계에서 클라이언트 값과 어긋날 수 있어 직접 구현한다."""
    factor = 10 ** digits
    return math.floor(value * factor + 0.5) / factor


def _kst_today_range_utc() -> tuple[str, str]:
    """KST '오늘' 00:00~23:59:59.999 를 UTC ISO 문자열로. page.tsx getKstTodayRangeUtc 미러.
    congestion_logs.timestamp 는 UTC 적재라 서버 로컬 TZ 와 무관하게 KST(UTC+9) 고정 환산한다."""
    kst_now = datetime.now(timezone.utc) + _KST_OFFSET  # KST 벽시계(UTC 라벨로 표현)
    start = datetime(kst_now.year, kst_now.month, kst_now.day, 0, 0, 0, tzinfo=timezone.utc) - _KST_OFFSET
    end = datetime(kst_now.year, kst_now.month, kst_now.day, 23, 59, 59, 999000, tzinfo=timezone.utc) - _KST_OFFSET
    return start.isoformat(), end.isoformat()


def _joined_facility(log: dict) -> tuple[str | None, str | None]:
    """조인된 facility 가 dict/list 어느 형태로 와도 name/type 안전 추출(page.tsx joinedFacility 미러)."""
    f = log.get("facility")
    if not f:
        return None, None
    o = f[0] if isinstance(f, list) else f
    if not isinstance(o, dict):
        return None, None
    return o.get("name"), o.get("type")


def _kst_hour(ts: str) -> int:
    """UTC 타임스탬프의 KST(UTC+9) 시(0..23). page.tsx: getTime()+9h → getUTCHours() 미러."""
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt.astimezone(timezone.utc) + _KST_OFFSET).hour


@router.get("/dashboard/today")
async def get_dashboard_today():
    """오늘(KST) 혼잡 집계 — page.tsx fetchCongestion 과 동일 산식의 compact JSON.

    반환: { hasLogs, avgCongestion, anomalyCount, heatmap, anomalies }
      · hasLogs = 오늘 로그 수 >= 5
      · avgCongestion.value = 평균 혼잡도(소수 2자리), changePercent = 전일 평균 대비(소수 1자리, 없으면 0)
      · anomalyCount = congestion_level >= 0.9 건수
      · heatmap = 시설명×KST시(0..23) 평균(2자리), 로그 없는 칸은 null 센티넬(실측 0.0 과 구분)
      · anomalies = 시설별 >=0.9 피크 상위 6건
    로그가 5건 미만이면 hasLogs=false + 나머지 null(클라이언트 폴백과 동일 shape).
    """
    start, end = _kst_today_range_utc()
    # 전일 동일 구간(변화율 보정용) — 오늘 구간을 하루 앞으로 민다.
    y_start = (datetime.fromisoformat(start) - timedelta(days=1)).isoformat()
    y_end = (datetime.fromisoformat(end) - timedelta(days=1)).isoformat()

    empty = {"hasLogs": False, "avgCongestion": None, "anomalyCount": None, "heatmap": None, "anomalies": None}
    try:
        # 오늘 로그(시설명/유형 조인)와 어제 로그(변화율용, congestion_level만)를 동시에 조회한다(직렬 왕복 제거).
        today_res, y_res = await asyncio.gather(
            asyncio.to_thread(
                supabase_admin.table("congestion_logs")
                .select("congestion_level, current_count, timestamp, facility:facilities(name, type)")
                .gte("timestamp", start)
                .lte("timestamp", end)
                .order("timestamp", desc=False)
                .limit(_DASHBOARD_LOG_CAP)
                .execute
            ),
            asyncio.to_thread(
                supabase_admin.table("congestion_logs")
                .select("congestion_level")
                .gte("timestamp", y_start)
                .lte("timestamp", y_end)
                .limit(5000)
                .execute
            ),
        )
    except Exception as e:
        logger.error("admin_dashboard_today_failed", error=str(e))
        raise HTTPException(status_code=500, detail="혼잡 집계 조회에 실패했습니다.")

    logs = today_res.data or []
    y_logs = y_res.data or []
    if len(logs) < 5:
        return empty

    # 1) KPI: 평균 혼잡도 + 이상(>=0.9) 건수 + 전일 대비 변화율
    avg = sum(float(row.get("congestion_level") or 0) for row in logs) / len(logs)
    value = _js_round(avg, 2)
    anomaly_count = sum(1 for row in logs if float(row.get("congestion_level") or 0) >= 0.9)
    change_percent = 0.0
    if y_logs:
        y_avg = sum(float(row.get("congestion_level") or 0) for row in y_logs) / len(y_logs)
        if y_avg > 0:
            # JS: Math.round((value - yAvg)/yAvg * 1000)/10 == _js_round(... * 100, 1)
            change_percent = _js_round((value - y_avg) / y_avg * 100, 1)
    avg_congestion = {"value": value, "changePercent": change_percent}

    # 2) 히트맵: 시설명 × KST시 평균(로그 있는 시설만, 첫 등장 순서 유지)
    cells: dict[str, dict[str, float]] = {}
    type_of: dict[str, str] = {}
    names: list[str] = []
    for row in logs:
        name, ftype = _joined_facility(row)
        if not name:
            continue
        if name not in type_of:
            type_of[name] = ftype or "unknown"
            names.append(name)
        key = f"{name}__{_kst_hour(row.get('timestamp'))}"
        acc = cells.setdefault(key, {"sum": 0.0, "n": 0})
        acc["sum"] += float(row.get("congestion_level") or 0)
        acc["n"] += 1
    heatmap: list[dict] = []
    for name in names:
        for h in range(24):
            acc = cells.get(f"{name}__{h}")
            heatmap.append({
                "facility": name,
                "facilityType": type_of[name],
                "hour": h,
                # 로그 없는 시간대는 null(데이터 없음 센티넬) — 실측 0.00 과 구분한다.
                "value": _js_round(acc["sum"] / acc["n"], 2) if acc and acc["n"] else None,
            })

    # 3) 이상 알림: 오늘 >=0.9 피크(시설별 최고 1건), congestionLevel 내림차순 상위 6
    peak: dict[str, dict] = {}
    for row in logs:
        level = float(row.get("congestion_level") or 0)
        if level < 0.9:
            continue
        name, _ = _joined_facility(row)
        if not name:
            continue
        if name not in peak or level > peak[name]["congestionLevel"]:
            peak[name] = {
                "id": f"{name}-{row.get('timestamp')}",
                "facilityName": name,
                "timestamp": row.get("timestamp"),
                "congestionLevel": level,
                "durationMinutes": 30,
            }
    anomalies = sorted(peak.values(), key=lambda a: a["congestionLevel"], reverse=True)[:6]

    return {
        "hasLogs": True,
        "avgCongestion": avg_congestion,
        "anomalyCount": anomaly_count,
        "heatmap": heatmap,
        "anomalies": anomalies,
    }
