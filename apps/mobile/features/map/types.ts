// <NextSpotMap> 의 공급자 중립 자료형 — 화면은 이 타입만 알고 react-native-maps 를 import 하지 않는다.
// 공급자를 네이버로 바꿔도 이 파일과 화면 코드는 그대로다. 순수 모듈.

import type { PinDisplay } from '@/lib/map/markerSvg';
import type { BandInsets } from '@/lib/map/visibleBand';

import type { EdgePadding, LatLng, Region, ViewSize } from './geometry';

export type { BandInsets, EdgePadding, LatLng, PinDisplay, Region, ViewSize };

interface MarkerBase {
  /** 지도 안에서 겹치지 않는 키(React key 로도 쓴다). */
  id: string;
  coordinate: LatLng;
  /** 접근성 라벨(장소 이름 등). */
  title?: string;
  /** 위에 그릴수록 큰 값. 핀은 생략하면 pin.zIndex(선택 100 > 순위 > 등급 > 빈 핀). */
  zIndex?: number;
  /** 화면이 되돌려 받을 값(장소 객체 등). 래퍼는 들여다보지 않는다. */
  data?: unknown;
}

/** 장소 핀 — 웹 lib/map/markerSvg 의 pinDisplay 결과를 그대로 받는다(등급 채움·빈 핀·금색 순위 고리·예측 점선·선택 크기). */
export interface PinMarker extends MarkerBase {
  kind: 'pin';
  pin: PinDisplay;
  /** 장소 유형(restaurant·cafe·attraction·culture·parking …) — 핀 안 아이콘. */
  placeType: string;
  selected?: boolean;
  dark?: boolean;
  /** 같은 건물 묶음이면 구성원 id(2개 이상). 있으면 누를 때 onGroupPress 가 불린다. */
  groupIds?: string[];
}

/** 코스 정류지 번호 원(금색 원 + 흰 숫자). 첫 정류지는 크게(emphasized). */
export interface NumberMarker extends MarkerBase {
  kind: 'number';
  label: string | number;
  emphasized?: boolean;
}

/** 작은 색 점(축제 정확 지점 등). */
export interface DotMarker extends MarkerBase {
  kind: 'dot';
  color: string;
  size?: number;
}

/** 말풍선 라벨(축제 이름 등). above=true 면 좌표 위에 뜨고, false 면 좌표 가운데에 선다. */
export interface LabelMarker extends MarkerBase {
  kind: 'label';
  text: string;
  color: string;
  above?: boolean;
}

export type NextSpotMarker = PinMarker | NumberMarker | DotMarker | LabelMarker;

export interface NextSpotCircle {
  id: string;
  center: LatLng;
  radiusM: number;
  strokeColor: string;
  fillColor: string;
  strokeWidth?: number;
  /** 점선 테두리(축제 600m 원). 안드로이드는 원 점선을 못 그려 Polyline 고리로 그린다. */
  dashed?: boolean;
  zIndex?: number;
}

export interface NextSpotPolyline {
  id: string;
  coordinates: LatLng[];
  strokeColor: string;
  strokeWidth?: number;
  /** 점선(코스 순서선 — 웹 'shortdash'). */
  dashed?: boolean;
  zIndex?: number;
}

/**
 * 내 위치 점. showsUserLocation 을 쓰지 않는다 — 경주 밖이면 화면이 위치를 황리단길 중심으로 옮겨 넘기기 때문이다.
 * halo = /main 의 금빛 점(흰 테두리 + 금빛 번짐), plain = 코스 지도의 먹색 점.
 */
export interface UserLocationDot extends LatLng {
  variant?: 'halo' | 'plain';
}

/** 지도가 지금 보여 주는 것 — 핀 겹침 계산(declutterPins)에 그대로 넘긴다. */
export interface MapViewport {
  region: Region;
  size: ViewSize;
  /** 정수 카카오 level(웹 map.getLevel() 자리). */
  level: number;
}

export interface FitToCoordinatesOptions {
  /** 직접 주는 패딩(dp). insets 보다 우선한다. */
  padding?: Partial<EdgePadding>;
  /** 가리는 두께(톱바·시트) — 웹 /main 규칙(fitPaddingForInsets)으로 패딩을 만든다. */
  insets?: Partial<BandInsets>;
  /** 확대 하한(카카오 level). 코스 지도는 4. */
  minLevel?: number;
  maxLevel?: number;
  /** 0 이면 바로 옮긴다. 기본 400ms. */
  duration?: number;
}

export interface AnimateToOptions {
  /** 이 축척(카카오 level)으로 바꾼다. 없으면 지금 축척 그대로. */
  level?: number;
  /** 가리는 두께 — 주면 그 띠의 가운데로(웹 panToVisible·centerOnFreeArea). */
  insets?: Partial<BandInsets>;
  duration?: number;
}

/** ref 로 받는 카메라 API. */
export interface NextSpotMapHandle {
  fitToCoordinates(coordinates: LatLng[], options?: FitToCoordinatesOptions): void;
  animateTo(target: LatLng, options?: AnimateToOptions): void;
  /** 마지막으로 알려진 영역(지도 준비 전이면 첫 영역). */
  getRegion(): Region | null;
  /** 영역 + 상자 크기 + level. 상자 크기를 모르면 null. */
  getViewport(): MapViewport | null;
}
