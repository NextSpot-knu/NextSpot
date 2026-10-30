// 저장에 실패한 추천은 서버가 모두 같은 합성 id("mock-rec-id")로 내려준다(apps/api routers/recommendations.py —
// INSERT 가 실패한 항목만 강등, 추천 자체는 그대로 온다). 화면은 카드마다 recommendationId 를 열쇠로 쓴다
// (React key · 사진 커서 · 카드 하나 지우기 · 영업시간 확인 팝업). 같은 id 가 둘 이상이면 카드 하나를 지울 때
// 합성 id 카드가 전부 사라지고, 첫 사진이 깨진 두 카드가 서로의 사진 커서를 끝없이 되돌린다(깜빡임·깨진 URL 재요청).
//
// 그래서 받자마자 합성 id 에만 시설 id 를 붙여 카드마다 다르게 만든다. 'mock-' 접두사는 그대로라 피드백·설명·
// 저장의 합성 id 가드(startsWith('mock-'))는 전과 같이 서버로 보내지 않는다. 실제 UUID 는 건드리지 않는다.

const SYNTHETIC_PREFIX = 'mock-';

/**
 * 서버 recommendations 표에 실제로 있는 추천 id 인가 — 비었거나 합성 id('mock-…')면 아니다.
 * /main 의 수락은 이 id 를 함께 보내야 서버가 노출된 그 추천을 수락으로 바꾸고 취향을 반영한다(P1-1).
 * 합성 id 를 보내면 서버는 찾지 못한다(404) — 그때는 종전처럼 시설 id 만 보낸다.
 */
export function isServerRecommendationId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.trim().length > 0 && !id.startsWith(SYNTHETIC_PREFIX);
}

interface HasRecommendationId {
  recommendationId: string;
  facility?: { id?: string | null } | null;
}

export function uniqueSyntheticRecommendationIds<T extends HasRecommendationId>(items: T[]): T[] {
  if (!Array.isArray(items)) return items;
  const seen = new Set<string>();
  return items.map((item, index) => {
    const id = item?.recommendationId;
    if (typeof id !== 'string' || !id.startsWith(SYNTHETIC_PREFIX)) return item;
    const facilityId = item.facility?.id;
    let unique = facilityId ? `${id}:${facilityId}` : `${id}:${index}`;
    if (seen.has(unique)) unique = `${unique}:${index}`;
    seen.add(unique);
    return { ...item, recommendationId: unique };
  });
}
