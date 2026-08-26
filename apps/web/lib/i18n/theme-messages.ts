import type { Locale } from './config';

export const THEME_MESSAGES: Record<Locale, Record<string, string>> = {
  ko: {
    'theme.title': '화면 테마',
    'theme.description': '자동은 경주 현지 시각 오후 6시부터 오전 6시까지 다크모드를 사용해요.',
    'theme.auto': '자동',
    'theme.light': '라이트',
    'theme.dark': '다크',
  },
  en: {
    'theme.title': 'Appearance',
    'theme.description': 'Auto uses dark mode from 6 PM to 6 AM in Gyeongju local time.',
    'theme.auto': 'Auto',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
  },
  ja: {
    'theme.title': '画面テーマ',
    'theme.description': '自動では慶州の現地時間18時から翌6時までダークモードになります。',
    'theme.auto': '自動',
    'theme.light': 'ライト',
    'theme.dark': 'ダーク',
  },
  zh: {
    'theme.title': '显示主题',
    'theme.description': '自动模式会在庆州当地时间18点至次日6点启用深色模式。',
    'theme.auto': '自动',
    'theme.light': '浅色',
    'theme.dark': '深色',
  },
};

