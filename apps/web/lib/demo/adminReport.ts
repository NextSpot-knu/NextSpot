// 관제 데모(`/admin/report?demo=1`)의 성과 리포트 고정 데이터 — 전부 **합성값**이다(실측 아님).
//
// 규칙은 lib/demoFixtures.ts 머리말과 같다: 백엔드를 부르지 않고, 난수를 쓰지 않으며(같은 입력 → 같은 값),
// 대시보드 데모와 겹치는 숫자(AI 추천 수락 384건 / 1,013건 = 37.9%, 오늘 이상 혼잡 3건)는 같게 둔다.
// 날짜 칸만 '지금'(KST)에서 거꾸로 센다 — 표지의 생성일과 데이터 기간이 어긋나 보이지 않게.

import type { DashboardTodayResponse, TrendDay, TrendResponse } from '@/app/admin/report/page';

const DEMO_DAYS = 30;
/** 로그가 없는 날(미관측 구간 음영을 보여 주는 1일) — 뒤에서부터 센 위치. */
const GAP_INDEX_FROM_START = 11;

export const DEMO_REPORT_REC_TOTAL = 1013;
export const DEMO_REPORT_REC_ACCEPTED = 384;

/** 가장 큰 나머지 방식으로 정수 합이 정확히 total 이 되게 나눈다. */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((v) => Math.floor(v));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest -= 1) out[order[k].i] += 1;
  return out;
}

/** now 의 KST 날짜(YYYY-MM-DD)를 UTC 자정 기준 Date 로. */
function kstToday(now: Date): Date {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(`${kst}T00:00:00Z`);
}

/** 최근 30일 일별 추이 — 주말에 혼잡·추천 노출이 늘고 평일은 낮다. */
export function buildDemoReportTrend(now: Date): TrendResponse {
  const end = kstToday(now);
  const dates = Array.from({ length: DEMO_DAYS }, (_, i) => {
    const d = new Date(end.getTime() - (DEMO_DAYS - 1 - i) * 86400 * 1000);
    return { iso: d.toISOString().slice(0, 10), weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6 };
  });

  const recWeights = dates.map(({ weekend }, i) =>
    i === GAP_INDEX_FROM_START ? 0 : (weekend ? 40 : 26) + ((i * 7) % 9),
  );
  const recTotals = allocate(DEMO_REPORT_REC_TOTAL, recWeights);
  // 일별 수락률 0.33~0.43 흔들림 — 합계는 정확히 384건으로 맞춘다.
  const acceptWeights = recTotals.map((n, i) => n * (0.33 + ((i * 5) % 11) / 100));
  const accepted = allocate(DEMO_REPORT_REC_ACCEPTED, acceptWeights);

  const daily: TrendDay[] = dates.map(({ iso, weekend }, i) => {
    const gap = i === GAP_INDEX_FROM_START;
    const congestion = 0.46 + (weekend ? 0.13 : 0) + ((i * 7) % 11) / 100 + (i / DEMO_DAYS) * 0.04;
    return {
      date: iso,
      avg_congestion: gap ? null : Math.round(Math.min(congestion, 0.82) * 1000) / 1000,
      samples: gap ? 0 : 132 + ((i * 13) % 12),
      rec_total: recTotals[i],
      rec_accepted: Math.min(accepted[i], recTotals[i]),
    };
  });
  return { days: DEMO_DAYS, daily, truncated: false };
}

/** 오늘 스냅샷 — 대시보드 데모의 이상 혼잡 3건과 같다. */
export const DEMO_REPORT_TODAY: DashboardTodayResponse = {
  hasLogs: true,
  avgCongestion: { value: 0.468, changePercent: 4.2 },
  anomalyCount: 3,
};

/** 마지막 TourAPI 일배치(매일 KST 04:00)의 시각 — now 이전 가장 가까운 04:00 KST. */
export function buildDemoReportFreshness(now: Date): { lastTourapiSync: string; source: string } {
  const sameDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 19, 0, 0);
  const sync = sameDay > now.getTime() ? sameDay - 86400 * 1000 : sameDay;
  return { lastTourapiSync: new Date(sync).toISOString(), source: 'tourapi' };
}
