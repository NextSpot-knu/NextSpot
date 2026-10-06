import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaLevelAt,
  clampForecastHours,
  forecastHeadlineLevel,
  forecastTargetHourKst,
  relativeAssumedAtIso,
  resolveStripForecast,
  STRIP_NOW,
  stripHours,
  stripReducer,
  type ForecastDeps,
  type StripState,
} from "./forecastStrip";
import { ASSUMED_TIME_PRESETS } from "./api-client";

// 계획 B3 — '🔮 혼잡 예측' 시간 줄: 상대 시각(지금+N시간) · KST 자정 넘김 · 상태 기계(배치 성공 / 503 → 곡선 / 둘 다 실패).
const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso).getTime();

async function main() {
  // 1) 상대 가정 시각 — 정확히 N시간 뒤, 지금은 null. 0~3 밖은 자른다.
  {
    const now = at("2026-10-07T03:10:00Z"); // 12:10 KST
    assert.equal(relativeAssumedAtIso(now, 0), null);
    assert.equal(relativeAssumedAtIso(now, 2), "2026-10-07T05:10:00.000Z");
    assert.equal(relativeAssumedAtIso(now, 7), "2026-10-07T06:10:00.000Z", "+3시간까지만");
    assert.equal(clampForecastHours(-1), 0);
    assert.equal(clampForecastHours(Number.NaN), 0);
    assert.equal(clampForecastHours(1.6), 2);
  }

  // 2) KST 정시 — 가장 가까운 정시, 자정을 넘기면 다음 날 시(23:40 + 1시간 → 01시, +2 → 02시).
  {
    const late = at("2026-10-07T14:40:00Z"); // 23:40 KST
    assert.equal(forecastTargetHourKst(late, 1), 1);
    assert.equal(forecastTargetHourKst(late, 2), 2);
    const lateEarly = at("2026-10-07T14:10:00Z"); // 23:10 KST
    assert.equal(forecastTargetHourKst(lateEarly, 1), 0, "00:10 → 0시");
    assert.equal(forecastTargetHourKst(at("2026-10-07T03:10:00Z"), 2), 14, "12:10 + 2 → 14시");
    // 곡선 값: 그 정시 → 없으면 가까운 쪽 한 시간 → 반대쪽.
    const curve = { 0: 0.2, 1: 0.3, 2: 0.4 };
    assert.equal(areaLevelAt(curve, late, 1), 0.3);
    assert.equal(areaLevelAt({ 0: 0.2, 2: 0.4 }, late, 1), 0.2, "00:40 에 1시가 없으면 더 가까운 0시");
  }

  // 3) 상태 기계 — 받는 중 · 늦게 온 옛 답 버림 · 실패하면 지금으로(알림 표시) · 지금을 누르면 비운다.
  {
    let s: StripState = STRIP_NOW;
    s = stripReducer(s, { type: "select", hours: 2 });
    assert.equal(s.status, "loading");
    assert.equal(stripHours(s), 2);
    s = stripReducer(s, { type: "select", hours: 3 });
    const stale = stripReducer(s, { type: "resolved", hours: 2, forecast: { hours: 2, basis: "area", level: 0.3 } });
    assert.equal(stale, s, "기다리지 않는 시각의 답은 버린다");
    s = stripReducer(s, { type: "resolved", hours: 3, forecast: { hours: 3, basis: "area", level: 0.3 } });
    assert.equal(s.status, "forecast");
    assert.equal(stripHours(s), 3);
    assert.equal(stripReducer(s, { type: "select", hours: 3 }), s, "같은 칸을 다시 누르면 그대로");
    const failed = stripReducer(stripReducer(s, { type: "select", hours: 1 }), { type: "resolved", hours: 1, forecast: null });
    assert.deepEqual(failed, { status: "now", failed: true }, "예측이 없으면 지금으로 돌아가며 알린다");
    assert.deepEqual(stripReducer(s, { type: "select", hours: 0 }), STRIP_NOW, "지금은 모두 비운다");
    assert.deepEqual(stripReducer(s, { type: "reset" }), STRIP_NOW);
  }

  // 4) 예측 정하기 — 배치 성공 / 503 → 곡선 / 둘 다 실패 / 미학습이면 배치를 부르지 않는다.
  {
    const now = at("2026-10-07T03:10:00Z"); // 12:10 KST → +2 = 14시
    const calls: string[] = [];
    const deps = (over: Partial<ForecastDeps>): ForecastDeps => ({
      modelTrained: async () => { calls.push("info"); return true; },
      batch: async () => { calls.push("batch"); return { a: { level: 0.7, anchored: true }, b: { level: 0.5, anchored: false } }; },
      areaCurve: async () => { calls.push("curve"); return { 13: 0.2, 14: 0.45, 15: 0.6 }; },
      ...over,
    });

    const ok = await resolveStripForecast(2, deps({}), now);
    assert.equal(ok?.basis, "model");
    assert.deepEqual(calls, ["info", "batch"], "배치가 되면 곡선은 묻지 않는다");
    assert.equal(ok?.basis === "model" && ok.anchored, false, "앵커 없는 예측이 섞이면 추정");
    assert.equal(forecastHeadlineLevel(ok!), 0.6, "모델 예측의 가운데값");

    calls.length = 0;
    const fallback = await resolveStripForecast(2, deps({ batch: async () => { calls.push("batch"); throw new Error("503"); } }), now);
    assert.deepEqual(fallback, { hours: 2, basis: "area", level: 0.45 });
    assert.deepEqual(calls, ["info", "batch", "curve"]);

    calls.length = 0;
    const untrained = await resolveStripForecast(1, deps({ modelTrained: async () => { calls.push("info"); return false; } }), now);
    assert.deepEqual(untrained, { hours: 1, basis: "area", level: 0.2 });
    assert.deepEqual(calls, ["info", "curve"], "미학습이면 배치를 부르지 않는다(언제나 503 이다)");

    calls.length = 0;
    const none = await resolveStripForecast(3, deps({
      batch: async () => { throw new Error("503"); },
      areaCurve: async () => { throw new Error("down"); },
    }), now);
    assert.equal(none, null, "둘 다 없으면 null");
    assert.equal(await resolveStripForecast(2, deps({ areaCurve: async () => ({}), batch: async () => ({}) }), now), null, "빈 답도 없음");
    assert.equal(await resolveStripForecast(0, deps({}), now), null, "지금은 예측이 아니다");
  }

  // 5) 상대 시각은 공유 프리셋이 아니다 — '가정 시각' 목록(/waiting·/course 와 공유)에 +N 이 없다.
  {
    assert.deepEqual(ASSUMED_TIME_PRESETS.map((p) => p.id), ["now", "weekday_noon", "fri_evening", "sat_afternoon", "sun_morning"]);
    const page = readFileSync(join(process.cwd(), "app/main/page.tsx"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(page, /setStoredAssumedPreset\([^)]*(forecastHours|relative)/, "상대 시각을 공유 프리셋에 저장한다");
    assert.doesNotMatch(page, /(sessionStorage|localStorage)\.setItem\([^)]*(forecast|relative)/i, "상대 시각을 저장소에 남긴다");
    assert.match(page, /relativeAssumedAtIso\(/, "카드가 지금+N시간 기준으로 다시 고르지 않는다");
  }

  console.log("forecastStrip tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
