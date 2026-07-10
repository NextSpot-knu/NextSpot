import asyncio
import structlog
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
# 읽기는 anon, congestion_logs 쓰기(simulate_peak)는 RLS 우회가 필요해 service_role 을 쓴다
# (ingest 라우터와 동일 사유 — anon INSERT 는 RLS 로 거부됨).
from app.core.supabase import supabase_client, supabase_admin, require_admin, fetch_all_rows

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["infrastructures"])

class CongestionInfo(BaseModel):
    level: float
    current_count: int
    timestamp: str | None

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

async def _fetch_latest_one(fid: str) -> tuple[str, dict | None]:
    """시설 1건의 최신 혼잡 로그를 .limit(1) 로 조회(시설별 1쿼리)."""
    try:
        res = await asyncio.to_thread(
            supabase_client.table("congestion_logs")
            .select("congestion_level, current_count, timestamp")
            .eq("facility_id", fid)
            .order("timestamp", desc=True)
            .order("id", desc=True)  # 동일 timestamp 동률 시 결정적 정렬(시설별 최신 1건 선택 안정화)
            .limit(1)
            .execute
        )
        if res.data:
            row = res.data[0]
            return fid, {
                "level": row["congestion_level"],
                "current_count": row["current_count"],
                "timestamp": row["timestamp"],
            }
    except Exception as e:
        logger.warning("congestion_fetch_one_failed", facility_id=fid, error=str(e))
    return fid, None


async def fetch_latest_congestion_for_all(facility_ids: list[str]) -> dict:
    # 시설별 .limit(1) 을 병렬 조회. 단일 IN 쿼리 + timestamp desc 는 PostgREST 기본 행수 캡(예: 1000)에
    # 걸려, 다른 시설 로그가 캡을 채우면 특정 시설 최신 로그가 윈도우 밖으로 밀려 congestion=None 으로
    # 조용히 누락될 수 있다. 시설별 limit(1) 은 캡과 무관하게 항상 각 시설의 최신 1건을 보장한다.
    if not facility_ids:
        return {}
    results = await asyncio.gather(*[_fetch_latest_one(fid) for fid in facility_ids])
    return {fid: data for fid, data in results if data is not None}

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

        # 공용 페이지네이션 헬퍼(블로킹)를 워커 스레드로 오프로드 — 각 페이지에 동일 필터 적용.
        facilities = await asyncio.to_thread(
            fetch_all_rows, supabase_client, "facilities", "*", apply_filters=_apply_filters
        )

        if not facilities:
            return []

        facility_ids = [f["id"] for f in facilities]
        congestion_map = await fetch_latest_congestion_for_all(facility_ids)

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
                features=f.get("features"),
                congestion=congestion,
            ))

        logger.info("infrastructures_returned", count=len(result))
        return result
    except Exception as e:
        # 예외 원문은 서버 로그로만 — DB 오류/스택 문자열을 클라이언트에 노출하지 않는다.
        logger.error("infrastructures_fetch_error", error=str(e))
        raise HTTPException(status_code=500, detail="시설 데이터 조회에 실패했습니다.")


@router.post("/admin/simulate-peak")
async def simulate_peak(admin_claims: dict = Depends(require_admin)):
    """
    데모 전용 피크타임 혼잡도 데이터 모의 발생 API. (관리자 전용 — require_admin 으로 보호)
    실행 시 모든 시설에 대해 실시간 랜덤 혼잡 로그(여유 15개, 보통 15개, 혼잡 10개)를 생성 및 DB에 삽입합니다.
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
        
        for idx, f in enumerate(shuffled):
            fid = f["id"]
            capacity = f["capacity"]
            
            if idx < 15:
                # 여유 (0.05 ~ 0.28)
                level = round(random.uniform(0.05, 0.28), 2)
            elif idx < 30:
                # 보통 (0.35 ~ 0.65)
                level = round(random.uniform(0.35, 0.65), 2)
            else:
                # 혼잡 (0.72 ~ 0.95)
                level = round(random.uniform(0.72, 0.95), 2)
                
            current_count = int(capacity * level)
            source = "traffic_cctv" if f["type"] in ["attraction", "culture"] else "user_report"
            
            logs.append({
                "facility_id": fid,
                "congestion_level": level,
                "current_count": current_count,
                "source": source,
                "timestamp": now_str
            })
            
        # 3. DB에 INSERT (10개 청크씩)
        inserted_count = 0
        for i in range(0, len(logs), 10):
            chunk = logs[i:i+10]
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