// '지금 경주 축제' 배너가 무엇을 보여 줄지 — 진행 중인 축제가 있을 때만 서고, 없으면 자리째 숨는다.
//
// 왜 진행 중만인가: 랜딩·지도 첫 화면의 배너는 "지금 경주에서 볼 것"을 말한다. 예정 축제나 0건을 배너로
// 세우면 '진행 중인 행사가 없어요' 같은 빈 상태 문구가 첫 화면에 남는다(PM 문구 규칙: 빈 상태는 숨긴다).
// 예정 축제는 지도의 축제 칩(components/main/FestivalBanner.tsx 기본형)이 패널에서 계속 보여 준다.

export interface FestivalSummary {
  title: string;
  endDate: string; // YYYY-MM-DD
  isOngoing: boolean;
  imageUrl?: string | null;
}

export interface FestivalBannerModel<T extends FestivalSummary> {
  /** 배너에 이름이 서는 축제 — 응답 순서에서 첫 진행 중 축제. */
  first: T;
  /** 그 밖의 진행 중 축제 수('외 N건'). 예정 축제는 세지 않는다. */
  moreCount: number;
}

export function festivalBannerModel<T extends FestivalSummary>(
  events: readonly T[] | null | undefined,
): FestivalBannerModel<T> | null {
  const ongoing = (events ?? []).filter((ev) => ev.isOngoing);
  if (ongoing.length === 0) return null;
  return { first: ongoing[0], moreCount: ongoing.length - 1 };
}

/** "2026-10-24" → "10.24". 형식이 다르면 원문 그대로(날짜를 지어내지 않는다). */
export function festivalShortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return m && d ? `${m}.${d}` : iso;
}
