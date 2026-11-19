"""인파 밀집 안전 경보(B2G 관제) — 혼잡 스코어에 위험 임계값을 얹은 존(골목) 단위 조기경보.

배경: 기존 관리자 화면(admin/infrastructure 등)은 시설 단위 표시 위주다. 이 라우터는 그 위에
  ① 시설 단위 경보(alert)/주의(warn) 분류,
  ② 좌표 기반 150m 격자 존 롤업('골목' 단위 근사 — 행정동/실제 골목 경계 아님),
  ③ 시설별 다음 1시간 예측(가능하면, 실패 시 null)
을 얹어 관제 화면(app/admin/safety) 이 소비할 압축 JSON 을 만든다.

- 가드: Supabase JWT + users.role='admin' — app/core/authz.py require_role 재사용.
- DB 조회는 fetch_all_rows(전체 시설, id 정렬) + fetch_latest_congestion_for_all(시설별 최신 로그를
  RPC 한 번으로 — infrastructures.py 재사용)로 구성한다. 별도 congestion_logs 집계 쿼리를
  새로 짜지 않고 기존 검증된 경로를 그대로 탄다. RPC 가 실패하면 빈 결과로 '경보 없음' 을 꾸미지
  않고 500 으로 알린다(raise_on_error).
- 존 롤업은 위경도를 소수점 셋째 자리로 반올림한 격자 키로 묶는다(위도 0.001˚ ≈ 111m, 경도는
  위도에 따라 다르지만 경주 위도(약 36˚)에서 ≈ 90m — '150m 격자'는 근사치이며 응답 메타
  zoneMethod='grid150m' 로 정직하게 표기한다. 과대포장 금지).
- 다음 1시간 예측은 predict.py 의 배치 앵커링 공식과 동일하다:
    offset  = 현재실측 − predict(타입, 지금 hour, 지금 dow)
    pred(t) = clamp01( predict(타입, +1h hour, +1h dow) + offset )
  predict_congestion 은 학습에 없던 조합이면 None 을 돌려주지만(예외는 던지지 않는다), 방어적으로
  try/except 를 둬 어떤 이유로든 계산이 실패하면 null 을 반환한다(무해 폴백 — 프런트가 '예측 없음'
  으로 표시).
- **관측 나이 상한(P0-4)**: 판정에는 최근 30분 안의 관측만 쓴다(추천 순위의 '지금' 판정과 같은
  congestion_evidence.RANKING_FRESHNESS). 예전에는 시설별 최신 로그를 나이와 무관하게 썼다 — 2주 전 제보
  한 건이 오늘의 '경보' 가 됐고, 반대로 관측이 하나도 없으면 화면이 '전 구역 정상' 이라고 말했다.
  관측이 없거나 전부 30분을 넘으면 judgement='unavailable'(판정 불가)다 — '정상' 이 아니다.
"""
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.authz import ROLE_ADMIN, require_role
from app.core.region import PUBLIC_REGION, apply_region, arun_region_scoped
from app.core.supabase import supabase_client, fetch_all_rows
from app.routers.infrastructures import fetch_latest_congestion_for_all
from app.services.congestion_estimator_service import ANOMALY_LEVEL
from app.services.congestion_evidence import RANKING_FRESHNESS
from app.services.predict_service import predict_congestion

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/admin/safety", tags=["admin-safety"], dependencies=[Depends(require_role(ROLE_ADMIN))])

# 기본 임계값 — 프런트 슬라이더 초기값과 같다(apps/web/lib/adminAlertLevels.ts).
# 경보 기준은 관제 대시보드의 '이상 혼잡'·추정 집계와 **같은 상수 하나**다(혼잡도 90% 이상). 예전에는
# 안전 화면만 85% 였다 — 같은 날 대시보드는 '이상 0건' 인데 이 화면은 '경보' 를 띄울 수 있었다.
DEFAULT_ALERT_THRESHOLD = ANOMALY_LEVEL
DEFAULT_WARN_THRESHOLD = 0.7

# 판정에 쓰는 관측의 최대 나이 — 추천 순위가 '지금' 을 판정하는 30분과 같은 값을 그대로 쓴다.
OBSERVATION_MAX_AGE = RANKING_FRESHNESS

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


def _parse_observed_at(value) -> datetime | None:
    """로그 시각(ISO) → tz-aware UTC. 비었거나 읽을 수 없으면 None — 나이를 모르는 관측은 판정에 쓰지 않는다."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_fresh(observed_at: datetime | None, now_dt: datetime) -> bool:
    """관측이 '지금' 을 말할 수 있는가 — 0 ≤ 나이 ≤ 30분(congestion_evidence.measurement_is_current 와 같은 창).

    미래 시각(시계 어긋남·잘못된 적재)도 지금이 아니다 — 그 창과 같은 규칙이다.
    """
    if observed_at is None:
        return False
    age = now_dt - observed_at
    return timedelta(0) <= age <= OBSERVATION_MAX_AGE


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
    # id 정렬 — offset 페이지 사이에 행이 옮겨져도 시설이 중복·누락되지 않게(페이지 경계 고정).
    # 관제(B2G)는 경주 시설만 — 서울은 내부 테스트베드라 관제 수치에 섞지 않는다.
    def _read(with_region: bool) -> list[dict]:
        return fetch_all_rows(
            supabase_client, "facilities", "id, name, type, latitude, longitude",
            apply_filters=lambda q: (apply_region(q, PUBLIC_REGION) if with_region else q).order("id"),
        )

    return await arun_region_scoped(_read, region=PUBLIC_REGION)


@router.get("/status")
async def get_safety_status(
    threshold: float = Query(DEFAULT_ALERT_THRESHOLD, ge=0.0, le=1.0, description="경보(alert) 임계값(0~1)"),
    warn: float = Query(DEFAULT_WARN_THRESHOLD, ge=0.0, le=1.0, description="주의(warn) 임계값(0~1)"),
):
    """시설·존(150m 격자) 단위 인파 밀집 안전 경보 현황 — 최근 30분 안의 관측만으로 판정한다.

    반환 shape:
      generatedAt, judgement('available'|'unavailable'), sampleEmpty, thresholds{alert,warn},
      meta{zoneMethod, maxObservationAgeMinutes}, observedFacilities, staleFacilities, latestObservedAt,
      facilityAlerts[], facilityWarnings[], zones[{…, observedAt, sourceCounts}], summary{…, observedZones}
    30분 안의 관측이 하나도 없으면 judgement='unavailable'·sampleEmpty=true 이고 목록은 빈 배열이다 —
    '정상' 이 아니라 '판정 불가' 다. 30분이 지난 관측은 판정에서 빼고 staleFacilities 로만 센다.
    """
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
        # raise_on_error: RPC 가 실패했을 때 빈 맵을 받으면 아래 분기가 '실측 표본 없음' 을 돌려준다 —
        # 관제 화면에서는 그게 '경보 없음' 으로 읽히는 거짓 안심이다. 모르면 모른다고(500) 알린다.
        congestion_map = await fetch_latest_congestion_for_all(facility_ids, raise_on_error=True)
    except Exception as e:
        logger.error("safety_status_congestion_failed", error=str(e))
        raise HTTPException(status_code=500, detail="혼잡 로그 조회에 실패했습니다.")

    # '지금' 은 관측을 다 읽은 **뒤에** 잡는다. 요청 첫머리에 잡으면 조회·재시도가 도는 사이 들어온 관측이
    # 판정 시각보다 늦어져 '미래 관측'(_is_fresh 거부)이 된다 — 방금 들어온 제보일수록 판정에서 빠지는 셈이다.
    now_dt = _utcnow()

    base_response = {
        "generatedAt": now_dt.isoformat(),
        "thresholds": {"alert": threshold, "warn": warn},
        "meta": {
            "zoneMethod": "grid150m",
            # 화면이 '최근 N분' 을 자기 숫자로 박지 않게 판정 창을 응답에 싣는다.
            "maxObservationAgeMinutes": int(OBSERVATION_MAX_AGE.total_seconds() // 60),
        },
    }

    facility_alerts: list[dict] = []
    facility_warnings: list[dict] = []
    # 존 격자 누적기 — zkey -> {합계/최대/개수/대표시설/예측합계/최근 관측 시각/출처 수}
    zone_acc: dict[str, dict] = {}
    observed_facilities = 0
    stale_facilities = 0
    latest_observed: datetime | None = None

    for f in facilities:
        data = congestion_map.get(f["id"])
        if not data:
            continue  # 최신 로그가 없는 시설은 경보 판정 대상에서 제외(무실측 = 무판정)

        observed_at = _parse_observed_at(data.get("timestamp"))
        if observed_at is not None and observed_at <= now_dt and (latest_observed is None or observed_at > latest_observed):
            latest_observed = observed_at
        if not _is_fresh(observed_at, now_dt):
            # 30분이 지난 관측은 지금을 말하지 않는다 — 경보도 '정상' 도 만들지 않는다(세기만 한다).
            stale_facilities += 1
            continue
        observed_facilities += 1

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
            # 새 키 — 무엇으로 판정했는지(손님 제보·좌석 방송·관리자 입력 …)와 그 신뢰 등급.
            "source": data.get("source"),
            "evidenceTier": data.get("evidence_tier"),
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
            "observedAt": None,
            "sourceCounts": {},
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
        if zone["observedAt"] is None or observed_at > zone["observedAt"]:
            zone["observedAt"] = observed_at
        source_key = str(data.get("source") or "unknown")
        zone["sourceCounts"][source_key] = zone["sourceCounts"].get(source_key, 0) + 1

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
            # 새 키 — 이 존 판정의 근거: 가장 최근 관측 시각(UTC ISO)과 출처별 시설 수.
            "observedAt": z["observedAt"].isoformat() if z["observedAt"] else None,
            "sourceCounts": z["sourceCounts"],
        })

    # 프런트 카드 정렬 편의 — 혼잡도 내림차순(가장 위험한 항목이 위로).
    zones.sort(key=lambda z: z["maxCongestion"], reverse=True)
    facility_alerts.sort(key=lambda a: a["congestion"], reverse=True)
    facility_warnings.sort(key=lambda a: a["congestion"], reverse=True)

    summary = {
        "alertZones": sum(1 for z in zones if z["level"] == "alert"),
        "warnZones": sum(1 for z in zones if z["level"] == "warn"),
        # '정상' 은 30분 안의 관측이 있는 존만 센다 — 관측이 없는 존은 어느 칸에도 들어가지 않는다.
        "normalZones": sum(1 for z in zones if z["level"] == "normal"),
        "alertFacilities": len(facility_alerts),
        "warnFacilities": len(facility_warnings),
        "observedZones": len(zones),
    }
    # 판정 가능 = 30분 안의 관측이 한 건이라도 있다. 없으면 목록이 비어도 '정상' 이 아니라 '판정 불가' 다.
    judgement = "available" if observed_facilities else "unavailable"

    logger.info(
        "safety_status_returned",
        alert_zones=summary["alertZones"], warn_zones=summary["warnZones"],
        observed_facilities=observed_facilities, stale_facilities=stale_facilities,
        threshold=threshold, warn_threshold=warn,
    )
    return {
        **base_response,
        "judgement": judgement,
        # 구 키 — 뜻: '판정에 쓸 관측이 없다'(예전: 로그가 전혀 없다). 구 번들도 빈 목록을 그린다.
        "sampleEmpty": judgement == "unavailable",
        "observedFacilities": observed_facilities,
        "staleFacilities": stale_facilities,
        # 30분 창과 무관한 가장 최근 관측 시각 — '판정 불가' 화면이 '마지막 관측 3일 전' 을 말할 근거.
        "latestObservedAt": latest_observed.isoformat() if latest_observed else None,
        "facilityAlerts": facility_alerts,
        "facilityWarnings": facility_warnings,
        "zones": zones,
        "summary": summary,
    }
