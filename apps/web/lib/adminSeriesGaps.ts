// 일별 추이에서 **관측이 없는 구간**을 찾아 말로 만드는 판정 — 관제 화면들의 공용 단일 출처.
//
// 왜 공용인가: 같은 `/admin/metrics/trend` 응답을 성과 리포트(`app/admin/report/page.tsx`)와
// 대시보드 분산 효과 차트(`components/admin/DashboardCharts.tsx`)가 각각 그린다. 그런데 한쪽은
// 결측일을 **잇지 않고** 음영으로 표시했고, 다른 쪽은 `connectNulls` 로 **직선으로 이어** 붙였다.
// 같은 데이터가 두 화면에서 다른 이야기를 한 것이다 — 대시보드에서는 관측이 없던 5일이
// '완만하게 이어진 추세' 로 보였다. 판정을 두 벌로 두면 반드시 이렇게 갈라지므로 여기로 모은다.
//
// 지켜야 하는 사실 하나: **빈 구간은 0 이 아니다.** 선을 이으면 없는 관측을 그린 것이고,
// 선만 끊으면 '그날은 0% 였다' 로 읽힌다. 그래서 세 가지를 함께 낸다 —
//   ① 선을 끊고(`connectNulls={false}`)  ② 구간을 음영으로 덮고  ③ 그 이유를 글자로 말한다.
//
// `lib/adminObservationGap.ts` 와는 질문이 다르다(그래서 합치지 않았다):
//   · 그쪽 — "조회 창이 **통째로** 비었다. 마지막 관측은 언제였나?" (창 밖의 사실을 끌어온다)
//   · 여기 — "창 **안 어디가** 비었나?" (창 안의 모양만 본다)
// 둘을 한 함수로 묶으면 창 밖 조회(마지막 관측 시각)가 차트 그리기에 딸려 들어온다.
//
// 판정을 렌더에서 뗀 이유는 `lib/adminLoadState.ts` 머리말과 같다(렌더 테스트 러너가 없다).

/** 값이 없는 날이 연속된 구간. `from`/`to` 는 차트 X축에 실제로 찍히는 라벨(예: '8/19'). */
export interface SeriesGap {
  from: string;
  to: string;
  days: number;
}

/** 계열 한 개의 요약 — 차트 아래 캡션이 인쇄물에서도 값을 말할 수 있게 하는 재료. */
export interface SeriesSummary {
  /** 값이 있는 날 수. */
  observed: number;
  /** 창 전체 일수. */
  total: number;
  avg: number | null;
  max: { date: string; value: number } | null;
  min: { date: string; value: number } | null;
  /** 음영 대상 구간(minSpan 일 이상). */
  gaps: SeriesGap[];
  /** 값이 없는 날 수 — `gaps` 의 합이 아니다(1일짜리 결측도 여기엔 센다). */
  missingDays: number;
}

/**
 * 음영으로 덮을 최소 결측 길이(일).
 *
 * 2인 이유: 카테고리 축의 ReferenceArea 는 `x1 === x2` 면 폭이 0이라 **아무것도 그려지지 않는다**.
 * 1일짜리 결측은 끊긴 선 자체로 드러나므로 음영 없이 둔다(캡션의 '미관측 N일' 에는 포함된다).
 */
export const MIN_SHADED_GAP_DAYS = 2;

/** 날짜 라벨을 가진 행이면 무엇이든 받는다 — 리포트의 ChartRow 도, 대시보드의 느슨한 행도. */
interface DatedRow {
  date: string;
}

/**
 * `isMissing` 이 참인 칸이 `minSpan` 일 이상 연속된 구간을 모두 찾는다.
 *
 * 술어를 밖에서 받는 이유: 대시보드는 한 차트에 계열이 둘이라 "**둘 다** 없는 날"만 음영으로
 * 덮어야 한다. 한쪽만 없는 날까지 덮으면 있는 관측을 없다고 말하는 셈이 된다.
 */
export function findGaps<T extends DatedRow>(
  rows: readonly T[],
  isMissing: (row: T) => boolean,
  minSpan: number = MIN_SHADED_GAP_DAYS,
): SeriesGap[] {
  const gaps: SeriesGap[] = [];
  let runStart: number | null = null;

  rows.forEach((row, i) => {
    const missing = isMissing(row);
    if (missing && runStart === null) runStart = i;
    // 구간은 '값이 다시 나타난 칸' 이나 '마지막 칸' 에서 닫힌다.
    if ((!missing || i === rows.length - 1) && runStart !== null) {
      const end = missing ? i : i - 1;
      const days = end - runStart + 1;
      if (days >= minSpan) gaps.push({ from: rows[runStart].date, to: rows[end].date, days });
      runStart = null;
    }
  });

  return gaps;
}

/** 값이 없다고 볼 것 — null·undefined·NaN. 0 은 **실측 0** 이므로 절대 여기 걸리지 않는다. */
export function isMissingValue(value: number | null | undefined): boolean {
  return value === null || value === undefined || Number.isNaN(value);
}

/** 계열 하나를 요약한다. `value` 로 값을 꺼내므로 행의 필드 이름에 묶이지 않는다. */
export function summarizeSeries<T extends DatedRow>(
  rows: readonly T[],
  value: (row: T) => number | null | undefined,
  minSpan: number = MIN_SHADED_GAP_DAYS,
): SeriesSummary {
  let sum = 0;
  let observed = 0;
  let max: { date: string; value: number } | null = null;
  let min: { date: string; value: number } | null = null;

  for (const row of rows) {
    const v = value(row);
    if (isMissingValue(v)) continue;
    const point = { date: row.date, value: v as number };
    observed += 1;
    sum += point.value;
    if (!max || point.value > max.value) max = point;
    if (!min || point.value < min.value) min = point;
  }

  return {
    observed,
    total: rows.length,
    avg: observed > 0 ? sum / observed : null,
    max,
    min,
    gaps: findGaps(rows, (row) => isMissingValue(value(row)), minSpan),
    missingDays: rows.length - observed,
  };
}

/**
 * 라벨을 붙일 구간 하나(가장 긴 것). 짧은 구간까지 전부 붙이면 글자가 서로 겹쳐서
 * 오히려 아무것도 안 읽힌다 — 나머지 구간은 음영과 캡션이 말한다.
 */
export function longestGap(gaps: readonly SeriesGap[]): SeriesGap | null {
  return gaps.reduce<SeriesGap | null>((best, g) => (!best || g.days > best.days ? g : best), null);
}

/** 음영 위에 얹는 한 줄 — '미관측 3일 (8/19~8/21)'. */
export function formatGapLabel(gap: SeriesGap): string {
  return `미관측 ${gap.days}일 (${gap.from}~${gap.to})`;
}

/**
 * 계열이 **하나뿐인** 차트의 캡션 문장. 결측이 없으면 null(할 말이 없으면 하지 않는다).
 *
 * '(0%가 아님)' 을 괄호로라도 반드시 남긴다 — 이 문장이 존재하는 유일한 이유다.
 */
export function formatGapNote(missingDays: number): string | null {
  if (missingDays <= 0) return null;
  return `미관측 ${missingDays}일은 선을 잇지 않고 음영으로 표시했습니다(0%가 아님).`;
}

/**
 * 계열이 **둘 이상인** 차트의 캡션 문장.
 *
 * 왜 일수를 말하지 않는가: 계열마다 결측일이 다르면 한 벌의 음영으로 덮을 수 있는 건
 * 교집합(둘 다 없는 날)뿐이다. 여기서 '미관측 N일' 이라고 쓰면 그 N이 어느 계열의 것인지
 * 알 수 없다 — 없는 숫자를 지어내지 않으려고 정책만 말한다.
 *
 * 두 문장을 한 파일에 두는 이유: 문구가 갈라지는 순간 두 화면이 다시 다른 이야기를 한다.
 */
export const GAP_SHADING_NOTE =
  '관측이 없는 날은 선을 잇지 않습니다. 음영은 두 지표 모두 관측이 없는 구간이며, 빈 구간은 0%가 아닙니다.';
