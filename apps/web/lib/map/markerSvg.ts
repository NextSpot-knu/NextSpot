// lucide-react(설치본) 아이콘의 path 데이터(verbatim). 24x24 viewBox, stroke 기반.
// 마커 중앙의 까만 원 위에 '흰색 stroke'로 그려 흰 로고를 만든다.
import { DEFAULT_BUSY_THRESHOLD, congestionKey } from "../congestionScale";

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

// 등급별 마커 색. 평소 = 700계열(톤 다운), 선택 = 밝은 500계열.
const MARKER_COLORS = {
  busy: { base: "#b91c1c", sel: "#ef4444" },     // 혼잡 (red 700/500)
  moderate: { base: "#b45309", sel: "#f59e0b" }, // 보통 (amber 700/500)
  relaxed: { base: "#047857", sel: "#10b981" },  // 여유 (emerald 700/500)
  quiet: { base: "#1d4ed8", sel: "#3b82f6" },    // 한산 (blue 700/500)
} as const;

export const getMarkerSvg = (
  type: string,
  level: number | null | undefined,
  features?: any,
  selected: boolean = false,
  // '혼잡' 경계는 운영자 설정(GET /system/public-settings)에서 온다. 여기에 0.75 를 박아 두면
  // 설정을 내려도 배지만 '혼잡' 으로 바뀌고 지도 마커는 그대로 남아, 같은 장소가 화면에서
  // 서로 다른 말을 한다. 못 받았을 때의 기본값은 congestionScale.ts 가 갖는다.
  busyAt: number = DEFAULT_BUSY_THRESHOLD,
  // 추정 모드(주차 실측 기반 **추정**, lib/congestionEstimate.ts)의 혼잡도. 실측 level 이 있으면
  // 무시한다(측정이 이긴다). 실측이 없고 이 값만 있을 때 **속이 빈 점선 핀**으로 그린다 —
  // 같은 색의 꽉 찬 핀으로 칠하면 지도에서 추정과 실측을 구분할 방법이 없어진다.
  estimatedLevel?: number | null
) => {
  // 마커는 지도 다크 필터를 우회(타일에만 적용)하므로 본래의 색으로 표시된다.
  // 혼잡 로그가 없는 시설(level=null/undefined)은 합성값 대신 회색 '데이터 없음' 마커.
  const isEstimate =
    typeof level !== 'number' && typeof estimatedLevel === 'number' && Number.isFinite(estimatedLevel);
  const p =
    typeof level === 'number'
      ? MARKER_COLORS[congestionKey(level, busyAt)]
      : isEstimate
      ? MARKER_COLORS[congestionKey(estimatedLevel as number, busyAt)]
      : { base: "#4b5563", sel: "#9ca3af" }; // 데이터 없음 (gray 600/400)
  const color = selected ? p.sel : p.base;

  const glyphKey =
    type === "restaurant"
      ? "restaurant"
      : type === "cafe"
      ? "cafe"
      : type === "attraction"
      ? "attraction"
      : type === "culture"
      ? "culture"
      : type === "parking"
      ? "parking"
      : "default";

  // 24x24 아이콘을 (cx,cy) 중앙에 size 크기로, 흰색 stroke 로 배치
  const icon = (cx: number, cy: number, size: number) => {
    const s = (size / 24).toFixed(4);
    const tx = cx - size / 2;
    const ty = cy - size / 2;
    return `<g fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(${tx} ${ty}) scale(${s})">${ICON_PATHS[glyphKey]}</g>`;
  };

  // 추정: 흰 몸통 + 등급색 **점선** 테두리 + 등급색 안쪽 원(흰 로고 대비 유지).
  // 실측의 '꽉 찬 등급색 몸통 + 까만 원' 과 모양 자체가 달라서 색각 이상이 있어도 구분된다.
  if (isEstimate) {
    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="46" viewBox="0 0 36 46">
      <path fill="#ffffff" fill-opacity="0.92" stroke="${color}" stroke-width="2.4" stroke-dasharray="4 3" stroke-linejoin="round" d="M18 1.4C8.9 1.4 1.4 8.9 1.4 18c0 12.6 15.4 24.8 16 25.4a.9.9 0 0 0 1.2 0c.6-.6 16-12.8 16-25.4C34.6 8.9 27.1 1.4 18 1.4z"/>
      <circle cx="18" cy="18" r="12" fill="${color}" fill-opacity="0.85"/>
      ${icon(18, 18, 17)}
    </svg>
  `;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
  }

  // 흰 테두리 없음 + 까만 원 + 흰 벡터 로고
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="46" viewBox="0 0 36 46">
      <path fill="${color}" d="M18 0C8.1 0 0 8.1 0 18c0 13.5 16.5 26.5 17.1 27.1a1.2 1.2 0 0 0 1.8 0c.6-.6 17.1-13.6 17.1-27.1C36 8.1 27.9 0 18 0z"/>
      <circle cx="18" cy="18" r="13" fill="#000000"/>
      ${icon(18, 18, 18.5)}
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
};
