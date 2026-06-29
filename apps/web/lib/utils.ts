// lucide-react(설치본) 아이콘의 path 데이터(verbatim). 24x24 viewBox, stroke 기반.
// 마커 중앙의 까만 원 위에 '흰색 stroke'로 그려 흰 로고를 만든다.
const ICON_PATHS: Record<string, string> = {
  // utensils
  cafeteria:
    '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  // car-front
  parking:
    '<path d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8"/><path d="M7 14h.01"/><path d="M17 14h.01"/><path d="M3 10h18a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z"/><path d="M5 18v2"/><path d="M19 18v2"/>',
  // handshake
  meeting_room:
    '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>',
  // sofa
  rest_area:
    '<path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M4 18v2"/><path d="M20 18v2"/><path d="M12 4v9"/>',
  // map-pin
  default:
    '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><path d="M12 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
  // building-2 (사옥/사유 주차장)
  private_parking:
    '<path d="M10 12h4"/><path d="M10 8h4"/><path d="M14 21v-3a2 2 0 0 0-4 0v3"/><path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"/><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/>',
};

export const getMarkerSvg = (
  type: string,
  level: number,
  features?: any,
  selected: boolean = false
) => {
  // 마커는 지도 다크 필터를 우회(타일에만 적용)하므로 본래의 색으로 표시된다.
  // 평소 = 700계열(톤 다운), 선택 = 200 밝은 500계열.
  const p =
    level >= 0.75
      ? { base: "#b91c1c", sel: "#ef4444" } // 혼잡 (red 700/500)
      : level >= 0.5
      ? { base: "#b45309", sel: "#f59e0b" } // 보통 (amber 700/500)
      : level >= 0.25
      ? { base: "#047857", sel: "#10b981" } // 여유 (emerald 700/500)
      : { base: "#1d4ed8", sel: "#3b82f6" }; // 한산 (blue 700/500)
  const color = selected ? p.sel : p.base;

  const isPrivateParking =
    type === "parking" && features && (features.is_private === true || features.is_public === false);

  const glyphKey = isPrivateParking
    ? "private_parking"
    : type === "cafeteria"
    ? "cafeteria"
    : type === "parking"
    ? "parking"
    : type === "meeting_room"
    ? "meeting_room"
    : type === "rest_area" || type === "loading_dock"
    ? "rest_area"
    : "default";

  // 24x24 아이콘을 (cx,cy) 중앙에 size 크기로, 흰색 stroke 로 배치
  const icon = (cx: number, cy: number, size: number) => {
    const s = (size / 24).toFixed(4);
    const tx = cx - size / 2;
    const ty = cy - size / 2;
    return `<g fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(${tx} ${ty}) scale(${s})">${ICON_PATHS[glyphKey]}</g>`;
  };

  if (isPrivateParking) {
    // 흰 테두리 없음 + 까만 원 + 흰 벡터 로고
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
        <rect x="2" y="2" width="36" height="36" rx="11" fill="${color}"/>
        <circle cx="20" cy="20" r="13.5" fill="#000000"/>
        ${icon(20, 20, 19)}
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
