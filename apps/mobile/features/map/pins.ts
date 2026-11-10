// 핀·점·지도 색의 순수 부분 — react-native-svg 의 SvgXml 에 넣을 XML, 크기, 앵커, 구글 지도 스타일.
// 웹 lib/map/markerSvg.pinSvg 는 카카오 MarkerImage 용 data URI 를 돌려준다. 앱은 같은 SVG 를 쓰되 URI 를 풀어 XML 로 넘긴다
// (핀 모양 규칙이 한 곳에 남는다). 순수 모듈.

import { pinSvg, type PinDisplay } from '@/lib/map/markerSvg';

const SVG_URI_PREFIX = 'data:image/svg+xml;charset=utf-8,';

/** data:image/svg+xml URI → SVG XML 문자열. */
export function svgXmlFromDataUri(uri: string): string {
  if (uri.startsWith(SVG_URI_PREFIX)) return decodeURIComponent(uri.slice(SVG_URI_PREFIX.length));
  const comma = uri.indexOf(',');
  return comma >= 0 ? decodeURIComponent(uri.slice(comma + 1)) : uri;
}

/** 웹과 같은 핀 SVG(XML). */
export function pinXml(display: PinDisplay, placeType: string, options: { selected?: boolean; dark?: boolean } = {}): string {
  return svgXmlFromDataUri(pinSvg(display, placeType, options));
}

/** 핀 그림이 바뀌었는지 가리는 키 — 바뀌면 마커가 한 번 다시 그려지게(tracksViewChanges) 한다. */
export function pinContentKey(display: PinDisplay, placeType: string, options: { selected?: boolean; dark?: boolean } = {}): string {
  return [display.style, display.grade ?? '-', display.ring ?? '-', display.rank ?? '-', display.width, display.height,
    placeType, options.selected ? 's' : '', options.dark ? 'd' : ''].join('|');
}

/** 코스 번호 원 크기(dp) — 웹 CourseMap: 첫 정류지 34 · 나머지 28. */
export function numberMarkerSize(emphasized: boolean | undefined): { size: number; fontSize: number } {
  return emphasized ? { size: 34, fontSize: 14 } : { size: 28, fontSize: 12 };
}

/** 색 */
export const MAP_COLORS = {
  gold: '#c19a3e',
  muk: '#2b2320',
  white: '#ffffff',
  festivalOngoing: '#c1553b',
  festivalUpcoming: '#c19a3e',
  // 지도를 불러오는 동안의 지도 자리(한지 진한 톤). 못 그리면 MAP_UNAVAILABLE_GRADIENT.
  unavailable: '#efe6d6',
} as const;

/**
 * 지도를 못 그릴 때(키 없음·SDK 시간 초과)의 지도 자리 — 웹 /main 지도 자리·CourseMap 폴백과 같은
 * `bg-gradient-to-b from-hanji-deep/70 via-hanji-deep/40 to-hanji`(위 → 아래, 0 · 50 · 100%).
 */
export const MAP_UNAVAILABLE_GRADIENT = ['rgba(241, 231, 211, 0.7)', 'rgba(241, 231, 211, 0.4)', '#faf5ec'] as const;

/**
 * 내 위치 점 크기(dp).
 * - halo = 웹 /main(`page.tsx` user-loc-marker): 100 상자 금빛 번짐 + 흰 원 28(그림자 0 0 10 먹 .25) + 금 점 14.
 *   웹 빌드는 웹처럼 맥박(1.2초)을 돌리고, 네이티브는 정적 번짐이다(구글 마커는 600ms 뒤 비트맵으로 굳는다 — tracksViewChanges).
 * - plain = 코스(`CourseMap.tsx` 사용자 점): 14 상자(border-box) 안 먹 8 + 흰 테 3, 번짐 4(0 0 0 4px 먹 .15 → 바깥 22).
 */
export const USER_DOT = {
  halo: { outer: 100, ring: 28, core: 14 },
  plain: { core: 8, border: 3, outer: 22 },
} as const;

/** 웹 번짐 — `radial-gradient(circle, 금 .6 0%, 금 .2 50%, 금 0 80%)`(웹 빌드는 이 문자열을 그대로 쓴다). */
export const USER_HALO_CSS_GRADIENT =
  'radial-gradient(circle, rgba(193,154,62,0.6) 0%, rgba(193,154,62,0.2) 50%, rgba(193,154,62,0) 80%)';

/**
 * 웹 번짐을 반지름 r 원의 RadialGradient 정지점으로(네이티브 react-native-svg, 오프셋은 원 반지름 기준 0~1).
 * CSS `radial-gradient(circle, …)` 의 크기는 farthest-corner — 정사각 상자에서 반지름 √2·r 이다. 상자는 원(r)으로 잘리므로
 * 정지점 0 · 50% · 80% 를 원 반지름 기준으로 다시 재고, 원 끝(1)의 투명도는 그 구간을 선형으로 이어 구한다.
 */
export function userHaloStops(): { offset: number; opacity: number }[] {
  const corner = Math.SQRT2;
  const css = [
    { at: 0, opacity: 0.6 },
    { at: 0.5, opacity: 0.2 },
    { at: 0.8, opacity: 0 },
  ];
  const stops: { offset: number; opacity: number }[] = [];
  for (let i = 0; i < css.length; i++) {
    const offset = css[i].at * corner;
    if (offset <= 1) {
      stops.push({ offset, opacity: css[i].opacity });
      continue;
    }
    const prev = css[i - 1];
    const prevOffset = prev.at * corner;
    const t = (1 - prevOffset) / (offset - prevOffset);
    stops.push({ offset: 1, opacity: prev.opacity + (css[i].opacity - prev.opacity) * t });
    break;
  }
  return stops;
}

/**
 * 카카오 기본 마커(`new kakao.maps.Marker({ position })` — 웹 대안 화면 미니맵) 실측(2026-11-11, 웹 390px):
 * 이미지 `mapjsapi/images/2x/marker.png`(58×84)를 29×42 로 그리고, 오버레이 margin 이 `-39px 0 0 -14px` — 좌표는 그림의 (14, 39)
 * (뾰족 끝 — 그 아래 3px 은 그림자). 웹 빌드는 카카오 Marker 를 그대로 쓰고, 네이티브는 DEFAULT_PIN_XML 로 같은 모양·크기·기준점을 그린다.
 */
export const DEFAULT_PIN = { width: 29, height: 42, anchorX: 14, anchorY: 39 } as const;

/** 카카오 기본 마커와 같은 파란 물방울 핀(2x 실측 좌표 — viewBox 58×84). 몸 #238cfa · 테 #0c52c0 · 흰 원 · 파란 ▼ · 그림자. */
export const DEFAULT_PIN_XML =
  '<svg xmlns="http://www.w3.org/2000/svg" width="29" height="42" viewBox="0 0 58 84">' +
  '<defs><radialGradient id="s" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000" stop-opacity="0.45"/>' +
  '<stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>' +
  '<ellipse cx="29" cy="81" rx="7.5" ry="3" fill="url(#s)"/>' +
  '<path d="M29 79.5Q37 56 51.3 38.4A25.5 25.5 0 1 0 6.7 38.4Q21 56 29 79.5Z" fill="#238cfa" stroke="#0c52c0" stroke-opacity="0.6" stroke-width="1"/>' +
  '<circle cx="29" cy="26" r="13" fill="#fff"/>' +
  '<path d="M23.5 24H34.5L29 30Z" fill="#238cfa"/>' +
  '</svg>';

/** 검색 이름표(웹 /main 검색 중 핀 위 이름 — `page.tsx` searchMatchLabels) 높이: 11px × 1.5 + py 4×2 + 테 1×2 = 26.5(실측 27). */
export const SEARCH_LABEL_HEIGHT = 26.5;
/** 검색 이름표 yAnchor — 웹 3.2(좌표가 이름표 위끝에서 높이의 3.2배 아래). */
export const SEARCH_LABEL_Y_ANCHOR = 3.2;
/** 네이티브 검색 이름표 그림 둘레의 그림자 여백(웹 그림자 0 2 10 — 안드로이드 마커 비트맵은 뷰 밖을 자른다). */
export const SEARCH_LABEL_SHADOW_PAD = 12;

/** 그림자 여백 pad 를 두른 검색 이름표 그림의 앵커 — 이름표 위끝(pad)에서 높이의 3.2배 아래가 좌표. pad 0 이면 markerAnchor('search'). */
export function searchLabelAnchor(pad: number, height: number = SEARCH_LABEL_HEIGHT): {
  anchor: { x: number; y: number };
  centerOffset: { x: number; y: number };
} {
  const total = height + pad * 2;
  const at = pad + SEARCH_LABEL_Y_ANCHOR * height;
  return { anchor: { x: 0.5, y: at / total }, centerOffset: { x: 0, y: total / 2 - at } };
}

/**
 * 앵커 — 핀은 아래 끝(뾰족한 곳)이 좌표에, 나머지는 가운데가 좌표에 온다.
 * 구글(안드로이드)은 anchor(그림 크기에 대한 비율), 애플 지도는 centerOffset(dp, 기본은 가운데가 좌표)를 쓴다.
 * - above = 웹 축제 라벨 yAnchor 1.35 · search = 웹 검색 이름표 yAnchor 3.2(높이의 몇 배 위)
 * - defaultPin = 카카오 기본 마커 — 그림의 (14, 39)가 좌표(DEFAULT_PIN). height 는 쓰지 않는다.
 */
export type MarkerAnchorKind = 'bottom' | 'center' | 'above' | 'search' | 'defaultPin';

export function markerAnchor(kind: MarkerAnchorKind, height: number): {
  anchor: { x: number; y: number };
  centerOffset: { x: number; y: number };
} {
  if (kind === 'bottom') return { anchor: { x: 0.5, y: 1 }, centerOffset: { x: 0, y: -height / 2 } };
  // 웹 축제 라벨 yAnchor 1.35 — 라벨 높이의 1.35배 위.
  if (kind === 'above') return { anchor: { x: 0.5, y: 1.35 }, centerOffset: { x: 0, y: -height * 0.85 } };
  if (kind === 'search') {
    return { anchor: { x: 0.5, y: SEARCH_LABEL_Y_ANCHOR }, centerOffset: { x: 0, y: -height * (SEARCH_LABEL_Y_ANCHOR - 0.5) } };
  }
  if (kind === 'defaultPin') {
    const { width, height: h, anchorX, anchorY } = DEFAULT_PIN;
    return {
      anchor: { x: anchorX / width, y: anchorY / h },
      centerOffset: { x: width / 2 - anchorX, y: h / 2 - anchorY },
    };
  }
  return { anchor: { x: 0.5, y: 0.5 }, centerOffset: { x: 0, y: 0 } };
}

/**
 * 구글 지도 스타일 — 웹 /main 지도 타일 필터 `saturate(55%) brightness(103%)`(globals.css) 에 맞춘 채도 낮춤.
 * 등급색 핀이 알록달록한 기본 지도에 묻히지 않게 한다. 애플 지도는 mapType 'mutedStandard' 로 대신한다.
 */
export const GOOGLE_MUTED_STYLE: { featureType?: string; elementType?: string; stylers: object[] }[] = [
  { stylers: [{ saturation: -45 }, { lightness: 3 }] },
];
