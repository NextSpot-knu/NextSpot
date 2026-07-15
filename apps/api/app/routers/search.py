"""실시간 키워드 게이트웨이 라우터 — 지도 검색 0건 폴백(TourAPI searchKeyword2) + 적재 요청 승인 큐.

배경(2위 기획): 지도 검색은 로컬 적재 85곳(facilities)만 매칭한다. 적재 밖 POI 를 검색하면
'검색 결과 없음'으로 막히므로, 0건일 때만 TourAPI 키워드 검색(searchKeyword2)으로 폴백해
후보를 보여준다. 다만 그 자리에서 즉시 facilities 에 적재하지 않고 admin_ingest_requests 에
"다음 배치 추가 요청"만 큐잉한다(운영자 검수 게이트 — 오탐/남용 방지). 관리자가 승인하면
detailCommon2/Intro2 를 조회해 단건 인제스트한다(scripts/ingest_tourapi.py 의 upsert 패턴 재사용).

엔드포인트:
  - GET  /api/v1/search/keyword            : 무인증, IP 당 분당 5회. TourAPI 실패/키 없음 → 무해 폴백.
  - POST /api/v1/search/ingest-request     : 무인증, IP 당 분당 3회. contentid 중복은 조용히 무시.
  - GET  /api/v1/search/ingest-requests    : require_admin. 대기(기본 pending) 목록.
  - POST /api/v1/search/ingest-requests/approve : require_admin. 단건 인제스트 → facilities upsert → approved.

admin_ingest_requests 테이블이 아직 없는 환경(마이그레이션 미적용)에서는 500 대신
503 + 안내 메시지로 흡수한다(_ingest_table_error).
"""
import asyncio
import time
from datetime import datetime, timezone
from typing import Literal, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.core.supabase import require_admin, supabase_admin
from app.services.tourapi import client as tourapi
from app.services.tourapi.transform import (
    extract_detail_common,
    extract_intro_extra_features,
    extract_intro_phone_fallback,
    extract_operating_hours,
    transform_poi,
    upgrade_image_scheme,
)

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/search", tags=["search"])

# areaBasedList2/searchKeyword2 지역 필터 — legacy areaCode(경북=35)·sigunguCode(경주=2)
# (docs/DATA_UTILIZATION.md 실측표). searchFestival2 만 예외적으로 법정동 코드를 쓴다
# (client.py search_festival 도크·events.py 참고) — 이 라우터는 legacy 코드가 맞는 엔드포인트만 쓴다.
_AREA_CODE_GYEONGBUK = 35
_SIGUNGU_CODE_GYEONGJU = 2

_SEARCH_ROWS = 5  # 폴백 결과 상위 5개(기획 스펙)

# --- 인메모리 IP 레이트리밋(분당 N회, 슬라이딩 윈도우) — tracking.py 의 IP 쿨다운 패턴을
#     "고정 쿨다운" 대신 "윈도우당 횟수 제한"으로 확장한 버전. 단일 인스턴스 데모 기준
#     (reports.py/tracking.py 와 동일 전제 — 다중 인스턴스는 공유 저장소로 승격 필요).
_RATE_LIMIT_WINDOW_SEC = 60.0
_SEARCH_RATE_LIMIT = 5
_INGEST_RATE_LIMIT = 3
_search_hits: dict[str, list[float]] = {}
_ingest_hits: dict[str, list[float]] = {}


def _client_ip(request: Request) -> str:
    """클라이언트 IP — 프록시(X-Forwarded-For) 우선, 없으면 소켓 피어(tracking.py _client_ip 미러)."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate_limit(store: dict[str, list[float]], ip: str, limit: int) -> Optional[int]:
    """분당 limit회 슬라이딩 윈도우 레이트리밋.

    통과 시 None, 초과 시 재시도까지 남은 초(Retry-After 헤더용, 최소 1)를 반환한다.
    초과 요청의 타임스탬프는 기록하지 않는다(연속 초과 요청으로 윈도우가 계속 밀리는 것 방지).
    """
    now = time.monotonic()
    hits = [t for t in store.get(ip, []) if now - t < _RATE_LIMIT_WINDOW_SEC]
    if len(hits) >= limit:
        store[ip] = hits
        return max(1, int(_RATE_LIMIT_WINDOW_SEC - (now - hits[0])))
    hits.append(now)
    store[ip] = hits
    return None


def _rate_limit_or_429(store: dict[str, list[float]], ip: str, limit: int, message: str) -> None:
    retry_after = _check_rate_limit(store, ip, limit)
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=message,
            headers={"Retry-After": str(retry_after)},
        )


# --- admin_ingest_requests 테이블 부재(마이그레이션 미적용) 안내 폴백 ---------------------------

_TABLE_MISSING_SIGNALS = ("does not exist", "PGRST205", "42P01", "schema cache", "could not find the table")


def _is_missing_table_error(e: Exception) -> bool:
    text = str(e).lower()
    return any(sig.lower() in text for sig in _TABLE_MISSING_SIGNALS)


def _ingest_table_error(e: Exception, action: str) -> HTTPException:
    """admin_ingest_requests DB 오류 → 500 대신 원인 구분된 안내 에러(테이블 부재는 503)."""
    if _is_missing_table_error(e):
        logger.warning("ingest_requests_table_missing", action=action, error=str(e))
        return HTTPException(
            status_code=503,
            detail=(
                f"{action}에 실패했습니다 — 적재 요청 테이블이 아직 준비되지 않았습니다"
                "(마이그레이션 20260715110001_ingest_requests.sql 적용 필요)."
            ),
        )
    logger.error("ingest_requests_db_failed", action=action, error=str(e))
    return HTTPException(status_code=500, detail=f"{action}에 실패했습니다.")


# =============================================================================
# 1. GET /api/v1/search/keyword — 지도 검색 0건 폴백(TourAPI searchKeyword2)
# =============================================================================


class KeywordSearchItem(BaseModel):
    contentid: str
    title: str
    addr1: Optional[str] = None
    mapx: Optional[float] = None
    mapy: Optional[float] = None
    contenttypeid: Optional[int] = None
    firstimage: Optional[str] = None


class KeywordSearchResponse(BaseModel):
    items: list[KeywordSearchItem]
    source: Literal["tourapi", "unavailable"]


def _parse_coord(raw: object) -> Optional[float]:
    """TourAPI 좌표 문자열 → float. 미상/0(TourAPI 좌표 미상 관례, events.py _parse_coord 미러)은 None."""
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if value != 0.0 else None


def transform_keyword_item(item: dict) -> Optional[KeywordSearchItem]:
    """searchKeyword2 item → KeywordSearchItem. 필수 필드(contentid/title) 없으면 None(스킵)."""
    if not isinstance(item, dict):
        return None
    contentid = str(item.get("contentid") or "").strip()
    title = str(item.get("title") or "").strip()
    if not contentid or not title:
        return None
    contenttypeid: Optional[int] = None
    try:
        raw_ctid = item.get("contenttypeid")
        if raw_ctid not in (None, ""):
            contenttypeid = int(raw_ctid)
    except (TypeError, ValueError):
        contenttypeid = None
    return KeywordSearchItem(
        contentid=contentid,
        title=title,
        addr1=str(item.get("addr1") or "").strip() or None,
        mapx=_parse_coord(item.get("mapx")),
        mapy=_parse_coord(item.get("mapy")),
        contenttypeid=contenttypeid,
        firstimage=upgrade_image_scheme(str(item.get("firstimage") or "").strip() or None),
    )


@router.get("/keyword", response_model=KeywordSearchResponse)
async def search_keyword_endpoint(
    request: Request,
    q: str = Query(..., min_length=1, max_length=100, description="검색 키워드"),
):
    """지도 검색 0건일 때만 프런트가 호출하는 TourAPI 키워드 폴백. 상위 5건만 반환한다.

    무인증 + IP 당 분당 5회 제한. TOURAPI_KEY 미설정/호출 실패는 500 이 아니라
    {items: [], source: 'unavailable'} 무해 폴백(events.py 축제 라우터와 동일 관례).
    """
    ip = _client_ip(request)
    _rate_limit_or_429(
        _search_hits, ip, _SEARCH_RATE_LIMIT,
        "검색 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    )

    keyword = q.strip()
    try:
        payload = await tourapi.search_keyword(
            keyword,
            area_code=_AREA_CODE_GYEONGBUK,
            sigungu_code=_SIGUNGU_CODE_GYEONGJU,
            rows=_SEARCH_ROWS,
        )
        raw_items = tourapi.parse_items(payload)
    except Exception as e:  # RuntimeError(키 미설정)·TourAPIError 모두 무해 폴백
        logger.warning("search_keyword_failed", q=keyword, error=str(e))
        return KeywordSearchResponse(items=[], source="unavailable")

    items = [it for it in (transform_keyword_item(i) for i in raw_items) if it is not None]
    return KeywordSearchResponse(items=items[:_SEARCH_ROWS], source="tourapi")


# =============================================================================
# 2. POST /api/v1/search/ingest-request — 적재 요청 큐잉
# =============================================================================


class IngestRequestCreate(BaseModel):
    contentid: str = Field(..., min_length=1, max_length=32)
    name: str = Field(default="", max_length=200)
    content_type_id: Optional[int] = None


@router.post("/ingest-request")
async def create_ingest_request(req: IngestRequestCreate, request: Request):
    """"다음 배치 추가 요청" 큐잉 — admin_ingest_requests 에 pending 으로 upsert.

    무인증 + IP 당 분당 3회 제한. contentid 가 이미 요청돼 있으면(UNIQUE) 조용히 무시한다
    (ignore_duplicates=True — 상태와 무관하게 재요청이 기존 행을 덮어쓰지 않는다).
    """
    ip = _client_ip(request)
    _rate_limit_or_429(
        _ingest_hits, ip, _INGEST_RATE_LIMIT,
        "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    )

    row = {
        "contentid": req.contentid.strip(),
        "name": req.name.strip() or None,
        "content_type_id": req.content_type_id,
        "status": "pending",
    }
    try:
        await asyncio.to_thread(
            supabase_admin.table("admin_ingest_requests")
            .upsert(row, on_conflict="contentid", ignore_duplicates=True)
            .execute
        )
    except Exception as e:
        raise _ingest_table_error(e, "적재 요청 접수")

    logger.info("ingest_request_created", contentid=row["contentid"])
    return {"success": True}


# =============================================================================
# 3. GET /api/v1/search/ingest-requests — 관리자 대기 목록
# =============================================================================

_INGEST_STATUSES = {"pending", "approved", "rejected"}


@router.get("/ingest-requests", dependencies=[Depends(require_admin)])
async def list_ingest_requests(status: str = "pending", limit: int = 100):
    if status not in _INGEST_STATUSES:
        raise HTTPException(status_code=422, detail=f"status 는 {sorted(_INGEST_STATUSES)} 중 하나여야 합니다.")
    limit = max(1, min(limit, 500))
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("admin_ingest_requests")
            .select("*")
            .eq("status", status)
            .order("created_at", desc=True)
            .limit(limit)
            .execute
        )
    except Exception as e:
        raise _ingest_table_error(e, "적재 요청 목록 조회")
    return res.data or []


# =============================================================================
# 4. POST /api/v1/search/ingest-requests/approve — 단건 인제스트 승인
# =============================================================================


class IngestApproveRequest(BaseModel):
    id: str


async def _enrich_and_transform(contentid: str) -> dict:
    """detailCommon2 → transform_poi 기본 행 + detailIntro2 보강(scripts/ingest_tourapi.py enrich_row 미러).

    detailCommon2 실패/필수 필드 부족은 HTTPException 으로 즉시 중단(승인 실패, pending 유지).
    detailIntro2 실패는 부분 실패 허용(공통 정보만으로 적재 진행 — enrich_row 와 동일 관례).
    """
    try:
        common_payload = await tourapi.detail_common(contentid)
        common_items = tourapi.parse_items(common_payload)
    except Exception as e:
        logger.warning("ingest_approve_detail_common_failed", contentid=contentid, error=str(e))
        raise HTTPException(status_code=502, detail="TourAPI 상세 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.")
    if not common_items:
        raise HTTPException(status_code=502, detail="TourAPI 에서 해당 장소의 상세 정보를 찾을 수 없습니다.")

    common_item = common_items[0]
    row = transform_poi(common_item)
    if row is None:
        raise HTTPException(status_code=422, detail="필수 정보(이름/좌표/지원 유형)가 부족해 적재할 수 없습니다.")

    ctid = row["contenttypeid"]
    common_extra = extract_detail_common(common_item)
    if row.get("image_url"):
        common_extra.pop("image_url", None)  # locationBasedList2/detailCommon2 firstimage 우선순위는 이미 반영됨
    row.update(common_extra)

    try:
        intro_payload = await tourapi.detail_intro(contentid, ctid)
        intro_items = tourapi.parse_items(intro_payload)
        if intro_items:
            intro_item = intro_items[0]
            hours = extract_operating_hours(intro_item, ctid)
            if hours:
                row["operating_hours"] = hours
            extra_features = extract_intro_extra_features(intro_item, ctid)
            if extra_features:
                row["features"] = {**row.get("features", {}), **extra_features}
            if not row.get("phone"):
                phone_fallback = extract_intro_phone_fallback(intro_item, ctid)
                if phone_fallback:
                    row["phone"] = phone_fallback
    except Exception as e:
        logger.warning("ingest_approve_detail_intro_failed", contentid=contentid, error=str(e))

    return row


def _upsert_facility(row: dict) -> None:
    """facilities 에 contentid 기준 upsert(scripts/ingest_tourapi.py upsert_facilities 단건 버전).

    1차: on_conflict='contentid' upsert. 실패 시(부분 유니크 인덱스를 거부하는 버전 등)
    2차: SELECT 후 신규는 INSERT, 기존은 UPDATE 로 폴백한다.
    """
    contentid = row["contentid"]
    try:
        supabase_admin.table("facilities").upsert(row, on_conflict="contentid").execute()
        return
    except Exception as e:
        logger.warning("ingest_approve_upsert_fallback", contentid=contentid, error=str(e))

    existing = (
        supabase_admin.table("facilities").select("contentid").eq("contentid", contentid).limit(1).execute()
    )
    if existing.data:
        payload = {k: v for k, v in row.items() if k != "contentid"}
        supabase_admin.table("facilities").update(payload).eq("contentid", contentid).execute()
    else:
        supabase_admin.table("facilities").insert(row).execute()


@router.post("/ingest-requests/approve", dependencies=[Depends(require_admin)])
async def approve_ingest_request(req: IngestApproveRequest):
    """적재 요청 승인 — detailCommon2/Intro2 조회 → facilities upsert → status='approved'.

    facilities 적재가 실패하면 admin_ingest_requests 상태는 갱신하지 않는다(pending 유지 + 에러 반환).
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("admin_ingest_requests").select("*").eq("id", req.id).limit(1).execute
        )
    except Exception as e:
        raise _ingest_table_error(e, "적재 요청 조회")
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 적재 요청을 찾을 수 없습니다.")

    request_row = res.data[0]
    contentid = str(request_row.get("contentid") or "")
    if request_row.get("status") == "approved":
        # 이미 승인됨 — TourAPI 재조회 없이 멱등 응답(중복 승인 클릭 방지).
        return {"success": True, "contentid": contentid, "name": request_row.get("name"), "already_approved": True}

    row = await _enrich_and_transform(contentid)

    try:
        await asyncio.to_thread(_upsert_facility, row)
    except Exception as e:
        logger.error("ingest_approve_facilities_write_failed", contentid=contentid, error=str(e))
        raise HTTPException(status_code=500, detail="시설 적재에 실패했습니다. 요청은 대기 상태로 유지됩니다.")

    try:
        await asyncio.to_thread(
            supabase_admin.table("admin_ingest_requests")
            .update({"status": "approved", "approved_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", req.id)
            .execute
        )
    except Exception as e:
        # facilities 적재는 이미 성공했으므로 여기서는 500 이 아니라 경고만 남긴다 —
        # 다음 목록 조회 시 상태 불일치가 보이면 재승인(멱등) 클릭으로 정리 가능.
        logger.error("ingest_approve_status_update_failed", contentid=contentid, error=str(e))

    logger.info("ingest_request_approved", contentid=contentid, request_id=req.id)
    return {"success": True, "contentid": contentid, "name": row.get("name")}
