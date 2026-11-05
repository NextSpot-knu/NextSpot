// 스테일-우선 캐시 — 마지막 성공 보드를 보관해 다시 열면 즉시 그리고 뒤에서 조용히 새로고침한다(웹과 같은 키·한도).
// 저장소는 앱 전역 localStorage(expo-sqlite). 읽기·쓰기 실패는 캐시 없이 동작한다.
import type { Sector } from './boardData';

export const BOARD_CACHE_KEY = 'nextspot_waiting_board_v2';
export const BOARD_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface BoardCache {
  sectors: Sector[];
  savedAt: number;
}

/** 저장된 문자열 → 쓸 수 있는 캐시. 모양이 어긋나거나 24시간을 넘겼으면 null. */
export function parseBoardCache(raw: string | null | undefined, now: number = Date.now()): BoardCache | null {
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as { sectors?: Sector[]; savedAt?: number; preset?: string };
    if (!Array.isArray(cached.sectors) || cached.sectors.length === 0) return null;
    if (typeof cached.savedAt !== 'number' || now - cached.savedAt > BOARD_CACHE_MAX_AGE_MS) return null;
    // 웹은 가정 시각 프리셋이 있어 'now' 가 아닌 캐시를 버린다 — 앱엔 프리셋이 없으니 같은 규칙으로 'now' 만 쓴다.
    if ((cached.preset ?? 'now') !== 'now') return null;
    return { sectors: cached.sectors, savedAt: cached.savedAt };
  } catch {
    return null;
  }
}

export function loadBoardCache(): BoardCache | null {
  try {
    return parseBoardCache(globalThis.localStorage?.getItem(BOARD_CACHE_KEY));
  } catch {
    return null;
  }
}

export function saveBoardCache(sectors: Sector[], now: number = Date.now()): void {
  try {
    globalThis.localStorage?.setItem(BOARD_CACHE_KEY, JSON.stringify({ sectors, savedAt: now, preset: 'now' }));
  } catch {
    /* 저장소 차단·용량 — 캐시 없이 동작 */
  }
}
