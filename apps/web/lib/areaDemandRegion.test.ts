// 권역 수요(경주 전용)는 내부 검증 지역에서 요청을 보내지 않는다 — lib/areaDemandCurve.fetchAreaDemandPoint.
//
// 내부 지역을 골라 둔 개발자가 새로 고치면 계정 확인 전까지 경주 화면이 먼저 돌고, 그때 시작된 세션 곡선 수집
// (선행 1점 → 나머지 fan-out)이 지역이 바뀐 뒤에도 이어진다. 예전에는 남은 점들이 **경주 좌표 + 내부 지역 헤더**로
// 나갔다(S3 검토 지적). 이제 지금 지역이 공개 지역이 아니면 보내지 않고 오류로 끝낸다 — 세션 캐시에도 남지 않는다.
// node:assert 독립 스크립트(scripts/run-web-tests.mjs 가 돌린다).

import assert from 'node:assert/strict';
import { apiClient } from './api-client';
import {
  AREA_DEMAND_GYEONGJU_ONLY,
  fetchAreaDemandPoint,
  resetSessionAreaDemandCurve,
  sessionCurveFetcher,
} from './areaDemandCurve';
import { REGION } from './region';
import { PUBLIC_REGION_ID, setActiveRegion } from './regionRuntime';

async function main() {
  const calls: string[] = [];
  const realGet = apiClient.get;
  (apiClient as { get: unknown }).get = async (path: string) => {
    calls.push(path);
    return { available: true, forecast: { level: 0.42 } };
  };
  try {
    const at = new Date(Date.UTC(2026, 10, 1, 5, 0));

    // 경주(공개 지역) — 종전과 같다: 요청 한 번, 값 그대로.
    setActiveRegion(PUBLIC_REGION_ID);
    assert.equal(await fetchAreaDemandPoint(REGION.center.lat, REGION.center.lng, at), 0.42);
    assert.deepEqual(calls, ['/api/v1/area-demand/forecast']);

    // 내부 지역으로 바뀐 뒤 — 요청을 보내지 않는다.
    calls.length = 0;
    setActiveRegion('testbed');
    await assert.rejects(fetchAreaDemandPoint(REGION.center.lat, REGION.center.lng, at), new RegExp(AREA_DEMAND_GYEONGJU_ONLY));
    assert.deepEqual(calls, [], '내부 지역에서 경주 좌표 권역 수요 요청을 보냈다');

    // 경주 화면에서 시작된 세션 곡선 수집이 지역이 바뀐 뒤 이어져도 남은 점은 나가지 않는다.
    resetSessionAreaDemandCurve();
    const nowMs = Date.UTC(2026, 10, 1, 3, 10);
    const curve = await sessionCurveFetcher()(REGION.center.lat, REGION.center.lng, new Date(nowMs), undefined, nowMs);
    assert.deepEqual(calls, [], '지역이 바뀐 뒤 곡선 수집이 요청을 보냈다');
    assert.deepEqual(curve, {});

    // 경주로 돌아오면 세션 캐시에 실패가 남아 있지 않다 — 다시 묻는다.
    setActiveRegion(PUBLIC_REGION_ID);
    await sessionCurveFetcher()(REGION.center.lat, REGION.center.lng, new Date(nowMs), undefined, nowMs);
    assert.ok(calls.length > 0, '내부 지역에서의 실패가 세션 캐시에 남았다');
  } finally {
    (apiClient as { get: unknown }).get = realGet;
    setActiveRegion(PUBLIC_REGION_ID);
    resetSessionAreaDemandCurve();
  }
  console.log('areaDemandRegion tests passed');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
