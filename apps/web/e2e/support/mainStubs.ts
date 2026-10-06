import type { Page, Route } from '@playwright/test';
import { stubExternalServices } from './stubs';

// /main 을 네트워크 없이 띄우는 공용 스텁 — 지도 시설(/infrastructures)과 추천(/recommendations/by-type)만
// 스펙이 정하고, 나머지 API 는 빈 성공으로 닫는다. 카탈-올을 먼저, 구체 경로를 나중에 등록한다
// (Playwright 는 나중에 등록한 라우트가 이긴다).

export type E2eLocale = 'ko' | 'en' | 'ja' | 'zh';

export interface MainStubOptions {
  locale?: E2eLocale;
  /** GET /api/v1/infrastructures 응답(snake_case 행). */
  facilities: unknown[];
  /** POST /api/v1/recommendations/by-type 응답 — 요청한 facility_type 별로 만든다(snake_case 행). */
  byType: (facilityType: string) => unknown[];
}

export async function stubMain(page: Page, options: MainStubOptions): Promise<void> {
  await stubExternalServices(page);
  await page.addInitScript((locale) => {
    localStorage.setItem('nextspot_onboarding_done', '1');
    localStorage.setItem('nextspot_locale', locale);
  }, options.locale ?? 'ko');

  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/v1/infrastructures**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(options.facilities) }),
  );
  await page.route('**/api/v1/recommendations/by-type', async (route: Route) => {
    const body = route.request().postDataJSON() as { facility_type?: string } | null;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(options.byType(String(body?.facility_type ?? 'restaurant'))),
    });
  });
}
