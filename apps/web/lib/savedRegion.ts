// 저장 장소를 지금 지역으로 거른다(S3) — /saved 가 경주에서는 경주 저장만, 내부 지역에서는 그 지역 저장만 보여 준다.
//
// 저장 목록(localStorage nextspot_saved_facilities + Supabase saved_facilities)은 지역 구분 없이 한 목록이다. 어느 지역의
// 저장인지는 이렇게 정한다:
//   1. 저장할 때 붙인 지역 표시(record.region) — /main 이 **내부 지역에서 저장할 때만** 붙인다. 경주 저장의 스냅숏은
//      오늘과 같은 모양이라 표시가 없다.
//   2. 표시가 없으면 좌표 — 아는 내부 지역 묶음(isWithinPack) 안이면 그 지역이다.
//   3. 그 밖(표시도 없고 내부 지역 안도 아님, 좌표가 없는 옛 저장 포함)은 경주다.
//
// 왜 경주를 '경주 경계 안' 으로 거르지 않는가: 경주 묶음의 경계는 황리단길 둘레의 좁은 지오펜스라 불국사·보문 같은
// 경주 저장이 그 밖에 있다. 경계로 거르면 경주 사용자의 저장이 사라진다 — 경주 화면은 오늘과 같아야 한다. 관광객·게스트
// (내부 지역을 모른다)에게는 표시가 붙은 내부 지역 저장만 빠지고, 나머지는 그대로다.
import { GYEONGJU_PACK, isWithinPack, type RegionPack } from './regionPacks';
import { PUBLIC_REGION_ID } from './regionRuntime';

export interface SavedRegionRecord {
  region?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 저장 한 건이 속한 지역 id. internalPacks 는 이 기기가 아는 내부 지역 묶음(내부 계정이 아니면 비어 있다). */
export function savedRecordRegion(record: SavedRegionRecord, internalPacks: readonly RegionPack[] = []): string {
  if (typeof record.region === 'string' && record.region.trim()) return record.region.trim();
  if (finite(record.latitude) && finite(record.longitude)) {
    for (const pack of internalPacks) {
      if (pack.id !== PUBLIC_REGION_ID && isWithinPack(pack, record.latitude, record.longitude)) return pack.id;
    }
  }
  return PUBLIC_REGION_ID;
}

/**
 * 지금 지역(pack)의 저장만 남긴다. 순서는 그대로. 지금 지역이 내부 지역이면 그 묶음도 '아는 내부 지역' 에 넣는다.
 * 순수 함수.
 */
export function filterSavedForPack<T extends SavedRegionRecord>(
  list: readonly T[],
  pack: RegionPack = GYEONGJU_PACK,
  internalPacks: readonly RegionPack[] = [],
): T[] {
  const known = pack.id !== PUBLIC_REGION_ID && !internalPacks.some((p) => p.id === pack.id)
    ? [pack, ...internalPacks]
    : internalPacks;
  return list.filter((record) => savedRecordRegion(record, known) === pack.id);
}

/**
 * 저장 스냅숏에 붙일 지역 표시. 경주는 아무것도 붙이지 않는다({}) — 경주 저장의 모양은 오늘과 같다.
 * 내부 지역은 { region: id }.
 */
export function savedRegionTag(pack: RegionPack): { region?: string } {
  return pack.id === PUBLIC_REGION_ID ? {} : { region: pack.id };
}
