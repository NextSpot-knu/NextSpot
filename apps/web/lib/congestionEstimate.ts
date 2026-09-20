// 경주 **추정 모드** — 주차 실측 + 관광 통계로 만든 시설별 혼잡 추정의 화면 계약.
//
// 백엔드(app/services/congestion_estimator_service.py)가 `congestion_estimate` 로 싣는 값이다.
// 실측이 아니다. 이 모듈이 지키는 선은 셋이다:
//
//   1) **따로 둔다.** 추정은 `congestionLevel`·`baseCongestion`·`currentCount` 에 절대 들어가지
//      않는다. 그 필드들은 클라 미러(lib/recommender.ts 의 scoreFacility)가 실측처럼 대기 분을
//      계산하고, 히트맵·저장 북마크·음성 후보가 '관측' 으로 읽는 자리다. 한 번 섞이면 추정이
//      실측 등급(measured_rules)으로 순위를 얻고 '예상 대기 n분' 으로 팔린다.
//   2) **낡으면 버린다.** 시설 목록은 localStorage 에 24시간 캐시된다(main 의 FACILITY_CACHE).
//      어제 밤 캐시가 첫 화면에 그려질 때 그 추정을 '지금' 으로 보여 주면 이 모드가 막으려던
//      바로 그 거짓말이 된다. 백엔드가 스냅샷을 60분까지만 '지금' 으로 인정하므로(MAX_SNAPSHOT_AGE)
//      화면도 같은 선을 쓴다 — 오래 열어 둔 탭도 같은 이유로 걸러진다.
//   3) **'지금' 자격이 있는 실측·예측이 있으면 말하지 않는다.** 서버가 이미 그 규칙으로 내려주지만
//      (측정(신선·신뢰) > 예측 > 추정 > 없음), 화면 쪽에서도 한 번 더 막는다. 두 숫자가 한 카드에
//      나란히 뜨면 사용자는 어느 쪽이 지금인지 고를 수 없다.
//
// **'지금' 판정 자체는 이 파일이 하지 않는다.** 서버가 `congestionIsCurrent` 로 결론만 내려보낸다
// (백엔드 congestion_evidence.measurement_is_current — verified/corroborated · 30분 이내).
// 같은 판단을 프런트가 다시 구현하면 네 번째 복사본이 되고, 애초에 판정에 필요한 evidence_tier 는
// 응답에 실리지도 않는다. 그 필드가 없는 구 서버 응답에서는 종전 규칙(실측 숫자가 있으면 추정을
// 감춘다) 그대로 동작한다 — 배포 시차에서 화면이 값을 잃지 않는다.

import type { CongestionEstimate } from './api-client';

/** 백엔드 parking_derived_congestion_service.MAX_SNAPSHOT_AGE 와 같은 선(60분). */
export const ESTIMATE_MAX_AGE_MS = 60 * 60 * 1000;

// 미래 시각 허용 폭. 서버·기기 시계가 몇 분 어긋나는 건 흔하다 — 그걸로 추정을 지우지는 않되,
// 한참 미래(=파싱 오류나 잘못된 값)는 '지금' 이라고 믿지 않는다.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 응답의 추정 한 건을 검증한다. 모양이 어긋나거나 낡았으면 `null`.
 *
 * 구 서버(필드 자체가 없음)·오염된 캐시·스냅샷 60분 초과는 전부 `null` 로 떨어진다 —
 * 그때 화면은 오늘과 같은 '근거 없음' 으로 그린다. 모르면 그리지 않는다.
 */
export function parseCongestionEstimate(raw: unknown, now: Date = new Date()): CongestionEstimate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== 'estimated') return null;
  const level = finite(r.level);
  if (level === null || level < 0 || level > 1) return null;
  if (typeof r.observedAt !== 'string' || !r.observedAt) return null;
  const observedMs = new Date(r.observedAt).getTime();
  if (Number.isNaN(observedMs)) return null;
  const age = now.getTime() - observedMs;
  if (age > ESTIMATE_MAX_AGE_MS || age < -FUTURE_SKEW_MS) return null;
  const parkingLevel = finite(r.parkingLevel);
  const tourismLevel = finite(r.tourismLevel);
  const lotCount = finite(r.lotCount);
  const nearestLotM = finite(r.nearestLotM);
  const radiusM = finite(r.radiusM);
  const rawLevel = finite(r.rawLevel);
  return {
    level,
    source: 'estimated',
    observedAt: r.observedAt,
    parkingLevel: parkingLevel ?? level,
    tourismLevel,
    lotCount: lotCount !== null ? Math.max(0, Math.round(lotCount)) : 0,
    nearestLotM,
    radiusM: radiusM !== null && radiusM > 0 ? radiusM : 2000,
    // 보정 흔적(서울 실측 보정). 구 서버 응답에는 없으므로 전부 관용적으로 읽는다 —
    // rawLevel 이 없으면 보정 전 원값이 곧 level 이고, calibrated 는 모르면 false 다.
    // calibrationBasis 는 백엔드가 만든 **한국어 문장**이라 화면에 그대로 쓰지 않는다
    // (4개 로케일을 지킬 수 없다). 화면이 쓰는 것은 아래 calibrated 불리언뿐이다.
    rawLevel: rawLevel !== null && rawLevel >= 0 && rawLevel <= 1 ? rawLevel : level,
    calibrated: r.calibrated === true,
    calibrationBasis: typeof r.calibrationBasis === 'string' ? r.calibrationBasis : null,
  };
}

export interface CongestionDisplayInput {
  congestionLevel?: number | null;
  congestionSource?: string | null;
  /** 서버 판정(백엔드 evidence_is_current). 구 응답엔 없다 — undefined 는 '종전대로'다. */
  congestionIsCurrent?: boolean | null;
  /** 실측 관측 시각(ISO). '마지막 관측 HH:MM' 문구에만 쓴다. */
  congestionTimestamp?: string | null;
  congestionEstimate?: unknown;
}

/**
 * 화면에 **보여도 되는** 추정. '지금' 자격이 있는 실측·예측 숫자가 있으면 `null` 이다.
 *
 * 기본 규칙은 예전과 같다 — `congestionSource` 가 'measured'/'predicted' 이거나 `congestionLevel`
 * 이 숫자면 그 값이 이긴다. 달라진 것은 **서버가 그 값을 '지금' 이 아니라고 말한 경우**
 * (`congestionIsCurrent === false`: 30분이 지났거나 단건 제보)뿐이다. 그때는 추정이 통과한다 —
 * 한 달 된 관측이 방금 관측한 주차 실측을 가리는 것이 우리가 고치려는 문제였다.
 *
 * `congestionIsCurrent` 가 없으면(구 서버) 종전 동작 그대로다. 로컬 제보처럼 화면이 직접 만든
 * 실측은 이 필드를 주지 않으므로 계속 추정을 이긴다 — 사용자가 방금 눈으로 본 값이다.
 */
export function displayableEstimate(
  input: CongestionDisplayInput,
  now: Date = new Date(),
): CongestionEstimate | null {
  if (input.congestionIsCurrent !== false) {
    if (typeof input.congestionLevel === 'number' && Number.isFinite(input.congestionLevel)) return null;
    if (input.congestionSource === 'measured' || input.congestionSource === 'predicted') return null;
  }
  return parseCongestionEstimate(input.congestionEstimate, now);
}

/** 카드·상세·코스가 '지금' 칸에 칠할 것. 이 판단의 사본을 화면마다 두지 않기 위한 단일 함수다. */
export interface CongestionDisplay {
  /** 'measured'/'predicted' 면 level 을, 'estimated' 면 estimate 를, 'none' 이면 아무것도 칠하지 않는다. */
  mode: 'measured' | 'predicted' | 'estimated' | 'none';
  /** mode 가 measured/predicted 일 때의 혼잡도. 그 밖에는 null(0 으로 채우지 않는다). */
  level: number | null;
  /** mode === 'estimated' 일 때의 검증된 추정. */
  estimate: CongestionEstimate | null;
  /**
   * '지금' 자격을 잃은 실측 관측. **지우지 않는다** — 추정에 자리를 내줬든(mode='estimated'),
   * 대신할 추정이 없어 그대로 칠하든(mode='measured' + stale) 언제 본 값인지는 말해 준다.
   * 화면은 이걸 'card.lastObserved'("마지막 관측 HH:MM")로 그린다.
   */
  lastObserved: { level: number | null; observedAt: string | null } | null;
}

/**
 * 서버 판정(`congestionIsCurrent`) + 추정 검증(60분)을 합쳐 '무엇을 지금으로 그릴지' 하나로 낸다.
 *
 * 왜 함수로 뺐나: 같은 판단이 추천 카드·추천 목록·코스 화면에 각각 있었고, 백엔드도 세 경로에
 * 복사돼 있었다(그래서 사장님 좌석 방송이 코스 화면에만 도달하지 못한 전례가 있다). 우선순위는
 * 한 곳에서만 바뀌어야 한다.
 *
 * 네 가지 경우가 전부다:
 *  · 신선·신뢰 실측(사장님 좌석 확인 포함) → 'measured'. 추정은 그리지 않는다.
 *  · 학습 모델 예측 → 'predicted'. 그 숫자가 순위를 만들었으므로 화면도 그 숫자다.
 *  · 근거 없음 **또는 낡은·단건 실측** + 신선한 추정 → 'estimated' + lastObserved(있으면).
 *  · 아무것도 없음 → 'none'(+ 낡은 실측만 있으면 'measured' + lastObserved).
 */
export function congestionDisplay(
  input: CongestionDisplayInput,
  now: Date = new Date(),
): CongestionDisplay {
  const level =
    typeof input.congestionLevel === 'number' && Number.isFinite(input.congestionLevel)
      ? input.congestionLevel
      : null;
  const measured = level !== null || input.congestionSource === 'measured';
  // 실측이 '지금' 자격을 잃었을 때만 마지막 관측 칸을 만든다(예측에는 관측 시각이 없다).
  const lastObserved =
    input.congestionIsCurrent === false && input.congestionSource !== 'predicted' && measured
      ? { level, observedAt: input.congestionTimestamp ?? null }
      : null;

  const estimate = displayableEstimate(input, now);
  if (estimate) return { mode: 'estimated', level: null, estimate, lastObserved };
  if (input.congestionSource === 'predicted' && level !== null) {
    return { mode: 'predicted', level, estimate: null, lastObserved: null };
  }
  if (level !== null) return { mode: 'measured', level, estimate: null, lastObserved };
  return { mode: 'none', level: null, estimate: null, lastObserved };
}

/**
 * 추정 피드(GET /congestion/estimates) 응답 → {facilityId: 원본 추정}. 모양이 어긋나면 빈 객체.
 *
 * 값 하나하나는 여기서 검증하지 않는다 — 신선도(60분)는 **그릴 때의 시각**으로 봐야 하므로
 * 소비처가 parseCongestionEstimate/displayableEstimate 를 매번 다시 부른다. 여기서 한 번 걸러
 * 저장하면 5분 뒤·30분 뒤의 화면이 받아 온 순간의 판정을 그대로 믿게 된다.
 * `available: false`(스냅샷 낡음·수집 실패)·구 서버 404·e2e 스텁의 `[]` 는 전부 '추정 없음'.
 */
export function estimatesFromFeed(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const p = payload as { available?: unknown; estimates?: unknown };
  if (p.available !== true) return {};
  const e = p.estimates;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  return e as Record<string, unknown>;
}

/** 관측 시각을 경주 현지(KST) 'HH:MM' 으로. 기기 시간대와 무관하게 같은 문자열이다. */
export function formatEstimateTime(observedAt: string | null | undefined): string | null {
  if (!observedAt) return null;
  const ms = new Date(observedAt).getTime();
  if (Number.isNaN(ms)) return null;
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ── 백엔드 미러(폴백 경로 전용) ───────────────────────────────────────────────
//
// 아래 두 상수와 `measurementIsCurrentFallback` 은 백엔드
// app/services/congestion_evidence.py 의 `TRUSTED_EVIDENCE_TIERS` ·
// `RANKING_FRESHNESS` · `measurement_is_current` 의 **미러**다. 패리티 테스트가 양쪽 일치를
// 강제한다(apps/api/tests/services/test_congestion_estimate_evidence.py).
//
// 미러를 두는 건 이 파일 머리말의 "판정은 서버만 한다" 와 모순처럼 보이지만, 그렇지 않다.
// 지도 화면에는 **서버를 아예 거치지 않는 경로**가 하나 있다: /infrastructures 가 4초 안에
// 오지 않으면 Supabase 를 직접 읽는 2순위 폴백이다(app/main/page.tsx). 프로덕션 TTFB 가
// 4.0~5.9초라 이 폴백이 드문 길이 아니다 — 거기서는 내려줄 서버 판정이 없으므로, 판정을 안 하면
// **가장 흔한 경로에서만 이 우선순위가 통째로 꺼진다.**
//
// 그래서 규칙 자체는 여전히 한 벌이고(백엔드), 여기 있는 것은 그 한 벌의 미러다 —
// recommender.ts 가 spot/ 을 미러하는 것과 같은 관례다. **폴백 경로에서만** 쓴다. 서버 응답이
// 있는 경로는 절대 이 함수를 부르지 않고 `congestionIsCurrent` 를 그대로 받아 쓴다.
export const TRUSTED_EVIDENCE_TIERS = ['verified', 'corroborated'] as const;
export const MEASUREMENT_NOW_WINDOW_MS = 30 * 60 * 1000;

function withinNowWindow(timestamp: string | null | undefined, now: Date): boolean {
  if (!timestamp) return false;
  const ms = new Date(timestamp).getTime();
  if (Number.isNaN(ms)) return false;
  const age = now.getTime() - ms;
  // 미래 쪽도 막는다 — 백엔드가 `timedelta(0) <= age` 로 같은 선을 쓴다.
  return age >= 0 && age <= MEASUREMENT_NOW_WINDOW_MS;
}

/** 백엔드 congestion_evidence.measurement_is_current 의 미러. **폴백 경로 전용.** */
export function measurementIsCurrentFallback(
  evidenceTier: string | null | undefined,
  timestamp: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!evidenceTier || !(TRUSTED_EVIDENCE_TIERS as readonly string[]).includes(evidenceTier)) return false;
  return withinNowWindow(timestamp, now);
}

/**
 * localStorage 에서 되살린 '지금' 판정을 **나이로 다시** 본다.
 *
 * 지도 시설 목록은 24시간 캐시된다. 30분짜리 판정을 24시간 캐시에 그대로 실어 두면, 5시간 전
 * 캐시가 첫 화면에 그려질 때 5시간 된 관측이 `is_current: true` 라고 주장하고 방금 받은 추정을
 * 가린다 — 이 파일 머리말 2)번이 추정에 대해 막아 둔 바로 그 실수를, 새 불리언이 그대로 밟는다.
 *
 * true 였던 판정만 다시 잰다: 등급(verified/corroborated)은 시간이 지나도 변하지 않으므로 나이만
 * 보면 되고, false/미상은 시간이 지나도 true 가 될 수 없다.
 */
export function revalidateIsCurrent(
  isCurrent: boolean | null | undefined,
  observedAt: string | null | undefined,
  now: Date = new Date(),
): boolean | undefined {
  if (isCurrent !== true) return isCurrent ?? undefined;
  return withinNowWindow(observedAt, now);
}

/**
 * '지금' 자격을 잃은 관측의 시각 표기.
 * 오늘(KST)이면 'HH:MM', 올해면 'M/D HH:MM', 해가 다르면 'YYYY. M/D HH:MM'.
 *
 * 날짜를 붙이는 게 핵심이다. 추정 배지처럼 HH:MM 만 쓰면 **한 달 전 관측이 오늘 09:12 로 읽힌다** —
 * 프로덕션에서 실제로 한 시설이 2026-08-21 로그 하나를 들고 있었으니 가상의 걱정이 아니다.
 * 연도까지 붙이는 이유도 같다: congestion_logs 에는 지난 시즌 7월 시드가 남아 있어, 'M/D' 만 쓰면
 * 작년 8/21 과 올해 8/21 이 같은 글자가 된다(2026-09-20 적대적 검토).
 * 추정 배지(formatEstimateTime)는 60분 안의 값만 그리므로 시:분으로 충분하고, 이 함수가 붙는
 * 자리는 나이가 얼마든 될 수 있다. 숫자 표기라 4개 로케일에서 같은 문자열이다.
 */
export function formatLastObserved(
  observedAt: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!observedAt) return null;
  const ms = new Date(observedAt).getTime();
  if (Number.isNaN(ms)) return null;
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hhmm = `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
  const sameYear = kst.getUTCFullYear() === kstNow.getUTCFullYear();
  const sameDay =
    sameYear &&
    kst.getUTCMonth() === kstNow.getUTCMonth() &&
    kst.getUTCDate() === kstNow.getUTCDate();
  if (sameDay) return hhmm;
  const md = `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${hhmm}`;
  return sameYear ? md : `${kst.getUTCFullYear()}. ${md}`;
}

/** 반경(m) → km 표기용 숫자. 2000 → 2, 1500 → 1.5. */
export function estimateRadiusKm(radiusM: number | null | undefined): number {
  const m = typeof radiusM === 'number' && Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 2000;
  return Math.round((m / 1000) * 10) / 10;
}
