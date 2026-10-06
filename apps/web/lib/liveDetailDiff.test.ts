import assert from "node:assert/strict";
import { LIVE_FLASH_MS, LIVE_REFRESH_COOLDOWN_MS, refreshedFields } from "./liveDetailDiff";

// 응답에 실린 줄만, 카드 순서대로.
assert.deepEqual(
  refreshedFields({
    operatingHours: { open: "09:00~18:00", closed: "연중무휴" },
    overview: "첨성대와 월성 사이의 숲",
    phone: "054-779-6100",
    homepage: "https://example.test",
    imageUrl: "https://tong.visitkorea.or.kr/a.jpg",
  }),
  ["photo", "hours", "overview", "phone", "homepage"],
);

// 빈 값·공백·null 은 '받아 온 줄' 이 아니다.
assert.deepEqual(
  refreshedFields({ operatingHours: { open: "", closed: "  " }, overview: null, phone: " ", homepage: undefined, imageUrl: "" }),
  [],
);
assert.deepEqual(refreshedFields({ operatingHours: { closed: "월요일" } }), ["hours"], "휴무일만 와도 운영시간 줄이다");
assert.deepEqual(refreshedFields(null), []);
assert.deepEqual(refreshedFields(undefined), []);

// 계획 값.
assert.equal(LIVE_FLASH_MS, 1500);
assert.equal(LIVE_REFRESH_COOLDOWN_MS, 10_000);

console.log("PASS liveDetailDiff");
