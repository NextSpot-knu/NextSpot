// 안전 경보 화면의 판정 — 순수 함수(P0-4). 화면(app/admin/safety/page.tsx)은 이 결과를 그리기만 한다.
//
// 공공 안전 화면에서 가장 나쁜 실패는 '모름' 을 '정상' 으로 보여 주는 것이다. 예전 화면은 관측이 하나도 없으면
// 초록색 "전 구역 정상 운영 중입니다" 를 띄웠고, 서버는 2주 전 제보 한 건으로 '경보' 를 만들었다.
// 지금 규칙:
//   · 서버가 최근 30분 안의 관측만으로 판정한다(apps/api/app/routers/safety.py — 추천 순위의 '지금' 과 같은 창).
//   · 그런 관측이 없으면 '판정 불가'(회색)다. '정상' 은 관측이 있는 존에만 쓴다.
//   · 옛 서버(관측 나이를 싣지 않는 응답)는 나이를 확인할 수 없다 — 경보·주의 존은 그리되(위험 신호를 숨기지 않는다)
//     '정상' 이라고는 말하지 않는다.

/** 서버 기본 판정 창(분) — 응답 meta.maxObservationAgeMinutes 가 없을 때만 쓴다. */
export const SAFETY_DEFAULT_WINDOW_MINUTES = 30;

export interface SafetyZoneLike {
  level: 'alert' | 'warn' | 'normal';
  observedAt?: string | null;
}

export interface SafetyStatusLike {
  judgement?: 'available' | 'unavailable';
  sampleEmpty?: boolean;
  latestObservedAt?: string | null;
  meta?: { maxObservationAgeMinutes?: number } | null;
  zones?: readonly SafetyZoneLike[] | null;
}

export type SafetyJudgement =
  /** 판정 불가 — 최근 창 안의 관측이 없다(ageKnown=false 면 옛 서버라 나이를 확인할 수 없다). */
  | { kind: 'unavailable'; windowMinutes: number; latestObservedAt: string | null; ageKnown: boolean }
  /** 관측된 존이 모두 주의 기준 미만 — '정상' 은 이 존들에만 해당한다. */
  | { kind: 'clear'; windowMinutes: number; observedZones: number }
  /** 경보·주의 존이 있다. */
  | { kind: 'zones'; windowMinutes: number; ageKnown: boolean };

export function resolveSafetyJudgement(res: SafetyStatusLike | null | undefined): SafetyJudgement {
  const minutes = res?.meta?.maxObservationAgeMinutes;
  const windowMinutes = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : SAFETY_DEFAULT_WINDOW_MINUTES;
  const zones = Array.isArray(res?.zones) ? res.zones : [];
  const flagged = zones.some((z) => z.level === 'alert' || z.level === 'warn');
  const latestObservedAt = typeof res?.latestObservedAt === 'string' ? res.latestObservedAt : null;

  if (res?.judgement === 'available' || res?.judgement === 'unavailable') {
    if (res.judgement === 'unavailable' || zones.length === 0) {
      return { kind: 'unavailable', windowMinutes, latestObservedAt, ageKnown: true };
    }
    return flagged ? { kind: 'zones', windowMinutes, ageKnown: true } : { kind: 'clear', windowMinutes, observedZones: zones.length };
  }
  // 옛 서버 — 관측 나이를 모른다.
  if (flagged && !res?.sampleEmpty) return { kind: 'zones', windowMinutes, ageKnown: false };
  return { kind: 'unavailable', windowMinutes, latestObservedAt: null, ageKnown: false };
}

/** '방금' · '12분 전' · '3시간 전' · '14일 전'. 읽을 수 없거나 미래면 null. */
export function relativeAgeLabel(iso: string | null | undefined, nowMs: number): string | null {
  const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  const minutes = Math.floor((nowMs - at) / 60_000);
  if (minutes < 0) return null;
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** KST 시각 — 오늘이면 'HH:MM', 아니면 'M/D HH:MM'. 브라우저 시간대와 무관하게 +9h 로 환산한다. */
export function kstClockLabel(iso: string | null | undefined, nowMs: number): string | null {
  const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const k = new Date(at + 9 * 3_600_000);
  const today = new Date(nowMs + 9 * 3_600_000);
  const hhmm = `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
  const sameDay = k.getUTCFullYear() === today.getUTCFullYear() && k.getUTCMonth() === today.getUTCMonth() && k.getUTCDate() === today.getUTCDate();
  return sameDay ? hhmm : `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${hhmm}`;
}

const SOURCE_LABELS: Record<string, string> = {
  user_report: '손님 제보',
  merchant_report: '좌석 방송',
  admin_override: '관리자 입력',
  traffic_cctv: 'CCTV',
  tour_api: '관광공사',
  event: '행사 정보',
};

/** 존 판정의 출처 한 줄 — '손님 제보 2 · 관리자 입력 1'(많은 순). 모르는 출처는 '기타' 로 묶는다. */
export function zoneSourceLine(sourceCounts: Record<string, number> | null | undefined): string | null {
  const merged = new Map<string, number>();
  for (const [key, value] of Object.entries(sourceCounts ?? {})) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const label = SOURCE_LABELS[key] ?? '기타';
    merged.set(label, (merged.get(label) ?? 0) + value);
  }
  if (merged.size === 0) return null;
  return [...merged.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${label} ${n}`).join(' · ');
}
