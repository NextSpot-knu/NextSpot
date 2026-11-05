"""서울 TourAPI POI 적재(수동) — SEOUL_TESTBED_PLAN S3 · ingest_mapping_design §1.

서울은 **개발자 전용** 두 번째 지역이다. 서울 시설이 관광객·게스트·사장님·관리자 화면에 한 줄이라도 새면
안 되므로, 이 스크립트는 격리가 확인된 뒤에만 쓰고, 쓴 직후 실제로 새는지 다시 본다. 경주 일배치
(`ingest_tourapi.py`)는 건드리지 않는다 — 변환·상세·upsert·중복 가드만 그대로 재사용한다.

## 순서
사전 점검(하나라도 실패 → exit 3, 쓰기 0)
  1. service_role 로 facilities.region 컬럼이 있는가(42703 이면 거부)
  2. RPC region_isolation_status() == 1 (DB 격리 — RESTRICTIVE 정책 · 자식 트리거 · 투영 패치)
  3. BACKEND_HEALTH_URL 의 capabilities.region_isolation ≥ 1 (지역을 아는 API 가 떠 있다)
  4. anon 키로 facilities?region=neq.gyeongju → []
  5. 점검용 관광객 계정(REGION_PROBE_TOURIST_EMAIL/PASSWORD)의 JWT 로 같은 조회 → [] (비밀이 없으면 실제 적재 거부)
수집 — SEOUL_ZONES 구역마다 반경 목록(12·14·39, 반경 = 발자국 끝까지) + 법정동 목록(11/110·140·440).
  발자국(`zone_footprint`) 안의 것만, contentid 로 합친다. 경주 등 다른 지역 행이 가진 contentid 는 건너뛴다.
  Kakao 는 부르지 않는다. 법정동 목록에만 나온 사진 없는 새 행은 넣지 않는다.
쓰기(`--apply`) — 새 행은 region='seoul' · is_active=false 로 들어간다(대기). 상세 조회는 `--details-budget`
  호출 안에서 새 행 먼저, 그다음 상세가 가장 오래된 행. 서울 showflag 동기화는 region='seoul' 행에만.
쓴 뒤 점검
  6. 이번 실행의 새 행을 켠다(사람이 숨긴 행 제외).
  7. 4·5 를 서울 행이 있는 상태로 다시.
  8. 90초(지도 스냅샷 60초 재적재보다 길게) 뒤 관광객 JWT 로 서울 구역 중심에서, X-NextSpot-Region: seoul
     헤더가 있을 때와 없을 때 모두: GET /infrastructures · POST /recommendations/by-type · POST /courses/plan ·
     GET /congestion/estimates — 응답에 서울 id 가 없고 위도 37 넘는 시설이 없어야 한다.
  하나라도 실패하면: **먼저** 이번 실행이 건드린 행을 모두 끄고(정책 누수면 서울 행 전부), 그다음 이번 실행이
  만든 행을 지운다(facility_zones 는 연쇄 삭제). app_events 'tourapi_sync_seoul_leak'(숫자만) → exit 4.

`--reactivate`: region-guard 가 서울 행을 내린 뒤 격리를 되살렸을 때, 사람이 숨기지 않은 서울 행을 다시 켠다
(showflag '0' 인 행은 켜지 않는다). 사전 점검 전부를 통과해야 한다.

## 로그(공개 저장소 CI)
표준 출력과 GITHUB_STEP_SUMMARY 에는 **집계 숫자 · 참거짓 · 종료 코드**만 남긴다. 이름·id·contentid·좌표는
찍지 않는다 — 재사용하는 함수가 contentid 를 찍는 출력은 가로채 줄 수만 센다. 행 단위 기록은 service_role
전용 표 app_events 'tourapi_sync_seoul_detail' 에 둔다.

## 종료 코드
  0 성공(미리보기 포함) · 75 목록 호출 일시 오류(쓰기 전) · 1 그 밖 실패 · 3 사전 점검 실패(쓰기 0) · 4 누수 감지(되돌림)

사용 예:
  python scripts/ingest_tourapi_seoul.py                                 # 미리보기(기본, 쓰기 0)
  python scripts/ingest_tourapi_seoul.py --apply --details-budget 400    # 적재
  python scripts/ingest_tourapi_seoul.py --apply --reactivate            # region-guard 트립 뒤 복구
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Iterable, Sequence

current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

from dotenv import load_dotenv

load_dotenv(os.path.join(parent_dir, ".env"))

import httpx

from app.core.region import PUBLIC_REGION, REGION_HEADER, REGION_SEOUL, apply_region, is_missing_region_column
from app.services.batch.facility_visibility import is_manually_hidden
from app.services.crowd.seoul_provider import SEOUL_ZONES
from app.services.crowd.zone_footprint import (
    Footprint,
    contains,
    extent_m,
    footprints_for,
    load_polygon_file,
)
from app.services.tourapi import CONTENT_TYPE_IDS, area_based_list, location_based_list, parse_items, parse_total_count
from app.services.tourapi.client import TourAPITransientError
from scripts import ingest_tourapi as base

# 재사용 — 경주 일배치와 같은 변환·상세·upsert·가드(모듈 이름으로 불러 테스트가 바꿔 끼울 수 있다).
transform_poi = base.transform_poi
enrich_row = base.enrich_row
upsert_facilities = base.upsert_facilities
find_probable_duplicates = base.find_probable_duplicates
photo_less_new_ldong_contentids = base.photo_less_new_ldong_contentids
fetch_showflag_map = base.fetch_showflag_map
list_call_with_retry = base._list_call_with_retry

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_PRECHECK = 3
EXIT_LEAK = 4
EXIT_TEMPFAIL = base.EXIT_TEMPFAIL  # 75

PAGE_ROWS = 100
LDONG_PAGE_ROWS = 1000
LDONG_REGN_CD = 11  # 서울특별시(법정동)
LDONG_SIGNGU_CDS: tuple[int, ...] = (110, 140, 440)  # 종로구 · 중구 · 마포구 — 서울 구역 9곳이 드는 구
SYNC_AREA_CODE = 1  # 서울(구 지역코드)
SYNC_SIGUNGU_CODES: tuple[int, ...] = (23, 24, 13)  # 종로구 · 중구 · 마포구(구 시군구코드)
LDONG_ONLY_MARK = base.LDONG_ONLY_MARK
DEFAULT_DETAILS_BUDGET = 400  # TourAPI 호출 수(일 한도를 경주 일배치 약 300~360콜과 나눠 쓴다)
DETAIL_CALLS_PER_ROW = 4  # detailCommon2 · detailIntro2 · detailInfo2 · detailImage2
DETAILS_AT_KEY = "tourapi_details_at"
POST_WRITE_WAIT_SECONDS = 90  # 지도 참조 스냅샷 재적재(60초)보다 길게
HTTP_TIMEOUT_SECONDS = 75.0  # Render 콜드 스타트
HTTP_ATTEMPTS = 2
PROBE_LAT_LIMIT = 37.0  # 경주는 35.8 근처 — 37 을 넘는 시설 좌표는 서울이다
EVENT = "tourapi_sync_seoul"
EVENT_DETAIL = "tourapi_sync_seoul_detail"
EVENT_LEAK = "tourapi_sync_seoul_leak"
CHUNK = 100


@dataclass
class Config:
    supabase_url: str = ""
    anon_key: str = ""
    health_url: str = ""
    probe_email: str = ""
    probe_password: str = ""
    # service_role 키가 없으면 app.core.supabase 가 anon 키로 물러선다 — 그 상태로는 쓰지 않는다.
    service_role_configured: bool = True

    @property
    def api_base(self) -> str:
        url = self.health_url.rstrip("/")
        return url[: -len("/health")] if url.endswith("/health") else url

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Config":
        env = os.environ if env is None else env
        return cls(
            supabase_url=str(env.get("SUPABASE_URL") or "").strip().rstrip("/"),
            anon_key=str(env.get("SUPABASE_ANON_KEY") or "").strip(),
            health_url=str(env.get("BACKEND_HEALTH_URL") or "").strip(),
            probe_email=str(env.get("REGION_PROBE_TOURIST_EMAIL") or "").strip(),
            probe_password=str(env.get("REGION_PROBE_TOURIST_PASSWORD") or ""),
            service_role_configured=bool(str(env.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()),
        )


@dataclass
class Context:
    admin: Any
    http: Any
    cfg: Config
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)


@dataclass
class Probe:
    token: str | None = None
    user_id: str | None = None


@dataclass
class Stats:
    list_calls: int = 0
    ldong_calls: int = 0
    ldong_failures: int = 0
    items_seen: int = 0
    outside_footprint: int = 0
    transformed: int = 0
    skipped_invalid: int = 0
    skipped_foreign_region: int = 0
    skipped_duplicate: int = 0
    skipped_photo_less_ldong: int = 0
    new_rows: int = 0
    existing_rows: int = 0
    details_rows: int = 0
    details_planned_calls: int = 0
    written: int = 0
    upsert_log_lines: int = 0
    created: int = 0
    activated: int = 0
    reactivated: int = 0
    showflag_checked: int = 0
    showflag_deactivated: int = 0
    showflag_lists_failed: int = 0
    per_zone: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


# ── 출력(집계만) ─────────────────────────────────────────────────────────────

def emit(line: str) -> None:
    print(line)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def emit_counts(label: str, payload: dict) -> None:
    emit(f"- {label}: " + json.dumps(payload, ensure_ascii=False, sort_keys=True))


@contextlib.contextmanager
def _quiet(stats: Stats):
    """재사용 함수가 찍는 행 단위 출력(contentid 포함)을 가로채 줄 수만 센다."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        yield
    stats.upsert_log_lines += len([line for line in buffer.getvalue().splitlines() if line.strip()])


def _chunks(items: Sequence, size: int = CHUNK) -> Iterable[list]:
    items = list(items)
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _event(ctx: Context, event: str, props: dict) -> None:
    try:
        ctx.admin.table("app_events").insert({"event": event, "props": props}).execute()
    except Exception as exc:  # noqa: BLE001 — 기록 실패는 결과를 바꾸지 않는다
        emit(f"- app_events {event} 기록 실패(error_type={type(exc).__name__})")


# ── 사전 점검 ────────────────────────────────────────────────────────────────

def _region_column_ok(ctx: Context) -> str | None:
    try:
        ctx.admin.table("facilities").select("id").eq("region", REGION_SEOUL).limit(1).execute()
    except Exception as exc:  # noqa: BLE001
        return "region_column_missing" if is_missing_region_column(exc) else "region_column_unreadable"
    return None


def _isolation_status(data: Any) -> int | None:
    if isinstance(data, list):
        data = data[0] if data else None
    if isinstance(data, dict):
        data = data.get("region_isolation_status")
    if isinstance(data, bool):
        return None
    try:
        return int(data)
    except (TypeError, ValueError):
        return None


def _isolation_ok(ctx: Context) -> str | None:
    try:
        data = ctx.admin.rpc("region_isolation_status", {}).execute().data
    except Exception:  # noqa: BLE001 — 함수가 없으면(마이그레이션 전) 거부
        return "isolation_status_unavailable"
    return None if _isolation_status(data) == 1 else "isolation_status_not_1"


async def _get_json(ctx: Context, url: str, **kwargs) -> tuple[int | None, Any]:
    """GET 을 두 번까지(콜드 스타트). (상태 코드, JSON) — 닿지 못하면 (None, None)."""
    for attempt in range(HTTP_ATTEMPTS):
        try:
            response = await ctx.http.get(url, timeout=HTTP_TIMEOUT_SECONDS, **kwargs)
        except httpx.HTTPError:
            if attempt + 1 >= HTTP_ATTEMPTS:
                return None, None
            continue
        try:
            body = response.json()
        except ValueError:
            body = None
        if response.status_code >= 500 and attempt + 1 < HTTP_ATTEMPTS:
            continue
        return response.status_code, body
    return None, None


async def _health_ok(ctx: Context) -> str | None:
    if not ctx.cfg.health_url:
        return "health_url_missing"
    status, body = await _get_json(ctx, ctx.cfg.health_url)
    if status is None or not (200 <= status < 300) or not isinstance(body, dict):
        return "health_unreachable"
    value = (body.get("capabilities") or {}).get("region_isolation") if isinstance(body.get("capabilities"), dict) else None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return "api_capability_missing"
    return None


async def rest_probe(ctx: Context, token: str | None) -> int | None:
    """브라우저 역할로 경주 아닌 시설 행이 보이는가. 보이는 행 수(0 이 정상), 조회 실패면 None."""
    if not (ctx.cfg.supabase_url and ctx.cfg.anon_key):
        return None
    status, body = await _get_json(
        ctx,
        f"{ctx.cfg.supabase_url}/rest/v1/facilities",
        params={"select": "id", "region": f"neq.{PUBLIC_REGION}", "limit": "1"},
        headers={"apikey": ctx.cfg.anon_key, "Authorization": f"Bearer {token or ctx.cfg.anon_key}"},
    )
    if status != 200 or not isinstance(body, list):
        return None
    return len(body)


async def tourist_login(ctx: Context) -> Probe | None:
    """점검용 관광객 계정의 JWT(비밀번호 grant). 실패하면 None."""
    try:
        response = await ctx.http.post(
            f"{ctx.cfg.supabase_url}/auth/v1/token",
            params={"grant_type": "password"},
            json={"email": ctx.cfg.probe_email, "password": ctx.cfg.probe_password},
            headers={"apikey": ctx.cfg.anon_key},
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        body = response.json() if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(body, dict) or not body.get("access_token"):
        return None
    return Probe(token=str(body["access_token"]), user_id=str((body.get("user") or {}).get("id") or "") or None)


async def prechecks(ctx: Context, *, apply: bool) -> tuple[list[str], Probe | None]:
    """사전 점검 1~5. (실패 코드 목록, 관광객 점검 세션). 쓰기는 하지 않는다."""
    failures: list[str] = []
    if not ctx.cfg.service_role_configured:
        failures.append("service_role_key_missing")
    for check in (_region_column_ok, _isolation_ok):
        code = check(ctx)
        if code:
            failures.append(code)
    code = await _health_ok(ctx)
    if code:
        failures.append(code)
    anon = await rest_probe(ctx, None)
    if anon is None:
        failures.append("anon_probe_failed")
    elif anon:
        failures.append("anon_rows_visible")
    probe: Probe | None = None
    if ctx.cfg.probe_email and ctx.cfg.probe_password:
        probe = await tourist_login(ctx)
        if probe is None:
            failures.append("tourist_login_failed")
        else:
            rows = await rest_probe(ctx, probe.token)
            if rows is None:
                failures.append("tourist_probe_failed")
            elif rows:
                failures.append("tourist_rows_visible")
    elif apply:
        failures.append("probe_secrets_missing")
    return failures, probe


# ── 수집 ─────────────────────────────────────────────────────────────────────

def selected_zones(clusters: str) -> list:
    wanted = {c.strip() for c in (clusters or "all").split(",") if c.strip()}
    if not wanted or "all" in wanted:
        return list(SEOUL_ZONES)
    return [zone for zone in SEOUL_ZONES if zone.cluster in wanted]


def zone_footprints(ctx: Context, zones: Sequence) -> list[Footprint]:
    """매핑(`map_facility_zones`)과 같은 규칙 — 구역 행의 geometry, 없으면 저장소 다각형 파일, 없으면 원."""
    db_geometry: dict[str, Any] = {}
    try:
        rows = ctx.admin.table("zones").select("zone_id, geometry").eq("region", REGION_SEOUL).execute().data or []
        db_geometry = {str(r.get("zone_id")): r.get("geometry") for r in rows}
    except Exception:  # noqa: BLE001 — 구역 표가 없어도 원 발자국으로 적재할 수 있다(매핑은 그때 실패로 알린다)
        db_geometry = {}
    rows = [
        {"zone_id": z.zone_id, "region": z.region, "centroid_lat": z.centroid_lat, "centroid_lng": z.centroid_lng,
         "radius_m": z.radius_m, "geometry": db_geometry.get(z.zone_id)}
        for z in zones
    ]
    return footprints_for(rows, load_polygon_file())


async def _paged(label: str, call: Callable[[int, int], Awaitable[dict]], rows: int, cap: int, stats: Stats,
                 *, ldong: bool) -> list[dict]:
    items: list[dict] = []
    page = 1
    while True:
        payload = await list_call_with_retry(f"{label}, page={page}", lambda page=page: call(page, rows))
        if ldong:
            stats.ldong_calls += 1
        else:
            stats.list_calls += 1
        page_items = parse_items(payload)
        items.extend(page_items)
        if not page_items or len(items) >= parse_total_count(payload) or len(page_items) < rows:
            break
        if cap and len(items) >= cap:
            break
        page += 1
    return items[:cap] if cap else items


async def collect(zones: Sequence, footprints: Sequence[Footprint], args, stats: Stats) -> tuple[dict, set]:
    """발자국 안의 원본 item 을 contentid 로 합친다. 반경 목록이 법정동 목록보다 먼저다.

    반경 목록이 재시도 뒤에도 일시 오류면 TourAPITransientError 를 올린다(호출부가 75 로 끝낸다).
    """
    by_contentid: dict[str, dict] = {}
    for index, (zone, footprint) in enumerate(zip(zones, footprints)):
        radius = int(math.ceil(extent_m(footprint)))
        kept = 0
        for ctid in CONTENT_TYPE_IDS:
            items = await _paged(
                f"locationBasedList2(zone#{index + 1}, type={ctid})",
                lambda page, rows, z=zone, c=ctid: location_based_list(
                    map_x=z.centroid_lng, map_y=z.centroid_lat, radius_m=radius,
                    content_type_id=c, page=page, rows=rows,
                ),
                PAGE_ROWS, args.max_per_zone_type, stats, ldong=False,
            )
            for item in items:
                stats.items_seen += 1
                contentid = str(item.get("contentid") or "")
                if not contentid or contentid in by_contentid:
                    continue
                if not any(contains(fp, item.get("mapy"), item.get("mapx")) for fp in footprints):
                    stats.outside_footprint += 1
                    continue
                by_contentid[contentid] = item
                kept += 1
        stats.per_zone[f"zone#{index + 1}"] = kept

    ldong_only: set[str] = set()
    for ctid in CONTENT_TYPE_IDS:
        for signgu in LDONG_SIGNGU_CDS:
            try:
                items = await _paged(
                    f"areaBasedList2(lDong={LDONG_REGN_CD}/{signgu}, type={ctid})",
                    lambda page, rows, c=ctid, s=signgu: area_based_list(
                        content_type_id=c, page=page, rows=rows,
                        ldong_regn_cd=LDONG_REGN_CD, ldong_signgu_cd=s,
                    ),
                    LDONG_PAGE_ROWS, 0, stats, ldong=True,
                )
            except RuntimeError:  # TourAPIError(일시 오류 포함)·키 미설정 — 법정동 목록은 보탬이다
                stats.ldong_failures += 1
                continue
            for item in items:
                stats.items_seen += 1
                contentid = str(item.get("contentid") or "")
                if not contentid or contentid in by_contentid:
                    continue
                if not any(contains(fp, item.get("mapy"), item.get("mapx")) for fp in footprints):
                    stats.outside_footprint += 1
                    continue
                by_contentid[contentid] = {**item, LDONG_ONLY_MARK: True}
                ldong_only.add(contentid)
    return by_contentid, ldong_only


# ── DB 대조 ──────────────────────────────────────────────────────────────────

def foreign_contentids(ctx: Context, contentids: Sequence[str]) -> set[str]:
    """서울이 아닌 지역 행이 이미 가진 contentid — 쿼리 안에서 지역을 건다(행을 가져와 dict 로 거르지 않는다)."""
    out: set[str] = set()
    for chunk in _chunks(contentids):
        rows = (
            ctx.admin.table("facilities").select("contentid").in_("contentid", chunk)
            .neq("region", REGION_SEOUL).execute().data or []
        )
        out.update(str(r.get("contentid")) for r in rows if r.get("contentid"))
    return out


def seoul_facilities(ctx: Context) -> list[dict]:
    from app.core.supabase import fetch_all_rows

    return fetch_all_rows(
        ctx.admin, "facilities", "id, name, type, latitude, longitude, contentid, is_active, features",
        apply_filters=lambda q: apply_region(q, REGION_SEOUL).order("id"),
    )


def seoul_ids(ctx: Context) -> set[str]:
    from app.core.supabase import fetch_all_rows

    rows = fetch_all_rows(ctx.admin, "facilities", "id", apply_filters=lambda q: apply_region(q, REGION_SEOUL).order("id"))
    return {str(r["id"]) for r in rows if r.get("id")}


def details_order(rows: list[dict], existing_by_cid: dict[str, dict]) -> list[dict]:
    """상세 조회 순서 — 새 행 먼저, 그다음 상세가 가장 오래된(없으면 맨 앞) 기존 행."""
    new = [r for r in rows if r["contentid"] not in existing_by_cid]

    def _age(row: dict) -> str:
        features = (existing_by_cid.get(row["contentid"]) or {}).get("features") or {}
        return str(features.get(DETAILS_AT_KEY) or "")

    old = sorted((r for r in rows if r["contentid"] in existing_by_cid), key=_age)
    return new + old


def _set_active(ctx: Context, ids: Sequence[str], active: bool) -> None:
    for chunk in _chunks(ids):
        apply_region(ctx.admin.table("facilities").update({"is_active": active}).in_("id", chunk), REGION_SEOUL).execute()


def deactivate_all_seoul(ctx: Context) -> None:
    apply_region(
        ctx.admin.table("facilities").update({"is_active": False}).eq("is_active", True), REGION_SEOUL
    ).execute()


def delete_rows(ctx: Context, ids: Sequence[str]) -> None:
    for chunk in _chunks(ids):
        apply_region(ctx.admin.table("facilities").delete().in_("id", chunk), REGION_SEOUL).execute()


# ── showflag(서울) ────────────────────────────────────────────────────────────

async def seoul_showflags(stats: Stats) -> dict[str, str]:
    merged: dict[str, str] = {}
    lists = [{"area_code": SYNC_AREA_CODE, "sigungu_code": s} for s in SYNC_SIGUNGU_CODES]
    lists += [{"area_code": None, "sigungu_code": None, "ldong_regn_cd": LDONG_REGN_CD, "ldong_signgu_cd": s}
              for s in LDONG_SIGNGU_CDS]
    for kwargs in lists:
        try:
            showflags = await fetch_showflag_map(**kwargs)
        except RuntimeError:
            stats.showflag_lists_failed += 1
            continue
        for contentid, flag in showflags.items():
            merged.setdefault(contentid, flag)
    return merged


def sync_seoul_showflags(ctx: Context, rows: list[dict], showflags: dict[str, str], *, reactivate: bool,
                         staged: set[str], stats: Stats) -> list[str]:
    """region='seoul' 행에만 showflag 를 반영한다. 끈 id 는 바로 끄고, 다시 켤 id 목록을 돌려준다.

    다시 켜기는 `--reactivate` 일 때만 한다(region-guard 가 끈 행을 사람 확인 없이 되살리지 않게) —
    사람이 숨긴 행 · 임시 휴업 · showflag '0' · 이번 실행의 대기 행(6단계가 켠다)은 제외.
    """
    deactivate: list[str] = []
    revive: list[str] = []
    for row in rows:
        fid, contentid = str(row.get("id")), str(row.get("contentid") or "")
        flag = showflags.get(contentid)
        if flag is not None:
            stats.showflag_checked += 1
        if flag == "0" and row.get("is_active") is not False:
            deactivate.append(fid)
        elif (reactivate and row.get("is_active") is False and flag != "0" and fid not in staged
              and not is_manually_hidden(row.get("features"))
              and not base._temporary_closure_active(row.get("features"))):
            revive.append(fid)
    _set_active(ctx, deactivate, False)
    stats.showflag_deactivated = len(deactivate)
    return revive


# ── 쓴 뒤 점검 ────────────────────────────────────────────────────────────────

def count_leaks(payload: Any, ids: set[str]) -> int:
    """응답 안의 서울 흔적 수 — 서울 id(값·키 어디든) 또는 위도 37 을 넘는 시설(id 와 latitude 를 가진 객체)."""
    hits = 0
    stack = [payload]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            latitude = value.get("latitude")
            if "id" in value and isinstance(latitude, (int, float)) and not isinstance(latitude, bool) \
                    and latitude > PROBE_LAT_LIMIT:
                hits += 1
            for key, item in value.items():
                if str(key) in ids:
                    hits += 1
                stack.append(item)
        elif isinstance(value, list):
            stack.extend(value)
        elif isinstance(value, str) and value in ids:
            hits += 1
    return hits


async def api_probes(ctx: Context, probe: Probe, ids: set[str], lat: float, lng: float) -> tuple[int, int]:
    """관광객 JWT 로 공개 API 네 곳(헤더 있음·없음). (누수 수, 실패한 요청 수)."""
    base_url = ctx.cfg.api_base
    leaks = failures = 0
    box = {"min_lat": lat - 0.02, "max_lat": lat + 0.02, "min_lng": lng - 0.02, "max_lng": lng + 0.02}
    by_type = {"user_id": probe.user_id or "", "facility_type": "cafe", "user_lat": lat, "user_lng": lng,
               "exclude_ids": [], "limit": 5}
    course = {"user_id": probe.user_id or "", "user_lat": lat, "user_lng": lng}
    for with_header in (False, True):
        headers = {"Authorization": f"Bearer {probe.token}"}
        if with_header:
            headers[REGION_HEADER] = REGION_SEOUL
        calls = [
            ("GET", "/api/v1/infrastructures", {"params": box}),
            ("POST", "/api/v1/recommendations/by-type", {"json": by_type}),
            ("POST", "/api/v1/courses/plan", {"json": course}),
            ("GET", "/api/v1/congestion/estimates", {}),
        ]
        for method, path, kwargs in calls:
            body, ok = None, False
            for attempt in range(HTTP_ATTEMPTS):
                try:
                    response = await ctx.http.request(
                        method, base_url + path, headers=headers, timeout=HTTP_TIMEOUT_SECONDS, **kwargs
                    )
                except httpx.HTTPError:
                    continue
                if response.status_code >= 500 and attempt + 1 < HTTP_ATTEMPTS:
                    continue
                if 200 <= response.status_code < 300:
                    try:
                        body, ok = response.json(), True
                    except ValueError:
                        ok = False
                break
            if not ok:
                failures += 1
                continue
            leaks += count_leaks(body, ids)
    return leaks, failures


async def post_write_checks(ctx: Context, probe: Probe | None, zones: Sequence) -> tuple[list[str], bool]:
    """7·8단계. (실패 코드, 정책 누수 여부)."""
    failures: list[str] = []
    leak = False
    anon = await rest_probe(ctx, None)
    if anon is None:
        failures.append("anon_probe_failed")
    elif anon:
        failures.append("anon_rows_visible")
        leak = True
    if probe is None or not probe.token:
        failures.append("tourist_probe_unavailable")
        return failures, leak
    tourist = await rest_probe(ctx, probe.token)
    if tourist is None:
        failures.append("tourist_probe_failed")
    elif tourist:
        failures.append("tourist_rows_visible")
        leak = True
    await ctx.sleep(POST_WRITE_WAIT_SECONDS)
    ids = seoul_ids(ctx)
    zone = zones[0] if zones else SEOUL_ZONES[0]
    leaks, request_failures = await api_probes(ctx, probe, ids, zone.centroid_lat, zone.centroid_lng)
    if leaks:
        failures.append("api_leak")
        leak = True
    if request_failures:
        failures.append("api_probe_failed")
    return failures, leak


def roll_back(ctx: Context, *, touched: Sequence[str], created: Sequence[str], all_seoul: bool) -> None:
    """누수·실패 시 되돌린다 — **끄기가 먼저**, 지우기가 다음(지우다 실패해도 이미 꺼져 있다)."""
    _set_active(ctx, touched, False)
    if all_seoul:
        deactivate_all_seoul(ctx)
    delete_rows(ctx, created)


# ── 실행 ─────────────────────────────────────────────────────────────────────

async def run(args: argparse.Namespace, ctx: Context) -> int:
    apply = bool(args.apply)
    stats = Stats()
    failures, probe = await prechecks(ctx, apply=apply)
    if failures:
        emit_counts("서울 적재 사전 점검 실패", {"apply": apply, "failures": sorted(failures), "exit": EXIT_PRECHECK})
        return EXIT_PRECHECK

    zones = selected_zones(args.clusters)
    if not zones:
        emit_counts("서울 적재", {"error": "no_zones_selected", "exit": EXIT_FAILURE})
        return EXIT_FAILURE
    footprints = zone_footprints(ctx, zones)
    try:
        items, ldong_only = await collect(zones, footprints, args, stats)
    except TourAPITransientError:
        emit_counts("서울 적재", {"error": "tourapi_list_transient", "list_calls": stats.list_calls,
                                  "exit": EXIT_TEMPFAIL})
        return EXIT_TEMPFAIL

    rows: list[dict] = []
    for item in items.values():
        row = transform_poi(item)
        if row is None:
            stats.skipped_invalid += 1
            continue
        row["region"] = REGION_SEOUL
        rows.append(row)
    stats.transformed = len(rows)

    foreign = foreign_contentids(ctx, [r["contentid"] for r in rows])
    stats.skipped_foreign_region = sum(1 for r in rows if r["contentid"] in foreign)
    rows = [r for r in rows if r["contentid"] not in foreign]
    existing = seoul_facilities(ctx)
    existing_by_cid = {str(r["contentid"]): r for r in existing if r.get("contentid")}
    duplicates = set(find_probable_duplicates(rows, existing))
    photo_less = photo_less_new_ldong_contentids(rows, existing, ldong_only) - duplicates
    stats.skipped_duplicate, stats.skipped_photo_less_ldong = len(duplicates), len(photo_less)
    rows = [r for r in rows if r["contentid"] not in duplicates | photo_less]
    new_cids = {r["contentid"] for r in rows if r["contentid"] not in existing_by_cid}
    for row in rows:
        if row["contentid"] in new_cids:
            row["is_active"] = False  # 대기 — 쓴 뒤 점검을 통과하면 6단계가 켠다
    stats.new_rows, stats.existing_rows = len(new_cids), len(rows) - len(new_cids)
    detail_rows = details_order(rows, existing_by_cid)[: max(0, args.details_budget) // DETAIL_CALLS_PER_ROW]
    stats.details_planned_calls = len(detail_rows) * DETAIL_CALLS_PER_ROW

    if not rows and not args.reactivate:
        emit_counts("서울 적재", {**stats.as_dict(), "error": "no_rows", "exit": EXIT_FAILURE})
        return EXIT_FAILURE
    if not apply:
        emit_counts("서울 적재 미리보기(쓰기 0)", {**stats.as_dict(), "exit": EXIT_OK})
        return EXIT_OK

    stamp = ctx.now().isoformat()
    with _quiet(stats):
        for row in detail_rows:
            await enrich_row(row)
            row["features"] = {**(row.get("features") or {}), DETAILS_AT_KEY: stamp}
    stats.details_rows = len(detail_rows)

    created: list[str] = []
    touched: list[str] = []
    try:
        with _quiet(stats):
            stats.written = upsert_facilities(rows) if rows else 0
        if rows and stats.written == 0:
            emit_counts("서울 적재", {**stats.as_dict(), "error": "write_failed", "exit": EXIT_FAILURE})
            return EXIT_FAILURE
        now_seoul = seoul_facilities(ctx)
        by_cid = {str(r["contentid"]): r for r in now_seoul if r.get("contentid")}
        created = [str(by_cid[c]["id"]) for c in sorted(new_cids) if c in by_cid]
        touched = [str(by_cid[r["contentid"]]["id"]) for r in rows if r["contentid"] in by_cid]
        stats.created = len(created)

        revive: list[str] = []
        if args.sync or args.reactivate:
            showflags = await seoul_showflags(stats) if args.sync else {}
            revive = sync_seoul_showflags(ctx, now_seoul, showflags, reactivate=args.reactivate,
                                          staged=set(created), stats=stats)
        # 6. 이번 실행의 대기 행 + (--reactivate) 다시 켤 행을 켠다. 사람이 숨긴 행은 켜지 않는다.
        by_id = {str(r["id"]): r for r in now_seoul if r.get("id")}
        activate = [fid for fid in created if not is_manually_hidden((by_id.get(fid) or {}).get("features"))]
        _set_active(ctx, activate + revive, True)
        stats.activated, stats.reactivated = len(activate), len(revive)
        touched = sorted(set(touched) | set(revive))

        # 7·8. 서울 행이 있는 상태로 다시 확인한다.
        failures, policy_leak = await post_write_checks(ctx, probe, zones)
    except Exception as exc:  # noqa: BLE001 — 쓴 뒤 무엇이 깨졌든 먼저 되돌린다
        roll_back(ctx, touched=touched, created=created, all_seoul=False)
        emit_counts("서울 적재", {**stats.as_dict(), "error": "post_write_exception",
                                  "error_type": type(exc).__name__, "rolled_back": True, "exit": EXIT_FAILURE})
        return EXIT_FAILURE

    if failures:
        roll_back(ctx, touched=touched, created=created, all_seoul=policy_leak)
        counts = {"failures": sorted(failures), "policy_leak": policy_leak, "deactivated": len(touched),
                  "deleted": len(created), "all_seoul_deactivated": policy_leak}
        _event(ctx, EVENT_LEAK, counts)
        emit_counts("서울 적재 누수 감지 — 되돌림", {**counts, "exit": EXIT_LEAK})
        return EXIT_LEAK

    _event(ctx, EVENT, {k: v for k, v in stats.as_dict().items() if k != "per_zone"})
    _event(ctx, EVENT_DETAIL, {
        "created_contentids": sorted(new_cids & set(by_cid)),
        "skipped_foreign_contentids": sorted(foreign),
        "skipped_duplicate_contentids": sorted(duplicates),
        "skipped_photo_less_contentids": sorted(photo_less),
    })
    emit_counts("서울 적재 완료", {**stats.as_dict(), "exit": EXIT_OK})
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="서울 TourAPI POI 적재(개발자 전용 지역, 수동)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", dest="apply", action="store_false", help="쓰지 않고 집계만(기본)")
    mode.add_argument("--apply", dest="apply", action="store_true", help="facilities 에 쓴다")
    parser.set_defaults(apply=False)
    parser.add_argument("--details-budget", type=int, default=DEFAULT_DETAILS_BUDGET,
                        help=f"상세 조회 TourAPI 호출 상한(기본 {DEFAULT_DETAILS_BUDGET}, 행당 {DETAIL_CALLS_PER_ROW}콜)")
    parser.add_argument("--max-per-zone-type", type=int, default=0, help="구역·타입별 반경 목록 상한(0=전체)")
    parser.add_argument("--clusters", default="all", help="jongno,hongdae,validation 중 쉼표 목록 또는 all")
    parser.add_argument("--reactivate", action="store_true", help="region-guard 트립 뒤 숨기지 않은 서울 행을 다시 켠다")
    parser.add_argument("--no-sync", dest="sync", action="store_false", help="서울 showflag 동기화를 건너뛴다")
    return parser


async def _main_async(args: argparse.Namespace) -> int:
    from app.core.supabase import supabase_admin

    async with httpx.AsyncClient(follow_redirects=False) as http:
        return await run(args, Context(admin=supabase_admin, http=http, cfg=Config.from_env()))


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return asyncio.run(_main_async(args))
    except Exception as exc:  # noqa: BLE001 — 원문(키·URL 이 섞일 수 있다) 대신 종류만
        emit_counts("서울 적재", {"error": "unexpected", "error_type": type(exc).__name__, "exit": EXIT_FAILURE})
        return EXIT_FAILURE


if __name__ == "__main__":
    sys.exit(main())
