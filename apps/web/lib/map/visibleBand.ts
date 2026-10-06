// 지도에서 **실제로 보이는 띠**의 가운데에 장소를 놓는다(계획 B3 · I26/I50 '보이는 띠 가운데 맞춤').
//
// 왜 필요한가: /main 의 지도는 화면 전체를 덮고, 그 위에 톱바(검색·칩) · 오른쪽 추천 패널(데스크톱) · 아래쪽
// 혼잡 예측 줄과 카드 미리보기(휴대폰)가 떠 있다. 예전 panToVisible 은 '지도 높이의 22% 위로' 같은 고정 비율로
// 옮겨, 휴대폰에서는 고른 핀이 톱바 밑으로, 데스크톱에서는 오른쪽 패널 밑으로 숨었다. 여기서는 가리는 것들의
// 두께(위·오른쪽·아래·왼쪽)로 남는 띠를 구하고, 그 띠의 가운데로 옮길 지도 중심을 계산한다. 순수 함수 — SDK 를 모른다.

export interface BandInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface VisibleBand {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

/** 띠가 이보다 얇아지면 가리는 쪽을 줄인다 — 가리는 것이 화면을 다 덮어도 핀을 놓을 자리는 남긴다. */
export const MIN_BAND_PX = 80;

function clampInsets(size: number, a: number, b: number, min: number): [number, number] {
  const near = Math.max(0, Number.isFinite(a) ? a : 0);
  const far = Math.max(0, Number.isFinite(b) ? b : 0);
  const room = Math.max(0, size - min);
  if (near + far <= room) return [near, far];
  // 넘치면 두 쪽을 같은 비율로 줄인다(한쪽만 깎으면 띠가 화면 끝에 붙는다).
  const scale = (near + far) > 0 ? room / (near + far) : 0;
  return [near * scale, far * scale];
}

/** 지도 상자(width×height)에서 가리는 두께를 뺀 띠. */
export function visibleBand(width: number, height: number, insets: Partial<BandInsets>, minSize: number = MIN_BAND_PX): VisibleBand {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const [top, bottom] = clampInsets(h, insets.top ?? 0, insets.bottom ?? 0, Math.min(minSize, h));
  const [left, right] = clampInsets(w, insets.left ?? 0, insets.right ?? 0, Math.min(minSize, w));
  const band = { left, top, right: w - right, bottom: h - bottom };
  return { ...band, centerX: (band.left + band.right) / 2, centerY: (band.top + band.bottom) / 2 };
}

/**
 * 지도 상자 좌표 `point`(그 장소가 지금 그려지는 자리)를 띠의 가운데로 보내려면 지도 중심을 어디(상자 좌표)로
 * 옮겨야 하는가. 지도 중심은 상자 가운데에 그려지므로, 중심을 (상자 가운데 − 띠 가운데)만큼 반대로 민다.
 */
export function centerTargetFor(
  point: { x: number; y: number },
  width: number,
  height: number,
  insets: Partial<BandInsets>,
): { x: number; y: number } {
  const band = visibleBand(width, height, insets);
  return {
    x: point.x + (width / 2 - band.centerX),
    y: point.y + (height / 2 - band.centerY),
  };
}

/** 띠 안에 점이 들어 있는가(가장자리 여백 margin 안쪽). */
export function isInBand(point: { x: number; y: number }, band: VisibleBand, margin = 0): boolean {
  return point.x >= band.left + margin && point.x <= band.right - margin
    && point.y >= band.top + margin && point.y <= band.bottom - margin;
}
