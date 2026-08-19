"""경주시 일반·휴게음식점 LOCALDATA 동기화 CLI.

기본은 dry-run이다. baseline은 내려받은 전체 CSV 두 파일을 사용하고 delta는
LOCALDATA_AUTH_KEY로 변경분을 중첩 조회한다. 수집/파싱이 모두 끝난 뒤 단일 DB RPC를
호출하므로 일부 파일·페이지 실패 시 어떤 행도 반영되지 않는다.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

API_URL = "https://www.localdata.go.kr/platform/rest/TO0/openDataApi"
SERVICES = ("07_24_04_P", "07_24_05_P")
PAGE_SIZE = 1000

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from app.services.localdata import find_duplicate, normalize_record  # noqa: E402


def decode_csv(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("CSV 인코딩을 UTF-8/CP949/EUC-KR로 해석할 수 없습니다")


def read_csv(path: Path) -> list[dict]:
    text = decode_csv(path.read_bytes())
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError(f"CSV 헤더가 없습니다: {path}")
    return list(reader)


async def fetch_delta(service: str, start: date, end: date, key: str) -> list[dict]:
    rows, page = [], 1
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            response = await client.get(
                API_URL,
                params={
                    "authKey": key,
                    "opnSvcId": service,
                    "localCode": "4713000",
                    "lastModTsBgn": start.strftime("%Y%m%d"),
                    "lastModTsEnd": end.strftime("%Y%m%d"),
                    "pageIndex": page,
                    "pageSize": PAGE_SIZE,
                    "resultType": "json",
                },
            )
            response.raise_for_status()
            payload = response.json()
            body = payload.get("body", payload)
            page_rows = body.get("rows") or body.get("items") or body.get("data") or []
            if isinstance(page_rows, dict):
                page_rows = page_rows.get("row") or page_rows.get("item") or []
            if not isinstance(page_rows, list):
                raise ValueError(f"LOCALDATA 응답 행 형식이 올바르지 않습니다: {service} page={page}")
            rows.extend(page_rows)
            total = int(body.get("totalCount") or body.get("total") or len(rows))
            if not page_rows or len(rows) >= total or len(page_rows) < PAGE_SIZE:
                break
            page += 1
    return rows


def load_db_context() -> tuple[list[dict], dict[str, dict]]:
    from app.core.supabase import supabase_admin

    facilities = supabase_admin.table("facilities").select(
        "id,name,address,latitude,longitude,type,features,is_active"
    ).execute().data or []
    refs = supabase_admin.table("facility_source_refs").select(
        "facility_id,source,external_id,source_status,source_updated_at,source_hash"
    ).execute().data or []
    return facilities, {str(r["external_id"]): r for r in refs if r.get("source") == "localdata"}


def require_recent_delta_checkpoint() -> None:
    """7일 초과 공백은 delta가 완전성을 보장할 수 없으므로 baseline으로 fail-closed한다."""
    from app.core.supabase import supabase_admin

    result = (supabase_admin.table("app_events").select("created_at")
              .eq("event", "localdata_sync").order("created_at", desc=True).limit(1).execute())
    if not result.data:
        raise ValueError("최초 LOCALDATA 반영 전 baseline --apply가 필요합니다")
    checkpoint = datetime.fromisoformat(str(result.data[0]["created_at"]).replace("Z", "+00:00"))
    if datetime.now(timezone.utc) - checkpoint > timedelta(days=7):
        raise ValueError("마지막 LOCALDATA 동기화 후 7일이 지나 baseline 재수집이 필요합니다")


def build_actions(raw_by_service: dict[str, list[dict]], facilities: list[dict], refs: dict[str, dict]):
    actions, quarantined = [], []
    for service, rows in raw_by_service.items():
        for raw in rows:
            record, reason = normalize_record(raw, service)
            if reason:
                quarantined.append({"service": service, "reason": reason})
                continue
            prior = refs.get(record["external_id"])
            duplicate_reason = "management_number" if prior else None
            facility_id = str(prior["facility_id"]) if prior else None
            if not facility_id:
                facility_id, duplicate_reason = find_duplicate(record, facilities)
            if duplicate_reason == "multiple_duplicate_candidates":
                quarantined.append({
                    "external_id": record["external_id"], "name": record["name"],
                    "reason": duplicate_reason,
                })
                continue
            if not record["is_active"] and not facility_id:
                # 폐업/휴업 행은 기존 시설 비활성화 근거로만 사용하며 새 후보를 만들지 않는다.
                quarantined.append({
                    "external_id": record["external_id"], "name": record["name"],
                    "reason": "inactive_without_existing_facility",
                })
                continue
            action = {k: v for k, v in record.items() if not k.startswith("normalized_")}
            action["facility_id"] = facility_id
            action["duplicate_rule"] = duplicate_reason
            actions.append(action)
    return actions, quarantined


async def run(args: argparse.Namespace) -> dict:
    if args.mode == "delta" and args.apply:
        require_recent_delta_checkpoint()
    if args.mode == "baseline":
        if not args.general_csv or not args.snack_csv:
            raise ValueError("baseline에는 --general-csv와 --snack-csv가 모두 필요합니다")
        raw_by_service = {
            SERVICES[0]: read_csv(args.general_csv),
            SERVICES[1]: read_csv(args.snack_csv),
        }
    else:
        key = os.getenv("LOCALDATA_AUTH_KEY")
        if not key:
            raise ValueError("delta에는 LOCALDATA_AUTH_KEY가 필요합니다")
        end = args.end_date or date.today()
        start = args.start_date or end - timedelta(days=7)
        if (end - start).days > 7:
            raise ValueError("delta 조회 기간은 중첩 포함 최대 7일입니다. baseline 재수집이 필요합니다")
        # gather 중 하나라도 실패하면 DB 컨텍스트를 읽기 전 예외로 종료한다.
        fetched = await asyncio.gather(*(fetch_delta(s, start, end, key) for s in SERVICES))
        raw_by_service = dict(zip(SERVICES, fetched, strict=True))

    facilities, refs = load_db_context()
    actions, quarantined = build_actions(raw_by_service, facilities, refs)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "apply": args.apply,
        "collected": sum(map(len, raw_by_service.values())),
        "eligible": len(actions),
        "new": sum(a["facility_id"] is None for a in actions),
        "merged": sum(a["facility_id"] is not None for a in actions),
        "quarantined": len(quarantined),
        "quarantine": quarantined,
        "actions": actions,
    }
    if args.apply:
        from app.core.supabase import supabase_admin

        result = supabase_admin.rpc("apply_localdata_sync", {"actions": actions}).execute()
        report["db_result"] = result.data
        supabase_admin.table("app_events").insert({
            "event": "localdata_sync",
            "props": {k: report[k] for k in ("mode", "collected", "eligible", "new", "merged", "quarantined")},
        }).execute()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("mode", choices=("baseline", "delta"))
    value.add_argument("--apply", action="store_true")
    value.add_argument("--general-csv", type=Path)
    value.add_argument("--snack-csv", type=Path)
    value.add_argument("--start-date", type=date.fromisoformat)
    value.add_argument("--end-date", type=date.fromisoformat)
    value.add_argument("--report", type=Path, default=Path("../../scratch/localdata_ingest.json"))
    return value


if __name__ == "__main__":
    parsed = parser().parse_args()
    try:
        result = asyncio.run(run(parsed))
        print(json.dumps({k: v for k, v in result.items() if k not in {"actions", "quarantine"}}, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001 - CLI는 실패를 비영(부분 성공)으로 숨기지 않는다.
        print(f"LOCALDATA 동기화 실패: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
