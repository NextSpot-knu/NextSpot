import assert from "node:assert/strict";
import { centerTargetFor, isInBand, MIN_BAND_PX, visibleBand } from "./visibleBand";

// 계획 B3 — 고른 핀은 톱바·추천 패널·예측 줄·미리보기에 가리지 않는 띠의 가운데로 간다.

// 1) 데스크톱 1536×730(레일 뒤 지도 1461 폭): 위 톱바 120, 오른쪽 패널 476, 아래 예측 줄 96.
{
  const band = visibleBand(1461, 730, { top: 120, right: 476, bottom: 96 });
  assert.deepEqual([band.left, band.top, band.right, band.bottom], [0, 120, 985, 634]);
  assert.equal(band.centerX, 492.5);
  assert.equal(band.centerY, 377);
  // 상자 가운데(730.5, 365)에 그려지던 핀을 띠 가운데로 — 중심은 오른쪽·아래로 민다(핀이 왼쪽·위로 간다).
  const target = centerTargetFor({ x: 730.5, y: 365 }, 1461, 730, { top: 120, right: 476, bottom: 96 });
  assert.deepEqual(target, { x: 968.5, y: 353 });
}

// 2) 휴대폰 390×844: 위 톱바 210, 아래 탭(116) + 미리보기(150) + 예측 줄(48) = 314 → 띠 210~530.
{
  const band = visibleBand(390, 844, { top: 210, bottom: 314 });
  assert.equal(band.top, 210);
  assert.equal(band.bottom, 530);
  assert.equal(band.centerY, 370);
  assert.equal(band.centerX, 195);
  assert.ok(isInBand({ x: 195, y: 370 }, band, 20));
  assert.equal(isInBand({ x: 195, y: 150 }, band), false, "톱바 밑은 띠 밖");
}

// 3) 가리는 것이 화면보다 두꺼우면 같은 비율로 줄여 최소 띠를 남긴다.
{
  const band = visibleBand(360, 300, { top: 200, bottom: 200 });
  assert.equal(Math.round(band.bottom - band.top), MIN_BAND_PX);
  assert.equal(Math.round(band.top), 110);
  const none = visibleBand(800, 600, {});
  assert.deepEqual([none.centerX, none.centerY], [400, 300], "가리는 것이 없으면 상자 가운데");
  const bad = visibleBand(800, 600, { top: Number.NaN, right: -20 });
  assert.deepEqual([bad.left, bad.top, bad.right, bad.bottom], [0, 0, 800, 600], "이상한 값은 0 으로");
}

console.log("visibleBand tests passed");
