import assert from "node:assert/strict";
import { REGION } from "./region";
import {
  forecastArrivalTimes,
  forecastPointAt,
  resetSessionAreaDemandCurve,
  sessionAreaDemandAt,
  sessionAreaDemandCurve,
  type AreaDemandCurve,
} from "./areaDemandCurve";
import { areaLevelAt } from "./forecastStrip";

// 교차 레인 계약 3 — 경주 중심 '지금' 곡선은 같은 정시 안에서 한 번만 묻는다(/main 시간 줄과 /waiting 이 공유).
async function main() {
  const calls: { lat: number; lng: number; base: number }[] = [];
  let answer: AreaDemandCurve = { 13: 0.4, 14: 0.5 };
  let fail = false;
  const fetcher = async (lat: number, lng: number, baseAt: Date = new Date()) => {
    calls.push({ lat, lng, base: baseAt.getTime() });
    if (fail) throw new Error("boom");
    return answer;
  };
  const HOUR = 60 * 60 * 1000;
  const t0 = Date.UTC(2026, 9, 7, 3, 10); // 12:10 KST

  resetSessionAreaDemandCurve();
  const [a, b] = await Promise.all([sessionAreaDemandCurve(t0, fetcher), sessionAreaDemandCurve(t0 + 20 * 60_000, fetcher)]);
  assert.equal(calls.length, 1, "같은 정시에는 한 번만 묻는다");
  assert.deepEqual(a, b);
  assert.deepEqual({ lat: calls[0].lat, lng: calls[0].lng }, { lat: REGION.center.lat, lng: REGION.center.lng }, "경주 중심 기준");

  await sessionAreaDemandCurve(t0 + HOUR, fetcher);
  assert.equal(calls.length, 2, "정시가 바뀌면 새로 묻는다");

  // 빈 곡선·실패는 담아 두지 않는다.
  resetSessionAreaDemandCurve();
  answer = {};
  await sessionAreaDemandCurve(t0, fetcher);
  await sessionAreaDemandCurve(t0, fetcher);
  assert.equal(calls.length, 4, "빈 곡선은 다시 묻는다");
  fail = true;
  await assert.rejects(sessionAreaDemandCurve(t0 + 2 * HOUR, fetcher));
  fail = false;
  answer = { 15: 0.3 };
  assert.deepEqual(await sessionAreaDemandCurve(t0 + 2 * HOUR, fetcher), { 15: 0.3 }, "실패 뒤에는 다시 묻는다");
  resetSessionAreaDemandCurve();

  // 시간 줄 +N — 그 정시 하나만 묻는다(GET 1회). 세션 정시 · KST 정시마다 한 번, +1 · +2 · +3 을 다 눌러도 3회
  // (리뷰 10-07: 첫 +N 이 6점 곡선 전체를 기다리며 Render 호출 6회를 썼다).
  {
    const asked: { lat: number; lng: number; at: string }[] = [];
    const levels: Record<string, number | null> = {};
    let pointFail = false;
    const fetchPoint = async (lat: number, lng: number, at: Date) => {
      asked.push({ lat, lng, at: at.toISOString() });
      if (pointFail) throw new Error("down");
      const iso = at.toISOString();
      return iso in levels ? levels[iso] : 0.35;
    };
    resetSessionAreaDemandCurve();
    assert.deepEqual(await sessionAreaDemandAt(2, t0, fetchPoint), { 14: 0.35 }, "12:10 + 2 → 14시");
    assert.deepEqual(asked, [{ lat: REGION.center.lat, lng: REGION.center.lng, at: "2026-10-07T05:00:00.000Z" }], "14:00 하나만 묻는다");
    await Promise.all([sessionAreaDemandAt(2, t0 + 5 * 60_000, fetchPoint), sessionAreaDemandAt(2, t0, fetchPoint)]);
    assert.equal(asked.length, 1, "같은 정시는 다시 묻지 않는다");
    await sessionAreaDemandAt(1, t0, fetchPoint);
    await sessionAreaDemandAt(3, t0, fetchPoint);
    assert.equal(asked.length, 3, "+1 · +2 · +3 = 3회");
    assert.equal(areaLevelAt(await sessionAreaDemandAt(3, t0, fetchPoint), t0, 3), 0.35, "areaLevelAt 이 그대로 읽는다");

    // 그 정시가 표본 부족이면 가까운 쪽 이웃 정시 한 번 더(12:10 + 2 = 14:10 → 14시 다음은 15시).
    resetSessionAreaDemandCurve();
    asked.length = 0;
    levels["2026-10-07T05:00:00.000Z"] = null;
    const neighbour = await sessionAreaDemandAt(2, t0, fetchPoint);
    assert.deepEqual(neighbour, { 15: 0.35 });
    assert.deepEqual(asked.map((a) => a.at), ["2026-10-07T05:00:00.000Z", "2026-10-07T06:00:00.000Z"]);
    assert.equal(areaLevelAt(neighbour, t0, 2), 0.35, "곡선 읽기와 같은 이웃 순서");

    // 전송 실패는 담아 두지 않고 그대로 던진다 — 이웃은 묻지 않는다(같은 시간 초과를 또 기다리지 않게).
    resetSessionAreaDemandCurve();
    asked.length = 0;
    pointFail = true;
    await assert.rejects(sessionAreaDemandAt(1, t0, fetchPoint));
    assert.equal(asked.length, 1);
    pointFail = false;
    assert.deepEqual(await sessionAreaDemandAt(1, t0, fetchPoint), { 13: 0.35 }, "실패 뒤에는 다시 묻는다");

    // 같은 세션의 6점 곡선을 이미 다 받았으면(/waiting 을 먼저 열었다) 새로 묻지 않는다.
    resetSessionAreaDemandCurve();
    asked.length = 0;
    await sessionAreaDemandCurve(t0, async () => ({ 13: 0.2, 14: 0.6 }));
    assert.deepEqual(await sessionAreaDemandAt(2, t0, fetchPoint), { 14: 0.6 });
    assert.equal(asked.length, 0);
    resetSessionAreaDemandCurve();
  }

  // 묻는 도착 시각은 6점 곡선과 같은 규칙이다(같은 정시 = 같은 시각) · 서버 창 안으로 당긴다 · 자정을 넘긴다.
  for (const now of [t0, Date.UTC(2026, 9, 7, 3, 45), Date.UTC(2026, 9, 7, 3, 29), Date.UTC(2026, 9, 7, 14, 40)]) {
    const grid = forecastArrivalTimes(new Date(now), now);
    for (const h of [1, 2, 3]) {
      const point = forecastPointAt(now, h);
      assert.ok(point, `+${h}`);
      const same = grid.find((p) => p.hourKst === point!.hourKst);
      if (same) assert.equal(point!.at.toISOString(), same.at.toISOString(), `${new Date(now).toISOString()} +${h}`);
      assert.ok(point!.at.getTime() >= now + 32 * 60_000, "서버 창(30분 + 2분) 안");
    }
  }
  assert.equal(forecastPointAt(Date.UTC(2026, 9, 7, 14, 40), 1)?.hourKst, 1, "23:40 + 1 → 1시");
  assert.equal(forecastPointAt(Date.UTC(2026, 9, 7, 3, 29), 1)?.at.toISOString(), "2026-10-07T04:01:00.000Z", "12:29 + 1 → 13시를 13:01 로");
}

main()
  .then(() => console.log("PASS areaDemandSessionCurve"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
