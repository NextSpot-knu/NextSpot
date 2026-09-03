import asyncio
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
# 읽기는 anon, congestion_logs 쓰기(simulate_peak)는 RLS 우회가 필요해 service_role 을 쓴다
# (ingest 라우터와 동일 사유 — anon INSERT 는 RLS 로 거부됨).
from app.core.authz import ROLE_ADMIN, require_role
from app.core.supabase import supabase_client, supabase_admin, fetch_all_rows
from app.services.availability_service import fetch_effective_availability_map

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["infrastructures"])

# 혼잡 로그 신선도 임계(시간) — 최신 로그 나이가 이보다 크면 is_stale=True(신뢰도 낮음 표기).
_STALE_AFTER_HOURS = 24

# ── 데모 '피크타임 모의 발생'(simulate_peak) 파라미터 ─────────────────────────
# 혼잡 구간 배정 비율(여유/보통/나머지=혼잡). **비율**인 것이 핵심이다.
#
# 원래는 절대 인덱스였다: idx<15 여유, idx<30 보통, 그 밖은 전부 혼잡. 작성 당시 시설이
# 40곳쯤이라 15/15/10 이 곧 37%/37%/25% 였고 시연 화면이 고르게 보였다. 그런데 시설이
# 늘면서 앞 30곳만 여유·보통이고 **나머지가 전부 혼잡**이 됐다 — 2026-09-03 실측 1,660곳
# 기준 1,630곳(98%)이 빨간 점이라, 관제 히트맵이 온통 빨갛게 물들어 데모가 못 쓰게 됐다.
# 시설 수가 어떻게 변하든 그림이 유지되도록 비율로 고정한다.
_SIMULATE_RELAXED_RATIO = 0.40   # 여유
_SIMULATE_NORMAL_RATIO = 0.35    # 보통 (나머지 ≈25% 가 혼잡)

# congestion_logs INSERT 배치 크기(행 수).
#
# 예전엔 10행씩이라 1,660곳이면 **순차 166 왕복**이었다 — Render 무료 인스턴스(콜드 스타트가
# 잦고 왕복 지연이 큼)에서 이 엔드포인트만 몇 분씩 잡아먹었다. 그렇다고 한 번에 다 보내면
# PostgREST/Kong 앞단의 요청 본문 크기 한계에 걸릴 수 있다.
# 한 행은 {facility_id(uuid), congestion_level, current_count, source, timestamp} 뿐이라
# JSON 으로 약 150바이트다 → 500행이면 약 75KB 로, 흔한 본문 상한(1MB 안팎)에 한참 못 미친다.
# 1,660곳 기준 왕복이 166회에서 4회로 줄어든다.
_SIMULATE_INSERT_CHUNK = 500


def _is_stale(timestamp: str | None, *, now: datetime | None = None) -> bool:
    """최신 혼잡 로그의 나이가 _STALE_AFTER_HOURS 를 초과하는지 판정한다.

    timestamp 미설정/비정형이면 판정 불가로 False(오탐 방지). now 는 테스트 주입용.
    """
    if not timestamp:
        return False
    try:
        ts = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    return (current - ts) > timedelta(hours=_STALE_AFTER_HOURS)


class CongestionInfo(BaseModel):
    level: float
    # 체감 혼잡 제보를 capacity×level 로 환산한 값은 실제 인원수가 아니다.
    # CCTV처럼 명시적으로 인원을 계수하는 소스에서만 숫자를 내려준다.
    current_count: int | None
    timestamp: str | None
    # 프런트 하위호환: 필드 추가만(기본값 제공). source=출처 라벨, is_stale=로그 나이>24h.
    source: str | None = None
    is_stale: bool = False


class AvailabilityEvidence(BaseModel):
    status: str
    evidence_tier: str
    corroborating_count: int
    reported_at: str
    expires_at: str

class InfrastructureItem(BaseModel):
    id: str
    name: str
    type: str
    latitude: float
    longitude: float
    capacity: int
    operating_hours: dict | None
    features: dict | None
    congestion: CongestionInfo | None
    # 프런트 하위호환: 필드 추가만(전부 Optional·기본 None). TourAPI 적재분(locationBasedList2·
    # detailCommon2·detailInfo2)만 값이 있고, 수동 시드 행은 None — 프런트는 값 있을 때만 렌더.
    image_url: str | None = None
    # detailImage2 갤러리(최대 5장) — 추천(by-type) 응답은 원본 dict 라 이미 내려가는데
    # 이 모델만 누락돼 /main 경로가 갤러리를 영영 못 받던 결손(2026-07-17 소비 경로 감사).
    gallery_images: list[str] | None = None
    address: str | None = None
    phone: str | None = None
    homepage: str | None = None
    overview: str | None = None
    barrier_free: bool | None = None
    # 폐업·표출중단 자동 감지(2차 기획 1위). is_active 컬럼 미배포(마이그레이션 미적용) 환경에서는
    # 항상 None — 프런트는 값이 False 일 때만 '운영정보 확인 필요' 배지를 표시한다(None/True 는 무배지).
    is_active: bool | None = None
    place_data_source: str | None = None
    data_updated_at: str | None = None
    availability_evidence: AvailabilityEvidence | None = None

def _clean_gallery_images(value) -> list[str] | None:
    """gallery_images JSONB 방어적 정제 — 오염된 한 행(비배열/비문자열 원소)이 pydantic 검증 실패로
    /infrastructures 응답 전체를 500 으로 만드는 failure amplification 차단(Codex 리뷰 P1, 2026-07-17)."""
    if not isinstance(value, list):
        return None
    urls = [u for u in value if isinstance(u, str) and u.strip()]
    return urls or None


async def _fetch_latest_one(fid: str) -> tuple[str, dict | None]:
    """시설 1건의 최신 혼잡 로그를 .limit(1) 로 조회(시설별 1쿼리)."""
    try:
        res = await asyncio.to_thread(
            supabase_client.table("congestion_logs")
            .select("congestion_level, current_count, timestamp, source, evidence_tier")
            .eq("facility_id", fid)
            .in_("evidence_tier", ["single_report", "corroborated", "verified"])
            .order("timestamp", desc=True)
            .order("id", desc=True)  # 동일 timestamp 동률 시 결정적 정렬(시설별 최신 1건 선택 안정화)
            .limit(1)
            .execute
        )
        if res.data:
            row = res.data[0]
            ts = row["timestamp"]
            return fid, {
                "level": row["congestion_level"],
                "current_count": _exact_current_count(row),
                "timestamp": ts,
                "source": row.get("source"),
                "evidence_tier": row.get("evidence_tier"),
                "is_stale": _is_stale(ts),
            }
    except Exception as e:
        logger.warning("congestion_fetch_one_failed", facility_id=fid, error=str(e))
    return fid, None


def _exact_current_count(row: dict) -> int | None:
    """정성 제보의 환산 인원수를 실제 인원처럼 노출하지 않는다."""
    if row.get("source") != "traffic_cctv":
        return None
    value = row.get("current_count")
    return int(value) if value is not None else None


def _is_missing_is_active_column(exc: Exception) -> bool:
    """PostgREST undefined_column(42703) 판정 — facilities.is_active 마이그레이션 미적용 상태에서도
    500 대신 필터 없이 폴백하기 위한 판별.

    실측(2026-07-15, 실 Supabase 프로젝트에 컬럼 미적용 상태로 조회): supabase-py 2.x 는
    postgrest.exceptions.APIError(code='42703', message='column facilities.is_active does not exist')
    를 던진다. supabase-py 버전 차이로 .code 속성이 없을 수 있어 메시지 문자열도 보조로 확인한다.
    """
    code = getattr(exc, "code", None)
    if code == "42703":
        return True
    message = str(getattr(exc, "message", None) or exc)
    return "is_active" in message and "does not exist" in message


async def fetch_active_facilities(client, select: str = "*", *, extra_filters=None) -> list[dict]:
    """facilities 를 is_active=false(폐업·표출중단 감지, 2차 기획 1위) 제외하고 전량 조회한다.

    추천/코스/예측/시설목록 로드가 공용으로 쓰는 지점 — fetch_all_rows(apply_filters=...) 위에
    is_active 필터를 얹은 얇은 래퍼다. is_active 컬럼이 아직 배포되지 않았으면(마이그레이션
    미적용, 42703) 필터 없이 재조회해 500 대신 전체 목록을 반환한다 — 폐업 감지가 아직 준비되지
    않았을 뿐 서비스 자체는 무중단이어야 한다(오탐보다 무필터 저하가 낫다는 원칙).
    """
    def _filters(query):
        if extra_filters is not None:
            query = extra_filters(query)
        return query.eq("is_active", True)

    try:
        rows = await asyncio.to_thread(
            fetch_all_rows, client, "facilities", select, apply_filters=_filters
        )
    except Exception as e:
        if not _is_missing_is_active_column(e):
            raise
        logger.warning("facilities_is_active_column_missing_fallback", select=select)
        rows = await asyncio.to_thread(
            fetch_all_rows, client, "facilities", select, apply_filters=extra_filters
        )
    try:
        ids = {str(row["id"]) for row in rows if row.get("id")}
        refs = await asyncio.to_thread(
            lambda: client.table("facility_source_refs")
            .select("facility_id,source,source_updated_at").execute()
        )
        by_id: dict[str, dict] = {}
        for ref in refs.data or []:
            fid = str(ref.get("facility_id"))
            if fid in ids and (fid not in by_id or ref.get("source") == "localdata"):
                by_id[fid] = ref
        for row in rows:
            ref = by_id.get(str(row.get("id")))
            if ref:
                row["place_data_source"] = ref.get("source")
                row["data_updated_at"] = ref.get("source_updated_at")
            elif row.get("contentid"):
                row["place_data_source"] = "tourapi"
                row["data_updated_at"] = row.get("updated_at")
            elif (row.get("features") or {}).get("source") == "kakao_discovery":
                row["place_data_source"] = "kakao"
                row["data_updated_at"] = (
                    (row.get("features") or {}).get("discovery_updated_at")
                    or row.get("updated_at")
                )
    except Exception as e:
        logger.warning("facility_source_refs_unavailable", error=str(e))
    return rows


async def fetch_latest_congestion_for_all(facility_ids: list[str]) -> dict:
    # DB RPC(DISTINCT ON)로 N개 시설의 최신 로그를 한 번에 받는다. 미배포 환경이나 일시 오류는
    # 기존 시설별 limit(1) 병렬 경로로 폴백해 기능·배포 순서 의존성을 없앤다.
    if not facility_ids:
        return {}
    try:
        response = await asyncio.to_thread(
            supabase_client.rpc(
                "latest_congestion_for_facilities", {"facility_ids": facility_ids}
            ).execute
        )
        result = {}
        for row in response.data or []:
            fid = str(row["facility_id"])
            ts = row["timestamp"]
            result[fid] = {
                "level": row["congestion_level"],
                "current_count": _exact_current_count(row),
                "timestamp": ts,
                "source": row.get("source"),
                "evidence_tier": row.get("evidence_tier"),
                "is_stale": _is_stale(ts),
            }
        return result
    except Exception as e:
        logger.warning("latest_congestion_rpc_fallback", error=str(e), facility_count=len(facility_ids))
    results = await asyncio.gather(*[_fetch_latest_one(fid) for fid in facility_ids])
    return {fid: data for fid, data in results if data is not None}

# ── 지도 응답에서 빼는 features 키 ──────────────────────────────────────────
# facilities.features 에는 화면이 쓰는 값(cuisine_tags·seat_status·kakao_place_url…)과
# **데이터 파이프라인 출처 기록**이 함께 들어 있다. 뒤쪽은 지도 화면이 한 줄도 읽지 않는데
# 방문자마다 매번 내려가고 있었다 — 실측 542곳 기준 약 85KB(전체 응답 724KB, features 350KB).
#
# 이게 왜 중요한가: 프런트는 /infrastructures 를 **2.5초 안에** 못 받으면 곧바로 Supabase
# 직접 읽기로 폴백한다(app/main/page.tsx). 그 폴백 경로에는 알려진 결함이 있다 —
# 로그가 잦은 시설이 캡을 채우면 다른 시설이 congestion=null 로 조용히 누락된다.
# 즉 응답이 무거워 2.5초를 넘길수록, 앱은 더 자주 **결함 있는 경로**로 돈다.
#
# DB 에서 지우는 게 아니라 이 엔드포인트 응답에서만 뺀다. 허용목록이 아니라 차단목록인 것은
# 의도적이다 — 새 키가 생겼을 때 조용히 사라지는 쪽보다 그냥 내려가는 쪽이 안전하다.
_FEATURES_OMITTED_ON_MAP = frozenset({
    "discovery_updated_at",
    "discovery_queries",
    "discovery_source",
    "indoor_evidence",
    "capacity_evidence",
    "coordinate_source",
    "tagging_source",
    "tourapi_coordinates",
    "kakao_category_name",
})


def _slim_features(features):
    """지도 응답용으로 출처 기록을 걷어낸다. dict 가 아니면 그대로 돌려준다."""
    if not isinstance(features, dict):
        return features
    return {k: v for k, v in features.items() if k not in _FEATURES_OMITTED_ON_MAP}


@router.get("/infrastructures", response_model=list[InfrastructureItem])
async def get_infrastructures(
    type: str | None = None,
    min_lat: float | None = None,
    max_lat: float | None = None,
    min_lng: float | None = None,
    max_lng: float | None = None,
):
    logger.info("infrastructures_request", type=type)
    try:
        def _apply_filters(query):
            if type:
                query = query.eq("type", type)
            if min_lat is not None:
                query = query.gte("latitude", min_lat)
            if max_lat is not None:
                query = query.lte("latitude", max_lat)
            if min_lng is not None:
                query = query.gte("longitude", min_lng)
            if max_lng is not None:
                query = query.lte("longitude", max_lng)
            return query

        # is_active=false(폐업·표출중단 감지) 제외 + 기존 위치/타입 필터 병행 적용.
        facilities = await fetch_active_facilities(supabase_client, "*", extra_filters=_apply_filters)

        if not facilities:
            return []

        facility_ids = [f["id"] for f in facilities]
        congestion_map, availability_map = await asyncio.gather(
            fetch_latest_congestion_for_all(facility_ids),
            fetch_effective_availability_map(facility_ids),
        )

        result = []
        for f in facilities:
            congestion_data = congestion_map.get(f["id"])
            congestion = CongestionInfo(**congestion_data) if congestion_data else None
            result.append(InfrastructureItem(
                id=f["id"],
                name=f["name"],
                type=f["type"],
                latitude=f["latitude"],
                longitude=f["longitude"],
                capacity=f["capacity"],
                operating_hours=f.get("operating_hours"),
                features=_slim_features(f.get("features")),
                congestion=congestion,
                image_url=f.get("image_url"),
                gallery_images=_clean_gallery_images(f.get("gallery_images")),
                address=f.get("address"),
                phone=f.get("phone"),
                homepage=f.get("homepage"),
                overview=f.get("overview"),
                barrier_free=f.get("barrier_free"),
                is_active=f.get("is_active"),
                place_data_source=f.get("place_data_source"),
                data_updated_at=f.get("data_updated_at"),
                availability_evidence=availability_map.get(str(f["id"])),
            ))

        logger.info("infrastructures_returned", count=len(result))
        return result
    except Exception as e:
        # 예외 원문은 서버 로그로만 — DB 오류/스택 문자열을 클라이언트에 노출하지 않는다.
        logger.error("infrastructures_fetch_error", error=str(e))
        raise HTTPException(status_code=500, detail="시설 데이터 조회에 실패했습니다.")


@router.post("/admin/simulate-peak")
async def simulate_peak(admin_claims: dict = Depends(require_role(ROLE_ADMIN))):
    """
    데모 전용 피크타임 혼잡도 데이터 모의 발생 API. (관리자 전용 — require_role(ROLE_ADMIN) 으로 보호)

    전 시설을 무작위로 섞은 뒤 **비율**로 구간을 배정해 혼잡 로그를 1건씩 만들고 삽입한다:
    앞 40% 여유(0.05~0.28) · 다음 35% 보통(0.35~0.65) · 나머지 약 25% 혼잡(0.72~0.95).
    (예전 독스트링의 "여유 15개, 보통 15개, 혼잡 10개" 는 시설이 40곳이던 시절의 절대 개수라
     지금은 사실이 아니다 — _SIMULATE_RELAXED_RATIO 위 주석 참조.)
    """
    try:
        # 1. 모든 시설 목록 가져오기
        res = await asyncio.to_thread(supabase_client.table("facilities").select("id, name, type, capacity").execute)
        facilities = res.data
        if not facilities:
            raise HTTPException(status_code=404, detail="시설 목록을 찾을 수 없습니다.")
        
        # 2. 혼잡도 구간 무작위 셔플 및 분할 배정
        import random
        from datetime import datetime, timezone
        
        shuffled = list(facilities)
        random.shuffle(shuffled)
        
        logs = []
        now_str = datetime.now(timezone.utc).isoformat()

        # 구간 경계는 전체 시설 수에 대한 **비율**로 잡는다(절대 인덱스 금지 — 위 상수 주석 참조).
        # 시설이 아주 적어도 인덱스가 깨지지 않는다: int() 내림이라 경계는 항상 0..len 안이고,
        # 남는 시설은 뒤 구간이 흡수한다(예: 3곳 → 여유 1 · 보통 1 · 혼잡 1).
        total = len(shuffled)
        relaxed_end = int(total * _SIMULATE_RELAXED_RATIO)
        normal_end = relaxed_end + int(total * _SIMULATE_NORMAL_RATIO)

        for idx, f in enumerate(shuffled):
            fid = f["id"]
            capacity = f["capacity"]

            if idx < relaxed_end:
                # 여유 (0.05 ~ 0.28)
                level = round(random.uniform(0.05, 0.28), 2)
            elif idx < normal_end:
                # 보통 (0.35 ~ 0.65)
                level = round(random.uniform(0.35, 0.65), 2)
            else:
                # 혼잡 (0.72 ~ 0.95)
                level = round(random.uniform(0.72, 0.95), 2)

            current_count = int(capacity * level)
            # 데모 시뮬 로그는 'simulated' 로 정직하게 기록한다(실 CCTV/제보가 아님 — source 정직화).
            source = "simulated"

            logs.append({
                "facility_id": fid,
                "congestion_level": level,
                "current_count": current_count,
                "source": source,
                "timestamp": now_str
            })
            
        # 3. DB에 INSERT (_SIMULATE_INSERT_CHUNK 행씩 — 왕복 횟수를 줄이는 것이 목적)
        inserted_count = 0
        for i in range(0, len(logs), _SIMULATE_INSERT_CHUNK):
            chunk = logs[i:i + _SIMULATE_INSERT_CHUNK]
            # service_role 로 INSERT (anon 은 congestion_logs RLS 로 거부됨)
            res_insert = await asyncio.to_thread(supabase_admin.table("congestion_logs").insert(chunk).execute)
            inserted_count += len(res_insert.data or [])
            
        logger.info("simulate_peak_success", inserted_logs=inserted_count)
        return {"status": "success", "message": f"모의 피크타임 혼잡 로그 {inserted_count}개가 성공적으로 삽입되었습니다."}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("simulate_peak_failed", error=str(e))
        raise HTTPException(status_code=500, detail="피크타임 모의 생성에 실패했습니다.")
