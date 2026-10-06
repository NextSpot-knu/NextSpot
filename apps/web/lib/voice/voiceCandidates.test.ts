import assert from "node:assert/strict";
import { REGION } from "../region";
import {
  CUISINE_CHIPS,
  VOICE_CANDIDATE_LIMIT,
  cuisineChipForUtterance,
  cuisineChipPool,
  voiceCandidatePayload,
  type PoolFacility,
} from "./voiceCandidates";

// 경주 중심에서 북쪽으로 m 만큼(위도 1도 ≈ 111km).
const north = (m: number) => REGION.center.lat + m / 111_000;
const place = (id: string, name: string, meters: number, features: Record<string, unknown> = {}, type = "restaurant"): PoolFacility => ({
  id, name, type, latitude: north(meters), longitude: REGION.center.lng, congestionLevel: null, features,
});

// 이사부피자 64m(양식·피자), 무궁무진 67m(양식), 우직 97m(정밀분류 한식 · 취급메뉴 파스타), 술집 동주,
// 그리고 더 가까운 한식집 30곳 — 예전 음성 후보(가까운 30곳)는 양식집을 하나도 싣지 못했다.
const koreanNear = Array.from({ length: 30 }, (_, i) => place(`kor-${i}`, `한식당 ${i}`, 10 + i, { cuisineTags: ["한식"] }));
const isabu = place("isabu", "이사부피자", 64, { cuisineTags: ["양식", "피자"] });
const mugung = place("mugung", "무궁무진", 67, { cuisineTags: ["양식"] });
const ujik = place("ujik", "우직", 97, { category: "한식", treatMenu: "파스타" });
const dongju = place("dongju", "동주", 30, { cuisineTags: ["술집"] });
const cafe = place("cafe-1", "고요한 찻집", 20, { cuisineTags: ["카페"] }, "cafe");
const all = [...koreanNear, isabu, mugung, ujik, dongju, cafe];

// --- 말 → 칩 -----------------------------------------------------------------
assert.equal(cuisineChipForUtterance("양식 먹고 싶어")?.id, "western", "기능설명서 예시 그대로");
assert.equal(cuisineChipForUtterance("피자 먹을래")?.id, "western");
assert.equal(cuisineChipForUtterance("갈비 먹고 싶어")?.id, "meat");
assert.equal(cuisineChipForUtterance("국밥 집 알려줘")?.id, "gukbap");
assert.equal(cuisineChipForUtterance("중식 어때")?.id, "chinese");
assert.equal(cuisineChipForUtterance("양식 말고 한식"), null, "부정이 섞이면 칩 지름길을 타지 않는다");
assert.equal(cuisineChipForUtterance("카페 보여줘"), null);
assert.equal(cuisineChipForUtterance("다음"), null);
assert.equal(cuisineChipForUtterance(""), null);
// 다른 언어 화면.
assert.equal(cuisineChipForUtterance("I want pizza")?.id, "western");
assert.equal(cuisineChipForUtterance("no pizza please"), null);
assert.equal(cuisineChipForUtterance("ピザが食べたい")?.id, "western");
assert.equal(cuisineChipForUtterance("想吃披萨")?.id, "western");
assert.equal(cuisineChipForUtterance("sushi")?.id, "japanese");

// --- 칩 풀 = 음성 풀(같은 함수) ------------------------------------------------
const western = CUISINE_CHIPS.find((chip) => chip.id === "western")!;
const pool = cuisineChipPool(all, western, new Set());
const poolIds = pool.map((f) => f.id).sort();
assert.deepEqual(poolIds, ["isabu", "mugung", "ujik"].sort(), "camelCase 태그·취급메뉴로 양식 세 곳, 술집·한식·카페 제외");
const voiceChip = cuisineChipForUtterance("양식 먹고 싶어")!;
assert.deepEqual(
  cuisineChipPool(all, voiceChip, new Set()).map((f) => f.id).sort(),
  poolIds,
  "음성으로 말해도 칩을 누를 때와 같은 곳들",
);
// 관심 없음·저장한 곳, 오늘 휴무 확정은 뺀다.
assert.deepEqual(cuisineChipPool(all, western, new Set(["isabu"])).map((f) => f.id).sort(), ["mugung", "ujik"]);
const closedEveryDay = place("closed", "휴무 피자", 50, { cuisineTags: ["피자"], rest_date_raw: "매주 월·화·수·목·금·토·일요일" });
assert.ok(!cuisineChipPool([...all, closedEveryDay], western, new Set()).some((f) => f.id === "closed"));

// --- 서버로 보내는 후보 ---------------------------------------------------------
const payload = voiceCandidatePayload(all, {
  type: "restaurant", origin: REGION.center, excludedIds: new Set(), priority: pool,
});
assert.equal(payload.length, VOICE_CANDIDATE_LIMIT);
assert.deepEqual(payload.slice(0, 3).map((c) => c.id), ["isabu", "mugung", "ujik"], "칩 풀이 가까운 30곳에 밀려나지 않는다");
assert.ok(!payload.some((c) => c.id === "dongju"), "술집(camelCase 태그)은 음식점 음성 후보가 아니다");
assert.ok(!payload.some((c) => c.id === "cafe-1"), "다른 유형은 싣지 않는다");
assert.deepEqual(payload[0].cuisine, ["양식", "피자"], "camelCase 태그를 서버에 싣는다(예전에는 늘 null)");
assert.equal(payload.find((c) => c.id === "ujik")?.category, "한식");
assert.equal(payload.find((c) => c.id === "ujik")?.menu, "파스타");
assert.equal(payload[0].congestion, null, "근거 없는 혼잡을 0 으로 지어내지 않는다");
// 우선 풀이 없으면 가까운 순.
const nearest = voiceCandidatePayload(all, { type: "restaurant", origin: REGION.center, excludedIds: new Set(["kor-0"]) });
assert.equal(nearest[0].id, "kor-1");
assert.ok(nearest.every((c, i) => i === 0 || nearest[i - 1].distanceM <= c.distanceM));

console.log("PASS voiceCandidates");
