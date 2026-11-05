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
  // 키 없는 빌드의 지도 자리(한지 진한 톤)
  unavailable: '#efe6d6',
} as const;

/** 내 위치 점 크기(dp) — 웹 /main: 흰 테두리 28 · 금빛 점 14, 번짐은 정적 고리로(지름 44). 코스: 14 + 테두리 3. */
export const USER_DOT = {
  halo: { outer: 44, ring: 28, core: 14 },
  plain: { core: 14, border: 3, outer: 22 },
} as const;

/**
 * 앵커 — 핀은 아래 끝(뾰족한 곳)이 좌표에, 나머지는 가운데가 좌표에 온다.
 * 구글(안드로이드)은 anchor(0~1), 애플 지도는 centerOffset(dp, 기본은 가운데가 좌표)를 쓴다.
 */
export function markerAnchor(kind: 'bottom' | 'center' | 'above', height: number): {
  anchor: { x: number; y: number };
  centerOffset: { x: number; y: number };
} {
  if (kind === 'bottom') return { anchor: { x: 0.5, y: 1 }, centerOffset: { x: 0, y: -height / 2 } };
  // 웹 축제 라벨 yAnchor 1.35 — 라벨 높이의 1.35배 위.
  if (kind === 'above') return { anchor: { x: 0.5, y: 1.35 }, centerOffset: { x: 0, y: -height * 0.85 } };
  return { anchor: { x: 0.5, y: 0.5 }, centerOffset: { x: 0, y: 0 } };
}

/**
 * 구글 지도 스타일 — 웹 /main 지도 타일 필터 `saturate(55%) brightness(103%)`(globals.css) 에 맞춘 채도 낮춤.
 * 등급색 핀이 알록달록한 기본 지도에 묻히지 않게 한다. 애플 지도는 mapType 'mutedStandard' 로 대신한다.
 */
export const GOOGLE_MUTED_STYLE: { featureType?: string; elementType?: string; stylers: object[] }[] = [
  { stylers: [{ saturation: -45 }, { lightness: 3 }] },
];
