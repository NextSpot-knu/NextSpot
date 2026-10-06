import type { Page } from '@playwright/test';

// 지도 SDK 대역 — 결정적 e2e 는 원래 Kakao SDK 를 빈 스크립트로 막는다(support/stubs.ts). 그러면 지도가
// 없어 '지도에서 보기' 핀이나 주차장 핀 클릭처럼 지도 위에서만 일어나는 일을 볼 수 없다. 여기서는 앱이 쓰는
// 표면(LatLng·Map·Marker·CustomOverlay·Circle·event·load)만 흉내 내는 스크립트를 대신 준다.
//   · window.__kakaoFake.markers()  — 지금 지도에 올라간 마커 제목들
//   · window.__kakaoFake.labels()   — 지금 지도에 올라간 CustomOverlay 의 글자들
//   · window.__kakaoFake.click(t)   — 제목이 t 인 마커의 click 리스너를 부른다(없으면 false)
// stubExternalServices 뒤에 부른다(Playwright 는 나중에 등록한 라우트가 이긴다).

const FAKE_SDK = `(() => {
  const listeners = new WeakMap();
  const onMap = new Set();
  function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
  LatLng.prototype.getLat = function () { return this.lat; };
  LatLng.prototype.getLng = function () { return this.lng; };
  function Point(x, y) { this.x = x; this.y = y; }
  function Size(width, height) { this.width = width; this.height = height; }
  function MarkerImage(src, size, options) { this.src = src; this.size = size; this.options = options; }
  // 1e5 px/도 — 경주 시내 몇 백 m 가 수십 px 로 벌어져 핀 간격 규칙이 실제처럼 돈다.
  const projection = {
    containerPointFromCoords: (ll) => new Point((ll.getLng() - 129.2) * 1e5, (35.85 - ll.getLat()) * 1e5),
    coordsFromContainerPoint: (pt) => new LatLng(35.85 - pt.y / 1e5, 129.2 + pt.x / 1e5),
  };
  function KMap(container, options) { this.container = container; this.center = options.center; this.level = options.level; }
  KMap.prototype.getLevel = function () { return this.level; };
  KMap.prototype.setLevel = function (level) { this.level = level; };
  KMap.prototype.getCenter = function () { return this.center; };
  KMap.prototype.setCenter = function (center) { this.center = center; };
  KMap.prototype.panTo = function (center) { this.center = center; };
  KMap.prototype.getBounds = function () { return { contain: () => true }; };
  KMap.prototype.getProjection = function () { return projection; };
  KMap.prototype.relayout = function () {};
  function Overlay(options) { Object.assign(this, options || {}); if (this.map) onMap.add(this); }
  Overlay.prototype.setMap = function (map) { this.map = map; if (map) onMap.add(this); else onMap.delete(this); };
  Overlay.prototype.getMap = function () { return this.map || null; };
  Overlay.prototype.getPosition = function () { return this.position; };
  Overlay.prototype.setPosition = function (position) { this.position = position; };
  Overlay.prototype.setZIndex = function (zIndex) { this.zIndex = zIndex; };
  Overlay.prototype.setImage = function (image) { this.image = image; };
  Overlay.prototype.setContent = function (content) { this.content = content; };
  Overlay.prototype.getContent = function () { return this.content; };
  Overlay.prototype.getTitle = function () { return this.title; };
  function Marker(options) { Overlay.call(this, options); }
  Marker.prototype = Object.create(Overlay.prototype);
  function CustomOverlay(options) { Overlay.call(this, options); }
  CustomOverlay.prototype = Object.create(Overlay.prototype);
  function Circle(options) { Overlay.call(this, options); }
  Circle.prototype = Object.create(Overlay.prototype);
  const event = {
    addListener(target, type, handler) {
      const byType = listeners.get(target) || {};
      (byType[type] = byType[type] || []).push(handler);
      listeners.set(target, byType);
    },
    removeListener() {},
    trigger(target, type) { ((listeners.get(target) || {})[type] || []).forEach((handler) => handler()); },
  };
  window.kakao = { maps: {
    load: (callback) => callback(),
    LatLng, Point, Size, MarkerImage, Map: KMap, Marker, CustomOverlay, Circle, event,
  } };
  window.__kakaoFake = {
    markers: () => [...onMap].filter((o) => o instanceof Marker).map((o) => o.title),
    labels: () => [...onMap].filter((o) => o instanceof CustomOverlay).map((o) => (o.content && o.content.textContent) || ''),
    click: (title) => {
      const marker = [...onMap].find((o) => o instanceof Marker && o.title === title);
      if (!marker) return false;
      event.trigger(marker, 'click');
      return true;
    },
  };
})();`;

export async function stubFakeKakaoMap(page: Page): Promise<void> {
  await page.route('**://dapi.kakao.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_SDK }),
  );
}

export type KakaoFakeWindow = Window & {
  __kakaoFake: { markers: () => string[]; labels: () => string[]; click: (title: string) => boolean };
};
