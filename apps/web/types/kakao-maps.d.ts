// Kakao Maps JavaScript SDK 앰비언트 타입 선언.
//
// 왜 필요한가: SDK 는 `app/layout.tsx` 가 <script> 로 전역 주입하는 런타임 객체라 번들에
// 타입이 없다. 그래서 지도를 다루는 코드(main·explore/recommend·CourseMap)가 전부
// `kakao: any` / `useRef<any>` 로 빠져 있었다 — 프런트에서 가장 복잡한 영역인데 타입이 0이었다.
//
// 이 파일은 타입 선언만 있고 런타임 코드가 없다(.d.ts) — 동작은 1비트도 바뀌지 않는다.
//
// 범위 원칙: **이 저장소가 실제로 호출하는 표면만** 선언한다. SDK 전체 미러가 목적이 아니다
// (Kakao 는 공식 타입을 배포하지 않아 전체를 따라가면 유지비만 늘고 금방 낡는다).
// 새 API 를 쓰게 되면 그때 여기에 추가할 것 — 없는 멤버를 부르면 tsc 가 잡아준다.
//
// SSR 주의: `window.kakao` 는 스크립트 로드 전/정적 export 프리렌더 시점에 undefined 다.
// 그래서 Window 확장에서 optional 로 뒀고, 호출부의 `typeof window === 'undefined'` 및
// `!window.kakao` 가드는 그대로 필요하다.

declare namespace kakao.maps {
  /** 위경도 좌표. */
  class LatLng {
    constructor(lat: number, lng: number);
    getLat(): number;
    getLng(): number;
  }

  /** 컨테이너 픽셀 좌표(투영 변환용). */
  class Point {
    constructor(x: number, y: number);
    x: number;
    y: number;
  }

  class Size {
    constructor(width: number, height: number);
  }

  /** 여러 좌표를 감싸는 사각 경계 — extend 로 넓힌 뒤 map.setBounds 에 넘긴다. */
  class LatLngBounds {
    constructor();
    extend(latlng: LatLng): void;
    isEmpty(): boolean;
    /** 이 경계가 좌표를 품는지 — 화면 안에 있는 시설만 추리는 데 쓴다. */
    contain(latlng: LatLng): boolean;
  }

  /** 화면 좌표 ↔ 지도 좌표 투영. 카드가 가리는 만큼 중심을 띄우는 보정에 쓴다. */
  interface Projection {
    containerPointFromCoords(latlng: LatLng): Point;
    coordsFromContainerPoint(point: Point): LatLng;
  }

  interface MapOptions {
    center: LatLng;
    level?: number;
    draggable?: boolean;
    scrollwheel?: boolean;
  }

  class Map {
    constructor(container: HTMLElement, options: MapOptions);
    setCenter(latlng: LatLng): void;
    getCenter(): LatLng;
    panTo(latlng: LatLng): void;
    setLevel(level: number, options?: { animate?: boolean }): void;
    getLevel(): number;
    /** 여백(px)은 top/right/bottom/left 순 — 하단 카드에 가리지 않게 CourseMap 이 쓴다. */
    setBounds(
      bounds: LatLngBounds,
      paddingTop?: number,
      paddingRight?: number,
      paddingBottom?: number,
      paddingLeft?: number
    ): void;
    /** 현재 화면에 보이는 영역의 경계. */
    getBounds(): LatLngBounds;
    getProjection(): Projection;
    relayout(): void;
  }

  /** 지도 위에 올라가는 모든 오버레이의 공통 계약 — setMap(null) 로 내린다. */
  interface Overlay {
    setMap(map: Map | null): void;
  }

  interface MarkerImageOptions {
    offset?: Point;
  }

  class MarkerImage {
    constructor(src: string, size: Size, options?: MarkerImageOptions);
  }

  interface MarkerOptions {
    position: LatLng;
    map?: Map;
    image?: MarkerImage;
    title?: string;
    zIndex?: number;
    clickable?: boolean;
  }

  class Marker implements Overlay {
    constructor(options: MarkerOptions);
    setMap(map: Map | null): void;
    getPosition(): LatLng;
    setPosition(latlng: LatLng): void;
    setZIndex(zIndex: number): void;
    setImage(image: MarkerImage): void;
  }

  interface CustomOverlayOptions {
    position: LatLng;
    /** HTML 문자열 또는 DOM 노드 둘 다 허용된다(이 저장소는 문자열을 쓴다). */
    content: string | HTMLElement;
    map?: Map;
    xAnchor?: number;
    yAnchor?: number;
    zIndex?: number;
    clickable?: boolean;
  }

  class CustomOverlay implements Overlay {
    constructor(options: CustomOverlayOptions);
    setMap(map: Map | null): void;
    setPosition(latlng: LatLng): void;
    getPosition(): LatLng;
    setContent(content: string | HTMLElement): void;
  }

  interface CircleOptions {
    center: LatLng;
    radius: number;
    strokeWeight?: number;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeStyle?: string;
    fillColor?: string;
    fillOpacity?: number;
    zIndex?: number;
  }

  class Circle implements Overlay {
    constructor(options: CircleOptions);
    setMap(map: Map | null): void;
  }

  interface PolylineOptions {
    path: LatLng[];
    strokeWeight?: number;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeStyle?: string;
  }

  class Polyline implements Overlay {
    constructor(options: PolylineOptions);
    setMap(map: Map | null): void;
  }

  namespace event {
    function addListener(target: object, type: string, handler: (...args: never[]) => void): void;
    function removeListener(target: object, type: string, handler: (...args: never[]) => void): void;
  }

  /**
   * `autoload=false` 로 주입했으므로, SDK 사용 전 반드시 이 콜백 안에서 초기화해야 한다
   * (layout.tsx 의 script src 참고).
   */
  function load(callback: () => void): void;

  /** `libraries=services` 로 로드된 장소 검색 모듈. */
  namespace services {
    enum Status {
      OK = "OK",
      ZERO_RESULT = "ZERO_RESULT",
      ERROR = "ERROR",
    }

    /** keywordSearch 정렬 기준 — 같은 이름의 다른 지점을 배제하려고 거리순을 쓴다. */
    enum SortBy {
      ACCURACY = "accuracy",
      DISTANCE = "distance",
    }

    /** keywordSearch 결과 1건 — 이 저장소가 읽는 필드만 선언한다. */
    interface PlacesSearchResultItem {
      id: string;
      place_name: string;
      address_name: string;
      road_address_name: string;
      phone: string;
      place_url: string;
      x: string;
      y: string;
      /** 검색 기준 좌표(options.location)로부터의 거리(m). location 을 넘겼을 때만 채워진다. */
      distance?: string;
    }

    class Places {
      constructor(map?: Map);
      keywordSearch(
        keyword: string,
        callback: (result: PlacesSearchResultItem[], status: Status) => void,
        options?: { location?: LatLng; radius?: number; size?: number; sort?: SortBy }
      ): void;
    }
  }
}

interface Window {
  /** SDK 스크립트 로드 전에는 undefined — 반드시 존재 확인 후 사용할 것. */
  kakao?: typeof kakao;
}
