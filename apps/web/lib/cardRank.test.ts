import assert from "node:assert/strict";
import { cardRankLabel, cardRankText } from "./cardRank";

// 목록 안: 1 → 베스트, 2·3 → N번째, 4+ → 다음 후보(숫자 없음).
assert.deepEqual(cardRankLabel(1), { kind: "top" });
assert.deepEqual(cardRankLabel(2), { kind: "rank", rank: 2 });
assert.deepEqual(cardRankLabel(3), { kind: "rank", rank: 3 });
assert.deepEqual(cardRankLabel(4), { kind: "next" });
assert.deepEqual(cardRankLabel(14), { kind: "next" }, "'추천 14순위' 같은 큰 숫자는 말하지 않는다");

// 목록 밖(핀 · 검색 · 링크로 고른 곳): 선택한 장소.
assert.deepEqual(cardRankLabel(null), { kind: "selected" });
assert.deepEqual(cardRankLabel(undefined), { kind: "selected" });
assert.deepEqual(cardRankLabel(0), { kind: "selected" });
assert.deepEqual(cardRankLabel(1.5), { kind: "selected" });
assert.deepEqual(cardRankLabel(Number.NaN), { kind: "selected" });

// i18n 키.
assert.deepEqual(cardRankText({ kind: "top" }), { key: "card.rankBadgeTop" });
assert.deepEqual(cardRankText({ kind: "rank", rank: 3 }), { key: "card.rankBadge", vars: { rank: 3 } });
assert.deepEqual(cardRankText({ kind: "next" }), { key: "card.nextCandidate" });
assert.deepEqual(cardRankText({ kind: "selected" }), { key: "card.selectedPlace" });

// 같은 입력은 언제나 같은 배지 — 렌더마다 순위가 흔들리지 않는다.
for (let i = 0; i < 3; i += 1) assert.deepEqual(cardRankLabel(2), { kind: "rank", rank: 2 });

console.log("PASS cardRank");
