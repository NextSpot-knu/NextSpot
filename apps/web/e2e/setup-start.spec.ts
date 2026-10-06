import { expect, test } from '@playwright/test';
import { stubExternalServices } from './support/stubs';

// /setup 의 '시작하기' 는 화면 아래에 붙어 늘 보이고, 고른 칩은 먹색으로 꽉 찬다(2026-10-06 감사 PE06·PH10).
// 다섯 질문이 한 화면을 넘겨 버튼이 접힘 아래로 밀리면(1536×730 실측) 심사위원이 어디서 시작할지 멈췄다.

test.beforeEach(async ({ page }) => {
  await stubExternalServices(page);
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
});

for (const viewport of [{ width: 1536, height: 730 }, { width: 360, height: 640 }]) {
  test(`start button is in view without scrolling at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    // 테마를 고정한다 — 자동 테마는 KST 18~06시에 야간이라 먹색 토큰이 밝은 색으로 뒤집힌다(그때도 반전된 꽉 찬 칩이다).
    await page.addInitScript(() => localStorage.setItem('nextspot_theme', 'light'));
    await page.goto('/setup');

    const start = page.getByRole('button', { name: '시작하기' });
    await expect(start).toBeVisible({ timeout: 30_000 });
    const inView = async () => {
      const b = (await start.boundingBox())!;
      return b.y >= 0 && b.y + b.height <= viewport.height;
    };
    expect(await inView(), '시작하기가 첫 화면 밖에 있다').toBe(true);
    // 위치가 바뀌는 대신 버튼을 그 자리에서 누를 수 있어야 한다(다른 칩이 덮지 않는다).
    expect(await start.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === el || el.contains(hit));
    })).toBe(true);

    // 고른 칩은 먹색으로 꽉 차고 ✓ 가 붙는다. 고르지 않은 칩은 그대로다.
    const chip = page.getByRole('button', { name: '음식점', exact: true });
    const other = page.getByRole('button', { name: '카페', exact: true });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toHaveClass(/\bbg-muk\b/);
    await expect(chip).toHaveClass(/\btext-hanji\b/);
    // 클래스만이 아니라 실제로 칠해진 색 — 먹색(#2b2320) 바탕(전환 애니메이션이 끝날 때까지 기다린다).
    await expect(chip).toHaveCSS('background-color', 'rgb(43, 35, 32)');
    await expect(chip.locator('svg')).toHaveCount(1);
    await expect(other).toHaveAttribute('aria-pressed', 'false');
    await expect(other).not.toHaveClass(/\bbg-muk\b/);

    // 끝까지 내려도 버튼은 그대로 보인다.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(inView).toBe(true);
  });
}
