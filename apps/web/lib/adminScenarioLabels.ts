// 관제 ③ 30일 차트의 '도입 시나리오' 축 — 합성 곡선을 실제 날짜 위에 그리지 않는다(I20).
//
// 시나리오 행(lib/demoFixtures.demoAdminDistribution · 대시보드 buildDemoDistribution)은 날짜 라벨(9/7 …)을 달고 온다.
// 그 위에 그린 '도입 후 혼잡 감소' 곡선은 실측 추이로 읽혔다 — 같은 화면의 KPI 는 실측인데 차트만 지어낸 날짜였다.
// 그래서 축을 '1일차 … 30일차' 로 바꿔 '도입하면 이렇게 된다' 는 시나리오임을 축 자체가 말하게 한다.

export function scenarioDayLabels<T extends { date?: unknown }>(rows: readonly T[]): (T & { date: string })[] {
  return rows.map((row, i) => ({ ...row, date: `${i + 1}일차` }));
}
