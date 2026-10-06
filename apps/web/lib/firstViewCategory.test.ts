import assert from "node:assert/strict";
import { pickFirstViewCategory } from "./firstViewCategory";

// 밤: 음식점·카페가 문을 닫아 0, 관광지가 가장 많다.
assert.equal(pickFirstViewCategory({ restaurant: 0, cafe: 0, attraction: 12, culture: 3 }, "restaurant"), "attraction");
// 지금 칩은 후보가 아니다(이미 0 이라 옮기는 것이다).
assert.equal(pickFirstViewCategory({ restaurant: 40, cafe: 2 }, "restaurant"), "cafe");
// 같은 수면 칩 순서가 앞인 쪽.
assert.equal(pickFirstViewCategory({ cafe: 5, attraction: 5 }, "restaurant"), "cafe");
// 어디에도 없으면 옮기지 않는다(제안 카드가 그대로 남는다).
assert.equal(pickFirstViewCategory({ restaurant: 0, cafe: 0, attraction: 0, culture: 0 }, "restaurant"), null);
assert.equal(pickFirstViewCategory({}, null), null);

console.log("PASS firstViewCategory");
