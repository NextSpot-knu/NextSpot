// lucide-react(설치본) 아이콘의 path 데이터(verbatim). 24x24 viewBox, stroke 기반.
// 마커 중앙의 까만 원 위에 '흰색 stroke'로 그려 흰 로고를 만든다.
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
  // map-pin (기본)
  default:
    '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><path d="M12 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
};

export const getMarkerSvg = (
  type: string,
  level: number | null | undefined,
  features?: any,
  selected: boolean = false
) => {
  // 마커는 지도 다크 필터를 우회(타일에만 적용)하므로 본래의 색으로 표시된다.
  // 평소 = 700계열(톤 다운), 선택 = 200 밝은 500계열.
  // 혼잡 로그가 없는 시설(level=null/undefined)은 합성값 대신 회색 '데이터 없음' 마커.
  const p =
    typeof level !== 'number'
      ? { base: "#4b5563", sel: "#9ca3af" } // 데이터 없음 (gray 600/400)
      : level >= 0.75
      ? { base: "#b91c1c", sel: "#ef4444" } // 혼잡 (red 700/500)
      : level >= 0.5
      ? { base: "#b45309", sel: "#f59e0b" } // 보통 (amber 700/500)
      : level >= 0.25
      ? { base: "#047857", sel: "#10b981" } // 여유 (emerald 700/500)
      : { base: "#1d4ed8", sel: "#3b82f6" }; // 한산 (blue 700/500)
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
      : "default";

  // 24x24 아이콘을 (cx,cy) 중앙에 size 크기로, 흰색 stroke 로 배치
  const icon = (cx: number, cy: number, size: number) => {
    const s = (size / 24).toFixed(4);
    const tx = cx - size / 2;
    const ty = cy - size / 2;
    return `<g fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(${tx} ${ty}) scale(${s})">${ICON_PATHS[glyphKey]}</g>`;
  };

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
