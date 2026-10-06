import assert from "node:assert/strict";
import { getMarkerSvg, isPaintableMeasurement, PIN_SIZES, pinDisplay, pinSvg } from "./markerSvg";

// 계획 B3 — 지도 핀(pinDisplay): 24시간 안쪽 실측만 칠하고, 나머지는 옅은 빈 핀, 서버 상위 추천은 금색 고리 + 순위.
const NOW = new Date("2026-10-07T05:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const decode = (uri: string) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
const NO_GREY_OR_BLACK = /#000(?![0-9a-f])|#000000|#4b5563/i;

// 1) 지금 잰 값(24시간 안쪽)은 등급색으로 꽉 찬 보통 크기 핀.
{
  const d = pinDisplay({ type: "cafe", level: 0.2, observedAt: minutesAgo(10), source: "traffic_cctv", now: NOW });
  assert.equal(d.style, "filled");
  assert.equal(d.grade, "quiet");
  assert.equal(d.ring, null);
  assert.deepEqual([d.width, d.height], [PIN_SIZES.desktop.normal.w, PIN_SIZES.desktop.normal.h]);
  assert.equal(d.zIndex, 5);
  const phone = pinDisplay({ type: "cafe", level: 0.2, observedAt: minutesAgo(10), now: NOW, phone: true });
  assert.deepEqual([phone.width, phone.height], [34, 43], "휴대폰 핀은 34×43");
}

// 2) 46일 전 관측 · 시각 모름 · 예측 출처 · 숫자 아님 → 빈 핀(작게). 24시간 경계 그대로.
{
  for (const input of [
    { level: 0.9, observedAt: minutesAgo(46 * 24 * 60) },
    { level: 0.9, observedAt: null },
    { level: 0.9, observedAt: "not-a-date" },
    { level: 0.5, observedAt: minutesAgo(5), source: "predicted" },
    { level: null, observedAt: minutesAgo(5) },
  ]) {
    const d = pinDisplay({ type: "attraction", now: NOW, ...input });
    assert.equal(d.style, "hollow", JSON.stringify(input));
    assert.equal(d.grade, null);
    assert.deepEqual([d.width, d.height], [26, 33], "빈 핀은 26×33");
    assert.equal(d.zIndex, 1);
  }
  assert.equal(isPaintableMeasurement({ level: 0.4, observedAt: minutesAgo(24 * 60) }, NOW), true, "정확히 24시간은 칠한다");
  assert.equal(isPaintableMeasurement({ level: 0.4, observedAt: minutesAgo(24 * 60 + 1) }, NOW), false, "24시간 1분은 칠하지 않는다");
}

// 3) 서버 상위 추천은 근거가 없어도 보통 크기 · 금색 고리 · 순위 숫자.
{
  const d = pinDisplay({ type: "attraction", level: null, rank: 2, now: NOW });
  assert.equal(d.style, "hollow");
  assert.equal(d.ring, "gold");
  assert.equal(d.rank, 2);
  assert.deepEqual([d.width, d.height], [40, 50], "순위 핀은 보통 크기");
  const svg = decode(pinSvg(d, "attraction"));
  assert.match(svg, /#c19a3e/, "금색 고리");
  assert.match(svg, />2<\/text>/, "순위 숫자");
  const top = pinDisplay({ type: "attraction", level: 0.3, observedAt: minutesAgo(3), rank: 1, now: NOW });
  assert.equal(top.style, "filled");
  assert.equal(top.ring, "gold");
  assert.ok(top.zIndex > d.zIndex, "1위가 2위 위에 그려진다");
}

// 4) 예측 모드(PM 4.2 a): 순위 핀은 그 시각의 예측 등급 + 흰 점선 고리, 지금 잰 값은 칠하지 않는다.
{
  const ranked = pinDisplay({ type: "restaurant", level: 0.2, observedAt: minutesAgo(3), rank: 1, forecastMode: true, forecastLevel: 0.8, now: NOW });
  assert.equal(ranked.style, "filled");
  assert.equal(ranked.grade, "busy");
  assert.equal(ranked.ring, "dashed");
  assert.match(decode(pinSvg(ranked, "restaurant")), /stroke-dasharray/, "예측은 점선");
  const measuredNow = pinDisplay({ type: "restaurant", level: 0.2, observedAt: minutesAgo(3), forecastMode: true, now: NOW });
  assert.equal(measuredNow.style, "hollow", "예측 모드에서 지금 잰 값은 그 시각의 값이 아니다");
  const rankedNoForecast = pinDisplay({ type: "restaurant", level: null, rank: 3, forecastMode: true, now: NOW });
  assert.equal(rankedNoForecast.ring, "gold", "예측이 없으면 추천 표시만 남는다");
}

// 5) 선택 핀은 더 크고 맨 위. 운영자 '혼잡' 경계를 따른다.
{
  const d = pinDisplay({ type: "cafe", level: 0.62, observedAt: minutesAgo(1), selected: true, busyAt: 0.6, now: NOW });
  assert.equal(d.grade, "busy", "경계 0.6 이면 0.62 는 혼잡");
  assert.deepEqual([d.width, d.height], [50, 63]);
  assert.equal(d.zIndex, 100);
}

// 6) 어떤 조합도 회색(#4b5563)·검정(#000) 몸통을 쓰지 않는다 — 라이트·야간 모두.
{
  for (const dark of [false, true]) {
    for (const selected of [false, true]) {
      for (const input of [
        { level: null },
        { level: 0.1, observedAt: minutesAgo(1) },
        { level: 0.4, observedAt: minutesAgo(1) },
        { level: 0.6, observedAt: minutesAgo(1) },
        { level: 0.9, observedAt: minutesAgo(1) },
        { level: null, rank: 1 },
        { level: null, rank: 2, forecastMode: true, forecastLevel: 0.3 },
      ]) {
        for (const type of ["restaurant", "cafe", "attraction", "culture", "parking", "other"]) {
          const svg = decode(pinSvg(pinDisplay({ type, now: NOW, selected, ...input }), type, { dark, selected }));
          assert.doesNotMatch(svg, NO_GREY_OR_BLACK, `${type} ${JSON.stringify(input)} dark=${dark}`);
        }
      }
    }
  }
  assert.match(decode(pinSvg(pinDisplay({ type: "cafe", level: null, now: NOW }), "cafe", { dark: true })), /#3a3027/, "야간 빈 핀 몸통은 #3a3027");
  assert.doesNotMatch(decode(getMarkerSvg("cafe", null)), NO_GREY_OR_BLACK, "예전 API 도 회색·검정을 쓰지 않는다");
}

console.log("markerSvg tests passed");
