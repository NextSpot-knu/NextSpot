import assert from "node:assert/strict";
import {
  DESKTOP_PANEL_CLASS,
  DESKTOP_PANEL_GUTTER_PX,
  DESKTOP_PANEL_STEPS,
  desktopPanelReservePx,
  desktopPanelWidthPx,
} from "./mainPanelLayout";

// 패널 폭: 380 / 420 / 460 (md / xl / 2xl), 휴대폰은 0.
assert.equal(desktopPanelWidthPx(390), 0);
assert.equal(desktopPanelWidthPx(767), 0);
assert.equal(desktopPanelWidthPx(768), 380);
assert.equal(desktopPanelWidthPx(1024), 380);
assert.equal(desktopPanelWidthPx(1279), 380);
assert.equal(desktopPanelWidthPx(1280), 420);
assert.equal(desktopPanelWidthPx(1366), 420);
assert.equal(desktopPanelWidthPx(1535), 420);
assert.equal(desktopPanelWidthPx(1536), 460);
assert.equal(desktopPanelWidthPx(1920), 460);
assert.equal(desktopPanelWidthPx(Number.NaN), 0);

// 지도가 비워 둘 폭 = 패널 + 오른쪽 여백(16). 예전 하드코딩 386 은 370 + 16 이었다.
assert.equal(DESKTOP_PANEL_GUTTER_PX, 16);
assert.equal(desktopPanelReservePx(390), 0);
assert.equal(desktopPanelReservePx(1366), 436);
assert.equal(desktopPanelReservePx(1536), 476);
assert.equal(desktopPanelReservePx(1920), 476);

// 클래스 문자열이 표와 같은 폭을 말한다 — 한쪽만 바꾸면 카드와 지도 계산이 갈린다.
const prefixFor: Record<number, string> = { 768: "md", 1280: "xl", 1536: "2xl" };
for (const step of DESKTOP_PANEL_STEPS) {
  const prefix = prefixFor[step.minWidth];
  assert.ok(prefix, `unknown breakpoint ${step.minWidth}`);
  assert.ok(
    DESKTOP_PANEL_CLASS.split(/\s+/).includes(`${prefix}:w-[${step.width}px]`),
    `${prefix}:w-[${step.width}px] missing from DESKTOP_PANEL_CLASS`,
  );
}
assert.ok(DESKTOP_PANEL_CLASS.includes("md:right-4"), "gutter class must match DESKTOP_PANEL_GUTTER_PX (right-4 = 16px)");

console.log("PASS mainPanelLayout");
