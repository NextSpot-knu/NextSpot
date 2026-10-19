import { test } from '@playwright/test';
import { DARK_MODE_ENABLED } from '../../lib/theme';

// 다크모드 임시 비활성(lib/theme.ts DARK_MODE_ENABLED = false) 동안 다크 시험은 건너뛴다 — true 로 되돌리면 같이 켜진다.
export const THEMES: ReadonlyArray<'light' | 'dark'> = DARK_MODE_ENABLED ? ['light', 'dark'] : ['light'];
export const darkTest = DARK_MODE_ENABLED ? test : test.skip;
