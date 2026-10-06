// '실시간 정보 새로고침'(TourAPI live-detail) 결과에서 카드의 어느 줄이 새로 왔는지 고른다(계획 B2 · I47).
//
// 왜 필요한가: 새로고침은 성공해도 값이 캐시와 같으면 화면이 그대로라, 심사위원은 눌러도 아무 일이 없었다고
// 읽었다. 이제 응답에 실려 온 줄(운영시간 · 소개 · 전화 · 홈페이지 · 사진)을 1.5초 반짝인다 — 값이 같아도
// '방금 공사 서버에서 다시 받아 왔다' 는 사실은 참이다. 응답에 없는(빈) 줄은 반짝이지 않는다(받지 않은 걸
// 받은 척하지 않는다).

export type LiveField = 'hours' | 'overview' | 'phone' | 'homepage' | 'photo';

export interface LiveDetailPayload {
  operatingHours?: { open?: unknown; closed?: unknown; [key: string]: unknown } | null;
  overview?: string | null;
  phone?: string | null;
  homepage?: string | null;
  imageUrl?: string | null;
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/** 응답에 실제 값이 실려 온 줄 — 카드에 그려지는 순서(사진 → 운영시간 → 소개 → 전화 → 홈페이지)대로. */
export function refreshedFields(live: LiveDetailPayload | null | undefined): LiveField[] {
  if (!live) return [];
  const out: LiveField[] = [];
  if (filled(live.imageUrl)) out.push('photo');
  const hours = live.operatingHours;
  if (hours && (filled(hours.open) || filled(hours.closed))) out.push('hours');
  if (filled(live.overview)) out.push('overview');
  if (filled(live.phone)) out.push('phone');
  if (filled(live.homepage)) out.push('homepage');
  return out;
}

/** 반짝임을 걸어 둘 시간(ms) — 계획 값 1.5초. */
export const LIVE_FLASH_MS = 1500;
/** 성공 뒤 버튼을 잠가 두는 시간(ms) — 공사 서버를 연달아 두드리지 않게. */
export const LIVE_REFRESH_COOLDOWN_MS = 10_000;
