// 구역 혼잡 근거 한 줄 — 내부 검증 지역의 카드·코스·대기 보드가 같은 규칙으로 말한다(S3).
//
// 내부 지역 장소의 혼잡은 장소 하나의 실측이 아니라 그 장소가 속한 **구역(일대)의 실시간 인구** 다. 서버가 제공처
// 문구를 네 단계(level_band: relaxed · normal · slightly_busy · busy)로 정규화해 내려 준다 — 화면은 그 단계를
// **앱 공통 혼잡 등급**(congestion.quiet · relaxed · moderate · busy = 한산·여유·보통·혼잡)으로 옮긴다(번들에 제공처
// 문구를 두지 않는다). 서버가 단계 대신 보내는 수준은 단계 중앙값(0.125·0.375·0.625·0.875)이라 칩·지도 핀이
// congestionKey 로 옮긴 등급과 이 등급이 같다 — 같은 관측을 한 단어·한 색으로 말한다(DESIGN_PRINCIPLES 7).
//
//   · 단계(band) — 도착 때 단계가 있으면 그것(순위가 본 값과 같다), 없으면 지금 단계. **지금이 아닌**(30분이 넘은)
//     구역 관측은 단계로 말하지 않는다 — 근거가 null 이 되고 화면은 경주와 같은 '마지막 관측' 표기로 물러선다
//     (DESIGN_PRINCIPLES 7 · 지도 구역 오버레이도 지금이 아니면 단계를 칠하지 않는다).
//   · 근거(basis) — 'provider_forecast' 면 '{time} 도착 기준 예측', 'persistence' 거나 모르면 '{min}분 전 관측'.
//   · 평소 대비(usual_comparison) — **보조 문장만** 만든다. 단계(band) 키를 절대 바꾸지 않는다: 순위는 절대 단계로
//     매기고(사용자 결정 4), '평소보다 한산해요' 는 화면에 덧붙이는 설명일 뿐이다.
//
// 경주 응답에는 이 필드들이 없다 — 모든 함수가 null 을 돌려주고 화면은 아무것도 그리지 않는다(경주 화면 불변).

import type { CongestionKey } from './congestionScale';

/** 서버 level_band 값. */
export type ZoneBandValue = 'relaxed' | 'normal' | 'slightly_busy' | 'busy';
/** 서버 usual_comparison 값. */
export type ZoneUsualValue = 'busier' | 'usual' | 'quieter';
/** 서버 congestion_arrival_basis 값(코스의 zone_crowd.basis 도 같다). */
export type ZoneBasisValue = 'persistence' | 'provider_forecast';

/** 구역 단계 → 앱 공통 혼잡 등급(칩 색·핀 색도 이 등급). */
const BAND_GRADES: Readonly<Record<ZoneBandValue, CongestionKey>> = Object.freeze({
  relaxed: 'quiet',
  normal: 'relaxed',
  slightly_busy: 'moderate',
  busy: 'busy',
});

export type ZoneBandKey = `congestion.${CongestionKey}`;
export type ZoneUsualKey = 'card.zoneUsual.busier' | 'card.zoneUsual.usual' | 'card.zoneUsual.quieter';


const USUAL_KEYS: Readonly<Record<ZoneUsualValue, ZoneUsualKey>> = Object.freeze({
  busier: 'card.zoneUsual.busier',
  usual: 'card.zoneUsual.usual',
  quieter: 'card.zoneUsual.quieter',
});

function own<T extends object>(table: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

/** level_band → 앱 공통 혼잡 등급(색 · 라벨의 근원). 모르는 값·빈 값은 null(지어내지 않는다). */
export function zoneBandGrade(band: unknown): CongestionKey | null {
  return own(BAND_GRADES, band) ? BAND_GRADES[band] : null;
}

/**
 * 구역 근거의 혼잡 수준(0~1) → 등급. 내부 지역 서버가 보내는 수준은 구역 단계 중앙값(0.125·0.375·0.625·0.875)이라
 * 등급 경계도 **구역 단계 경계**(0.25·0.5·0.75)다 — 운영자가 바꾸는 경주의 '혼잡' 경계(system_settings.congestion_threshold)
 * 를 쓰면 같은 구역이 코스 막대에서는 '보통', 정류장 칩에서는 '혼잡' 이 됐다. 숫자가 아니면 null.
 */
export function zoneLevelGrade(level: unknown): CongestionKey | null {
  if (typeof level !== 'number' || !Number.isFinite(level)) return null;
  if (level >= 0.75) return 'busy';
  if (level >= 0.5) return 'moderate';
  if (level >= 0.25) return 'relaxed';
  return 'quiet';
}

/** congestion.* 라벨 키 → 등급(칩·핀 색). zoneBandKey 의 역. */
export function zoneKeyGrade(key: ZoneBandKey): CongestionKey {
  return key.slice('congestion.'.length) as CongestionKey;
}

/** level_band → congestion.* 라벨 키. 모르는 값·빈 값은 null. */
export function zoneBandKey(band: unknown): ZoneBandKey | null {
  const grade = zoneBandGrade(band);
  return grade ? `congestion.${grade}` : null;
}

/** usual_comparison → card.zoneUsual.* 키. 모르는 값·빈 값은 null. */
export function zoneUsualKey(comparison: unknown): ZoneUsualKey | null {
  return own(USUAL_KEYS, comparison) ? USUAL_KEYS[comparison] : null;
}

/** 화면 세 곳(카드 · 코스 정류장 · 지도 시설)이 모아 오는 구역 근거 — 전부 camelCase(keysToCamel 뒤). */
export interface ZoneEvidence {
  zoneName: string;
  /** 지금 단계. */
  band: ZoneBandValue | null;
  /** 도착 때 단계(추천·코스만). 있으면 이것을 말한다. */
  arrivalBand: ZoneBandValue | null;
  basis: ZoneBasisValue | null;
  observedAt: string | null;
  forecastTargetAt: string | null;
  usualComparison: ZoneUsualValue | null;
  /** 지금 단계가 '지금'(관측 30분 안)인가. null = 서버가 알려 주지 않음(관측 시각으로 판정). */
  isCurrent: boolean | null;
}

/** 구역 관측이 '지금' 을 말할 수 있는 나이(서버 zone_evidence.ZONE_NOW_WINDOW 와 같다). */
export const ZONE_NOW_WINDOW_MS = 30 * 60_000;

type Loose = Record<string, unknown> | null | undefined;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function band(value: unknown): ZoneBandValue | null {
  return own(BAND_GRADES, value) ? value : null;
}

function usual(value: unknown): ZoneUsualValue | null {
  return own(USUAL_KEYS, value) ? value : null;
}

function basis(value: unknown): ZoneBasisValue | null {
  return value === 'persistence' || value === 'provider_forecast' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function evidence(input: ZoneEvidence): ZoneEvidence | null {
  if (!input.zoneName) return null;
  if (!input.band && !input.arrivalBand) return null;
  return input;
}

/**
 * 추천 응답 breakdown(camelCase) 의 구역 키 → 근거. 구역 근거가 아닌 breakdown(경주 전부)은 null.
 * 키: zoneName · zoneLevelBand · zoneArrivalLevelBand · congestionArrivalBasis · zoneObservedAt · zoneForecastTargetAt ·
 * zoneUsualComparison · zoneIsCurrent(서버 score.py 가 구역 근거일 때만 더한다).
 */
export function zoneEvidenceFromBreakdown(breakdown: Loose): ZoneEvidence | null {
  if (!breakdown || typeof breakdown !== 'object') return null;
  return evidence({
    zoneName: str(breakdown.zoneName) ?? '',
    band: band(breakdown.zoneLevelBand),
    arrivalBand: band(breakdown.zoneArrivalLevelBand),
    basis: basis(breakdown.congestionArrivalBasis),
    observedAt: str(breakdown.zoneObservedAt),
    forecastTargetAt: str(breakdown.zoneForecastTargetAt),
    usualComparison: usual(breakdown.zoneUsualComparison),
    isCurrent: bool(breakdown.zoneIsCurrent),
  });
}

/** 코스 정류장 facility.zoneCrowd({zoneName, arrivalBand, basis, observedAt, forecastTargetAt, usualComparison}) → 근거. */
export function zoneEvidenceFromCourseStop(zoneCrowd: Loose): ZoneEvidence | null {
  if (!zoneCrowd || typeof zoneCrowd !== 'object') return null;
  return evidence({
    zoneName: str(zoneCrowd.zoneName) ?? '',
    band: null,
    arrivalBand: band(zoneCrowd.arrivalBand),
    basis: basis(zoneCrowd.basis),
    observedAt: str(zoneCrowd.observedAt),
    forecastTargetAt: str(zoneCrowd.forecastTargetAt),
    usualComparison: usual(zoneCrowd.usualComparison),
    isCurrent: null,
  });
}

/** 지도 시설의 zone(ZoneCrowdView) → 근거. 지금 단계만 있고 근거는 관측이다. 지금이 아닌 구역(isCurrent=false)은 단계를 말하지 않는다(zoneEvidenceLines). */
export function zoneEvidenceFromZoneView(zone: Loose): ZoneEvidence | null {
  if (!zone || typeof zone !== 'object') return null;
  return evidence({
    zoneName: str(zone.zoneName) ?? '',
    band: band(zone.levelBand),
    arrivalBand: null,
    basis: 'persistence',
    observedAt: str(zone.observedAt),
    forecastTargetAt: null,
    usualComparison: usual(zone.usualComparison),
    isCurrent: bool(zone.isCurrent),
  });
}

/** 단계 없이 '마지막 관측' 만 남기는 장소 기록 조각(partialZoneObservation). */
export interface PartialZoneObservation {
  congestionSource: 'measured';
  congestionLogSource: string | null;
  congestionIsCurrent: false;
}

/**
 * 내부 지역 장소 목록(GET /internal/regions/{r}/infrastructures)의 항목 하나 → '마지막 관측' 조각. 여러 구역에 걸친 시설에서
 * 한 구역이 읽히지 않으면 서버가 수준 · 단계를 비운다(congestion.level = null, zone.levelBand = null — 조용한 쪽 구역 하나로
 * '한산' 을 말하지 않게). 그때 화면은 단계를 말하지 않고 '마지막 관측 {시각}' 만 남긴다: 실측이지만(measured) 지금이 아닌
 * (isCurrent false) 수준 없는 기록 → 카드의 congestionDisplay 가 lastObserved(수준 없음)로 옮긴다.
 * 구역이 없는 항목(경주 전부) · 수준이 있는 항목 · 관측 시각이 없는 항목은 null — 기록 모양이 그대로다.
 */
export function partialZoneObservation(item: Loose): PartialZoneObservation | null {
  if (!item || typeof item !== 'object' || !item.zone) return null;
  const congestion = item.congestion as Record<string, unknown> | null | undefined;
  if (!congestion || typeof congestion !== 'object') return null;
  if (typeof congestion.level === 'number') return null;
  if (!str(congestion.timestamp)) return null;
  return { congestionSource: 'measured', congestionLogSource: str(congestion.source), congestionIsCurrent: false };
}

/** 지금 단계가 '지금' 인가 — 서버 값이 있으면 그것, 없으면 관측 시각이 30분 안인지(벽시계). */
function bandIsCurrent(ev: ZoneEvidence, nowMs: number): boolean {
  if (ev.isCurrent !== null) return ev.isCurrent;
  if (!ev.observedAt) return false;
  const observedMs = Date.parse(ev.observedAt);
  if (!Number.isFinite(observedMs)) return false;
  // 미래 시각(기기 시계가 서버보다 늦음)은 지금으로 본다 — 'N분 전' 도 0분으로 그린다.
  return nowMs - observedMs <= ZONE_NOW_WINDOW_MS;
}

/** i18n 키 하나와 그 자리값. 화면은 t(key, params) 로만 그린다. */
export interface ZoneLine {
  key: string;
  params?: Record<string, string | number>;
}

export interface ZoneEvidenceLines {
  /** 단계 라벨(congestion.* — 앱 공통 등급). */
  band: ZoneLine & { key: ZoneBandKey };
  /** '{zone} 일대 실시간 인구 기준'. */
  source: ZoneLine;
  /** '{time} 도착 기준 예측' 또는 '{min}분 전 관측'. 시각을 모르면 null. */
  basis: ZoneLine | null;
  /** 평소 대비 보조 문장 — 단계와 독립. 없으면 null. */
  usual: (ZoneLine & { key: ZoneUsualKey }) | null;
}

/** HH:MM(서울 시각) — 카드·코스의 다른 시각 표기와 같은 24시간 두 자리. */
export function zoneClock(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * 근거를 화면 줄(키 + 자리값)로 옮긴다. 단계를 말할 수 없으면 null. 순수 함수.
 * 도착 단계가 없고 지금 단계가 '지금' 이 아니면(낡은 관측) null — 낡은 단계를 지금처럼 칩에 올리지 않는다.
 */
export function zoneEvidenceLines(ev: ZoneEvidence | null | undefined, nowMs: number): ZoneEvidenceLines | null {
  if (!ev) return null;
  if (!ev.arrivalBand && !bandIsCurrent(ev, nowMs)) return null;
  const bandKey = zoneBandKey(ev.arrivalBand ?? ev.band);
  if (!bandKey) return null;
  let basisLine: ZoneLine | null = null;
  const forecastTime = ev.basis === 'provider_forecast' && ev.forecastTargetAt ? zoneClock(ev.forecastTargetAt) : null;
  if (forecastTime) {
    basisLine = { key: 'card.zoneForecastAt', params: { time: forecastTime } };
  } else if (ev.observedAt) {
    const observedMs = Date.parse(ev.observedAt);
    if (Number.isFinite(observedMs)) {
      basisLine = { key: 'card.zoneObservedAgo', params: { min: Math.max(0, Math.round((nowMs - observedMs) / 60000)) } };
    }
  }
  const usualKey = zoneUsualKey(ev.usualComparison);
  return {
    band: { key: bandKey },
    source: { key: 'card.zoneSource', params: { zone: ev.zoneName } },
    basis: basisLine,
    usual: usualKey ? { key: usualKey } : null,
  };
}
