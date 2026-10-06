// /main 지도 핀 — 무엇을 칠할지(pinDisplay)와 어떻게 그릴지(pinSvg)를 한 곳에서 정한다(계획 B3 · I06+P4).
//
// 핀은 이 서비스의 얼굴이다. 예전 핀은 근거가 없으면 회색(#4b5563) 몸통 + 까만 원이라, 경주 지도 위 7곳 중
// 5~7곳이 '데이터 없음' 으로 읽혔다(심사 시뮬레이션 2026-10-06). 이제 규칙은 셋이다:
//   1) **지금 잰 값(24시간 안쪽 실측)만 칠한다** — 등급색으로 꽉 찬 큰 핀. 46일 전 관측이나 시각을 모르는 값은
//      칠하지 않는다(lib/congestionEstimate.ts 의 LAST_OBSERVED_MAX_AGE_MS 와 같은 선).
//   2) **그 밖은 옅은 빈 핀**(작게) — 회색·검정이 아니라 한지색 몸통에 먹선. '없다' 가 아니라 '아직 안 잼' 으로 읽힌다.
//      추정(주차 실측 + 관광 통계)은 핀을 칠하지 않는다(사용자 결정 2026-09-20 · PM 4.3) — 카드의 '추정' 배지가 말한다.
//   3) **서버 상위 추천(1~5위)은 금색 고리 + 순위 숫자**로 보통 크기 — 근거가 있든 없든 '여기가 추천' 이 보인다.
// 혼잡 예측(+N시간) 모드에서는(PM 4.2 a) 순위 핀이 그 시각의 이 일대 예측 등급(또는 장소별 모델 예측)을 받고
// 흰 점선 고리로 '예측' 임을 구분한다. 지금 잰 값은 그 시각의 값이 아니라 예측 모드에서는 칠하지 않는다.
//
// 아이콘 path 는 lucide-react(설치본) 아이콘의 path 데이터 그대로다(24x24 viewBox, stroke 기반).
import { DEFAULT_BUSY_THRESHOLD, congestionKey, type CongestionKey } from "../congestionScale";

const ICON_PATHS: Record<string, string> = {
  // utensils (음식점)
  restaurant:
    '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  // coffee (카페)
  cafe:
    '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
  // camera (관광지)
  attraction:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  // building-2 (문화시설/박물관)
  culture:
    '<path d="M10 12h4"/><path d="M10 8h4"/><path d="M14 21v-3a2 2 0 0 0-4 0v3"/><path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"/><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/>',
  // parking (공식 주차장)
  parking:
    '<circle cx="12" cy="12" r="9"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
  // map-pin (기본)
  default:
    '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><path d="M12 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
};

/** 등급별 핀 몸통 색. 평소 = 700계열, 선택 = 한 단계 밝게. 화면 범례(ForecastTimeStrip)도 이 표를 쓴다. */
export const PIN_GRADE_COLORS: Record<CongestionKey, { base: string; sel: string }> = {
  busy: { base: "#b91c1c", sel: "#dc2626" },     // 혼잡 (red 700/600)
  moderate: { base: "#b45309", sel: "#d97706" }, // 보통 (amber 700/600)
  relaxed: { base: "#047857", sel: "#059669" },  // 여유 (emerald 700/600)
  quiet: { base: "#1d4ed8", sel: "#2563eb" },    // 한산 (blue 700/600)
};

/** 빈 핀(아직 잰 값이 없는 곳) — 라이트는 한지색 몸통 + 먹선, 야간은 먹빛 몸통(#3a3027) + 밝은 선. */
const HOLLOW = {
  light: { body: "#fffaf0", stroke: "#8a7a66", glyph: "#6b5d4f" },
  dark: { body: "#3a3027", stroke: "#c4b49f", glyph: "#efe4d2" },
} as const;
const GOLD_RING = "#c19a3e";
/** 순위 핀의 번호 원 — 혼잡 예측 줄의 범례도 같은 색으로 그린다. */
export const RANK_BADGE = { fill: "#8a6a1c", text: "#ffffff" } as const;

/** 실측을 '지금 칠할 수 있는' 최대 나이(24시간). lib/congestionEstimate.ts 의 LAST_OBSERVED_MAX_AGE_MS 와 같다. */
export const PIN_MEASURED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** 핀 크기(px). 휴대폰은 조금 작게 — 7개 핀 상한과 함께 지도가 핀으로 덮이지 않게. */
export const PIN_SIZES = {
  desktop: { normal: { w: 40, h: 50 }, hollow: { w: 26, h: 33 }, selected: { w: 50, h: 63 } },
  phone: { normal: { w: 34, h: 43 }, hollow: { w: 26, h: 33 }, selected: { w: 42, h: 53 } },
} as const;

export interface PinInput {
  type: string;
  /** 실측 혼잡도(0~1). 추정은 넣지 않는다 — 핀은 추정을 칠하지 않는다. */
  level: number | null | undefined;
  /** 그 실측의 관측 시각(ISO). 모르면 칠하지 않는다(언제 잰 값인지 말할 수 없다). */
  observedAt?: string | null;
  /** 'predicted' 처럼 실측이 아닌 출처면 지금 칠하지 않는다. */
  source?: string | null;
  /** 서버 상위 추천에서의 순위(1~5). 목록 밖이면 null. */
  rank?: number | null;
  /** 혼잡 예측(+N시간) 모드인가. */
  forecastMode?: boolean;
  /**
   * 예측 모드에서 이 핀에 칠할 예측 혼잡도 — 장소별 모델 예측이 있으면 그 값, 없고 순위 핀이면 이 일대 예측
   * (부르는 쪽이 고른다). 없으면 null.
   */
  forecastLevel?: number | null;
  selected?: boolean;
  phone?: boolean;
  busyAt?: number;
  now?: Date;
}

export interface PinDisplay {
  style: "filled" | "hollow";
  /** 칠할 등급. 빈 핀이면 null. */
  grade: CongestionKey | null;
  /** 금색 고리(지금 추천) · 흰 점선 고리(예측) · 없음. */
  ring: "gold" | "dashed" | null;
  rank: number | null;
  width: number;
  height: number;
  zIndex: number;
}

/** 이 실측을 지금 칠해도 되는가 — 숫자 · 실측 출처 · 24시간 안쪽 관측. */
export function isPaintableMeasurement(
  input: { level: number | null | undefined; observedAt?: string | null; source?: string | null },
  now: Date = new Date(),
): boolean {
  if (typeof input.level !== "number" || !Number.isFinite(input.level)) return false;
  if (input.source === "predicted" || input.source === "estimated") return false;
  if (!input.observedAt) return false;
  const ms = new Date(input.observedAt).getTime();
  if (Number.isNaN(ms)) return false;
  const age = now.getTime() - ms;
  return age <= PIN_MEASURED_MAX_AGE_MS && age >= -FUTURE_SKEW_MS;
}

/** 핀 한 개를 어떻게 보일지. 순수 함수 — 지도 SDK 를 모른다. */
export function pinDisplay(input: PinInput): PinDisplay {
  const busyAt = input.busyAt ?? DEFAULT_BUSY_THRESHOLD;
  const rank = typeof input.rank === "number" && input.rank >= 1 ? Math.round(input.rank) : null;
  let grade: CongestionKey | null = null;
  if (input.forecastMode) {
    const level = input.forecastLevel;
    if (typeof level === "number" && Number.isFinite(level)) grade = congestionKey(Math.min(1, Math.max(0, level)), busyAt);
  } else if (isPaintableMeasurement(input, input.now)) {
    grade = congestionKey(input.level as number, busyAt);
  }
  const ring: PinDisplay["ring"] = input.forecastMode && grade ? "dashed" : rank ? "gold" : null;
  const sizes = input.phone ? PIN_SIZES.phone : PIN_SIZES.desktop;
  const size = input.selected ? sizes.selected : grade || rank ? sizes.normal : sizes.hollow;
  const zIndex = input.selected ? 100 : rank ? 20 - rank : grade ? 5 : 1;
  return { style: grade ? "filled" : "hollow", grade, ring, rank, width: size.w, height: size.h, zIndex };
}

/** pinDisplay 결과 → SVG data URI. viewBox 40x50 하나로 그리고 크기는 MarkerImage 가 맞춘다. */
export function pinSvg(display: PinDisplay, type: string, options: { selected?: boolean; dark?: boolean } = {}): string {
  const glyphKey = ICON_PATHS[type] ? type : "default";
  const hollow = options.dark ? HOLLOW.dark : HOLLOW.light;
  const filled = display.style === "filled" && display.grade;
  const body = filled
    ? (options.selected ? PIN_GRADE_COLORS[display.grade!].sel : PIN_GRADE_COLORS[display.grade!].base)
    : hollow.body;
  const glyph = filled ? "#ffffff" : hollow.glyph;
  // 몸통 테두리 — 금색 고리(추천) · 흰 점선(예측) · 흰 선(실측) · 먹선(빈 핀).
  const ringStroke = display.ring === "gold" ? GOLD_RING : display.ring === "dashed" ? "#ffffff" : filled ? "#ffffff" : hollow.stroke;
  const ringWidth = display.ring === "gold" ? 3.4 : display.ring === "dashed" ? 3 : filled ? 2 : 1.8;
  const dash = display.ring === "dashed" ? ' stroke-dasharray="4 3"' : "";
  // 예측 점선 아래에는 몸통 색 테두리를 한 번 더 깔아 점선 사이가 비어 보이지 않게 한다.
  const under = display.ring === "dashed" ? `<path d="${PIN_PATH}" fill="none" stroke="${body}" stroke-width="3"/>` : "";
  const size = 17;
  const s = (size / 24).toFixed(4);
  const icon = `<g fill="none" stroke="${glyph}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(${20 - size / 2} ${19 - size / 2}) scale(${s})">${ICON_PATHS[glyphKey]}</g>`;
  const badge = display.rank
    ? `<circle cx="32" cy="8.5" r="7.5" fill="${RANK_BADGE.fill}" stroke="#ffffff" stroke-width="1.6"/><text x="32" y="12.2" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5" font-weight="800" fill="${RANK_BADGE.text}">${display.rank}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50" data-pin="${display.style}${display.ring ? `-${display.ring}` : ""}">${under}<path d="${PIN_PATH}" fill="${body}" stroke="${ringStroke}" stroke-width="${ringWidth}"${dash}/>${icon}${badge}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// 몸통(물방울) — 위 둥근 머리 + 아래 뾰족한 끝. 테두리가 잘리지 않게 viewBox 안쪽 2px 여백.
const PIN_PATH =
  "M20 2.2C10.6 2.2 3 9.7 3 19c0 11.9 15.4 25.2 16.1 25.8a1.4 1.4 0 0 0 1.8 0C21.6 44.2 37 30.9 37 19 37 9.7 29.4 2.2 20 2.2z";

/**
 * 예전 API — 실측 혼잡도 하나로 핀을 그린다. 새 화면은 pinDisplay + pinSvg 를 쓴다. 등급 판정은 같은
 * congestionKey(level, busyAt) 이고, 근거가 없으면 빈 핀(회색·검정 아님)이다.
 */
export const getMarkerSvg = (
  type: string,
  level: number | null | undefined,
  _features?: unknown,
  selected: boolean = false,
  // '혼잡' 경계는 운영자 설정(GET /system/public-settings)에서 온다(congestionScale.ts).
  busyAt: number = DEFAULT_BUSY_THRESHOLD,
) => {
  const grade = typeof level === "number" ? congestionKey(level, busyAt) : null;
  const display: PinDisplay = {
    style: grade ? "filled" : "hollow", grade, ring: null, rank: null, width: 40, height: 50, zIndex: grade ? 5 : 1,
  };
  return pinSvg(display, type, { selected });
};
