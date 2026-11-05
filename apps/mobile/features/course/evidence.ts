// 코스 정류지의 사진 후보·추정 노출 판정 — 웹 lib/photoCredit.ts(photoCandidates·isWikimediaUrl·isCityPhotoUrl)와
// lib/congestionEstimate.ts(parseCongestionEstimate·displayableEstimate·formatEstimateTime)의 코스 화면이 쓰는 부분만 옮겼다(기준 커밋 0d145a1).
// 웹 두 파일은 process.env.NEXT_PUBLIC_*·api-client(window)를 끌고 와 check:shared 에 걸려 import 하지 못한다.
// 순수 모듈(테스트: evidence.test.ts).

function hostIs(url: unknown, domain: string): boolean {
  if (typeof url !== 'string') return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/** 작은 사진에는 출처 줄을 달 자리가 없다 — 출처를 따로 적어야 하는 Wikimedia·경주시 사진은 빼고 TourAPI 사진만. 대표 → 갤러리 순, 중복 제거. */
export function uncreditedPhotoCandidates(imageUrl: unknown, galleryImages: unknown): string[] {
  const gallery: unknown[] = Array.isArray(galleryImages) ? galleryImages : [];
  const all = [imageUrl, ...gallery].filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
  return Array.from(new Set(all)).filter((u) => !hostIs(u, 'wikimedia.org') && !hostIs(u, 'gyeongju.go.kr'));
}

/** 주차 실측 기반 혼잡 추정 — 실측이 아니다. 60분 넘게 낡았거나 모양이 어긋나면 null(모르면 그리지 않는다). */
export const ESTIMATE_MAX_AGE_MS = 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface DisplayEstimate {
  level: number;
  observedAt: string;
}

export function displayableEstimate(
  input: { congestionLevel?: number | null; congestionEstimate?: unknown },
  now: Date = new Date(),
): DisplayEstimate | null {
  // 예측 숫자가 있으면 그 값이 이긴다 — 한 카드에 두 숫자가 나란히 뜨지 않게.
  if (typeof input.congestionLevel === 'number' && Number.isFinite(input.congestionLevel)) return null;
  const raw = input.congestionEstimate;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== 'estimated') return null;
  const level = r.level;
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) return null;
  if (typeof r.observedAt !== 'string' || !r.observedAt) return null;
  const observedMs = new Date(r.observedAt).getTime();
  if (Number.isNaN(observedMs)) return null;
  const age = now.getTime() - observedMs;
  if (age > ESTIMATE_MAX_AGE_MS || age < -FUTURE_SKEW_MS) return null;
  return { level, observedAt: r.observedAt };
}

/** 관측 시각을 경주 현지(KST) 'HH:MM' 으로 — 기기 시간대와 무관하다. */
export function formatEstimateTime(observedAt: string | null | undefined): string | null {
  if (!observedAt) return null;
  const ms = new Date(observedAt).getTime();
  if (Number.isNaN(ms)) return null;
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}
