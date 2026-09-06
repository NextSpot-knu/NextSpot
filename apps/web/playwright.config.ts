import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // 로컬에서 기본 워커 수(코어 절반, 8개)로 갓 뜬 dev 서버를 동시에 두드리면 첫 물결 8개가 load 타임아웃으로 죽는다
  // (2026-09-04 실측 — 2워커에서는 17/17 통과). CI 러너(4 vCPU)와 같은 2워커로 고정하고 CI 는 기본값을 둔다.
  workers: process.env.CI ? undefined : 2,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    ...devices['Desktop Chrome'],
    viewport: { width: 390, height: 844 },
    timezoneId: 'Asia/Seoul',
    locale: 'ko-KR',
    trace: 'retain-on-failure',
  },
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER ? undefined : {
    // Invoke Next directly so Playwright can terminate the Windows child process cleanly.
    command: 'node ../../node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
