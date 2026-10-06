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

/**
 * 화면에 적는 축제 날짜 — ko 는 "10.24", 그 밖은 그 언어의 월·일 표기("Oct 24", "10月24日").
 * 영어 독자는 '10.24'를 날짜로 바로 읽지 못한다(2026-10-07 리뷰). 형식이 다르면 원문 그대로.
 */
export function festivalDateLabel(iso: string, locale: string): string {
  if (locale === 'ko') return festivalShortDate(iso);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  try {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  } catch {
    return festivalShortDate(iso);
  }
}

/**
 * 축제 버튼(칩·배너·한 줄)을 세울지. 응답이 없으면(백엔드 다운·키 미설정) 어느 모양도 서지 않는다.
 * 칩은 예정 축제만 있어도 서지만(패널이 예정 축제를 보여 준다), 0건이면 숨는다 — 눌러서 '행사가 없어요'를 보이는
 * 버튼은 빈 상태 문구다(PM 문구 규칙: 빈 상태는 숨긴다). 배너·한 줄은 진행 중 축제가 있을 때만.
 */
export function festivalTriggerVisible(
  variant: 'chip' | 'banner' | 'compact',
  events: readonly FestivalSummary[] | null | undefined,
): boolean {
  if (!events) return false;
  return variant === 'chip' ? events.length > 0 : festivalBannerModel(events) !== null;
}
