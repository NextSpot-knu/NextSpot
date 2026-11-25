// 관제 통계 리포트 데모(`/admin/reports?demo=1`) 고정 데이터 — 전부 합성값이다.
//
// 규칙은 lib/demoFixtures.ts 머리말과 같다: 백엔드를 부르지 않고, 난수·현재 시각 의존 값이 없다.
// 형(type)은 화면(app/admin/reports/page.tsx)이 쓰는 것을 그대로 가져와 모양이 어긋나지 않게 한다.
// 마지막 주 수락률(38%)은 대시보드 데모의 AI 추천 수락률(37.9%)과 같은 값이다.

import type { AiTrendRow, CategoryTableRow, WeeklyRow } from '@/app/admin/reports/page';

/** 요일별 카테고리 관측 혼잡 지수(막대 차트). 주말로 갈수록 음식점·관광지가 커진다. */
export const DEMO_REPORT_WEEKLY: WeeklyRow[] = [
  { day: '월', 음식점: 84, 카페: 62, 관광지: 71, 문화시설: 38 },
  { day: '화', 음식점: 91, 카페: 66, 관광지: 76, 문화시설: 41 },
  { day: '수', 음식점: 96, 카페: 70, 관광지: 82, 문화시설: 44 },
  { day: '목', 음식점: 102, 카페: 74, 관광지: 90, 문화시설: 47 },
  { day: '금', 음식점: 148, 카페: 109, 관광지: 131, 문화시설: 58 },
  { day: '토', 음식점: 212, 카페: 158, 관광지: 204, 문화시설: 83 },
  { day: '일', 음식점: 187, 카페: 141, 관광지: 176, 문화시설: 72 },
];

/** AI 추천 수락 트렌드(주차 버킷, %). 4주차 = 이번 주. */
export const DEMO_REPORT_AI_TREND: AiTrendRow[] = [
  { date: '1주차', 수락: 31, 거절: 69 },
  { date: '2주차', 수락: 34, 거절: 66 },
  { date: '3주차', 수락: 36, 거절: 64 },
  { date: '4주차', 수락: 38, 거절: 62 },
];

const DEMO_GROWTH: Record<string, { growth: string; status: string }> = {
  음식점: { growth: '+12%', status: '활발' },
  카페: { growth: '+7%', status: '활발' },
  관광지: { growth: '+23%', status: '급증' },
  문화시설: { growth: '-3%', status: '보통' },
};

/** 카테고리 요약 표 — 합계는 위 요일별 값의 합이라 막대 차트와 어긋나지 않는다. */
export const DEMO_REPORT_TABLE: CategoryTableRow[] = (['음식점', '카페', '관광지', '문화시설'] as const).map(
  (category, i) => ({
    id: i + 1,
    category,
    totalUsers: DEMO_REPORT_WEEKLY.reduce((sum, row) => sum + row[category], 0).toLocaleString(),
    growth: DEMO_GROWTH[category].growth,
    status: DEMO_GROWTH[category].status,
  }),
);
