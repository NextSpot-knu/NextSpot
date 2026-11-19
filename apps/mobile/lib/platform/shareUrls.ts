// 공유 링크 — 받는 사람은 앱이 아니라 웹(운영 주소)에서 연다. 순수 함수(테스트: share.test.ts).
//
// 형식은 웹과 똑같다(기준 커밋 e07ea61):
//   코스  apps/web/app/course/page.tsx            `${origin}/course?s=${encodeURIComponent(encodeStops(…))}&ref=share`
//   추천  apps/web/app/explore/recommend/page.tsx `${origin}/explore/recommend?facilityId=…|name=…&type=…&lat=…&lng=…&ref=share`
// 웹은 window.location.origin 을 쓴다. 앱에는 출처가 없어 운영 웹 주소를 쓴다(docs/DEPLOY_AND_ENV.md 의
// NEXT_PUBLIC_SITE_URL 값, apps/web/lib/usageEvents.ts 의 PRODUCTION_HOST 와 같은 호스트).
import { encodeStops, type ShareStop } from '@/lib/courseShare';

export const WEB_ORIGIN = 'https://nextspot-nu.vercel.app';

/** 코스 공유 링크. 정류지가 없으면 null(웹은 이때 맨 페이지 링크로 폴백했다가 '코스 빠진 링크' 문제를 겪었다). */
export function courseShareUrl(stops: ShareStop[], origin: string = WEB_ORIGIN): string | null {
  if (stops.length === 0) return null;
  return `${origin}/course?s=${encodeURIComponent(encodeStops(stops))}&ref=share`;
}

/**
 * 공유받은 코스를 다시 공유할 때 — 받은 `s` 값을 그대로 싣는다(웹은 원본 URL 을 그대로 넘긴다:
 * 다시 인코딩하면 새 공유 시각이 찍혀 '지금 바로 도착' 인 거짓 일정이 된다).
 */
export function reshareCourseUrl(shareParam: string | null | undefined, origin: string = WEB_ORIGIN): string | null {
  if (!shareParam) return null;
  return `${origin}/course?s=${encodeURIComponent(shareParam)}&ref=share`;
}

export interface RecommendShareTarget {
  /** DB 장소 id. 없으면 이름·종류로 돌아온다(카카오 검색 결과처럼 DB 에 없는 곳). */
  facilityId?: string | null;
  name?: string | null;
  type?: string | null;
  lat: number;
  lng: number;
}

export function recommendShareUrl(target: RecommendShareTarget, origin: string = WEB_ORIGIN): string {
  const head = target.facilityId
    ? `facilityId=${encodeURIComponent(target.facilityId)}`
    : `name=${encodeURIComponent((target.name ?? '').trim())}&type=${encodeURIComponent(target.type ?? '')}`;
  return `${origin}/explore/recommend?${head}&lat=${target.lat}&lng=${target.lng}&ref=share`;
}
