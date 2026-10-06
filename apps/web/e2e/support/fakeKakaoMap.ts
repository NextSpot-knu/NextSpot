import type { Page } from '@playwright/test';

// 지도 SDK 대역 — 결정적 e2e 는 원래 Kakao SDK 를 빈 스크립트로 막는다(support/stubs.ts). 그러면 지도가
// 없어 '지도에서 보기' 핀이나 주차장 핀 클릭처럼 지도 위에서만 일어나는 일을 볼 수 없다. 여기서는 앱이 쓰는
// 표면(LatLng·LatLngBounds·Map·Marker·CustomOverlay·Circle·event·load)만 흉내 내는 스크립트를 대신 준다.
//   · window.__kakaoFake.markers()  — 지금 지도에 올라간 마커 제목들
//   · window.__kakaoFake.pins()     — 지금 지도에 올라간 마커의 제목 · 크기 · z-index(핀 모양 검사용)
//   · window.__kakaoFake.labels()   — 지금 지도에 올라간 CustomOverlay 의 글자들
//   · window.__kakaoFake.click(t)   — 제목이 t 인 마커의 click 리스너를 부른다(없으면 false)
//   · window.__kakaoFake.lastBounds() — 마지막 setBounds 에 들어온 점 수(지도 맞춤 검사용, 없으면 0)
// 마커·오버레이는 지도 상자 안에 실제로 그린다(스크린숏에 핀이 보이게 — 포인터는 받지 않는다). 실제 SDK 처럼
// 왼쪽 아래에 'kakao' 로고 자리(data-testid=kakao-logo)를 둔다 — 지도 위 조작부가 로고를 가리는지 잰다.
// stubExternalServices 뒤에 부른다(Playwright 는 나중에 등록한 라우트가 이긴다).

const FAKE_SDK = `(() => {
  const listeners = new WeakMap();
  const onMap = new Set();
  const maps = new Set();
  let lastBoundsCount = 0;
  function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
  LatLng.prototype.getLat = function () { return this.lat; };
  LatLng.prototype.getLng = function () { return this.lng; };
  function LatLngBounds() { this.points = []; }
  LatLngBounds.prototype.extend = function (latlng) { this.points.push(latlng); };
  LatLngBounds.prototype.contain = function () { return true; };
  function Point(x, y) { this.x = x; this.y = y; }
  function Size(width, height) { this.width = width; this.height = height; }
  function MarkerImage(src, size, options) { this.src = src; this.size = size; this.options = options; }
  // 1e5 px/도 — 경주 시내 몇 백 m 가 수십 px 로 벌어져 핀 간격 규칙이 실제처럼 돈다.
  const projection = {
    containerPointFromCoords: (ll) => new Point((ll.getLng() - 129.2) * 1e5, (35.85 - ll.getLat()) * 1e5),
    coordsFromContainerPoint: (pt) => new LatLng(35.85 - pt.y / 1e5, 129.2 + pt.x / 1e5),
  };
  function schedule(map) {
    if (!map || map.__pending) return;
    map.__pending = true;
    Promise.resolve().then(() => { map.__pending = false; render(map); });
  }
  function render(map) {
    const layer = map.layer;
    if (!layer || !layer.isConnected) return;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const width = map.container.clientWidth || 0;
    const height = map.container.clientHeight || 0;
    const c = projection.containerPointFromCoords(map.center);
    for (const o of onMap) {
      if (o.map !== map || !o.position) continue;
      const p = projection.containerPointFromCoords(o.position);
      const x = width / 2 + (p.x - c.x);
      const y = height / 2 + (p.y - c.y);
      const wrap = document.createElement('div');
      wrap.style.position = 'absolute';
      wrap.style.zIndex = String(o.zIndex || 0);
      wrap.style.pointerEvents = o.clickable ? 'auto' : 'none';
      if (o instanceof Marker && o.image) {
        const img = document.createElement('img');
        img.src = o.image.src;
        img.alt = '';
        img.width = o.image.size.width;
        img.height = o.image.size.height;
        img.style.display = 'block';
        wrap.appendChild(img);
        const off = (o.image.options && o.image.options.offset) || new Point(o.image.size.width / 2, o.image.size.height);
        wrap.style.left = (x - off.x) + 'px';
        wrap.style.top = (y - off.y) + 'px';
        layer.appendChild(wrap);
      } else if (o instanceof CustomOverlay && o.content) {
        if (typeof o.content === 'string') wrap.innerHTML = o.content; else wrap.appendChild(o.content);
        layer.appendChild(wrap);
        const xa = typeof o.xAnchor === 'number' ? o.xAnchor : 0.5;
        const ya = typeof o.yAnchor === 'number' ? o.yAnchor : 0.5;
        wrap.style.left = (x - wrap.offsetWidth * xa) + 'px';
        wrap.style.top = (y - wrap.offsetHeight * ya) + 'px';
      }
    }
  }
  function KMap(container, options) {
    this.container = container; this.center = options.center; this.level = options.level;
    const layer = document.createElement('div');
    layer.setAttribute('data-fake-map-layer', '');
    layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    const logo = document.createElement('div');
    logo.setAttribute('data-testid', 'kakao-logo');
    logo.textContent = 'kakao';
    logo.style.cssText = 'position:absolute;left:8px;bottom:6px;width:56px;height:18px;font:700 12px sans-serif;color:#555;z-index:1;';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(layer);
    container.appendChild(logo);
    this.layer = layer;
    maps.add(this);
    schedule(this);
  }
  KMap.prototype.getLevel = function () { return this.level; };
  KMap.prototype.setLevel = function (level) { this.level = level; schedule(this); };
  KMap.prototype.getCenter = function () { return this.center; };
  KMap.prototype.setCenter = function (center) { this.center = center; schedule(this); };
  KMap.prototype.panTo = function (center) { this.center = center; schedule(this); };
  KMap.prototype.setBounds = function (bounds) { lastBoundsCount = (bounds && bounds.points ? bounds.points.length : 0); schedule(this); };
  KMap.prototype.getBounds = function () { return { contain: () => true }; };
  KMap.prototype.getProjection = function () { return projection; };
  KMap.prototype.relayout = function () { schedule(this); };
  function Overlay(options) { Object.assign(this, options || {}); if (this.map) { onMap.add(this); schedule(this.map); } }
  Overlay.prototype.setMap = function (map) {
    const prev = this.map;
    this.map = map;
    if (map) onMap.add(this); else onMap.delete(this);
    schedule(prev); schedule(map);
  };
  Overlay.prototype.getMap = function () { return this.map || null; };
  Overlay.prototype.getPosition = function () { return this.position; };
  Overlay.prototype.setPosition = function (position) { this.position = position; schedule(this.map); };
  Overlay.prototype.setZIndex = function (zIndex) { this.zIndex = zIndex; schedule(this.map); };
  Overlay.prototype.setImage = function (image) { this.image = image; schedule(this.map); };
  Overlay.prototype.setContent = function (content) { this.content = content; schedule(this.map); };
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
    LatLng, LatLngBounds, Point, Size, MarkerImage, Map: KMap, Marker, CustomOverlay, Circle, event,
  } };
  window.addEventListener('resize', () => maps.forEach((map) => schedule(map)));
  window.__kakaoFake = {
    markers: () => [...onMap].filter((o) => o instanceof Marker).map((o) => o.title),
    pins: () => [...onMap].filter((o) => o instanceof Marker && o.image).map((o) => ({
      title: o.title, width: o.image.size.width, height: o.image.size.height, zIndex: o.zIndex || 0, src: o.image.src,
    })),
    labels: () => [...onMap].filter((o) => o instanceof CustomOverlay).map((o) => (o.content && o.content.textContent) || ''),
    click: (title) => {
      const marker = [...onMap].find((o) => o instanceof Marker && o.title === title);
      if (!marker) return false;
      event.trigger(marker, 'click');
      return true;
    },
    lastBounds: () => lastBoundsCount,
  };
})();`;

export async function stubFakeKakaoMap(page: Page): Promise<void> {
  await page.route('**://dapi.kakao.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_SDK }),
  );
}

export interface FakePin { title: string; width: number; height: number; zIndex: number; src: string }

export type KakaoFakeWindow = Window & {
  __kakaoFake: {
    markers: () => string[];
    pins: () => FakePin[];
    labels: () => string[];
    click: (title: string) => boolean;
    lastBounds: () => number;
  };
};
