import asyncio
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, HTTPException, Depends
from typing import Literal

from pydantic import BaseModel
# 읽기는 anon, congestion_logs 쓰기(simulate_peak)는 RLS 우회가 필요해 service_role 을 쓴다
# (ingest 라우터와 동일 사유 — anon INSERT 는 RLS 로 거부됨).
from app.core.authz import ROLE_ADMIN, require_role
from app.core.supabase import supabase_client, supabase_admin, fetch_all_rows
from app.services.availability_service import fetch_effective_availability_map
from app.services.congestion_evidence import (
    estimate_for,
    load_current_estimates,
    measurement_is_current,
)

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["infrastructures"])

# 혼잡 로그 신선도 임계(시간) — 최신 로그 나이가 이보다 크면 is_stale=True(신뢰도 낮음 표기).
#
# ⚠️ 이 24시간은 '**몹시** 낡았다' 경고선이지, "이 값이 지금이다" 의 기준선이 아니다. 후자는
# congestion_evidence.measurement_is_current 의 30분 × 신뢰등급이며(계획서 §5.2), 아래 혼잡 info 의
# ``is_current`` 로 함께 실려 나간다. 두 선이 필요한 이유는 그 함수 주석 참조 — 사용자에게 보이는
# 문구는 30분 선(마지막 관측 HH:MM)으로 통일하고, is_stale 은 배포된 구 번들 호환으로 남긴다.
_STALE_AFTER_HOURS = 24

# ── 데모 '피크타임 모의 발생'(simulate_peak) 파라미터 ─────────────────────────
# 혼잡 구간 배정 비율(여유/보통/나머지=혼잡). **비율**인 것이 핵심이다.
#
# 원래는 절대 인덱스였다: idx<15 여유, idx<30 보통, 그 밖은 전부 혼잡. 작성 당시 시설이
# 40곳쯤이라 15/15/10 이 곧 37%/37%/25% 였고 시연 화면이 고르게 보였다. 그런데 시설이
# 늘면서 앞 30곳만 여유·보통이고 **나머지가 전부 혼잡**이 됐다 — 활성 1,669곳(2026-09-20 실측)
# 기준 1,630곳(98%)이 빨간 점이라, 관제 히트맵이 온통 빨갛게 물들어 데모가 못 쓰게 됐다.
# 시설 수가 어떻게 변하든 그림이 유지되도록 비율로 고정한다.
_SIMULATE_RELAXED_RATIO = 0.40   # 여유
_SIMULATE_NORMAL_RATIO = 0.35    # 보통 (나머지 ≈25% 가 혼잡)

# congestion_logs INSERT 배치 크기(행 수).
#
# 예전엔 10행씩이라 1,669곳이면 **순차 167 왕복**이었다 — Render 무료 인스턴스(콜드 스타트가
# 잦고 왕복 지연이 큼)에서 이 엔드포인트만 몇 분씩 잡아먹었다. 그렇다고 한 번에 다 보내면
# PostgREST/Kong 앞단의 요청 본문 크기 한계에 걸릴 수 있다.
# 한 행은 {facility_id(uuid), congestion_level, current_count, source, timestamp} 뿐이라
# JSON 으로 약 150바이트다 → 500행이면 약 75KB 로, 흔한 본문 상한(1MB 안팎)에 한참 못 미친다.
# 활성 1,669곳(2026-09-20 실측) 기준 왕복이 167회에서 4회로 줄어든다.
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
    # 이 관측이 '지금' 을 말할 자격이 있는가(verified/corroborated · 30분 이내 —
    # congestion_evidence.measurement_is_current). False 면 화면은 같은 시설의 추정
    # (GET /congestion/estimates)을 '지금' 으로 칠하고 이 값은 '마지막 관측 HH:MM' 으로 남긴다.
    # **지도 마커는 그대로 실측만 칠한다** — 추정이 마커 색을 만들지 않는다(사용자 결정).
    # 기본값 False 가 아니라 True 인 이유: 이 모델은 구 응답을 역직렬화하는 자리가 아니라 항상
    # 아래 두 조회 함수가 계산해 채운다. 혹시 키가 빠진 경로가 생기더라도 '지금이 아니다' 로
    # 오해해 멀쩡한 실측을 추정으로 덮는 쪽보다, 종전 동작(실측을 그대로 그림)이 안전하다.
    is_current: bool = True


class CongestionEstimate(BaseModel):
    """주차 실측 + 관광 통계로 만든 **추정** 혼잡(congestion_estimator_service.estimate_evidence).

    실측이 아니다. 화면은 항상 '추정 · 주차 실측 기반 · HH:MM 관측 · 반경 2km' 로 그린다.
    인원수·대기 분은 싣지 않는다 — 점유율에서 인원으로 가는 계수가 없으니 지어낸 숫자가 된다.
    지도(/infrastructures)·추천(/recommendations, /by-type)·코스(/courses/plan)가 같은 모양을 쓴다.
    """

    level: float
    source: Literal["estimated"] = "estimated"
    observed_at: str | None = None      # 원본 주차 스냅샷 관측 시각(UTC ISO)
    parking_level: float                # 반경 2km 공영주차 가중 점유율(격자 중심)
    tourism_level: float | None = None  # 관광공사 집중률 기준선 /100 (없으면 주차만)
    lot_count: int                      # 반경 안 실시간 주차장 수 — 관측이 얼마나 얇은지 같이 말한다
    nearest_lot_m: float | None = None
    radius_m: int
    # 서울 실측 보정(congestion_calibration_service)의 흔적. 추정기가 항상 싣지만 이 모델이
    # 받지 않아 /congestion/estimates 에서만 조용히 사라지고 있었다(pydantic extra='ignore').
    # **전부 Optional** — 보정을 모르는 구 추정기 payload 도 그대로 검증을 통과해야 한다.
    #  · raw_level        : 보정 전 원값. 보정이 꺼져 있으면 level 과 같다(원값은 어느 경우에도 안 버린다).
    #  · calibrated       : 이 level 에 보정 곡선이 실제로 적용됐는지.
    #  · calibration_basis: 사람이 읽는 근거 한 줄("보정 전(서울 표본 부족)" / "서울 실측으로 보정(…)").
    #    화면은 이 문장을 '추정' 라벨 옆 출처 텍스트로만 쓴다 — 새 배지를 만들지 않는다.
    raw_level: float | None = None
    calibrated: bool | None = None
    calibration_basis: str | None = None


def congestion_estimate_model(estimate: dict | None) -> CongestionEstimate | None:
    """추정 dict → 응답 모델. 모양이 어긋난 추정 하나가 응답 전체를 500 으로 만들지 않게 삼킨다.

    (_clean_gallery_images 와 같은 원칙 — 부가 정보 한 칸의 오염이 지도 전체를 죽이면 안 된다.)
    """
    if not estimate:
        return None
    try:
        return CongestionEstimate(**estimate)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError 등
        logger.warning("congestion_estimate_invalid", error=str(exc))
        return None


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
    # 폐업·표출중단 자동 감지(2차 기획 1위)의 상태 컬럼.
    #
    # ⚠️ 이 응답에서 이 필드는 **구조적으로 False 가 될 수 없다.** 아래 get_infrastructures 는
    # fetch_active_facilities 로 is_active=true 인 행만 받으므로, 값은 True 이거나
    # (is_active 컬럼 미배포 → 42703 무필터 폴백일 때) None 뿐이다.
    #
    # 예전 주석은 "프런트는 값이 False 일 때만 '운영정보 확인 필요' 배지를 표시한다" 고 적었지만
    # 그건 사실이 아니다: 그 배지는 docs/archive/TOURAPI_EXPANSION.md 의 계획일 뿐 구현된 적이
    # 없고(2026-09-07 apps/web 전수 확인 — 이 응답의 is_active 를 읽는 소비자는 하나도 없다.
    # lib/facilitySearch.ts 가 읽는 is_active 는 Supabase 를 직접 조회하는 다른 경로다),
    # 설령 구현하더라도 위 필터 때문에 여기서는 절대 켜지지 않는다. 폐업 배지가 필요해지면
    # 비활성 행까지 내려주는 별도 경로가 있어야 한다.
    # (이 불변식은 tests/scripts/test_facility_lifecycle.py 가 잠근다.)
    #
    # 그럼에도 필드를 지우지 않는 이유: 응답 봉투는 배포된 구 번들도 읽는다. 소비자가 없다는
    # 이유로 키를 빼면 얻는 것(바이트 몇 개)보다 깨질 위험이 크다.
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
                "is_current": measurement_is_current(row.get("evidence_tier"), ts),
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
                "is_current": measurement_is_current(row.get("evidence_tier"), ts),
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
    # 추정(추정 모드)은 여기 싣지 않는다 — GET /congestion/estimates 주석 참조.
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


# 지도용 추정 묶음은 추천(3초)보다 조금 더 기다린다 — 이 요청은 지도 로딩과 **병렬**로 나가고,
# 늦게 와도 마커 위에 덧칠만 하므로 화면을 붙잡지 않는다. 추정기 캐시가 빈 첫 요청만 해당한다.
_MAP_ESTIMATE_TIMEOUT_SECONDS = 8.0


class CongestionEstimatesResponse(BaseModel):
    """GET /congestion/estimates — 지금 시점의 시설별 **추정** 혼잡(추정 모드, 계획서 §5.2).

    ``estimates`` 에는 반경 2km 에 실시간 주차장이 있는 시설만 있다(나머지는 키가 없다 — 값을
    만들지 않는다). 실측 우선은 **화면이 적용한다**: 같은 시설에 /infrastructures 의 congestion 이
    있고 그 관측이 ``is_current=True``(verified/corroborated · 30분 이내)면 추정은 그리지 않는다.
    ``is_current=False`` 인 낡은·단건 관측은 추정에 '지금' 자리를 내주고 '마지막 관측 HH:MM' 으로
    남는다 — 판정은 서버가 하고 화면은 그 결론만 읽는다
    (apps/web/lib/congestionEstimate.ts congestionDisplay).
    지도 마커는 어느 경우에도 실측만 칠한다 — 추정은 시설 상세·카드의 '추정' 배지로만 보인다.
    """

    available: bool
    reason: str | None = None
    observed_at: str | None = None
    radius_m: int | None = None
    lot_count: int = 0
    estimates: dict[str, CongestionEstimate] = {}


@router.get("/congestion/estimates", response_model=CongestionEstimatesResponse)
async def get_congestion_estimates():
    """지도 마커가 덧칠할 추정 묶음. 추정을 못 만들면 ``available=false`` 와 빈 묶음(200)이다.

    왜 /infrastructures 에 싣지 않고 따로 내나(레드팀 2026-09-20 실측):
      · 프로덕션 /infrastructures 는 이미 TTFB 4.0~5.9초라 프런트의 4초 상한을 자주 넘기고,
        그러면 화면은 Supabase 직접 읽기로 폴백한다 — 그 경로에는 추정이 없다. 추정을 거기
        실으면 **대부분의 방문에서 추정이 안 보이고**, 추정 계산이 그 느린 응답을 더 늦춘다.
      · 따로 받으면 어느 시설 경로가 이기든 그 위에 덧칠할 수 있고, 1,669행 전체에 null 칸을
        더하는 페이로드 증가(+13%)도 없다.
    구 번들은 이 엔드포인트를 부르지 않는다 — 추가만이다.
    """
    current = await load_current_estimates(timeout=_MAP_ESTIMATE_TIMEOUT_SECONDS)
    if current is None:
        return CongestionEstimatesResponse(available=False, reason="estimates_unavailable")
    estimates: dict[str, CongestionEstimate] = {}
    for facility_id in (current.get("estimates") or {}):
        # estimate_for 가 모양·0..1·관측 나이(60분)를 **내보내는 시점에** 다시 잰다.
        model = congestion_estimate_model(estimate_for(current, facility_id))
        if model is not None:
            estimates[str(facility_id)] = model
    if not estimates:
        return CongestionEstimatesResponse(
            available=False, reason="estimates_expired", observed_at=current.get("observed_at"),
        )
    first = next(iter(estimates.values()))
    return CongestionEstimatesResponse(
        available=True,
        observed_at=current.get("observed_at"),
        radius_m=first.radius_m,
        lot_count=int(current.get("lot_count") or 0),
        estimates=estimates,
    )


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
        #
        # **fetch_all_rows 여야 한다.** 단발 select 는 PostgREST 캡에 걸려 1,000곳만 돌려주는데,
        # 오류가 아니라 200 이라 아무도 모른다. 프로덕션 시설은 전체 1,688곳(활성 1,669곳,
        # 2026-09-20 실측)이므로 시연에서 이 버튼을 눌러도 688곳은 혼잡 로그를 받지 못한 채
        # 지도에 '데이터 없음' 으로 남는다 —
        # 위 독스트링이 말하는 "전 시설" 도, 아래 비율 배정(앞 40%/35%/25%)도 그만큼 거짓이 된다.
        # id 로 정렬해 페이지 경계에서 행이 중복·누락되지 않게 한다(전순서 보장).
        facilities = await asyncio.to_thread(
            fetch_all_rows,
            supabase_client,
            "facilities",
            "id, name, type, capacity",
            apply_filters=lambda q: q.order("id"),
        )
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
