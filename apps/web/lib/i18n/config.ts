export type Locale = 'ko' | 'en' | 'ja' | 'zh';
export const DEFAULT_LOCALE: Locale = 'ko';
export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
];
export type Messages = { [key: string]: string | Messages };
