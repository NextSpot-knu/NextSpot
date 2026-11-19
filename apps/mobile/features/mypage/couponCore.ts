// 쿠폰 화면의 순수 규칙 — 웹 apps/web/app/mypage/coupons/page.tsx 의 daysUntil · 날짜·유형 표기를 옮겼다(기준 커밋 0d145a1).

/** GET /api/v1/coupons/mine 항목. status 'expired' 는 서버가 expires_at 으로 파생한 값. */
export interface Coupon {
  id: string;
  facilityId: string;
  facilityName: string | null;
  facilityType: string | null;
  /** 0.20 = 20% */
  couponRate: number;
  status: 'issued' | 'used' | 'expired';
  issuedAt: string | null;
  usedAt: string | null;
  /** null 이면 만료 없음 — D-day 뱃지를 그리지 않는다. */
  expiresAt: string | null;
}

/** 시설 유형(캐노니컬 키) — i18n category 네임스페이스로 표시명을 번역한다. */
export const COUPON_TYPE_IDS: readonly string[] = ['restaurant', 'cafe', 'attraction', 'culture'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 만료까지 남은 일수(올림). 지났으면 0 이하가 나올 수 있다. 날짜를 못 읽으면 null. */
export function daysUntil(iso: string | null, now: number = Date.now()): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.ceil((at - now) / DAY_MS);
}

/** 할인율 0.2 → 20(정수 %). 숫자가 아니면 0. */
export function couponPercent(rate: unknown): number {
  const n = typeof rate === 'number' ? rate : Number(rate);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 발급일 표기 — 'M월 D일'(웹은 ko-KR 고정). 못 읽으면 빈 문자열. */
export function formatCouponDate(iso: string | null, locale = 'ko-KR'): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(locale, { month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

/** D-day 뱃지 — issued 상태에서만, 만료일이 있을 때만. urgent = 3일 이내. */
export function ddayBadge(
  coupon: Pick<Coupon, 'status' | 'expiresAt'>,
  now: number = Date.now(),
): { daysLeft: number; urgent: boolean } | null {
  if (coupon.status !== 'issued') return null;
  const daysLeft = daysUntil(coupon.expiresAt, now);
  if (daysLeft === null) return null;
  return { daysLeft, urgent: daysLeft <= 3 };
}
