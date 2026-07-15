"""인파 밀집 안전 경보(B2G 관제) — 혼잡 스코어에 위험 임계값을 얹은 존(골목) 단위 조기경보.

배경: 기존 관리자 화면(admin/infrastructure 등)은 시설 단위 표시 위주다. 이 라우터는 그 위에
  ① 시설 단위 경보(alert)/주의(warn) 분류,
  ② 좌표 기반 150m 격자 존 롤업('골목' 단위 근사 — 행정동/실제 골목 경계 아님),
  ③ 시설별 다음 1시간 예측(가능하면, 실패 시 null)
을 얹어 관제 화면(app/admin/safety) 이 소비할 압축 JSON 을 만든다.

- 가드: require_admin(X-Admin-Authorization 공유 토큰) — apps/api/app/routers/admin.py 와 동일 재사용.
- DB 조회는 fetch_all_rows(전체 시설) + fetch_latest_congestion_for_all(시설별 최신 로그, 시설별
  .limit(1) 병렬 조회 — infrastructures.py 재사용)로 구성한다. 별도 congestion_logs 집계 쿼리를
  새로 짜지 않고 기존 검증된 경로를 그대로 탄다.
- 존 롤업은 위경도를 소수점 셋째 자리로 반올림한 격자 키로 묶는다(위도 0.001˚ ≈ 111m, 경도는
  위도에 따라 다르지만 경주 위도(약 36˚)에서 ≈ 90m — '150m 격자'는 근사치이며 응답 메타
  zoneMethod='grid150m' 로 정직하게 표기한다. 과대포장 금지).
- 다음 1시간 예측은 predict.py 의 배치 앵커링 공식과 동일하다:
    offset  = 현재실측 − predict(타입, 지금 hour, 지금 dow)
    pred(t) = clamp01( predict(타입, +1h hour, +1h dow) + offset )
  predict_congestion 은 로컬 모델 미학습 시에도 0.5 로 폴백해 예외를 던지지 않지만, 방어적으로
  try/except 를 둬 어떤 이유로든 계산이 실패하면 null 을 반환한다(무해 폴백 — 프런트가 '예측 없음'
  으로 표시).
"""
import asyncio
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.supabase import supabase_client, require_admin, fetch_all_rows
from app.routers.infrastructures import fetch_latest_congestion_for_all
from app.services.predict_service import predict_congestion

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/admin/safety", tags=["admin-safety"], dependencies=[Depends(require_admin)])

# 기본 임계값 — 프런트 슬라이더 초기값과 동일(app/admin/safety/page.tsx).
DEFAULT_ALERT_THRESHOLD = 0.85
DEFAULT_WARN_THRESHOLD = 0.7

# 존 격자 반올림 자리수(소수점 셋째 자리) — '150m 격자' 근사의 근거.
_GRID_DECIMALS = 3


def _utcnow() -> datetime:
    # 테스트에서 고정 시각으로 패치할 수 있도록 분리(predict.py _utcnow 와 동일 관례).
    return datetime.now(timezone.utc)


def _classify(level: float, alert_threshold: float, warn_threshold: float) -> str:
    """혼잡도를 alert/warn/normal 3단계로 분류(경계값은 포함 — '이상'). """
    if level >= alert_threshold:
        return "alert"
    if level >= warn_threshold:
        return "warn"
    return "normal"


def _zone_key(lat: float, lng: float) -> str:
    return f"{round(lat, _GRID_DECIMALS):.3f}_{round(lng, _GRID_DECIMALS):.3f}"


def _predict_next_hour(facility_type: str, current_level: float, now_dt: datetime) -> float | None:
    """실측 혼잡도에 앵커링한 +1시간 예측. 계산 중 어떤 예외든 흡수하고 None 을 반환한다(무해 폴백)."""
    try:
        target_dt = now_dt + timedelta(hours=1)
        base_now = predict_congestion(facility_type, now_dt.hour, now_dt.weekday())
        base_target = predict_congestion(facility_type, target_dt.hour, target_dt.weekday())
        offset = float(current_level) - float(base_now)
        return round(max(0.0, min(1.0, float(base_target) + offset)), 4)
    except Exception as e:
        logger.warning("safety_predict_next_hour_failed", facility_type=facility_type, error=str(e))
        return None


async def _fetch_facilities() -> list[dict]:
    """전체 시설의 (id, name, type, 좌표)만 페이지네이션 조회(공용 fetch_all_rows 를 워커 스레드로 오프로드)."""
    return await asyncio.to_thread(
        fetch_all_rows, supabase_client, "facilities", "id, name, type, latitude, longitude"
    )


@router.get("/status")
async def get_safety_status(
    threshold: float = Query(DEFAULT_ALERT_THRESHOLD, ge=0.0, le=1.0, description="경보(alert) 임계값(0~1)"),
    warn: float = Query(DEFAULT_WARN_THRESHOLD, ge=0.0, le=1.0, description="주의(warn) 임계값(0~1)"),
):
    """시설·존(150m 격자) 단위 인파 밀집 안전 경보 현황.

    반환 shape:
      generatedAt, sampleEmpty, thresholds{alert,warn}, meta{zoneMethod},
      facilityAlerts[], facilityWarnings[], zones[], summary{...}
    실측 로그가 전혀 없으면(sampleEmpty=true) 목록은 모두 빈 배열 — 프런트가 시뮬레이터 안내로 대체한다.
    """
    now_dt = _utcnow()

    # 프런트 슬라이더 오조작(주의 > 경보) 방어 — 분류가 역전되지 않도록 스왑한다.
    if warn > threshold:
        logger.warning("safety_status_thresholds_swapped", threshold=threshold, warn=warn)
        threshold, warn = warn, threshold

    try:
        facilities = await _fetch_facilities()
    except Exception as e:
        logger.error("safety_status_facilities_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시설 데이터 조회에 실패했습니다.")

    facility_ids = [f["id"] for f in facilities]
    try:
        congestion_map = await fetch_latest_congestion_for_all(facility_ids)
    except Exception as e:
        logger.error("safety_status_congestion_failed", error=str(e))
        raise HTTPException(status_code=500, detail="혼잡 로그 조회에 실패했습니다.")

    base_response = {
        "generatedAt": now_dt.isoformat(),
        "thresholds": {"alert": threshold, "warn": warn},
        "meta": {"zoneMethod": "grid150m"},
    }

    if not congestion_map:
        # 오늘/전체 실측 로그가 전혀 없음 — 프런트가 '실측 표본 없음, 시뮬레이터로 생성 가능' 안내를 띄운다.
        return {
            **base_response,
            "sampleEmpty": True,
            "facilityAlerts": [],
            "facilityWarnings": [],
            "zones": [],
            "summary": {
                "alertZones": 0, "warnZones": 0, "normalZones": 0,
                "alertFacilities": 0, "warnFacilities": 0,
            },
        }

    facility_alerts: list[dict] = []
    facility_warnings: list[dict] = []
    # 존 격자 누적기 — zkey -> {합계/최대/개수/대표시설/예측합계}
    zone_acc: dict[str, dict] = {}

    for f in facilities:
        data = congestion_map.get(f["id"])
        if not data:
            continue  # 최신 로그가 없는 시설은 경보 판정 대상에서 제외(무실측 = 무판정)

        level = float(data["level"])
        level_status = _classify(level, threshold, warn)
        next_hour = _predict_next_hour(f["type"], level, now_dt)

        item = {
            "facilityId": f["id"],
            "facilityName": f["name"],
            "facilityType": f["type"],
            "congestion": round(level, 4),
            "nextHourCongestion": next_hour,
            "timestamp": data.get("timestamp"),
        }
        if level_status == "alert":
            facility_alerts.append(item)
        elif level_status == "warn":
            facility_warnings.append(item)

        lat, lng = f.get("latitude"), f.get("longitude")
        if lat is None or lng is None:
            continue  # 좌표 없는 시설은 존 롤업에서 제외(격자 산출 불가) — 정직 폴백

        zkey = _zone_key(float(lat), float(lng))
        zone = zone_acc.setdefault(zkey, {
            "sumCongestion": 0.0,
            "maxCongestion": 0.0,
            "facilityCount": 0,
            "topFacilityId": None,
            "topFacilityName": None,
            "topCongestion": -1.0,
            "nextHourSum": 0.0,
            "nextHourCount": 0,
        })
        zone["sumCongestion"] += level
        zone["facilityCount"] += 1
        if level > zone["maxCongestion"]:
            zone["maxCongestion"] = level
        if level > zone["topCongestion"]:
            # 존 내 최고 혼잡 시설을 대표 시설로 삼아 'OO 일대' 라벨을 만든다.
            zone["topCongestion"] = level
            zone["topFacilityId"] = f["id"]
            zone["topFacilityName"] = f["name"]
        if next_hour is not None:
            zone["nextHourSum"] += next_hour
            zone["nextHourCount"] += 1

    zones: list[dict] = []
    for zkey, z in zone_acc.items():
        zone_level = _classify(z["maxCongestion"], threshold, warn)
        next_hour_avg = round(z["nextHourSum"] / z["nextHourCount"], 4) if z["nextHourCount"] else None
        zones.append({
            "zoneId": zkey,
            "zoneLabel": f"{z['topFacilityName']} 일대" if z["topFacilityName"] else "이름 미상 구역",
            "topFacilityId": z["topFacilityId"],
            "avgCongestion": round(z["sumCongestion"] / z["facilityCount"], 4),
            "maxCongestion": round(z["maxCongestion"], 4),
            "facilityCount": z["facilityCount"],
            "level": zone_level,
            "nextHourCongestion": next_hour_avg,
        })

    # 프런트 카드 정렬 편의 — 혼잡도 내림차순(가장 위험한 항목이 위로).
    zones.sort(key=lambda z: z["maxCongestion"], reverse=True)
    facility_alerts.sort(key=lambda a: a["congestion"], reverse=True)
    facility_warnings.sort(key=lambda a: a["congestion"], reverse=True)

    summary = {
        "alertZones": sum(1 for z in zones if z["level"] == "alert"),
        "warnZones": sum(1 for z in zones if z["level"] == "warn"),
        "normalZones": sum(1 for z in zones if z["level"] == "normal"),
        "alertFacilities": len(facility_alerts),
        "warnFacilities": len(facility_warnings),
    }

    logger.info(
        "safety_status_returned",
        alert_zones=summary["alertZones"], warn_zones=summary["warnZones"],
        threshold=threshold, warn_threshold=warn,
    )
    return {
        **base_response,
        "sampleEmpty": False,
        "facilityAlerts": facility_alerts,
        "facilityWarnings": facility_warnings,
        "zones": zones,
        "summary": summary,
    }
