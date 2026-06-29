// 구미 주요 랜드마크 좌표 — 음성 "X 가까운 주차장" 같은 랜드마크 상대거리 쿼리의 기준점.
//
// ⚠️ 좌표는 데모용 근사값이다(구미 시내 bbox 내). 정확 좌표가 필요하면 Kakao/Google 지오코딩으로
//    동적 해석하거나 이 표를 실측값으로 교체하라. 기능(랜드마크→근접정렬) 자체는 좌표 품질과 무관하게 동작한다.
export interface Landmark {
  name: string;
  lat: number;
  lng: number;
  aliases: string[];
}

export const LANDMARKS: Landmark[] = [
  { name: '구미세무서', lat: 36.1276, lng: 128.3449, aliases: ['구미세무서', '세무서'] },
  { name: '구미시청', lat: 36.1196, lng: 128.3441, aliases: ['구미시청', '시청'] },
  { name: '구미역', lat: 36.1284, lng: 128.3315, aliases: ['구미역', '기차역'] },
  { name: '구미종합버스터미널', lat: 36.1270, lng: 128.3339, aliases: ['버스터미널', '종합터미널', '터미널', '고속버스'] },
  { name: '구미국가산업단지', lat: 36.1090, lng: 128.3884, aliases: ['국가산업단지', '국가산단', '공단', '산업단지', '산단'] },
  { name: '금오공과대학교', lat: 36.1455, lng: 128.3933, aliases: ['금오공대', '금오공과대', '금오공과대학교'] },
  { name: '구미보건소', lat: 36.1205, lng: 128.3460, aliases: ['구미보건소', '보건소'] },
  { name: '구미경찰서', lat: 36.1228, lng: 128.3520, aliases: ['구미경찰서', '경찰서'] },
  { name: '구미문화예술회관', lat: 36.1188, lng: 128.3408, aliases: ['문화예술회관', '예술회관', '문예회관'] },
];

// 발화에서 등록된 랜드마크를 찾는다. 가장 긴 alias 가 우선('구미세무서'가 '세무서'보다 우선)해 오매칭을 줄인다.
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
