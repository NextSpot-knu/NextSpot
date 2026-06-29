// 경주 황리단길 주요 랜드마크 좌표 — 음성 "X 가까운 카페" 같은 랜드마크 상대거리 쿼리의 기준점.
//
// ⚠️ 좌표는 데모용 근사값이다(경주 황남동/황리단길 일대). 정확 좌표가 필요하면 Kakao/TourAPI 지오코딩으로
//    동적 해석하거나 이 표를 실측값으로 교체하라. 기능(랜드마크→근접정렬) 자체는 좌표 품질과 무관하게 동작한다.
export interface Landmark {
  name: string;
  lat: number;
  lng: number;
  aliases: string[];
}

export const LANDMARKS: Landmark[] = [
  { name: '황리단길', lat: 35.8362, lng: 129.2095, aliases: ['황리단길', '황남동', '황리단'] },
  { name: '대릉원', lat: 35.8389, lng: 129.2099, aliases: ['대릉원', '천마총', '고분'] },
  { name: '첨성대', lat: 35.8347, lng: 129.2189, aliases: ['첨성대'] },
  { name: '동궁과 월지', lat: 35.8348, lng: 129.2265, aliases: ['동궁과월지', '동궁과 월지', '월지', '안압지'] },
  { name: '월정교', lat: 35.8316, lng: 129.2167, aliases: ['월정교'] },
  { name: '국립경주박물관', lat: 35.8297, lng: 129.2278, aliases: ['국립경주박물관', '경주박물관', '박물관'] },
  { name: '경주 교촌마을', lat: 35.8296, lng: 129.2156, aliases: ['교촌마을', '교촌', '교동'] },
  { name: '황남빵 본점', lat: 35.8389, lng: 129.2117, aliases: ['황남빵', '황남빵본점'] },
];

// 발화에서 등록된 랜드마크를 찾는다. 가장 긴 alias 가 우선('동궁과월지'가 '월지'보다 우선)해 오매칭을 줄인다.
export function findLandmark(utterance: string | null | undefined): Landmark | null {
  if (!utterance) return null;
  const u = String(utterance);
  let best: { lm: Landmark; len: number } | null = null;
  for (const lm of LANDMARKS) {
    for (const a of lm.aliases) {
      if (u.includes(a) && (!best || a.length > best.len)) best = { lm, len: a.length };
    }
  }
  return best ? best.lm : null;
}
