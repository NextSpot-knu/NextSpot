export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/**
 * 다크모드 임시 비활성(10-19 PM: 개선하기 전까지 항상 라이트). false 인 동안 자동(경주 18~06시)·수동 다크가 모두 라이트로 풀린다.
 * 지운 것은 없다 — 다크 토큰(globals.css) · 테마 계산 · 저장값 · 설정 화면의 테마 카드는 그대로 있고,
 * true 로 되돌리면 한 번에 되살아난다(e2e 의 다크 시험도 같은 스위치로 켜진다 — e2e/support/theme.ts).
 */
export const DARK_MODE_ENABLED = false;

export const THEME_STORAGE_KEY = 'nextspot_theme';
export const GYEONGJU_NIGHT_START_HOUR = 18;
export const GYEONGJU_NIGHT_END_HOUR = 6;

const VALID_THEME_MODES = new Set<ThemeMode>(['auto', 'light', 'dark']);

export function parseThemeMode(value: string | null | undefined): ThemeMode {
  return value && VALID_THEME_MODES.has(value as ThemeMode) ? value as ThemeMode : 'auto';
}

export function getGyeongjuHour(now: Date = new Date()): number {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).find((item) => item.type === 'hour');
  return Number(part?.value ?? 12);
}

export function isGyeongjuNight(now: Date = new Date()): boolean {
  const hour = getGyeongjuHour(now);
  return hour >= GYEONGJU_NIGHT_START_HOUR || hour < GYEONGJU_NIGHT_END_HOUR;
}

export function resolveTheme(mode: ThemeMode, now: Date = new Date()): ResolvedTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return isGyeongjuNight(now) ? 'dark' : 'light';
}

export function supportsTouristTheme(pathname: string): boolean {
  return !pathname.startsWith('/admin') && !pathname.startsWith('/merchant');
}

