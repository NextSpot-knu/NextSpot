import assert from "node:assert/strict";
import { REGION } from "./region";
import { resetSessionAreaDemandCurve, sessionAreaDemandCurve, type AreaDemandCurve } from "./areaDemandCurve";

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
}

main()
  .then(() => console.log("PASS areaDemandSessionCurve"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
