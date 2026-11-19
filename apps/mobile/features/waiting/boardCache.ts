// 스테일-우선 캐시 — 마지막 성공 보드를 보관해 다시 열면 즉시 그리고 뒤에서 조용히 새로고침한다(웹과 같은 키·한도).
// 저장소는 앱 전역 localStorage(expo-sqlite). 읽기·쓰기 실패는 캐시 없이 동작한다.
// 가정 시각 프리셋(D11)이 다른 캐시는 쓰지 않는다 — 웹과 같다(다른 가정 시각의 결과는 안 보여 준다).
import type { Sector } from './boardData';

export const BOARD_CACHE_KEY = 'nextspot_waiting_board_v2';
export const BOARD_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface BoardCache {
  sectors: Sector[];
  savedAt: number;
}

/** 저장된 문자열 → 쓸 수 있는 캐시. 모양이 어긋나거나 24시간을 넘겼거나 프리셋이 다르면 null. */
export function parseBoardCache(
  raw: string | null | undefined,
  now: number = Date.now(),
  preset: string = 'now',
): BoardCache | null {
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as { sectors?: Sector[]; savedAt?: number; preset?: string };
    if (!Array.isArray(cached.sectors) || cached.sectors.length === 0) return null;
    if (typeof cached.savedAt !== 'number' || now - cached.savedAt > BOARD_CACHE_MAX_AGE_MS) return null;
    if ((cached.preset ?? 'now') !== preset) return null;
    return { sectors: cached.sectors, savedAt: cached.savedAt };
  } catch {
    return null;
  }
}

export function loadBoardCache(preset: string = 'now'): BoardCache | null {
  try {
    return parseBoardCache(globalThis.localStorage?.getItem(BOARD_CACHE_KEY), Date.now(), preset);
  } catch {
    return null;
  }
}

export function saveBoardCache(sectors: Sector[], preset: string = 'now', now: number = Date.now()): void {
  try {
    globalThis.localStorage?.setItem(BOARD_CACHE_KEY, JSON.stringify({ sectors, savedAt: now, preset }));
  } catch {
    /* 저장소 차단·용량 — 캐시 없이 동작 */
  }
}
