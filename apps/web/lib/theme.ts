export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

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

