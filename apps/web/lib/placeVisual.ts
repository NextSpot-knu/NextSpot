// 사진이 없는 장소의 사진 자리 — '사진 실패' 가 아니라 처음부터 그렇게 디자인된 표지로 보이게 한다.
//
// 근처 식당·카페의 대부분(카카오로 찾은 곳)은 합법적으로 쓸 수 있는 사진이 아예 없다. 그 자리를 평평한 이모지
// 블록으로 두면 옆 카드의 사진 사이에서 '사진이 깨졌다' 로 읽히고, 야간(18시 이후 자동)에는 검은 구멍이 된다.
// 그래서 장소마다 경주 문양(기와·창호 문살·석탑 옥개석·물결·수막새) 하나와 차분한 색 하나를 **장소 id 로
// 결정적으로** 골라 표지를 만든다. 같은 장소는 언제 봐도 같은 표지다.
//
// 색은 대기 등급 색(주칠 terracotta = 혼잡, 금 gold = 보통, 청록 jade = 여유)을 피한다 — 같은 카드의
// 등급 배지 바로 위에 붉은 표지가 '여유' 와 함께 있으면 혼잡을 말하는 것처럼 읽힌다. 유형은 색이 아니라
// 가운데 그림(수저·커피잔·산·기둥 건물)으로만 구분한다. 카메라 그림은 쓰지 않는다('사진 없음' 기호다).
//
// 순수 함수만 둔다(테스트: placeVisual.test.ts). 그리기는 components/PlacePhotoFallback.tsx.

/** 가운데 그림 — 장소 유형. 모르는 유형은 'default'(지도 핀). */
export type PlaceGlyph = 'restaurant' | 'cafe' | 'attraction' | 'culture' | 'default';

/** 경주 문양 — 기와(비늘) · 창호 문살 · 석탑 옥개석(처마 곡선) · 물결 · 수막새(둥근 막새). */
export const PLACE_MOTIFS = ['giwa', 'lattice', 'pagoda', 'wave', 'roundel'] as const;
export type PlaceMotif = (typeof PLACE_MOTIFS)[number];

/** 표지 색 — 기와 청회색 · 쪽빛 · 화강석 회색. 값은 app/globals.css 의 --nextspot-tile-* (야간 값 포함). */
export const PLACE_TONES = ['slate', 'indigo', 'stone'] as const;
export type PlaceTone = (typeof PLACE_TONES)[number];

/** 표지 색이 쓰는 CSS 변수 이름. 대기 등급 토큰(terracotta·gold·jade)을 가리키지 않는다. */
export const PLACE_TONE_VAR: Record<PlaceTone, string> = {
  slate: '--nextspot-tile-slate',
  indigo: '--nextspot-tile-indigo',
  stone: '--nextspot-tile-stone',
};

export interface PlaceVisual {
  glyph: PlaceGlyph;
  motif: PlaceMotif;
  tone: PlaceTone;
  /** 문양의 시작 위치(0~1) — 같은 문양이라도 장소마다 무늬가 어긋나 보이게. */
  phase: number;
}

/** FNV-1a 32bit — 장소 id → 부호 없는 정수. 브라우저·Node 어디서나 같은 값(결정적). */
export function hashPlaceId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function placeGlyph(type: string | null | undefined): PlaceGlyph {
  switch (type) {
    case 'restaurant':
    case 'cafe':
    case 'attraction':
    case 'culture':
      return type;
    default:
      return 'default';
  }
}

/** 한 장소의 표지. 문양·색·위치는 id 해시의 서로 다른 비트에서 뽑는다(문양이 같아도 색이 다를 수 있게). */
export function placeVisual(id: string, type: string | null | undefined): PlaceVisual {
  const h = hashPlaceId(id || '');
  return {
    glyph: placeGlyph(type),
    motif: PLACE_MOTIFS[h % PLACE_MOTIFS.length],
    tone: PLACE_TONES[(h >>> 8) % PLACE_TONES.length],
    phase: ((h >>> 16) & 0xff) / 255,
  };
}

/**
 * 한 줄(대표 카드 3장)의 표지들 — 각자 자기 id 의 표지를 쓰되, 앞 카드가 이미 쓴 문양이면 다음 문양으로
 * 넘긴다. 사진 없는 카드 셋이 나란히 있어도 같은 무늬가 반복되지 않는다(반복되면 로딩 자리로 읽힌다).
 * 문양 수(5)보다 카드가 많으면 그 뒤로는 겹칠 수 있다. 입력 순서가 같으면 결과도 같다.
 */
export function placeVisualsForRow(
  places: readonly { id: string; type: string | null | undefined }[],
): PlaceVisual[] {
  const used = new Set<PlaceMotif>();
  return places.map(({ id, type }) => {
    const visual = placeVisual(id, type);
    if (used.size < PLACE_MOTIFS.length && used.has(visual.motif)) {
      const start = PLACE_MOTIFS.indexOf(visual.motif);
      for (let step = 1; step < PLACE_MOTIFS.length; step++) {
        const candidate = PLACE_MOTIFS[(start + step) % PLACE_MOTIFS.length];
        if (!used.has(candidate)) {
          visual.motif = candidate;
          break;
        }
      }
    }
    used.add(visual.motif);
    return visual;
  });
}
